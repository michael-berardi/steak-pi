import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CheckpointStore, diagnoseRun, recoveredRun } from "../src/subagents/checkpoints.ts";
import { CLAUDE_CODE_MODEL, CLAUDE_CODE_ROUTE, createClaudeWorkerRunner, type ClaudeSpawn, type ClaudeSpawnHandle } from "../src/subagents/claude-worker.ts";
import { Coordinator } from "../src/subagents/coordinator.ts";
import { NoopSlots } from "../src/subagents/machine-slots.ts";
import { createPiWorkerRunner, type PiWorkerSession } from "../src/subagents/pi-worker.ts";
import type { AccountSelection, ProviderAccount, ProviderAccountRouter } from "../src/subagents/provider-accounts.ts";
import { RelayBroker } from "../src/subagents/relay.ts";
import { renderSubagentResult } from "../src/subagents/render.ts";
import { Scheduler } from "../src/subagents/scheduler.ts";
import {
  USAP_VERSION, emptyUsage, partialReasonOf,
  type RunRecord, type TaskRecord, type WorkerProgress, type WorkerResult,
} from "../src/subagents/types.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "steak-accounts-int-"));
  roots.push(root);
  return root;
}
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
/** Synthetic account directories live under a throwaway home handed to the runners through their explicit `accountHome` seam. */
const fileHome = mkdtempSync(join(tmpdir(), "steak-accounts-home-"));
afterAll(() => rmSync(fileHome, { recursive: true, force: true }));
const testHome = (): string => fileHome;
const claudeRunner = (options: Parameters<typeof createClaudeWorkerRunner>[0] = {}) => createClaudeWorkerRunner({ accountHome: testHome(), ...options });

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "run-acct-task-1", label: "leaf", task: "Report the entrypoint", role: "scout", mayEdit: false, ownedPaths: [], allowBash: false,
    state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, ...overrides,
  };
}
function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: USAP_VERSION, id: "run-acct", goal: "Inspect the leaf", constraints: [], cwd: "/repo", model: CLAUDE_CODE_ROUTE,
    harness: "claude-code", thinkingLevel: "xhigh", concurrency: 1, timeoutMs: 60_000, maxTurns: 8, background: false, state: "running",
    createdAt: 0, tasks: [], usage: emptyUsage(), ...overrides,
  };
}

/** Scripted router that also logs every call into a shared, ordered event list. */
function fakeRouter(events: string[], script: (call: number, request: { account?: string }) => AccountSelection) {
  const selects: Array<{ provider: string; account?: string; owner: string }> = [];
  const limits: Array<{ provider: string; account: string; resetAt?: number; reason: string }> = [];
  const router: ProviderAccountRouter = {
    async select(request) { selects.push(request); events.push(`select:${request.provider}:${request.account ?? "auto"}`); return script(selects.length, request); },
    async renew(lease) { events.push(`renew:${lease}`); return "renewed"; },
    async release(lease) { events.push(`release:${lease}`); },
    async limit(request) { events.push(`limit:${request.account}`); limits.push(request); },
  };
  return { router, selects, limits };
}
const chosen = (account: ProviderAccount, lease: string): AccountSelection => ({ kind: "selected", account, lease });

/** Router with the real one's observable rules: a limit starts a cooldown, an explicit or owner-pinned account queues while it
 * cools down, and automatic selection takes the first account that is not cooling. */
function statefulRouter(events: string[], accounts: ProviderAccount[]) {
  const cooling = new Set<string>();
  const owners = new Map<string, string>();
  const selects: Array<{ provider: string; account?: string; owner: string; existing?: boolean }> = [];
  let leases = 0;
  const router: ProviderAccountRouter = {
    async select(request) {
      selects.push(request);
      const wanted = request.account ?? owners.get(request.owner);
      const account = wanted ? accounts.find((candidate) => candidate.id === wanted) : accounts.find((candidate) => !cooling.has(candidate.id));
      events.push(`select:${request.provider}:${request.account ?? "auto"}`);
      if (!account || (!request.existing && cooling.has(account.id))) return { kind: "queued", error: account ? `${account.label} is cooling down` : "every account is cooling down" };
      owners.set(request.owner, account.id);
      return { kind: "selected", account, lease: `L-${++leases}` };
    },
    async renew() { return "renewed"; },
    async release(lease) { events.push(`release:${lease}`); },
    async limit(request) { cooling.add(request.account); events.push(`limit:${request.account}`); },
  };
  return { router, cooling, selects };
}
/** The CLI's absolute notice for a reset `minutes` from now, in the one shape the worker's classifier keeps ("Mon d at h:mmam (Zone/Name)"). */
function resetNotice(minutes = 20): string {
  const at = new Date(Date.now() + minutes * 60_000);
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getUTCMonth()];
  return `resets ${month} ${at.getUTCDate()} at ${at.getUTCHours() % 12 || 12}:${String(at.getUTCMinutes()).padStart(2, "0")}${at.getUTCHours() >= 12 ? "pm" : "am"} (Etc/UTC)`;
}
const limitFrame = () => frame({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: `You've hit your limit · ${resetNotice()}` }] } });
const sessionOf = (args: string[]) => args[args.indexOf(args.includes("--resume") ? "--resume" : "--session-id") + 1];

// ---------------------------------------------------------------- Claude Code

class FakeClaudeProcess implements ClaudeSpawnHandle {
  private static nextPid = 9100;
  pid = FakeClaudeProcess.nextPid++;
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private stdoutListeners: Array<(chunk: string) => void> = [];
  onExit(listener: (code: number | null, signal: string | null) => void) { this.exitListeners.push(listener); }
  onError() {}
  onStdout(listener: (chunk: string) => void) { this.stdoutListeners.push(listener); }
  onStderr() {}
  writeStdin() {}
  endStdin() {}
  kill(signal?: string) { if (signal === "SIGKILL") queueMicrotask(() => this.exit(null, "SIGKILL")); return true; }
  stdout(chunk: string) { for (const listener of this.stdoutListeners) listener(chunk); }
  exit(code: number | null = 0, signal: string | null = null) { for (const listener of this.exitListeners) listener(code, signal); }
}

let sequence = 0;
function frame(value: { type: string; message?: object } & Record<string, unknown>): string {
  const withMessage = value.type === "assistant" && value.message
    ? { ...value, message: { id: `acct-message-${++sequence}`, model: CLAUDE_CODE_MODEL, ...value.message } } : value;
  return `${JSON.stringify(withMessage)}\n`;
}
const success = () => frame({
  type: "result", subtype: "success", is_error: false, result: "report", usage: { input_tokens: 1, output_tokens: 1 },
  total_cost_usd: 0.01, num_turns: 1, modelUsage: { [CLAUDE_CODE_MODEL]: {} },
});

function claudeSpawn(events: string[], script: (child: FakeClaudeProcess, call: number) => void) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn: ClaudeSpawn = ({ args, env }) => {
    const child = new FakeClaudeProcess();
    calls.push({ args, env });
    events.push("spawn");
    const index = calls.length;
    queueMicrotask(() => script(child, index));
    return child;
  };
  return { spawn, calls };
}

const claude1: ProviderAccount = { id: "primary", label: "Claude 1", configDir: join(fileHome, ".claude") };
function claude2Account(): ProviderAccount {
  const configDir = mkdtempSync(join(testHome(), "claude-b-"));
  return { id: "b", label: "Claude 2", configDir };
}

const ctx = (overrides: { task?: TaskRecord; signal?: AbortSignal; onProgress?: (progress: WorkerProgress) => void } = {}) =>
  ({ run: run(), task: overrides.task ?? task(), signal: overrides.signal ?? new AbortController().signal, onProgress: overrides.onProgress ?? (() => {}) });

describe("Claude worker account routing", () => {
  it("reserves Claude 2 before spawning, binds its config dir, pins it and releases on completion", async () => {
    const events: string[] = [];
    const account = claude2Account();
    const { router } = fakeRouter(events, () => chosen(account, "L-claude-2"));
    const { spawn, calls } = claudeSpawn(events, (child) => { child.stdout(success()); child.exit(0); });
    const progress: WorkerProgress[] = [];
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router })(ctx({ onProgress: (value) => progress.push(value) }));
    expect(result.state).toBe("done");
    expect(events).toEqual(["select:claude:auto", "spawn", "release:L-claude-2"]);
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(account.configDir);
    expect(progress.find((value) => value.providerAccount)?.providerAccount).toEqual({ provider: "claude", id: "b", label: "Claude 2", configDir: account.configDir });
    // Only the allowlist plus the account directory ever reaches the child.
    expect(Object.keys(calls[0].env).every((key) => key === "CLAUDE_CONFIG_DIR" || /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_ALL|TZ|TMPDIR|TEMP|TMP|TERM|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy)$/.test(key))).toBe(true);
  });

  it("keeps the primary account on the CLI's default config dir", async () => {
    for (const account of [claude1, { id: "primary", label: "Claude 1" }]) {
      const events: string[] = [];
      const { router } = fakeRouter(events, () => chosen(account, "L-1"));
      const { spawn, calls } = claudeSpawn(events, (child) => { child.stdout(success()); child.exit(0); });
      const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router })(ctx());
      expect(result.state).toBe("done");
      expect("CLAUDE_CONFIG_DIR" in calls[0].env).toBe(false);
    }
  });

  it("does nothing different without a router or when routing is disabled (legacy primary route)", async () => {
    for (const accounts of [undefined, false as const]) {
      const events: string[] = [];
      const { spawn, calls } = claudeSpawn(events, (child) => { child.stdout(success()); child.exit(0); });
      const progress: WorkerProgress[] = [];
      const result = await claudeRunner({ spawn, abortGraceMs: 20, ...(accounts === undefined ? {} : { accounts }) })(ctx({ onProgress: (value) => progress.push(value) }));
      expect(result.state).toBe("done");
      expect(events).toEqual(["spawn"]);
      expect("CLAUDE_CONFIG_DIR" in calls[0].env).toBe(false);
      expect(progress.some((value) => value.providerAccount)).toBe(false);
    }
  });

  it("pins a resumed session to its recorded account and queues instead of switching", async () => {
    const events: string[] = [];
    const account = claude2Account();
    const { router, selects } = fakeRouter(events, (call) => call === 1 ? { kind: "queued", error: "Claude 2 at its usage limit" } : chosen(account, "L-pinned"));
    const { spawn, calls } = claudeSpawn(events, (child) => { child.stdout(success()); child.exit(0); });
    const sessionId = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
    const progress: WorkerProgress[] = [];
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router, accountQueue: { pollMs: 1, sleep: async () => true } })(ctx({
      task: task({ claudeSessionId: sessionId, providerAccount: { provider: "claude", id: "b", label: "Claude 2" } }),
      onProgress: (value) => progress.push(value),
    }));
    expect(result.state).toBe("done");
    expect(selects.map((request) => request.account)).toEqual(["b", "b"]);
    expect(events).toEqual(["select:claude:b", "select:claude:b", "spawn", "release:L-pinned"]);
    expect(calls[0].args).toContain("--resume");
    expect(calls[0].args[calls[0].args.indexOf("--resume") + 1]).toBe(sessionId);
    expect(progress[0]).toEqual({ state: "waiting", currentTool: "waiting for Claude account capacity" });
  });

  it("never moves a resumable session recorded before balancing off the primary account", async () => {
    const events: string[] = [];
    const { router, selects } = fakeRouter(events, () => chosen(claude1, "L-1"));
    const { spawn } = claudeSpawn(events, (child) => { child.stdout(success()); child.exit(0); });
    await claudeRunner({ spawn, abortGraceMs: 20, accounts: router })(ctx({ task: task({ claudeSessionId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b" }) }));
    expect(selects[0].account).toBe("primary");
  });

  it("queues on exhaustion without spawning or leasing, and the task is not partial work", async () => {
    const events: string[] = [];
    const { router } = fakeRouter(events, () => ({ kind: "queued", error: "usage unknown for Claude 1; Claude 2 at limit" }));
    const { spawn, calls } = claudeSpawn(events, (child) => child.exit(0));
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router, accountQueue: { maxWaitMs: 0 } })(ctx());
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/Waiting for Claude account capacity ended after \d+ min: usage unknown for Claude 1; Claude 2 at limit; no inference started/);
    expect(calls).toHaveLength(0);
    expect(events).toEqual(["select:claude:auto"]);
    expect(partialReasonOf("timed_out", result.error, true)).toBeUndefined();
    expect(partialReasonOf("failed", "Child exhausted the 8-turn limit", true)).toBe("turn_budget");
  });

  it("is cancellation-aware while queued and never launches", async () => {
    const events: string[] = [];
    const { router } = fakeRouter(events, () => ({ kind: "queued", error: "busy" }));
    const { spawn, calls } = claudeSpawn(events, (child) => child.exit(0));
    const controller = new AbortController();
    const progress: WorkerProgress[] = [];
    const pending = claudeRunner({ spawn, abortGraceMs: 20, accounts: router })(ctx({ signal: controller.signal, onProgress: (value) => progress.push(value) }));
    await vi.waitFor(() => expect(progress).toHaveLength(1));
    controller.abort(new DOMException("Task cancelled", "AbortError"));
    const result = await pending;
    expect(result.state).toBe("aborted");
    expect(result.error).toMatch(/Waiting for Claude account capacity/);
    expect(calls).toHaveLength(0);
  });

  it("fails closed with a broken router: no spawn and no substitute account", async () => {
    const events: string[] = [];
    const { router } = fakeRouter(events, () => ({ kind: "unavailable", error: "router gave no usable answer" }));
    const { spawn, calls } = claudeSpawn(events, (child) => child.exit(0));
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router })(ctx());
    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("no account was substituted") });
    expect(calls).toHaveLength(0);
  });

  it("refuses a secondary account whose config dir is missing before any launch", async () => {
    const events: string[] = [];
    const { router } = fakeRouter(events, () => chosen({ id: "b", label: "Claude 2", configDir: join(testHome(), "gone") }, "L-gone"));
    const { spawn, calls } = claudeSpawn(events, (child) => child.exit(0));
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router })(ctx());
    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("Claude 2 config directory is missing") });
    expect(calls).toHaveLength(0);
    expect(events).toEqual(["select:claude:auto", "release:L-gone"]);
  });

  it("reports a Claude usage limit against the account that hit it", async () => {
    const events: string[] = [];
    const account = claude2Account();
    const { router, limits } = fakeRouter(events, () => chosen(account, "L-limit"));
    const { spawn } = claudeSpawn(events, (child) => {
      child.stdout(limitFrame());
      child.exit(1);
    });
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router, accountQueue: { limitRetries: 0 } })(ctx());
    expect(result.state).toBe("failed");
    // The notice's absolute reset (~20 minutes ahead, in Etc/UTC) is passed on as an epoch.
    expect(limits).toEqual([{ provider: "claude", account: "b", resetAt: expect.any(Number), reason: "usage limit" }]);
    expect(limits[0].resetAt! * 1000 - Date.now()).toBeGreaterThan(17 * 60_000);
    expect(limits[0].resetAt! * 1000 - Date.now()).toBeLessThanOrEqual(20 * 60_000);
    expect(events.at(-1)).toBe("release:L-limit");
  });

  it("keeps an automatic continuation on the account its first attempt reserved", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const account = claude2Account();
    const { router, selects } = fakeRouter(events, (call) => chosen(account, `L-${call}`));
    const { spawn, calls } = claudeSpawn(events, (child, call) => {
      if (call === 1) { child.stdout(frame({ type: "assistant", message: { content: [] } })); child.stdout('{"type":'); child.exit(0); }
      else { child.stdout(success()); child.exit(0); }
    });
    const coordinator = new Coordinator(claudeRunner({ spawn, abortGraceMs: 20, accounts: router }), { scheduler: new Scheduler(1), machineSlots: new NoopSlots() });
    const record = run({ timeoutMs: 30 * 60_000, tasks: [task({ state: "queued" })] });
    coordinator.start(record);
    await vi.advanceTimersByTimeAsync(10_000);
    const settled = await coordinator.wait(record.id, "all");
    expect(settled.tasks[0].state).toBe("done");
    expect(selects.map((request) => request.account)).toEqual([undefined, "b"]);
    expect(calls[1].args).toContain("--resume");
    expect(settled.tasks[0].providerAccount).toMatchObject({ provider: "claude", id: "b", label: "Claude 2" });
    expect(events).toEqual(["select:claude:auto", "spawn", "release:L-1", "select:claude:b", "spawn", "release:L-2"]);
    await coordinator.shutdown();
  });

  it("restarts a fresh task that hit the limit before any inference on the other account, with a new session", async () => {
    const events: string[] = [];
    const b = claude2Account();
    const { router, selects } = statefulRouter(events, [claude1, b]);
    const { spawn, calls } = claudeSpawn(events, (child, call) => {
      if (call === 1) { child.stdout(limitFrame()); child.exit(1); }
      else { child.stdout(success()); child.exit(0); }
    });
    const progress: WorkerProgress[] = [];
    const record = task();
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router })(ctx({ task: record, onProgress: (value) => { progress.push(value); if (value.claudeSessionId) record.claudeSessionId = value.claudeSessionId; } }));
    expect(result.state).toBe("done");
    expect(events).toEqual(["select:claude:auto", "spawn", "limit:primary", "release:L-1", "select:claude:auto", "spawn", "release:L-2"]);
    expect("CLAUDE_CONFIG_DIR" in calls[0].env).toBe(false);
    expect(calls[1].env.CLAUDE_CONFIG_DIR).toBe(b.configDir);
    // The second launch is a new conversation: its own session id, never a resume of the first.
    expect(calls[0].args).toContain("--session-id");
    expect(calls[1].args).toContain("--session-id");
    expect(calls[1].args).not.toContain("--resume");
    expect(sessionOf(calls[1].args)).not.toBe(sessionOf(calls[0].args));
    expect(selects[1].account).toBeUndefined();
  });

  it("queues a limit-hit resumed session on its own account and resumes the same conversation there", async () => {
    const events: string[] = [];
    const b = claude2Account();
    const { router, cooling, selects } = statefulRouter(events, [claude1, b]);
    const { spawn, calls } = claudeSpawn(events, (child, call) => {
      if (call === 1) { child.stdout(limitFrame()); child.exit(1); }
      else { child.stdout(success()); child.exit(0); }
    });
    const progress: WorkerProgress[] = [];
    const slots = { yield: vi.fn(), reclaim: vi.fn(async () => {}) };
    const record = task({ claudeSessionId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", providerAccount: { provider: "claude", id: "b", label: "Claude 2" } });
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router, accountQueue: { pollMs: 1, sleep: async () => { cooling.clear(); return true; } } })(
      { ...ctx({ task: record, onProgress: (value) => progress.push(value) }), slots },
    );
    expect(result.state).toBe("done");
    expect(events).toEqual(["select:claude:b", "spawn", "limit:b", "release:L-1", "select:claude:b", "select:claude:b", "spawn", "release:L-2"]);
    // Both launches continue the one conversation, on the one account's directory; the other account is never asked for.
    for (const call of calls) {
      expect(call.args).toContain("--resume");
      expect(sessionOf(call.args)).toBe("0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b");
      expect(call.env.CLAUDE_CONFIG_DIR).toBe(b.configDir);
    }
    expect(selects.every((request) => request.account === "b")).toBe(true);
    expect(progress).toContainEqual({ state: "waiting", currentTool: "waiting for Claude account capacity" });
    // The wait lent the launch slots back and took them again before the second spawn.
    expect(slots.yield).toHaveBeenCalledTimes(1);
    expect(slots.reclaim).toHaveBeenCalledTimes(1);
  });

  it("through the coordinator, re-pins a task that restarted fresh to the account that then ran it", async () => {
    const events: string[] = [];
    const b = claude2Account();
    const { router } = statefulRouter(events, [claude1, b]);
    const { spawn, calls } = claudeSpawn(events, (child, call) => {
      if (call === 1) { child.stdout(limitFrame()); child.exit(1); }
      else { child.stdout(success()); child.exit(0); }
    });
    const coordinator = new Coordinator(claudeRunner({ spawn, abortGraceMs: 20, accounts: router }), { scheduler: new Scheduler(1), machineSlots: new NoopSlots() });
    const record = run({ tasks: [task({ state: "queued" })] });
    coordinator.start(record);
    const settled = await coordinator.wait(record.id, "all");
    expect(settled.tasks[0].state).toBe("done");
    expect(settled.tasks[0].providerAccount).toEqual({ provider: "claude", id: "b", label: "Claude 2", configDir: b.configDir });
    expect(settled.tasks[0].claudeSessionId).toBe(sessionOf(calls[1].args));
    expect(settled.tasks[0].claudeSessionId).not.toBe(sessionOf(calls[0].args));
    expect(settled.tasks[0].autoResumes).toBeUndefined();
    await coordinator.shutdown();
  });

  it("through the coordinator, shows a limit-hit resume as waiting and finishes it on the same account", async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const b = claude2Account();
    const { router, cooling } = statefulRouter(events, [claude1, b]);
    const { spawn, calls } = claudeSpawn(events, (child, call) => {
      if (call === 1) { child.stdout(limitFrame()); child.exit(1); }
      else { child.stdout(success()); child.exit(0); }
    });
    const states: string[] = [];
    const coordinator = new Coordinator(
      claudeRunner({ spawn, abortGraceMs: 20, accounts: router, accountQueue: { pollMs: 1_000, sleep: async () => { cooling.clear(); return true; } } }),
      { scheduler: new Scheduler(1), machineSlots: new NoopSlots(), onChange: (value) => states.push(value.tasks[0].state) },
    );
    const record = run({ timeoutMs: 30 * 60_000, tasks: [task({ state: "queued", claudeSessionId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", providerAccount: { provider: "claude", id: "b", label: "Claude 2" } })] });
    coordinator.start(record);
    await vi.advanceTimersByTimeAsync(2_000);
    const settled = await coordinator.wait(record.id, "all");
    expect(settled.tasks[0].state).toBe("done");
    expect(states).toContain("waiting");
    expect(calls.map((call) => sessionOf(call.args))).toEqual(["0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"]);
    expect(calls.every((call) => call.env.CLAUDE_CONFIG_DIR === b.configDir)).toBe(true);
    expect(settled.tasks[0].providerAccount).toMatchObject({ id: "b", label: "Claude 2" });
    await coordinator.shutdown();
  });

  it("with both accounts limited, a fresh task waits for capacity and fails as a wait, not as work", async () => {
    const events: string[] = [];
    const { router, cooling } = statefulRouter(events, [claude1, claude2Account()]);
    cooling.add("primary"); cooling.add("b");
    const { spawn, calls } = claudeSpawn(events, (child) => child.exit(0));
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router, accountQueue: { maxWaitMs: 0 } })(ctx());
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/Waiting for Claude account capacity ended.*every account is cooling down; no inference started/);
    expect(calls).toHaveLength(0);
  });
});

describe("Claude worker account directory safety and N accounts", () => {
  const quick = (events: string[]) => claudeSpawn(events, (child) => { child.stdout(success()); child.exit(0); });

  it("serves a third registered account through its own directory and pin", async () => {
    const events: string[] = [];
    const b = claude2Account();
    const configDir = mkdtempSync(join(testHome(), "claude-team-"));
    const team: ProviderAccount = { id: "team-3", label: "Claude (team-3)", configDir };
    const { router, cooling } = statefulRouter(events, [claude1, b, team]);
    cooling.add("primary"); cooling.add("b");
    const { spawn, calls } = quick(events);
    const progress: WorkerProgress[] = [];
    const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router })(ctx({ onProgress: (value) => progress.push(value) }));
    expect(result.state).toBe("done");
    expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(progress.find((value) => value.providerAccount)?.providerAccount).toEqual({ provider: "claude", id: "team-3", label: "Claude (team-3)", configDir });
    // With every account cooling the task waits instead of failing or borrowing a directory.
    cooling.add("team-3");
    const waiting = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router, accountQueue: { maxWaitMs: 0 } })(ctx());
    expect(waiting.error).toMatch(/Waiting for Claude account capacity ended/);
    expect(calls).toHaveLength(1);
  });

  it("fallback-only selection order changes which account runs, never which directory belongs to it", async () => {
    const events: string[] = [];
    const b = claude2Account();
    // Fallback mode: the primary account first, the second only once the primary cools down.
    const { router, cooling } = statefulRouter(events, [claude1, b]);
    const { spawn, calls } = quick(events);
    const runner = claudeRunner({ spawn, abortGraceMs: 20, accounts: router });
    await runner(ctx({ task: task({ id: "run-acct-task-1" }) }));
    await runner(ctx({ task: task({ id: "run-acct-task-2" }) }));
    cooling.add("primary");
    await runner(ctx({ task: task({ id: "run-acct-task-3" }) }));
    expect(calls.map((call) => call.env.CLAUDE_CONFIG_DIR)).toEqual([undefined, undefined, b.configDir]);
    for (const call of calls) expect(call.env.CLAUDE_CONFIG_DIR).not.toBe(claude1.configDir);
    expect(events.filter((event) => event.startsWith("select"))).toEqual(["select:claude:auto", "select:claude:auto", "select:claude:auto"]);
  });

  it("refuses an account directory that is not private, behind a symlink, or outside home, before any launch", async () => {
    const loose = mkdtempSync(join(testHome(), "claude-loose-"));
    chmodSync(loose, 0o755);
    const real = mkdtempSync(join(testHome(), "claude-real-"));
    const linked = join(testHome(), `claude-link-${Date.now()}`);
    symlinkSync(real, linked);
    const outside = mkdtempSync(join(tempRoot(), "claude-outside-"));
    // The production default home is the process home: point it at a synthetic one so no real home is consulted.
    vi.stubEnv("HOME", tempRoot());
    for (const [configDir, message, runner] of [
      [loose, /must be private \(mode 0700\)/, claudeRunner],
      [linked, /passes through a symlink/, claudeRunner],
      // No test home: the production default (the real home) applies, and a temp directory is not below it.
      [outside, /outside the home directory/, createClaudeWorkerRunner],
    ] as const) {
      const events: string[] = [];
      const { router } = fakeRouter(events, () => chosen({ id: "b", label: "Claude 2", configDir }, "L-dir"));
      const { spawn, calls } = quick(events);
      const result = await runner({ spawn, abortGraceMs: 20, accounts: router })(ctx());
      expect(result, configDir).toMatchObject({ state: "failed", error: expect.stringMatching(message) });
      expect(result.error).toContain("no inference started");
      expect(calls).toHaveLength(0);
      expect(events).toEqual(["select:claude:auto", "release:L-dir"]);
    }
  });

  it("never lets Claude 2 resolve to the primary directory, even through a link", async () => {
    const home = testHome();
    const legacy = join(home, ".claude");
    mkdirSync(legacy, { recursive: true });
    const alias = join(home, `claude-alias-${Date.now()}`);
    symlinkSync(legacy, alias);
    for (const configDir of [legacy, alias]) {
      const events: string[] = [];
      const { router } = fakeRouter(events, () => chosen({ id: "b", label: "Claude 2", configDir }, "L-alias"));
      const { spawn, calls } = quick(events);
      const result = await claudeRunner({ spawn, abortGraceMs: 20, accounts: router })(ctx());
      expect(result.state, configDir).toBe("failed");
      expect(calls).toHaveLength(0);
    }
  });
});

// ------------------------------------------------------------------------- Pi

const codexModel = { provider: "openai-codex", id: "gpt-6-luna" } as never;
const otherModel = { provider: "test", id: "model" } as never;

class FakeSession implements PiWorkerSession {
  isStreaming = false;
  disposed = false;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  onPrompt: (session: FakeSession) => Promise<void> = async () => {};
  subscribe(listener: (event: AgentSessionEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: AgentSessionEvent) { for (const listener of this.listeners) listener(event); }
  async prompt() { this.isStreaming = true; await this.onPrompt(this); this.isStreaming = false; }
  async steer() {}
  async abort() { this.isStreaming = false; }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
const assistant = (text: string, stopReason = "stop", errorMessage?: string) => ({
  role: "assistant" as const, content: [{ type: "text" as const, text }], api: "test", provider: "test", model: "test",
  usage: emptyUsage(), stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: Date.now(),
});

function piRun(cwd: string, record: TaskRecord): RunRecord {
  return run({ cwd, model: "fake/model", harness: undefined, thinkingLevel: "low", maxTurns: 8, tasks: [record], timeoutMs: 10_000 });
}
function broker(): RelayBroker {
  const relay = new RelayBroker();
  relay.createRun("run-acct", ["run-acct-task-1"]);
  return relay;
}
function piHarness(events: string[], model: never, script: (session: FakeSession) => Promise<void> = async (session) => {
  session.emit({ type: "message_end", message: assistant("Evidence: done") } as AgentSessionEvent);
}) {
  const options: CreateAgentSessionOptions[] = [];
  const session = new FakeSession();
  session.onPrompt = script;
  const sessionFactory = vi.fn(async (value: CreateAgentSessionOptions) => { options.push(value); events.push("session"); return { session }; });
  const runnerOptions = { relay: broker(), accountHome: testHome(), resolveRuntime: () => ({ model, thinkingLevel: "off" as const }), sessionFactory };
  return { options, session, sessionFactory, runnerOptions };
}
function gpt2Account(withAuth = true): ProviderAccount {
  const agentDir = mkdtempSync(join(testHome(), "pi-fallback-"));
  if (withAuth) writeFileSync(join(agentDir, "auth.json"), "{}");
  return { id: "fallback", label: "GPT 2", agentDir };
}

describe("Pi worker account routing", () => {
  it("reserves GPT 2 before the session exists, hands it the account agent dir and releases after disposal", async () => {
    const events: string[] = [];
    const account = gpt2Account();
    const { router } = fakeRouter(events, () => chosen(account, "L-gpt-2"));
    const harness = piHarness(events, codexModel);
    const record = task();
    const progress: WorkerProgress[] = [];
    const result = await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: (value) => progress.push(value) });
    expect(result.state).toBe("done");
    expect(events).toEqual(["select:codex:auto", "session", "release:L-gpt-2"]);
    expect(harness.options[0].agentDir).toBe(account.agentDir);
    expect(harness.session.disposed).toBe(true);
    expect(progress.find((value) => value.providerAccount)?.providerAccount).toEqual({ provider: "codex", id: "fallback", label: "GPT 2" });
  });

  it("leaves GPT 1 on Pi's default agent dir", async () => {
    const events: string[] = [];
    const { router } = fakeRouter(events, () => chosen({ id: "primary", label: "GPT 1" }, "L-1"));
    const harness = piHarness(events, codexModel);
    const record = task();
    const result = await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("done");
    expect("agentDir" in harness.options[0]).toBe(false);
  });

  it("does not route a non-Codex provider and does not touch the router at all", async () => {
    const events: string[] = [];
    const { router, selects } = fakeRouter(events, () => chosen({ id: "primary", label: "GPT 1" }, "L-1"));
    const harness = piHarness(events, otherModel);
    const record = task();
    const result = await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("done");
    expect(selects).toEqual([]);
    expect(events).toEqual(["session"]);
  });

  it("runs the legacy route when no router is configured", async () => {
    const events: string[] = [];
    const harness = piHarness(events, codexModel);
    const record = task();
    const progress: WorkerProgress[] = [];
    const result = await createPiWorkerRunner(harness.runnerOptions)({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: (value) => progress.push(value) });
    expect(result.state).toBe("done");
    expect("agentDir" in harness.options[0]).toBe(false);
    expect(progress.some((value) => value.providerAccount)).toBe(false);
  });

  it("queues a pinned session at its own account without opening the session or switching", async () => {
    const events: string[] = [];
    const { router, selects } = fakeRouter(events, () => ({ kind: "queued", error: "GPT 2 at its usage limit" }));
    const harness = piHarness(events, codexModel);
    const record = task({ sessionFile: "/nonexistent/session.jsonl", providerAccount: { provider: "codex", id: "fallback", label: "GPT 2" } });
    const result = await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router, accountQueue: { maxWaitMs: 0 } })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(selects.map((request) => request.account)).toEqual(["fallback"]);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/Waiting for GPT account capacity ended after \d+ min: GPT 2 at its usage limit; no inference started/);
    expect(harness.sessionFactory).not.toHaveBeenCalled();
    expect(events).toEqual(["select:codex:fallback"]);
  });

  it("pins history written before balancing to the primary account", async () => {
    const events: string[] = [];
    const { router, selects } = fakeRouter(events, () => ({ kind: "queued", error: "busy" }));
    const harness = piHarness(events, codexModel);
    const record = task();
    record.sessionFile = "/nonexistent/session.jsonl";
    await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router, accountQueue: { maxWaitMs: 0 } })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(selects[0].account).toBe("primary");
  });

  it("settles a cancelled queue wait as aborted, never as failed work", async () => {
    const events: string[] = [];
    const { router } = fakeRouter(events, () => ({ kind: "queued", error: "busy" }));
    const harness = piHarness(events, codexModel);
    const record = task();
    const controller = new AbortController();
    const progress: WorkerProgress[] = [];
    const pending = createPiWorkerRunner({ ...harness.runnerOptions, accounts: router })({ run: piRun("/repo", record), task: record, signal: controller.signal, onProgress: (value) => progress.push(value) });
    await vi.waitFor(() => expect(progress).toContainEqual({ state: "waiting", currentTool: "waiting for GPT account capacity" }));
    controller.abort(new DOMException("Task cancelled", "AbortError"));
    const result = await pending;
    expect(result.state).toBe("aborted");
    expect(result.error).toMatch(/waiting for GPT account capacity, no inference started/);
    expect(harness.sessionFactory).not.toHaveBeenCalled();
  });

  it("reports a Codex usage limit with its stated reset and releases the lease", async () => {
    const events: string[] = [];
    const { router, limits } = fakeRouter(events, () => chosen({ id: "primary", label: "GPT 1" }, "L-1"));
    const harness = piHarness(events, codexModel, async (session) => {
      session.emit({ type: "message_end", message: assistant("", "error", "You have hit your ChatGPT usage limit (plus plan). Try again in ~90 min.") } as AgentSessionEvent);
    });
    const record = task();
    const before = Math.floor(Date.now() / 1000);
    const result = await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router, accountQueue: { limitRetries: 0 } })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("failed");
    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({ provider: "codex", account: "primary", reason: "usage limit" });
    expect(limits[0].resetAt).toBeGreaterThanOrEqual(before + 5_400);
    expect(limits[0].resetAt).toBeLessThanOrEqual(before + 5_405);
    expect(events.at(-1)).toBe("release:L-1");
  });

  it("restarts a Codex task that hit the limit before any inference on GPT 2, in a new session", async () => {
    const events: string[] = [];
    const account = gpt2Account();
    const { router, selects } = statefulRouter(events, [{ id: "primary", label: "GPT 1" }, account]);
    let prompts = 0;
    const harness = piHarness(events, codexModel, async (session) => {
      prompts += 1;
      session.emit({ type: "message_end", message: prompts === 1 ? assistant("", "error", "You have hit your ChatGPT usage limit (plus plan). Try again in ~90 min.") : assistant("Evidence: done") } as AgentSessionEvent);
    });
    const record = task();
    const result = await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("done");
    expect(prompts).toBe(2);
    expect("agentDir" in harness.options[0]).toBe(false);
    expect(harness.options[1].agentDir).toBe(account.agentDir);
    expect(events.filter((event) => !event.startsWith("session"))).toEqual(["select:codex:auto", "limit:primary", "release:L-1", "select:codex:auto", "release:L-2"]);
    expect(selects[1].account).toBeUndefined();
  });

  it("queues a limit-hit Codex session that has history on its own account instead of moving it", async () => {
    const events: string[] = [];
    const account = gpt2Account();
    const { router, cooling, selects } = statefulRouter(events, [{ id: "primary", label: "GPT 1" }, account]);
    const harness = piHarness(events, codexModel, async (session) => {
      session.emit({ type: "message_end", message: { ...assistant("", "error", "You have hit your ChatGPT usage limit (plus plan). Try again in ~2 min."), usage: { ...emptyUsage(), input: 50, output: 10, totalTokens: 60 } } } as AgentSessionEvent);
    });
    const record = task({ providerAccount: { provider: "codex", id: "fallback", label: "GPT 2" } });
    const result = await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router, accountQueue: { maxWaitMs: 5 * 60_000, pollMs: 6 * 60_000, limitRetries: 2 } })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    // Work was done on GPT 2, so the retry asks for GPT 2 only, finds it cooling, and settles as a wait.
    expect(cooling.has("fallback")).toBe(true);
    expect(selects.map((request) => request.account)).toEqual(["fallback", "fallback"]);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/Waiting for GPT account capacity ended.*GPT 2 is cooling down; no further inference started/);
    expect(harness.sessionFactory).toHaveBeenCalledTimes(1);
    expect(result.usage.totalTokens).toBe(60);
    // The limited account's lease is released before the session waits for that account again.
    expect(events.filter((event) => event !== "session")).toEqual(["select:codex:fallback", "limit:fallback", "release:L-1", "select:codex:fallback"]);
  });

  it("refuses a secondary agent dir that others can read before creating a session", async () => {
    const events: string[] = [];
    const account = gpt2Account();
    chmodSync(account.agentDir!, 0o755);
    const { router } = fakeRouter(events, () => chosen(account, "L-open"));
    const harness = piHarness(events, codexModel);
    const record = task();
    const result = await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result).toMatchObject({ state: "failed", error: expect.stringMatching(/GPT 2 agent directory must be private \(mode 0700\)/) });
    expect(harness.sessionFactory).not.toHaveBeenCalled();
    expect(events).toEqual(["select:codex:auto", "release:L-open"]);
  });

  it("refuses a secondary account without auth.json before creating a session", async () => {
    const events: string[] = [];
    const { router } = fakeRouter(events, () => chosen(gpt2Account(false), "L-x"));
    const harness = piHarness(events, codexModel);
    const record = task();
    const result = await createPiWorkerRunner({ ...harness.runnerOptions, accounts: router })({ run: piRun("/repo", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("no auth.json") });
    expect(harness.sessionFactory).not.toHaveBeenCalled();
    expect(events).toEqual(["select:codex:auto", "release:L-x"]);
  });
});

// --------------------------------------------------- Coordinator and checkpoint

describe("account pin persistence", () => {
  const pin = (id: string, provider: "claude" | "codex" = "claude") => ({ provider, id, label: "bogus label from a runner" });

  it("records the first reserved account once, with the canonical label, and never remaps it", async () => {
    const runner = async ({ onProgress }: { onProgress: (progress: WorkerProgress) => void }): Promise<WorkerResult> => {
      onProgress({ providerAccount: pin("b") });
      onProgress({ providerAccount: pin("primary") });
      return { state: "done", output: "ok", turns: 1, usage: emptyUsage() };
    };
    const coordinator = new Coordinator(runner as never, { scheduler: new Scheduler(1), machineSlots: new NoopSlots() });
    const record = run({ tasks: [task({ state: "queued" })] });
    coordinator.start(record);
    const settled = await coordinator.wait(record.id, "all");
    expect(settled.tasks[0].providerAccount).toEqual({ provider: "claude", id: "b", label: "Claude 2" });
    // Snapshots are isolated copies.
    settled.tasks[0].providerAccount!.id = "primary";
    expect(coordinator.snapshot(record.id)!.tasks[0].providerAccount!.id).toBe("b");
    // A task that already carries a pin keeps it when a runner reports another.
    const resumed = run({ id: "run-acct-2", tasks: [task({ id: "run-acct-2-task-1", state: "queued", providerAccount: { provider: "claude", id: "b", label: "Claude 2" } })] });
    coordinator.start(resumed);
    expect((await coordinator.wait(resumed.id, "all")).tasks[0].providerAccount?.id).toBe("b");
    await coordinator.shutdown();
  });

  it("ignores a malformed progress pin", async () => {
    const runner = async ({ onProgress }: { onProgress: (progress: WorkerProgress) => void }): Promise<WorkerResult> => {
      onProgress({ providerAccount: pin("Bad_ID") });
      onProgress({ providerAccount: { provider: "other", id: "primary", label: "x" } as never });
      return { state: "done", output: "ok", turns: 1, usage: emptyUsage() };
    };
    const coordinator = new Coordinator(runner as never, { scheduler: new Scheduler(1), machineSlots: new NoopSlots() });
    const record = run({ tasks: [task({ state: "queued" })] });
    coordinator.start(record);
    expect((await coordinator.wait(record.id, "all")).tasks[0].providerAccount).toBeUndefined();
    await coordinator.shutdown();
  });

  it("fills in the verified directory for the very pin an explicit selector set, and changes nothing else", async () => {
    const early = { provider: "claude" as const, id: "b", label: "Claude 2" };
    const reported = { provider: "claude" as const, id: "b", label: "Claude 2", configDir: "/accounts/claude-b" };
    const settle = async (pinned: typeof early & { configDir?: string }, ...progress: WorkerProgress[]) => {
      const runner = async ({ onProgress }: { onProgress: (value: WorkerProgress) => void }): Promise<WorkerResult> => {
        for (const value of progress) onProgress(value);
        return { state: "done", output: "ok", turns: 1, usage: emptyUsage() };
      };
      const coordinator = new Coordinator(runner as never, { scheduler: new Scheduler(1), machineSlots: new NoopSlots() });
      const record = run({ id: `run-acct-${++sequence}`, tasks: [task({ id: `run-acct-${sequence}-task-1`, state: "queued", providerAccount: pinned })] });
      coordinator.start(record);
      const settled = await coordinator.wait(record.id, "all");
      await coordinator.shutdown();
      return settled.tasks[0].providerAccount;
    };
    // The same pin gains its directory; the account itself is never changed.
    expect(await settle(early, { providerAccount: reported })).toEqual(reported);
    // A different account, another provider, or a directory already recorded never rewrites the pin.
    expect(await settle(early, { providerAccount: { ...reported, id: "primary", label: "Claude 1" } })).toEqual(early);
    expect(await settle(early, { providerAccount: { provider: "codex", id: "b", label: "x", configDir: "/accounts/x" } })).toEqual(early);
    expect(await settle({ ...early, configDir: "/accounts/original" }, { providerAccount: reported })).toEqual({ ...early, configDir: "/accounts/original" });
    // A relative or control-character directory is dropped by the sanitizer.
    expect(await settle(early, { providerAccount: { ...reported, configDir: "relative/dir" } })).toEqual(early);
    expect(await settle(early, { providerAccount: { ...reported, configDir: "/accounts/b\nx" } })).toEqual(early);
    // A third account keeps its own canonical-form label.
    expect(await settle({ provider: "claude", id: "team-3", label: "Claude (team-3)" }, { providerAccount: { provider: "claude", id: "team-3", label: "Claude (team-3)", configDir: "/accounts/team-3" } }))
      .toEqual({ provider: "claude", id: "team-3", label: "Claude (team-3)", configDir: "/accounts/team-3" });
  });

  it("writes the pin to the checkpoint promptly, survives recovery, and diagnoses a queue as such", () => {
    const root = tempRoot();
    const store = new CheckpointStore(join(root, "parent.jsonl"), join(root, "checkpoints"));
    try {
      const record = run({ id: "run-acct-ckpt", tasks: [task({ id: "run-acct-ckpt-task-1", state: "running", startedAt: 1, claudeSessionId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b" })] });
      store.save(record, true);
      // Same state apart from the pin, inside the throttle window: must still be written.
      record.tasks[0].providerAccount = { provider: "claude", id: "b", label: "Claude 2" };
      store.save(record);
      const onDisk = JSON.parse(readFileSync(join(store.directory, "run-acct-ckpt.json"), "utf8")) as { run: RunRecord };
      expect(onDisk.run.tasks[0].providerAccount).toEqual({ provider: "claude", id: "b", label: "Claude 2" });
      expect(recoveredRun(store.get("run-acct-ckpt")!).tasks[0].providerAccount?.id).toBe("b");

      const queued = run({ id: "run-acct-q", state: "failed", tasks: [task({
        id: "run-acct-q-task-1", state: "failed", startedAt: 1,
        error: "Waiting for GPT account capacity ended after 30 min: GPT 1 at limit; no inference started",
        providerAccount: { provider: "codex", id: "primary", label: "GPT 1" },
      })] });
      const [diagnosis] = diagnoseRun(queued).tasks;
      expect(diagnosis).toMatchObject({ reason: "provider_account_queue", account: "GPT 1" });
    } finally { store.close(); }
  });
});

describe("account label display", () => {
  it("shows only the canonical Claude/GPT label on an expanded task and never raw account data", () => {
    const view = { runId: "run-acct", state: "running", model: "m", tasks: [
      { label: "pinned", state: "running", turns: 1, providerAccount: { provider: "claude", id: "b", label: "Claude 2", configDir: "/private/claude-b" } },
      { label: "legacy", state: "running", turns: 1 },
    ] };
    const text = renderSubagentResult({ details: { run: view } }, { expanded: true, isPartial: false }).render(100).join("\n");
    expect(text).toContain("Claude 2");
    expect(text).not.toContain("/private/claude-b");
    expect(text.match(/Claude 2/g)).toHaveLength(1);
  });
});

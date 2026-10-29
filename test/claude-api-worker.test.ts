import { afterEach, describe, expect, it } from "vitest";
import { Coordinator } from "../src/subagents/coordinator.ts";
import { Scheduler } from "../src/subagents/scheduler.ts";
import { NoopSlots } from "../src/subagents/machine-slots.ts";
import {
  buildClaudeWorkerPrompt, claudeApiWorkerArgs, claudeWorkerArgs, claudeWorkerEnv, classifyClaudeWorkerState, createClaudeWorkerRunner, parseClaudeStreamLine, type ClaudeSpawnHandle,
} from "../src/subagents/claude-worker.ts";
import { CLAUDE_API_ROUTES } from "../src/subagents/claude-api-route.ts";
import { canFallbackReview } from "../src/subagents/reviewer-fallback.ts";
import { CheckpointStore } from "../src/subagents/checkpoints.ts";
import { emptyUsage, USAP_VERSION, type RunRecord, type TaskRecord } from "../src/subagents/types.ts";
import { apiFixture, CANARY_HEADER, CANARY_KEY, CANARY_WORKSPACE, type ApiFixture } from "./helpers/claude-api-fixture.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SONNET = "claude-code-api/claude-sonnet-5-5";
const OPUS = "claude-code-api/claude-opus-5-5";
const SESSION = "11111111-2222-4333-8444-555555555555";
const GOOD_STATUS = { loggedIn: true, authMethod: "api_key_helper", apiProvider: "firstParty", apiKeySource: "apiKeyHelper" };

const fixtures: ApiFixture[] = [];
const fresh = () => { const f = apiFixture(); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

function run(model = SONNET, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: USAP_VERSION, id: "run-api-test", goal: "Inspect the leaf", constraints: ["No writes"], cwd: "/repo", model, harness: "claude-code",
    thinkingLevel: "xhigh", concurrency: 1, timeoutMs: 60_000, maxTurns: 8, background: false, state: "running", createdAt: 0,
    tasks: [task()], usage: emptyUsage(), ...overrides,
  };
}
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "run-api-test-task-1", label: "Inspect", task: "Report the routing entrypoint", role: "scout", mayEdit: false, ownedPaths: [], allowBash: false,
    state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, ...overrides,
  };
}

class FakeProcess implements ClaudeSpawnHandle {
  private static next = 9100;
  pid = FakeProcess.next++;
  exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  errorListeners: Array<(error: Error) => void> = [];
  stdoutListeners: Array<(chunk: string) => void> = [];
  stderrListeners: Array<(chunk: string) => void> = [];
  stdin: string[] = [];
  signals: string[] = [];
  onExit(l: (code: number | null, signal: string | null) => void) { this.exitListeners.push(l); }
  onError(l: (error: Error) => void) { this.errorListeners.push(l); }
  onStdout(l: (chunk: string) => void) { this.stdoutListeners.push(l); }
  onStderr(l: (chunk: string) => void) { this.stderrListeners.push(l); }
  writeStdin(text: string) { this.stdin.push(text); }
  endStdin() {}
  kill(signal?: string) { this.signals.push(signal ?? "SIGTERM"); if (signal === "SIGKILL") queueMicrotask(() => this.exit(null, "SIGKILL")); return true; }
  stdout(chunk: string) { for (const l of this.stdoutListeners) l(chunk); }
  stderr(chunk: string) { for (const l of this.stderrListeners) l(chunk); }
  exit(code: number | null = 0, signal: string | null = null) { for (const l of this.exitListeners) l(code, signal); }
}

const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
const init = (extra: Record<string, unknown> = {}, model = "claude-sonnet-5-5") =>
  frame({ type: "system", subtype: "init", model, apiKeySource: "apiKeyHelper", claude_code_version: "2.1.296", session_id: SESSION, ...extra });
let messageNo = 0;
const assistant = (text: string, model = "claude-sonnet-5-5", extra: Record<string, unknown> = {}) =>
  frame({ type: "assistant", message: { id: `api-msg-${++messageNo}`, model, content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } }, ...extra });
const success = (text: string, cost = 0.07, model = "claude-sonnet-5-5") =>
  frame({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: cost, num_turns: 1, modelUsage: { [model]: {} } });

interface Call { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; child: FakeProcess }
function fakeSpawn(script: (child: FakeProcess) => void) {
  const calls: Call[] = [];
  return { calls, spawn: ({ command, args, env, cwd }: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }) => {
    const child = new FakeProcess(); calls.push({ command, args, env, cwd, child }); queueMicrotask(() => script(child)); return child;
  } };
}
const options = (f: ApiFixture, spawn: unknown, extra: Record<string, unknown> = {}) =>
  ({ spawn: spawn as never, abortGraceMs: 20, api: f.options, apiAuthStatus: async () => GOOD_STATUS, ...extra }) as Parameters<typeof createClaudeWorkerRunner>[0];
const ctx = (r: RunRecord, t: TaskRecord, signal = new AbortController().signal, onProgress: (p: unknown) => void = () => {}) => ({ run: r, task: t, signal, onProgress: onProgress as never });
const ok = (child: FakeProcess, text = "done") => { child.stdout(init()); child.stdout(assistant(text)); child.stdout(success(text)); child.exit(); };

describe("API argv and environment", () => {
  it("is the subscription argv behind --bare with the approved settings path and a session budget", () => {
    const subscription = claudeWorkerArgs(8, { role: "scout" }, undefined, "claude-sonnet-5-5", { id: SESSION, resume: false });
    const api = claudeApiWorkerArgs(8, { role: "scout" }, undefined, "claude-sonnet-5-5", { id: SESSION, resume: false }, { settingsPath: "/approved/settings.json", maxBudgetUsd: 0.5 });
    expect(api[0]).toBe("--bare");
    expect(api.slice(1, 1 + subscription.length)).toEqual(subscription);
    expect(api.slice(1 + subscription.length)).toEqual(["--settings", "/approved/settings.json", "--max-budget-usd", "0.5"]);
    expect(api).toContain("--model"); expect(api[api.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(api[api.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(api[api.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  it("subscription argv keeps the permission baseline plus realtime stream-json input", () => {
    expect(claudeWorkerArgs(8, { role: "scout" }, undefined, "claude-sonnet-5-5", undefined)).toEqual([
      "--print", "--output-format", "stream-json", "--input-format", "stream-json", "--replay-user-messages", "--verbose", "--model", "claude-sonnet-5-5", "--effort", "xhigh", "--no-session-persistence",
      "--permission-mode", "dontAsk", "--safe-mode", "--restricted", "--setting-sources", "", "--max-turns", "8", "--strict-mcp-config", "--tools", "Read,Grep,Glob",
    ]);
    expect(claudeWorkerArgs(8, { role: "scout" }, undefined, "claude-opus-5-5", undefined)).not.toContain("--bare");
    expect(claudeWorkerArgs(8, { role: "scout" }, undefined, "claude-opus-5-5", undefined)).not.toContain("--settings");
  });

  it.each([
    [{ settingsPath: "relative.json", maxBudgetUsd: 0.5 }, /absolute file path/],
    [{ settingsPath: "{\"apiKeyHelper\":\"x\"}", maxBudgetUsd: 0.5 }, /absolute file path/],
    [{ settingsPath: "/ok/settings.json", maxBudgetUsd: 0 }, /budget must be a positive/],
    [{ settingsPath: "/ok/settings.json", maxBudgetUsd: 26 }, /at most 25/],
    [{ settingsPath: "/ok/settings.json", maxBudgetUsd: Number.NaN }, /budget must be a positive/],
  ])("refuses an unsafe launch contract %j", (launch, pattern) => {
    expect(() => claudeApiWorkerArgs(8, {}, undefined, "claude-sonnet-5-5", undefined, launch)).toThrow(pattern);
  });

  it("keeps owned-path edit rules, shell policy and read-only invariants identical to the subscription route", () => {
    const resolve = (value: string) => value;
    const edit = { role: "worker", mayEdit: true, ownedPaths: ["/repo/src/a.ts"] };
    const sub = claudeWorkerArgs(8, edit, resolve, "claude-sonnet-5-5", undefined);
    const api = claudeApiWorkerArgs(8, edit, resolve, "claude-sonnet-5-5", undefined, { settingsPath: "/s.json", maxBudgetUsd: 1 });
    expect(api.slice(1, 1 + sub.length)).toEqual(sub);
    expect(api).toContain("Edit(//repo/src/a.ts)"); expect(api).toContain("Edit(//repo/src/a.ts/**)");
    // Read-only reviewers never receive Bash, even when requested.
    const reviewer = claudeApiWorkerArgs(8, { role: "reviewer", allowBash: true }, undefined, "claude-opus-5-5", undefined, { settingsPath: "/s.json", maxBudgetUsd: 1 });
    expect(reviewer[reviewer.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(reviewer).not.toContain("Bash");
    expect(() => claudeApiWorkerArgs(8, { mayEdit: true, ownedPaths: [] }, undefined, "claude-sonnet-5-5", undefined, { settingsPath: "/s.json", maxBudgetUsd: 1 })).toThrow(/require at least one owned path/);
    expect(() => claudeApiWorkerArgs(8, { mayEdit: false, ownedPaths: ["/repo/a"] }, undefined, "claude-sonnet-5-5", undefined, { settingsPath: "/s.json", maxBudgetUsd: 1 })).toThrow(/read-only leaves cannot own writable paths/);
    expect(() => claudeApiWorkerArgs(8, { mayEdit: true, ownedPaths: ["/repo/a*"] }, undefined, "claude-sonnet-5-5", undefined, { settingsPath: "/s.json", maxBudgetUsd: 1 })).toThrow(/metacharacter/);
  });

  it("session id and resume flags work behind --bare", () => {
    const fresh = claudeApiWorkerArgs(8, {}, undefined, "claude-sonnet-5-5", { id: SESSION, resume: false }, { settingsPath: "/s.json", maxBudgetUsd: 1 });
    expect(fresh[fresh.indexOf("--session-id") + 1]).toBe(SESSION);
    const resumed = claudeApiWorkerArgs(8, {}, undefined, "claude-sonnet-5-5", { id: SESSION, resume: true }, { settingsPath: "/s.json", maxBudgetUsd: 1 });
    expect(resumed[resumed.indexOf("--resume") + 1]).toBe(SESSION);
    expect(() => claudeApiWorkerArgs(8, {}, undefined, "claude-sonnet-5-5", { id: "not-a-uuid", resume: false }, { settingsPath: "/s.json", maxBudgetUsd: 1 })).toThrow(/lowercase UUID/);
  });

  it("the child environment never carries API, OAuth, base-URL, cloud-provider or config-dir variables", () => {
    const env = claudeWorkerEnv({
      PATH: "/bin", HOME: "/home/x", ANTHROPIC_API_KEY: CANARY_KEY, ANTHROPIC_AUTH_TOKEN: CANARY_KEY, ANTHROPIC_BASE_URL: "https://example.invalid",
      ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER, CLAUDE_CODE_OAUTH_TOKEN: CANARY_KEY, CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: "/elsewhere",
      AWS_SECRET_ACCESS_KEY: CANARY_KEY, USAP_CLAUDE_API_CONFIG: "/x",
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });
});

describe("API runner", () => {
  it("runs a leaf to done, attests API auth and the pinned model, and records a sanitized receipt", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => ok(child, "The entrypoint is index.ts"));
    const progress: unknown[] = [];
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task(), undefined, (p) => progress.push(p)));
    expect(result.state).toBe("done");
    expect(result.output).toContain("The entrypoint is index.ts");
    expect(result.usage.cost.total).toBe(0.07);
    expect(result.apiReceipt).toMatchObject({
      kind: "claude-code-api", route: SONNET, model: "claude-sonnet-5-5", auth: { method: "api_key_helper", provider: "firstParty", keySource: "apiKeyHelper" },
      attested: { preflight: true, init: true }, servedModels: ["claude-sonnet-5-5"], cliVersion: "2.1.296", budget: { leafCapUsd: 1, runCapUsd: 2, priorSpendUsd: 0, spentUsd: 0.07 },
    });
    expect(progress.some((p) => (p as { apiReceipt?: unknown }).apiReceipt !== undefined)).toBe(true);
    const [call] = calls;
    expect(call.command).toBe("claude");
    expect(call.args[0]).toBe("--bare");
    expect(call.args[call.args.indexOf("--settings") + 1]).toBe(f.settingsPath);
    expect(call.args[call.args.indexOf("--max-budget-usd") + 1]).toBe("1");
    expect(Object.keys(call.env).sort()).toEqual(Object.keys(claudeWorkerEnv()).sort());
  });

  it("leaks no secret into the prompt, argv, env, receipt, output or error", async () => {
    const f = fresh();
    process.env.ANTHROPIC_API_KEY = CANARY_KEY;
    try {
      const { spawn, calls } = fakeSpawn((child) => {
        child.stderr(`diagnostic ${CANARY_KEY} ${CANARY_HEADER}`);
        child.stdout(init()); child.stdout(assistant("report")); child.stdout(success("report")); child.exit();
      });
      const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task()));
      const everything = JSON.stringify({ stdin: calls[0].child.stdin, args: calls[0].args, env: calls[0].env, result });
      for (const canary of [CANARY_KEY, CANARY_WORKSPACE, CANARY_HEADER, f.helperPath]) expect(everything).not.toContain(canary);
      expect(calls[0].args.join(" ")).not.toContain("sk-ant");
    } finally { delete process.env.ANTHROPIC_API_KEY; }
  });

  it("sanitizes a CLI error result that echoes a secret", async () => {
    const f = fresh();
    const { spawn } = fakeSpawn((child) => {
      child.stdout(init());
      child.stdout(frame({ type: "result", subtype: "error_during_execution", is_error: true, result: `request failed ${CANARY_KEY} ${CANARY_HEADER}`, modelUsage: { "claude-sonnet-5-5": {} } }));
      child.exit();
    });
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task()));
    expect(result.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(CANARY_KEY);
    expect(JSON.stringify(result)).not.toContain(CANARY_WORKSPACE);
  });

  it.each([
    ["oauth", { apiKeySource: "oauth" }],
    ["none", { apiKeySource: "none" }],
    ["missing", { apiKeySource: undefined }],
  ])("fails closed and kills the child when init reports key source %s", async (_name, extra) => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => { child.stdout(init(extra)); child.stdout(assistant("x")); child.stdout(success("x")); child.exit(); });
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task()));
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/did not attest apiKeyHelper API authentication/);
    expect(result.apiReceipt).toBeUndefined();
    expect(calls[0].child.signals).toContain("SIGTERM");
    expect(result.output).not.toContain("x");
  });

  it("a success result without API attestation can never be done", () => {
    const state = { outputParts: ["ok"], outputLength: 2, toolErrors: 0, toolSuccesses: 0, turns: 1, turnLimitReached: false, usage: emptyUsage(), sawResult: true, modelVerified: true,
      result: { kind: "result" as const, isError: false, subtype: "success" } };
    const base = { signal: new AbortController().signal, state, maxTurns: 8, exitCode: 0, exitSignal: null };
    expect(classifyClaudeWorkerState({ ...base, apiRequired: true, apiAttested: false })).toMatchObject({ state: "failed" });
    expect(classifyClaudeWorkerState({ ...base, apiRequired: true, apiAttested: true })).toEqual({ state: "done" });
    expect(classifyClaudeWorkerState(base)).toEqual({ state: "done" });
  });

  it("the init frame parser exposes key source and CLI version", () => {
    expect(parseClaudeStreamLine(init())).toMatchObject({ kind: "identity", model: "claude-sonnet-5-5", apiKeySource: "apiKeyHelper", cliVersion: "2.1.296" });
    expect(parseClaudeStreamLine(init({ apiKeySource: undefined }))).toEqual({ kind: "identity", model: "claude-sonnet-5-5", cliVersion: "2.1.296" });
  });

  it("fails when a served frame is not the pinned model, even on the API route", async () => {
    const f = fresh();
    const { spawn } = fakeSpawn((child) => { child.stdout(init()); child.stdout(assistant("x", "claude-opus-5-5")); child.exit(); });
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task()));
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/claude-opus-5-5, not the pinned Sonnet 5.5/);
    expect(result.apiReceipt?.servedModels ?? []).not.toContain("claude-opus-5-5");
  });

  it("the Opus API route pins Opus", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => { child.stdout(init({}, "claude-opus-5-5")); child.stdout(assistant("x", "claude-opus-5-5")); child.stdout(success("x", 0.1, "claude-opus-5-5")); child.exit(); });
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(OPUS), task()));
    expect(result.state).toBe("done");
    expect(result.apiReceipt).toMatchObject({ route: OPUS, model: "claude-opus-5-5", servedModels: ["claude-opus-5-5"] });
    expect(calls[0].args[calls[0].args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  });

  it("tells an API-route worker that bare mode may omit Grep and Glob, and leaves the subscription prompt unchanged", () => {
    const api = buildClaudeWorkerPrompt(run(), task());
    const sub = buildClaudeWorkerPrompt(run("claude-code/claude-sonnet-5-5"), task());
    expect(api).toContain("minimal bare mode: Grep, Glob, Write and NotebookEdit may not be provided");
    expect(sub).not.toContain("bare mode");
    expect(api.replace(/\nThis session runs in the CLI's minimal bare mode[^\n]*/, "")).toBe(sub);
    for (const canary of [CANARY_KEY, CANARY_WORKSPACE, "apiKeyHelper", "--settings", "ANTHROPIC"]) expect(api).not.toContain(canary);
  });

  it("requires xhigh and an exact route", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn(() => {});
    const runner = createClaudeWorkerRunner(options(f, spawn));
    expect((await runner(ctx(run(SONNET, { thinkingLevel: "high" }), task()))).error).toMatch(/exact Sonnet 5.5 or Opus 5.5 xhigh route/);
    expect((await runner(ctx(run("claude-code-api/claude-sonnet-5-5-other"), task()))).error).toMatch(/exact Sonnet 5.5 or Opus 5.5 xhigh route/);
    expect(calls).toHaveLength(0);
  });
});

describe("admission at launch (fail closed, no fallback)", () => {
  it("a missing approval fails before any spawn with the exact blocker, while the subscription route is unaffected", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => { child.stdout(init({ apiKeySource: undefined }, "claude-sonnet-5-5")); child.stdout(assistant("sub", "claude-sonnet-5-5")); child.stdout(success("sub")); child.exit(); });
    const missing = join(f.dir, "absent.json");
    const apiResult = await createClaudeWorkerRunner(options(f, spawn, { api: { configPath: missing, now: f.options.now } }))(ctx(run(), task()));
    expect(apiResult.state).toBe("failed");
    expect(apiResult.error).toMatch(/ClaudeApiAdmissionError\[approval-missing\]/);
    expect(apiResult.error).toContain("no subscription, Sol or other fallback was selected");
    expect(apiResult.reviewFallbackReason).toBeUndefined();
    expect(calls).toHaveLength(0);
    // Subscription route: same runner, same injected spawn, never consults the API record.
    const subscription = await createClaudeWorkerRunner(options(f, spawn, { api: { configPath: missing, now: f.options.now } }))(ctx(run("claude-code/claude-sonnet-5-5"), task()));
    expect(subscription.state).toBe("done");
    expect(calls[0].args).not.toContain("--bare");
    expect(calls[0].args).not.toContain("--settings");
    expect(calls[0].args).not.toContain("--max-budget-usd");
    expect(subscription.apiReceipt).toBeUndefined();
  });

  it("a role outside the approval scope never launches, and an in-scope leaf records the approval provenance", async () => {
    const f = fresh();
    f.writeConfig({ roles: ["reviewer"] });
    const { spawn, calls } = fakeSpawn((child) => ok(child, "verified"));
    const runner = createClaudeWorkerRunner(options(f, spawn));
    const refused = await runner(ctx(run(), task({ role: "worker" })));
    expect(refused.state).toBe("failed");
    expect(refused.error).toMatch(/ClaudeApiAdmissionError\[role-not-approved\]/);
    expect(refused.error).toMatch(/no subscription, Sol or other fallback was selected/);
    expect(calls).toHaveLength(0);
    const verified = await runner(ctx(run(), task({ role: "reviewer" })));
    expect(verified.state).toBe("done");
    expect(verified.apiReceipt?.approval).toMatchObject({ approvedBy: "operator", source: "phase-A brief", task: "sonnet-usap-api-test", roles: ["reviewer"] });
    expect(calls).toHaveLength(1);
  });

  it("expiry and revocation between dispatch and launch stop the launch", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => ok(child));
    const expired = await createClaudeWorkerRunner(options(f, spawn, { api: { ...f.options, now: () => Date.parse("2026-10-21T00:00:00Z") } }))(ctx(run(), task()));
    expect(expired.error).toMatch(/approval-expired/);
    f.writeConfig({ routes: [OPUS] });
    const revoked = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task()));
    expect(revoked.error).toMatch(/route-not-approved/);
    expect(calls).toHaveLength(0);
  });

  it("a CLI that does not report API-key-helper auth fails the preflight before inference", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => ok(child));
    for (const status of [
      { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" },
      { ...GOOD_STATUS, apiKeySource: "none" }, {}, "garbage",
    ]) {
      const result = await createClaudeWorkerRunner(options(f, spawn, { apiAuthStatus: async () => status }))(ctx(run(), task()));
      expect(result.state).toBe("failed");
      expect(result.error).toMatch(/requires the approved apiKeyHelper credential/);
      expect(result.reviewFallbackReason).toBeUndefined();
    }
    const thrown = await createClaudeWorkerRunner(options(f, spawn, { apiAuthStatus: async () => { throw new Error(`boom ${CANARY_KEY}`); } }))(ctx(run(), task()));
    expect(thrown.state).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("a hanging or erroring subscription login never substitutes for the API route", async () => {
    // The API route does not consult the subscription login at all: a spawn-injected runner with a good API status launches.
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => ok(child));
    expect((await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task()))).state).toBe("done");
    expect(calls).toHaveLength(1);
  });
});

describe("API session budget", () => {
  it("sizes --max-budget-usd to the leaf share of the run ceiling and the spend already booked", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => ok(child));
    const runner = createClaudeWorkerRunner(options(f, spawn));
    // Two leaves share the $2 run ceiling: $1 each.
    await runner(ctx(run(SONNET, { tasks: [task(), task({ id: "t2", label: "Two" })] }), task()));
    expect(calls[0].args[calls[0].args.indexOf("--max-budget-usd") + 1]).toBe("1");
    // Three leaves: $0.66 each.
    await runner(ctx(run(SONNET, { tasks: [task(), task({ id: "t2", label: "Two" }), task({ id: "t3", label: "Three" })] }), task()));
    expect(calls[1].args[calls[1].args.indexOf("--max-budget-usd") + 1]).toBe("0.66");
    // Automatic resume after a transient cut: the coordinator carries prior usage on the task.
    await runner(ctx(run(), task({ usage: { ...emptyUsage(), cost: { ...emptyUsage().cost, total: 0.4 } } })));
    expect(calls[2].args[calls[2].args.indexOf("--max-budget-usd") + 1]).toBe("0.6");
    // Explicit bounded resume: spend booked by the predecessor, and the ceiling fixed at the original dispatch.
    await runner(ctx(run(), task({ priorSpendUsd: 0.1, apiLeafCapUsd: 0.5 })));
    expect(calls[3].args[calls[3].args.indexOf("--max-budget-usd") + 1]).toBe("0.4");
  });

  it("refuses to launch a leaf whose ceiling is already spent", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => ok(child));
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task({ priorSpendUsd: 0.99 })));
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/budget-exhausted/);
    expect(calls).toHaveLength(0);
  });

  it("a CLI budget stop is a failure with partial evidence, never done, and never retried elsewhere", async () => {
    const f = fresh();
    const { spawn } = fakeSpawn((child) => {
      child.stdout(init()); child.stdout(assistant("partial findings"));
      child.stdout(frame({ type: "result", subtype: "error_max_budget_usd", is_error: false, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 1.02, num_turns: 2, modelUsage: { "claude-sonnet-5-5": {} } }));
      child.exit();
    });
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task()));
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/session budget ceiling reached \(cap \$1\.00/);
    expect(result.error).toMatch(/no top-up or fallback/);
    expect(result.reviewFallbackReason).toBeUndefined();
    expect(result.output).toContain("partial findings");
    expect(result.apiReceipt?.budget.spentUsd).toBe(1.02);
  });

  it("credit exhaustion is reported as quota, names no fallback, and sets no review fallback", async () => {
    const f = fresh();
    const { spawn } = fakeSpawn((child) => {
      child.stdout(init({}, "claude-opus-5-5"));
      child.stdout(frame({ type: "assistant", message: { id: "synthetic-1", model: "<synthetic>", content: [{ type: "text", text: `Credit balance is too low ${CANARY_KEY}` }] }, error: "billing_error" }));
      child.exit();
    });
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(OPUS, { selection: { provider: "claude-code-api", modelId: "claude-opus-5-5", source: "override", harness: "claude-code", images: false, tools: true, automaticReview: true } }), task({ role: "reviewer" })));
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/API credit balance exhausted\); no fallback, purchase or top-up was attempted/);
    expect(JSON.stringify(result)).not.toContain(CANARY_KEY);
    expect(result.reviewFallbackReason).toBeUndefined();
    expect(canFallbackReview(run(OPUS, { selection: { provider: "claude-code-api", modelId: "claude-opus-5-5", source: "override", harness: "claude-code", images: false, tools: true, automaticReview: true } }),
      { ...result, reviewFallbackReason: "quota" }, new AbortController().signal)).toBe(false);
  });
});

describe("cancellation, resume and ownership on the API route", () => {
  it("cancels only its own child with SIGTERM then SIGKILL and settles aborted", async () => {
    const f = fresh();
    const controller = new AbortController();
    let launched!: FakeProcess;
    const { spawn, calls } = fakeSpawn((child) => { launched = child; child.stdout(init()); queueMicrotask(() => controller.abort(new DOMException("operator cancel", "AbortError"))); });
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task(), controller.signal));
    expect(result.state).toBe("aborted");
    expect(launched.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(calls).toHaveLength(1);
    expect(result.apiReceipt).toBeDefined(); // attested before the cancel; the receipt does not claim a result
    expect(result.apiReceipt?.budget.spentUsd).toBeUndefined();
  });

  it("a cancel before launch spawns nothing", async () => {
    const f = fresh();
    const controller = new AbortController(); controller.abort(new DOMException("early", "AbortError"));
    const { spawn, calls } = fakeSpawn(() => {});
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), task(), controller.signal));
    expect(result.state).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  it("a deadline during the auth probe settles timed_out without inference", async () => {
    const f = fresh();
    const controller = new AbortController();
    const { spawn, calls } = fakeSpawn(() => {});
    const result = await createClaudeWorkerRunner(options(f, spawn, { apiAuthStatus: async () => { controller.abort(new DOMException("deadline", "TimeoutError")); throw new Error("probe aborted"); } }))(ctx(run(), task(), controller.signal));
    expect(result.state).toBe("timed_out");
    expect(calls).toHaveLength(0);
  });

  it("resumes the same session on the API route with the continuation prompt and the same permissions", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => ok(child, "finished"));
    const t = task({ claudeSessionId: SESSION, mayEdit: true, ownedPaths: ["/repo/src/a.ts"], role: "worker", priorSpendUsd: 0.2 });
    const result = await createClaudeWorkerRunner(options(f, spawn))(ctx(run(), t));
    expect(result.state).toBe("done");
    const args = calls[0].args;
    expect(args[0]).toBe("--bare");
    expect(args[args.indexOf("--resume") + 1]).toBe(SESSION);
    expect(args).not.toContain("--session-id");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.8");
    expect(calls[0].child.stdin.join("")).toContain("Continue the exact assigned leaf");
    expect(calls[0].child.stdin.join("")).toContain("Owned paths:");
    expect(result.apiReceipt?.sessionId).toBe(SESSION);
    expect(result.apiReceipt?.budget.priorSpendUsd).toBe(0.2);
  });

  it("the checkpoint store pins an API run to its route: a resume cannot move to the subscription or another API model", () => {
    const root = mkdtempSync(join(tmpdir(), "usap-api-store-"));
    try {
      const store = new CheckpointStore(join(root, "parent.session"), root, "parent-1");
      const original = run(SONNET, { id: "run-api-original", state: "failed" });
      store.save(original, true);
      for (const model of ["claude-code/claude-sonnet-5-5", OPUS]) {
        expect(() => store.prepareResume("run-api-original", run(model, { id: `run-successor-${model.length}`, resumedFrom: "run-api-original" }))).toThrow(/a resume stays on the original route/);
      }
      store.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("read-only reviewers never receive shell or edit tools on the API route", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => ok(child));
    await createClaudeWorkerRunner(options(f, spawn))(ctx(run(OPUS), task({ role: "reviewer", allowBash: true })));
    const args = calls[0].args;
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("Bash");
  });
});

describe("coordinator integration", () => {
  it("settles an API run through the native coordinator, copies the receipt to the task and books the spend", async () => {
    const f = fresh();
    const { spawn } = fakeSpawn((child) => ok(child, "coordinated"));
    const coordinator = new Coordinator(createClaudeWorkerRunner(options(f, spawn)), { scheduler: new Scheduler(3), machineSlots: new NoopSlots() });
    const started = coordinator.start(run(SONNET, { tasks: [task({ state: "queued" })] }));
    const settled = await coordinator.wait(started.id, "all");
    expect(settled.state).toBe("done");
    expect(settled.tasks[0].state).toBe("done");
    expect(settled.tasks[0].apiReceipt).toMatchObject({ route: SONNET, auth: { keySource: "apiKeyHelper" }, budget: { spentUsd: 0.07 } });
    expect(settled.usage.cost.total).toBeCloseTo(0.07);
    expect(CLAUDE_API_ROUTES).toContain(settled.model);
    await coordinator.shutdown();
  });

  it("a coordinator cancel settles the API run aborted and kills the owned child", async () => {
    const f = fresh();
    let launched!: FakeProcess;
    const { spawn } = fakeSpawn((child) => { launched = child; child.stdout(init()); });
    const coordinator = new Coordinator(createClaudeWorkerRunner(options(f, spawn)), { scheduler: new Scheduler(3), machineSlots: new NoopSlots() });
    const started = coordinator.start(run(SONNET, { tasks: [task({ state: "queued" })] }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(coordinator.cancel(started.id, undefined, "operator")).toBe(true);
    const settled = await coordinator.wait(started.id, "all");
    expect(settled.tasks[0].state).toBe("aborted");
    expect(launched.signals).toContain("SIGTERM");
    await coordinator.shutdown();
  });

  it("a missing approval settles the run failed with the named blocker and no child", async () => {
    const f = fresh();
    const { spawn, calls } = fakeSpawn((child) => ok(child));
    const coordinator = new Coordinator(createClaudeWorkerRunner(options(f, spawn, { api: { configPath: join(f.dir, "gone.json"), now: f.options.now } })), { scheduler: new Scheduler(3), machineSlots: new NoopSlots() });
    const started = coordinator.start(run(SONNET, { tasks: [task({ state: "queued" })] }));
    const settled = await coordinator.wait(started.id, "all");
    expect(settled.state).toBe("failed");
    expect(settled.tasks[0].error).toMatch(/approval-missing/);
    expect(calls).toHaveLength(0);
    await coordinator.shutdown();
  });
});

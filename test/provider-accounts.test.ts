import { defaultWorkerRunner, reviewFallbackReceipt } from "../extensions/ultraterm-subagents.ts";
import { RelayBroker } from "../src/subagents/relay.ts";
import { normalizeDispatch } from "../src/subagents/policy.ts";
import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  GO_ACCOUNT_LEASE_RENEW_INTERVAL_MS,
  createGoAccountLeaseKeeper,
  noEligibleClaudeAccount,
  providerAccountCommand,
  reserveGoAccount,
  reserveCodexAccount,
  isolatedCodexAgentDir,
  type GoAccountLeaseRenewalError,
} from "../src/subagents/provider-accounts.ts";
import { canFallbackReview, isReadOnlyReviewWave, recordReviewFallback } from "../src/subagents/reviewer-fallback.ts";
import { emptyUsage, type RunRecord, type TaskRecord } from "../src/subagents/types.ts";

const dir = (id: string) => join(homedir(), ".ultraterm/provider-accounts/opencode-go", id, "agent");
describe("credential-free account contract", () => {
  it("reserves canonical Go account dirs and never changes parent environment", async () => {
    const original = process.env.PI_CODING_AGENT_DIR;
    const command = vi.fn(async (_args: string[]) => ({ ok: true, account: { id: "b", agentDir: dir("b") }, lease: "abcd" }));
    expect(await reserveGoAccount("owner", command)).toEqual({ id: "b", label: "Go 2", agentDir: dir("b"), lease: "abcd" });
    expect(command.mock.calls[0][0]).toEqual(["select", "--provider", "opencode-go", "--reserve", "--owner", "owner", "--ttl", "3600"]);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(original);
  });
  it("releases an unsafe selection instead of using ambient credentials", async () => {
    const command = vi.fn(async () => ({ ok: true, account: { id: "b", agentDir: "/tmp/ambient" }, lease: "abcd" }));
    await expect(reserveGoAccount("owner", command)).rejects.toThrow(/Unsafe/);
    expect(command).toHaveBeenLastCalledWith(["release", "--lease", "abcd"]);
  });
  it("unknown router state never proves Claude unavailable", async () => {
    for (const response of [{}, { providers: { claude: { accounts: [] } } }, { providers: { claude: { accounts: [{}] } } }]) {
      expect(await noEligibleClaudeAccount(async () => response)).toBe(false);
    }
    expect(await noEligibleClaudeAccount(async () => { throw new Error("offline"); })).toBe(false);
    expect(await noEligibleClaudeAccount(async () => ({ providers: { claude: { accounts: [{ eligible: false }, { eligible: true }] } } }))).toBe(false);
    expect(await noEligibleClaudeAccount(async () => ({ providers: { claude: { accounts: [{ eligible: false }, { eligible: false }] } } }))).toBe(true);
  });
});

describe("automatic-only official review fallback", () => {
  const run = () => ({ model: "claude-code/claude-opus-5-5", selection: { automaticReview: true, reviewRequiresImages: false }, tasks: [{ role: "reviewer" }] }) as RunRecord;
  const result = () => ({ state: "failed" as const, turns: 0, output: "", usage: emptyUsage(), reviewFallbackReason: "quota" as const });
  it("accepts only trusted pre-output quota/auth classification", () => {
    expect(canFallbackReview(run(), result(), new AbortController().signal)).toBe(true);
    expect(canFallbackReview(run(), { ...result(), reviewFallbackReason: "auth" }, new AbortController().signal)).toBe(true);
    expect(canFallbackReview(run(), { ...result(), reviewFallbackReason: undefined, error: "quota exceeded" }, new AbortController().signal)).toBe(false);
    const task = {} as TaskRecord;
    recordReviewFallback(task, "quota");
    expect(task.reviewFallback).toEqual({ from: "claude-code/claude-opus-5-5", to: "openai-codex/gpt-6.1-sol", reason: "quota" });
  });
  it.each([{ mayEdit: true }, { allowBash: true }, { ownedPaths: ["src/[slug].astro"] }])("never falls back a privileged reviewer after quota/auth: %j", (permissions) => {
    const privileged = run(); Object.assign(privileged.tasks[0], permissions);
    expect(isReadOnlyReviewWave(privileged.tasks)).toBe(false);
    for (const reason of ["quota", "auth"] as const) {
      expect(canFallbackReview(privileged, { ...result(), reviewFallbackReason: reason }, new AbortController().signal)).toBe(false);
    }
  });
  it("admits only permission-free reviewers as a read-only review wave", () => {
    expect(isReadOnlyReviewWave([])).toBe(false);
    expect(isReadOnlyReviewWave([{ role: "reviewer" }, { role: "reviewer", mayEdit: false, allowBash: false, ownedPaths: [] }])).toBe(true);
    expect(isReadOnlyReviewWave([{ role: "reviewer" }, { role: "worker" }])).toBe(false);
    expect(isReadOnlyReviewWave([{ role: "reviewer" }, { role: "reviewer", allowBash: true }])).toBe(false);
    expect(isReadOnlyReviewWave([{ role: "reviewer", ownedPaths: "src" as unknown as string[] }])).toBe(false);
  });
  it("never changes explicit routes, mixed waves, image review, cancelled or unsettled children", () => {
    const explicit = run(); explicit.selection!.automaticReview = false;
    const images = run(); images.selection!.reviewRequiresImages = true;
    const mixed = run(); mixed.tasks.push({ role: "worker" } as TaskRecord);
    for (const candidate of [explicit, images, mixed]) expect(canFallbackReview(candidate, result(), new AbortController().signal)).toBe(false);
    const controller = new AbortController(); controller.abort();
    expect(canFallbackReview(run(), result(), controller.signal)).toBe(false);
    expect(canFallbackReview(run(), { ...result(), cleanup: Promise.resolve() }, new AbortController().signal)).toBe(false);
  });
});

describe("real default-runner automatic fallback wiring (offline)", () => {
  const model = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text"] } as any;
  /** An implicit Opus review whose Claude child fails before output on a weekly-limit message. */
  function quotaFixture(permissions: { allowBash?: boolean } = {}) {
    const run = normalizeDispatch({ goal: "review", tasks: [{ label: "review", role: "reviewer", task: "inspect only", ...permissions }] }, process.cwd(), "claude-code/claude-opus-5-5", "xhigh", 0, () => "run-review-fixture");
    run.harness = "claude-code";
    run.selection = { provider: "claude-code", modelId: "claude-opus-5-5", source: "override", harness: "claude-code", images: true, tools: true, automaticReview: true, reviewRequiresImages: false };
    const task = run.tasks[0];
    const relay = new RelayBroker(); relay.createRun(run.id, ["parent", task.id]);
    const runtimes = new Map([[`${run.id}:review-fallback`, { model, thinkingLevel: "high" as const }]]);
    const spawn = (() => {
      const listeners: Record<string, any> = {};
      let started = false;
      return { pid: 999, onExit: (fn: any) => listeners.exit = fn, onError() {}, onStdout: (fn: any) => listeners.stdout = fn, onStderr() {}, writeStdin(text: string) {
        if (started) return;
        started = true;
        expect(text.endsWith("\n")).toBe(true);
        expect(JSON.parse(text)).toMatchObject({ type: "user", message: { role: "user", content: expect.any(String) } });
        // Stream-json keeps stdin open for relay input; respond to the prompt, not EOF.
        queueMicrotask(() => {
          listeners.stdout(JSON.stringify({ type: "assistant", message: { id: "synthetic", model: "<synthetic>", content: [{ type: "text", text: "You've hit your weekly limit" }] } }) + "\n");
          listeners.exit(1, null);
        });
      }, kill() { return true; }, endStdin() {} };
    }) as any;
    return { run, task, relay, runtimes, spawn };
  }
  it("refuses runtime fallback for a privileged reviewer even with a frozen Sol runtime", async () => {
    const { run, task, relay, runtimes, spawn } = quotaFixture({ allowBash: true });
    const factory = vi.fn(async () => { throw new Error("must not launch Sol"); });
    const accountCommand = vi.fn(async () => ({ ok: true }));
    const result = await defaultWorkerRunner(relay, runtimes, spawn, accountCommand, factory)({ run, task, signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed");
    expect(factory).not.toHaveBeenCalled();
    expect(accountCommand).not.toHaveBeenCalled();
    expect(task.reviewFallback).toBeUndefined();
    expect(task.allowBash).toBe(true);
    expect(run.model).toBe("claude-code/claude-opus-5-5");
  });
  it.each([false, true])("records actual Sol completion or failure (failure=%s)", async failure => {
    const { run, task, relay, runtimes, spawn } = quotaFixture();
    let listener: any;
    const factory = vi.fn(async (options: any) => {
      expect(options.model.id).toBe("gpt-6.1-sol");
      if (failure) throw new Error("Sol unavailable");
      return { session: { isStreaming: false, subscribe(fn: any) { listener = fn; return () => {}; }, async prompt() {
        listener({ type: "message_end", message: { role: "assistant", provider: model.provider, model: model.id, api: model.api, content: [{ type: "text", text: "Sol review evidence" }], stopReason: "stop", usage: emptyUsage(), timestamp: 0 } });
      }, async steer() {}, async abort() {}, dispose() {} } };
    });
    const accountCommand = vi.fn(async (args: string[]) => args[0] === "select"
      ? { ok: true, account: { id: "primary", agentDir: isolatedCodexAgentDir("primary") }, lease: "codex-lease" } : { ok: true });
    const runner = defaultWorkerRunner(relay, runtimes, spawn, accountCommand, factory);
    const result = await runner({ run, task, signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe(failure ? "failed" : "done");
    expect(task.reviewFallback?.to).toBe("openai-codex/gpt-6.1-sol");
    expect(task.allowBash).toBe(false);
    expect(run.model).toBe("claude-code/claude-opus-5-5");
    task.state = result.state;
    expect(reviewFallbackReceipt(run, "/fixture")).toBe(failure ? "" : `Sol fallback review: USAP ${run.id} receipt=/fixture/${run.id}.json report=${task.id}`);
  });
});

const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
const until = async (predicate: () => boolean, deadlineMs = 3_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs;
  while (!predicate() && Date.now() < deadline) await wait(5);
};
const renewCount = (command: { mock: { calls: unknown[][] } }) => command.mock.calls.filter(([args]) => (args as string[])[0] === "renew").length;
const releaseCount = (command: { mock: { calls: unknown[][] } }) => command.mock.calls.filter(([args]) => (args as string[])[0] === "release").length;
/** A gated fixture: renewals block until the test opens the gate, so overlap is observable. */
function gatedCommand() {
  const order: string[] = [];
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  let concurrent = 0, peak = 0;
  const command = vi.fn(async (args: string[]) => {
    order.push(args[0]);
    concurrent += 1; peak = Math.max(peak, concurrent);
    if (args[0] === "renew") await gate;
    concurrent -= 1;
    return args[0] === "renew" ? { ok: true, renewed: true, leaseExpiresAt: 1 } : { ok: true, released: true };
  });
  return { command, order, openGate: () => openGate(), peak: () => peak };
}

describe("serialized Go lease renewal", () => {
  it("keeps a long ownership renewed on a bounded cadence and stops before release", async () => {
    expect(GO_ACCOUNT_LEASE_RENEW_INTERVAL_MS).toBe(1_200_000);
    const command = vi.fn(async (args: string[]) => args[0] === "renew" ? { ok: true, renewed: true, leaseExpiresAt: 1 } : { ok: true });
    const keeper = createGoAccountLeaseKeeper({ lease: "abcd", command, intervalMs: 5, timeoutMs: 500 });
    keeper.start();
    keeper.start(); // idempotent: still one cadence, not two
    await until(() => renewCount(command) >= 2);
    expect(keeper.failure()).toBeUndefined();
    expect(keeper.stopped).toBe(false);
    expect(command.mock.calls.every(([args]) => args[0] === "renew")).toBe(true);
    expect(command.mock.calls[0][0]).toEqual(["renew", "--lease", "abcd", "--ttl", "3600"]);
    await keeper.release();
    expect(keeper.stopped).toBe(true);
    expect(command.mock.calls.at(-1)![0]).toEqual(["release", "--lease", "abcd"]);
    const settled = command.mock.calls.length;
    await wait(40);
    expect(command.mock.calls.length).toBe(settled);
    await keeper.renew(); // never renews after release
    expect(command.mock.calls.length).toBe(settled);
    await keeper.release();
    expect(releaseCount(command)).toBe(1);
  });

  it("fails closed with a named reason when the router no longer holds the lease", async () => {
    const command = vi.fn(async (args: string[]) => args[0] === "renew" ? { ok: true, renewed: false } : { ok: true });
    const failures: GoAccountLeaseRenewalError[] = [];
    const keeper = createGoAccountLeaseKeeper({
      lease: "abcd", command, intervalMs: 5, timeoutMs: 500, onFailure: (error) => failures.push(error),
    });
    keeper.start();
    await until(() => keeper.failure() !== undefined);
    expect(keeper.failure()?.reason).toBe("lease-lost");
    expect(keeper.failure()?.message).toMatch(/Go account lease renewal failed \(lease-lost\)/);
    expect(failures).toEqual([keeper.failure()]);
    expect(keeper.stopped).toBe(true);
    const settled = command.mock.calls.length;
    await wait(40);
    expect(command.mock.calls.length).toBe(settled); // one failure stops the timer: no retry storm
    await keeper.stop();
    expect(command.mock.calls.length).toBe(settled);
  });

  it("refuses a renewal answer that is not ok:true with a boolean renewed flag", async () => {
    const command = vi.fn(async (_args: string[]) => ({ ok: true }));
    const keeper = createGoAccountLeaseKeeper({ lease: "abcd", command, intervalMs: 5, timeoutMs: 100 });
    await expect(keeper.renew()).rejects.toThrow(/invalid-response/);
    expect(keeper.failure()?.reason).toBe("invalid-response");
    expect(keeper.stopped).toBe(true);
    expect(command.mock.calls.map(([args]) => args)).toEqual([["renew", "--lease", "abcd", "--ttl", "3600"]]);
  });

  it("fails closed on a bounded router timeout instead of pinning the task", async () => {
    const command = vi.fn(() => new Promise<never>(() => {}));
    const keeper = createGoAccountLeaseKeeper({ lease: "abcd", command, intervalMs: 5, timeoutMs: 10 });
    keeper.start();
    await until(() => keeper.failure() !== undefined);
    expect(keeper.failure()?.reason).toBe("router-timeout");
    expect(keeper.failure()?.message).toMatch(/no answer within 10 ms/);
    await keeper.stop();
    await expect(keeper.renew()).resolves.toBeUndefined();
  });

  it("reports a rejected router call as a bounded router-error, never a hang", async () => {
    const command = vi.fn(async () => { throw new Error("Provider account router refused: no opencode-go account can take a launch now"); });
    const keeper = createGoAccountLeaseKeeper({ lease: "abcd", command, intervalMs: 5, timeoutMs: 100 });
    await expect(keeper.renew()).rejects.toThrow(/router-error.*no opencode-go account can take a launch now/);
    expect(keeper.failure()?.reason).toBe("router-error");
  });

  it("never overlaps two renewals and never releases while a renewal is in flight", async () => {
    const { command, order, openGate, peak } = gatedCommand();
    const keeper = createGoAccountLeaseKeeper({ lease: "abcd", command, intervalMs: 5, timeoutMs: 1_000 });
    const first = keeper.renew();
    const second = keeper.renew();
    await until(() => order.length === 1);
    expect(order).toEqual(["renew"]);
    const releasing = keeper.release();
    await wait(20);
    expect(order).toEqual(["renew"]);
    expect(releaseCount(command)).toBe(0);
    openGate();
    await Promise.all([first, second]);
    await releasing;
    expect(order).toEqual(["renew", "release"]); // the queued renewal was dropped, never raced
    expect(peak()).toBe(1);
    await keeper.renew();
    expect(order).toEqual(["renew", "release"]);
  });

  it("rejects a cadence longer than the TTL it must keep alive", () => {
    const command = vi.fn(async (_args: string[]) => ({ ok: true, renewed: true }));
    expect(() => createGoAccountLeaseKeeper({ lease: "abcd", command, ttlSeconds: 60, intervalMs: 60_001 })).toThrow(/intervalMs/);
    expect(() => createGoAccountLeaseKeeper({ lease: "abcd", command, intervalMs: 0 })).toThrow(/intervalMs/);
    expect(() => createGoAccountLeaseKeeper({ lease: "abcd", command, timeoutMs: -1 })).toThrow(/timeoutMs/);
  });
});

describe("router failure reporting", () => {
  const withRouter = async (router: string, run: () => Promise<unknown>) => {
    const previous = process.env.ULTRATERM_ACCOUNT_ROUTER;
    process.env.ULTRATERM_ACCOUNT_ROUTER = router;
    try { return await run(); }
    finally {
      if (previous === undefined) delete process.env.ULTRATERM_ACCOUNT_ROUTER;
      else process.env.ULTRATERM_ACCOUNT_ROUTER = previous;
    }
  };
  it("keeps the router's own structured refusal instead of an opaque unavailability", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "steak-pi-router-"));
    const script = join(fixture, "fake-router");
    await writeFile(script, "#!/bin/sh\necho '{\"ok\": false, \"queued\": false, \"error\": \"no opencode-go account can take a launch now; queued, not failed\"}'\nexit 2\n");
    await chmod(script, 0o755);
    try {
      await withRouter(script, async () => {
        await expect(providerAccountCommand(["select", "--provider", "opencode-go", "--reserve"])).rejects
          .toThrow(/router refused: no opencode-go account can take a launch now; queued, not failed/);
      });
    } finally { await rm(fixture, { recursive: true, force: true }); }
    // The real Go account dirs are still the only ones a reservation may name.
    expect(dir("b")).toBe(join(homedir(), ".ultraterm/provider-accounts/opencode-go", "b", "agent"));
  });
  it("falls back to a bounded unavailability notice when the router has no structured cause", async () => {
    await withRouter(join(tmpdir(), `steak-pi-absent-router-${process.pid}`), async () => {
      await expect(providerAccountCommand(["status"])).rejects.toThrow(/unavailable or no account eligible \(ENOENT\)/);
    });
  });
});


describe("Codex account metadata validation", () => {
  it.each(["primary", "fallback"] as const)("pins canonical %s with GPT labels", async id => {
    const command = vi.fn(async (_args: string[]) => ({ ok: true, account: { id, agentDir: isolatedCodexAgentDir(id) }, lease: "codex-lease" }));
    const account = await reserveCodexAccount("child", command, id);
    expect(account.label).toBe(id === "primary" ? "GPT1" : "GPT2");
    expect(command.mock.calls[0][0]).toEqual(["select", "--provider", "codex", "--reserve", "--owner", "child", "--ttl", "3600", "--account", id]);
  });
  it("releases mismatched pins and noncanonical directories", async () => {
    for (const agentDir of [isolatedCodexAgentDir("fallback"), "/tmp/ambient"]) {
      const command = vi.fn(async (_args: string[]) => ({ ok: true, account: { id: "fallback", agentDir }, lease: "codex-lease" }));
      await expect(reserveCodexAccount("child", command, "primary")).rejects.toThrow(/Unsafe Codex/);
      expect(command).toHaveBeenLastCalledWith(["release", "--lease", "codex-lease"]);
    }
  });
});

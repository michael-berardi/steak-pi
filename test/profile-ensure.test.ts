// The pre-launch `ensure` hook of a worker profile: how the command runs (argv, no shell, env passed through,
// bounded), how a failure refuses the launch, and that `release` runs however the worker ends.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ENSURE_REFUSAL_PREFIX, RELEASE_TIMEOUT_MS, ensureOf, isEnsureRefusal, runEnsureCommand, withProfileEnsure, type EnsureExec, type EnsureExecResult } from "../src/subagents/profile-ensure.ts";
import { emptyUsage, type RunRecord, type TaskRecord, type WorkerResult, type WorkerRunContext, type WorkerRunner } from "../src/subagents/types.ts";

const dir = mkdtempSync(join(tmpdir(), "steak-pi-ensure-"));
let files = 0;
const ENSURE = { command: ["/opt/hook/up", "--start"], release: ["/opt/hook/down"], timeoutMs: 5_000 };
const PROFILE = "hub/local-profile";
const ROUTE = "local-p/small-model";

function configure(config: Record<string, unknown> | string): void {
  const file = join(dir, `routing-${++files}.json`);
  writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
  vi.stubEnv("STEAK_PI_ROUTING_CONFIG", file);
}
const withProfile = (ensure: unknown = ENSURE, model = ROUTE) => configure({ workerProfiles: [{ id: PROFILE, model, ensure }] });

const ok = (): EnsureExecResult => ({ ok: true, code: 0, signal: null, timedOut: false, aborted: false, stderr: "" });
const failed = (over: Partial<EnsureExecResult> = {}): EnsureExecResult => ({ ok: false, code: 3, signal: null, timedOut: false, aborted: false, stderr: "port 8080 is busy\n", ...over });

function context(over: { profile?: string | null; model?: string; harness?: RunRecord["harness"]; signal?: AbortSignal } = {}) {
  const task = { id: "t1", label: "leaf" } as TaskRecord;
  const progress: Array<Record<string, unknown>> = [];
  const profile = over.profile === undefined ? PROFILE : over.profile;
  const run = {
    id: "run-1", model: over.model ?? ROUTE, ...(over.harness ? { harness: over.harness } : {}),
    selection: { provider: "local-p", modelId: "small-model", source: "chain", images: false, tools: true, ...(profile ? { profile } : {}) },
  } as unknown as RunRecord;
  const ctx: WorkerRunContext = { run, task, signal: over.signal ?? new AbortController().signal, onProgress: (p) => { progress.push(p as Record<string, unknown>); } };
  return { ctx, task, progress };
}
const done = (): WorkerResult => ({ state: "done", output: "ok", turns: 1, usage: emptyUsage() });

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe("runEnsureCommand: the real process boundary", () => {
  const node = process.execPath;
  const run = (script: string, timeoutMs = 10_000, extra: string[] = []) => runEnsureCommand([node, "-e", script, ...extra], { timeoutMs });

  it("reports success for exit 0 and the exit code plus stderr for a failure", async () => {
    expect((await run("process.exit(0)")).ok).toBe(true);
    const bad = await run("console.error('server did not start'); process.exit(7)");
    expect(bad).toMatchObject({ ok: false, code: 7, timedOut: false, aborted: false });
    expect(bad.stderr).toContain("server did not start");
  });

  it("runs the argv with no shell: metacharacters are literal arguments", async () => {
    const marker = join(dir, "shell-ran");
    const result = await run("process.exit(process.argv.slice(1).join('|') === '; touch X && echo $HOME' ? 0 : 9)", 10_000, [`; touch X && echo $HOME`]);
    expect(result.ok).toBe(true);
    // And a shell metacharacter in the program position is just a missing program.
    const missing = await runEnsureCommand([`${marker}; touch ${marker}`], { timeoutMs: 5_000 });
    expect(missing).toMatchObject({ ok: false, spawnError: "ENOENT" });
  });

  it("passes the environment through", async () => {
    vi.stubEnv("ENSURE_PROBE_VALUE", "carried");
    expect((await run("process.exit(process.env.ENSURE_PROBE_VALUE === 'carried' ? 0 : 5)")).ok).toBe(true);
  });

  it("kills a command that outlives its timeout and says so", async () => {
    const started = Date.now();
    const result = await run("setTimeout(() => {}, 60000)", 300);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops a running command when the worker is aborted", async () => {
    const controller = new AbortController();
    const pending = runEnsureCommand([node, "-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 30_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await pending).toMatchObject({ ok: false, aborted: true });
  });

  it("does not wait for a server the command left running with stderr open", async () => {
    const script = "const { spawn } = require('node:child_process'); spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true }).unref(); process.exit(0)";
    const started = Date.now();
    const result = await run(script);
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("ensureOf: only the operator's routing.json counts", () => {
  it("is absent for a run with no recorded profile, a profile without ensure, or an unknown profile", () => {
    withProfile();
    expect(ensureOf({ model: ROUTE, selection: undefined })).toBeUndefined();
    configure({ workerProfiles: [{ id: PROFILE, model: ROUTE }] });
    expect(ensureOf(context().ctx.run)).toBeUndefined();
    withProfile();
    expect(ensureOf(context({ profile: "hub/other" }).ctx.run)).toBeUndefined();
  });

  it("resolves the hook of the recorded profile and refuses a profile that no longer serves the run's route", () => {
    withProfile();
    expect(ensureOf(context().ctx.run)).toEqual({ profile: PROFILE, ensure: ENSURE });
    withProfile(ENSURE, "local-p/other-model");
    expect(() => ensureOf(context().ctx.run)).toThrow(/now serves local-p\/other-model, not this run's local-p\/small-model/);
  });
});

describe("withProfileEnsure: launch lifecycle", () => {
  function harness(exec: EnsureExec, runner: WorkerRunner) {
    return withProfileEnsure(runner, { exec });
  }

  it("changes nothing for a run without a profile or a profile without a hook", async () => {
    const exec = vi.fn<EnsureExec>(async () => ok());
    const runner = vi.fn(async () => done());
    withProfile();
    expect((await harness(exec, runner)(context({ profile: null }).ctx)).state).toBe("done");
    configure({ workerProfiles: [{ id: PROFILE, model: ROUTE }] });
    expect((await harness(exec, runner)(context().ctx)).state).toBe("done");
    expect(exec).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("runs ensure, then the worker, then release, and records the receipt", async () => {
    withProfile();
    const order: string[] = [];
    const exec = vi.fn<EnsureExec>(async (argv) => { order.push(argv[0].split("/").pop()!); return ok(); });
    const runner = vi.fn(async () => { order.push("worker"); return done(); });
    const { ctx, task } = context();
    const result = await harness(exec, runner)(ctx);
    expect(result.state).toBe("done");
    expect(order).toEqual(["up", "worker", "down"]);
    expect(exec.mock.calls[0]).toEqual([ENSURE.command, { timeoutMs: 5_000, signal: ctx.signal }]);
    expect(task.profileEnsure).toEqual({ profile: PROFILE, state: "released" });
  });

  it("refuses the launch with the command's stderr as the named cause, and never runs the worker or release", async () => {
    withProfile();
    const exec = vi.fn<EnsureExec>(async () => failed());
    const runner = vi.fn(async () => done());
    const { ctx, task } = context();
    const result = await harness(exec, runner)(ctx);
    expect(runner).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1); // no release: the command failed on its own, it holds nothing
    expect(result).toMatchObject({ state: "failed", turns: 0 });
    expect(result.error).toContain(`${ENSURE_REFUSAL_PREFIX} (${PROFILE}): port 8080 is busy (exited with code 3)`);
    expect(isEnsureRefusal(result.error)).toBe(true);
    expect(task.profileEnsure).toMatchObject({ profile: PROFILE, state: "refused", cause: expect.stringContaining("port 8080 is busy") });
  });

  it.each([
    ["cannot start", failed({ code: null, stderr: "", spawnError: "ENOENT" }), /could not start \(ENOENT\)/],
    ["killed by a signal with no output", failed({ code: null, signal: "SIGKILL", stderr: "" }), /was killed by SIGKILL/],
  ])("names a command that %s", async (_name, outcome, cause) => {
    withProfile();
    const result = await harness(vi.fn(async () => outcome), vi.fn(async () => done()))(context().ctx);
    expect(result.error).toMatch(cause);
  });

  it("bounds the cause it echoes and strips control characters", async () => {
    withProfile();
    const noisy = failed({ stderr: `${"x".repeat(2_000)}\u001b[31mred\u0000\n` });
    const result = await harness(vi.fn(async () => noisy), vi.fn(async () => done()))(context().ctx);
    expect(result.error!.length).toBeLessThan(700);
    expect(result.error).not.toMatch(/[\u0000-\u0008\u001b]/);
  });

  it("releases after a launch timeout (it may hold a lease) and still refuses", async () => {
    withProfile();
    const calls: string[] = [];
    const exec = vi.fn<EnsureExec>(async (argv) => { calls.push(argv[0]); return calls.length === 1 ? failed({ timedOut: true, stderr: "" }) : ok(); });
    const runner = vi.fn(async () => done());
    const { ctx, task } = context();
    const result = await harness(exec, runner)(ctx);
    expect(result.error).toMatch(/timed out after 5s/);
    expect(runner).not.toHaveBeenCalled();
    expect(calls).toEqual(["/opt/hook/up", "/opt/hook/down"]);
    expect(task.profileEnsure).toMatchObject({ state: "refused" });
  });

  it("releases when the worker fails", async () => {
    withProfile();
    const exec = vi.fn<EnsureExec>(async () => ok());
    const failedWorker: WorkerResult = { state: "failed", output: "", error: "boom", turns: 2, usage: emptyUsage() };
    const result = await harness(exec, vi.fn(async () => failedWorker))(context().ctx);
    expect(result).toEqual(failedWorker);
    expect(exec.mock.calls.map(([argv]) => argv[0])).toEqual(["/opt/hook/up", "/opt/hook/down"]);
  });

  it("releases when the worker throws, and the throw still propagates", async () => {
    withProfile();
    const exec = vi.fn<EnsureExec>(async () => ok());
    await expect(harness(exec, vi.fn(async () => { throw new Error("runner crashed"); }))(context().ctx)).rejects.toThrow("runner crashed");
    expect(exec.mock.calls.map(([argv]) => argv[0])).toEqual(["/opt/hook/up", "/opt/hook/down"]);
  });

  it("releases when the worker is aborted, and the release is not cancelled by that abort", async () => {
    withProfile();
    const controller = new AbortController();
    const exec = vi.fn<EnsureExec>(async () => ok());
    const runner = vi.fn(async ({ signal }: WorkerRunContext): Promise<WorkerResult> => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { state: "aborted", output: "", turns: 1, usage: emptyUsage() };
    });
    const pending = harness(exec, runner)(context({ signal: controller.signal }).ctx);
    await vi.waitFor(() => expect(runner).toHaveBeenCalled());
    controller.abort();
    expect((await pending).state).toBe("aborted");
    expect(exec.mock.calls.map(([argv]) => argv[0])).toEqual(["/opt/hook/up", "/opt/hook/down"]);
    expect(exec.mock.calls[1][1]).toEqual({ timeoutMs: 5_000 }); // no signal: cleanup survives the abort
  });

  it("an abort during ensure ends the launch as aborted and still releases", async () => {
    withProfile();
    const controller = new AbortController();
    const exec = vi.fn<EnsureExec>(async (argv, options) => {
      if (!argv[0].endsWith("/up")) return ok();
      await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return failed({ aborted: true, stderr: "" });
    });
    const runner = vi.fn(async () => done());
    const pending = harness(exec, runner)(context({ signal: controller.signal }).ctx);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    controller.abort();
    const result = await pending;
    expect(result.state).toBe("aborted");
    expect(runner).not.toHaveBeenCalled();
    expect(exec.mock.calls.map(([argv]) => argv[0])).toEqual(["/opt/hook/up", "/opt/hook/down"]);
  });

  it("does not start the command at all for an already-aborted launch", async () => {
    withProfile();
    const controller = new AbortController();
    controller.abort();
    const exec = vi.fn<EnsureExec>(async () => ok());
    const result = await harness(exec, vi.fn(async () => done()))(context({ signal: controller.signal }).ctx);
    expect(result.state).toBe("aborted");
    expect(exec).not.toHaveBeenCalled();
  });

  it("bounds release by the shorter of the hook's timeout and the release ceiling", async () => {
    withProfile({ ...ENSURE, timeoutMs: 600_000 });
    const exec = vi.fn<EnsureExec>(async () => ok());
    await harness(exec, vi.fn(async () => done()))(context().ctx);
    expect(exec.mock.calls[0][1]).toMatchObject({ timeoutMs: 600_000 });
    expect(exec.mock.calls[1][1]).toEqual({ timeoutMs: RELEASE_TIMEOUT_MS });
  });

  it("keeps a finished worker's result when release fails, and records the failure", async () => {
    withProfile();
    const exec = vi.fn<EnsureExec>(async (argv) => argv[0].endsWith("/up") ? ok() : failed({ stderr: "lease file locked" }));
    const { ctx, task } = context();
    const result = await harness(exec, vi.fn(async () => done()))(ctx);
    expect(result.state).toBe("done");
    expect(task.profileEnsure).toMatchObject({ profile: PROFILE, state: "release-failed", cause: expect.stringContaining("lease file locked") });
  });

  it("runs no release when the profile has none", async () => {
    withProfile({ command: ENSURE.command });
    const exec = vi.fn<EnsureExec>(async () => ok());
    const { ctx, task } = context();
    await harness(exec, vi.fn(async () => done()))(ctx);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(task.profileEnsure).toEqual({ profile: PROFILE, state: "ensured" });
  });

  it("serves a claude-code run exactly like a Pi run", async () => {
    withProfile();
    const exec = vi.fn<EnsureExec>(async () => ok());
    const runner = vi.fn(async () => done());
    const { ctx } = context({ harness: "claude-code" });
    expect((await harness(exec, runner)(ctx)).state).toBe("done");
    expect(exec.mock.calls.map(([argv]) => argv[0])).toEqual(["/opt/hook/up", "/opt/hook/down"]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("refuses the launch, naming the cause, when the routing file cannot be read", async () => {
    configure("{ not json");
    const exec = vi.fn<EnsureExec>(async () => ok());
    const runner = vi.fn(async () => done());
    const result = await harness(exec, runner)(context().ctx);
    expect(result.state).toBe("failed");
    expect(result.error).toContain(`${ENSURE_REFUSAL_PREFIX} (${PROFILE})`);
    expect(exec).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses when the profile now serves a different route than the run froze", async () => {
    withProfile(ENSURE, "local-p/other-model");
    const exec = vi.fn<EnsureExec>(async () => ok());
    const result = await harness(exec, vi.fn(async () => done()))(context().ctx);
    expect(result.error).toMatch(/now serves local-p\/other-model/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("starts one launch of a profile at a time, so a start-if-absent command never races itself", async () => {
    withProfile();
    let active = 0;
    let peak = 0;
    const exec = vi.fn<EnsureExec>(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return ok();
    });
    const wrapped = harness(exec, vi.fn(async () => done()));
    const results = await Promise.all([1, 2, 3, 4].map(() => wrapped(context().ctx)));
    expect(results.every((result) => result.state === "done")).toBe(true);
    expect(exec).toHaveBeenCalledTimes(8);
    expect(peak).toBe(1);
  });

  it("lets a waiting launch be aborted without running its command", async () => {
    withProfile();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exec = vi.fn<EnsureExec>(async (argv) => { if (argv[0].endsWith("/up")) await gate; return ok(); });
    const wrapped = harness(exec, vi.fn(async () => done()));
    const first = wrapped(context().ctx);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const second = wrapped(context({ signal: controller.signal }).ctx);
    controller.abort();
    expect(await second).toMatchObject({ state: "aborted" });
    release();
    expect((await first).state).toBe("done");
    expect(exec.mock.calls.filter(([argv]) => argv[0].endsWith("/up"))).toHaveLength(1);
  });
});

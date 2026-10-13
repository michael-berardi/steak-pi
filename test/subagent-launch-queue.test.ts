import { afterEach, describe, expect, it, vi } from "vitest";
import { Coordinator } from "../src/subagents/coordinator.ts";
import { Scheduler } from "../src/subagents/scheduler.ts";
import { NoopSlots, type MachineSlots, type MachineCapacitySnapshot } from "../src/subagents/machine-slots.ts";
import { REVIEW_LAUNCH_TIMEOUT_MS, USAP_VERSION, emptyUsage, type RunRecord, type WorkerRunner } from "../src/subagents/types.ts";

function run(id: string, roles: ("worker" | "reviewer")[] = ["reviewer"], concurrency = 1): RunRecord {
  return { version: USAP_VERSION, id, goal: id, constraints: [], cwd: "/synthetic", model: "claude-code/claude-sonnet-5-5",
    thinkingLevel: "xhigh", concurrency, timeoutMs: 600_000, maxTurns: 64, background: true, state: "running", createdAt: Date.now(), usage: emptyUsage(),
    ownerSessionId: "parent-session", tasks: roles.map((role, i) => ({ id: `${id}-t${i}`, label: role, task: "fixture", role,
      mayEdit: false, ownedPaths: [], allowBash: false, state: "queued", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false })) };
}
const done = () => ({ state: "done" as const, output: "review", turns: 1, usage: emptyUsage() });
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

describe("synthetic launch queue coordinator checks", () => {
  it("exposes capacity holders immediately and bounds review machine waits separately", async () => {
    vi.useFakeTimers();
    const capacity: MachineCapacitySnapshot = { provider: "claude-code", providerBucket: { cap: 1, held: 1, owners: [{ index: 0, kind: "lease", status: "live", pid: 123, runId: "holder-run", taskId: "holder-task", sessionId: "holder-parent" }] }, globalBucket: { cap: 2, held: 1, owners: [] } };
    const acquire = vi.fn((_provider, signal, _timeout, options) => {
      options.onWait(capacity);
      return new Promise<() => void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const runner = vi.fn(async () => done());
    const c = new Coordinator(runner, { scheduler: new Scheduler(1), machineSlots: { acquire } as unknown as MachineSlots });
    c.start(run("machine")); await flush();
    const waiting = c.snapshot("machine")!.tasks[0];
    expect(waiting.launchQueue?.tier).toBe("machine");
    expect(waiting.launchQueue?.reason).toContain("provider claude-code 1/1");
    expect(waiting.launchQueue?.capacity?.providerBucket.owners[0].sessionId).toBe("holder-parent");
    expect(waiting.startedAt).toBeUndefined();
    waiting.launchQueue!.capacity!.providerBucket.owners[0].pid = 999;
    expect(c.snapshot("machine")!.tasks[0].launchQueue!.capacity!.providerBucket.owners[0].pid).toBe(123);
    expect(acquire.mock.calls[0][2]).toBe(REVIEW_LAUNCH_TIMEOUT_MS);
    expect(acquire.mock.calls[0][3].owner).toEqual({ runId: "machine", taskId: "machine-t0", sessionId: "parent-session" });
    await vi.advanceTimersByTimeAsync(REVIEW_LAUNCH_TIMEOUT_MS);
    const task = (await c.wait("machine", "all")).tasks[0];
    expect(task.state).toBe("timed_out"); expect(task.error).toContain("Reviewer launch queue budget exceeded");
    expect(task.lastLaunchQueue?.capacity?.providerBucket.owners[0].runId).toBe("holder-run");
    expect(task.launchQueue).toBeUndefined(); expect(task.outcome).toBeUndefined(); expect(runner).not.toHaveBeenCalled();
    await c.shutdown();
  });

  it.each(["session", "run-width"])("bounds reviews queued behind %s and never launches them late", async (tier) => {
    vi.useFakeTimers();
    const scheduler = new Scheduler(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const runner: WorkerRunner = async ({ task }) => { calls.push(task.id); if (task.role === "worker") await gate; return done(); };
    const c = new Coordinator(runner, { scheduler, machineSlots: new NoopSlots() });
    if (tier === "session") { c.start(run("holder", ["worker"])); c.start(run("review")); }
    else c.start(run("review", ["worker", "reviewer"]));
    await flush();
    const review = c.snapshot("review")!.tasks.find(t => t.role === "reviewer")!;
    expect(review.launchQueue?.tier).toBe("session");
    await vi.advanceTimersByTimeAsync(REVIEW_LAUNCH_TIMEOUT_MS);
    const stopped = c.snapshot("review")!.tasks.find(t => t.role === "reviewer")!;
    expect(stopped.state).toBe("timed_out"); expect(stopped.startedAt).toBeUndefined();
    release(); await flush();
    expect(calls.filter(id => id === stopped.id)).toHaveLength(0);
    await c.shutdown(); expect(scheduler.activeCount).toBe(0); expect(scheduler.queuedCount).toBe(0);
  });

  it("lets a shorter run deadline win even when a launch timer has not fired", async () => {
    vi.useFakeTimers();
    let clock = 10_000;
    const release = vi.fn();
    const acquire = vi.fn(async (_provider, _signal, timeout) => {
      expect(timeout).toBe(1000); clock += 1000; return release;
    });
    const runner = vi.fn(async () => done());
    const c = new Coordinator(runner, { scheduler: new Scheduler(1), machineSlots: { acquire } as unknown as MachineSlots, now: () => clock });
    const input = run("short-review"); input.timeoutMs = 1000;
    c.start(input); await flush();
    const task = (await c.wait(input.id, "all")).tasks[0];
    expect(task.state).toBe("timed_out"); expect(task.error).toBe("Run deadline exceeded");
    expect(task.startedAt).toBeUndefined(); expect(task.outcome).toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1); expect(runner).not.toHaveBeenCalled();
    await c.shutdown();
  });

  it.each(["worker", "reviewer"] as const)("classifies %s acquisition rejection at the run deadline before the timer fires", async (role) => {
    vi.useFakeTimers();
    let clock = 10_000;
    const acquire = vi.fn(async () => { clock += 1000; throw new Error("machine launch slots exhausted"); });
    const runner = vi.fn(async () => done());
    const c = new Coordinator(runner, { scheduler: new Scheduler(1), machineSlots: { acquire } as unknown as MachineSlots, now: () => clock });
    const input = run(`reject-${role}`, [role]); input.timeoutMs = 1000;
    c.start(input); await flush();
    const task = (await c.wait(input.id, "all")).tasks[0];
    expect(task.state).toBe("timed_out"); expect(task.error).toBe("Run deadline exceeded");
    expect(task.startedAt).toBeUndefined(); expect(task.outcome).toBeUndefined();
    expect(task.lastLaunchQueue).toBeDefined(); expect(runner).not.toHaveBeenCalled();
    await c.shutdown();
  });

  it("clears the launch bound before inference and leaves normal worker waits unchanged", async () => {
    vi.useFakeTimers();
    const c = new Coordinator(async ({ signal }) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return done();
    }, { scheduler: new Scheduler(1), machineSlots: new NoopSlots() });
    c.start(run("inference")); await flush();
    expect(c.snapshot("inference")!.tasks[0].launchQueue).toBeUndefined();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.snapshot("inference")!.tasks[0].state).toBe("running");
    c.cancel("inference"); await c.wait("inference", "all"); await c.shutdown();
    const acquire = vi.fn(async (_provider?: string, _signal?: AbortSignal, _timeout?: number) => () => undefined);
    const worker = new Coordinator(async () => done(), { scheduler: new Scheduler(1), machineSlots: { acquire } as unknown as MachineSlots });
    worker.start(run("worker", ["worker"])); await worker.wait("worker", "all");
    expect(acquire.mock.calls[0][2]).toBe(600_000); await worker.shutdown();
  });
});

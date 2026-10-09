import { afterEach, describe, expect, it, vi } from "vitest";
import { Coordinator, CoordinatorWaitTimeoutError, workerJournal } from "../src/subagents/coordinator.ts";
import { Scheduler } from "../src/subagents/scheduler.ts";
import { workerTurnBudget } from "../src/subagents/pi-worker.ts";
import type { MachineSlots } from "../src/subagents/machine-slots.ts";
import {
  MAX_ACTIVE_RUNS,
  MAX_RETAINED_TERMINAL_RUNS,
  USAP_VERSION,
  emptyUsage,
  type RunRecord,
  type TaskRecord,
  type UsageTotals,
  type WorkerResult,
  type WorkerRunContext,
  type WorkerRunner,
} from "../src/subagents/types.ts";

function usage(tokens: number): UsageTotals {
  return {
    input: tokens,
    output: tokens * 2,
    cacheRead: tokens * 3,
    cacheWrite: tokens * 4,
    totalTokens: tokens * 10,
    cost: {
      input: tokens / 100,
      output: tokens / 50,
      cacheRead: tokens / 200,
      cacheWrite: tokens / 100,
      total: tokens * 0.045,
    },
  };
}

function result(
  state: WorkerResult["state"] = "done",
  tokens = 1,
  output: string = state,
): WorkerResult {
  return { state, output, turns: tokens, usage: usage(tokens) };
}

function task(runId: string, index: number): TaskRecord {
  return {
    id: `${runId}-t${index}`,
    label: `task ${index}`,
    task: `do ${index}`,
    role: "worker",
    mayEdit: false,
    ownedPaths: [],
    allowBash: true,
    state: "queued",
    output: "",
    turns: 0,
    usage: emptyUsage(),
    relaySent: 0,
    relayReceived: 0,
    truncated: false,
  };
}

function run(id: string, taskCount: number, concurrency = 4, timeoutMs = 10_000): RunRecord {
  return {
    version: USAP_VERSION,
    id,
    goal: id,
    constraints: [],
    cwd: "/tmp",
    model: "fake",
    thinkingLevel: "off",
    concurrency,
    timeoutMs,
    maxTurns: 64,
    background: true,
    state: "running",
    createdAt: Date.now(),
    tasks: Array.from({ length: taskCount }, (_, index) => task(id, index + 1)),
    usage: emptyUsage(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("session scheduler", () => {
  it("cancels queued acquisition and never launches after pre-abort", async () => {
    const scheduler = new Scheduler(1);
    const gate = deferred<void>();
    const first = scheduler.run(() => gate.promise);
    await flush();

    let queuedLaunches = 0;
    const queuedAbort = new AbortController();
    const queued = scheduler.run(() => {
      queuedLaunches += 1;
    }, queuedAbort.signal);
    await flush();
    expect(scheduler.activeCount).toBe(1);
    expect(scheduler.queuedCount).toBe(1);

    queuedAbort.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(queuedLaunches).toBe(0);
    expect(scheduler.queuedCount).toBe(0);

    const preAbort = new AbortController();
    preAbort.abort();
    await expect(scheduler.run(() => {
      queuedLaunches += 1;
    }, preAbort.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(queuedLaunches).toBe(0);

    gate.resolve();
    await first;
    expect(scheduler.activeCount).toBe(0);
  });
});

describe("subagent coordinator", () => {
  it("keeps a six-hour task alive beyond legacy limits and enforces the absolute deadline", async () => {
    vi.useFakeTimers();
    const changes: RunRecord[] = [];
    const coordinator = new Coordinator(async ({ signal, onProgress }) => {
      onProgress({ turns: 80, currentTool: "read" });
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return result("aborted", 80, "partial evidence");
    }, { scheduler: new Scheduler(1), onChange: (value) => changes.push(value) });
    const input = run("hours", 1, 1, 6 * 60 * 60_000); input.maxTurns = 256;
    coordinator.start(input); await flush();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(coordinator.snapshot("hours")!.tasks[0].state).toBe("running");
    expect(coordinator.snapshot("hours")!.tasks[0].turns).toBe(80);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const settled = await coordinator.wait("hours", "all");
    expect(settled.tasks[0].state).toBe("timed_out");
    expect(settled.tasks[0].output).toContain("partial evidence");
    expect(changes.at(-1)!.state).toBe("failed");
    await coordinator.shutdown();
  });

  it("shares a max-four pool across runs and preserves run/task order", async () => {
    const scheduler = new Scheduler(4);
    const gate = deferred<void>();
    let active = 0;
    let peak = 0;
    const launches: string[] = [];
    const runner: WorkerRunner = async ({ run: record, task: recordTask }) => {
      launches.push(`${record.id}:${recordTask.id}`);
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return result();
    };
    const coordinator = new Coordinator(runner, { scheduler });

    coordinator.start(run("one", 3, 3));
    coordinator.start(run("two", 3, 3));
    await flush();

    expect(peak).toBe(4);
    expect(active).toBe(4);
    expect(scheduler.queuedCount).toBe(2);
    expect(coordinator.list().map((record) => record.id)).toEqual(["one", "two"]);
    expect(coordinator.snapshot("two")!.tasks.map((recordTask) => recordTask.id)).toEqual([
      "two-t1",
      "two-t2",
      "two-t3",
    ]);

    gate.resolve();
    await Promise.all([coordinator.wait("one", "all"), coordinator.wait("two", "all")]);
    expect(peak).toBe(4);
    expect(launches).toHaveLength(6);
    expect(coordinator.list().map((record) => record.state)).toEqual(["done", "done"]);
  });

  it("settles failures independently and keeps records in normalized order", async () => {
    const controls = new Map<string, ReturnType<typeof deferred<WorkerResult>>>();
    const runner: WorkerRunner = ({ task: recordTask }) => {
      const control = deferred<WorkerResult>();
      controls.set(recordTask.id, control);
      return control.promise;
    };
    const coordinator = new Coordinator(runner, { scheduler: new Scheduler(3) });
    coordinator.start(run("ordered", 3, 3));
    await flush();

    controls.get("ordered-t3")!.resolve(result("done", 3, "third"));
    controls.get("ordered-t1")!.resolve({
      ...result("failed", 1, "first"),
      error: "expected failure",
    });
    await flush();
    expect(coordinator.snapshot("ordered")!.tasks.map((recordTask) => recordTask.id)).toEqual([
      "ordered-t1",
      "ordered-t2",
      "ordered-t3",
    ]);
    expect(coordinator.snapshot("ordered")!.tasks[1].state).toBe("running");

    controls.get("ordered-t2")!.resolve(result("done", 2, "second"));
    const settled = await coordinator.wait("ordered", "all");
    expect(settled.state).toBe("failed");
    expect(settled.tasks.map((recordTask) => recordTask.state)).toEqual([
      "failed",
      "done",
      "done",
    ]);
  });

  it("waits for the next completion or all completions without polling", async () => {
    const controls = new Map<string, ReturnType<typeof deferred<WorkerResult>>>();
    const runner: WorkerRunner = ({ task: recordTask }) => {
      const control = deferred<WorkerResult>();
      controls.set(recordTask.id, control);
      return control.promise;
    };
    const coordinator = new Coordinator(runner, { scheduler: new Scheduler(2) });
    coordinator.start(run("wait", 2, 2));
    await flush();

    const next = coordinator.wait("wait", "next");
    const all = coordinator.wait("wait", "all");
    controls.get("wait-t2")!.resolve(result("done", 2));
    const afterNext = await next;
    expect(afterNext.state).toBe("running");
    expect(afterNext.tasks.map((recordTask) => recordTask.state)).toEqual(["running", "done"]);

    let allSettled = false;
    void all.then(() => { allSettled = true; });
    await flush();
    expect(allSettled).toBe(false);
    controls.get("wait-t1")!.resolve(result("done", 1));
    expect((await all).state).toBe("done");
  });

  it("supports abortable waits and wait timeouts", async () => {
    vi.useFakeTimers();
    const never: WorkerRunner = () => new Promise(() => {});
    const coordinator = new Coordinator(never, { scheduler: new Scheduler(1) });
    coordinator.start(run("waiting", 1, 1, 10_000));
    await flush();

    const timedWait = coordinator.wait("waiting", "all", { timeoutMs: 50 });
    const timedExpectation = expect(timedWait).rejects.toBeInstanceOf(CoordinatorWaitTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await timedExpectation;

    const controller = new AbortController();
    controller.abort();
    await expect(coordinator.wait("waiting", "next", { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    coordinator.shutdown();
  });

  it("enforces the run deadline for queued and running tasks", async () => {
    vi.useFakeTimers();
    const launches: string[] = [];
    const runner: WorkerRunner = ({ task: recordTask, signal }) => {
      launches.push(recordTask.id);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(result("timed_out")), { once: true });
      });
    };
    const coordinator = new Coordinator(runner, { scheduler: new Scheduler(1) });
    coordinator.start(run("deadline", 2, 2, 1_000));
    await flush();
    expect(launches).toEqual(["deadline-t1"]);

    const all = coordinator.wait("deadline", "all");
    await vi.advanceTimersByTimeAsync(1_000);
    const snapshot = await all;
    expect(snapshot.state).toBe("failed");
    expect(snapshot.tasks.map((recordTask) => recordTask.state)).toEqual([
      "timed_out",
      "timed_out",
    ]);
    expect(launches).toEqual(["deadline-t1"]);
  });

  it("bounds the machine-slot wait by the run's remaining budget", async () => {
    vi.useFakeTimers();
    const requestedWaits: number[] = [];
    const slots = {
      acquire: async (_provider: string, _signal?: AbortSignal, timeoutMs?: number) => {
        requestedWaits.push(timeoutMs ?? -1);
        return () => undefined;
      },
    } as unknown as MachineSlots;

    // An explicit multi-hour dispatch asks for its own remaining budget, never
    // the implicit ten-minute machine-slot default.
    let clock = 1_000_000;
    const sixHours = 6 * 60 * 60_000;
    const longHorizon = new Coordinator(async () => result(), {
      machineSlots: slots,
      scheduler: new Scheduler(1),
      now: () => clock,
    });
    longHorizon.start(run("budget-long", 1, 1, sixHours));
    await flush();
    expect(requestedWaits).toEqual([sixHours]);
    expect((await longHorizon.wait("budget-long", "all")).tasks[0].state).toBe("done");
    await longHorizon.shutdown();

    // A short run never asks for more time than it has left: the second
    // dispatch is capped at the run budget minus the time already spent queued.
    requestedWaits.length = 0;
    clock = 2_000_000;
    const gate = deferred<void>();
    const shortRun = new Coordinator(async ({ task: recordTask }) => {
      if (recordTask.id === "budget-short-t1") await gate.promise;
      return result();
    }, { machineSlots: slots, scheduler: new Scheduler(1), now: () => clock });
    shortRun.start(run("budget-short", 2, 1, 90_000));
    await flush();
    expect(requestedWaits).toEqual([90_000]);

    clock += 30_000; // thirty seconds queued behind the first task
    gate.resolve();
    for (let index = 0; index < 4; index += 1) await flush();
    expect(requestedWaits).toEqual([90_000, 60_000]);
    expect((await shortRun.wait("budget-short", "all")).tasks.map((recordTask) => recordTask.state))
      .toEqual(["done", "done"]);
    await shortRun.shutdown();
  });

  it("cancels globally queued and running tasks without a late launch", async () => {
    const scheduler = new Scheduler(1);
    const launched: string[] = [];
    const sawAbort: string[] = [];
    const runner: WorkerRunner = ({ task: recordTask, signal }) => new Promise((resolve) => {
      launched.push(recordTask.id);
      signal.addEventListener("abort", () => {
        sawAbort.push(recordTask.id);
        resolve(result("aborted"));
      }, { once: true });
    });
    const coordinator = new Coordinator(runner, { scheduler });
    coordinator.start(run("cancel", 2, 2));
    await flush();
    expect(launched).toEqual(["cancel-t1"]);
    expect(scheduler.queuedCount).toBe(1);

    expect(coordinator.cancel("cancel", "cancel-t2")).toBe(true);
    await flush();
    expect(launched).toEqual(["cancel-t1"]);
    expect(coordinator.snapshot("cancel")!.tasks[1].state).toBe("aborted");

    expect(coordinator.cancel("cancel", "cancel-t1")).toBe(true);
    const snapshot = await coordinator.wait("cancel", "all");
    expect(sawAbort).toEqual(["cancel-t1"]);
    expect(snapshot.state).toBe("aborted");
    expect(snapshot.tasks.map((recordTask) => recordTask.state)).toEqual(["aborted", "aborted"]);
  });

  it("does not settle cancellation until worker disposal completes and retains final usage", async () => {
    const abortStarted = deferred<void>();
    const disposal = deferred<void>();
    const runner: WorkerRunner = async ({ signal, onProgress }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          abortStarted.resolve();
          resolve();
        }, { once: true });
      });
      await disposal.promise;
      onProgress({ turns: 4, usage: usage(7) });
      return result("aborted", 7, "final partial output");
    };
    const coordinator = new Coordinator(runner, { scheduler: new Scheduler(1) });
    coordinator.start(run("delayed-abort", 1, 1));
    await flush();

    const waiting = coordinator.wait("delayed-abort", "all");
    expect(coordinator.cancel("delayed-abort")).toBe(true);
    await abortStarted.promise;
    let settled = false;
    void waiting.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(coordinator.snapshot("delayed-abort")!.state).toBe("running");
    expect(coordinator.snapshot("delayed-abort")!.tasks[0].state).toBe("running");

    disposal.resolve();
    const snapshot = await waiting;
    expect(snapshot.state).toBe("aborted");
    expect(snapshot.tasks[0]).toMatchObject({
      state: "aborted",
      output: expect.stringContaining("final partial output"),
      turns: 7,
      usage: usage(7),
    });
    expect(snapshot.tasks[0].output).toContain("Status: incomplete");
    expect(snapshot.tasks[0].output).toMatch(/^FINAL REPORT\n/);
    expect(snapshot.usage).toEqual(usage(7));
  });

  it("shutdown aborts all work and prevents future starts", async () => {
    const launched: string[] = [];
    const runner: WorkerRunner = ({ task: recordTask, signal }) => new Promise((resolve) => {
      launched.push(recordTask.id);
      signal.addEventListener("abort", () => resolve(result("aborted")), { once: true });
    });
    const coordinator = new Coordinator(runner, { scheduler: new Scheduler(1) });
    coordinator.start(run("shutdown", 3, 1));
    await flush();
    coordinator.shutdown();

    const snapshot = await coordinator.wait("shutdown", "all");
    expect(snapshot.state).toBe("aborted");
    expect(snapshot.tasks.every((recordTask) => recordTask.state === "aborted")).toBe(true);
    expect(launched).toEqual(["shutdown-t1"]);
    expect(() => coordinator.start(run("too-late", 1))).toThrow("shut down");
  });

  it("defensively validates raw run bounds", () => {
    const coordinator = new Coordinator(async () => result(), { scheduler: new Scheduler(1) });
    expect(() => coordinator.start(run("empty", 0))).toThrow(/1 to 8/);
    expect(() => coordinator.start(run("many", 9))).toThrow(/1 to 8/);
    expect(() => coordinator.start(run("short", 1, 1, 999))).toThrow(/timeoutMs/);
    expect(() => coordinator.start(run("long", 1, 1, 8 * 60 * 60_000 + 1))).toThrow(/timeoutMs/);
  });

  it("bounds simultaneously active runs even when workers never settle", () => {
    const coordinator = new Coordinator(() => new Promise(() => {}), { scheduler: new Scheduler(1) });
    for (let index = 0; index < MAX_ACTIVE_RUNS; index += 1) {
      coordinator.start(run(`active-${index}`, 1, 1));
    }
    expect(() => coordinator.start(run("one-too-many", 1, 1))).toThrow(/maximum 16 active runs/);
    coordinator.shutdown();
  });

  it("sanitizes malformed runner usage and still settles the run", async () => {
    const malformed: WorkerRunner = async () => ({
      state: "done",
      output: "partial",
      turns: Number.NaN,
      usage: {
        input: Number.NaN,
        output: -10,
        cacheRead: 4,
        totalTokens: Number.POSITIVE_INFINITY,
        cost: { total: Number.NaN },
      },
    } as never);
    const coordinator = new Coordinator(malformed, { scheduler: new Scheduler(1) });
    coordinator.start(run("malformed", 1, 1));
    const settled = await coordinator.wait("malformed", "all");

    expect(settled.state).toBe("done");
    expect(settled.tasks[0].turns).toBe(0);
    expect(settled.usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 4,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });

  it("retains only a bounded terminal history while active status stays lightweight", async () => {
    const coordinator = new Coordinator(async () => result(), { scheduler: new Scheduler(1) });
    const total = MAX_RETAINED_TERMINAL_RUNS + 5;
    for (let index = 0; index < total; index += 1) {
      const id = `retained-${index}`;
      coordinator.start(run(id, 1, 1));
      await coordinator.wait(id, "all");
    }

    expect(coordinator.list()).toHaveLength(MAX_RETAINED_TERMINAL_RUNS);
    expect(coordinator.list()[0].id).toBe("retained-5");
    expect(coordinator.snapshot("retained-0")).toBeUndefined();
    expect(coordinator.activeRuns()).toEqual([]);
  });

  it("reports progress and aggregates each task's final usage exactly once", async () => {
    const progress = vi.fn();
    const runner: WorkerRunner = async ({ task: recordTask, onProgress }: WorkerRunContext) => {
      onProgress({ state: "waiting", currentTool: "read", turns: 1, usage: usage(50) });
      return result("done", recordTask.id.endsWith("1") ? 2 : 3);
    };
    const coordinator = new Coordinator(runner, {
      scheduler: new Scheduler(2),
      onProgress: progress,
    });
    coordinator.start(run("usage", 2, 2));
    const snapshot = await coordinator.wait("usage", "all");

    expect(progress).toHaveBeenCalledTimes(2);
    expect(snapshot.tasks.map((recordTask) => recordTask.turns)).toEqual([2, 3]);
    expect(snapshot.usage).toMatchObject({
      input: 5,
      output: 10,
      cacheRead: 15,
      cacheWrite: 20,
      totalTokens: 50,
    });
    expect(snapshot.usage.cost.total).toBeCloseTo(usage(5).cost.total);
    expect(snapshot.tasks.every((recordTask) => recordTask.currentTool === undefined)).toBe(true);

    // Returned records are copies, so observers cannot corrupt coordinator state.
    snapshot.tasks.reverse();
    snapshot.usage.totalTokens = -1;
    expect(coordinator.snapshot("usage")!.tasks.map((recordTask) => recordTask.id)).toEqual([
      "usage-t1",
      "usage-t2",
    ]);
    expect(coordinator.snapshot("usage")!.usage.totalTokens).toBe(50);
  });
});

it("terminalizes cancelled initialization but retains its scheduler lease until cleanup", async () => {
  const scheduler = new Scheduler(1);
  const cleanup = deferred<void>();
  const entered = deferred<void>();
  const first = new Coordinator(async ({ signal }) => {
    entered.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { ...result("aborted"), cleanup: cleanup.promise };
  }, { scheduler });
  const launched = vi.fn(async () => result());
  const second = new Coordinator(launched, { scheduler });
  first.start(run("old", 1, 1));
  await entered.promise;
  await first.shutdown();
  expect(first.snapshot("old")?.state).toBe("aborted");
  second.start(run("new", 1, 1));
  await flush();
  expect(scheduler.activeCount).toBe(1);
  expect(launched).not.toHaveBeenCalled();
  cleanup.resolve();
  await second.wait("new", "all");
  expect(launched).toHaveBeenCalledTimes(1);
});

describe("automatic resume after transient worker failures", () => {
  const failing = (error: string, tokens = 2): WorkerResult => ({ state: "failed", output: "partial", error, turns: tokens, usage: usage(tokens) });

  it("resumes a network drop from the worker's session and carries usage across attempts", async () => {
    vi.useFakeTimers();
    const seen: Array<{ sessionFile?: string; claudeSessionId?: string }> = [];
    let calls = 0;
    const coordinator = new Coordinator(async ({ task: recordTask, onProgress }) => {
      seen.push({ sessionFile: recordTask.sessionFile });
      calls += 1;
      if (calls === 1) { onProgress({ sessionFile: "/tmp/worker.jsonl" }); return failing("fetch failed", 2); }
      return result("done", 3, "finished");
    }, { scheduler: new Scheduler(1) });
    coordinator.start(run("resume", 1, 1, 30 * 60_000)); await flush();
    expect(coordinator.snapshot("resume")!.tasks[0].currentTool).toBe("retry");
    await vi.advanceTimersByTimeAsync(10_000);
    const settled = await coordinator.wait("resume", "all");
    expect(calls).toBe(2);
    expect(seen[1].sessionFile).toBe("/tmp/worker.jsonl");
    const done = settled.tasks[0];
    expect(done.state).toBe("done");
    expect(done.autoResumes).toEqual(["network drop: fetch failed"]);
    expect(done.turns).toBe(5);
    expect(done.usage.totalTokens).toBe(50);
    expect(settled.usage.totalTokens).toBe(50);
    await coordinator.shutdown();
  });

  it("passes only remaining turns through the Pi runner budget seam without changing the shared run", async () => {
    vi.useFakeTimers();
    const budgets: number[] = [];
    const coordinator = new Coordinator(async ({ run: attemptRun, onProgress }) => {
      budgets.push(workerTurnBudget(attemptRun));
      onProgress({ sessionFile: "/tmp/worker.jsonl" });
      return budgets.length === 1 ? failing("fetch failed", 3) : result("done", workerTurnBudget(attemptRun));
    }, { scheduler: new Scheduler(1) });
    const original = { ...run("turn-budget", 1, 1, 30 * 60_000), maxTurns: 4 };
    coordinator.start(original); await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    const settled = await coordinator.wait(original.id, "all");
    expect(budgets).toEqual([4, 1]);
    expect(settled.tasks[0].turns).toBe(4);
    expect(settled.maxTurns).toBe(4);
    expect(original.maxTurns).toBe(4);
    await coordinator.shutdown();
  });

  it("subtracts cumulative turns across multiple automatic resumes", async () => {
    vi.useFakeTimers();
    const budgets: number[] = [];
    const coordinator = new Coordinator(async ({ run: attemptRun, onProgress }) => {
      budgets.push(workerTurnBudget(attemptRun));
      onProgress({ sessionFile: "/tmp/worker.jsonl" });
      return budgets.length < 3 ? failing("fetch failed", budgets.length === 1 ? 2 : 1) : result("done", workerTurnBudget(attemptRun));
    }, { scheduler: new Scheduler(1) });
    coordinator.start({ ...run("cumulative-turns", 1, 1, 30 * 60_000), maxTurns: 4 });
    await flush();
    await vi.advanceTimersByTimeAsync(40_000);
    const settled = await coordinator.wait("cumulative-turns", "all");
    expect(budgets).toEqual([4, 2, 1]);
    expect(settled.tasks[0].turns).toBe(4);
    expect(settled.maxTurns).toBe(4);
    await coordinator.shutdown();
  });

  it("keeps a fresh authorized budget for an explicitly resumed run", async () => {
    const resumed = { ...run("explicit-turns", 1, 1, 30 * 60_000), maxTurns: 4 };
    resumed.tasks[0].sessionFile = "/tmp/worker.jsonl";
    resumed.tasks[0].turns = 3;
    const runner = vi.fn(async ({ run: attemptRun }: WorkerRunContext) => result("done", workerTurnBudget(attemptRun)));
    const coordinator = new Coordinator(runner, { scheduler: new Scheduler(1) });
    coordinator.start(resumed);
    const settled = await coordinator.wait(resumed.id, "all");
    expect(runner.mock.calls[0][0].run.maxTurns).toBe(4);
    expect(settled.tasks[0].turns).toBe(4);
    await coordinator.shutdown();
  });

  it.each([4, 5])("refuses automatic resume after %i turns consume the entire budget", async (turns) => {
    vi.useFakeTimers();
    const runner = vi.fn(async ({ onProgress }: WorkerRunContext) => {
      onProgress({ sessionFile: "/tmp/worker.jsonl" });
      return failing("fetch failed", turns);
    });
    const coordinator = new Coordinator(runner, { scheduler: new Scheduler(1) });
    coordinator.start({ ...run(`exhausted-${turns}`, 1, 1, 30 * 60_000), maxTurns: 4 });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    const settled = await coordinator.wait(`exhausted-${turns}`, "all");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(settled.tasks[0].error).toMatch(/4-turn limit/);
    expect(settled.tasks[0].autoResumes).toBeUndefined();
    await coordinator.shutdown();
  });

  it("resumes a reply Codex ended at its limit once, from its own session, and stops if the smaller step is cut too", async () => {
    vi.useFakeTimers();
    const limit = "Codex reply limit: Codex ended this reply after 15 minutes of thinking, its longest allowed reply. The same request was not sent again because it would end the same way. Model and reasoning level are unchanged (gpt-6.1-sol, high). Continue in smaller steps: one check or one edit per reply.";
    for (const [name, outcomes, expectedCalls, expectedState] of [
      ["recovers", [limit, null], 2, "done"],
      ["stops", [limit, limit, null], 2, "failed"],
    ] as const) {
      let calls = 0;
      const sessions: Array<string | undefined> = [];
      const coordinator = new Coordinator(async ({ task: recordTask, onProgress }) => {
        sessions.push(recordTask.sessionFile);
        const outcome = outcomes[calls];
        calls += 1;
        onProgress({ sessionFile: "/tmp/codex-worker.jsonl" });
        return outcome ? failing(outcome, 1) : result("done", 1, "finished in small steps");
      }, { scheduler: new Scheduler(1) });
      coordinator.start(run(`codex-${name}`, 1, 1, 60 * 60_000)); await flush();
      await vi.advanceTimersByTimeAsync(60_000);
      const settled = await coordinator.wait(`codex-${name}`, "all");
      expect(calls, name).toBe(expectedCalls);
      expect(sessions[1], name).toBe("/tmp/codex-worker.jsonl"); // the same session, never a fresh replay
      expect(settled.tasks[0].state, name).toBe(expectedState);
      expect(settled.tasks[0].autoResumes, name).toEqual([`codex reply limit: ${limit.slice(0, 200)}`]);
      if (expectedState === "failed") expect(settled.tasks[0].error).toMatch(/^Codex reply limit:/);
      await coordinator.shutdown();
    }
  });

  it("stops after two resumes and reports the last error", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const coordinator = new Coordinator(async ({ onProgress }) => {
      calls += 1;
      onProgress({ claudeSessionId: "0b5e1c2a-1111-4222-8333-944455556666" });
      return failing("claude-code ended with an incomplete stream-json frame", 1);
    }, { scheduler: new Scheduler(1) });
    coordinator.start(run("cap", 1, 1, 30 * 60_000)); await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    const settled = await coordinator.wait("cap", "all");
    expect(calls).toBe(3);
    expect(settled.tasks[0].state).toBe("failed");
    expect(settled.tasks[0].autoResumes).toHaveLength(2);
    expect(settled.tasks[0].error).toMatch(/incomplete stream-json frame/);
    await coordinator.shutdown();
  });

  it("never resumes decisions, sessionless workers, or a run without budget left", async () => {
    for (const [name, error, session, timeoutMs] of [
      ["turns", "Child exceeded the 32-turn limit; the partial report above is evidence, not acceptance", true, 30 * 60_000],
      ["filter", "Provider finish_reason: content_filter", true, 30 * 60_000],
      ["nosession", "fetch failed", false, 30 * 60_000],
      ["budget", "fetch failed", true, 60_000],
    ] as const) {
      let calls = 0;
      const coordinator = new Coordinator(async ({ onProgress }) => {
        calls += 1;
        if (session) onProgress({ sessionFile: "/tmp/w.jsonl" });
        return failing(error);
      }, { scheduler: new Scheduler(1) });
      coordinator.start(run(name, 1, 1, timeoutMs));
      const settled = await coordinator.wait(name, "all");
      expect(calls, name).toBe(1);
      expect(settled.tasks[0].autoResumes, name).toBeUndefined();
      await coordinator.shutdown();
    }
  });
});

describe("explicit partial outcome for budget stops", () => {
  const stopped = (state: WorkerResult["state"], error: string, output = "findings so far"): WorkerResult =>
    ({ state, output, error, turns: 7, usage: usage(1) });

  it("marks a turn-budget stop partial while it stays failed, with a content-free summary", async () => {
    const coordinator = new Coordinator(async ({ task: leaf }) => {
      workerJournal(leaf).lastStep = "grep";
      return stopped("failed", "Child exceeded the 12-turn limit; the partial report above is evidence, not acceptance");
    }, { scheduler: new Scheduler(1) });
    coordinator.start({ ...run("partial-turns", 1, 1), maxTurns: 12 });
    const settled = await coordinator.wait("partial-turns", "all");
    expect(settled.tasks[0]).toMatchObject({ state: "failed", outcome: "partial", partialReason: "turn_budget" });
    expect(settled.tasks[0].partialSummary).toMatch(/^Turn budget reached after 7\/12 turns; 0 changed paths; last step: grep; partial report retained/);
    expect(settled.tasks[0].partialSummary).not.toContain("findings so far");
    expect(settled.state).toBe("failed");
    await coordinator.shutdown();
  });

  it("marks a started time-budget stop partial, and records when no report was written", async () => {
    const coordinator = new Coordinator(async () => stopped("timed_out", "Run deadline exceeded", ""), { scheduler: new Scheduler(1) });
    coordinator.start(run("partial-time", 1, 1));
    const settled = await coordinator.wait("partial-time", "all");
    expect(settled.tasks[0]).toMatchObject({ state: "timed_out", outcome: "partial", partialReason: "time_budget" });
    expect(settled.tasks[0].partialSummary).toContain("Time budget reached after 7/64 turns");
    expect(settled.tasks[0].partialSummary).toContain("no written report");
    await coordinator.shutdown();
  });

  it("never marks cancelled, ordinary failed, done, or never-started tasks partial", async () => {
    let call = 0;
    const coordinator = new Coordinator(async () => {
      call += 1;
      return call === 1 ? stopped("failed", "Provider finish_reason: content_filter")
        : call === 2 ? stopped("aborted", "Task cancelled")
        : result("done");
    }, { scheduler: new Scheduler(1) });
    coordinator.start(run("not-partial", 3, 1));
    const settled = await coordinator.wait("not-partial", "all");
    expect(settled.tasks.map((leaf) => [leaf.state, leaf.outcome])).toEqual([["failed", undefined], ["aborted", undefined], ["done", undefined]]);
    await coordinator.shutdown();

    // A queued task that the deadline reaches before it ever started retained no work.
    const idle = new Coordinator(() => new Promise<WorkerResult>(() => {}), { scheduler: new Scheduler(1) });
    vi.useFakeTimers();
    idle.start(run("never-started", 2, 1, 1_000));
    await flush();
    await vi.advanceTimersByTimeAsync(1_100);
    const expired = idle.snapshot("never-started")!;
    expect(expired.tasks[1].state).toBe("timed_out");
    expect(expired.tasks[1].startedAt).toBeUndefined();
    expect(expired.tasks[1].outcome).toBeUndefined();
  });
});

describe("launch slots lent to a worker that only waits for account capacity", () => {
  const countingSlots = () => {
    const held = { machine: 0 };
    const slots = { acquire: async () => { held.machine += 1; return () => { held.machine -= 1; }; } } as unknown as MachineSlots;
    return { held, slots };
  };

  it("lets another launch run while a task is parked, then takes the slots back before the task works", async () => {
    const { held, slots } = countingSlots();
    const gate = deferred<void>();
    const events: string[] = [];
    // One launch slot for two tasks: t2 can only run because t1 gave its slot back.
    const coordinator = new Coordinator(async ({ task: leaf, slots: lent }) => {
      if (leaf.id === "lend-t1") {
        lent!.yield();
        events.push(`t1:parked machine=${held.machine}`);
        await gate.promise;
        await lent!.reclaim();
        events.push(`t1:reclaimed machine=${held.machine}`);
        return result();
      }
      events.push("t2:runs");
      gate.resolve();
      return result();
    }, { machineSlots: slots, scheduler: new Scheduler(1) });
    coordinator.start(run("lend", 2, 2));
    const settled = await coordinator.wait("lend", "all");
    expect(events).toEqual(["t1:parked machine=0", "t2:runs", "t1:reclaimed machine=1"]);
    expect(settled.tasks.map((leaf) => leaf.state)).toEqual(["done", "done"]);
    await flush();
    expect(held.machine).toBe(0);
    await coordinator.shutdown();
  });

  it("releases nothing twice and leaks no slot when a parked task is cancelled", async () => {
    const { held, slots } = countingSlots();
    const scheduler = new Scheduler(1);
    const coordinator = new Coordinator(async ({ signal, slots: lent }) => {
      lent!.yield();
      lent!.yield();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return result("aborted");
    }, { machineSlots: slots, scheduler });
    coordinator.start(run("park-cancel", 1, 1));
    await flush();
    expect(held.machine).toBe(0);
    expect(scheduler.activeCount).toBe(0);
    coordinator.cancel("park-cancel");
    const settled = await coordinator.wait("park-cancel", "all");
    expect(settled.tasks[0].state).toBe("aborted");
    await flush();
    expect(held.machine).toBe(0);
    expect(scheduler.activeCount).toBe(0);
    await coordinator.shutdown();
  });

  it("settles a task cancelled while it waits to take its slots back, holding no slot", async () => {
    const { held, slots } = countingSlots();
    const scheduler = new Scheduler(1);
    const hold = deferred<void>();
    const coordinator = new Coordinator(async ({ task: leaf, slots: lent }) => {
      if (leaf.id === "reclaim-t1") {
        lent!.yield();
        await flush();
        await lent!.reclaim();
        return result();
      }
      await hold.promise;
      return result();
    }, { machineSlots: slots, scheduler });
    coordinator.start(run("reclaim", 2, 2));
    await flush();
    await flush();
    // t2 owns the only slot, so t1's reclaim is queued behind it.
    expect(scheduler.queuedCount).toBe(1);
    coordinator.cancel("reclaim", "reclaim-t1");
    await flush();
    expect(coordinator.snapshot("reclaim")!.tasks[0].state).toBe("aborted");
    hold.resolve();
    const settled = await coordinator.wait("reclaim", "all");
    expect(settled.tasks.map((leaf) => leaf.state)).toEqual(["aborted", "done"]);
    await flush();
    expect(held.machine).toBe(0);
    expect(scheduler.activeCount).toBe(0);
    await coordinator.shutdown();
  });
});

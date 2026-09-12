import { afterEach, describe, expect, it, vi } from "vitest";
import { Coordinator, CoordinatorWaitTimeoutError } from "../src/subagents/coordinator.ts";
import { Scheduler } from "../src/subagents/scheduler.ts";
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
    expect(() => coordinator.start(run("long", 1, 1, 30 * 60_000 + 1))).toThrow(/timeoutMs/);
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

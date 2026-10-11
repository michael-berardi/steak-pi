import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderRunResult, toRunView } from "../extensions/ultraterm-subagents.ts";
import type { CapacityConfig } from "../src/subagents/capacity.ts";
import { CheckpointStore, diagnoseRun, recoveredRun } from "../src/subagents/checkpoints.ts";
import { Coordinator } from "../src/subagents/coordinator.ts";
import { MachineSlots, type MachineCapacityWait } from "../src/subagents/machine-slots.ts";
import { Scheduler } from "../src/subagents/scheduler.ts";
import { USAP_VERSION, emptyUsage, type RunRecord, type WorkerResult, type WorkerRunner } from "../src/subagents/types.ts";

// Also keep the module-level session scheduler from reading host capacity files.
vi.mock("../src/subagents/capacity.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/subagents/capacity.ts")>();
  return {
    ...actual,
    loadCapacityConfig: () => ({
      session: { providers: { zai: 4 }, global: 4 },
      machine: { providers: { zai: 1 }, global: 2 },
    }),
  };
});

const directories: string[] = [];
const coordinators: Coordinator[] = [];
const releases: Array<() => void> = [];

function fixture(providerCap = 1, globalCap = 2, sessionCap = 4) {
  const dir = mkdtempSync(join(tmpdir(), "steak-launch-visibility-"));
  directories.push(dir);
  const config: CapacityConfig = {
    session: { providers: { zai: sessionCap }, global: sessionCap },
    machine: { providers: { zai: providerCap }, global: globalCap },
  };
  const slots = new MachineSlots({ dir, config });
  const scheduler = new Scheduler(sessionCap, config);
  const hold = async (provider: string) => {
    const release = await slots.acquire(provider, undefined, 0);
    releases.push(release);
    return release;
  };
  return { dir, config, slots, scheduler, hold };
}

function run(dir: string, id = "run-capacity", taskCount = 1, timeoutMs = 10_000): RunRecord {
  return {
    version: USAP_VERSION,
    id,
    goal: "observe launch capacity without launching a model",
    constraints: [],
    cwd: dir,
    model: "zai/fake-model",
    thinkingLevel: "off",
    concurrency: taskCount,
    timeoutMs,
    maxTurns: 8,
    background: true,
    state: "running",
    createdAt: Date.now(),
    usage: emptyUsage(),
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `${id}-task-${index + 1}`,
      label: `worker ${index + 1}`,
      task: "hermetic fake worker",
      role: "worker" as const,
      mayEdit: false,
      ownedPaths: [],
      allowBash: false,
      state: "queued" as const,
      output: "",
      turns: 0,
      usage: emptyUsage(),
      relaySent: 0,
      relayReceived: 0,
      truncated: false,
    })),
  };
}

function result(state: WorkerResult["state"] = "done"): WorkerResult {
  return { state, output: "fake worker result", turns: 1, usage: emptyUsage() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function coordinator(f: ReturnType<typeof fixture>, runner: WorkerRunner, onChange?: (value: RunRecord) => void) {
  const value = new Coordinator(runner, {
    scheduler: f.scheduler,
    machineSlots: f.slots,
    now: () => Date.now(),
    onChange,
  });
  coordinators.push(value);
  return value;
}

async function flush() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

function clock() {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
}

function expectFrozen(record: RunRecord, elapsedMs: number, reason: string) {
  const wait = record.tasks[0].launchCapacityWait!;
  expect(wait.endedAt! - wait.since).toBe(elapsedMs);
  expect(toRunView(record).tasks[0].launchCapacityWait).toEqual({ ...wait, elapsedMs });
  expect(diagnoseRun(record, Date.now() + 60_000).tasks[0]).toMatchObject({
    reason,
    launchCapacityWait: { ...wait, elapsedMs },
  });
}

afterEach(async () => {
  for (const value of coordinators.splice(0)) await value.shutdown();
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("machine launch capacity observations", () => {
  it("does not report a wait for immediate acquisition or pre-abort", async () => {
    const f = fixture();
    const onWait = vi.fn();
    const release = await f.slots.acquire("zai", undefined, 0, onWait);
    releases.push(release);
    expect(onWait).not.toHaveBeenCalled();
    release();
    const controller = new AbortController();
    controller.abort();
    await expect(f.slots.acquire("zai", controller.signal, 0, onWait)).rejects.toThrow(/aborted/);
    expect(onWait).not.toHaveBeenCalled();
    expect(f.slots.heldCount("zai", 1)).toBe(0);
    expect(f.slots.heldCount("global", 2)).toBe(0);
  });

  it("reports a full provider, then a full global bucket, and ignores observer exceptions", async () => {
    clock();
    const f = fixture();
    const releaseProvider = await f.hold("zai");
    const releaseOther = await f.hold("other");
    const observations: MachineCapacityWait[] = [];
    const waiting = f.slots.acquire("zai", undefined, 10_000, (wait) => {
      observations.push({ ...wait });
      throw new Error("observation must not affect acquisition");
    });
    expect(observations[0]).toEqual({ provider: "zai", bucket: "provider", providerCap: 1, globalCap: 2 });
    releaseProvider();
    await f.hold("third"); // Keep the global bucket full, but free the target provider.
    await vi.advanceTimersByTimeAsync(250);
    expect(observations.at(-1)).toEqual({ provider: "zai", bucket: "global", providerCap: 1, globalCap: 2 });
    expect(f.slots.heldCount("zai", 1)).toBe(0); // Failed global attempt returned its provider lease.
    releaseOther();
    await vi.advanceTimersByTimeAsync(250);
    const release = await waiting;
    releases.push(release);
    expect(f.slots.heldCount("zai", 1)).toBe(1);
    expect(f.slots.heldCount("global", 2)).toBe(2);
    release();
    release();
    expect(f.slots.heldCount("zai", 1)).toBe(0);
    expect(f.slots.heldCount("global", 2)).toBe(1);
  });

  it.each(["abort", "timeout"] as const)("retains normal %s failure despite a throwing observer", async (exit) => {
    clock();
    const f = fixture();
    await f.hold("zai");
    const controller = new AbortController();
    const onWait = vi.fn(() => { throw new Error("observer failure"); });
    const waiting = f.slots.acquire("zai", controller.signal, 500, onWait);
    // Attach rejection handling before advancing the fake clock.
    const rejected = expect(waiting).rejects.toThrow(exit === "abort" ? /exhausted.*aborted/ : /exhausted for zai/);
    if (exit === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(500);
    await rejected;
    expect(onWait).toHaveBeenCalledWith({ provider: "zai", bucket: "provider", providerCap: 1, globalCap: 2 });
    expect(f.slots.heldCount("zai", 1)).toBe(1);
    expect(f.slots.heldCount("global", 2)).toBe(1);
  });
});

describe("launch capacity lifecycle visibility", () => {
  it("exposes provider pressure and advancing elapsed time without changing state or launching a runner", async () => {
    clock();
    const f = fixture();
    await f.hold("zai");
    const runner = vi.fn(async () => result());
    const changes: RunRecord[] = [];
    const c = coordinator(f, runner, (value) => changes.push(value));
    c.start(run(f.dir));
    await flush();
    expect(c.snapshot("run-capacity")!.tasks[0]).toMatchObject({
      state: "starting",
      launchCapacityWait: { provider: "zai", bucket: "provider", providerCap: 1, globalCap: 2, since: 10_000 },
    });
    expect(changes.some((value) => value.tasks[0].launchCapacityWait?.since === 10_000)).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    const snapshot = c.snapshot("run-capacity")!;
    const expected = { provider: "zai", bucket: "provider", providerCap: 1, globalCap: 2, since: 10_000, elapsedMs: 2000 };
    expect(snapshot.tasks[0].state).toBe("starting");
    expect(snapshot.tasks[0].launchCapacityWait?.endedAt).toBeUndefined();
    expect(toRunView(snapshot).tasks[0].launchCapacityWait).toEqual(expected);
    expect(diagnoseRun(snapshot, Date.now()).tasks[0]).toMatchObject({ reason: "launch_capacity", launchCapacityWait: expected });
    const text = renderRunResult(snapshot);
    expect(text).toMatch(/launch.*capacity|capacity.*wait/i);
    expect(text).toContain("provider");
    expect(text).toContain("zai");
    expect(text).toMatch(/2\s*s|2000\s*ms/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("keeps the first since across bucket changes and freezes elapsed when acquisition succeeds", async () => {
    clock();
    const f = fixture();
    const releaseProvider = await f.hold("zai");
    const releaseOther = await f.hold("other");
    const gate = deferred<WorkerResult>();
    const runner = vi.fn<WorkerRunner>(({ signal }) => {
      signal.addEventListener("abort", () => gate.resolve(result("aborted")), { once: true });
      return gate.promise;
    });
    const c = coordinator(f, runner);
    c.start(run(f.dir));
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runner).not.toHaveBeenCalled();
    releaseProvider();
    await f.hold("third");
    await vi.advanceTimersByTimeAsync(250);
    expect(c.snapshot("run-capacity")!.tasks[0].launchCapacityWait).toEqual({
      provider: "zai", bucket: "global", providerCap: 1, globalCap: 2, since: 10_000,
    });
    const globalWait = c.snapshot("run-capacity")!;
    expect(toRunView(globalWait).tasks[0].launchCapacityWait).toMatchObject({ bucket: "global", since: 10_000, elapsedMs: 1250 });
    expect(diagnoseRun(globalWait).tasks[0]).toMatchObject({ reason: "launch_capacity", launchCapacityWait: { bucket: "global", elapsedMs: 1250 } });
    expect(renderRunResult(globalWait)).toContain("global");
    expect(runner).not.toHaveBeenCalled();
    releaseOther();
    await vi.advanceTimersByTimeAsync(50);
    const acquired = c.snapshot("run-capacity")!;
    expect(acquired.tasks[0].state).toBe("running");
    expect(runner).toHaveBeenCalledTimes(1);
    const frozen = acquired.tasks[0].launchCapacityWait!;
    expect(frozen.endedAt).toBe(11_300);
    expectFrozen(acquired, 1300, "running");
    await vi.advanceTimersByTimeAsync(1000);
    expect(c.snapshot("run-capacity")!.tasks[0].launchCapacityWait).toEqual(frozen);
    expectFrozen(c.snapshot("run-capacity")!, 1300, "running");
    gate.resolve(result());
    const settled = await c.wait("run-capacity", "all");
    expectFrozen(settled, 1300, "done");
    await flush(); // Terminal notification precedes the lease-release cleanup microtask.
    expect(f.slots.heldCount("zai", 1)).toBe(0);
  });

  it.each(["cancel", "deadline"] as const)("freezes a blocked wait on %s and preserves its terminal diagnosis", async (exit) => {
    clock();
    const f = fixture();
    const release = await f.hold("zai");
    const runner = vi.fn(async () => result());
    const c = coordinator(f, runner);
    c.start(run(f.dir, "run-capacity", 1, 1000));
    await flush();
    await vi.advanceTimersByTimeAsync(exit === "cancel" ? 400 : 1000);
    if (exit === "cancel") expect(c.cancel("run-capacity")).toBe(true);
    const settled = await c.wait("run-capacity", "all");
    await flush();
    expect(settled.tasks[0].state).toBe(exit === "cancel" ? "aborted" : "timed_out");
    expectFrozen(settled, exit === "cancel" ? 400 : 1000, exit === "cancel" ? "cancelled" : "deadline");
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expectFrozen(c.snapshot("run-capacity")!, exit === "cancel" ? 400 : 1000, exit === "cancel" ? "cancelled" : "deadline");
    expect(runner).not.toHaveBeenCalled();
    expect(f.slots.heldCount("zai", 1)).toBe(0);
    expect(f.slots.heldCount("global", 2)).toBe(0);
  });

  it("does not fabricate machine waits for session-queued or immediately launched tasks", async () => {
    clock();
    const f = fixture(2, 2, 1);
    const gate = deferred<WorkerResult>();
    const runner = vi.fn<WorkerRunner>(({ signal }) => {
      signal.addEventListener("abort", () => gate.resolve(result("aborted")), { once: true });
      return gate.promise;
    });
    const c = coordinator(f, runner);
    c.start(run(f.dir, "run-session", 2));
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    const snapshot = c.snapshot("run-session")!;
    expect(snapshot.tasks.map((task) => task.state)).toEqual(["running", "queued"]);
    expect(snapshot.tasks.map((task) => task.launchCapacityWait)).toEqual([undefined, undefined]);
    expect(toRunView(snapshot).tasks.every((task) => task.launchCapacityWait === undefined)).toBe(true);
    expect(diagnoseRun(snapshot).tasks.map((task) => task.reason)).toEqual(["running", "queued"]);
    expect(renderRunResult(snapshot)).not.toMatch(/launch capacity/i);
    expect(f.scheduler.queuedCount).toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
    gate.resolve(result());
    const settled = await c.wait("run-session", "all");
    expect(settled.tasks.every((task) => task.launchCapacityWait === undefined)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("deep-clones wait metadata in snapshots, lifecycle notifications, and model-facing views", async () => {
    clock();
    const f = fixture();
    await f.hold("zai");
    const changes: RunRecord[] = [];
    const c = coordinator(f, async () => result(), (value) => changes.push(value));
    c.start(run(f.dir));
    await flush();
    const first = c.snapshot("run-capacity")!;
    const second = c.snapshot("run-capacity")!;
    const notification = changes.find((value) => value.tasks[0].launchCapacityWait)!;
    const view = toRunView(second);
    const diagnostic = diagnoseRun(second);
    first.tasks[0].launchCapacityWait!.since = -1;
    notification.tasks[0].launchCapacityWait!.provider = "mutated-notification";
    view.tasks[0].launchCapacityWait!.bucket = "global";
    diagnostic.tasks[0].launchCapacityWait!.providerCap = 99;
    expect(second.tasks[0].launchCapacityWait).toEqual({ provider: "zai", bucket: "provider", providerCap: 1, globalCap: 2, since: 10_000 });
    expect(c.snapshot("run-capacity")!.tasks[0].launchCapacityWait).toEqual(second.tasks[0].launchCapacityWait);
    await vi.advanceTimersByTimeAsync(250);
    expect(second.tasks[0].launchCapacityWait?.since).toBe(10_000);
  });

  it("persists capacity transitions immediately while throttling unchanged wait observations", () => {
    clock();
    const f = fixture();
    const input = run(f.dir, "run-persistence");
    input.tasks[0].state = "starting";
    const store = new CheckpointStore(join(f.dir, "parent.jsonl"), join(f.dir, "checkpoints"));
    try {
      expect(store.save(input)).toBe(true);
      input.tasks[0].launchCapacityWait = { provider: "zai", bucket: "provider", providerCap: 1, globalCap: 2, since: 10_000 };
      expect(store.save(input)).toBe(true);
      expect(store.get(input.id)?.run.tasks[0].launchCapacityWait).toEqual(input.tasks[0].launchCapacityWait);
      expect(store.save(input)).toBe(false);
      input.tasks[0].launchCapacityWait.bucket = "global";
      expect(store.save(input)).toBe(true);
      input.tasks[0].launchCapacityWait.endedAt = 10_010;
      expect(store.save(input)).toBe(true);
      expect(store.save(input)).toBe(false);
      expect(store.get(input.id)?.run.tasks[0].launchCapacityWait).toEqual(input.tasks[0].launchCapacityWait);
    } finally {
      store.close();
    }
  });

  it("freezes an interrupted checkpoint's active wait at savedAt, without inventing metadata for legacy tasks", () => {
    clock();
    const f = fixture();
    const input = run(f.dir, "run-recovered", 2);
    input.tasks[0].state = "starting";
    input.tasks[0].startedAt = 10_000;
    input.tasks[0].launchCapacityWait = { provider: "zai", bucket: "global", providerCap: 1, globalCap: 2, since: 10_000 };
    const restored = recoveredRun({ version: 1, run: input, delivered: false, savedAt: 12_000 });
    expect(restored.state).toBe("aborted");
    expect(restored.tasks[0].launchCapacityWait?.endedAt).toBe(12_000);
    vi.setSystemTime(90_000);
    expectFrozen(restored, 2000, "host_interrupted");
    expect(restored.tasks[1].launchCapacityWait).toBeUndefined();
    expect(toRunView(restored).tasks[1].launchCapacityWait).toBeUndefined();
    expect(diagnoseRun(restored).tasks[1].reason).toBe("host_interrupted");
    expect(input.tasks[0].launchCapacityWait?.endedAt).toBeUndefined();

    // A successfully acquired wait is already historical, even if its runner was interrupted later.
    input.tasks[0].state = "running";
    input.tasks[0].launchCapacityWait.endedAt = 11_000;
    const previouslyEnded = recoveredRun({ version: 1, run: input, delivered: false, savedAt: 12_000 });
    expectFrozen(previouslyEnded, 1000, "host_interrupted");
  });
});

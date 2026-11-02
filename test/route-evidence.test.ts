// The route evidence store: an append-only, bounded JSONL; verdicts folded onto the work they judge; the records a
// settled task leaves. Every name is synthetic.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FAILURE_KINDS, RouteEvidenceStore, classifyFailure, foldEvidence, parseEvidenceLine, recordSettledTask, settledTaskEvidence, testGateResult, type TaskEvidence } from "../src/subagents/route-evidence.ts";
import { USAP_VERSION, emptyUsage, type RunRecord, type TaskRecord } from "../src/subagents/types.ts";

const dir = mkdtempSync(join(tmpdir(), "steak-pi-route-evidence-"));
let files = 0;
const fresh = () => join(dir, `evidence-${++files}.jsonl`);
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const base = { runId: "run-1", taskId: "run-1-task-1", label: "leaf", taskClass: "class-a", route: "route-a", wallSeconds: 12, costUsd: 0.004, tokens: 900 };

describe("the append-only store", () => {
  it("appends one JSON line per record and reads them back in order", () => {
    const store = new RouteEvidenceStore(fresh(), { now: () => 5 });
    expect(store.recordTask({ ...base, outcome: "pass", source: "worker-state" })).toBe(true);
    expect(store.recordTask({ ...base, taskId: "run-1-task-2", route: "route-b", outcome: "fail", source: "worker-state", failureKind: "http-5xx" })).toBe(true);
    expect(store.recordProbe({ taskClass: "class-a", route: "route-b" })).toBe(true);
    const lines = readFileSync(store.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toMatchObject({ v: 1, kind: "task", at: 5, route: "route-a", outcome: "pass" });
    const view = store.view();
    expect(view.tasks.map((task) => task.route)).toEqual(["route-a", "route-b"]);
    expect(view.tasks[1].failureKind).toBe("http-5xx");
    expect(view.probes).toHaveLength(1);
  });

  it("never rewrites a record: later facts are new lines", () => {
    const store = new RouteEvidenceStore(fresh());
    store.recordTask({ ...base, outcome: "pass", source: "worker-state" });
    const before = readFileSync(store.path, "utf8");
    store.recordVerdict({ runId: "run-1", outcome: "fail", source: "verification" });
    const after = readFileSync(store.path, "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.trim().split("\n")).toHaveLength(2);
  });

  it("skips damaged lines instead of blinding the router", () => {
    const path = fresh();
    const store = new RouteEvidenceStore(path);
    store.recordTask({ ...base, outcome: "pass", source: "worker-state" });
    appendFileSync(path, "{not json\n[]\n{\"v\":2,\"kind\":\"task\"}\n{\"v\":1,\"kind\":\"task\",\"at\":1}\n\n");
    store.recordTask({ ...base, taskId: "run-1-task-2", outcome: "fail", source: "worker-state", failureKind: "other" });
    expect(store.view().tasks).toHaveLength(2);
  });

  it("bounds each record's strings and drops impossible numbers", () => {
    const line = JSON.stringify({ v: 1, kind: "task", at: 1, runId: "r", taskId: "t", label: "x".repeat(500), taskClass: "c", route: "q", outcome: "pass", source: "worker-state", wallSeconds: -4, costUsd: "free", tokens: 12.9, failureKind: "bogus" });
    const parsed = parseEvidenceLine(line) as TaskEvidence;
    expect(parsed.label).toHaveLength(80);
    expect(parsed).toMatchObject({ wallSeconds: 0, costUsd: 0, tokens: 12 });
    expect(parsed).not.toHaveProperty("failureKind");
    expect(parseEvidenceLine(JSON.stringify({ v: 1, kind: "verdict", at: 1, runId: "r", outcome: "pass", source: "worker-state" }))).toBeUndefined();
  });

  it("never throws when it cannot write, and keeps the cause", () => {
    const blocker = fresh();
    writeFileSync(blocker, "a file, not a directory");
    const store = new RouteEvidenceStore(join(blocker, "nested", "evidence.jsonl"));
    expect(store.recordTask({ ...base, outcome: "pass", source: "worker-state" })).toBe(false);
    expect(store.lastError).toBeTruthy();
    expect(store.view().tasks).toEqual([]);
  });

  it("serves a cached view until the file changes", () => {
    const store = new RouteEvidenceStore(fresh());
    store.recordTask({ ...base, outcome: "pass", source: "worker-state" });
    const first = store.view();
    expect(store.view()).toBe(first);
    store.recordTask({ ...base, taskId: "run-1-task-2", outcome: "pass", source: "worker-state" });
    expect(store.view().tasks).toHaveLength(2);
  });
});

describe("rotation keeps the store bounded", () => {
  it("rotates to a previous generation once the size bound is reached, and reads both", () => {
    const store = new RouteEvidenceStore(fresh(), { maxBytes: 1_500 });
    for (let index = 0; index < 40; index += 1) store.recordTask({ ...base, runId: `run-${index}`, taskId: `run-${index}-task-1`, outcome: "pass", source: "worker-state" });
    expect(existsSync(store.previousPath)).toBe(true);
    // Neither generation outgrows the bound by more than one record.
    for (const path of [store.path, store.previousPath]) expect(statSync(path).size).toBeLessThanOrEqual(1_500);
    const view = store.view();
    expect(view.tasks.length).toBeGreaterThan(0);
    expect(view.tasks.length).toBeLessThan(40); // the oldest generation was dropped: history is bounded
    // The newest record is always kept, in order.
    expect(view.tasks[view.tasks.length - 1].runId).toBe("run-39");
    const ids = view.tasks.map((task) => Number(task.runId.slice(4)));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
  it("defaults to a 5 MB bound", () => {
    expect(new RouteEvidenceStore(fresh()).maxBytes).toBe(5_000_000);
  });
  it("does not rotate a small file", () => {
    const store = new RouteEvidenceStore(fresh(), { maxBytes: 100_000 });
    for (let index = 0; index < 10; index += 1) store.recordTask({ ...base, taskId: `t${index}`, outcome: "pass", source: "worker-state" });
    expect(existsSync(store.previousPath)).toBe(false);
    expect(store.view().tasks).toHaveLength(10);
  });
});

describe("a later verdict is attached to the same run and task", () => {
  const seed = (store: RouteEvidenceStore) => {
    store.recordTask({ ...base, taskId: "t1", outcome: "pass", source: "worker-state" });
    store.recordTask({ ...base, taskId: "t2", outcome: "pass", source: "worker-state" });
    store.recordTask({ ...base, runId: "run-2", taskId: "t3", outcome: "pass", source: "worker-state" });
  };
  it("overrides a worker-state pass with a verification fail for one task only", () => {
    const store = new RouteEvidenceStore(fresh());
    seed(store);
    store.recordVerdict({ runId: "run-1", taskId: "t2", outcome: "fail", source: "verification" });
    expect(store.view().tasks.map((task) => `${task.taskId}:${task.outcome}:${task.source}`)).toEqual(["t1:pass:worker-state", "t2:fail:verification", "t3:pass:worker-state"]);
  });
  it("covers every classed task of the run when no task is named, and the latest verdict wins", () => {
    const store = new RouteEvidenceStore(fresh());
    seed(store);
    store.recordVerdict({ runId: "run-1", outcome: "fail", source: "verification", at: 10 });
    store.recordVerdict({ runId: "run-1", taskId: "t1", outcome: "pass", source: "test-gate", at: 11 });
    expect(store.view().tasks.map((task) => `${task.outcome}:${task.source}`)).toEqual(["pass:test-gate", "fail:verification", "pass:worker-state"]);
  });
  it("does not judge a route the task merely left on the way", () => {
    const records = foldEvidence([
      { v: 1, kind: "task", at: 1, ...base, taskId: "t1", route: "route-a", outcome: "fail", source: "worker-state", failureKind: "quota", hop: true },
      { v: 1, kind: "task", at: 1, ...base, taskId: "t1", route: "route-b", outcome: "pass", source: "worker-state" },
      { v: 1, kind: "verdict", at: 2, runId: "run-1", outcome: "fail", source: "verification" },
    ]);
    expect(records.tasks.map((task) => `${task.route}:${task.outcome}`)).toEqual(["route-a:fail", "route-b:fail"]);
    const passed = foldEvidence([
      { v: 1, kind: "task", at: 1, ...base, route: "route-b", outcome: "fail", source: "worker-state", failureKind: "other" },
      { v: 1, kind: "verdict", at: 2, runId: "run-1", outcome: "pass", source: "operator" },
    ]);
    expect(passed.tasks[0]).toMatchObject({ outcome: "pass", source: "operator" });
    expect(passed.tasks[0]).not.toHaveProperty("failureKind");
  });
});

describe("failure kinds", () => {
  it.each([
    ["HTTP 402: Insufficient credits", "quota"],
    ["No endpoints found that can handle the requested parameters", "quota"],
    ["subscription_quota_exceeded", "quota"],
    ["503 Service Unavailable", "http-5xx"],
    ["upstream error 502 bad gateway", "http-5xx"],
    ["provider overloaded", "http-5xx"],
    ["HTTP 429 Too Many Requests", "http-4xx"],
    ["404 model not found", "http-4xx"],
    ["Child produced no final output", "empty-output"],
    ["Child ran out of output tokens before a final answer (stopReason length)", "reasoning-exhausted"],
    ["Every attempted native tool call failed", "tool-error"],
    ["Child exceeded the 500-turn limit; the partial report is evidence", "other"],
    ["something unforeseen", "other"],
    [undefined, "other"],
  ] as const)("names %s as %s", (message, kind) => {
    expect(classifyFailure(message)).toBe(kind);
    expect(FAILURE_KINDS).toContain(kind);
  });
  it("reads a test gate result from the report", () => {
    expect(testGateResult("Focused checks:\nTEST-GATE: pass\n")).toBe("pass");
    expect(testGateResult("x\n  test-gate: FAIL (2 failing)\n")).toBe("fail");
    expect(testGateResult("TEST-GATE: pass\nlater\nTEST-GATE: fail")).toBe("fail");
    expect(testGateResult("no gate here; TEST-GATE: pass inline")).toBeUndefined();
    expect(testGateResult("TEST-GATE: none")).toBeUndefined();
  });
});

function runOf(overrides: Partial<RunRecord> = {}, taskClass: Partial<NonNullable<RunRecord["selection"]>["taskClass"]> = {}): RunRecord {
  return {
    version: USAP_VERSION, id: "run-9", goal: "g", constraints: [], cwd: "/tmp", model: "p-a/model-a", thinkingLevel: "low", concurrency: 1,
    timeoutMs: 600_000, maxTurns: 8, background: false, state: "done", createdAt: 0, tasks: [], usage: emptyUsage(),
    selection: {
      provider: "p-a", modelId: "model-a", source: "chain", images: false, tools: true,
      taskClass: {
        name: "class-a", outcome: "served", reason: "ok", step: "route-a",
        decision: { mode: "exploit", winner: "route-a", explored: false, order: [{ entry: "route-a", route: "p-a/model-a" }, { entry: "route-b", route: "p-b/model-b" }], estimates: [], timeWeight: 0, minPassRate: 0, explore: 0.1 },
        ...taskClass,
      },
    },
    ...overrides,
  };
}
function taskOf(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const usage = emptyUsage();
  usage.cost.total = 0.0123; usage.totalTokens = 345;
  return {
    id: "run-9-task-1", label: "leaf", task: "t", role: "worker", mayEdit: false, ownedPaths: [], allowBash: false, taskClass: "class-a",
    state: "done", output: "FINAL REPORT\nStatus: done\n\nall good", turns: 2, usage, relaySent: 0, relayReceived: 0, truncated: false,
    startedAt: 10_000, endedAt: 22_500, ...overrides,
  };
}

describe("the records a settled task leaves", () => {
  it("records a finished task: route, outcome, source, seconds, dollars, tokens", () => {
    const [record, ...rest] = settledTaskEvidence(runOf(), taskOf(), 99);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({ kind: "task", at: 99, runId: "run-9", taskId: "run-9-task-1", taskClass: "class-a", route: "route-a", outcome: "pass", source: "worker-state", wallSeconds: 12.5, costUsd: 0.0123, tokens: 345 });
    expect(record).not.toHaveProperty("failureKind");
  });
  it("records a failed task with its failure kind", () => {
    const [record] = settledTaskEvidence(runOf(), taskOf({ state: "failed", error: "HTTP 503 upstream unavailable", output: "FINAL REPORT\nStatus: failed" }), 1);
    expect(record).toMatchObject({ outcome: "fail", failureKind: "http-5xx", source: "worker-state" });
  });
  it("takes a test gate result the worker reported as the stronger source", () => {
    const [passed] = settledTaskEvidence(runOf(), taskOf({ output: "FINAL REPORT\nFocused checks: 4 passed\nTEST-GATE: pass" }), 1);
    expect(passed).toMatchObject({ outcome: "pass", source: "test-gate" });
    const [failed] = settledTaskEvidence(runOf(), taskOf({ output: "FINAL REPORT\nTEST-GATE: fail" }), 1);
    expect(failed).toMatchObject({ outcome: "fail", source: "test-gate" });
  });
  it("leaves a test-gated class's finished work unknown until a gate or verdict speaks", () => {
    const [record] = settledTaskEvidence(runOf({}, { requiresTestGate: true }), taskOf(), 1);
    expect(record.outcome).toBe("unknown");
  });
  it("counts a cancelled or never-started task as unknown, not as the route's failure", () => {
    expect(settledTaskEvidence(runOf(), taskOf({ state: "aborted", error: "cancelled" }), 1)[0].outcome).toBe("unknown");
    expect(settledTaskEvidence(runOf(), taskOf({ state: "failed", error: "queue", startedAt: undefined, endedAt: undefined }), 1)[0].outcome).toBe("unknown");
  });
  it("leaves a fail record on each route the task left, with the cause and a hop marker, then the serving route's", () => {
    const task = taskOf({ routeHopDetails: [{ from: "p-a/model-a", to: "p-b/model-b", cause: "HTTP 402 Insufficient credits", costUsd: 0, seconds: 0 }], routeFallbacks: ["p-a/model-a->p-b/model-b"] });
    const records = settledTaskEvidence(runOf(), task, 7);
    expect(records.map((record) => `${record.route}:${record.outcome}:${record.failureKind ?? "-"}:${record.hop ? "hop" : "final"}`)).toEqual([
      "route-a:fail:quota:hop", "route-b:pass:-:final",
    ]);
  });
  it("splits cost and time between the routes a task spent them on", () => {
    const task = taskOf({ routeHopDetails: [{ from: "p-a/model-a", to: "p-b/model-b", cause: "empty-output: Child produced no final output", costUsd: 0.005, seconds: 4 }] });
    const [left, served] = settledTaskEvidence(runOf(), task, 1);
    expect(left).toMatchObject({ costUsd: 0.005, wallSeconds: 4, failureKind: "empty-output" });
    expect(served.costUsd).toBeCloseTo(0.0123 - 0.005, 9);
    expect(served.wallSeconds).toBeCloseTo(12.5 - 4, 9);
  });
  it("marks a retried task and an explored pick", () => {
    const [retried] = settledTaskEvidence(runOf(), taskOf({ retriedOnSameRoute: true }), 1);
    expect(retried.retried).toBe(true);
    const explored = runOf({}, { decision: { mode: "explore", winner: "route-a", explored: true, order: [{ entry: "route-a", route: "p-a/model-a" }], estimates: [], timeWeight: 0, minPassRate: 0, explore: 0.1 } });
    expect(settledTaskEvidence(explored, taskOf(), 1)[0].explored).toBe(true);
  });
  it("records nothing for a rider, an unserved class, or a run no class steered", () => {
    expect(settledTaskEvidence(runOf(), taskOf({ taskClass: undefined }), 1)).toEqual([]);
    expect(settledTaskEvidence(runOf(), taskOf({ taskClass: "class-b" }), 1)).toEqual([]);
    expect(settledTaskEvidence(runOf({}, { outcome: "fallback", step: undefined }), taskOf(), 1)).toEqual([]);
    expect(settledTaskEvidence(runOf({}, { outcome: "ignored" }), taskOf(), 1)).toEqual([]);
    expect(settledTaskEvidence(runOf({ selection: undefined }), taskOf(), 1)).toEqual([]);
  });
  it("writes them through the store and never throws", () => {
    const store = new RouteEvidenceStore(fresh());
    expect(recordSettledTask(store, runOf(), taskOf(), 5)).toBe(1);
    expect(store.view().tasks).toHaveLength(1);
    const blocked = fresh();
    writeFileSync(blocked, "x");
    expect(recordSettledTask(new RouteEvidenceStore(join(blocked, "x", "y.jsonl")), runOf(), taskOf(), 5)).toBe(0);
  });
});

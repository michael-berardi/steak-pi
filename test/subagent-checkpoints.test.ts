import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointStore, diagnoseRun, recoveredRun } from "../src/subagents/checkpoints.ts";
import { normalizeDispatch } from "../src/subagents/policy.ts";

const dirs: string[] = [];
const stores: CheckpointStore[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), "usap-checkpoint-")); dirs.push(root);
  const store = new CheckpointStore(join(root, "parent.jsonl"), join(root, "checkpoints")); stores.push(store);
  const run = normalizeDispatch({ goal: "private task", tasks: [{ label: "one", task: "private instruction" }], background: true }, root, "zai/glm-5.3-flash", "medium", Date.now(), () => "checkpoint-test");
  return { root, store, run };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("durable USAP checkpoints", () => {
  it("atomically persists private snapshots and reopens interrupted work without launching anything", () => {
    const { root, store, run } = setup();
    run.tasks[0].state = "running"; run.tasks[0].changedPaths = ["src/a.ts"]; run.tasks[0].lastStep = "write";
    store.save(run, true);
    const path = join(store.directory, `${run.id}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(store.directory).some((file) => file.endsWith(".tmp"))).toBe(false);
    store.close();
    const next = new CheckpointStore(join(root, "parent.jsonl"), join(root, "checkpoints")); stores.push(next);
    const recovered = recoveredRun(next.get(run.id)!);
    expect(recovered.state).toBe("aborted");
    expect(recovered.tasks[0]).toMatchObject({ state: "aborted", changedPaths: ["src/a.ts"], lastStep: "write" });
    expect(recovered.tasks[0].error).toContain("Host interrupted");
    expect(next.get(run.id)!.run.state).toBe("running");
  });
  it("refuses a second live host and separates parent histories", () => {
    const { root, store } = setup();
    expect(() => new CheckpointStore(join(root, "parent.jsonl"), join(root, "checkpoints"))).toThrow(/live host/);
    const other = new CheckpointStore(join(root, "different.jsonl"), join(root, "checkpoints")); stores.push(other);
    expect(other.directory).not.toBe(store.directory);
  });
  it("retains receipt and successor identity so completion and resume are not replayed", () => {
    const { store, run } = setup(); store.save(run, true);
    store.markDelivered(run.id); store.markResumed(run.id, "run-successor"); store.save(run, true);
    expect(store.get(run.id)).toMatchObject({ delivered: true, resumedAs: "run-successor" });
    expect(() => store.markResumed(run.id, "run-duplicate")).toThrow(/Already resumed/);
    expect(JSON.parse(readFileSync(join(store.directory, `${run.id}.json`), "utf8")).resumedAs).toBe("run-successor");
  });
  it("rejects unsafe session paths and symlinks", () => {
    const { root, store } = setup(); const outside = join(root, "outside.jsonl"); writeFileSync(outside, "history");
    expect(() => store.validateSession(outside)).toThrow(/escaped/);
    const link = join(store.sessionsDirectory, "link.jsonl"); symlinkSync(outside, link);
    expect(() => store.validateSession(link)).toThrow();
    const safe = join(store.sessionsDirectory, "safe.jsonl"); writeFileSync(safe, "history"); store.validateSession(safe);
    expect(statSync(safe).mode & 0o777).toBe(0o600);
    const linkedRoot = join(root, "linked"); symlinkSync(store.directory, linkedRoot);
    expect(() => new CheckpointStore("parent", linkedRoot)).toThrow(/Unsafe/);
  });
  it("quarantines malformed checkpoints and bounds diagnostics to metadata", () => {
    const { root, store, run } = setup(); run.state = "failed"; run.tasks[0].state = "failed";
    run.tasks[0].error = "Child exceeded the 12-turn limit private instruction";
    run.tasks[0].output = "private output"; store.save(run, true);
    writeFileSync(join(store.directory, "run-corrupt.json"), "{", { mode: 0o600 }); store.close();
    const next = new CheckpointStore(join(root, "parent.jsonl"), join(root, "checkpoints")); stores.push(next);
    expect(next.warnings).toHaveLength(1);
    const diagnostics = diagnoseRun(run);
    expect(diagnostics.tasks[0].reason).toBe("turn_budget");
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });
  it.each([
    ["Cannot find package PRIVATE imported from PRIVATE", "initialization_dependency"],
    ["Launch slots exhausted", "launch_capacity"],
    ["429 rate limit PRIVATE", "provider_rate_limit"],
    ["usage limit reached PRIVATE", "provider_quota"],
    ["Unsupported model/account PRIVATE", "provider_configuration"],
    ["Request payload too large PRIVATE", "context_budget"],
    ["fetch failed PRIVATE", "transport"],
    ["401 authentication PRIVATE", "provider_auth"],
  ])("classifies historical error %s without exporting provider payloads", (error, reason) => {
    const { run } = setup(); run.tasks[0].state = "failed"; run.tasks[0].error = error;
    const diagnostics = diagnoseRun(run);
    expect(diagnostics.tasks[0].reason).toBe(reason);
    expect(JSON.stringify(diagnostics)).not.toContain("PRIVATE");
  });

  it("recovers a write-ahead resume reservation without replaying either run", () => {
    const { root, store, run } = setup(); store.save(run, true);
    const successor = structuredClone(run); successor.id = "run-successor";
    const originalPath = join(store.directory, `${run.id}.json`);
    const original = JSON.parse(readFileSync(originalPath, "utf8"));
    original.pendingResume = successor.id;
    writeFileSync(originalPath, JSON.stringify(original), { mode: 0o600 });
    store.save(successor, true); store.close();
    const next = new CheckpointStore(join(root, "parent.jsonl"), join(root, "checkpoints")); stores.push(next);
    expect(next.get(run.id)).toMatchObject({ resumedAs: successor.id });
    expect(next.get(run.id)!.pendingResume).toBeUndefined();
    expect(recoveredRun(next.get(successor.id)!).state).toBe("aborted");
  });

  it("clears a reservation interrupted before its successor was committed", () => {
    const { root, store, run } = setup(); store.save(run, true);
    const path = join(store.directory, `${run.id}.json`);
    const original = JSON.parse(readFileSync(path, "utf8")); original.pendingResume = "run-never-created";
    writeFileSync(path, JSON.stringify(original), { mode: 0o600 }); store.close();
    const next = new CheckpointStore(join(root, "parent.jsonl"), join(root, "checkpoints")); stores.push(next);
    expect(next.get(run.id)!.resumedAs).toBeUndefined();
    expect(next.get(run.id)!.pendingResume).toBeUndefined();
  });

  it("fails closed while another host owns the atomic claim gate", () => {
    const { root, store } = setup(); store.close();
    mkdirSync(join(store.directory, ".claim"));
    expect(() => new CheckpointStore(join(root, "parent.jsonl"), join(root, "checkpoints"))).toThrow(/claim is busy/);
  });

  it("prunes only retained terminal snapshots and exclusive child sessions", () => {
    const { store, run } = setup(); run.state = "done"; run.tasks[0].state = "done";
    const session = join(store.sessionsDirectory, "old.jsonl"); writeFileSync(session, "history", { mode: 0o600 });
    for (let index = 0; index < 53; index++) {
      run.id = `run-retained-${index}`; run.tasks[0].sessionFile = index === 0 ? session : undefined; store.save(run, true);
    }
    expect(store.list()).toHaveLength(50);
    expect(readdirSync(store.sessionsDirectory)).not.toContain("old.jsonl");
  });
});

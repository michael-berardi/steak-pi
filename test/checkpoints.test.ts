import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/subagents/checkpoints.ts";
import { normalizeDispatch } from "../src/subagents/policy.ts";

const dirs: string[] = [];
const stores: CheckpointStore[] = [];

function setup(ownerSessionId?: string) {
  const root = mkdtempSync(join(tmpdir(), "usap-owner-")); dirs.push(root);
  const parent = join(root, "parent.jsonl");
  const store = new CheckpointStore(parent, join(root, "checkpoints"), ownerSessionId);
  stores.push(store);
  const run = normalizeDispatch({ goal: "private task", tasks: [{ label: "one", task: "private instruction" }], background: true }, root, "zai/glm-5.3-flash", "medium", Date.now(), () => "owner-test");
  return { root, parent, store, run };
}

/** The checkpoint namespace of the test currently running (dirs is cleared per test). */
function checkpointRoot(): string { return join(dirs[0], "checkpoints"); }

function errorFrom(run: () => unknown): Error {
  try { run(); } catch (error) { return error as Error; }
  throw new Error("expected the operation to fail");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("checkpoint ownership during native session replacement", () => {
  it("names a live same-process owner as a duplicate resource without deleting its lock", () => {
    const { parent, store, run } = setup("session-A");
    store.save(run, true);
    const lockPath = join(store.directory, "owner.json");
    const before = readFileSync(lockPath, "utf8");
    const ownerToken = (JSON.parse(before) as { token: string }).token;
    const error = errorFrom(() => new CheckpointStore(parent, checkpointRoot(), "session-A"));
    expect(error.message).toMatch(/live host/);
    expect(error).toMatchObject({ name: "CheckpointOwnershipError", reason: "live-owner", sameProcess: true, ownerPid: process.pid, ownerToken, lockPath });
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    run.tasks[0].state = "running";
    store.save(run, true);
    expect(store.get(run.id)?.run.tasks[0].state).toBe("running");
  });

  it("refuses an unknown same-process lock instead of guessing it is stale", () => {
    // A dropped store, a collected handle, or an absent registry entry is not
    // proof of death: another isolate sharing this pid may hold this very lock.
    const { parent, store } = setup("session-A");
    const lockPath = join(store.directory, "owner.json");
    store.close();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "11111111-2222-4333-8444-555555555555" }), { mode: 0o600 });
    const before = readFileSync(lockPath, "utf8");
    const error = errorFrom(() => new CheckpointStore(parent, checkpointRoot(), "session-A"));
    expect(error.message).toMatch(/live host/);
    expect(error).toMatchObject({ reason: "live-owner", sameProcess: true, ownerPid: process.pid, ownerToken: "11111111-2222-4333-8444-555555555555", lockPath });
    expect(readFileSync(lockPath, "utf8")).toBe(before);
  });

  it("refuses an unverifiable same-process lock instead of guessing ownership", () => {
    const { parent, store } = setup("session-A");
    const lockPath = join(store.directory, "owner.json");
    store.close();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    const error = errorFrom(() => new CheckpointStore(parent, checkpointRoot(), "session-A"));
    expect(error.message).toMatch(/live host/);
    expect(error).toMatchObject({ reason: "live-owner", sameProcess: true, ownerPid: process.pid });
    expect((error as { ownerToken?: string }).ownerToken).toBeUndefined();
    expect(readFileSync(lockPath, "utf8")).toBe(JSON.stringify({ pid: process.pid }));
  });

  it("never steals a live same-process lock from another isolate (worker_threads)", async () => {
    // The registry and any isolate-local bookkeeping are invisible across
    // isolates, while process.pid is shared: the only safe answer is refusal.
    const { parent, store, run } = setup("session-A");
    store.save(run, true);
    const lockPath = join(store.directory, "owner.json");
    const before = readFileSync(lockPath, "utf8");
    const script = join(dirs[0], "isolate-claim.mjs");
    writeFileSync(script, [
      'import { readFileSync } from "node:fs";',
      'import { parentPort, workerData } from "node:worker_threads";',
      "const { CheckpointStore } = await import(workerData.moduleUrl);",
      "let outcome;",
      "try {",
      "  const store = new CheckpointStore(workerData.parent, workerData.root, workerData.ownerSessionId);",
      "  outcome = { ok: true, warnings: store.warnings };",
      "  store.close();",
      "} catch (error) {",
      "  outcome = { ok: false, name: error?.name, message: error?.message, sameProcess: error?.sameProcess, ownerPid: error?.ownerPid, ownerToken: error?.ownerToken, lockPath: error?.lockPath };",
      "}",
      "let lock;",
      'try { lock = readFileSync(workerData.lock, "utf8"); } catch { lock = "<missing>"; }',
      "parentPort.postMessage({ pid: process.pid, outcome, lock });",
    ].join("\n"), { mode: 0o600 });
    const worker = new Worker(script, {
      execArgv: ["--experimental-strip-types"],
      workerData: {
        moduleUrl: new URL("../src/subagents/checkpoints.ts", import.meta.url).href,
        parent, root: checkpointRoot(), ownerSessionId: "session-A", lock: lockPath,
      },
    });
    interface IsolateClaim {
      pid: number;
      outcome: { ok: boolean; name?: string; message?: string; sameProcess?: boolean; ownerPid?: number; ownerToken?: string; lockPath?: string; warnings?: string[] };
      lock: string;
    }
    const result = await new Promise<IsolateClaim>((resolve, reject) => {
      worker.on("message", (message: IsolateClaim) => resolve(message));
      worker.on("error", reject);
      worker.on("exit", (code) => reject(new Error(`isolate exited with ${code} before reporting a claim result`)));
    });
    await worker.terminate();
    expect(result.pid).toBe(process.pid);
    expect(result.outcome).toMatchObject({ ok: false, name: "CheckpointOwnershipError", sameProcess: true, ownerPid: process.pid, lockPath });
    expect(result.outcome.message).toMatch(/live host in this process/);
    expect(result.lock).toBe(before);
    expect(readFileSync(lockPath, "utf8")).toBe(before);
    run.tasks[0].state = "running";
    store.save(run, true);
    expect(store.get(run.id)?.run.tasks[0].state).toBe("running");
  });

  it("never deletes another live host's lock", () => {
    const { parent, store } = setup("session-A");
    const lockPath = join(store.directory, "owner.json");
    store.close();
    writeFileSync(lockPath, JSON.stringify({ pid: 1, token: "foreign-owner" }), { mode: 0o600 });
    const error = errorFrom(() => new CheckpointStore(parent, checkpointRoot(), "session-A"));
    expect(error.message).toMatch(/live host/);
    expect(error).toMatchObject({ reason: "live-owner", sameProcess: false, ownerPid: 1, ownerToken: "foreign-owner", lockPath });
    expect(readFileSync(lockPath, "utf8")).toContain("foreign-owner");
  });

  it("takes over a lock left by a host that is no longer running", () => {
    const { parent, store, run } = setup("session-A");
    store.save(run, true);
    const directory = store.directory;
    store.close();
    writeFileSync(join(directory, "owner.json"), JSON.stringify({ pid: 999999, token: "dead-owner" }), { mode: 0o600 });
    const next = new CheckpointStore(parent, checkpointRoot(), "session-A");
    stores.push(next);
    expect(next.directory).toBe(directory);
    expect(next.warnings.join(" ")).toMatch(/no longer running/);
    expect(next.get(run.id)?.run.id).toBe(run.id);
    expect(JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as { pid: number }).toMatchObject({ pid: process.pid });
  });

  it("releases only its own lock (compare-and-swap on the recorded token)", () => {
    const { store } = setup("session-A");
    const lockPath = join(store.directory, "owner.json");
    writeFileSync(lockPath, JSON.stringify({ pid: 1, token: "foreign-owner" }), { mode: 0o600 });
    store.close();
    expect(readFileSync(lockPath, "utf8")).toContain("foreign-owner");
  });

  it("reclaims a lock left behind by a store that closed (ownership-safe release)", () => {
    const { parent, store, run } = setup("session-A");
    store.save(run, true);
    const directory = store.directory;
    const lockPath = join(directory, "owner.json");
    const token = (JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }).token;
    store.close();
    expect(existsSync(lockPath)).toBe(false);
    // A close whose unlink could not run leaves the released token behind; the
    // tombstone proves that store is gone, so the replacement may take over.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    const replacement = new CheckpointStore(parent, checkpointRoot(), "session-A");
    stores.push(replacement);
    expect(replacement.directory).toBe(directory);
    expect(replacement.warnings.join(" ")).toMatch(/stale/);
    expect(replacement.get(run.id)?.run.id).toBe(run.id);
    expect((JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }).token).not.toBe(token);
  });

  it("keeps replacement stores from reusing a released namespace when the identity changed", () => {
    const { parent, store } = setup("session-A");
    const first = store.directory;
    store.close();
    const other = new CheckpointStore(parent, checkpointRoot(), "session-B");
    stores.push(other);
    expect(other.directory).not.toBe(first);
  });
});

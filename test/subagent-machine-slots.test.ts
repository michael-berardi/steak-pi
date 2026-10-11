import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineSlots, NoopSlots, defaultSlotDir, type MachineCapacitySnapshot } from "../src/subagents/machine-slots.ts";
import type { CapacityConfig } from "../src/subagents/capacity.ts";

const temporaryDirectories: string[] = [];

function fixture(provider = 1, global = 1): { dir: string; slots: MachineSlots } {
  const dir = mkdtempSync(join(tmpdir(), "steak-slots-"));
  temporaryDirectories.push(dir);
  const config: CapacityConfig = {
    session: { providers: {}, global: 8 },
    machine: { providers: { zai: provider }, global },
  };
  return { dir, slots: new MachineSlots({ dir, config }) };
}

/** A pid that is provably not this process and not a live local process. */
const DEAD_PID = 2_147_483_646;

function lockPath(dir: string, bucket: string, index = 0): string {
  return join(dir, bucket, `${index}.lock`);
}

function claimPath(dir: string, bucket: string, index = 0): string {
  return join(dir, bucket, `${index}.lock.claim`);
}

function writeStamp(dir: string, bucket: string, stamp: Record<string, unknown> | string, index = 0): string {
  mkdirSync(join(dir, bucket), { recursive: true });
  const path = lockPath(dir, bucket, index);
  writeFileSync(path, typeof stamp === "string" ? stamp : JSON.stringify(stamp));
  return path;
}

function writeClaim(dir: string, bucket: string, claim: Record<string, unknown> | string, index = 0): string {
  mkdirSync(join(dir, bucket), { recursive: true });
  const path = claimPath(dir, bucket, index);
  writeFileSync(path, typeof claim === "string" ? claim : JSON.stringify(claim));
  return path;
}

/** Publish scratch files and reclaim claims that must never be left behind. */
function strayFiles(dir: string, bucket: string): string[] {
  return readdirSync(join(dir, bucket)).filter((entry) => entry.startsWith(".tmp-") || entry.endsWith(".claim"));
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MachineSlots", () => {
  it("round-trips one provider plus one global slot and releases idempotently", async () => {
    const { dir, slots } = fixture();
    const release = await slots.acquire("zai", undefined, 0);

    expect(existsSync(lockPath(dir, "zai", 0))).toBe(true);
    expect(existsSync(lockPath(dir, "global", 0))).toBe(true);
    expect(slots.heldCount("zai", 1)).toBe(1);
    expect(slots.heldCount("global", 1)).toBe(1);

    release();
    release();
    expect(existsSync(lockPath(dir, "zai", 0))).toBe(false);
    expect(existsSync(lockPath(dir, "global", 0))).toBe(false);
    expect(slots.heldCount("zai", 1)).toBe(0);
  });

  it("reports provider caps clamped by the global machine ceiling", () => {
    const providerCapped = fixture(2, 8).slots;
    expect(providerCapped.caps("zai")).toEqual({ provider: 2, global: 8 });
    const globalCapped = fixture(5, 3).slots;
    expect(globalCapped.caps("zai")).toEqual({ provider: 3, global: 3 });
    expect(globalCapped.caps("unknown-provider")).toEqual({ provider: 3, global: 3 });
  });

  it("fails closed once the provider cap is held and names the exhausted bucket", async () => {
    const { slots } = fixture(1, 8);
    const release = await slots.acquire("zai", undefined, 0);
    await expect(slots.acquire("zai", undefined, 0)).rejects.toThrow(/exhausted for zai/);
    release();
    const next = await slots.acquire("zai", undefined, 0);
    next();
  });

  it("returns the provider slot when the global ceiling is full", async () => {
    const { dir, slots } = fixture(1, 1);
    const held = await slots.acquire("zai", undefined, 0);
    await expect(slots.acquire("other", undefined, 0)).rejects.toThrow(/exhausted for other/);
    expect(slots.heldCount("other", 1)).toBe(0);
    expect(existsSync(lockPath(dir, "other", 0))).toBe(false);
    held();
  });

  it("reclaims a stale lease under the single-winner claim and removes the claim", async () => {
    const { dir, slots } = fixture(1, 8);
    writeStamp(dir, "zai", { pid: DEAD_PID, born: Date.now(), nonce: "crashed" });

    const release = await slots.acquire("zai", undefined, 0);
    const stamp = JSON.parse(readFileSync(lockPath(dir, "zai", 0), "utf8")) as { pid: number; nonce: string };
    expect(stamp.pid).toBe(process.pid);
    expect(stamp.nonce).not.toBe("crashed");
    // The claim is scoped to the reclaim, so it must not outlive that win.
    expect(existsSync(claimPath(dir, "zai", 0))).toBe(false);
    expect(strayFiles(dir, "zai")).toEqual([]);

    release();
    expect(existsSync(lockPath(dir, "zai", 0))).toBe(false);
    expect(strayFiles(dir, "zai")).toEqual([]);
  });

  it("publishes complete stamps and leaves no publish artifacts behind", async () => {
    const { dir, slots } = fixture(1, 8);
    for (let i = 0; i < 25; i++) {
      // Each round goes through the claim-guarded reclaim path, so a leaked
      // claim would starve the bucket on the next round.
      writeStamp(dir, "zai", { pid: DEAD_PID, born: Date.now(), nonce: `crashed-${i}` });
      const release = await slots.acquire("zai", undefined, 0);
      const stamp = JSON.parse(readFileSync(lockPath(dir, "zai", 0), "utf8")) as { pid: number; nonce: string };
      expect(stamp.pid).toBe(process.pid);
      expect(typeof stamp.nonce).toBe("string");
      expect(stamp.nonce.length).toBeGreaterThan(0);
      expect(strayFiles(dir, "zai")).toEqual([]);
      expect(strayFiles(dir, "global")).toEqual([]);
      release();
    }
    expect(existsSync(lockPath(dir, "zai", 0))).toBe(false);
  });

  it("never reclaims a slot whose stamp cannot be read, and counts it as held", async () => {
    const { dir, slots } = fixture(1, 8);
    writeStamp(dir, "zai", "not-json-at-all");

    await expect(slots.acquire("zai", undefined, 0)).rejects.toThrow(/exhausted for zai/);
    expect(readFileSync(lockPath(dir, "zai", 0), "utf8")).toBe("not-json-at-all");
    // Conservative occupancy: an unreadable slot is not free capacity.
    expect(slots.heldCount("zai", 1)).toBe(1);
    // Recovery is a manual rm, not an age-based steal.
    rmSync(lockPath(dir, "zai", 0), { force: true });
    const release = await slots.acquire("zai", undefined, 0);
    release();
  });

  it("leaves a stale lease alone while a peer holds the reclaim claim", async () => {
    const { dir, slots } = fixture(1, 8);
    const stale = { pid: DEAD_PID, born: Date.now(), nonce: "crashed-but-claimed" };
    writeStamp(dir, "zai", stale);
    // Even a claim whose recorded holder is provably dead is never stolen:
    // stealing would need an atomic conditional unlink, and two stealers could
    // then both unlink a fresh lease between them.
    writeClaim(dir, "zai", { pid: DEAD_PID, born: Date.now(), nonce: "abandoned-claim" });

    await expect(slots.acquire("zai", undefined, 0)).rejects.toThrow(/exhausted for zai/);
    expect(JSON.parse(readFileSync(lockPath(dir, "zai", 0), "utf8"))).toEqual(stale);
    expect(existsSync(claimPath(dir, "zai", 0))).toBe(true);

    // Bounded manual recovery: the stale lease is reclaimed once the abandoned
    // claim is removed, and no other index or bucket was harmed meanwhile.
    rmSync(claimPath(dir, "zai", 0), { force: true });
    const release = await slots.acquire("zai", undefined, 0);
    expect((JSON.parse(readFileSync(lockPath(dir, "zai", 0), "utf8")) as { pid: number }).pid).toBe(process.pid);
    release();
  });

  it("fails closed on an unreadable reclaim claim", async () => {
    const { dir, slots } = fixture(1, 8);
    writeStamp(dir, "zai", { pid: DEAD_PID, born: Date.now(), nonce: "crashed-unreadable-claim" });
    writeClaim(dir, "zai", "not-json-claim");

    await expect(slots.acquire("zai", undefined, 0)).rejects.toThrow(/exhausted for zai/);
    expect(readFileSync(claimPath(dir, "zai", 0), "utf8")).toBe("not-json-claim");
    expect(JSON.parse(readFileSync(lockPath(dir, "zai", 0), "utf8")).nonce).toBe("crashed-unreadable-claim");
  });

  it("never reclaims a live holder even far past any fixed TTL", async () => {
    const { dir, slots } = fixture(1, 8);
    const liveStamp = { pid: process.pid, born: Date.now() - 9 * 60 * 60_000, nonce: "long-horizon-lease" };
    writeStamp(dir, "zai", liveStamp);

    expect(slots.heldCount("zai", 1)).toBe(1);
    await expect(slots.acquire("zai", undefined, 0)).rejects.toThrow(/exhausted for zai/);
    expect(JSON.parse(readFileSync(lockPath(dir, "zai", 0), "utf8"))).toEqual(liveStamp);
    // A live lease is never rewritten in place either: publish must not clobber.
    expect(readFileSync(lockPath(dir, "zai", 0), "utf8")).toBe(JSON.stringify(liveStamp));
    expect(strayFiles(dir, "zai")).toEqual([]);
  });

  it("release never unlinks a slot recreated under a foreign nonce", async () => {
    const { dir, slots } = fixture(1, 8);
    const release = await slots.acquire("zai", undefined, 0);
    const foreign = { pid: process.pid, born: Date.now(), nonce: "foreign-owner" };
    writeStamp(dir, "zai", foreign);

    release();
    expect(JSON.parse(readFileSync(lockPath(dir, "zai", 0), "utf8"))).toEqual(foreign);
  });

  it("counts only in-cap holders and leaves foreign-capacity slots untouched", () => {
    const { dir, slots } = fixture(1, 8);
    writeStamp(dir, "zai", { pid: process.pid, born: Date.now(), nonce: "in-cap" }, 0);
    writeStamp(dir, "zai", { pid: process.pid, born: Date.now(), nonce: "foreign" }, 4);
    writeFileSync(join(dir, "zai", "not-a-slot.txt"), "ignore");

    expect(slots.heldCount("zai", 1)).toBe(1);
    expect(existsSync(lockPath(dir, "zai", 4))).toBe(true);
  });

  it("does not acquire after abort and reports the aborted wait", async () => {
    const { slots } = fixture(1, 8);
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(slots.acquire("zai", controller.signal, 0)).rejects.toThrow(/aborted/);
    expect(slots.heldCount("zai", 1)).toBe(0);
  });

  it("proves machine-wide ownership via the on-disk holder stamp", async () => {
    const { dir, slots } = fixture(1, 8);
    const release = await slots.acquire("zai", undefined, 0);
    const again = await slots.acquire("zai", undefined, 0).catch((error: Error) => error);
    expect(again).toBeInstanceOf(Error);

    // A separate MachineSlots instance (as another pi session would create) sees
    // the same held slot instead of double-booking machine capacity.
    const otherSession = new MachineSlots({ dir, config: { session: { providers: {}, global: 8 }, machine: { providers: { zai: 1 }, global: 8 } } });
    expect(otherSession.heldCount("zai", 1)).toBe(1);
    expect(otherSession.caps("zai")).toEqual({ provider: 1, global: 8 });
    release();
    expect(otherSession.heldCount("zai", 1)).toBe(0);
  });

  it("propagates bounded owner metadata and immediately observes provider contention", async () => {
    const { dir, slots } = fixture(1, 8);
    const owner = { runId: "run-owner", taskId: "task-owner", sessionId: "session-owner" };
    const onSuccessWait = vi.fn();
    const release = await slots.acquire("zai", undefined, 0, { owner, onWait: onSuccessWait });
    expect(onSuccessWait).not.toHaveBeenCalled();
    for (const bucket of ["zai", "global"]) {
      expect(JSON.parse(readFileSync(lockPath(dir, bucket), "utf8")).owner).toEqual(owner);
    }

    const waits: MachineCapacitySnapshot[] = [];
    const pending = slots.acquire("zai", undefined, 0, { onWait: (snapshot) => waits.push(snapshot) });
    // No timer or promise continuation is required for the first observation.
    expect(waits).toHaveLength(1);
    expect(waits[0].providerBucket).toEqual({
      cap: 1, held: 1,
      owners: [{ index: 0, pid: process.pid, born: expect.any(Number), ...owner, kind: "lease", status: "live" }],
    });
    expect(waits[0].globalBucket.held).toBe(1);
    expect(JSON.stringify(waits[0])).not.toContain("nonce");
    await expect(pending).rejects.toThrow(/exhausted/);
    release();
    expect(slots.inspect("zai").providerBucket.held).toBe(0);
    expect(slots.inspect("zai").globalBucket.held).toBe(0);
  });

  it("observes global contention after returning the temporary provider lease", async () => {
    const { slots } = fixture(1, 1);
    const release = await slots.acquire("zai", undefined, 0, { owner: { runId: "held-run", taskId: "held-task" } });
    const onWait = vi.fn();
    await expect(slots.acquire("other", undefined, 0, { onWait })).rejects.toThrow(/exhausted for other/);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait.mock.calls[0][0]).toMatchObject({
      provider: "other", providerBucket: { cap: 1, held: 0, owners: [] },
      globalBucket: { cap: 1, held: 1, owners: [{ runId: "held-run", taskId: "held-task" }] },
    });
    release();
  });

  it("supports legacy stamps and rejects invalid or extraneous owner fields", async () => {
    const { dir, slots } = fixture(3, 8);
    const legacy = { pid: process.pid, born: 1, nonce: "legacy" };
    writeStamp(dir, "zai", legacy);
    writeStamp(dir, "zai", { ...legacy, nonce: "dead", pid: DEAD_PID }, 1);
    writeStamp(dir, "zai", { ...legacy, owner: { runId: "bad run", taskId: "task", prompt: "SECRET" } }, 2);
    const before = readFileSync(lockPath(dir, "zai"), "utf8");
    const snapshot = slots.inspect("zai");
    expect(snapshot.providerBucket.held).toBe(2);
    expect(snapshot.providerBucket.owners).toEqual([
      { index: 0, pid: process.pid, born: 1, kind: "lease", status: "live" },
      { index: 1, pid: DEAD_PID, born: 1, kind: "lease", status: "dead" },
      { index: 2, pid: process.pid, born: 1, kind: "lease", status: "live" },
    ]);
    expect(readFileSync(lockPath(dir, "zai"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "global"))).toBe(false);

    const fresh = fixture().slots;
    const release = await fresh.acquire("zai", undefined, 0, {
      owner: { runId: "x".repeat(257), taskId: "task" },
    });
    expect(fresh.inspect("zai").providerBucket.owners[0].runId).toBeUndefined();
    release();
    const extra = { runId: "run", taskId: "task", prompt: "SECRET", commandline: "SECRET", nonce: "SECRET" };
    const next = await fresh.acquire("zai", undefined, 0, { owner: extra });
    expect(fresh.inspect("zai").providerBucket.owners[0]).toMatchObject({ runId: "run", taskId: "task" });
    expect(JSON.stringify(fresh.inspect("zai"))).not.toContain("SECRET");
    next();
  });

  it("does not mistake an uncertain process probe for a dead holder", async () => {
    const { dir, slots } = fixture();
    const stamp = { pid: process.pid, born: 1, nonce: "uncertain" };
    const path = writeStamp(dir, "zai", stamp);
    const probe = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("probe failed"), { code: "EIO" }); });
    try {
      expect(slots.inspect("zai").providerBucket.owners[0].status).toBe("unknown");
      await expect(slots.acquire("zai", undefined, 0)).rejects.toThrow(/exhausted/);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(stamp);
    } finally { probe.mockRestore(); }
  });

  it("counts claims once per blocked index, even when dead or unreadable", async () => {
    const { dir, slots } = fixture(2, 8);
    const dead = { pid: DEAD_PID, born: 1, nonce: "dead" };
    writeStamp(dir, "zai", dead);
    writeClaim(dir, "zai", dead);
    writeClaim(dir, "zai", "unreadable", 1);
    writeClaim(dir, "zai", dead, 9); // Outside the local capacity view.
    const snapshot = slots.inspect("zai");
    expect(snapshot.providerBucket).toEqual({ cap: 2, held: 2, owners: [
      { index: 0, kind: "lease", status: "dead", pid: DEAD_PID, born: 1 },
      { index: 0, kind: "claim", status: "dead", pid: DEAD_PID, born: 1 },
      { index: 1, kind: "claim", status: "unknown" },
    ] });
    const onWait = vi.fn();
    await expect(slots.acquire("zai", undefined, 0, { onWait })).rejects.toThrow(/exhausted/);
    expect(onWait.mock.calls[0][0]).toEqual(snapshot);
    expect(slots.heldCount("zai", 2)).toBe(2);
    expect(readFileSync(claimPath(dir, "zai", 1), "utf8")).toBe("unreadable");
    expect(JSON.parse(readFileSync(lockPath(dir, "zai"), "utf8"))).toEqual(dead);
  });

  it("observes read failures and inaccessible storage without mutating anything", () => {
    const { dir, slots } = fixture(2, 8);
    expect(slots.inspect("zai").providerBucket).toEqual({ cap: 2, held: 0, owners: [] });
    expect(readdirSync(dir)).toEqual([]);
    mkdirSync(lockPath(dir, "zai"), { recursive: true }); // EISDIR: deterministic even as root.
    writeStamp(dir, "zai", "invalid-json", 1);
    expect(slots.inspect("zai").providerBucket).toEqual({ cap: 2, held: 2, owners: [
      { index: 0, kind: "lease", status: "unknown" },
      { index: 1, kind: "lease", status: "unknown" },
    ] });
    rmSync(join(dir, "zai"), { recursive: true });
    writeFileSync(join(dir, "zai"), "not-a-directory"); // ENOTDIR: inaccessible bucket.
    const snapshot = slots.inspect("zai");
    expect(snapshot.providerBucket.held).toBe(2);
    expect(snapshot.providerBucket.owners.every((owner) => owner.status === "unknown")).toBe(true);
    expect(snapshot.globalBucket.held).toBe(0);
    expect(readFileSync(join(dir, "zai"), "utf8")).toBe("not-a-directory");
    expect(readdirSync(dir)).toEqual(["zai"]);
  });

  it("reports polling retries but never emits a wait observation after success", async () => {
    vi.useFakeTimers();
    const { slots } = fixture();
    const release = await slots.acquire("zai", undefined, 0);
    const onWait = vi.fn();
    const pending = slots.acquire("zai", undefined, 1000, { onWait });
    expect(onWait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(onWait).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(250);
    const acquired = await pending;
    expect(onWait).toHaveBeenCalledTimes(2);
    acquired();
    expect(slots.inspect("zai").globalBucket.held).toBe(0);
  });

  it("cleans up aborted waits and tolerates throwing diagnostic callbacks", async () => {
    const { slots } = fixture();
    const release = await slots.acquire("zai", undefined, 0);
    const controller = new AbortController();
    const onWait = vi.fn(() => {
      controller.abort();
      throw new Error("observer failure");
    });
    await expect(slots.acquire("zai", controller.signal, 1000, { onWait })).rejects.toThrow(/aborted/);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(slots.inspect("zai").providerBucket.held).toBe(1);
    release();
    const afterAbort = vi.fn();
    await expect(slots.acquire("zai", controller.signal, 0, { onWait: afterAbort })).rejects.toThrow(/aborted/);
    expect(afterAbort).not.toHaveBeenCalled();
    const next = await slots.acquire("zai", undefined, 0);
    next();
    expect(slots.inspect("zai").providerBucket.held).toBe(0);
  });

  it("uses the env-overridable default slot directory", () => {
    const previous = process.env.STEAK_PI_USAP_SLOT_DIR;
    process.env.STEAK_PI_USAP_SLOT_DIR = "/tmp/steak-pi-slots-test";
    try {
      expect(defaultSlotDir()).toBe("/tmp/steak-pi-slots-test");
    } finally {
      if (previous === undefined) delete process.env.STEAK_PI_USAP_SLOT_DIR;
      else process.env.STEAK_PI_USAP_SLOT_DIR = previous;
    }
  });
});

describe("NoopSlots", () => {
  it("is an inert limiter for tests and embedded hosts", async () => {
    const slots = new NoopSlots();
    const release = await slots.acquire();
    expect(typeof release).toBe("function");
    expect(() => release()).not.toThrow();
    expect(slots.caps()).toEqual({ provider: Number.MAX_SAFE_INTEGER, global: Number.MAX_SAFE_INTEGER });
    expect(slots.heldCount()).toBe(0);
    const onWait = vi.fn();
    const anotherRelease = await slots.acquire("zai", undefined, 0, { onWait });
    anotherRelease();
    expect(onWait).not.toHaveBeenCalled();
    expect(slots.inspect("zai")).toEqual({
      provider: "zai",
      providerBucket: { cap: Number.MAX_SAFE_INTEGER, held: 0, owners: [] },
      globalBucket: { cap: Number.MAX_SAFE_INTEGER, held: 0, owners: [] },
    });
  });
});

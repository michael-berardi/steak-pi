import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MachineSlots, NoopSlots, defaultSlotDir } from "../src/subagents/machine-slots.ts";
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
  });
});

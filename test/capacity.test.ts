import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MachineSlots, NoopSlots } from "../src/subagents/machine-slots.ts";
import { adaptiveCeiling, loadCapacityConfig, machineCap, sessionCap } from "../src/subagents/capacity.ts";
import { SessionScheduler, THROTTLE_RESET_MS, THROTTLE_WINDOW_MS } from "../src/subagents/scheduler.ts";

const tempDirs: string[] = [];

function slotDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "usap-slots-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.STEAK_PI_USAP_CAPS;
});

describe("capacity config", () => {
  it("ships no provider-specific ceiling and no fixed width: capacity follows the computer", () => {
    const config = loadCapacityConfig(undefined as unknown as string);
    expect(config.session.providers).toEqual({});
    expect(config.machine.providers).toEqual({});
    const ceiling = adaptiveCeiling();
    expect(config.session.global).toBe(ceiling);
    expect(config.machine.global).toBe(ceiling);
    for (const provider of ["provider-a", "provider-b", "unknown"]) {
      expect(sessionCap(config, provider)).toBe(ceiling);
      expect(machineCap(config, provider)).toBe(ceiling);
    }
  });

  it("sizes the ceiling from cores and memory, within 4 to 64", () => {
    const GIB = 1024 ** 3;
    expect(adaptiveCeiling(8, 64 * GIB)).toBe(16); // two per core
    expect(adaptiveCeiling(16, 24 * GIB)).toBe(12); // one per 2 GiB
    expect(adaptiveCeiling(1, 1 * GIB)).toBe(4); // a small machine still runs a wave
    expect(adaptiveCeiling(128, 512 * GIB)).toBe(64); // hard bound
    expect(adaptiveCeiling(Number.NaN, Number.NaN)).toBe(4);
  });

  it("sizes a default session scheduler from the computer, and an operator cap wins", () => {
    process.env.STEAK_PI_USAP_CAPS = "off";
    expect(new SessionScheduler().maxConcurrency).toBe(adaptiveCeiling());
    const path = join(slotDir(), "caps.json");
    writeFileSync(path, JSON.stringify({ session: { global: 40, providers: { "provider-a": 3 } } }));
    const config = loadCapacityConfig(path);
    const scheduler = new SessionScheduler(config.session.global, config);
    expect(scheduler.maxConcurrency).toBe(40);
    expect(scheduler.capFor("provider-a")).toBe(3);
    expect(scheduler.capFor("provider-b")).toBe(40);
  });

  it("loads overrides and falls back on malformed files", () => {
    const { writeFileSync: write } = { writeFileSync };
    const path = join(slotDir(), "caps.json");
    write(path, JSON.stringify({ machine: { providers: { xiaomi: 20 }, global: 30 } }));
    const config = loadCapacityConfig(path);
    expect(machineCap(config, "xiaomi")).toBe(20);
    expect(config.machine.global).toBe(30);

    const bad = join(slotDir(), "bad.json");
    write(bad, "{not json");
    expect(loadCapacityConfig(bad)).toEqual(loadCapacityConfig(undefined as unknown as string));
  });
});

describe("SessionScheduler provider buckets", () => {
  it("runs Xiaomi 8 + Codex 6 concurrently in one session", async () => {
    const scheduler = new SessionScheduler(14);
    let peakXiaomi = 0;
    let peakCodex = 0;
    let activeXiaomi = 0;
    let activeCodex = 0;
    await Promise.all([
      ...Array.from({ length: 8 }, () => scheduler.run(async () => {
        activeXiaomi += 1;
        peakXiaomi = Math.max(peakXiaomi, activeXiaomi);
        await new Promise((r) => setTimeout(r, 20));
        activeXiaomi -= 1;
      }, undefined, "xiaomi")),
      ...Array.from({ length: 6 }, () => scheduler.run(async () => {
        activeCodex += 1;
        peakCodex = Math.max(peakCodex, activeCodex);
        await new Promise((r) => setTimeout(r, 20));
        activeCodex -= 1;
      }, undefined, "openai-codex")),
    ]);
    expect(peakXiaomi).toBe(8);
    expect(peakCodex).toBe(6);
  });

  it("caps a provider bucket and does not head-of-line block other providers", async () => {
    const config = loadCapacityConfig(undefined as unknown as string);
    config.session.providers = { xiaomi: 8 };
    const scheduler = new SessionScheduler(14, config);
    const releaseXiaomi: Array<() => void> = [];
    // Fill the xiaomi bucket.
    for (let i = 0; i < 8; i++) {
      releaseXiaomi.push(await scheduler.acquire(undefined, "xiaomi"));
    }
    expect(scheduler.activeCount).toBe(8);
    let codexRan = false;
    const codexRun = scheduler.run(async () => { codexRan = true; }, undefined, "openai-codex");
    const queuedXiaomi = scheduler.run(async () => undefined, undefined, "xiaomi");
    await new Promise((r) => setTimeout(r, 30));
    // A free Codex slot must proceed even though xiaomi is saturated and queued.
    expect(codexRan).toBe(true);
    expect(scheduler.queuedCount).toBe(1);
    for (const release of releaseXiaomi) release();
    await codexRun;
    await queuedXiaomi;
    expect(scheduler.activeCount).toBe(0);
  });
});

describe("SessionScheduler adaptive width", () => {
  const wide = () => {
    const config = loadCapacityConfig(undefined as unknown as string);
    config.session.global = 32;
    return config;
  };

  it("runs a 24-task wave 24 wide when capacity allows", async () => {
    const scheduler = new SessionScheduler(32, wide());
    let active = 0; let peak = 0;
    await Promise.all(Array.from({ length: 24 }, () => scheduler.run(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
    }, undefined, "provider-a")));
    expect(peak).toBe(24);
  });

  it("halves a rate-limited provider once per burst, leaves others alone, and recovers a slot per clean finish", async () => {
    let now = 1_000;
    const scheduler = new SessionScheduler(32, wide(), () => now);
    const held = await Promise.all(Array.from({ length: 16 }, () => scheduler.acquire(undefined, "provider-a")));
    expect(scheduler.limitFor("provider-a")).toBe(32);
    scheduler.throttle("provider-a");
    scheduler.throttle("provider-a"); // same burst: counted once
    expect(scheduler.limitFor("provider-a")).toBe(8);
    expect(scheduler.limitFor("provider-b")).toBe(32);

    // Running workers keep running; a new launch waits until the provider is under its reduced width.
    let started = false;
    const waiting = scheduler.run(async () => { started = true; }, undefined, "provider-a");
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(false);
    for (const release of held.splice(0, 9)) release();
    await waiting;
    expect(started).toBe(true);

    now += THROTTLE_WINDOW_MS + 1;
    scheduler.throttle("provider-a"); // a later refusal halves again, never below one
    expect(scheduler.limitFor("provider-a")).toBe(3);
    for (let i = 0; i < 40; i++) scheduler.recover("provider-a");
    expect(scheduler.limitFor("provider-a")).toBe(32);
    for (const release of held) release();
    for (let i = 0; i < 12; i++) { now += THROTTLE_WINDOW_MS + 1; scheduler.throttle("provider-a"); }
    expect(scheduler.limitFor("provider-a")).toBe(1);
    now += THROTTLE_RESET_MS; // quiet for long enough: full width again
    expect(scheduler.limitFor("provider-a")).toBe(32);
  });
});

describe("MachineSlots", () => {
  it("bounds concurrent holders across independent instances sharing a dir", async () => {
    const dir = slotDir();
    const config = loadCapacityConfig(undefined as unknown as string);
    config.machine.providers = { xiaomi: 2 };
    const a = new MachineSlots({ dir, config });
    const b = new MachineSlots({ dir, config });
    const releases: Array<() => void> = [];
    releases.push(await a.acquire("xiaomi"));
    releases.push(await b.acquire("xiaomi"));
    await expect(a.acquire("xiaomi", undefined, 60)).rejects.toThrow(/exhausted/);
    releases.forEach((release) => release());
    const again = await a.acquire("xiaomi", undefined, 60);
    again();
  });

  it("caps the global bucket across providers", async () => {
    const dir = slotDir();
    const config = loadCapacityConfig(undefined as unknown as string);
    config.machine.global = 2;
    config.machine.providers = { xiaomi: 16 };
    const slots = new MachineSlots({ dir, config });
    const r1 = await slots.acquire("xiaomi");
    const r2 = await slots.acquire("xiaomi");
    await expect(slots.acquire("xiaomi", undefined, 60)).rejects.toThrow(/exhausted/);
    r1();
    const r3 = await slots.acquire("xiaomi", undefined, 60);
    r3();
    r2();
  });

  it("reclaims slots leaked by dead pids, and release never deletes a foreign lease", async () => {
    const dir = slotDir();
    const config = loadCapacityConfig(undefined as unknown as string);
    config.machine.providers = { xiaomi: 1 };
    const slots = new MachineSlots({ dir, config });
    const release = await slots.acquire("xiaomi");
    // Simulate a crashed holder: dead pid inside the held slot file.
    writeFileSync(join(dir, "xiaomi", "0.lock"), JSON.stringify({ pid: 2_147_483_646, born: Date.now(), nonce: "crashed" }));
    release(); // foreign or crashed holder: release must not delete
    expect(existsSync(join(dir, "xiaomi", "0.lock"))).toBe(true);
    const reclaimed = await slots.acquire("xiaomi", undefined, 5_000);
    reclaimed();
  });

  it("keeps out-of-cap slots of other capacity views intact", async () => {
    const dir = slotDir();
    const config = loadCapacityConfig(undefined as unknown as string);
    config.machine.providers = { xiaomi: 2 };
    const slots = new MachineSlots({ dir, config });
    mkdirSync(join(dir, "xiaomi"), { recursive: true });
    writeFileSync(join(dir, "xiaomi", "99.lock"), JSON.stringify({ pid: process.pid, born: Date.now(), nonce: "other-view" }));
    expect(slots.heldCount("xiaomi", 2)).toBe(0); // out of this view's cap: ignored, not deleted
    expect(existsSync(join(dir, "xiaomi", "99.lock"))).toBe(true);
  });

  it("NoopSlots never bounds", async () => {
    const noop = new NoopSlots();
    const r1 = await noop.acquire();
    const r2 = await noop.acquire();
    r1();
    r2();
    expect((await noop.heldCount())).toBe(0);
  });
});

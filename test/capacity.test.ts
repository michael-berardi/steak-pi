import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MachineSlots, NoopSlots } from "../src/subagents/machine-slots.ts";
import { loadCapacityConfig, machineCap, sessionCap } from "../src/subagents/capacity.ts";
import { SessionScheduler } from "../src/subagents/scheduler.ts";

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
  it("defaults to GLM 8 + Codex 6 per session and machine-wide totals", () => {
    const config = loadCapacityConfig(undefined as unknown as string);
    expect(sessionCap(config, "zai")).toBe(8);
    expect(sessionCap(config, "openai-codex")).toBe(6);
    expect(machineCap(config, "zai")).toBe(6);
    expect(machineCap(config, "openai-codex")).toBe(12);
    expect(config.machine.global).toBe(24);
  });

  it("loads overrides and falls back on malformed files", () => {
    const { writeFileSync: write } = { writeFileSync };
    const path = join(slotDir(), "caps.json");
    write(path, JSON.stringify({ machine: { providers: { zai: 20 }, global: 30 } }));
    const config = loadCapacityConfig(path);
    expect(machineCap(config, "zai")).toBe(20);
    expect(config.machine.global).toBe(30);

    const bad = join(slotDir(), "bad.json");
    write(bad, "{not json");
    expect(loadCapacityConfig(bad)).toEqual(loadCapacityConfig(undefined as unknown as string));
  });
});

describe("SessionScheduler provider buckets", () => {
  it("runs GLM 8 + Luna 6 concurrently in one session", async () => {
    const scheduler = new SessionScheduler(14);
    let peakZai = 0;
    let peakCodex = 0;
    let activeZai = 0;
    let activeCodex = 0;
    await Promise.all([
      ...Array.from({ length: 8 }, () => scheduler.run(async () => {
        activeZai += 1;
        peakZai = Math.max(peakZai, activeZai);
        await new Promise((r) => setTimeout(r, 20));
        activeZai -= 1;
      }, undefined, "zai")),
      ...Array.from({ length: 6 }, () => scheduler.run(async () => {
        activeCodex += 1;
        peakCodex = Math.max(peakCodex, activeCodex);
        await new Promise((r) => setTimeout(r, 20));
        activeCodex -= 1;
      }, undefined, "openai-codex")),
    ]);
    expect(peakZai).toBe(8);
    expect(peakCodex).toBe(6);
  });

  it("caps a provider bucket and does not head-of-line block other providers", async () => {
    const scheduler = new SessionScheduler(14);
    const releaseZai: Array<() => void> = [];
    // Fill the zai bucket.
    for (let i = 0; i < 8; i++) {
      releaseZai.push(await scheduler.acquire(undefined, "zai"));
    }
    expect(scheduler.activeCount).toBe(8);
    let codexRan = false;
    const codexRun = scheduler.run(async () => { codexRan = true; }, undefined, "openai-codex");
    const queuedZai = scheduler.run(async () => undefined, undefined, "zai");
    await new Promise((r) => setTimeout(r, 30));
    // A free Luna slot must proceed even though zai is saturated and queued.
    expect(codexRan).toBe(true);
    expect(scheduler.queuedCount).toBe(1);
    for (const release of releaseZai) release();
    await codexRun;
    await queuedZai;
    expect(scheduler.activeCount).toBe(0);
  });
});

describe("MachineSlots", () => {
  it("bounds concurrent holders across independent instances sharing a dir", async () => {
    const dir = slotDir();
    const config = loadCapacityConfig(undefined as unknown as string);
    config.machine.providers = { zai: 2 };
    const a = new MachineSlots({ dir, config });
    const b = new MachineSlots({ dir, config });
    const releases: Array<() => void> = [];
    releases.push(await a.acquire("zai"));
    releases.push(await b.acquire("zai"));
    await expect(a.acquire("zai", undefined, 60)).rejects.toThrow(/exhausted/);
    releases.forEach((release) => release());
    const again = await a.acquire("zai", undefined, 60);
    again();
  });

  it("caps the global bucket across providers", async () => {
    const dir = slotDir();
    const config = loadCapacityConfig(undefined as unknown as string);
    config.machine.global = 2;
    config.machine.providers = { zai: 16 };
    const slots = new MachineSlots({ dir, config });
    const r1 = await slots.acquire("zai");
    const r2 = await slots.acquire("zai");
    await expect(slots.acquire("zai", undefined, 60)).rejects.toThrow(/exhausted/);
    r1();
    const r3 = await slots.acquire("zai", undefined, 60);
    r3();
    r2();
  });

  it("reclaims slots leaked by dead pids, and release never deletes a foreign lease", async () => {
    const dir = slotDir();
    const config = loadCapacityConfig(undefined as unknown as string);
    config.machine.providers = { zai: 1 };
    const slots = new MachineSlots({ dir, config });
    const release = await slots.acquire("zai");
    // Simulate a crashed holder: dead pid inside the held slot file.
    writeFileSync(join(dir, "zai", "0.lock"), JSON.stringify({ pid: 3_999_999_999, born: Date.now(), nonce: "crashed" }));
    release(); // foreign or crashed holder: release must not delete
    expect(existsSync(join(dir, "zai", "0.lock"))).toBe(true);
    const reclaimed = await slots.acquire("zai", undefined, 5_000);
    reclaimed();
  });

  it("keeps out-of-cap slots of other capacity views intact", async () => {
    const dir = slotDir();
    const config = loadCapacityConfig(undefined as unknown as string);
    config.machine.providers = { zai: 2 };
    const slots = new MachineSlots({ dir, config });
    mkdirSync(join(dir, "zai"), { recursive: true });
    writeFileSync(join(dir, "zai", "99.lock"), JSON.stringify({ pid: process.pid, born: Date.now(), nonce: "other-view" }));
    expect(slots.heldCount("zai", 2)).toBe(0); // out of this view's cap: ignored, not deleted
    expect(existsSync(join(dir, "zai", "99.lock"))).toBe(true);
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

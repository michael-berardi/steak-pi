import { open, readdir, readFile, rm, stat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { machineCap, loadCapacityConfig, type CapacityConfig } from "./capacity.ts";

/**
 * Cross-process provider-bucketed launch slots.
 *
 * A fixed set of numbered slot files per bucket (one directory per provider,
 * plus one shared "global" directory) bounds how many workers all pi sessions
 * on this computer may run at once. Acquisition creates the slot file
 * exclusively (O_EXCL); release unlinks it. Crashed sessions leak slots, so
 * every holder records its pid and a coarse process-start stamp; a slot whose
 * pid is no longer alive, or whose stamp exceeds the TTL, is fair game for
 * reclaim by any process that needs it.
 */

const SLOT_TTL_MS = 45 * 60_000; // > MAX_TIMEOUT_MS (30m) + disposal grace.

export interface MachineSlotsOptions {
  /** Slot directory. Defaults to ~/.local/state/steak-pi/usap-slots. */
  dir?: string;
  config?: CapacityConfig;
}

export function defaultSlotDir(): string {
  if (process.env.STEAK_PI_USAP_SLOT_DIR) return process.env.STEAK_PI_USAP_SLOT_DIR;
  return join(homedir(), ".local", "state", "steak-pi", "usap-slots");
}

/** Coarse, clock-skew-tolerant process-start stamp derived from process uptime. */
function processStamp(): number {
  return Date.now() - Math.floor(process.uptime() * 1000);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"; // alive but guarded
  }
}

interface HolderStamp {
  pid: number;
  born: number;
}

async function readHolder(path: string): Promise<HolderStamp | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<HolderStamp>;
    if (typeof parsed.pid === "number" && typeof parsed.born === "number") {
      return { pid: parsed.pid, born: parsed.born };
    }
  } catch {
    // Unreadable/just-unlinked slot is treated as unheld.
  }
  return undefined;
}

function holderIsStale(holder: HolderStamp | undefined, now: number): boolean {
  if (!holder) return true;
  if (!pidAlive(holder.pid)) return true;
  return now - holder.born > SLOT_TTL_MS;
}

export class MachineSlots {
  private readonly dir: string;
  private readonly config: CapacityConfig;

  constructor(options: MachineSlotsOptions = {}) {
    this.dir = options.dir ?? defaultSlotDir();
    this.config = options.config ?? loadCapacityConfig();
  }

  caps(provider: string): { provider: number; global: number } {
    return { provider: machineCap(this.config, provider), global: this.config.machine.global };
  }

  private bucketDir(bucket: string): string {
    return join(this.dir, bucket.replace(/[^a-z0-9_-]+/gi, "_"));
  }

  /** Best-effort single-slot grab for one bucket. Returns release or undefined. */
  private async tryBucket(bucket: string, cap: number, signal?: AbortSignal): Promise<(() => void) | undefined> {
    if (signal?.aborted) return undefined;
    await mkdir(this.bucketDir(bucket), { recursive: true });
    const now = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      for (let i = 0; i < cap; i++) {
        if (signal?.aborted) return undefined;
        const path = join(this.bucketDir(bucket), `${i}.lock`);
        let handle;
        try {
          handle = await open(path, "wx");
        } catch {
          // Held. If stale, reclaim exactly once per pass.
          if (attempt === 1) continue;
          const holder = await readHolder(path);
          if (holderIsStale(holder, now)) {
            await rm(path, { force: true }).catch(() => undefined);
          }
          continue;
        }
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, born: processStamp() } satisfies HolderStamp));
        } finally {
          await handle.close();
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          void rm(path, { force: true }).catch(() => undefined);
        };
      }
    }
    return undefined;
  }

  private async heldCount(bucket: string, cap: number): Promise<number> {
    try {
      const entries = await readdir(this.bucketDir(bucket));
      let held = 0;
      const now = Date.now();
      for (const entry of entries) {
        if (!entry.endsWith(".lock")) continue;
        const index = Number(entry.slice(0, -5));
        if (!Number.isInteger(index) || index >= cap) {
          await rm(join(this.bucketDir(bucket), entry), { force: true }).catch(() => undefined);
          continue;
        }
        const holder = await readHolder(join(this.bucketDir(bucket), entry));
        if (!holderIsStale(holder, now)) held += 1;
      }
      return held;
    } catch {
      return 0;
    }
  }

  /**
   * Acquire one launch slot for `provider` across all local sessions. Waits
   * (bounded polling) until a provider slot and a global slot are both free.
   * The returned release is idempotent and never throws.
   */
  async acquire(provider: string, signal?: AbortSignal): Promise<() => void>;
  async acquire(provider: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<() => void>;
  async acquire(provider: string, signal?: AbortSignal, timeoutMs = 10 * 60_000): Promise<() => void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const { provider: providerCap, global: globalCap } = this.caps(provider);
    let providerRelease: (() => void) | undefined;
    try {
      while (!signal?.aborted) {
        providerRelease = await this.tryBucket(provider, providerCap, signal);
        if (providerRelease) {
          const globalRelease = await this.tryBucket("global", globalCap, signal);
          if (globalRelease) {
            const providerOnce = providerRelease;
            let done = false;
            return () => {
              if (done) return;
              done = true;
              providerOnce();
              globalRelease();
            };
          }
          // Global full: give back the provider slot and wait for room.
          providerRelease();
          providerRelease = undefined;
        }
        if (Date.now() >= deadline) break;
        const providerHeld = await this.heldCount(provider, providerCap);
        const globalHeld = await this.heldCount("global", globalCap);
        // Skip the sleep entirely when stale slots were just purged.
        const backoff = providerHeld < providerCap || globalHeld < globalCap ? 50 : 250;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoff);
          signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    } catch (error) {
      providerRelease?.();
      throw error;
    }
    providerRelease?.();
    throw new Error(`machine launch slots exhausted for ${provider}${signal?.aborted ? " (aborted)" : ""}`);
  }
}

/** No-op implementation for tests and embedded embeds that must not touch disk. */
export class NoopSlots {
  async acquire(): Promise<() => void> {
    return () => undefined;
  }
  caps(): { provider: number; global: number } {
    return { provider: Number.MAX_SAFE_INTEGER, global: Number.MAX_SAFE_INTEGER };
  }
  async heldCount(): Promise<number> {
    return 0;
  }
}

let machineSlotsSingleton: MachineSlots | undefined;

/**
 * Process-wide machine slots. Disabled (no-op) when STEAK_PI_USAP_MACHINE=off,
 * which unit test setups use to stay hermetic.
 */
export function defaultMachineSlots(): MachineSlots | NoopSlots {
  if (process.env.STEAK_PI_USAP_MACHINE === "off") {
    if (!machineSlotsNoop) machineSlotsNoop = new NoopSlots();
    return machineSlotsNoop;
  }
  if (!machineSlotsSingleton) machineSlotsSingleton = new MachineSlots();
  return machineSlotsSingleton;
}
let machineSlotsNoop: NoopSlots | undefined;

export const _slotInternals = { SLOT_TTL_MS, holderIsStale };

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { machineCap, loadCapacityConfig, type CapacityConfig } from "./capacity.ts";

/**
 * Cross-process provider-bucketed launch slots.
 *
 * A fixed set of numbered slot files per bucket (one directory per provider,
 * plus one shared "global" directory) bounds how many workers all pi sessions
 * on this computer may run at once. Acquisition creates the slot file
 * exclusively (O_EXCL) with its holder stamp written synchronously, so no
 * other local process can observe a created-but-empty slot. Release unlinks
 * the slot only when the stored stamp still names this exact lease, so a
 * reclaimed-and-recreated slot is never deleted by its previous owner.
 *
 * A slot is reclaimable when its holder pid is no longer alive (crashed
 * session) or its LEASE age exceeds the TTL. Lease age, not process age:
 * long-lived sessions must keep their live leases.
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
  /** Lease acquisition time (ms epoch), not process start. */
  born: number;
  /** Identity of this exact lease; release never deletes a foreign nonce. */
  nonce: string;
}

function readHolder(path: string): HolderStamp | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<HolderStamp>;
    if (typeof parsed.pid === "number" && typeof parsed.born === "number" && typeof parsed.nonce === "string") {
      return { pid: parsed.pid, born: parsed.born, nonce: parsed.nonce };
    }
  } catch {
    // Unreadable or just-unlinked slot carries no live owner to protect.
  }
  return undefined;
}

function holderIsStale(holder: HolderStamp | undefined, now: number): boolean {
  if (!holder) return true;
  if (!pidAlive(holder.pid)) return true;
  return now - holder.born > SLOT_TTL_MS;
}

/** Create the slot file with its holder stamp atomically w.r.t. every local event loop. */
function createSlot(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx");
    const stamp: HolderStamp = { pid: process.pid, born: Date.now(), nonce: randomUUID() };
    writeSync(fd, JSON.stringify(stamp));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* slot content already flushed */ }
    }
  }
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

  /** Best-effort single-slot grab for one bucket. Returns a release or undefined. */
  private tryBucket(bucket: string, cap: number, signal?: AbortSignal): (() => void) | undefined {
    if (signal?.aborted) return undefined;
    mkdirSync(this.bucketDir(bucket), { recursive: true });
    const now = Date.now();
    for (let i = 0; i < cap; i++) {
      if (signal?.aborted) return undefined;
      const path = join(this.bucketDir(bucket), `${i}.lock`);
      if (existsSync(path)) {
        // Held. Reclaim exactly when the recorded holder is provably gone.
        if (holderIsStale(readHolder(path), now)) rmSync(path, { force: true });
        if (!createSlot(path)) continue;
      } else if (!createSlot(path)) {
        continue; // Lost a creation race with another process.
      }
      // createSlot wrote our unique stamp; release must match it to unlink.
      const mine = readHolder(path);
      const nonce = mine?.pid === process.pid ? mine.nonce : undefined;
      let released = false;
      return () => {
        if (released || nonce === undefined) return;
        released = true;
        const holder = readHolder(path);
        if (holder && holder.nonce === nonce && holder.pid === process.pid) {
          rmSync(path, { force: true });
        }
      };
    }
    return undefined;
  }

  /** Count valid in-cap holders. Never deletes slots, regardless of index or cap. */
  heldCount(bucket: string, cap: number): number {
    let held = 0;
    let entries: string[];
    try {
      entries = readdirSync(this.bucketDir(bucket));
    } catch {
      return 0;
    }
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith(".lock")) continue;
      const index = Number(entry.slice(0, -5));
      if (!Number.isInteger(index) || index < 0 || index >= cap) continue; // foreign capacity view: leave it alone
      if (!holderIsStale(readHolder(join(this.bucketDir(bucket), entry)), now)) held += 1;
    }
    return held;
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
    let pendingSignal: { signal: AbortSignal; listener: () => void } | undefined;
    let settled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
        const listener = () => {
          clearTimeout(timer);
          resolve();
        };
        const cleanup = () => {
          signal?.removeEventListener("abort", listener);
          pendingSignal = undefined;
        };
        if (signal) {
          signal.addEventListener("abort", listener, { once: true });
          pendingSignal = { signal, listener };
        }
      });
    try {
      while (!signal?.aborted) {
        providerRelease = this.tryBucket(provider, providerCap, signal);
        if (providerRelease) {
          const globalRelease = this.tryBucket("global", globalCap, signal);
          if (globalRelease) {
            const providerOnce = providerRelease;
            let done = false;
            settled = true; // success: the finally must not release our slot
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
        const providerHeld = this.heldCount(provider, providerCap);
        const globalHeld = this.heldCount("global", globalCap);
        // Skip the sleep entirely when reclaimable slots were just purged.
        const backoff = providerHeld < providerCap || globalHeld < globalCap ? 50 : 250;
        await sleep(backoff);
      }
    } finally {
      if (pendingSignal) pendingSignal.signal.removeEventListener("abort", pendingSignal.listener);
      if (!settled) providerRelease?.();
    }
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
  heldCount(): number {
    return 0;
  }
}

let machineSlotsSingleton: MachineSlots | undefined;
let machineSlotsNoop: NoopSlots | undefined;

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

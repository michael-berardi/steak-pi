import { randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { machineCap, loadCapacityConfig, type CapacityConfig } from "./capacity.ts";

/**
 * Cross-process provider-bucketed launch slots.
 *
 * A fixed set of numbered slot files per bucket (one directory per provider,
 * plus one shared "global" directory) bounds how many workers all pi sessions
 * on this computer may run at once.
 *
 * Slot stamps are published, never written in place: the holder stamp is
 * written to a private temp file, closed, and then `link`ed onto the slot path.
 * `link` is atomic and fails with EEXIST, so a peer can only ever observe
 * ENOENT or a complete stamp. The older O_EXCL create followed by a separate
 * write was NOT atomic across processes: it exposed a created-but-empty slot
 * that a peer correctly read as unowned and then reclaimed, double-booking the
 * index while the first writer's bytes went to an unlinked inode.
 *
 * Removing a lease is the dangerous direction, because POSIX offers no atomic
 * "unlink if the content is still the stamp I read" - read, compare, then
 * unlink is a three-step race and does not eliminate the window. Stale-slot
 * reclamation therefore happens while holding that index's reclaim claim
 * (`<i>.lock.claim`), which is itself published atomically. Only the claim
 * holder may unlink a slot, and it re-reads the stamp after taking the claim.
 * Without that claim, two reclaimers that both read the same crashed holder
 * could unlink each other's freshly published lease and both walk away holding
 * the same index.
 *
 * A claim is only ever removed by the process that published it, which needs no
 * atomic compare because it re-reads its own nonce first. A claim left behind
 * by a crashed holder, or an unreadable claim, therefore fails closed: that
 * index is skipped rather than stolen, because stealing a foreign claim needs
 * the atomic conditional unlink POSIX does not provide. A slot is likewise
 * reclaimable only when its holder pid is provably gone: an eight-hour run
 * holds a live lease far past any fixed TTL, and an unreadable slot file is
 * left in place rather than guessed at. Fail-closed: unprovable ownership is
 * left alone rather than stolen.
 *
 * Accepted tradeoffs: manual removal requires first verifying that every
 * worker host using this directory has stopped. Never remove a live claim.
 * Recovery cases:
 * - A process that dies between publishing its claim stamp and removing it (a
 *   few synchronous syscalls, no awaits in between) parks one slot index.
 *   Recovery: `rm <slotdir>/<bucket>/<i>.lock.claim`.
 * - A slot file left unreadable by a torn write from a pre-fix build is never
 *   reclaimed, because an unreadable stamp is also exactly what a still-running
 *   pre-fix publisher looks like mid-write; reclaiming either by age would
 *   steal a lease that is about to become live. Recovery:
 *   `rm <slotdir>/<bucket>/<i>.lock`.
 * - A peer running a pre-fix build ignores the claim protocol, so during a
 *   rolling upgrade it can still publish into a reclaim window (and be read as
 *   unreadable mid-write). Draining workers, or clearing stale
 *   `<i>.lock` files, is the safe way to cross that boundary.
 * - A crash between temp-file creation and `link` leaves an inert `.tmp-*`
 *   file behind. Nothing but a `<i>.lock` path is ever read as a lease, so
 *   these can simply be deleted at leisure.
 */

/**
 * Retained for reference only. Lease age is deliberately NOT used to reclaim a
 * live holder, so no fixed TTL can expire a running worker's slot.
 */
export const SLOT_TTL_MS = 8 * 60 * 60_000 + 10 * 60_000;

export interface MachineSlotsOptions {
  /** Slot directory. Defaults to ~/.local/state/steak-pi/usap-slots. */
  dir?: string;
  config?: CapacityConfig;
}

export interface SlotOwner {
  index: number;
  pid?: number;
  born?: number;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  kind: "lease" | "claim";
  status: "live" | "dead" | "unknown";
}

export interface SlotBucketSnapshot {
  cap: number;
  /** Blocked indices, not the number of stamps (a claim and lease may coexist). */
  held: number;
  owners: SlotOwner[];
}

export interface MachineCapacitySnapshot {
  provider: string;
  providerBucket: SlotBucketSnapshot;
  globalBucket: SlotBucketSnapshot;
}

export interface MachineSlotsAcquireOptions {
  owner?: { runId: string; taskId: string; sessionId?: string };
  onWait?: (snapshot: MachineCapacitySnapshot) => void;
}

type OwnerMetadata = NonNullable<MachineSlotsAcquireOptions["owner"]>;

/** Only bounded identifiers are persisted, never arbitrary caller fields. */
function validatedOwner(value: unknown): OwnerMetadata | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const owner = value as Partial<OwnerMetadata>;
  const validId = (id: unknown): id is string =>
    typeof id === "string" && id.length <= 256 && /^[a-z0-9][a-z0-9._:-]*$/i.test(id);
  if (!validId(owner.runId) || !validId(owner.taskId)) return undefined;
  if (owner.sessionId !== undefined && !validId(owner.sessionId)) return undefined;
  return {
    runId: owner.runId,
    taskId: owner.taskId,
    ...(owner.sessionId !== undefined ? { sessionId: owner.sessionId } : {}),
  };
}

const SLOT_SUFFIX = ".lock";
const CLAIM_SUFFIX = ".claim";
/** Private publish scratch files; never read as leases. */
const TEMP_PREFIX = ".tmp-";

export function defaultSlotDir(): string {
  if (process.env.STEAK_PI_USAP_SLOT_DIR) return process.env.STEAK_PI_USAP_SLOT_DIR;
  return join(homedir(), ".local", "state", "steak-pi", "usap-slots");
}

function pidStatus(pid: number): SlotOwner["status"] {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "live"; // alive but guarded
    return code === "ESRCH" ? "dead" : "unknown";
  }
}

function pidAlive(pid: number): boolean {
  return pidStatus(pid) !== "dead"; // Only ESRCH proves a holder is gone.
}

interface HolderStamp {
  pid: number;
  /** Lease acquisition time (ms epoch), not process start. */
  born: number;
  /** Identity of this exact lease; release never deletes a foreign nonce. */
  nonce: string;
  owner?: OwnerMetadata;
}

function isHolderStamp(value: unknown): value is HolderStamp {
  const parsed = value as Partial<HolderStamp>;
  return (
    typeof parsed?.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0 &&
    typeof parsed.born === "number" && Number.isFinite(parsed.born) && parsed.born >= 0 &&
    typeof parsed.nonce === "string" && parsed.nonce.length > 0
  );
}

function freshStamp(owner?: OwnerMetadata): HolderStamp {
  return { pid: process.pid, born: Date.now(), nonce: randomUUID(), ...(owner ? { owner } : {}) };
}

/**
 * Read one slot or claim file without guessing. `present` separates "no file"
 * from "a file that exists but cannot be read or parsed"; the two demand
 * opposite reactions (publish into the gap vs leave it strictly alone), so
 * callers must never collapse them into a single `undefined`.
 */
function readStamp(path: string): { present: boolean; holder?: HolderStamp } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isHolderStamp(parsed)) {
      const owner = validatedOwner(parsed.owner);
      return { present: true, holder: { pid: parsed.pid, born: parsed.born, nonce: parsed.nonce, ...(owner ? { owner } : {}) } };
    }
    return { present: true };
  } catch (error) {
    // ENOENT is the only failure that proves absence; EACCES, EISDIR and
    // unparseable content all mean a file is there to respect.
    return { present: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
}

/** True only when the stamp names a pid that is provably gone on this host. */
function holderIsReclaimable(holder: HolderStamp | undefined): boolean {
  return holder !== undefined && !pidAlive(holder.pid);
}

function sameHolder(a: HolderStamp | undefined, b: HolderStamp | undefined): boolean {
  return a !== undefined && b !== undefined && a.pid === b.pid && a.born === b.born && a.nonce === b.nonce;
}

/**
 * Publish `path` carrying a fully written stamp, or fail because it is taken.
 *
 * The temp file is written and closed before it is linked into place, so peers
 * see either ENOENT or the complete stamp - never a partial one. Hardlinking
 * also keeps the "do not clobber an existing lease" guarantee that `rename`
 * would lose.
 */
function publishStamp(dir: string, path: string, stamp: HolderStamp): boolean {
  const tmp = join(dir, `${TEMP_PREFIX}${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, JSON.stringify(stamp));
    closeSync(fd);
    fd = undefined;
    linkSync(tmp, path); // atomic: EEXIST when `path` is already taken
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    // Never downgrade to create-then-write: that recreates the ownership race.
    throw new Error("USAP slot storage cannot publish an atomic lease; check local filesystem permissions and hardlink support");
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* stamp already flushed */ }
    }
    try { unlinkSync(tmp); } catch { /* temp already removed or never created */ }
  }
}

/**
 * Take the single-winner reclaim claim for one slot index. `undefined` means
 * the claim is held by a peer, or was abandoned unreadable - either way the
 * index is skipped, never stolen: removing a foreign claim would need the
 * atomic conditional unlink POSIX does not have, and two competing stealers
 * could then both enter the critical section and unlink a fresh lease.
 */
function acquireClaim(dir: string, index: number): (() => void) | undefined {
  const path = join(dir, `${index}${SLOT_SUFFIX}${CLAIM_SUFFIX}`);
  const claim = freshStamp();
  if (!publishStamp(dir, path, claim)) return undefined;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readStamp(path).holder;
    if (current && current.nonce === claim.nonce && current.pid === process.pid) {
      rmSync(path, { force: true });
    }
  };
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

  /**
   * Give back one lease: unlink the slot only while it still carries this exact
   * lease stamp, so a reclaimed-and-republished slot is never deleted by its
   * previous owner. Idempotent and never throws. This read-then-unlink is only
   * reached for a live lease of our own process, which no conforming peer ever
   * decides to reclaim, so it does not need the index claim.
   */
  private releaseLease(path: string, stamp: HolderStamp): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        const current = readStamp(path).holder;
        if (current && current.nonce === stamp.nonce && current.pid === process.pid) {
          rmSync(path, { force: true });
        }
      } catch { /* release must never throw */ }
    };
  }

  /**
   * Grab one slot index. Read busy slots without writing scratch files; publish
   * atomically into empty indices. Existing dead slots are reclaimed
   * only under the index's single-winner claim with a recheck of the stamp.
   */
  private trySlot(dir: string, path: string, index: number, owner?: OwnerMetadata): (() => void) | undefined {
    // An abandoned claim also parks an empty index: never publish into a
    // foreign reclaim critical section, even if its lease is already gone.
    if (readStamp(`${path}${CLAIM_SUFFIX}`).present) return undefined;
    const observed = readStamp(path);
    if (!observed.present) {
      const stamp = freshStamp(owner);
      return publishStamp(dir, path, stamp) ? this.releaseLease(path, stamp) : undefined;
    }
    // Live holder, or an unreadable stamp we refuse to guess at: leave it alone.
    if (!holderIsReclaimable(observed.holder)) return undefined;

    const releaseClaim = acquireClaim(dir, index);
    if (!releaseClaim) return undefined; // claim busy or abandoned: fail closed
    try {
      // Recheck under the claim: the stamp read outside it may already have
      // been reclaimed and republished by a peer, and only the exact stale
      // lease we observed - and only we while holding the claim - may go.
      const current = readStamp(path);
      if (current.present) {
        if (!sameHolder(current.holder, observed.holder)) return undefined;
        rmSync(path, { force: true });
      }
      const mine = freshStamp(owner);
      if (!publishStamp(dir, path, mine)) return undefined; // peer published while the path was free
      if (!sameHolder(readStamp(path).holder, mine)) return undefined; // never report a lease we cannot prove
      return this.releaseLease(path, mine);
    } finally {
      releaseClaim();
    }
  }

  /** Best-effort single-slot grab for one bucket. Returns a release or undefined. */
  private tryBucket(bucket: string, cap: number, signal?: AbortSignal, owner?: OwnerMetadata): (() => void) | undefined {
    if (signal?.aborted) return undefined;
    const dir = this.bucketDir(bucket);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < cap; i++) {
      if (signal?.aborted) return undefined;
      const release = this.trySlot(dir, join(dir, `${i}${SLOT_SUFFIX}`), i, owner);
      if (release) return release;
    }
    return undefined;
  }

  /** Read-only, best-effort observation; never mkdir, publish, reclaim or release. */
  inspect(provider: string): MachineCapacitySnapshot {
    const caps = this.caps(provider);
    return {
      provider,
      providerBucket: this.inspectBucket(provider, caps.provider),
      globalBucket: this.inspectBucket("global", caps.global),
    };
  }

  private inspectBucket(bucket: string, cap: number): SlotBucketSnapshot {
    const snapshot: SlotBucketSnapshot = { cap, held: 0, owners: [] };
    const dir = this.bucketDir(bucket);
    try {
      readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot;
      // Inaccessible storage is not evidence of free capacity. Represent every
      // in-cap index as unknown rather than exposing paths or filesystem errors.
      snapshot.held = cap;
      for (let index = 0; index < cap; index++) {
        snapshot.owners.push({ index, kind: "lease", status: "unknown" });
      }
      return snapshot;
    }
    for (let index = 0; index < cap; index++) {
      let blocked = false;
      for (const kind of ["lease", "claim"] as const) {
        const path = join(dir, `${index}${SLOT_SUFFIX}${kind === "claim" ? CLAIM_SUFFIX : ""}`);
        const { present, holder } = readStamp(path);
        if (!present) continue;
        const status = holder ? pidStatus(holder.pid) : "unknown";
        snapshot.owners.push({
          index, kind, status,
          ...(holder ? { pid: holder.pid, born: holder.born, ...holder.owner } : {}),
        });
        // Claims park an index even when dead. Dead leases alone are reclaimable.
        if (kind === "claim" || status !== "dead") blocked = true;
      }
      if (blocked) snapshot.held += 1;
    }
    return snapshot;
  }

  /** Count blocked in-cap indices, including claims and unreadable storage. */
  heldCount(bucket: string, cap: number): number {
    return this.inspectBucket(bucket, cap).held;
  }

  /**
   * Acquire one launch slot for `provider` across all local sessions. Waits
   * (bounded polling) until a provider slot and a global slot are both free.
   * The returned release is idempotent and never throws.
   */
  async acquire(provider: string, signal?: AbortSignal): Promise<() => void>;
  async acquire(provider: string, signal: AbortSignal | undefined, timeoutMs: number, options?: MachineSlotsAcquireOptions): Promise<() => void>;
  async acquire(provider: string, signal?: AbortSignal, timeoutMs = 10 * 60_000, options: MachineSlotsAcquireOptions = {}): Promise<() => void> {
    const owner = validatedOwner(options.owner);
    const observeWait = (snapshot: MachineCapacitySnapshot) => {
      // Diagnostics must not affect lease acquisition or cleanup.
      try { options.onWait?.(snapshot); } catch { /* observer is best-effort */ }
    };
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
        providerRelease = this.tryBucket(provider, providerCap, signal, owner);
        if (providerRelease) {
          const globalRelease = this.tryBucket("global", globalCap, signal, owner);
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
        // Report the first unsuccessful attempt immediately, including a
        // zero-timeout attempt; report every retry, but never a successful grab.
        const snapshot = this.inspect(provider);
        const providerHeld = snapshot.providerBucket.held;
        const globalHeld = snapshot.globalBucket.held;
        observeWait(snapshot);
        if (Date.now() >= deadline || signal?.aborted) break;
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
  async acquire(_provider?: string, _signal?: AbortSignal, _timeoutMs?: number, _options?: MachineSlotsAcquireOptions): Promise<() => void> {
    return () => undefined;
  }
  inspect(provider: string): MachineCapacitySnapshot {
    const cap = Number.MAX_SAFE_INTEGER;
    return {
      provider,
      providerBucket: { cap, held: 0, owners: [] },
      globalBucket: { cap, held: 0, owners: [] },
    };
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

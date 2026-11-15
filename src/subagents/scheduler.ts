import { machineCap, loadCapacityConfig, type CapacityConfig } from "./capacity.ts";

export type SchedulerLease = () => void;

/** Rate-limit refusals closer together than this are one event. */
export const THROTTLE_WINDOW_MS = 5_000;
/** A provider with no rate limit for this long gets its full width back. */
export const THROTTLE_RESET_MS = 10 * 60_000;

interface QueuedAcquire {
  provider: string;
  signal?: AbortSignal;
  resolve: (lease: SchedulerLease) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}

/** Error used when an AbortSignal has no Error-valued reason. */
export function abortError(signal?: AbortSignal, message = "Operation aborted"): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException(message, "AbortError");
}

function bucketCap(config: CapacityConfig, provider: string, globalCeiling: number): number {
  // A provider without its own configured ceiling may use the whole of this scheduler's width.
  return Math.min(config.session.providers[provider] ?? globalCeiling, globalCeiling);
}

/**
 * Provider-bucketed in-process semaphore for worker launches. One module-level
 * instance is shared by every coordinator in a session, so independently
 * started runs share one launch budget. Limits apply per provider: a session
 * may run up to one provider's ceiling and another's simultaneously, bounded
 * by one session-wide global ceiling.
 */
export class SessionScheduler {
  readonly maxConcurrency: number;
  private readonly config: CapacityConfig;
  private activeLeases = 0;
  private readonly activeByBucket = new Map<string, number>();
  private readonly queue: QueuedAcquire[] = [];
  /** Providers currently slowed after a rate limit: provider -> launch width allowed now. */
  private readonly throttled = new Map<string, { limit: number; at: number }>();
  private readonly now: () => number;

  constructor(maxConcurrency = loadCapacityConfig().session.global, config?: CapacityConfig, now: () => number = Date.now) {
    this.now = now;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64) {
      throw new RangeError("maxConcurrency must be an integer from 1 to 64");
    }
    this.maxConcurrency = maxConcurrency;
    this.config = config ?? loadCapacityConfig();
  }

  get activeCount(): number {
    return this.activeLeases;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  activeFor(provider: string): number {
    return this.activeByBucket.get(provider) ?? 0;
  }

  /** Configured ceiling for a provider in this session. */
  capFor(provider: string): number {
    return bucketCap(this.config, provider, this.maxConcurrency);
  }

  /** Width a provider may run right now: its ceiling, or less while it is being throttled. */
  limitFor(provider: string): number {
    const slowed = this.throttled.get(provider);
    if (slowed && this.now() - slowed.at >= THROTTLE_RESET_MS) this.throttled.delete(provider);
    return Math.min(this.capFor(provider), this.throttled.get(provider)?.limit ?? Infinity);
  }

  /**
   * A provider rate-limited a worker: halve the width this session gives it.
   * Workers already running are left alone; fewer new ones start. One burst of
   * refusals counts once (`THROTTLE_WINDOW_MS`), so a wave that is throttled
   * together does not collapse to a single worker.
   */
  throttle(provider: string): void {
    const now = this.now();
    const prior = this.throttled.get(provider);
    if (prior && now - prior.at < THROTTLE_WINDOW_MS) return;
    const running = Math.max(1, this.activeFor(provider));
    const limit = Math.max(1, Math.floor(Math.min(this.limitFor(provider), running) / 2));
    this.throttled.set(provider, { limit, at: now });
  }

  /** A worker on this provider finished cleanly: give one launch slot back, up to the ceiling. */
  recover(provider: string): void {
    const prior = this.throttled.get(provider);
    if (!prior) return;
    if (prior.limit + 1 >= this.capFor(provider)) this.throttled.delete(provider);
    else this.throttled.set(provider, { limit: prior.limit + 1, at: prior.at });
    this.drain();
  }

  /** Acquire one launch slot, optionally scoped to a provider bucket. */
  acquire(signal?: AbortSignal, provider = "default"): Promise<SchedulerLease> {
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise<SchedulerLease>((resolve, reject) => {
      const entry: QueuedAcquire = { provider, signal, resolve, reject };
      if (signal) {
        entry.onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(abortError(signal));
          this.drain();
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queue.push(entry);
      this.drain();
    });
  }

  /**
   * Acquire a slot and invoke launch only if the signal is still live. This
   * closes the race where cancellation happens after acquisition resolves but
   * before caller code runs.
   */
  async run<T>(
    launch: () => T | PromiseLike<T>,
    signal?: AbortSignal,
    provider = "default",
  ): Promise<T> {
    const release = await this.acquire(signal, provider);
    try {
      if (signal?.aborted) throw abortError(signal);
      return await launch();
    } finally {
      release();
    }
  }

  private hasRoom(entry: QueuedAcquire): boolean {
    if (this.activeLeases >= this.maxConcurrency) return false;
    return (this.activeByBucket.get(entry.provider) ?? 0) < this.limitFor(entry.provider);
  }

  private drain(): void {
    // Scan the whole queue: one provider's full bucket must not head-of-line
    // block another provider's entry behind it.
    for (let index = 0; index < this.queue.length; ) {
      const entry = this.queue[index];
      if (entry.signal?.aborted) {
        this.queue.splice(index, 1);
        if (entry.onAbort) entry.signal!.removeEventListener("abort", entry.onAbort);
        entry.reject(abortError(entry.signal));
        continue;
      }
      if (!this.hasRoom(entry)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      if (entry.onAbort) entry.signal!.removeEventListener("abort", entry.onAbort);
      this.activeLeases += 1;
      this.activeByBucket.set(entry.provider, (this.activeByBucket.get(entry.provider) ?? 0) + 1);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.activeLeases -= 1;
        const current = this.activeByBucket.get(entry.provider) ?? 1;
        if (current <= 1) this.activeByBucket.delete(entry.provider);
        else this.activeByBucket.set(entry.provider, current - 1);
        this.drain();
      });
    }
  }
}

function defaultSessionScheduler(): SessionScheduler {
  const config = loadCapacityConfig();
  return new SessionScheduler(config.session.global, config);
}

/** The process/session-wide worker pool shared by default by every coordinator. */
export const sessionScheduler = defaultSessionScheduler();

// Short aliases keep callers and tests readable without creating another pool.
export { SessionScheduler as Scheduler };
export const globalScheduler = sessionScheduler;
export { machineCap };

import { machineCap, loadCapacityConfig, sessionCap, type CapacityConfig } from "./capacity.ts";
import { MAX_CONCURRENCY } from "./types.ts";

export type SchedulerLease = () => void;

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
  return Math.min(sessionCap(config, provider), globalCeiling);
}

/**
 * Provider-bucketed in-process semaphore for worker launches. One module-level
 * instance is shared by every coordinator in a session, so independently
 * started runs share one launch budget. Limits apply per provider: a session
 * may run up to its GLM ceiling and its Luna ceiling simultaneously, bounded
 * by one session-wide global ceiling.
 */
export class SessionScheduler {
  readonly maxConcurrency: number;
  private readonly config: CapacityConfig;
  private activeLeases = 0;
  private readonly activeByBucket = new Map<string, number>();
  private readonly queue: QueuedAcquire[] = [];

  constructor(maxConcurrency = loadCapacityConfig().session.global, config?: CapacityConfig) {
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

  capFor(provider: string): number {
    return bucketCap(this.config, provider, this.maxConcurrency);
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
    const cap = bucketCap(this.config, entry.provider, this.maxConcurrency);
    return (this.activeByBucket.get(entry.provider) ?? 0) < cap;
  }

  private drain(): void {
    // Scan the whole queue: a full GLM bucket must not head-of-line block a
    // Luna entry behind it.
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

/** Ceiling used by the default bucket for providers without an explicit cap. */
export const DEFAULT_BUCKET_CEILING = Math.min(MAX_CONCURRENCY, sessionScheduler.maxConcurrency);

// Short aliases keep callers and tests readable without creating another pool.
export { SessionScheduler as Scheduler };
export const globalScheduler = sessionScheduler;
export { machineCap };

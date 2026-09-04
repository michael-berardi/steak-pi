import { MAX_CONCURRENCY } from "./types.ts";

export type SchedulerLease = () => void;

interface QueuedAcquire {
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

/**
 * A FIFO semaphore for worker launches. A single module-level instance is used
 * by coordinators so independently-started runs still share the same budget.
 */
export class SessionScheduler {
  readonly maxConcurrency: number;
  private activeLeases = 0;
  private readonly queue: QueuedAcquire[] = [];

  constructor(maxConcurrency = MAX_CONCURRENCY) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY) {
      throw new RangeError(`maxConcurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
    }
    this.maxConcurrency = maxConcurrency;
  }

  get activeCount(): number {
    return this.activeLeases;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** Acquire one launch slot. The returned release function is idempotent. */
  acquire(signal?: AbortSignal): Promise<SchedulerLease> {
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise<SchedulerLease>((resolve, reject) => {
      const entry: QueuedAcquire = { signal, resolve, reject };
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
  async run<T>(launch: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      if (signal?.aborted) throw abortError(signal);
      return await launch();
    } finally {
      release();
    }
  }

  private drain(): void {
    while (this.activeLeases < this.maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.onAbort) entry.signal!.removeEventListener("abort", entry.onAbort);
      if (entry.signal?.aborted) {
        entry.reject(abortError(entry.signal));
        continue;
      }

      this.activeLeases += 1;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.activeLeases -= 1;
        this.drain();
      });
    }
  }
}

/** The process/session-wide worker pool shared by default by every coordinator. */
export const sessionScheduler = new SessionScheduler(MAX_CONCURRENCY);

// Short aliases keep callers and tests readable without creating another pool.
export { SessionScheduler as Scheduler };
export const globalScheduler = sessionScheduler;

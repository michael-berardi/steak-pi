/**
 * A local wait failure. `kind: "idle"` is a silent model or connection, which Steak Pi may recover by asking again (only
 * while nothing was shown and the reply was not complete); every other kind is terminal.
 */
export class ClaudeWaitLimitError extends Error {
  override name = "ClaudeWaitLimitError";
  /** "idle": the model or connection went silent mid-turn, which a fresh attempt can fix. Anything else is a local wait. */
  kind?: "idle";
  /** What the silence looked like, filled in where it is known. */
  silentMs?: number;
  stage?: string;
  lastEvent?: string;
  childAlive?: boolean;
  bytesReceived?: number;
  recoveries?: number;
  /** The request body stopped moving mid-upload. Never resent: that would only restart the upload. */
  uploadStalled?: boolean;
  /** The API had already sent the whole reply (message_stop) when the silence hit: asking again would pay for it twice. */
  replyComplete?: boolean;

  constructor(message: string, details: { kind?: "idle"; silentMs?: number; stage?: string } = {}) {
    super(message);
    this.kind = details.kind;
    this.silentMs = details.silentMs;
    this.stage = details.stage;
  }
}

/** A transport deadline must be finite: zero/Infinity must never disable it. */
export function transportTimeout(value: number | undefined, fallback = 180_000): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("Claude Code timeout must be a positive finite number of milliseconds (at most 2147483647)");
  }
  return value;
}

/** Stop waiting even if a child/pipe never emits its expected terminal event. */
export function waitForOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
  onStop?: () => void,
  kind?: "idle",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T, stopped = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (stopped) {
        try { onStop?.(); }
        catch (cause) {
          reject(new Error(`${label} cleanup failed after ${String(error)}`, { cause }));
          return;
        }
      }
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(signal?.reason ?? new Error("Claude Code request aborted"), undefined, true);
    const timer = setTimeout(() => finish(new ClaudeWaitLimitError(`${label} exceeded its wait limit`, { kind, silentMs: timeoutMs, stage: label }), undefined, true), timeoutMs);
    operation.then((value) => finish(undefined, value), (error) => finish(error));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

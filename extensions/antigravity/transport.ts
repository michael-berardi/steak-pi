// One HTTP POST with the same wait rules as the Claude Code relay: the first-byte limit counts from the last sign of
// upload progress (never from the start of the upload), a body that stops moving is a named terminal failure that is not
// sent again, and a response that goes quiet is cut at the stream idle limit with the silence stated.
import http from "node:http";
import https from "node:https";
import { formatSilence } from "../claude-code/idle-policy.ts";
import { AntigravityError } from "./errors.ts";

const UPLOAD_SLICE = 64 * 1024;
const UPLOAD_WINDOW = 256 * 1024;

export interface WaitLimits { firstByteMs: number; streamIdleMs: number }

export interface PostOptions {
  headers: Record<string, string>;
  signal?: AbortSignal;
  limits: WaitLimits;
  /** What the request is, for error text: "model list", "stream". */
  label: string;
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The body, chunk by chunk. Throws an `idle` AntigravityError when it goes quiet for the idle limit. */
  chunks(): AsyncGenerator<Buffer>;
  /** The whole body as text (bounded by the same idle limit). */
  text(): Promise<string>;
  destroy(): void;
}

const megabytes = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;

export function post(url: string, body: Buffer, options: PostOptions): Promise<Reply> {
  const { limits, label, signal } = options;
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  return new Promise<Reply>((resolve, reject) => {
    const request = client.request(target, { method: "POST", headers: { ...options.headers, "Content-Length": String(body.length) } });
    const total = body.length;
    let finished = false;
    let flushed = 0;
    let sent = 0;
    let lastProgress = Date.now();
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (error: unknown) => done(() => { request.destroy(); reject(error); });
    const onAbort = () => fail(signal?.reason ?? new Error("Antigravity request aborted"));
    const note = () => {
      const now = finished ? total : flushed;
      if (now > sent) { sent = now; lastProgress = Date.now(); }
    };
    const poll = setInterval(() => {
      note();
      if (Date.now() - lastProgress < limits.firstByteMs) return;
      if (finished) {
        fail(new AntigravityError("idle", `Antigravity ${label}: no response for ${formatSilence(limits.firstByteMs)} after the request was sent; the connection or the model went silent. Try again.`));
      } else {
        fail(new AntigravityError("upload-stalled", `Antigravity ${label}: request upload stalled at ${megabytes(sent)} of ${megabytes(total)} (no progress for ${formatSilence(limits.firstByteMs)}); not sent again, because that would only restart the upload`));
      }
    }, Math.max(5, Math.min(250, Math.floor(limits.firstByteMs / 10))));
    poll.unref?.();
    request.once("finish", () => { finished = true; note(); });
    request.once("error", (error) => fail(error));
    request.once("response", (response) => done(() => resolve(wrap(response, request, limits, label, signal))));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    let next = 0;
    let ended = false;
    const pump = () => {
      while (next < total && next - flushed < UPLOAD_WINDOW && !request.destroyed) {
        const slice = body.subarray(next, Math.min(total, next + UPLOAD_SLICE));
        next += slice.length;
        request.write(slice, (error) => { if (error) return; flushed += slice.length; pump(); });
      }
      if (next >= total && !ended) { ended = true; request.end(); }
    };
    pump();
  });
}

function wrap(response: http.IncomingMessage, request: http.ClientRequest, limits: WaitLimits, label: string, signal?: AbortSignal): Reply {
  async function* chunks(): AsyncGenerator<Buffer> {
    const iterator = response[Symbol.asyncIterator]();
    let received = 0;
    let onAbort: (() => void) | undefined;
    // Cancelling must end a read that is waiting on a quiet connection, not only the wait before the first byte.
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason ?? new Error("Antigravity request aborted"));
      if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    });
    cancelled.catch(() => {});
    try {
      for (;;) {
        let timer: NodeJS.Timeout | undefined;
        const quiet = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AntigravityError("idle", `Antigravity ${label}: stream idle for ${formatSilence(limits.streamIdleMs)} (${received} bytes received); the connection or the model went silent`)), limits.streamIdleMs);
        });
        let step: IteratorResult<unknown>;
        try { step = await Promise.race([iterator.next(), quiet, cancelled]); }
        finally { clearTimeout(timer); }
        if (step.done) return;
        const chunk = Buffer.isBuffer(step.value) ? step.value : Buffer.from(step.value as string);
        received += chunk.length;
        yield chunk;
      }
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      response.destroy();
      request.destroy();
    }
  }
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    chunks,
    async text() {
      const parts: Buffer[] = [];
      for await (const chunk of chunks()) parts.push(chunk);
      return Buffer.concat(parts).toString("utf8");
    },
    destroy() { response.destroy(); request.destroy(); },
  };
}

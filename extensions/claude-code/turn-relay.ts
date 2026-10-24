import * as http from "node:http";
import * as https from "node:https";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { AnthropicStreamEvent, NativeContentBlock, NativeMessage } from "./native-types.ts";

import { ClaudeWaitLimitError, transportTimeout, waitForOperation } from "./wait.ts";

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class AnthropicCapture {
  message?: NativeMessage;
  complete = false;
  /** Error reported inside an otherwise successful (HTTP 200) event stream. */
  error?: string;
  private pending = "";
  private readonly decoder = new TextDecoder();
  private readonly argumentsByIndex = new Map<number, string>();

  constructor(private readonly onEvent?: (event: AnthropicStreamEvent) => void) {}

  feed(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.consumeFrames();
  }

  finish(): void {
    this.pending += this.decoder.decode();
    this.consumeFrames();
  }

  private consumeFrames(): void {
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(this.pending);
      if (!match) return;
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as AnthropicStreamEvent;
      this.apply(event);
      this.onEvent?.(event);
    }
  }

  private apply(event: AnthropicStreamEvent): void {
    switch (event.type) {
      case "message_start":
        this.message = copy(event.message);
        break;
      case "content_block_start":
        if (this.message) this.message.content[event.index] = copy(event.content_block);
        break;
      case "content_block_delta": {
        const block = this.message?.content[event.index];
        if (!block) break;
        const delta = event.delta;
        if (delta.type === "text_delta" && block.type === "text") block.text += delta.text;
        else if (delta.type === "thinking_delta" && block.type === "thinking") block.thinking += delta.thinking;
        else if (delta.type === "signature_delta" && block.type === "thinking") {
          block.signature = (block.signature ?? "") + delta.signature;
        } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
          this.argumentsByIndex.set(event.index, (this.argumentsByIndex.get(event.index) ?? "") + delta.partial_json);
        }
        break;
      }
      case "content_block_stop": {
        const block = this.message?.content[event.index];
        if (block?.type === "tool_use" && this.argumentsByIndex.has(event.index)) {
          const raw = this.argumentsByIndex.get(event.index) ?? "";
          block.input = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
          this.argumentsByIndex.delete(event.index);
        }
        break;
      }
      case "message_delta":
        if (this.message) {
          Object.assign(this.message, event.delta);
          if (event.usage) this.message.usage = { ...this.message.usage, ...event.usage } as NativeMessage["usage"];
        }
        break;
      case "message_stop":
        this.complete = !!this.message?.stop_reason && this.argumentsByIndex.size === 0;
        break;
      case "error": {
        const { type, message } = event.error ?? {};
        this.error = [type, message].filter(Boolean).join(": ") || "unknown stream error";
        break;
      }
    }
  }
}

interface Destroyable {
  destroy(error?: Error): void;
}

const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
]);

const STRIPPED_RESPONSE_HEADERS = new Set(["connection", "transfer-encoding", "server", "date"]);

export interface RetryPolicy {
  /** Total upstream attempts per turn, including the first. */
  attempts: number;
  baseDelayMs: number;
}

const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 400 };
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504, 529]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_SOCKET", "ERR_STREAM_PREMATURE_CLOSE",
]);

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as NodeJS.ErrnoException).code;
  return `${error.name}: ${error.message}${code ? ` [${code}]` : ""}`;
}

/** Socket-level failures only: aborts, bad requests and programming errors are not retried. */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (code !== undefined && TRANSIENT_CODES.has(code)) || /socket hang up|aborted/iu.test(error.message) && code !== "ABORT_ERR";
}

export class TurnRelay {
  capture: AnthropicCapture;
  used = false;
  denied = 0;
  status?: number;
  requestId?: string;
  failure?: string;
  failureDetail?: string;
  waitFailure?: ClaudeWaitLimitError;
  stage = "start";
  attempts = 0;
  retries = 0;
  lastRetry?: string;
  errorBody = Buffer.alloc(0);
  originalRequestBody?: Buffer;
  requestBody?: Buffer;

  private readonly upstream: URL;
  private readonly prefix = `/turn/${randomBytes(32).toString("base64url")}`;
  private readonly server: http.Server;
  private readonly sockets = new Set<Destroyable>();
  private readonly active = new Set<Promise<void>>();
  private controller = new AbortController();
  private cancelled = false;
  private closed = false;
  private baseUrl?: string;
  private transformRequest?: (body: Buffer) => Buffer;
  private requestBetas: string[] = [];
  private onActivity?: () => void;

  constructor(
    upstream = "https://api.anthropic.com",
    private readonly timeoutMs = 180_000,
    onEvent?: (event: AnthropicStreamEvent) => void,
    transformRequest?: (body: Buffer) => Buffer,
    requestBetas: string[] = [],
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
  ) {
    transportTimeout(timeoutMs);
    this.upstream = new URL(upstream);
    const loopback = ["127.0.0.1", "::1", "localhost"].includes(this.upstream.hostname);
    if (
      (this.upstream.protocol !== "https:" && !(this.upstream.protocol === "http:" && loopback)) ||
      this.upstream.username ||
      this.upstream.password ||
      this.upstream.search ||
      this.upstream.hash
    ) {
      throw new Error("Claude Code upstream must be HTTPS or a loopback HTTP fixture");
    }
    this.capture = new AnthropicCapture(onEvent);
    this.transformRequest = transformRequest;
    this.requestBetas = requestBetas;
    this.server = http.createServer((request, response) => {
      const operation = this.handle(request, response).finally(() => this.active.delete(operation));
      this.active.add(operation);
    });
  }

  /** Arm the persistent relay for one new Claude turn. */
  beginTurn(
    onEvent?: (event: AnthropicStreamEvent) => void,
    transformRequest?: (body: Buffer) => Buffer,
    requestBetas: string[] = [],
    onActivity?: () => void,
  ): void {
    if (this.closed) throw new Error("Claude Code turn relay is closed");
    if (this.active.size > 0) throw new Error("Claude Code turn relay still has an active request");
    this.controller = new AbortController();
    this.onActivity = onActivity;
    this.capture = new AnthropicCapture(onEvent);
    this.used = false;
    this.denied = 0;
    this.status = undefined;
    this.requestId = undefined;
    this.failure = undefined;
    this.failureDetail = undefined;
    this.waitFailure = undefined;
    this.attempts = 0;
    this.retries = 0;
    this.lastRetry = undefined;
    this.errorBody = Buffer.alloc(0);
    this.originalRequestBody = undefined;
    this.requestBody = undefined;
    this.transformRequest = transformRequest;
    this.requestBetas = requestBetas;
    this.cancelled = false;
  }

  /** Disarm the current turn without closing the worker-scoped HTTP server. */
  finishTurn(reason = new Error("Claude Code request aborted")): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort(reason);
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server.closeAllConnections?.();
  }

  async start(signal?: AbortSignal): Promise<string> {
    const launch = new AbortController();
    let onError: (error: Error) => void;
    try {
      await waitForOperation(new Promise<void>((resolve, reject) => {
        onError = reject;
        this.server.once("error", onError);
        this.server.listen({ port: 0, host: "127.0.0.1", signal: launch.signal }, resolve);
      }), this.timeoutMs, "Claude Code turn relay start", signal, () => launch.abort());
    } finally {
      this.server.off("error", onError!);
    }
    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}${this.prefix}`;
    return this.baseUrl;
  }

  errorText(): string {
    if (this.capture.error) return this.capture.error;
    const text = this.errorBody.toString("utf8");
    try {
      const payload = JSON.parse(text) as { error?: { message?: unknown } };
      return typeof payload.error?.message === "string" ? payload.error.message : text;
    } catch {
      return text;
    }
  }

  abort(): void {
    this.finishTurn();
  }

  async settled(): Promise<void> {
    await waitForOperation(Promise.allSettled([...this.active]), this.timeoutMs, "Claude Code turn relay settlement", undefined, () => this.abort());
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort();
    await waitForOperation(new Promise<void>((resolve) => {
      if (!this.server.listening) return resolve();
      this.server.close(() => resolve());
    }), 2_000, "Claude Code turn relay close", undefined, () => this.server.closeAllConnections());
    await this.settled();
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "POST" || requestUrl.pathname !== `${this.prefix}/v1/messages` || request.headers.origin) {
      response.writeHead(404).end();
      return;
    }

    if (this.cancelled || this.used) {
      this.denied += 1;
      const body = Buffer.from(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "PI_CLAUDE_CODE_TURN_RELAY_CONSUMED" },
        }),
      );
      response.writeHead(400, { "content-type": "application/json", "content-length": body.length }).end(body);
      return;
    }
    this.used = true;
    this.sockets.add(request);
    this.sockets.add(response);

    let upstreamRequest: http.ClientRequest | undefined;
    // Each non-streaming wait is wall-bounded; each streaming read is idle-bounded.
    // Never put a wall-clock cap on a healthy, continuously streaming response.
    const signal = this.controller.signal;
    try {
      this.stage = "read-body";
      let body = await waitForOperation(this.readBody(request), this.timeoutMs, "Claude Code relay request body", signal);
      this.stage = "upstream-request";
      this.originalRequestBody = Buffer.from(body);
      if (this.transformRequest) body = this.transformRequest(body);
      this.requestBody = Buffer.from(body);
      if (this.cancelled) return;

      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (!STRIPPED_REQUEST_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      headers["accept-encoding"] = "identity";
      headers["content-length"] = body.length;
      if (this.requestBetas.length > 0) {
        const existing = Array.isArray(headers["anthropic-beta"])
          ? headers["anthropic-beta"].join(",")
          : String(headers["anthropic-beta"] ?? "");
        headers["anthropic-beta"] = [
          ...new Set([
            ...existing.split(",").map((value) => value.trim()).filter(Boolean),
            ...this.requestBetas,
          ]),
        ].join(",");
      }

      const pathPrefix = this.upstream.pathname.replace(/\/$/u, "");
      const transport = this.upstream.protocol === "https:" ? https : http;
      const responseHeaders: http.OutgoingHttpHeaders = {};
      let upstreamResponse: http.IncomingMessage | undefined;
      let iterator: AsyncIterator<unknown> | undefined;
      let pending: Buffer[] = [];

      // Claude Code cannot replay a turn, so a transient failure is retried here, but only
      // while nothing has reached it yet: connection errors, retryable statuses and a stream
      // that dies before its first byte. Anything after the first byte, 4xx and billing
      // errors surface as they are, with the real cause.
      for (let attempt = 1; ; attempt += 1) {
        signal.throwIfAborted();
        this.attempts = attempt;
        // A new bounded attempt gets its own idle budget, including after
        // backoff when Claude Code has not emitted any stdout of its own.
        this.onActivity?.();
        const retryable = attempt < this.retry.attempts && !this.cancelled;
        this.stage = "upstream-request";
        upstreamRequest = transport.request({
          protocol: this.upstream.protocol,
          hostname: this.upstream.hostname,
          port: this.upstream.port || undefined,
          method: "POST",
          path: `${pathPrefix}/v1/messages${requestUrl.search}`,
          headers,
        });
        this.sockets.add(upstreamRequest);
        const current = upstreamRequest;
        try {
          upstreamResponse = await waitForOperation(new Promise<http.IncomingMessage>((resolve, reject) => {
            current.once("response", resolve);
            current.once("error", reject);
            current.end(body);
          }), this.timeoutMs, "Claude Code upstream response headers", signal);
        } catch (error) {
          this.sockets.delete(current);
          current.destroy();
          if (!retryable || !isTransientNetworkError(error)) throw error;
          this.noteRetry(`connection: ${describeError(error)}`);
          await this.backoff(attempt);
          continue;
        }
        this.stage = "streaming";
        this.onActivity?.();
        this.sockets.add(upstreamResponse);
        this.status = upstreamResponse.statusCode;
        if (retryable && this.status !== undefined && RETRYABLE_STATUSES.has(this.status)) {
          this.noteRetry(`upstream status ${this.status}`);
          upstreamResponse.resume();
          this.sockets.delete(upstreamResponse);
          this.sockets.delete(current);
          current.destroy();
          await this.backoff(attempt);
          continue;
        }
        this.requestId =
          String(upstreamResponse.headers["request-id"] ?? upstreamResponse.headers["x-request-id"] ?? "") || undefined;
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (!STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase()) && value !== undefined) responseHeaders[name] = value;
        }
        responseHeaders.connection = "close";

        // Read the first chunk before committing headers to Claude Code.
        const source = upstreamResponse[Symbol.asyncIterator]();
        try {
          const first = await waitForOperation(source.next(), this.timeoutMs, "Claude Code upstream first byte", signal);
          if (!first.done) pending = [Buffer.isBuffer(first.value) ? first.value : Buffer.from(first.value)];
        } catch (error) {
          this.sockets.delete(upstreamResponse);
          this.sockets.delete(current);
          current.destroy();
          if (!retryable || !isTransientNetworkError(error)) throw error;
          this.noteRetry(`stream before first byte: ${describeError(error)}`);
          await this.backoff(attempt);
          continue;
        }
        iterator = source;
        break;
      }

      response.writeHead(upstreamResponse!.statusCode ?? 502, responseHeaders);
      const forward = async (rawChunk: unknown) => {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
        this.onActivity?.();
        if (this.status === 200) this.capture.feed(chunk);
        else if (this.errorBody.length < 65_536) {
          this.errorBody = Buffer.concat([this.errorBody, chunk]).subarray(0, 65_536);
        }
        if (!response.write(chunk)) { this.stage = "drain"; await this.waitForDrain(response); this.stage = "streaming"; }
      };
      for (const chunk of pending) await forward(chunk);
      for (;;) {
        const next = await waitForOperation(iterator!.next(), this.timeoutMs, "Claude Code upstream stream idle", signal);
        if (next.done) break;
        await forward(next.value);
      }
      this.stage = "finish";
      if (this.status === 200) this.capture.finish();
      response.end();
    } catch (error) {
      if (error instanceof ClaudeWaitLimitError) this.waitFailure = error;
      this.failure = error instanceof Error ? error.name : "UnknownError";
      this.failureDetail = `${describeError(error)} (stage ${this.stage}, attempt ${this.attempts} of ${this.retry.attempts}${this.lastRetry ? `, last retry: ${this.lastRetry}` : ""})`;
      if (!response.headersSent) response.writeHead(this.cancelled ? 499 : 502).end();
      else response.destroy();
    } finally {
      if (upstreamRequest) this.sockets.delete(upstreamRequest);
      this.sockets.delete(request);
      this.sockets.delete(response);
      upstreamRequest?.destroy();
    }
  }

  private noteRetry(cause: string): void {
    this.onActivity?.();
    this.retries += 1;
    this.lastRetry = cause;
  }

  private backoff(attempt: number): Promise<void> {
    const delay = this.retry.baseDelayMs * 2 ** (attempt - 1);
    let timer: NodeJS.Timeout;
    return waitForOperation(new Promise<void>((resolve) => { timer = setTimeout(resolve, delay); }), this.timeoutMs, "Claude Code retry backoff", this.controller.signal, () => clearTimeout(timer));
  }

  private async waitForDrain(response: http.ServerResponse): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", onAbort);
        response.off("drain", onDrain);
        response.off("close", onClose);
        response.off("error", onError);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Claude Code disconnected from the turn relay"));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        reject(this.controller.signal.reason);
      };
      const timer = setTimeout(() => onError(new ClaudeWaitLimitError("Claude Code turn relay drain exceeded its wait limit")), this.timeoutMs);
      response.once("drain", onDrain);
      response.once("close", onClose);
      response.once("error", onError);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (this.controller.signal.aborted) onAbort();
      else if (response.destroyed || response.writableEnded) onClose();
    });
  }

  private async readBody(request: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const rawChunk of request) chunks.push(Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk));
    return Buffer.concat(chunks);
  }
}

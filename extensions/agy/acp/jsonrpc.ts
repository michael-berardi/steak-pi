// Newline-delimited JSON-RPC 2.0 over agy acp's stdio (ACP v1 framing). Own implementation; no third-party ACP runtime.
import type { Readable, Writable } from "node:stream";

export interface RpcErrorObject { code: number; message: string; data?: unknown }

export class AcpRpcError extends Error {
  override name = "AcpRpcError";
  constructor(readonly method: string, readonly rpc: RpcErrorObject) {
    super(`${method}: ${rpc.message} (code ${rpc.code})`);
  }
}

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void }

export interface AcpPeer {
  request<T = unknown>(method: string, params: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
  notify(method: string, params: unknown): void;
  log: (direction: "in" | "out", message: string) => void;
  close(cause?: Error): void;
}

/** One JSON-RPC peer. Requests initiated by the agent are answered by `onRequest`; notifications by `onNotification`. */
export function createJsonRpcPeer(options: {
  input: Readable;
  output: Writable;
  onRequest?: (method: string, params: unknown, id: number | string) => Promise<unknown> | unknown;
  onNotification?: (method: string, params: unknown) => void;
  onClose?: (error: Error) => void;
  maxLineBytes?: number;
}): AcpPeer {
  const pending = new Map<number | string, Pending>();
  const maxLine = options.maxLineBytes ?? 8_000_000;
  let nextId = 1, buffer = "", closed: Error | undefined;
  const input = options.input;
  const output = options.output;
  input.setEncoding("utf8");

  const write = (message: unknown) => {
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  };
  const close = (cause = new Error("ACP transport closed")) => {
    if (closed) return;
    closed = cause;
    for (const [id, request] of pending) {
      pending.delete(id);
      request.reject(new Error(`ACP request ${id}: ${cause.message}`));
    }
    options.onClose?.(cause);
  };
  const line = (text: string) => {
    let message: any;
    try { message = JSON.parse(text); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.id !== undefined && (message.method === undefined || message.method === null)) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new AcpRpcError(String(message.method ?? "response"), message.error as RpcErrorObject));
      else request.resolve(message.result);
      return;
    }
    if (message.method === undefined) return;
    if (message.id === undefined) {
      options.onNotification?.(String(message.method), message.params);
      return;
    }
    void Promise.resolve()
      .then(() => options.onRequest?.(String(message.method), message.params, message.id))
      .then((result) => write({ jsonrpc: "2.0", id: message.id, result: result ?? null }), (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text.slice(0, 500) } });
      });
  };
  input.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > maxLine * 2) { close(new Error("ACP stream line exceeded its size limit")); return; }
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const text = buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
      if (text.trim()) line(text);
    }
  });
  input.on("end", () => close(new Error("ACP stream ended")));
  input.on("error", (error) => close(error));
  output.on("error", (error) => close(error));

  return {
    log: (_direction, _message) => { /* the session owns bounded diagnostics */ },
    request<T>(method: string, params: unknown, requestOptions: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
      if (closed) return Promise.reject(new Error(`${method}: ${closed.message}`));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        let timer: NodeJS.Timeout | undefined;
        const settle = (fn: () => void) => { if (timer) clearTimeout(timer); requestOptions.signal?.removeEventListener("abort", onAbort); pending.delete(id); fn(); };
        const onAbort = () => settle(() => reject(new Error(`${method}: cancelled by Pi`)));
        pending.set(id, { resolve: (value) => settle(() => resolve(value as T)), reject: (error) => settle(() => reject(error)) });
        timer = setTimeout(() => settle(() => reject(new Error(`${method}: no ACP response within ${requestOptions.timeoutMs}ms`))), requestOptions.timeoutMs ?? 120_000);
        timer.unref();
        if (requestOptions.signal?.aborted) { onAbort(); return; }
        requestOptions.signal?.addEventListener("abort", onAbort, { once: true });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method: string, params: unknown) { write({ jsonrpc: "2.0", method, params }); },
    close,
  };
}

// Loopback MCP bridge: advertises Pi's transcript tool declarations to agy and parks every tools/call as a Streamable
// HTTP SSE response until Pi has run that call through its own agent loop. Headers and keepalive comments leave
// immediately; the reference runtime notes a 60 s client timeout when headers never arrive.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface BridgeTool { name: string; description: string; parameters?: Record<string, unknown> }
export interface BridgeContent { type: "text" | "image"; text?: string; data?: string; mimeType?: string }
export interface BridgeToolResult { content: BridgeContent[]; details?: unknown; isError?: boolean }
export interface BridgeCallRequest {
  /** Also the id of the Pi toolCall block that Pi will execute. */
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Aborts when agy closes the parked HTTP request. */
  signal: AbortSignal;
}
export interface BridgeToolSource {
  list(): BridgeTool[] | Promise<BridgeTool[]>;
  call(request: BridgeCallRequest): Promise<BridgeToolResult>;
}
export interface McpBridgeOptions { keepAliveMs?: number }
export interface McpBridge {
  url: string;
  token: string;
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

const PREFIX = "pi_";
const MAX_BODY = 1_048_576;
const KEEPALIVE_MS = 15_000;

/** Fixed-length digests make the comparison independent of token length (no early exit on a mismatch). */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
}

function sse(res: ServerResponse, body: unknown): void {
  if (!res.writableEnded && !res.destroyed) res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > MAX_BODY) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startMcpBridge(source: BridgeToolSource, options: McpBridgeOptions = {}): Promise<McpBridge> {
  const token = randomBytes(32).toString("base64url"); // 256 bits, new for every session, never logged
  const keepAliveMs = options.keepAliveMs ?? KEEPALIVE_MS;
  const open = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    let requestId: number | string = 0;
    void (async () => {
      try {
        if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
        if ((req.url ?? "").split("?")[0] !== "/mcp") { res.writeHead(404).end(); return; }
        const header = req.headers.authorization ?? "";
        const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
        if (!constantTimeEqual(provided, token)) {
          res.writeHead(401, { "www-authenticate": "Bearer" }).end();
          return;
        }
        let request: any;
        try { request = JSON.parse(await readBody(req)); } catch { json(res, 400, { error: "invalid JSON" }); return; }
        if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") { json(res, 400, { error: "invalid JSON-RPC" }); return; }
        requestId = request.id ?? 0;
        if (request.id === undefined) { res.writeHead(202).end(); return; }
        let result: unknown;
        switch (request.method) {
          case "initialize":
            result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "steak-pi-tools", version: "1.0.0" } };
            break;
          case "ping":
            result = {};
            break;
          case "tools/list": {
            const tools = await source.list();
            result = { tools: tools.map((tool) => ({ name: `${PREFIX}${tool.name}`, description: tool.description, inputSchema: tool.parameters ?? { type: "object" } })) };
            break;
          }
          case "tools/call": {
            const name = String(request.params?.name ?? "");
            if (!name.startsWith(PREFIX)) { json(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "unknown tool" } }); return; }
            const real = name.slice(PREFIX.length);
            const allowed = await source.list();
            if (!allowed.some((tool) => tool.name === real)) { json(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: `unknown tool ${name}` } }); return; }
            const args = (request.params?.arguments && typeof request.params.arguments === "object") ? request.params.arguments as Record<string, unknown> : {};
            const controller = new AbortController();
            const progressToken = request.params?._meta?.progressToken;
            let parked: Promise<BridgeToolResult>;
            try {
              parked = source.call({ id: randomUUID(), name: real, arguments: args, signal: controller.signal });
            } catch (error) {
              json(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: messageOf(error) } });
              return;
            }
            // SSE, not a buffered JSON response: headers now, keepalives while parked, result when Pi is done.
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
            res.flushHeaders();
            open.add(res);
            let ticks = 0;
            const keepAlive = setInterval(() => {
              if (res.writableEnded || res.destroyed) return;
              ticks++;
              try {
                res.write(": keepalive\n\n");
                if (typeof progressToken === "string" || typeof progressToken === "number") {
                  sse(res, { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: ticks, message: "Pi is running the tool" } });
                }
              } catch { clearInterval(keepAlive); }
            }, keepAliveMs);
            const onClose = () => { clearInterval(keepAlive); if (!controller.signal.aborted) controller.abort(); };
            res.once("close", onClose);
            void parked.then(
              (outcome) => sse(res, { jsonrpc: "2.0", id: request.id, result: {
                content: outcome.content.map((part) => part.type === "image"
                  ? { type: "image", data: part.data ?? "", mimeType: part.mimeType ?? "application/octet-stream" }
                  : { type: "text", text: part.text ?? "" }),
                ...(outcome.isError ? { isError: true } : {}),
              } }),
              (error) => sse(res, { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: messageOf(error) } }),
            ).finally(() => {
              clearInterval(keepAlive);
              open.delete(res);
              res.off("close", onClose);
              if (!res.writableEnded && !res.destroyed) res.end();
            });
            return;
          }
          default:
            json(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
            return;
        }
        json(res, 200, { jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        if (!res.headersSent) json(res, 200, { jsonrpc: "2.0", id: requestId, error: { code: -32000, message: messageOf(error) } });
        else res.end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    token,
    address: () => server.address(),
    async close() {
      for (const response of open) response.destroy();
      open.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message.slice(0, 500) : String(error); }

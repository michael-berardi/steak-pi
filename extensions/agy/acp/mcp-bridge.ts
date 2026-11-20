// Loopback MCP bridge: exposes Pi's own tools to agy, but parks every tools/call until Pi has run it through its
// permission and execution pipeline. The returned content is Pi's real tool result, so agy resumes with it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface BridgeTool { name: string; description: string; parameters?: Record<string, unknown> }
export interface BridgeContent { type: "text" | "image"; text?: string; data?: string; mimeType?: string }
export interface BridgeToolResult { content: BridgeContent[]; details?: unknown; isError?: boolean }
export interface BridgeToolSource {
  list(): BridgeTool[] | Promise<BridgeTool[]>;
  call(name: string, args: unknown, signal?: AbortSignal): Promise<BridgeToolResult>;
}
export interface McpBridge {
  url: string;
  token: string;
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

const PREFIX = "pi_";
const MAX_BODY = 1_048_576;

/** Fixed-length digests make the comparison independent of token length (no early exit on a mismatch). */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
}

export async function startMcpBridge(source: BridgeToolSource): Promise<McpBridge> {
  const token = randomBytes(32).toString("base64url"); // 256 bits, new for every session, never logged
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
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += (chunk as Buffer).length;
          if (bytes > MAX_BODY) { res.writeHead(413).end(); return; }
          chunks.push(chunk as Buffer);
        }
        let request: any;
        try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json(res, 400, { error: "invalid JSON" }); return; }
        if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") { json(res, 400, { error: "invalid JSON-RPC" }); return; }
        requestId = request.id ?? 0;
        if (request.id === undefined) { res.writeHead(202).end(); return; }
        let result: unknown;
        switch (request.method) {
          case "initialize":
            result = { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "steak-pi-tools", version: "1.0.0" } };
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
            const outcome = await source.call(real, request.params?.arguments ?? {});
            result = {
              content: outcome.content.map((part) => part.type === "image"
                ? { type: "image", data: part.data ?? "", mimeType: part.mimeType ?? "application/octet-stream" }
                : { type: "text", text: part.text ?? "" }),
              ...(outcome.isError ? { isError: true } : {}),
            };
            break;
          }
          default:
            json(res, 200, { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
            return;
        }
        json(res, 200, { jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        if (!res.headersSent) json(res, 200, { jsonrpc: "2.0", id: requestId, error: { code: -32000, message: error instanceof Error ? error.message.slice(0, 500) : String(error) } });
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
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

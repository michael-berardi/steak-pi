// A local fake of the provider's endpoints. The tests never call a real service: every URL in a test config points here.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseConfig, type AntigravityConfig } from "../../extensions/antigravity/config.ts";

export interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
export type Handler = (request: Seen, res: http.ServerResponse, count: number) => void | Promise<void>;

export interface Fake {
  url: string;
  seen: Seen[];
  /** Replace the handler for a path (a prefix match on the URL). */
  on(path: string, handler: Handler): void;
  /** A handler that sees the request before its body is read (to stall an upload). */
  raw(path: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): void;
  close(): Promise<void>;
}

export async function startFake(): Promise<Fake> {
  const handlers = new Map<string, Handler>();
  const counts = new Map<string, number>();
  const seen: Seen[] = [];
  const rawHandlers = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>();
  const server = http.createServer((req, res) => {
    const rawKey = [...rawHandlers.keys()].find((k) => (req.url ?? "").startsWith(k));
    if (rawKey) { rawHandlers.get(rawKey)!(req, res); return; }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const record: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(record);
      const key = [...handlers.keys()].find((k) => record.url.startsWith(k));
      if (!key) { res.writeHead(404).end(JSON.stringify({ error: { message: `no handler for ${record.url}` } })); return; }
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      await handlers.get(key)!(record, res, n);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, seen,
    raw: (path, handler) => { rawHandlers.set(path, handler); },
    on: (path, handler) => { handlers.set(path, handler); counts.set(path, 0); },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** Server-Sent Events: each object is one `data:` line; `gapMs` waits between events. */
export async function sse(res: http.ServerResponse, events: unknown[], gapMs = 0): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
  }
  res.end();
}

export function testConfig(fake: Fake, extra: Record<string, unknown> = {}): AntigravityConfig {
  const config = parseConfig({
    enabled: true,
    clientId: "test-client",
    clientSecret: "test-secret",
    baseUrls: [fake.url],
    authUrl: `${fake.url}/auth`,
    tokenUrl: `${fake.url}/token`,
    maxRateLimitWaitMs: 5_000,
    ...extra,
  });
  if (!config) throw new Error("test config must be enabled");
  return config;
}

export const TOKEN = "tok-live-1";
export const sessionKey = (extra: Record<string, unknown> = {}) => JSON.stringify({ token: TOKEN, projectId: "proj-1", ...extra });

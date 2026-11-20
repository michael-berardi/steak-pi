import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearModelCache } from "../../extensions/agy/models.ts";
import { AcpSession, resetAcpSessions, setAcpPermissionHandler, setAcpToolSource } from "../../extensions/agy/acp/session.ts";
import { constantTimeEqual, startMcpBridge } from "../../extensions/agy/acp/mcp-bridge.ts";
import { effortForAcp, normalizeAcpUsage } from "../../extensions/agy/acp/options.ts";
import { acpLogs, clearAcpLog, probeAcpSupport, resolveTransport, setAcpLog } from "../../extensions/agy/acp/transport.ts";
import { streamAgyAcp } from "../../extensions/agy/acp/stream.ts";
import agyExtension from "../../extensions/agy/index.ts";

const FAKE = new URL("./fake-acp.mjs", import.meta.url).pathname;
const HEADLESS_FAKE = new URL("./fake-agy.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "agy-acp-test-"));
const log = join(dir, "acp.log");
const saved = { ...process.env };

const entries = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const ctx = (...messages: unknown[]) => ({ messages }) as never;
const model = () => ({ id: "gemini-x-high", api: "agy-stream-json", provider: "agy", contextWindow: 200_000, maxTokens: 64_000 }) as any;
const waitFor = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  if (!cond()) throw new Error("timed out waiting for fixture");
};
const toolInvocations: [string, unknown][] = [];
const permissionAnswers: string[] = [];
const source = () => ({
  list: () => [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
  call: async (name: string, args: unknown) => {
    toolInvocations.push([name, args]);
    return { content: [{ type: "text" as const, text: "file contents" }], details: {} };
  },
});

beforeEach(() => {
  clearModelCache(); resetAcpSessionsForTest(); clearAcpLog(); logs.length = 0;
  writeFileSync(log, "");
  toolInvocations.length = 0; permissionAnswers.length = 0;
  Object.assign(process.env, {
    STEAK_PI_AGY_BIN: FAKE, FAKE_ACP_LOG: log, FAKE_ACP_HEADLESS_BIN: HEADLESS_FAKE,
    FAKE_AGY_LOG: log, FAKE_AGY_SCENARIO: "success", STEAK_PI_AGY_TRANSPORT: "acp",
  });
  delete process.env.FAKE_ACP_SCENARIO; delete process.env.STEAK_DSH_AGY_TRANSPORT;
  setAcpToolSource(source());
  setAcpPermissionHandler(async (request) => { permissionAnswers.push(request.title); return request.options.find((o) => o.kind === "allow_once")?.optionId; });
  setAcpLog((message) => { logs.push(message); });
});
const logs: string[] = [];
afterEach(async () => { await resetAcpSessions(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
// Synchronous reset for beforeEach (the async one also closes the HTTP bridge).
function resetAcpSessionsForTest() { void resetAcpSessions(); }

async function collect(modelToUse = model(), messages: unknown[] = [user("hello")], options: Record<string, unknown> = {}) {
  const events: any[] = [];
  for await (const event of streamAgyAcp(modelToUse, ctx(...messages), options as never)) events.push(event);
  return { events, message: (events.at(-1) as any)?.message ?? (events.at(-1) as any)?.error };
}

describe("ACP transport and bridge", () => {
  it("selects acp/headless/auto from either env var and names a bad value", () => {
    expect(resolveTransport({})).toBe("auto");
    expect(resolveTransport({ STEAK_PI_AGY_TRANSPORT: "acp", STEAK_DSH_AGY_TRANSPORT: "headless" })).toBe("headless");
    delete process.env.STEAK_DSH_AGY_TRANSPORT;
    for (const value of ["acp", "headless", "auto"]) expect(resolveTransport({ STEAK_PI_AGY_TRANSPORT: value })).toBe(value);
    expect(() => resolveTransport({ STEAK_PI_AGY_TRANSPORT: "yolo" })).toThrow(/STEAK_PI_AGY_TRANSPORT/);
  });
  it("binds the MCP bridge to loopback only, checks a random token in constant time, and closes it", async () => {
    const bridge = await startMcpBridge({ list: () => [], call: async () => ({ content: [], details: {} }) });
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(bridge.token.length).toBeGreaterThan(30);
    expect((bridge.address() as any).address).toBe("127.0.0.1");
    expect(constantTimeEqual(bridge.token, bridge.token)).toBe(true);
    expect(constantTimeEqual(bridge.token, `${bridge.token}x`)).toBe(false);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const send = (authorization: string) => fetch(bridge.url, { method: "POST", headers: { authorization, "content-type": "application/json" }, body });
    expect((await send("Bearer wrong-token")).status).toBe(401);
    const ok = await send(`Bearer ${bridge.token}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).result.tools).toEqual([]);
    await bridge.close();
    await expect(fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}` }, body })).rejects.toThrow();
  });
  it("spawns one long-lived agy acp child with the documented flags and an HTTP MCP bridge", async () => {
    const session = await AcpSession.create({ bin: FAKE, cwd: process.cwd(), env: process.env, toolSource: source() });
    const argv = entries().find((e) => e.event === "argv")?.args as string[];
    expect(argv.slice(0, 2)).toEqual(["acp", "--process-per-session"]);
    expect(argv).toContain("--disable-telemetry");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv).not.toContain("--gemini-dir");
    expect(argv.join(" ")).not.toContain("credential");
    const created = entries().find((e) => e.event === "session/new");
    const server = created.params.mcpServers[0];
    expect(server.type).toBe("http");
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(server.auth).toMatch(/^Bearer /);
    expect(entries().find((e) => e.event === "mcp/tools/list").result).toEqual(["pi_read"]);
    expect(entries().find((e) => e.event === "mcp/tools/call").result.content[0].text).toBe("file contents");
    expect(toolInvocations).toEqual([["read", { path: "/tmp/agy-acp-fixture.txt" }]]);
    await session.close();
  });
});

describe("an ACP turn", () => {
  it("streams thinking and text as Pi events, runs agy's tool call through Pi, and learns window/efforts", async () => {
    const m = model();
    const { events, message } = await collect(m, [user("hello")], { reasoning: "high" });
    expect(events.filter((e) => e.type === "thinking_delta").map((e) => e.delta)).toEqual(["thinking about ", "the request"]);
    expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta)).toEqual(["Here is ", "the answer."]);
    expect(message.content.map((b: any) => b.type)).toEqual(["thinking", "text"]);
    // The bridge already ran the tool through Pi: emitting toolcall blocks would make Pi execute it twice.
    expect(events.some((e) => String(e.type).startsWith("toolcall"))).toBe(false);
    expect(toolInvocations).toEqual([["read", { path: "/tmp/agy-acp-fixture.txt" }]]);
    expect(message.stopReason).toBe("stop");
    expect(m.contextWindow).toBe(123456);
    expect(m.thinkingLevelMap).toMatchObject({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" });
    // ACP's prompt buckets are cumulative across steps; scale them to single-call occupancy.
    expect(message.usage).toMatchObject({ totalTokens: 70000, output: 300, cacheRead: 15555, input: 54445 });
    expect(entries().filter((e) => e.event === "config").map((e) => [e.configId, e.value])).toContainEqual(["thought_level", "High"]);
  });
  it("selects a model only if it is in the server's model option list", async () => {
    const m = model(); m.id = "gemini-x-low";
    await collect(m);
    expect(entries().filter((e) => e.event === "config").map((e) => [e.configId, e.value])).toContainEqual(["model", "gemini-x-low"]);
  });
  it("uses the server's real effort values instead of inventing levels", () => {
    const options = [{ id: "thought_level", name: "Thinking level", category: "thought_level", type: "select", currentValue: "Medium", options: ["Low", "Medium", "High", "Extra", "Max"].map((value) => ({ value, name: value })) }];
    expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => effortForAcp(level, options))).toEqual(["Low", "Low", "Low", "Medium", "High", "Extra", "Max"]);
    expect(normalizeAcpUsage({ inputTokens: 90, cacheReadTokens: 10, outputTokens: 5, totalTokens: 50 })).toMatchObject({ input: 45, cacheRead: 5, totalTokens: 50, output: 5 });
  });
  it("answers an agy permission request through the host's approval path", async () => {
    process.env.FAKE_ACP_SCENARIO = "permission";
    const { message } = await collect();
    expect(message.stopReason).toBe("stop");
    expect(permissionAnswers).toEqual(["read a file"]);
    expect(entries().filter((e) => e.id === 900), JSON.stringify(entries())).toContainEqual(expect.objectContaining({ result: { outcome: { outcome: "selected", optionId: "allow-once" } } }));
  });
  it("cancels the ACP turn with session/cancel and reports an aborted stream", async () => {
    process.env.FAKE_ACP_SCENARIO = "cancel";
    const controller = new AbortController();
    const events: any[] = [];
    const stream = streamAgyAcp(model(), ctx(user("go")), { signal: controller.signal } as never);
    await waitFor(() => entries().some((e) => e.event === "prompt"));
    controller.abort();
    for await (const event of stream) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    await waitFor(() => entries().some((e) => e.event === "cancel"));
    expect(entries().some((e) => e.event === "cancel")).toBe(true);
  });
});

describe("errors and fallback", () => {
  it("names a -32000 authentication error and never silently falls back in acp mode", async () => {
    process.env.FAKE_ACP_SCENARIO = "auth";
    const { message } = await collect();
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("not signed in");
    expect(entries().filter((e) => e.event === "argv").every((e) => e.args[0] === "acp")).toBe(true);
    expect(logs.join(" ")).not.toMatch(/falling back/i);
  });
  it("names a missing agy binary with the official install command", async () => {
    process.env.STEAK_PI_AGY_BIN = join(dir, "does-not-exist");
    const { message } = await collect();
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("install.sh");
  });
  it("auto mode falls back to headless with a logged reason when agy acp --help fails", async () => {
    process.env.FAKE_ACP_SCENARIO = "no-acp-help";
    process.env.STEAK_PI_AGY_TRANSPORT = "auto";
    const { message } = await collect();
    expect(message.stopReason).toBe("stop");
    expect(message.content[0].text).toContain("Git rebase");
    expect(entries().some((e) => e.event === "argv" && e.args[0] === "--input-format")).toBe(true);
    expect(logs.join(" ")).toMatch(/agy acp --help failed/i);
  });
  it("auto mode falls back with a logged reason when ACP initialize fails", async () => {
    process.env.FAKE_ACP_SCENARIO = "auth";
    process.env.STEAK_PI_AGY_TRANSPORT = "auto";
    const { message } = await collect();
    expect(message.stopReason).toBe("stop");
    expect(logs.join(" ")).toMatch(/ACP initialize failed.*Authentication required/i);
    expect(entries().some((e) => e.event === "argv" && e.args[0] === "--input-format")).toBe(true);
  });
  it("probes agy acp --help without passing credentials or installing anything", async () => {
    expect(await probeAcpSupport({ bin: FAKE, env: process.env })).toBe(true);
    process.env.FAKE_ACP_SCENARIO = "no-acp-help";
    expect(await probeAcpSupport({ bin: FAKE, env: process.env, force: true })).toBe(false);
  });
});

describe("session lifecycle", () => {
  it("resets the ACP session on branch/compact/start and disposes it on shutdown", async () => {
    const handlers: Record<string, (e: unknown, c: any) => any> = {};
    const uiCtx = { ui: { confirm: async () => true, notify: () => {} }, modelRegistry: { refresh: async () => {} }, getCallableTools: () => [] } as any;
    agyExtension({ registerProvider: () => {}, registerCommand: () => {}, on: (name: string, handler: any) => { handlers[name] = handler; } } as never);
    await collect();
    const first = entries().filter((e) => e.event === "argv").length;
    for (const event of ["session_start", "session_tree", "session_compact"]) await handlers[event]({}, uiCtx);
    expect(entries().filter((e) => e.event === "argv").length).toBe(first); // no child until the next turn
    await collect();
    expect(entries().filter((e) => e.event === "argv").length).toBeGreaterThan(first);
    await handlers.session_shutdown({ reason: "quit" }, uiCtx);
    // A fresh turn after shutdown creates a fresh session, proving the old child and bridge were disposed.
    await collect();
    expect(entries().filter((e) => e.event === "argv").length).toBeGreaterThan(first + 1);
    await resetAcpSessions();
  });
});

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import agyExtension from "../../extensions/agy/index.ts";
import { startMcpBridge } from "../../extensions/agy/acp/mcp-bridge.ts";
import { resetAcpSessions, setAcpPermissionHandler } from "../../extensions/agy/acp/session.ts";
import { streamAgyAcp } from "../../extensions/agy/acp/stream.ts";

const FAKE = new URL("./fake-acp.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "agy-acp-loop-test-"));
const log = join(dir, "acp.log");
const saved = { ...process.env };
const TOOLS = [
  { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] } },
] as const;
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const model = () => ({ id: "gemini-x-high", api: "agy-stream-json", provider: "agy", contextWindow: 200_000, maxTokens: 64_000 }) as any;
const entries = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const waitFor = async (cond: () => boolean, ms = 6000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  if (!cond()) throw new Error("timed out waiting for the ACP fixture");
};

const context = () => normalizeContext({ messages: [user("read the file")], tools: TOOLS as never }) as never;
const continuation = (assistant: any, results: any[]) => normalizeContext({
  messages: [{ role: "system" as const, content: "Pi", timestamp: 0, toolsAdded: TOOLS as never }, assistant, ...results],
}) as never;
const toolResults = (assistant: any, contents = ["fixture text", "written"]) => assistant.content
  .filter((block: any) => block.type === "toolCall")
  .map((block: any, index: number) => ({ role: "toolResult" as const, toolCallId: block.id, toolName: block.name, content: [{ type: "text" as const, text: contents[index] ?? "" }], isError: false, timestamp: 3 }));
const collect = async (stream: AsyncIterable<any>) => {
  const events: any[] = [];
  for await (const event of stream) events.push(event);
  return { events, message: events.at(-1)?.message ?? events.at(-1)?.error };
};

beforeEach(async () => {
  await resetAcpSessions();
  writeFileSync(log, "");
  Object.assign(process.env, { STEAK_PI_AGY_BIN: FAKE, FAKE_ACP_LOG: log, FAKE_ACP_SCENARIO: "tool", STEAK_PI_AGY_TRANSPORT: "acp" });
  delete process.env.FAKE_ACP_HEADLESS_BIN; delete process.env.STEAK_DSH_AGY_TRANSPORT;
});
afterEach(async () => {
  setAcpPermissionHandler(undefined);
  await resetAcpSessions();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

/** The two successive streamSimple calls of one Pi provider tool loop. */
async function runLoop(options: { scenario?: string; omitResults?: boolean } = {}) {
  process.env.FAKE_ACP_SCENARIO = options.scenario ?? "tool";
  const signal = new AbortController().signal;
  const first = await collect(streamAgyAcp(model(), context(), { signal } as never));
  const assistant = first.message;
  expect(assistant.stopReason).toBe("toolUse");
  const calls = assistant.content.filter((block: any) => block.type === "toolCall");
  const results = options.omitResults ? [] : toolResults(assistant);
  const second = await collect(streamAgyAcp(model(), continuation(assistant, results), { signal } as never));
  return { first, assistant, calls, second, result: second.message };
}

describe("the provider tool loop", () => {
  it("a real Pi event context has no executeTool; the old context borrowing exposes no tools, the transcript does", () => {
    // Pi's runner.createContext() is what session_start / before_provider_request handlers receive.
    const runner = new ExtensionRunner([], { invalidate() {} } as never, process.cwd(), {} as never, {} as never);
    const piContext: any = runner.createContext();
    expect("executeTool" in piContext).toBe(false);
    expect("getCallableTools" in piContext).toBe(false);
    expect("tools" in piContext).toBe(false);
    const oldBorrowedTools = (piContext.getCallableTools?.() ?? []).map((tool: any) => tool.name);
    expect(oldBorrowedTools).toEqual([]); // exactly why the old bridge advertised an empty tool list
    expect(normalizeContext({ messages: [user("hi")], tools: TOOLS as never }).messages[0]).toMatchObject({ toolsAdded: TOOLS });
  });

  it("turns a parked MCP call into a Pi toolCall block, then answers it from the next step's toolResult in the same ACP prompt", async () => {
    const { first, assistant, calls, second, result } = await runLoop();
    expect(first.events.filter((e) => e.type === "toolcall_start")).toHaveLength(1);
    expect(first.events.filter((e) => e.type === "toolcall_end")).toHaveLength(1);
    expect(calls).toEqual([{ type: "toolCall", id: expect.any(String), name: "read", arguments: { path: "/tmp/agy-acp-fixture.txt" } }]);
    expect(first.events.at(-1)).toMatchObject({ type: "done", reason: "toolUse" });
    const mcp = entries().find((e) => e.event === "mcp/tools/call");
    expect(mcp).toMatchObject({ name: "pi_read", result: { content: [{ type: "text", text: "fixture text" }] } });
    expect(mcp.result.isError).toBeUndefined();
    expect(entries().filter((e) => e.event === "prompt")).toHaveLength(1); // the ACP prompt never restarted
    expect(entries().filter((e) => e.event === "session/new")).toHaveLength(1);
    expect(second.events.some((e) => String(e.type).startsWith("toolcall"))).toBe(false);
    expect(result.content.map((b: any) => b.text).join("")).toContain("Here is the answer.");
    expect(result.stopReason).toBe("stop");
  });

  it("parks and resumes several parallel calls from one Pi step", async () => {
    const { calls, result } = await runLoop({ scenario: "parallel" });
    expect(calls.map((c: any) => c.name).sort()).toEqual(["read", "write"]);
    expect(new Set(calls.map((c: any) => c.id)).size).toBe(2);
    expect(entries().filter((e) => e.event === "mcp/tools/call")).toHaveLength(2);
    expect(entries().filter((e) => e.event === "prompt")).toHaveLength(1);
    expect(entries().filter((e) => e.event === "mcp/tools/call").map((e) => e.result?.content?.[0]?.text).sort()).toEqual(["fixture text", "written"]);
    expect(result.stopReason).toBe("stop");
    expect(result.content.map((b: any) => b.text).join("")).toContain("Both done.");
  });

  it("cancels the ACP turn and answers parked calls with an error when Pi aborts", async () => {
    process.env.FAKE_ACP_SCENARIO = "tool-cancel";
    const controller = new AbortController();
    const events: any[] = [];
    const stream = streamAgyAcp(model(), context(), { signal: controller.signal } as never);
    const reading = (async () => { for await (const event of stream) events.push(event); })();
    await waitFor(() => entries().some((e) => e.event === "mcp/call-headers"));
    controller.abort();
    await reading;
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    await waitFor(() => entries().some((e) => e.event === "cancel"));
    await waitFor(() => entries().some((e) => e.event === "mcp/tools/call"));
    const mcp = entries().find((e) => e.event === "mcp/tools/call");
    expect(mcp?.result?.isError, JSON.stringify(entries())).toBe(true);
    expect(mcp?.result?.content?.[0]?.text).toMatch(/cancel/i);
  });

  it("answers a parked call with an error result when the next step has no matching toolResult", async () => {
    const { result } = await runLoop({ scenario: "missing", omitResults: true });
    const mcp = entries().find((e) => e.event === "mcp/tools/call");
    expect(mcp?.result?.isError).toBe(true);
    expect(mcp?.result?.content?.[0]?.text).toMatch(/missing/i);
    expect(entries().filter((e) => e.event === "prompt")).toHaveLength(1);
    expect(result.stopReason).toBe("stop");
    expect(result.content.map((b: any) => b.text).join("")).toContain("missing result");
  });

  it("sends HTTP headers immediately and keeps SSE comments flowing while a call is parked", async () => {
    const bridge = await startMcpBridge({
      list: () => [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      call: () => new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: "text", text: "done" }] }), 120)),
    }, { keepAliveMs: 10 });
    try {
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "pi_read", arguments: {} } }),
      });
      expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
      let text = "";
      const reader = response.body!.getReader();
      while (!text.includes(": keepalive")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain(": keepalive");
      while (!text.includes("done")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain('"result"');
    } finally {
      await bridge.close();
    }
  });

  it("closing the bridge releases a never-resolving parked call instead of hanging the HTTP client", async () => {
    const bridge = await startMcpBridge({
      list: () => [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
      call: () => new Promise(() => {}),
    }, { keepAliveMs: 10 });
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "pi_read", arguments: {} } }),
    });
    const reader = response.body!.getReader();
    await reader.read();
    await bridge.close();
    await expect(reader.read()).resolves.toMatchObject({ done: true }).catch(() => { /* a destroyed socket is also a release */ });
  });

  it("resets a live session while a call is parked: the call gets an error and the next turn creates a fresh session", async () => {
    process.env.FAKE_ACP_SCENARIO = "tool-cancel";
    const events: any[] = [];
    const reading = (async () => { for await (const event of streamAgyAcp(model(), context())) events.push(event); })();
    await waitFor(() => entries().some((e) => e.event === "mcp/call-headers"));
    await resetAcpSessions();
    await reading;
    expect(events.at(-1)?.type).toBe("error");
    process.env.FAKE_ACP_SCENARIO = "success";
    const { message } = await collect(streamAgyAcp(model(), context()));
    expect(message.stopReason).toBe("stop");
    expect(entries().filter((e) => e.event === "session/new")).toHaveLength(2);
  });

  it("never auto-approves an agy permission request when Pi has no UI", async () => {
    const handlers: Record<string, (event: unknown, ctx: any) => any> = {};
    agyExtension({ registerProvider: () => {}, registerCommand: () => {}, on: (name: string, handler: any) => { handlers[name] = handler; } } as never);
    await handlers.before_provider_request({}, { ui: { confirm: async () => true, notify: () => {} }, hasUI: false });
    await runLoop({ scenario: "permission" });
    expect(entries().find((e) => e.id === 900)?.result?.outcome?.optionId).toBe("reject-once");
  });

  it("does not borrow tools from the event context: no Pi context is needed for the bridge", async () => {
    const handlers: Record<string, (event: unknown, ctx: any) => any> = {};
    agyExtension({ registerProvider: () => {}, registerCommand: () => {}, on: (name: string, handler: any) => { handlers[name] = handler; } } as never);
    const noTools = { ui: { confirm: async () => false, notify: () => {} }, hasUI: false } as any;
    await handlers.before_provider_request({}, noTools);
    const { calls } = await runLoop();
    expect(calls).toHaveLength(1);
    expect(entries().find((e) => e.event === "mcp/tools/list")?.result).toEqual(["pi_read", "pi_write"]);
  });
});

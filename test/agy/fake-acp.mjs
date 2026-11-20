#!/usr/bin/env node
// Fake `agy acp`: JSON-RPC 2.0 over stdio, with a real HTTP MCP tools/call round trip to the bridge.
// Scenario: FAKE_ACP_SCENARIO = success | auth | prompt-auth | cancel | permission | no-acp-help.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_ACP_SCENARIO || "success";
const log = (event) => { if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(event) + "\n"); };
log({ event: "argv", args });

// The same fake stands in for headless agy, so auto-transport fallback can be exercised with one binary.
if (args[0] !== "acp") {
  if (!process.env.FAKE_ACP_HEADLESS_BIN) { process.stderr.write("no headless fake configured\n"); process.exit(3); }
  await import(pathToFileURL(process.env.FAKE_ACP_HEADLESS_BIN).href);
  process.exit(0);
}
if (args[1] === "--help") {
  if (scenario === "no-acp-help") { process.stderr.write("unrecognized command: acp\n"); process.exit(2); }
  process.stdout.write("agy acp: Agent Client Protocol server\n  --process-per-session\n  --disable-telemetry\n");
  process.exit(0);
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const OPTIONS = [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "gemini-x-high", options: [{ value: "gemini-x-high", name: "Gemini X (High)" }, { value: "gemini-x-low", name: "Gemini X (Low)" }] },
  { id: "thought_level", name: "Thinking level", category: "thought_level", type: "select", currentValue: "Medium", options: ["Low", "Medium", "High", "Extra", "Max"].map((v) => ({ value: v, name: v })) },
];
let mcpId = 100;
async function mcpCall(url, headers, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: Object.fromEntries(headers.map((h) => [h.name, h.value])),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++mcpId, method, params }),
  });
  return await response.json();
}
const cancelled = [];
let answeredPermission;

async function handle(message) {
  const { method, params, id } = message;
  if (id === 900 && !method) { log({ ...message }); answeredPermission?.(message); return; } // Pi's answer to session/request_permission
  if (method === "initialize") {
    log({ event: "initialize", params });
    if (scenario === "auth") { send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } }); return; }
    send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } } });
    return;
  }
  if (method === "session/new") {
    const server = params.mcpServers?.[0];
    log({ event: "session/new", params: { cwd: params.cwd, mcpServers: server ? [{ type: server.type, name: server.name, url: server.url, auth: server.headers?.find((h) => h.name === "Authorization")?.value }] : [] } });
    const base = { jsonrpc: "2.0", id, params: {} };
    const list = await mcpCall(server.url, server.headers, "tools/list", {});
    log({ event: "mcp/tools/list", result: list.result?.tools?.map((t) => t.name) ?? list.error });
    const called = await mcpCall(server.url, server.headers, "tools/call", { name: "pi_read", arguments: { path: "/tmp/agy-acp-fixture.txt" } });
    log({ event: "mcp/tools/call", result: called.result ?? called.error });
    send({ jsonrpc: "2.0", id, result: { sessionId: "acp-session-1", configOptions: OPTIONS } });
    return;
  }
  if (method === "session/set_config_option") {
    log({ event: "config", configId: params.configId, value: params.value });
    send({ jsonrpc: "2.0", id, result: { configOptions: OPTIONS } });
    return;
  }
  if (method === "session/prompt") {
    log({ event: "prompt", params });
    if (scenario === "prompt-auth") { send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required" } }); return; }
    const chunk = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } });
    chunk({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about " } });
    chunk({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "the request" } });
    chunk({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "read", name: "pi_read", status: "pending" });
    chunk({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "completed", content: [{ type: "content", content: { type: "text", text: "file contents" } }] });
    chunk({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Here is " } });
    chunk({ sessionUpdate: "usage_update", used: 70000, size: 123456, inputTokens: 70000, outputTokens: 300, cacheReadTokens: 20000, totalTokens: 70000 });
    chunk({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "the answer." } });
    if (scenario === "permission") {
      const answer = new Promise((resolve) => { answeredPermission = resolve; });
      send({ jsonrpc: "2.0", id: 900, method: "session/request_permission", params: { sessionId: params.sessionId, toolCall: { toolCallId: "call_1", title: "read a file", name: "pi_read" }, options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }] } });
      await answer;
    }
    if (scenario === "cancel") {
      await new Promise((resolve) => cancelled.push(resolve));
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  if (method === "session/cancel") { log({ event: "cancel", params }); cancelled.splice(0).forEach((resolve) => resolve()); return; }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let at;
  while ((at = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, at).trim();
    pending = pending.slice(at + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    void handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));

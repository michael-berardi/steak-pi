import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { closeClaudeProcesses, runClaudeRequest } from "../../extensions/claude-code/claude-cli.ts";

const FAKE = `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth")) { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const usage = { input_tokens: 1, output_tokens: 1 };
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (process.env.MODE === "replay-chatter") { setInterval(() => console.log(JSON.stringify({ type: "rate_limit_event" })), 30); continue; }
  if (process.env.MODE === "error") {
    console.log(JSON.stringify({ type: "assistant", error: "fixture failure\\u001b[31m\\nline", message: { role: "assistant", content: [] } }));
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, usage }));
    continue;
  }
  if (process.env.MODE.startsWith("relay")) {
    const pulse = setInterval(() => console.log(JSON.stringify({ type: "rate_limit_event" })), 80);
    try {
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: "{}" });
    await response.text();
    } catch { /* Native wrappers may obscure the relay's terminal local cause. */ }
    finally { clearInterval(pulse); }
  } else {
    for (let i = 0; i < 30; i++) {
      console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } }));
      if (process.env.MODE === "silence") await new Promise(() => {});
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  }
  console.log(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));
  console.log(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage }));
}
`;

async function fixture(mode: string, check: (input: Parameters<typeof runClaudeRequest>[0]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "request-idle-"));
  const executable = join(root, "claude.mjs");
  await writeFile(executable, FAKE); await chmod(executable, 0o755);
  const timers = new Set<NodeJS.Timeout>();
  let attempts = 0;
  const upstream = http.createServer(async (request, response) => {
    for await (const _ of request) { /* consume */ }
    attempts++;
    if (mode === "relay-stuck" && attempts < 3) { response.writeHead(503).end("busy"); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "relay-stuck") { response.write(": first byte\n\n"); return; }
    const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
    const pulse = setInterval(() => response.write(": keepalive\n\n"), 40);
    timers.add(pulse);
    const end = setTimeout(() => {
      send({ type: "message_delta", delta: { stop_reason: "end_turn" } });
      send({ type: "message_stop" }); response.end();
    }, 2400);
    timers.add(end);
    response.on("close", () => { clearInterval(pulse); clearTimeout(end); });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    await check({ model: "sonnet", cwd: root, systemPrompt: "s", manifest: [], extraBody: {}, toolNames: new Set(),
      frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] }, ...(mode === "replay-chatter" ? { shouldQuery: false as const } : {}) }],
      timeoutMs: 1_000, env: { PI_CLAUDE_CODE_COMMAND: executable, MODE: mode },
      upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
  } finally {
    await closeClaudeProcesses();
    for (const timer of timers) clearInterval(timer);
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

for (const mode of ["native", "relay"]) {
  test(`${mode} bytes keep a long turn alive beyond timeoutMs`, () => fixture(mode, async input => {
    const started = Date.now();
    const output = await runClaudeRequest(input);
    assert.equal(output.message.stop_reason, "end_turn");
    assert.ok(Date.now() - started > 2_300);
  }));
}

test("silence fails with a visible non-retryable idle cause", () => fixture("silence", async input => {
  await assert.rejects(runClaudeRequest(input), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /idle|inactiv/);
    assert.equal(isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: error.message } as AssistantMessage), false);
    return true;
  });
}));

test("history replay has a wall bound even with native chatter", () => fixture("replay-chatter", async input => {
  const started = Date.now();
  await assert.rejects(runClaudeRequest(input), /history replay/);
  assert.ok(Date.now() - started < 2_500);
}));

test("empty native error content retains sanitized event.error", () => fixture("error", async input => {
  await assert.rejects(runClaudeRequest(input), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /fixture failure/);
    assert.doesNotMatch(error.message, /\u001b|\n|unknown native error/);
    return true;
  });
}));


test("a stalled relay retains a non-retryable cause after transient retries", () => fixture("relay-stuck", async input => {
  await assert.rejects(runClaudeRequest(input), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /upstream stream idle.*wait limit/);
    assert.equal(isRetryableAssistantError({ role: "assistant", stopReason: "error", errorMessage: error.message } as AssistantMessage), false);
    assert.doesNotMatch(error.message, /503|timed out|timeout/);
    return true;
  });
}));

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetryableAssistantError, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { afterEach, test, vi } from "vitest";
import { closeClaudeProcesses, setClaudeCodeStatusReporter } from "../../extensions/claude-code/claude-cli.ts";
import { effortRank, formatSilence, idleLimits, requestShape } from "../../extensions/claude-code/idle-policy.ts";
import { CLAUDE_CODE_MODELS } from "../../extensions/claude-code/model-catalog.ts";
import { streamClaudeCode } from "../../extensions/claude-code/stream.ts";

vi.setConfig({ testTimeout: 40_000 });

// The caller's idle budget in every case below. Old limit: 1 000 ms for any silence. New: 1 400 ms mid-stream, 300 ms to the
// first byte (then a quiet retry), and up to two recoveries.
const BUDGET = 1_000;

/** A fake Claude Code: forwards the conversation it was given to the relay, as the real CLI does, and logs its own pid. */
const FAKE = `#!/usr/bin/env node
import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.argv.includes("auth")) { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
appendFileSync(process.env.SPAWNS, process.pid + "\\n");
const usage = { input_tokens: 1, output_tokens: 1 };
const history = [];
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === "user" || frame.type === "assistant") history.push(frame.message);
  if (frame.shouldQuery === false) { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 0, usage })); continue; }
  if (frame.type !== "user") continue;
  let text = "";
  try {
    const response = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: JSON.stringify({ messages: history }) });
    text = await response.text();
  } catch { /* the relay's own cause is what the operator sees */ }
  const answer = /"text":"(answer[^"]*)"/.exec(text)?.[1] ?? "answer";
  console.log(JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: answer }], stop_reason: "end_turn", usage } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage }));
}
`;

type Behaviour = (attempt: number, response: http.ServerResponse, body: string) => (() => void) | void;

interface Rig {
  executable: string;
  spawns: () => Promise<number[]>;
  bodies: string[];
  attempts: () => number;
  run: (env?: Record<string, string>, context?: Context) => Promise<AssistantMessage>;
}

const timers = new Set<NodeJS.Timeout>();
afterEach(() => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  setClaudeCodeStatusReporter(undefined);
});

function sse(response: http.ServerResponse, ...events: unknown[]): void {
  for (const event of events) response.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
}
const START = { type: "message_start", message: { id: "m", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } } };
const textStart = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
const textDelta = (text: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
const FINISH = [
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];
const later = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); timers.add(t); };

async function rig(behaviour: Behaviour, body: (rig: Rig) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "stream-recovery-"));
  const executable = join(root, "claude.mjs");
  const spawnsPath = join(root, "spawns.log");
  await writeFile(executable, FAKE);
  await chmod(executable, 0o755);
  await writeFile(spawnsPath, "");
  // First launch of a fresh executable is scanned by the OS; do it outside the timed request.
  await new Promise<void>((resolve, reject) => execFile(executable, ["auth", "status"], (error) => (error ? reject(error) : resolve())));
  const bodies: string[] = [];
  let attempts = 0;
  const upstream = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    bodies.push(text);
    attempts += 1;
    const stop = behaviour(attempts, response, text);
    response.on("close", () => stop?.());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as AddressInfo).port;
  const model = CLAUDE_CODE_MODELS[0]!;
  const defaultContext = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as unknown as Context;
  try {
    await body({
      executable,
      bodies,
      attempts: () => attempts,
      spawns: async () => (await readFile(spawnsPath, "utf8")).split("\n").filter(Boolean).map(Number),
      run: (env = {}, context = defaultContext) =>
        streamClaudeCode(model, context as never, {
          timeoutMs: BUDGET,
          sessionId: `recovery-${Math.random()}`,
          env: { PI_CLAUDE_CODE_COMMAND: executable, SPAWNS: spawnsPath, ...env },
          upstreamUrl: `http://127.0.0.1:${port}`,
        } as never).result(),
    });
  } finally {
    await closeClaudeProcesses();
    for (const timer of timers) clearTimeout(timer);
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const textOf = (message: AssistantMessage) => message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");

test("a healthy turn that is silent longer than the old limit still completes (and shows a waiting line)", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, textStart, textDelta("answer"));
    // 1.2 s of nothing at all: more than the old 1.0 s limit, less than the new 1.4 s one.
    later(1_200, () => { sse(response, ...FINISH); response.end(); });
  }, async (r) => {
    const lines: Array<string | undefined> = [];
    setClaudeCodeStatusReporter((text) => lines.push(text));
    const message = await r.run();
    assert.equal(message.stopReason, "stop", String(message.errorMessage));
    assert.equal(textOf(message), "answer");
    assert.equal(r.attempts(), 1);
    assert.equal((await r.spawns()).length, 1);
    assert.ok(lines.some((line) => /^waiting on the model: \d+ s since last event$/.test(line ?? "")), `status lines: ${JSON.stringify(lines)}`);
    assert.equal(lines.at(-1), undefined, "the waiting line is cleared when the turn ends");
  }));

test("thinking deltas, tool-input deltas and keepalive pings all count as activity", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    let step = 0;
    const tick = setInterval(() => {
      step += 1;
      if (step <= 3) sse(response, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm " } });
      else if (step <= 5) sse(response, { type: "ping" });
      else if (step === 6) sse(response, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }, { type: "content_block_stop", index: 0 }, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } });
      else { clearInterval(tick); sse(response, { type: "content_block_stop", index: 1 }, ...FINISH.slice(1)); response.end(); }
    }, 700);
    return () => clearInterval(tick);
  }, async (r) => {
    const started = Date.now();
    const message = await r.run();
    assert.equal(message.stopReason, "stop", String(message.errorMessage));
    assert.ok(Date.now() - started > 4_000, "the turn ran well past one budget");
    assert.equal(r.attempts(), 1);
    assert.equal((await r.spawns()).length, 1, "no recovery was needed");
  }));

test("a connection that never answers is retried quietly at the relay without restarting Claude Code", () =>
  rig((attempt, response) => {
    if (attempt === 1) return; // never answers: no headers, no bytes
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, textStart, textDelta("answer"), ...FINISH);
    response.end();
  }, async (r) => {
    const started = Date.now();
    const message = await r.run();
    assert.equal(message.stopReason, "stop", String(message.errorMessage));
    assert.equal(r.attempts(), 2);
    assert.equal((await r.spawns()).length, 1, "the same Claude Code process served both attempts");
    assert.ok(Date.now() - started < 2_500, "recovered at the first-byte limit (300 ms), not after the full idle budget");
  }));

test("a stream that dies mid-reply: only that child is stopped, the turn is asked again once, and no tool call repeats", () =>
  rig((attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (attempt === 1) { sse(response, START, textStart, textDelta("answer")); return; } // then silence forever
    sse(response, START, textStart, textDelta("answer"), ...FINISH);
    response.end();
  }, async (r) => {
    // History already holds one finished tool call; it is replayed, never re-run.
    const context = {
      tools: [{ name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } as never }],
      messages: [
        { role: "user", content: "run it", timestamp: 1 },
        { role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "echo hi" } }], api: "anthropic-messages", provider: "claude-code", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 } as never,
        { role: "toolResult", toolCallId: "toolu_1", toolName: "bash", content: [{ type: "text", text: "hi" }], isError: false, timestamp: 3 },
      ],
    } as unknown as Context;
    const message = await r.run({}, context);
    assert.equal(message.stopReason, "stop", String(message.errorMessage));
    assert.equal(textOf(message), "answer", "the stalled attempt's partial text is dropped, not doubled");
    assert.equal(r.attempts(), 2, "asked again exactly once");
    const pids = await r.spawns();
    assert.equal(pids.length, 2, "a fresh Claude Code process took over");
    assert.equal(alive(pids[0]!), false, "the stalled child was stopped");
    assert.equal(r.bodies[0], r.bodies[1], "the replayed request is identical: nothing was added, nothing run twice");
    assert.equal((r.bodies[1]!.match(/toolu_1/g) ?? []).length, (r.bodies[0]!.match(/toolu_1/g) ?? []).length);
  }));

test("a stream that goes quiet on every attempt: bounded recoveries, then an error that names the cause", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, textStart, textDelta("answer"), { type: "ping" });
  }, async (r) => {
    const message = await r.run();
    assert.equal(message.stopReason, "error");
    assert.equal(r.attempts(), 3, "the first try plus two recoveries, never more");
    assert.equal((await r.spawns()).length, 3);
    const error = message.errorMessage ?? "";
    assert.match(error, /^Claude Code stream idle limit exceeded \(no bytes or events\)/);
    assert.match(error, /silent for 1 s partway through the reply|silent for \d+ s partway through the reply/);
    assert.match(error, /last event: ping/);
    assert.match(error, /process was alive/);
    assert.match(error, /2 automatic recoveries tried/);
    assert.match(error, /send "resume"/);
    assert.match(error, /PI_CLAUDE_CODE_IDLE_LIMIT_MS/);
    assert.equal(isRetryableAssistantError(message), false, "Pi must not retry a turn that recovery already retried");
    for (const pid of await r.spawns()) assert.equal(alive(pid), false, "every stalled child was stopped");
  }));

test("recovery can be switched off and the error says so", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, textStart);
  }, async (r) => {
    const message = await r.run({ PI_CLAUDE_CODE_MAX_RECOVERIES: "0" });
    assert.equal(message.stopReason, "error");
    assert.equal(r.attempts(), 1);
    assert.match(message.errorMessage ?? "", /automatic recovery is off \(PI_CLAUDE_CODE_MAX_RECOVERIES=0\)/);
  }));

test("the idle limit can be set from the environment", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, textStart, textDelta("answer"));
    later(2_000, () => { sse(response, ...FINISH); response.end(); });
  }, async (r) => {
    const message = await r.run({ PI_CLAUDE_CODE_IDLE_LIMIT_MS: "5000" });
    assert.equal(message.stopReason, "stop", String(message.errorMessage));
    assert.equal(r.attempts(), 1);
  }));

test("idle limits scale with effort and context, never fall below the budget, and are provider-neutral", () => {
  const base = idleLimits(300_000, {}, {});
  assert.equal(base.streamIdleMs, 420_000);
  assert.equal(base.firstByteMs, 90_000);
  const high = idleLimits(300_000, { effort: "high", bodyBytes: 1_575_000 }, {});
  assert.ok(high.streamIdleMs > base.streamIdleMs && high.streamIdleMs <= 540_000, String(high.streamIdleMs));
  assert.ok(high.firstByteMs > base.firstByteMs && high.firstByteMs <= high.streamIdleMs);
  assert.ok(idleLimits(300_000, { effort: "max", bodyBytes: 9_000_000 }, {}).streamIdleMs <= 540_000);
  assert.ok(base.streamIdleMs > 300_000, "longer than the old 300 s");
  assert.ok(base.queueIdleMs > base.streamIdleMs);
  assert.equal(idleLimits(300_000, {}, { PI_CLAUDE_CODE_IDLE_LIMIT_MS: "900000" }).streamIdleMs, 900_000);
  assert.equal(idleLimits(300_000, {}, { PI_CLAUDE_CODE_MAX_RECOVERIES: "0" }).maxRecoveries, 0);
  assert.equal(base.maxRecoveries, 2);
  assert.throws(() => idleLimits(300_000, {}, { PI_CLAUDE_CODE_IDLE_LIMIT_MS: "0" }), /positive number/);
  assert.throws(() => idleLimits(300_000, {}, { PI_CLAUDE_CODE_MAX_RECOVERIES: "99" }), /0 to 10/);
  assert.equal(effortRank({ thinkingBudgetTokens: 40_000 }), 4);
  assert.deepEqual(requestShape(Buffer.from(JSON.stringify({ output_config: { effort: "high" }, x: 1 }))), { bodyBytes: 41, effort: "high" });
  assert.deepEqual(requestShape(Buffer.from("not json")), { bodyBytes: 8 });
  assert.equal(formatSilence(301_400), "5 min 1 s");
  assert.equal(formatSilence(42_000), "42 s");
});

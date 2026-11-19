import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetryableAssistantError, type AssistantMessage, type AssistantMessageEvent, type Context } from "@earendil-works/pi-ai";
import { afterEach, test, vi } from "vitest";
import { closeClaudeProcesses, runClaudeRequest, setClaudeCodeDiagnosticReporter } from "../../extensions/claude-code/claude-cli.ts";
import { effortRank, formatSilence, idleLimits, MAX_REQUEST_SENDS, requestShape } from "../../extensions/claude-code/idle-policy.ts";
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
  if (process.env.HANG_AFTER_REPLY) await new Promise(() => setInterval(() => {}, 1000));
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
  /** Every event the Pi stream emitted for the last run, in order (not only the final message). */
  events: AssistantMessageEvent[];
  run: (env?: Record<string, string>, context?: Context, signal?: AbortSignal) => Promise<AssistantMessage>;
  /** The provider's request loop itself, with the caller's own canRestart / onEvent (what a harness supplies). */
  direct: (extra: Partial<Parameters<typeof runClaudeRequest>[0]>) => Promise<Awaited<ReturnType<typeof runClaudeRequest>>>;
}

const timers = new Set<NodeJS.Timeout>();
afterEach(() => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  setClaudeCodeDiagnosticReporter(undefined);
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
  const events: AssistantMessageEvent[] = [];
  try {
    await body({
      events,
      executable,
      bodies,
      attempts: () => attempts,
      direct: (extra) => runClaudeRequest({
        model: "default", cwd: root, frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }] as never,
        systemPrompt: "s", manifest: [], extraBody: {}, toolNames: new Map(), timeoutMs: BUDGET, upstreamUrl: `http://127.0.0.1:${port}`,
        env: { PI_CLAUDE_CODE_COMMAND: executable, SPAWNS: spawnsPath }, ...extra,
      } as never),
      spawns: async () => (await readFile(spawnsPath, "utf8")).split("\n").filter(Boolean).map(Number),
      run: async (env = {}, context = defaultContext, signal) => {
        events.length = 0;
        const stream = streamClaudeCode(model, context as never, {
          timeoutMs: BUDGET,
          sessionId: `recovery-${Math.random()}`,
          signal,
          env: { PI_CLAUDE_CODE_COMMAND: executable, SPAWNS: spawnsPath, ...env },
          upstreamUrl: `http://127.0.0.1:${port}`,
        } as never);
        for await (const event of stream) events.push(event);
        return stream.result();
      },
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

test("a healthy turn that is silent longer than the old limit still completes (and shows no waiting line)", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, textStart, textDelta("answer"));
    // 1.2 s of nothing at all: more than the old 1.0 s limit, less than the new 1.4 s one.
    later(1_200, () => { sse(response, ...FINISH); response.end(); });
  }, async (r) => {
    const notices: string[] = [];
    setClaudeCodeDiagnosticReporter((text) => notices.push(text));
    const message = await r.run();
    assert.equal(message.stopReason, "stop", String(message.errorMessage));
    assert.equal(textOf(message), "answer");
    assert.equal(r.attempts(), 1);
    assert.equal((await r.spawns()).length, 1);
    assert.deepEqual(notices.filter((line) => /waiting on the model/.test(line)), [], "a quiet but alive turn shows nothing");
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

test("a stream that dies before any content: only that child is stopped, the turn is asked again once, and no tool call repeats", () =>
  rig((attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (attempt === 1) { sse(response, START, { type: "ping" }); return; } // header bytes, then silence forever
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
    assert.equal(textOf(message), "answer");
    const kinds = r.events.map((event) => event.type);
    assert.equal(kinds.filter((kind) => kind === "text_start").length, 1, `emitted events: ${kinds.join(",")}`);
    assert.equal(kinds.filter((kind) => kind === "text_delta").length, 1, "the answer is streamed once, not twice");
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
    sse(response, START, { type: "ping" });
  }, async (r) => {
    const message = await r.run();
    assert.equal(message.stopReason, "error");
    assert.equal(r.attempts(), 3, "the first try plus two recoveries, never more");
    assert.equal((await r.spawns()).length, 3);
    const error = message.errorMessage ?? "";
    assert.match(error, /^Claude Code stream idle limit exceeded \(no bytes or events\)/);
    assert.match(error, /silent for \d+ s partway through the reply/);
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
    sse(response, START);
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

test("idle limits scale with effort and context, never fall below the budget, and are provider-neutral", async () => {
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
  assert.throws(() => idleLimits(300_000, {}, { PI_CLAUDE_CODE_IDLE_LIMIT_MS: "0" }), /PI_CLAUDE_CODE_IDLE_LIMIT_MS must be a number of milliseconds from 1000/);
  // Above the maximum: clamped to it with one warning that names the variable, never a failure on every turn.
  const warnings: string[] = [];
  const onWarning = (warning: Error) => { if (warning.name === "ClaudeCodeLimit") warnings.push(warning.message); };
  process.on("warning", onWarning);
  assert.equal(idleLimits(300_000, {}, { PI_CLAUDE_CODE_MAX_RECOVERIES: "99" }).maxRecoveries, 2);
  assert.equal(idleLimits(300_000, {}, { PI_CLAUDE_CODE_MAX_RECOVERIES: "99" }).maxRecoveries, 2);
  assert.equal(idleLimits(300_000, {}, { PI_CLAUDE_CODE_MAX_RECOVERIES: "3" }).maxRecoveries, 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.off("warning", onWarning);
  assert.equal(warnings.length, 1, `one-time: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0]!, /PI_CLAUDE_CODE_MAX_RECOVERIES="99" is above the maximum; using 2/);
  // Not a number (or not whole, or negative): still fails, naming the variable.
  for (const bad of ["abc", "1.5", "-1", "NaN", "Infinity"]) {
    assert.throws(() => idleLimits(300_000, {}, { PI_CLAUDE_CODE_MAX_RECOVERIES: bad }), /PI_CLAUDE_CODE_MAX_RECOVERIES must be a whole number from 0 to 2/, bad);
  }
  assert.equal(base.maxSends, MAX_REQUEST_SENDS);
  assert.equal(MAX_REQUEST_SENDS, 3);
  assert.equal(effortRank({ thinkingBudgetTokens: 40_000 }), 4);
  assert.deepEqual(requestShape(Buffer.from(JSON.stringify({ output_config: { effort: "high" }, x: 1 }))), { bodyBytes: 41, effort: "high" });
  assert.deepEqual(requestShape(Buffer.from("not json")), { bodyBytes: 8 });
  assert.equal(formatSilence(301_400), "5 min 1 s");
  assert.equal(formatSilence(42_000), "42 s");
});

test("env limits are checked after rounding, floored at 1000 ms and capped at the largest timer", () => {
  for (const bad of ["0.3", "0", "-5", "999", "999.4", "abc", "NaN", "Infinity", "2147483648", "1e12"]) {
    assert.throws(() => idleLimits(300_000, {}, { PI_CLAUDE_CODE_IDLE_LIMIT_MS: bad }), /PI_CLAUDE_CODE_IDLE_LIMIT_MS must be a number of milliseconds/, bad);
    assert.throws(() => idleLimits(300_000, {}, { PI_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS: bad }), /PI_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS must be/, bad);
  }
  assert.equal(idleLimits(300_000, {}, { PI_CLAUDE_CODE_IDLE_LIMIT_MS: "1000.4" }).streamIdleMs, 1_000);
  assert.equal(idleLimits(300_000, {}, { PI_CLAUDE_CODE_IDLE_LIMIT_MS: "999.6" }).streamIdleMs, 1_000, "rounds to 1000 first, then passes the floor");
  const huge = idleLimits(300_000, {}, { PI_CLAUDE_CODE_IDLE_LIMIT_MS: "2147483647" });
  assert.equal(huge.streamIdleMs, 2_147_483_647);
  assert.equal(huge.queueIdleMs, 2_147_483_647, "the native queue limit never exceeds Node's timer maximum");
  assert.ok(idleLimits(2_147_483_647, {}, {}).queueIdleMs <= 2_147_483_647);
  assert.ok(idleLimits(2_147_483_647, {}, {}).streamIdleMs <= 2_147_483_647);
});

test("a bad limit in the environment fails the turn with its name before any Claude Code process is started", () =>
  rig(() => { throw new Error("the API must not be called"); }, async (r) => {
    const message = await r.run({ PI_CLAUDE_CODE_IDLE_LIMIT_MS: "0.3" });
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage ?? "", /PI_CLAUDE_CODE_IDLE_LIMIT_MS must be a number of milliseconds from 1000/);
    assert.equal((await r.spawns()).length, 0, "no process was acquired, so none is left busy");
    assert.equal(r.attempts(), 0);
  }));

test("text already streamed is never asked for again: the turn fails with the named error and the stream shows it once", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, textStart, textDelta("answer"), { type: "ping" }); // then silence forever
  }, async (r) => {
    const message = await r.run();
    assert.equal(message.stopReason, "error");
    assert.equal(r.attempts(), 1, "no second request: the first already put text on the stream");
    assert.equal((await r.spawns()).length, 1);
    assert.match(message.errorMessage ?? "", /^Claude Code stream idle limit exceeded/);
    assert.match(message.errorMessage ?? "", /already been shown and cannot be taken back/);
    const kinds = r.events.map((event) => event.type);
    assert.equal(kinds.filter((kind) => kind === "text_start").length, 1, `emitted events: ${kinds.join(",")}`);
    assert.equal(kinds.filter((kind) => kind === "text_delta").length, 1);
    assert.equal(kinds.at(-1), "error");
    assert.equal(isRetryableAssistantError(message), false);
    for (const pid of await r.spawns()) assert.equal(alive(pid), false);
  }));

test("a thinking block already streamed is never asked for again", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } });
  }, async (r) => {
    const message = await r.run();
    assert.equal(message.stopReason, "error");
    assert.equal(r.attempts(), 1);
    assert.match(message.errorMessage ?? "", /cannot be taken back/);
    assert.equal(r.events.filter((event) => event.type === "thinking_start").length, 1);
  }));

test("message_stop and then Claude Code hangs: the turn finishes from the received reply and the API is asked once", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, textStart, textDelta("answer"), ...FINISH);
    response.end();
  }, async (r) => {
    const lines: string[] = [];
    setClaudeCodeDiagnosticReporter((line) => lines.push(line));
    const message = await r.run({ HANG_AFTER_REPLY: "1" });
    assert.equal(message.stopReason, "stop", String(message.errorMessage));
    assert.equal(textOf(message), "answer");
    assert.equal(r.attempts(), 1, "a complete reply is never paid for twice");
    const pids = await r.spawns();
    assert.equal(pids.length, 1);
    assert.equal(alive(pids[0]!), false, "the hung process was dropped, not reused");
    assert.ok(lines.some((line) => /whole reply/.test(line)), JSON.stringify(lines));
    const kinds = r.events.map((event) => event.type);
    assert.equal(kinds.filter((kind) => kind === "text_delta").length, 1);
    assert.equal(kinds.at(-1), "done");
  }));

test("hangs after message_stop: usage, tool arguments and stop reason come out right from the relay's capture", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(
      response,
      START,
      textStart, textDelta("let me "), textDelta("look"), { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__pi__lookup", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"query\":\"ab" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "c\",\"limit\"" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: ":3}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    );
    response.end();
  }, async (r) => {
    const tool = { name: "lookup", description: "look something up", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } } };
    const context = {
      messages: [
        { role: "system", content: "", toolsAdded: [tool], timestamp: 0 },
        { role: "user", content: "hi", timestamp: Date.now() },
      ],
    } as unknown as Context;
    const message = await r.run({ HANG_AFTER_REPLY: "1" }, context);
    assert.equal(message.stopReason, "toolUse", String(message.errorMessage));
    assert.equal(message.usage.input, 1);
    assert.equal(message.usage.output, 7, "message_delta's count replaces message_start's 1");
    assert.equal(message.usage.totalTokens, 8);
    assert.equal(textOf(message), "let me look");
    const calls = message.content.filter((block) => block.type === "toolCall") as Array<{ name: string; arguments: unknown }>;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "lookup");
    assert.deepEqual(calls[0]!.arguments, { query: "abc", limit: 3 });
    assert.equal(r.attempts(), 1, "a complete reply is never paid for twice");
    assert.equal(r.events.at(-1)?.type, "done");
    const pids = await r.spawns();
    assert.equal(alive(pids[0]!), false);
  }));

test("canRestart is asked again right before the restart: output that arrived during the backoff ends the turn, no second send", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, { type: "ping" }); // first byte, then silence: a stall with nothing shown yet
  }, async (r) => {
    let asked = 0;
    await assert.rejects(
      r.direct({ onEvent: () => {}, canRestart: () => (asked += 1) === 1 }), // true at the stall, false once the backoff and the acquisition are over
      /cannot be taken back/,
    );
    assert.equal(asked, 2, "asked at the stall and again right before the restart");
    assert.equal(r.attempts(), 1, "the request was not sent again");
    const pids = await r.spawns();
    // The second process was started and dropped at once: it may be gone before it logs its pid, so only the pids that were logged are checked.
    for (const pid of pids) assert.equal(alive(pid), false, "no process is left running");
  }));

test("one request is sent at most 3 times across both retry layers: a connection that never answers", () =>
  rig(() => { /* never answers, on every send */ }, async (r) => {
    const message = await r.run();
    assert.equal(message.stopReason, "error");
    assert.equal(r.attempts(), MAX_REQUEST_SENDS, "was up to 9 (3 relay attempts x 3 processes)");
    assert.match(message.errorMessage ?? "", /already sent 3 times, the most one request is ever sent \(3\)/);
    assert.equal(isRetryableAssistantError(message), false);
  }));

test("sends are shared: one quiet retry, then one recovery, then no more", () =>
  rig((attempt, response) => {
    if (attempt === 1) return; // never answers: the relay's quiet retry sends again (send 2)
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (attempt === 2) { sse(response, START, { type: "ping" }); return; } // first byte, then silence: recovery (send 3)
    sse(response, START, textStart, textDelta("answer"), ...FINISH);
    response.end();
  }, async (r) => {
    const message = await r.run();
    assert.equal(message.stopReason, "stop", String(message.errorMessage));
    assert.equal(r.attempts(), 3);
    assert.equal((await r.spawns()).length, 2);
  }));

test("sends are shared: with two sends spent, a fresh process gets exactly one more and then the turn fails", () =>
  rig((attempt, response) => {
    if (attempt === 1) return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, { type: "ping" }); // silence after the first byte, on every later send
  }, async (r) => {
    const message = await r.run();
    assert.equal(message.stopReason, "error");
    assert.equal(r.attempts(), 3, "never a fourth send");
  }));

test("Escape during the backoff between recoveries stops the turn: aborted, no further request, no leftover child", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, { type: "ping" });
  }, async (r) => {
    const controller = new AbortController();
    // The recovery line is written right before the backoff starts.
    setClaudeCodeDiagnosticReporter((line) => { if (/asking again/.test(line)) controller.abort(new Error("operator pressed Escape")); });
    const message = await r.run({}, undefined, controller.signal);
    assert.equal(message.stopReason, "aborted");
    assert.equal(r.attempts(), 1, "no second request after Escape");
    assert.doesNotMatch(message.errorMessage ?? "", /stream idle limit exceeded/);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal((await r.spawns()).length, 1, "no replacement process was started");
    for (const pid of await r.spawns()) assert.equal(alive(pid), false);
  }));

test("Escape during a quiet stretch is an abort, not a stall, and nothing is recovered", () =>
  rig((_attempt, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse(response, START, { type: "ping" });
  }, async (r) => {
    const controller = new AbortController();
    later(500, () => controller.abort(new Error("operator pressed Escape")));
    const started = Date.now();
    const message = await r.run({}, undefined, controller.signal);
    assert.equal(message.stopReason, "aborted");
    assert.ok(Date.now() - started < 1_300, "ended at Escape, before the 1.4 s stall limit");
    assert.equal(r.attempts(), 1);
    assert.equal((await r.spawns()).length, 1);
  }));

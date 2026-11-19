import assert from "node:assert/strict";
import * as http from "node:http";
import { afterEach, test, vi } from "vitest";
import { TurnRelay } from "../../extensions/claude-code/turn-relay.ts";

vi.setConfig({ testTimeout: 40_000 });

const BODY = Buffer.alloc(8 * 1024 * 1024, 0x61);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    cleanups.push(() => { server.closeAllConnections(); server.close(); });
  });
}

const EVENTS = [
  { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
];

function newRelay(port: number, activity: () => void) {
  // Budget 5 s; the first-byte limit is 1 s, far shorter than the throttled upload below.
  const relay = new TurnRelay(`http://127.0.0.1:${port}`, 5_000, undefined, undefined, [], undefined, {
    PI_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS: "1000",
  });
  relay.beginTurn(undefined, undefined, [], activity);
  cleanups.push(() => relay.close());
  return relay;
}

test("a slow but moving upload longer than the first-byte limit completes with exactly one send", async () => {
  let requests = 0;
  let received = 0;
  const upstream = http.createServer((request, response) => {
    requests += 1;
    // About 2 MB/s: the whole body takes well over the 1 s first-byte limit, and no gap between reads does.
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      request.pause();
      setTimeout(() => request.resume(), 20);
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(EVENTS.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  const port = await listen(upstream);
  let touches = 0;
  const relay = newRelay(port, () => { touches += 1; });
  const baseUrl = await relay.start();
  const started = Date.now();
  const reply = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: BODY });
  await reply.text();
  await relay.settled();
  const elapsed = Date.now() - started;
  assert.ok(elapsed > 1_500, `the upload must outlast the 1 s limit to prove anything (took ${elapsed} ms)`);
  assert.equal(reply.status, 200, String(relay.failureDetail));
  assert.equal(requests, 1, "a moving upload is never sent again");
  assert.equal(relay.attempts, 1);
  assert.equal(relay.retries, 0);
  assert.equal(received, BODY.length);
  assert.equal(relay.waitFailure, undefined);
  assert.ok(touches > 5, `upload progress counts as activity for the outer idle limit (${touches} touches)`);
});

test("a body that stops mid-upload fails with the named cause and is not sent again", async () => {
  let requests = 0;
  const upstream = http.createServer((request) => {
    requests += 1;
    let first = true;
    request.on("data", () => {
      if (first) { first = false; request.pause(); } // reads one chunk, then never reads or answers again
    });
  });
  const port = await listen(upstream);
  const relay = newRelay(port, () => {});
  const baseUrl = await relay.start();
  const started = Date.now();
  const reply = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: BODY });
  await reply.text();
  await relay.settled();
  assert.equal(reply.status, 502);
  assert.equal(requests, 1, "a stalled upload is never resent");
  assert.equal(relay.attempts, 1);
  const failure = relay.waitFailure;
  assert.ok(failure, "the stall is a named wait failure");
  assert.equal(failure.uploadStalled, true);
  assert.equal(failure.kind, undefined, "not an idle silence: recovery must not send the body again");
  assert.match(failure.message, /request upload stalled at \d+\.\d MB of 8\.0 MB/);
  assert.ok(Date.now() - started < 8_000);
});

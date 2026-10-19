import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "vitest";
import { TurnRelay } from "../../extensions/claude-code/turn-relay.ts";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      resolve(address.port);
    });
  });
}

test("relays one upstream Messages request and captures its SSE response", async () => {
  const upstreamBodies: string[] = [];
  const upstreamBetas: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    upstreamBodies.push(body);
    upstreamBetas.push(String(request.headers["anthropic-beta"] ?? ""));
    response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test" });
    const usage = {
      input_tokens: 2,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const events = [
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
      { type: "message_stop" },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const upstreamPort = await listen(upstream);
  const observed: string[] = [];
  const relay = new TurnRelay(
    `http://127.0.0.1:${upstreamPort}`,
    5_000,
    (event) => observed.push(event.type),
    (body) => Buffer.from(JSON.stringify({ ...JSON.parse(body.toString("utf8")), rewritten: true })),
    ["native-tools-test"],
  );

  try {
    const baseUrl = await relay.start();
    const first = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "anthropic-beta": "existing-test" },
      body: "{}",
    });
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(second.status, 400);
    await relay.settled();

    assert.equal(upstreamBodies.length, 1);
    assert.deepEqual(JSON.parse(upstreamBodies[0]!), { rewritten: true });
    assert.deepEqual(JSON.parse(relay.originalRequestBody!.toString("utf8")), {});
    assert.equal(upstreamBetas[0], "existing-test,native-tools-test");
    assert.equal(relay.used, true);
    assert.equal(relay.denied, 1);
    assert.equal(relay.capture.complete, true);
    assert.equal(relay.capture.message?.content[0]?.type, "text");
    assert.equal((relay.capture.message?.content[0] as { text: string }).text, "hello");
    assert.equal(relay.requestId, "req_test");
    assert.deepEqual(observed.at(-1), "message_stop");

    relay.finishTurn();
    const nextObserved: string[] = [];
    relay.beginTurn((event) => nextObserved.push(event.type));
    const next = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: '{"turn":2}' });
    assert.equal(next.status, 200);
    await next.text();
    await relay.settled();
    assert.equal(upstreamBodies.length, 2);
    assert.deepEqual(JSON.parse(upstreamBodies[1]!), { turn: 2 });
    assert.equal(relay.denied, 0);
    assert.equal(relay.capture.complete, true);
    assert.equal(nextObserved.at(-1), "message_stop");
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("surfaces an error event from an otherwise successful SSE stream", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const usage = { input_tokens: 2, output_tokens: 0 };
    response.end(
      [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } })}\n\n`,
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
      ].join(""),
    );
  });
  const upstreamPort = await listen(upstream);
  const relay = new TurnRelay(`http://127.0.0.1:${upstreamPort}`, 5_000);

  try {
    const baseUrl = await relay.start();
    const response = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    await response.text();
    await relay.settled();

    assert.equal(relay.capture.complete, false);
    assert.equal(relay.errorText(), "overloaded_error: Overloaded");
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

const OK_EVENTS = (() => {
  const usage = { input_tokens: 2, output_tokens: 1 };
  return [
    { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
    { type: "message_stop" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
})();
const FAST = { attempts: 3, baseDelayMs: 1 };

async function relayWith(
  script: Array<(request: http.IncomingMessage, response: http.ServerResponse) => void>,
) {
  let calls = 0;
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    script[Math.min(calls++, script.length - 1)]!(request, response);
  });
  const port = await listen(upstream);
  const relay = new TurnRelay(`http://127.0.0.1:${port}`, 5_000, undefined, undefined, [], FAST);
  const baseUrl = await relay.start();
  const send = async () => {
    const response = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    const text = await response.text().catch(() => "");
    await relay.settled();
    return { status: response.status, text };
  };
  const close = async () => {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  };
  return { relay, send, close, calls: () => calls };
}

const ok = (_request: http.IncomingMessage, response: http.ServerResponse) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(OK_EVENTS);
};
const overloaded = (_request: http.IncomingMessage, response: http.ServerResponse) => {
  response.writeHead(529, { "content-type": "application/json" });
  response.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
};

test("retries a transient 529 and a dropped connection before any output", async () => {
  const dropped = (request: http.IncomingMessage) => request.socket.destroy();
  const harness = await relayWith([overloaded, dropped, ok]);
  try {
    const result = await harness.send();
    assert.equal(result.status, 200);
    assert.equal(harness.calls(), 3);
    assert.equal(harness.relay.retries, 2);
    assert.equal(harness.relay.capture.complete, true);
    assert.equal(harness.relay.failure, undefined);
  } finally {
    await harness.close();
  }
});

test("retries a stream that dies before its first byte", async () => {
  const dieAfterHeaders = (_request: http.IncomingMessage, response: http.ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    setTimeout(() => response.socket?.destroy(), 5);
  };
  const harness = await relayWith([dieAfterHeaders, ok]);
  try {
    const result = await harness.send();
    assert.equal(result.status, 200);
    assert.equal(harness.relay.retries, 1);
    assert.equal(harness.relay.capture.complete, true);
  } finally {
    await harness.close();
  }
});

test("gives up after the bounded attempts and reports the upstream status", async () => {
  const harness = await relayWith([overloaded]);
  try {
    const result = await harness.send();
    assert.equal(result.status, 529);
    assert.equal(harness.calls(), 3);
    assert.equal(harness.relay.status, 529);
    assert.match(harness.relay.errorText(), /Overloaded/u);
  } finally {
    await harness.close();
  }
});

test("never retries client, auth or billing errors", async () => {
  for (const status of [400, 401, 403, 429]) {
    const harness = await relayWith([
      (_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end('{"type":"error","error":{"type":"x","message":"nope"}}');
      },
      ok,
    ]);
    try {
      const result = await harness.send();
      assert.equal(result.status, status);
      assert.equal(harness.calls(), 1, `status ${status} must not be retried`);
      assert.equal(harness.relay.retries, 0);
    } finally {
      await harness.close();
    }
  }
});

test("does not retry after output reached Claude Code and names the cause", async () => {
  const dieMidStream = (_request: http.IncomingMessage, response: http.ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(OK_EVENTS.slice(0, 80));
    setTimeout(() => response.socket?.destroy(), 5);
  };
  const harness = await relayWith([dieMidStream, ok]);
  try {
    await harness.send();
    assert.equal(harness.calls(), 1);
    assert.equal(harness.relay.capture.complete, false);
    assert.ok(harness.relay.failure);
    assert.match(harness.relay.failureDetail ?? "", /stage streaming, attempt 1 of 3/u);
  } finally {
    await harness.close();
  }
});

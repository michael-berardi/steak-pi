import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "vitest";
import { TurnRelay } from "../../extensions/claude-code/turn-relay.ts";

async function fixture(mode: "headers" | "first-byte" | "trickle", check: (relay: TurnRelay, url: string) => Promise<void>) {
  const timers = new Set<NodeJS.Timeout>();
  const upstream = http.createServer(async (request, response) => {
    for await (const _ of request) { /* consume fixture input */ }
    if (mode === "headers") return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    if (mode === "trickle") {
      const timer = setInterval(() => response.write(": keepalive\n\n"), 15);
      timers.add(timer);
      response.on("close", () => { clearInterval(timer); timers.delete(timer); });
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const relay = new TurnRelay(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, 120, undefined, undefined, [], { attempts: 1, baseDelayMs: 1 });
  try { await check(relay, await relay.start()); }
  finally {
    await relay.close();
    for (const timer of timers) clearInterval(timer);
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}

for (const mode of ["headers", "first-byte", "trickle"] as const) {
  test(`relay bounds ${mode} waits, even if the upstream socket never closes`, async () => fixture(mode, async (relay, url) => {
    const started = Date.now();
    try {
      const response = await fetch(`${url}/v1/messages`, { method: "POST", body: "{}", signal: AbortSignal.timeout(1_500) });
      await response.text();
    } catch { /* a truncated downstream stream is expected */ }
    await relay.settled();
    assert.ok(Date.now() - started < 1_000, "relay did not enforce its own deadline");
    assert.match(relay.failureDetail ?? "", /timed out/);
  }));
}

test("relay bounds a request whose body is never finished", async () => {
  const relay = new TurnRelay("http://127.0.0.1:1", 100);
  const url = await relay.start();
  const client = http.request(`${url}/v1/messages`, { method: "POST" });
  client.on("error", () => {});
  try {
    client.write("{");
    await new Promise(resolve => setTimeout(resolve, 250));
    await relay.settled();
    assert.match(relay.failureDetail ?? "", /timed out/);
    assert.equal(relay.stage, "read-body");
  } finally { client.destroy(); await relay.close(); }
});

test("drain rejects a pre-closed response and times out an open pipe that never drains", async () => {
  const relay = new TurnRelay("http://127.0.0.1:1", 50);
  const drain = (response: EventEmitter) => (relay as unknown as { waitForDrain(response: EventEmitter): Promise<void> }).waitForDrain(response);
  const closed = Object.assign(new EventEmitter(), { destroyed: true });
  const stuck = new EventEmitter();
  try {
    await assert.rejects(drain(closed), /disconnected/);
    await assert.rejects(drain(stuck), /drain timed out/);
    for (const event of ["drain", "close", "error"]) {
      assert.equal(closed.listenerCount(event), 0);
      assert.equal(stuck.listenerCount(event), 0);
    }
  } finally { await relay.close(); }
});

test("relay startup honours an already-aborted request without leaving a listener", async () => {
  const relay = new TurnRelay("http://127.0.0.1:1", 100);
  const controller = new AbortController();
  controller.abort(new Error("startup cancelled"));
  try { await assert.rejects(relay.start(controller.signal), /startup cancelled/); }
  finally { await relay.close(); }
  const server = (relay as unknown as { server: http.Server }).server;
  assert.equal(server.listening, false);
});

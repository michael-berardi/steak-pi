import { describe, expect, it } from "vitest";
import {
  RelayBroker,
  RUN_BROADCAST_TARGET,
  type RelaySendInput,
} from "../src/subagents/relay.ts";
import { USAP_VERSION } from "../src/subagents/types.ts";

function makeBroker(options: ConstructorParameters<typeof RelayBroker>[0] = {}) {
  let now = 1_000;
  return new RelayBroker({ ...options, now: () => now++ });
}

describe("subagent relay broker", () => {
  it("routes direct messages within their run namespace", () => {
    const broker = makeBroker();
    broker.createRun("run-a", ["alice", "bob"]);
    broker.createRun("run-b", ["alice", "bob"]);
    const aliceA = broker.bind("run-a", "alice");
    const bobA = broker.bind("run-a", "bob");
    const bobB = broker.bind("run-b", "bob");

    const sent = aliceA.send({ to: "bob", kind: "request", body: "review this" });
    expect(sent).toMatchObject({ ok: true, status: "queued", accepted: 1, queued: 1 });
    expect(bobB.inbox().messages).toEqual([]);
    expect(bobA.inbox().messages).toEqual([
      expect.objectContaining({
        version: USAP_VERSION,
        runId: "run-a",
        id: "run-a:1",
        seq: 1,
        from: "alice",
        to: "bob",
        kind: "request",
        body: "review this",
        createdAt: 1_000,
      }),
    ]);
  });

  it("accepts only replies correlated to the original request parties", () => {
    const broker = makeBroker();
    broker.createRun("replies", ["alice", "bob", "mallory"]);
    const alice = broker.bind("replies", "alice");
    const bob = broker.bind("replies", "bob");
    const mallory = broker.bind("replies", "mallory");
    const request = alice.send({ to: "bob", kind: "request", body: "review" });
    expect(request.ok).toBe(true);
    const requestId = request.ok ? request.ids[0] : "";

    expect(bob.send({ to: "alice", kind: "reply", body: "missing" }))
      .toMatchObject({ ok: false, code: "invalid_reply" });
    expect(mallory.send({ to: "alice", kind: "reply", replyTo: requestId, body: "spoof" }))
      .toMatchObject({ ok: false, code: "invalid_reply" });
    expect(bob.send({ to: "mallory", kind: "reply", replyTo: requestId, body: "wrong target" }))
      .toMatchObject({ ok: false, code: "invalid_reply" });
    expect(bob.send({ to: "alice", kind: "reply", replyTo: requestId, body: "approved" }))
      .toMatchObject({ ok: true });
    expect(bob.send({ to: "alice", kind: "reply", replyTo: requestId, body: "duplicate" }))
      .toMatchObject({ ok: false, code: "invalid_reply" });
    expect(alice.send({ to: "bob", kind: "message", replyTo: requestId, body: "mis-typed" }))
      .toMatchObject({ ok: false, code: "invalid_reply" });
    expect(alice.inbox().messages[0]).toMatchObject({
      from: "bob", kind: "reply", replyTo: requestId, body: "approved",
    });
  });

  it("broadcasts to every other peer and lists peers deterministically", () => {
    const broker = makeBroker();
    broker.createRun("r", ["a", "b", "c"]);
    const a = broker.bind("r", "a");
    const b = broker.bind("r", "b");
    const c = broker.bind("r", "c");

    expect(a.peers()).toEqual(["b", "c"]);
    expect(broker.listPeers("r")).toEqual(["a", "b", "c"]);
    expect(a.send({ to: RUN_BROADCAST_TARGET, body: "heads up" })).toMatchObject({
      ok: true,
      accepted: 2,
      queued: 2,
    });
    expect(a.inbox().messages).toEqual([]);
    expect(b.inbox().messages.map((message) => [message.seq, message.to])).toEqual([[1, "#run"]]);
    expect(c.inbox().messages.map((message) => [message.seq, message.to])).toEqual([[2, "#run"]]);
  });

  it("assigns monotonic sequence numbers and IDs and preserves inbox order", () => {
    const broker = makeBroker();
    broker.createRun("ordered", ["a", "b", "c"]);
    const a = broker.bind("ordered", "a");
    const b = broker.bind("ordered", "b");
    const c = broker.bind("ordered", "c");

    a.send({ to: "c", body: "one" });
    b.send({ to: "c", body: "two" });
    a.send({ to: "c", body: "three" });
    const messages = c.inbox().messages;
    expect(messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(messages.map((message) => message.id)).toEqual(["ordered:1", "ordered:2", "ordered:3"]);
    expect(messages.map((message) => message.body)).toEqual(["one", "two", "three"]);
  });

  it("drains inboxes in bounded pages and honors cursors", () => {
    const broker = makeBroker();
    broker.createRun("cursor", ["a", "b"]);
    const a = broker.bind("cursor", "a");
    const b = broker.bind("cursor", "b");
    for (const body of ["one", "two", "three", "four"]) a.send({ to: "b", body });

    const first = b.inbox(0, 2);
    expect(first.messages.map((message) => message.body)).toEqual(["one", "two"]);
    expect(first).toMatchObject({ nextSeq: 2, remaining: 2 });
    const second = b.inbox(first.nextSeq, 1);
    expect(second.messages.map((message) => message.body)).toEqual(["three"]);
    expect(second).toMatchObject({ nextSeq: 3, remaining: 1 });
    expect(b.inbox(4, 10)).toEqual({ messages: [], nextSeq: 4, remaining: 0 });
  });

  it("enforces body, mailbox, and run caps without consuming sequence IDs", () => {
    const broker = makeBroker({ bodyLimit: 3, mailboxLimit: 1, runLimit: 2 });
    broker.createRun("caps", ["a", "b", "c"]);
    const a = broker.bind("caps", "a");
    const b = broker.bind("caps", "b");
    const c = broker.bind("caps", "c");

    expect(a.send({ to: "b", body: "long" })).toMatchObject({ ok: false, code: "body_too_large" });
    expect(a.send({ to: "b", body: "one" })).toMatchObject({ ok: true, ids: ["caps:1"] });
    expect(a.send({ to: "b", body: "two" })).toMatchObject({ ok: false, code: "mailbox_full" });
    expect(a.send({ to: "c", body: "two" })).toMatchObject({ ok: true, ids: ["caps:2"] });
    b.inbox();
    c.inbox();
    expect(a.send({ to: "b", body: "end" })).toMatchObject({ ok: false, code: "run_full" });
  });

  it("validates targets and rejects self sends", () => {
    const broker = makeBroker();
    broker.createRun("targets", ["a", "b"]);
    const a = broker.bind("targets", "a");

    expect(a.send({ to: "b", body: "   " })).toMatchObject({ ok: false, code: "invalid_body" });
    expect(a.send({ to: "a", body: "no" })).toMatchObject({ ok: false, code: "self_send" });
    expect(a.send({ to: "missing", body: "no" })).toMatchObject({ ok: false, code: "invalid_target" });
    expect(a.send({ to: "", body: "no" })).toMatchObject({ ok: false, code: "invalid_target" });
  });

  it("binds sender identity immutably instead of accepting caller spoofing", () => {
    const broker = makeBroker();
    broker.createRun("identity", ["alice", "bob", "mallory"]);
    const alice = broker.bindSender("identity", "alice");
    const bob = broker.bind("identity", "bob");
    const spoofed = { to: "bob", body: "hello", from: "mallory" } as RelaySendInput;

    expect(Object.isFrozen(alice)).toBe(true);
    alice.send(spoofed);
    expect(bob.inbox().messages[0].from).toBe("alice");
  });

  it("delivers to active targets and queues when active delivery declines or fails", () => {
    const broker = makeBroker();
    broker.createRun("active", ["a", "b", "c"]);
    const received: string[] = [];
    const a = broker.bind("active", "a");
    const b = broker.bind("active", "b", (envelope) => {
      received.push(envelope.body);
    });
    const c = broker.bind("active", "c", () => {
      throw new Error("receiver unavailable");
    });

    expect(a.send({ to: "b", body: "live" })).toMatchObject({
      ok: true,
      status: "delivered",
      delivered: 1,
      queued: 0,
    });
    expect(received).toEqual(["live"]);
    expect(b.inbox().messages).toEqual([]);
    expect(a.send({ to: "c", body: "fallback" })).toMatchObject({
      ok: true,
      status: "queued",
      delivered: 0,
      queued: 1,
    });
    expect(c.inbox().messages.map((message) => message.body)).toEqual(["fallback"]);
  });

  it("cleans up runs and prevents stale bindings from entering recreated runs", () => {
    const broker = makeBroker();
    broker.createRun("temporary", ["a", "b"]);
    const staleA = broker.bind("temporary", "a");
    const staleB = broker.bind("temporary", "b");
    staleA.send({ to: "b", body: "old" });

    expect(broker.cleanupRun("temporary")).toBe(true);
    expect(broker.cleanupRun("temporary")).toBe(false);
    expect(staleB.inbox().messages).toEqual([]);
    expect(staleA.send({ to: "b", body: "late" })).toMatchObject({ ok: false, code: "closed" });

    broker.createRun("temporary", ["a", "b"]);
    const freshB = broker.bind("temporary", "b");
    expect(staleA.send({ to: "b", body: "spoof" })).toMatchObject({ ok: false, code: "closed" });
    expect(freshB.inbox().messages).toEqual([]);
  });
});

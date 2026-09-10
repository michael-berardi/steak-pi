import { describe, it, expect, vi } from "vitest";
import { readSync, unlinkSync, appendFileSync, chmodSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxConsumer, createPersistedReader, acceptedEntry, customMessage, persistedEntry, unixTransport, type Claim } from "../src/ultraterm-inbox.ts";
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});
const host = { version: 1 as const, pid: process.pid, sessionId: "pi-id", sessionFile: "/file", generation: "generation" };
const claim: Claim = { receiptId: "receipt", claimId: "claim", fromSessionId: "sender", toSessionId: "terminal", text: "exact\n\u2028 text" };
function harness() {
  let idle = true, valid = true, evidence: string | undefined, fail = "";
  const calls: any[] = [];
  const send = vi.fn();
  const transport = { request: vi.fn(async (r: any) => {
    calls.push(r);
    if (fail === r.cmd) { fail = ""; throw Error("lost response"); }
    if (r.cmd === "inbox.register") return { token: "private", terminalId: "terminal" };
    if (r.cmd === "inbox.poll") return { message: r.ready ? claim : null };
    return {};
  }) };
  const consumer = new InboxConsumer({ host, transport, idle: () => idle, current: () => valid, evidence: () => evidence, send });
  return { consumer, calls, send, transport, idle: (v: boolean) => idle = v, valid: (v: boolean) => valid = v, evidence: (v?: string) => evidence = v, fail: (v: string) => fail = v };
}
describe("native inbox state machine", () => {
  it("keeps busy messages on server; idle dispatch uses canonical followUp", async () => {
    const h = harness(); h.idle(false); await h.consumer.tick();
    expect(h.calls.at(-1).ready).toBe(false); expect(h.send).not.toHaveBeenCalled();
    h.idle(true); await h.consumer.tick();
    expect(h.send).toHaveBeenCalledWith(customMessage(claim), { deliverAs: "followUp", triggerTurn: true });
    expect(h.calls.some(r => r.cmd === "inbox.record")).toBe(false);
    h.consumer.stop();
  });
  it("void/no evidence and rejected sends never redispatch live pending calls", async () => {
    for (const reject of [false, true]) {
      const h = harness(); if (reject) h.send.mockImplementation(() => { throw Error("rejected"); });
      await h.consumer.tick(); await h.consumer.tick(); await h.consumer.tick();
      expect(h.send).toHaveBeenCalledTimes(1); expect(h.calls.some(r => r.cmd === "inbox.record")).toBe(false); h.consumer.stop();
    }
  });
  it("recovers persisted claims before sending, and retries lost record responses", async () => {
    const h = harness(); h.evidence("entry"); h.fail("inbox.record");
    await h.consumer.tick(); await h.consumer.tick();
    expect(h.send).not.toHaveBeenCalled(); expect(h.calls.filter(r => r.cmd === "inbox.record")).toHaveLength(2); h.consumer.stop();
  });
  it("lost poll response recovers a claim without duplicate dispatch", async () => {
    const h = harness(); h.fail("inbox.poll"); await h.consumer.tick(); await h.consumer.tick(); await h.consumer.tick();
    expect(h.send).toHaveBeenCalledTimes(1); h.consumer.stop();
  });
  it("records only when later persisted evidence arrives; duplicate never sends again", async () => {
    const h = harness(); await h.consumer.tick(); h.evidence("entry"); await h.consumer.tick(); await h.consumer.tick();
    expect(h.send).toHaveBeenCalledTimes(1); expect(h.calls.find(r => r.cmd === "inbox.record").entryId).toBe("entry"); h.consumer.stop();
  });
  it("wrong lifecycle identity does not register; shutdown aborts polling", async () => {
    const h = harness(); h.valid(false); await h.consumer.tick(); expect(h.calls).toHaveLength(0);
    const other = harness(); await other.consumer.tick(); other.consumer.stop(); const count = other.calls.length;
    await other.consumer.tick(); expect(other.calls).toHaveLength(count); expect(other.consumer.status).toBe("stopped");
  });
  it("ignores a response arriving after lifecycle shutdown", async () => {
    const h = harness(); let complete!: (v: any) => void;
    h.transport.request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const tick = h.consumer.tick(); h.consumer.stop(); complete({ token: "private", terminalId: "terminal" }); await tick;
    expect(h.send).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0);
  });
});
describe("persisted evidence", () => {
  it("requires exact custom_message file record and session identity; rejects corruption/symlinks/root escape", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-test-")));
    try {
      const dir = join(root, "cwd"); mkdirSync(dir, { mode: 0o700 }); const file = join(dir, "s.jsonl");
      const h = { ...host, sessionFile: file };
      const header = JSON.stringify({ type: "session", id: h.sessionId }) + "\n";
      writeFileSync(file, header, { mode: 0o600 }); expect(persistedEntry(h, claim, root)).toBeUndefined();
      const record = { type: "custom_message", id: "entry", ...customMessage(claim) };
      writeFileSync(file, header + JSON.stringify(record) + "\n"); expect(persistedEntry(h, claim, root)).toBe("entry");
      expect(() => persistedEntry({ ...h, sessionId: "wrong" }, claim, root)).toThrow();
      writeFileSync(file, header + JSON.stringify({ ...record, content: "tampered" }) + "\n"); expect(() => persistedEntry(h, claim, root)).toThrow();
      writeFileSync(file, header + "{broken\n"); expect(() => persistedEntry(h, claim, root)).toThrow();
      const link = join(dir, "link.jsonl"); symlinkSync(file, link); expect(() => persistedEntry({ ...h, sessionFile: link }, claim, root)).toThrow();
      expect(() => persistedEntry(h, claim, dir + "/other")).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("thin native adapter", () => {
  it("does not create socket traffic without registry proof; clears retry on lifecycle shutdown", async () => {
    vi.useFakeTimers();
    try {
      const { default: extension } = await import("../extensions/ultraterm-inbox.ts");
      const handlers = new Map<string, Function>();
      extension({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
      const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => host.sessionId, getSessionFile: () => host.sessionFile } };
      vi.stubEnv("ULTRATERM_SLOT", "");
      handlers.get("session_start")!({}, ctx);
      expect(vi.getTimerCount()).toBe(0);
      vi.stubEnv("ULTRATERM_SLOT", "1"); vi.stubEnv("TMUX_PANE", "%13");
      vi.stubEnv("NODE_ENV", "development");
      for (const flag of ["VITEST", "NODE_TEST_CONTEXT", "PI_WORKER", "PI_MIRROR", "ULTRATERM_MIRROR"]) vi.stubEnv(flag, "");
      handlers.get("session_start")!({}, ctx);
      await vi.advanceTimersByTimeAsync(2000);
      expect(vi.getTimerCount()).toBe(1);
      // A cancelled before-event must not strand a valid inbox consumer.
      for (const event of ["session_before_tree", "session_before_switch", "session_before_fork"]) expect(handlers.has(event)).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      handlers.get("session_tree")!({}, ctx); handlers.get("session_shutdown")!(); expect(vi.getTimerCount()).toBe(0);
      for (const mode of ["rpc", "json", "print"]) {
        handlers.get("session_start")!({}, { ...ctx, mode }); expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
});


it("Unix transport frames isolated requests and aborts a lost response", async () => {
  const { createServer } = await import("node:net");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-wire-")));
  const path = join(root, "utp.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.once("data", data => {
      const r = JSON.parse(data.toString());
      if (r.cmd === "test") socket.end(JSON.stringify({ ok: true, result: { message: null } }) + "\n");
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(path, resolve)); chmodSync(path, 0o600);
    const transport = unixTransport(path);
    expect(await transport.request({ cmd: "test" }, new AbortController().signal)).toEqual({ message: null });
    const controller = new AbortController();
    const pending = transport.request({ cmd: "lost" }, controller.signal);
    controller.abort(); await expect(pending).rejects.toThrow("stopped");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});


describe("bounded live histories", () => {
  function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "inbox-large-")));
    const dir = join(root, "cwd"); mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, "s.jsonl"), h = { ...host, sessionFile: file };
    const header = JSON.stringify({ type: "session", id: host.sessionId }) + "\n";
    const record = JSON.stringify({ type: "custom_message", id: "entry", ...customMessage(claim) }) + "\n";
    return { root, file, h, header, record };
  }
  it("supports >28 MiB, skips huge unrelated lines, and idle polls read only header", async () => {
    const f = fixture();
    try {
      writeFileSync(f.file, f.header, { mode: 0o600 });
      appendFileSync(f.file, '{"unrelated":"');
      for (let i = 0; i < 30; i++) appendFileSync(f.file, "x".repeat(1024 * 1024));
      appendFileSync(f.file, '"}\n');
      const offset = Buffer.byteLength(f.header) + 30 * 1024 * 1024 + Buffer.byteLength('{"unrelated":""}\n');
      appendFileSync(f.file, f.record);
      const reader = createPersistedReader(f.h, f.root);
      const send = vi.fn();
      const consumer = new InboxConsumer({ host: f.h, current: () => true, idle: () => true, send,
        evidence: reader, transport: { request: async r => r.cmd === "inbox.register" ? { token: "t", terminalId: "terminal" } : {} } });
      vi.mocked(readSync).mockClear();
      await consumer.tick(); await consumer.tick();
      expect(vi.mocked(readSync).mock.calls.every(c => Number((c as unknown[])[4]) < Buffer.byteLength(f.header))).toBe(true);
      expect(vi.mocked(readSync).mock.calls).toHaveLength(2 * Buffer.byteLength(f.header));
      consumer.stop();
      expect(reader(claim)).toEqual({ entryId: "entry", entryOffset: offset });
      // A cached offset is not proof after truncation/replacement.
      writeFileSync(f.file, f.header + f.record.replace('"entry"', '"other"'));
      expect(reader(claim)?.entryId).toBe("other");
      writeFileSync(f.file, f.header + f.record.replace('"display":true', '"display":false'));
      expect(() => reader(claim)).toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("incrementally recovers an older receipt outside the tail", () => {
    const f = fixture();
    try {
      writeFileSync(f.file, f.header, { mode: 0o600 });
      const line = JSON.stringify({ unrelated: "x".repeat(65500) }) + "\n";
      for (let i = 0; i < 160; i++) appendFileSync(f.file, line);
      appendFileSync(f.file, f.record);
      for (let i = 0; i < 320; i++) appendFileSync(f.file, line);
      const reader = createPersistedReader(f.h, f.root);
      expect(reader(claim)).toBeUndefined();
      expect(reader(claim)?.entryId).toBe("entry");
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
  it("fresh proven intended file dispatches once; memory never ACKs; persistence wires offset", async () => {
    const f = fixture();
    try {
      expect(() => createPersistedReader(f.h, f.root)()).toThrow();
      const reader = createPersistedReader(f.h, f.root, true);
      expect(reader()).toBeUndefined();
      expect(() => createPersistedReader(f.h, f.root, () => false)()).toThrow();
      const calls: any[] = [], entries: unknown[] = [];
      const send = vi.fn(() => entries.push({ type: "custom_message", id: "entry", ...customMessage(claim) }));
      const make = () => new InboxConsumer({ host: f.h, current: () => true, idle: () => true, send, evidence: reader,
        accepted: m => acceptedEntry(entries, m), transport: { request: async r => {
          calls.push(r); return r.cmd === "inbox.register" ? { token: "t", terminalId: "terminal" }
            : r.cmd === "inbox.poll" ? { message: claim } : {};
        } } });
      const first = make(); await first.tick(); first.stop();
      const recovered = make(); await recovered.tick(); await recovered.tick();
      expect(send).toHaveBeenCalledTimes(1);
      expect(calls.some(c => c.cmd === "inbox.record")).toBe(false);
      writeFileSync(f.file, f.header + f.record, { mode: 0o600 });
      await recovered.tick();
      expect(calls.find(c => c.cmd === "inbox.record")).toMatchObject({ entryId: "entry", entryOffset: Buffer.byteLength(f.header) });
      recovered.stop();
      unlinkSync(f.file); expect(() => reader()).toThrow();
      writeFileSync(f.file, '{broken\n'); expect(() => reader()).toThrow();
      writeFileSync(f.file, '{"type":"session","id":"wrong"}\n'); expect(() => reader()).toThrow();
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import finishGuardExtension from "../extensions/finish-guard.ts";

type Handler = (event: any, ctx: any) => any;

function harness(branch: unknown[] = []) {
  const handlers = new Map<string, Handler>();
  const pi = { on(event: string, handler: Handler) { handlers.set(event, handler); return () => handlers.delete(event); } };
  finishGuardExtension(pi as unknown as ExtensionAPI);
  const ctx = { sessionManager: { getBranch: () => branch } };
  const fire = (name: string, event: any = {}) => handlers.get(name)!({ type: name, ...event }, ctx);
  const input = (text: string, source = "interactive") => fire("input", { text, source });
  const assistant = (text: string) => fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } });
  const todo = (items: Array<{ content: string; status: string; reason?: string }>, extra: any = {}) =>
    fire("tool_result", { toolName: "todo", isError: false, details: { state: { phases: [{ name: "p", items }] } }, ...extra });
  const settle = (event: any = {}) => fire("agent_before_settle", { outcome: "completed", entries: [], continue: false, ...event });
  return { handlers, ctx, fire, input, assistant, todo, settle };
}

const pending = (content: string) => ({ content, status: "pending" });

describe("finish guard extension", () => {
  const saved = { env: process.env.STEAK_PI_FINISH_GUARD, dir: process.env.PI_CODING_AGENT_DIR };
  let dir: string;
  beforeEach(() => {
    delete process.env.STEAK_PI_FINISH_GUARD;
    dir = mkdtempSync(join(tmpdir(), "steak-pi-finish-guard-ext-"));
    process.env.PI_CODING_AGENT_DIR = dir; // an empty agent dir: default settings
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.env === undefined) delete process.env.STEAK_PI_FINISH_GUARD; else process.env.STEAK_PI_FINISH_GUARD = saved.env;
    if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.dir;
  });

  it("registers only the events it needs", () => {
    expect([...harness().handlers.keys()].sort()).toEqual(["agent_before_settle", "input", "message_end", "session_start", "session_tree", "tool_result"]);
  });

  it("lets a finished turn settle", async () => {
    const h = harness();
    await h.input("fix it");
    await h.assistant("All done and verified.");
    expect(await h.settle()).toBeUndefined();
  });

  it("pushes on an open todo item with a custom_message entry and continue", async () => {
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("Disk to 70%")]);
    await h.assistant("Working on it.");
    const result = await h.settle();
    expect(result.continue).toBe(true);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ type: "custom_message", customType: "finish-guard", display: true });
    expect(result.entries[0].content).toContain("Disk to 70%");
  });

  it("keeps entries other handlers already proposed and skips when one already continues", async () => {
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("x")]);
    const earlier = { type: "custom", customType: "other", data: 1 };
    const result = await h.settle({ entries: [earlier] });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toBe(earlier);
    expect(await h.settle({ continue: true })).toBeUndefined();
  });

  it("pushes on a final reply that reports unfinished work, then only on the new reply", async () => {
    const h = harness();
    await h.input("fix it");
    await h.assistant("Shipped.\n\nStill not done: the docs.");
    expect((await h.settle()).entries[0].content).toContain("reports unfinished work");
    // The model finishes without writing text again: the stale reply no longer counts.
    expect(await h.settle()).toBeUndefined();
  });

  it("allows at most 3 pushes per operator message and resets on the next one", async () => {
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("x")]);
    for (let push = 0; push < 3; push++) expect((await h.settle()).continue, `push ${push + 1}`).toBe(true);
    expect(await h.settle()).toBeUndefined();
    await h.input("keep going");
    expect((await h.settle()).continue).toBe(true);
  });

  it("does not reset on messages other extensions send", async () => {
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("x")]);
    for (let push = 0; push < 3; push++) await h.settle();
    await h.input("smaller steps please", "extension");
    expect(await h.settle()).toBeUndefined();
  });

  it("never pushes after an abort or error", async () => {
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("x")]);
    expect(await h.settle({ outcome: "aborted" })).toBeUndefined();
    expect(await h.settle({ outcome: "error" })).toBeUndefined();
    expect((await h.settle()).continue).toBe(true);
  });

  it("never pushes when the operator asked to stop or only for an answer", async () => {
    const h = harness();
    await h.todo([pending("x")]);
    await h.input("HOLD everything");
    expect(await h.settle()).toBeUndefined();
    await h.input("just answer: why did it fail?");
    expect(await h.settle()).toBeUndefined();
  });

  it("follows the latest todo state: done items and external blockers end the turn", async () => {
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("a"), pending("b")]);
    await h.todo([{ content: "a", status: "done" }, { content: "b", status: "blocked", reason: "needs the 2FA code" }]);
    expect(await h.settle()).toBeUndefined();
    await h.todo([{ content: "a", status: "done" }, { content: "b", status: "blocked", reason: "too big for now" }]);
    expect((await h.settle()).entries[0].content).toContain("[blocked] b (blocked: too big for now)");
  });

  it("ignores other tools' results and failed todo calls", async () => {
    const h = harness();
    await h.input("fix it");
    await h.fire("tool_result", { toolName: "bash", isError: false, details: { state: { phases: [{ items: [pending("x")] }] } } });
    await h.todo([pending("y")], { isError: true });
    await h.fire("tool_result", { toolName: "todo", isError: false, details: undefined });
    expect(await h.settle()).toBeUndefined();
  });

  it("keeps an open plan across operator messages", async () => {
    const h = harness();
    await h.input("plan it");
    await h.todo([pending("x")]);
    await h.input("continue");
    expect((await h.settle()).continue).toBe(true);
  });

  it("does nothing when turned off by env", async () => {
    process.env.STEAK_PI_FINISH_GUARD = "0";
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("x")]);
    expect(await h.settle()).toBeUndefined();
  });

  it("reads enabled, maxPushes and message from steak-pi.json", async () => {
    writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ finishGuard: { maxPushes: 1, message: "Finish the plan." } }));
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("x")]);
    expect((await h.settle()).entries[0].content).toContain("FINISH GUARD: Finish the plan.");
    expect(await h.settle()).toBeUndefined();

    writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ finishGuard: false }));
    const off = harness();
    await off.input("fix it");
    await off.todo([pending("x")]);
    expect(await off.settle()).toBeUndefined();
  });

  it("picks up edited settings when the session reloads", async () => {
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("x")]);
    writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ finishGuard: false }));
    expect((await h.settle()).continue).toBe(true); // settings are not re-read on the hot path
    await h.fire("session_start", { reason: "startup" });
    await h.fire("session_start", { reason: "reload" });
    expect(await h.settle()).toBeUndefined();
  });

  it("rebuilds its state from the branch tip when a session becomes active", async () => {
    const branch = [
      { type: "message", message: { role: "user", content: "older request" } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { state: { phases: [{ items: [pending("old")] }] } } } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "fix it" }] } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { state: { phases: [{ items: [pending("current")] }] } } } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Looking." }] } },
      { type: "custom_message", customType: "finish-guard", content: "FINISH GUARD" },
      { type: "custom_message", customType: "finish-guard", content: "FINISH GUARD" },
      { type: "custom_message", customType: "other", content: "x" },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Still not done: the rest." }] } },
    ];
    const h = harness(branch);
    await h.fire("session_start", { reason: "resume" });
    const result = await h.settle();
    expect(result.entries[0].content).toContain("[pending] current");
    expect(result.entries[0].content).not.toContain("[pending] old");
    expect(result.entries[0].content).toContain("Still not done");
    expect(await h.settle()).toBeUndefined(); // two earlier pushes plus this one reach the cap
  });

  it("starts empty on a new session and survives an unreadable branch", async () => {
    const h = harness();
    await h.input("fix it");
    await h.todo([pending("x")]);
    h.ctx.sessionManager.getBranch = () => [];
    await h.fire("session_start", { reason: "new" });
    expect(await h.settle()).toBeUndefined();
    await h.todo([pending("x")]);
    h.ctx.sessionManager.getBranch = () => { throw new Error("unreadable"); };
    expect(() => h.fire("session_tree", {})).not.toThrow();
    expect(await h.settle()).toBeUndefined();
  });

  it("does not touch the filesystem or the branch at settle", async () => {
    const h = harness();
    let reads = 0;
    h.ctx.sessionManager.getBranch = () => { reads += 1; return []; };
    await h.input("fix it");
    await h.todo([pending("x")]);
    await h.assistant("Working.");
    await h.settle();
    expect(reads).toBe(0);
  });
});

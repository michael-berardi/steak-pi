import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import extension from "../extensions/agent-state.ts";
import { createIsolatedResourceLoader } from "../src/subagents/pi-worker.ts";
import { setSubagentCountReader, subagentActivityChanged } from "../src/tui/subagent-activity.ts";

describe("agent state writer", () => {
  let home: string; let handlers: Record<string, (event: any, ctx: any) => Promise<void>>; let ctx: any;
  let oldHome: string | undefined; let oldKey: string | undefined;
  const file = () => join(home, "agent-state", "pane.json");
  const state = () => JSON.parse(readFileSync(file(), "utf8"));
  const emit = async (name: string, event: any = {}) => handlers[name]?.(event, ctx);
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(100_000);
    home = mkdtempSync(join(process.cwd(), ".agent-state-test-")); oldHome = process.env.ULTRATERM_HOME; oldKey = process.env.ULTRATERM_TMUX_SESSION;
    process.env.ULTRATERM_HOME = home; process.env.ULTRATERM_TMUX_SESSION = "pane";
    handlers = {}; ctx = { hasUI: true, ui: { getEditorText: () => "", notify: vi.fn() }, sessionManager: { getSessionId: () => "native-id", getSessionFile: () => "/native.jsonl" } };
    setSubagentCountReader(() => 0);
  });
  afterEach(async () => {
    await emit("session_shutdown"); vi.useRealTimers(); rmSync(home, { recursive: true, force: true });
    if (oldHome === undefined) delete process.env.ULTRATERM_HOME; else process.env.ULTRATERM_HOME = oldHome;
    if (oldKey === undefined) delete process.env.ULTRATERM_TMUX_SESSION; else process.env.ULTRATERM_TMUX_SESSION = oldKey;
    setSubagentCountReader(() => 0);
  });
  function start() { extension({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any); }
  it("writes the contract, transitions, heartbeat and cleans up", async () => {
    start(); await emit("session_start");
    expect(state()).toMatchObject({ v: 1, pid: process.pid, sessionId: "native-id", sessionFile: "/native.jsonl", seq: 1, at: 100000, state: "idle", turn: { kind: "final", endedAt: null }, tools: 0, shellSince: null, subagents: 0, prompt: false, inputEmpty: true, error: null });
    expect(statSync(file()).mode & 0o777).toBe(0o600); expect(statSync(join(home, "agent-state")).mode & 0o777).toBe(0o700);
    expect(Buffer.byteLength(readFileSync(file()))).toBeLessThanOrEqual(4096);
    expect(readdirSync(join(home, "agent-state"))).toEqual(["pane.json"]);
    await emit("agent_start"); expect(state().state).toBe("working");
    await emit("tool_execution_start", { toolCallId: "s", toolName: "bash" });
    expect(state().shellSince).toBe(100000); vi.advanceTimersByTime(60000); expect(state().state).toBe("waiting");
    await emit("tool_execution_end", { toolCallId: "s", toolName: "bash" });
    await emit("tool_execution_start", { toolCallId: "u", toolName: "ultraterm_subagents" });
    setSubagentCountReader(() => 2); subagentActivityChanged(); expect(state()).toMatchObject({ state: "waiting", subagents: 2 });
    await emit("ui_prompt_start"); expect(state()).toMatchObject({ state: "asking", prompt: true });
    await emit("ui_prompt_end"); await emit("tool_execution_end", { toolCallId: "u", toolName: "ultraterm_subagents" });
    // Between turns, with subagents still in flight, the parent waits on them (not idle, not working).
    expect(state()).toMatchObject({ state: "waiting", subagents: 2 });
    setSubagentCountReader(() => 0); subagentActivityChanged();
    await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "secret" } });
    await emit("agent_settled"); expect(state()).toMatchObject({ state: "error", error: "Agent run failed", turn: { kind: "error" } });
    expect(readFileSync(file(), "utf8")).not.toContain("secret");
    await emit("agent_start"); await emit("agent_settled"); expect(state()).toMatchObject({ state: "idle", turn: { kind: "final" } });
    const previous = state(); ctx.ui.getEditorText = () => "draft"; vi.advanceTimersByTime(10000);
    expect(state().at).toBeGreaterThan(previous.at); expect(state().seq).toBeGreaterThan(previous.seq); expect(state().inputEmpty).toBe(false);
    await emit("session_shutdown"); expect(existsSync(file())).toBe(false);
  });
  it.each([undefined, "../bad", "a".repeat(81)])("refuses unmanaged or invalid key %s", async key => {
    if (key === undefined) delete process.env.ULTRATERM_TMUX_SESSION; else process.env.ULTRATERM_TMUX_SESSION = key;
    start(); await emit("session_start"); expect(readdirSync(home)).toEqual([]);
  });
  it("refuses symlink destinations and reports errors once", async () => {
    symlinkSync(home, join(home, "agent-state")); start(); await emit("session_start"); vi.advanceTimersByTime(20000);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1); expect(existsSync(join(home, "pane.json"))).toBe(false);
  });
  it("excludes all extensions from isolated worker resources", () => {
    expect(createIsolatedResourceLoader("task").getExtensions().extensions).toEqual([]);
  });
});

import { constants, chmodSync, closeSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initialCompanionState, reduceCompanionState, type CompanionAction } from "../src/tui/model.ts";
import { getSubagentCount, onSubagentActivityChanged } from "../src/tui/subagent-activity.ts";

// Reject symlink components, including an existing target. The exclusive, no-follow
// temporary open also prevents an attacker-provided temporary file being opened.
function checkPath(path: string): void {
  const absolute = resolve(path); const root = parse(absolute).root;
  let part = root;
  for (const name of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    part = join(part, name);
    try { if (lstatSync(part).isSymbolicLink()) throw new Error("symlink refused"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export default function agentStateExtension(pi: ExtensionAPI): void {
  const key = process.env.ULTRATERM_TMUX_SESSION;
  if (!key || !/^[A-Za-z0-9._-]{1,80}$/.test(key)) return;
  const dir = join(process.env.ULTRATERM_HOME || join(homedir(), ".ultraterm"), "agent-state");
  const path = join(dir, `${key}.json`); const tmp = `${path}.tmp`;
  let state = initialCompanionState();
  let ctx: ExtensionContext | undefined;
  let seq = 0; let reported = false; let closed = false;
  let turn: { kind: "running" | "final" | "error" | "aborted"; endedAt: number | null } = { kind: "final", endedAt: null };
  const shells = new Map<string, number>();
  const report = () => {
    if (reported) return; reported = true;
    try { if (ctx?.hasUI) ctx.ui.notify("Agent state file could not be written", "warning"); else process.stderr.write("Agent state file could not be written\n"); } catch { /* never interrupt Pi */ }
  };
  const write = () => {
    if (!ctx || closed) return;
    let fd: number | undefined; let ownTmp = false;
    try {
      const now = Date.now(); const subagents = getSubagentCount();
      const tools = Object.values(state.activeTools); const shellSince = shells.size ? Math.min(...shells.values()) : null;
      const prompt = state.promptDepth > 0;
      // Waiting: a shell running a minute or more, or subagents in flight while the parent itself does nothing else (between
      // turns, or only in a subagent/hub call). The rail shows these as yellow, not as working or idle.
      const onlyDelegating = tools.every(name => name === "ultraterm_subagents" || name === "ultraterm_hub");
      const waiting = (shellSince !== null && now - shellSince >= 60_000) || (subagents > 0 && onlyDelegating && turn.kind !== "error");
      // An error that ended the run wins over waiting: the human must see it.
      const activity = prompt ? "asking" : !state.agentActive && turn.kind === "error" ? "error" : waiting ? "waiting" : state.agentActive ? "working" : "idle";
      let inputEmpty: boolean | null = null;
      try { const text = ctx.ui.getEditorText(); if (typeof text === "string") inputEmpty = text === ""; } catch { /* unavailable */ }
      const data = JSON.stringify({ v: 1, pid: process.pid, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null, seq: ++seq, at: now, state: activity, turn, tools: tools.length, shellSince, subagents, prompt, inputEmpty, error: turn.kind === "error" ? "Agent run failed" : null });
      if (Buffer.byteLength(data) > 4096) throw new Error("state too large");
      checkPath(dir); mkdirSync(dir, { recursive: true, mode: 0o700 }); checkPath(dir); chmodSync(dir, 0o700);
      checkPath(path); checkPath(tmp);
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); ownTmp = true;
      writeFileSync(fd, data); closeSync(fd); fd = undefined;
      checkPath(dirname(path)); checkPath(path); renameSync(tmp, path); ownTmp = false;
    } catch { report(); }
    finally { if (fd !== undefined) try { closeSync(fd); } catch {} if (ownTmp) try { unlinkSync(tmp); } catch {} }
  };
  const update = (action: CompanionAction, context: ExtensionContext) => { ctx = context; state = reduceCompanionState(state, action); write(); };
  const cleanup = () => { if (closed) return; closed = true; clearInterval(timer); unsubscribe(); process.removeListener("exit", cleanup); try { checkPath(path); unlinkSync(path); } catch {} };
  const unsubscribe = onSubagentActivityChanged(write);
  const timer = setInterval(write, 10_000); timer.unref();
  process.once("exit", cleanup);
  pi.on("session_start", async (_event, context) => { ctx = context; state = initialCompanionState(); shells.clear(); turn = { kind: "final", endedAt: null }; write(); });
  pi.on("agent_start", async (_event, context) => { turn = { kind: "running", endedAt: null }; shells.clear(); update({ type: "agent_start" }, context); });
  pi.on("message_end", async (event, context) => { if (event.message.role === "assistant" && (event.message.stopReason === "error" || event.message.stopReason === "aborted")) { turn = { kind: event.message.stopReason, endedAt: Date.now() }; update({ type: "message_error", aborted: event.message.stopReason === "aborted" }, context); } });
  pi.on("turn_end", async (event, context) => { if (event.message.role === "assistant" && (event.message.stopReason === "error" || event.message.stopReason === "aborted")) { turn = { kind: event.message.stopReason, endedAt: Date.now() }; update({ type: "message_error", aborted: event.message.stopReason === "aborted" }, context); } else write(); });
  pi.on("tool_execution_start", async (event, context) => { if (event.toolName === "bash" || event.toolName === "shell") shells.set(event.toolCallId, Date.now()); update({ type: "tool_start", id: event.toolCallId, name: event.toolName }, context); });
  pi.on("tool_execution_end", async (event, context) => { shells.delete(event.toolCallId); update({ type: "tool_end", id: event.toolCallId, name: event.toolName }, context); });
  pi.on("ui_prompt_start", async (_event, context) => update({ type: "prompt_start" }, context));
  pi.on("ui_prompt_end", async (_event, context) => update({ type: "prompt_end" }, context));
  pi.on("agent_settled", async (_event, context) => { if (turn.kind === "running") turn = { kind: "final", endedAt: Date.now() }; shells.clear(); update({ type: "settled" }, context); });
  pi.on("session_shutdown", async () => cleanup());
}

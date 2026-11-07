import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
const parentOf = (pid: number): number | undefined => {
  try {
    const value = Number.parseInt(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
};
/** When `pid` started (`ps` lstart), the identity that tells a live process from a later one that reused its PID. */
const startOf = (pid: number): string | undefined => {
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined; } catch { return undefined; }
};
const WALK_BUDGET_MS = 3000;
/** Is `pid` a live process above this one? The ppid chain is walked at most 64 steps and `WALK_BUDGET_MS`
 * (a hung `ps` must not stall the agent for the sum of its timeouts). */
function isLiveAncestor(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || !isAlive(pid)) return false;
  let current: number | undefined = process.ppid;
  const until = Date.now() + WALK_BUDGET_MS;
  for (let step = 0; step < 64 && current !== undefined && current > 1 && Date.now() < until; step++) {
    if (current === pid) return true;
    current = parentOf(current);
  }
  return false;
}
/** The state file belongs to the pane's top-level agent. A nested pi (a `pi -p` run from a bash tool) inherits the pane's key. */
function ownedByAncestor(path: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; pidStart?: unknown };
    // A PID that now belongs to a different process (reused after a crash) does not own the file, even above this process.
    if (typeof owner.pidStart === "string" && startOf(Number(owner.pid)) !== owner.pidStart) return false;
    return isLiveAncestor(Number(owner.pid));
  } catch { return false; }
}
const failureDetail = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const text = code ?? (error instanceof Error ? error.message : String(error));
  return text.replace(/\s+/g, " ").slice(0, 80);
};

/** Remove temp files a killed writer left (`<key>.json.<pid>.<hex>.tmp` with a dead PID, and the old fixed `<key>.json.tmp`). */
function sweepTemps(dir: string, key: string): void {
  try {
    checkPath(dir);
    for (const name of readdirSync(dir)) {
      const match = name === `${key}.json.tmp` ? [name, "0"] : new RegExp(`^${key.replace(/[.]/g, "\\.")}\\.json\\.(\\d+)\\.[0-9a-f]+\\.tmp$`).exec(name);
      if (!match) continue;
      const pid = Number(match[1]);
      if (pid > 0 && isAlive(pid)) continue;
      try { unlinkSync(join(dir, name)); } catch { /* best effort */ }
    }
  } catch { /* no directory yet, or not readable: nothing to sweep */ }
}

export default function agentStateExtension(pi: ExtensionAPI): void {
  const key = process.env.ULTRATERM_TMUX_SESSION;
  if (!key || !/^[A-Za-z0-9._-]{1,80}$/.test(key)) return;
  const dir = join(process.env.ULTRATERM_HOME || join(homedir(), ".ultraterm"), "agent-state");
  const path = join(dir, `${key}.json`);
  let nested = ownedByAncestor(path); // nested process: never writes, never warns, never removes the pane agent's file
  if (nested) return;
  const ownStart = startOf(process.pid);
  sweepTemps(dir, key);
  const tmpName = () => `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`; // unique per write: no leftover or second writer can block it
  let state = initialCompanionState();
  let ctx: ExtensionContext | undefined;
  let seq = 0; let reported = false; let closed = false;
  let turn: { kind: "running" | "final" | "error" | "aborted"; endedAt: number | null } = { kind: "final", endedAt: null };
  const shells = new Map<string, number>();
  const report = (error: unknown) => {
    if (reported) return; reported = true;
    const message = `Agent state file could not be written (${failureDetail(error)})`;
    try { if (ctx?.hasUI) ctx.ui.notify(message, "warning"); else process.stderr.write(`${message}\n`); } catch { /* never interrupt Pi */ }
  };
  const write = () => {
    if (!ctx || closed || nested) return;
    let fd: number | undefined; let ownTmp = false; const tmp = tmpName();
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
      const data = JSON.stringify({ v: 1, pid: process.pid, pidStart: ownStart ?? null, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null, seq: ++seq, at: now, state: activity, turn, tools: tools.length, shellSince, subagents, prompt, inputEmpty, error: turn.kind === "error" ? "Agent run failed" : null });
      if (Buffer.byteLength(data) > 4096) throw new Error("state too large");
      checkPath(dir); mkdirSync(dir, { recursive: true, mode: 0o700 }); checkPath(dir); chmodSync(dir, 0o700);
      checkPath(path); checkPath(tmp);
      fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); ownTmp = true;
      writeFileSync(fd, data); closeSync(fd); fd = undefined;
      checkPath(dirname(path)); checkPath(path); renameSync(tmp, path); ownTmp = false;
      reported = false; // a later success recovers silently; a new failure may warn again
    } catch (error) { report(error); }
    finally { if (fd !== undefined) try { closeSync(fd); } catch {} if (ownTmp) try { unlinkSync(tmp); } catch {} }
  };
  const update = (action: CompanionAction, context: ExtensionContext) => { ctx = context; state = reduceCompanionState(state, action); write(); };
  const cleanup = () => { if (closed) return; closed = true; clearInterval(timer); unsubscribe(); process.removeListener("exit", cleanup); try { checkPath(path); if (Number((JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid) === process.pid) unlinkSync(path); } catch {} };
  const unsubscribe = onSubagentActivityChanged(write);
  const timer = setInterval(() => { nested = ownedByAncestor(path); write(); }, 10_000); timer.unref();
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

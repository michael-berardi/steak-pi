/**
 * Finish guard: a turn may not end while the work the operator asked for is still open.
 *
 * Written rules ("never stop with open items") did not stop agents from marking items `blocked`
 * for reasons they could have worked on, or from ending with a "still not done" list. This turns the
 * rule into a check at the moment a turn ends. The pure decision lives here (no Pi imports, no file
 * reads, regexes compiled once); extensions/finish-guard.ts wires it to Pi and
 * src/finish-guard-hook.ts to the Claude Code Stop hook.
 *
 * It blocks only when something is open, at most `maxPushes` times per operator message, and never
 * when the operator asked to stop or hold or only wanted an answer.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GuardTodo { content: string; status: string; reason?: string; blockedReason?: string }
export interface GuardVerdict { block: boolean; reason: string }
export interface GuardSettings { enabled: boolean; maxPushes: number; message: string }

/** Names the push in transcripts; the Claude Code hook counts earlier pushes by it. */
export const FINISH_GUARD_MARK = "FINISH GUARD";
export const FINISH_GUARD_ENV = "STEAK_PI_FINISH_GUARD";
export const FINISH_GUARD_DEFAULT_MAX_PUSHES = 3;
export const FINISH_GUARD_DEFAULT_MESSAGE =
  "You are about to end the turn with requested work still open. Do not stop. Keep working until every item is done and verified. "
  + "Only a real external blocker may remain: then ask for exactly that one thing, with everything else finished.";
/** Only the tail of a long final reply is scanned for unfinished-work wording. */
const SCAN_LIMIT = 32_000;
const MAX_MESSAGE = 2_000;
const MAX_PUSH_CAP = 20;

/** A blocker an agent cannot solve itself: 2FA, an approval, a missing credential, payment, legal sign-off. */
const EXTERNAL_BLOCKER = /\b(?:2fa|two[- ]factor|otp|verification code|credential|password|api key|token expired|log ?in|sign[- ]in|payment|billing|spend|paid route|legal|sign-?off|approval card|operator approval|consent|physical|hardware)\b/i;

/** Wording that reports unfinished work instead of doing it. */
const OPEN_WORK: readonly RegExp[] = [
  /\bstill (?:not done|open|to do|left|pending|failing|unfixed|unresolved|broken)\b/i,
  /\bnot (?:done|fixed|finished|resolved|shipped|verified) yet\b/i,
  /\b(?:haven'?t|have not|didn'?t|did not) (?:fixed|fix|finished|finish|done|shipped|ship|verified|verify)\b/i,
  // The noun phrase alone also appears when describing things ("no longer counts as unfinished work"); it reports open work
  // only as a list header ("Remaining items:") or when the reply says it has some ("there are still open tasks").
  /\b(?:remaining|open|outstanding|unfinished) (?:items|work|tasks|issues)\s*:/i,
  /\b(?:still (?:have|has|got)|there (?:is|are)(?: still)?|we have|i have)\s+(?:some |a few |several |\d+ )?(?:remaining|open|outstanding|unfinished) (?:items|work|tasks|issues)\b/i,
  /\bleft to do\b/i,
  /\bnext (?:step|i'?ll|i will)\b/i,
  /\bwhat'?s left\b/i,
  /\bnot yet (?:fixed|done|addressed)\b/i,
];

/** The operator told the agent to stop or hold, or only wanted an answer: never force more work. */
const OPERATOR_STOP = /^\s*(?:hold|stop|pause)\b|\b(?:just|only) answer\b|\bdon'?t (?:do|change|touch) anything\b|\bno changes\b/i;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const DONE_STATUS = new Set(["done", "completed", "dropped", "cancelled"]);

/** The operator's own words: harness reminders and attached context are not the operator talking. */
export const operatorText = (text: string): string => (text || "").replace(SYSTEM_REMINDER, "").trim();

const blockedReasonOf = (item: GuardTodo): string => item.blockedReason || item.reason || "";

/** Items that still need work. `blocked` stays open unless its reason is a real external blocker. */
export function openTodos(items: readonly GuardTodo[]): GuardTodo[] {
  return items.filter((item) => {
    const status = (item.status || "").toLowerCase();
    if (DONE_STATUS.has(status)) return false;
    return !(status === "blocked" && EXTERNAL_BLOCKER.test(blockedReasonOf(item)));
  });
}

/** Quoted spans ("...", “...”, `...`) and code blocks are words being cited or shown, not the reply's own report. */
const QUOTED = /```[\s\S]*?```|`[^`\n]*`|"[^"\n]{0,200}"|“[^”\n]{0,200}”/g;

export function openWorkPhrases(text: string): string[] {
  const found: string[] = [];
  if (!text) return found;
  const scan = (text.length > SCAN_LIMIT ? text.slice(-SCAN_LIMIT) : text).replace(QUOTED, " ");
  for (const pattern of OPEN_WORK) {
    const match = pattern.exec(scan);
    if (match) found.push(match[0]);
  }
  return found;
}

/**
 * Decide whether the turn may end. `continuations` counts how often the guard already pushed this operator
 * request on; at `maxPushes` the turn ends anyway (no endless loop) and the agent must name the real blocker.
 */
export function finishVerdict(opts: {
  todos: readonly GuardTodo[]; finalText: string; lastUserText: string; continuations: number; maxPushes?: number; message?: string;
}): GuardVerdict {
  if (opts.continuations >= (opts.maxPushes ?? FINISH_GUARD_DEFAULT_MAX_PUSHES)) return { block: false, reason: "push cap reached" };
  const open = openTodos(opts.todos);
  const phrases = openWorkPhrases(opts.finalText);
  if (!open.length && !phrases.length) return { block: false, reason: "nothing open" };
  if (OPERATOR_STOP.test(operatorText(opts.lastUserText))) return { block: false, reason: "operator asked to stop or only answer" };
  const lines = [`${FINISH_GUARD_MARK}: ${opts.message || FINISH_GUARD_DEFAULT_MESSAGE}`];
  if (open.length) {
    lines.push("Open todo items:");
    for (const item of open) {
      const why = blockedReasonOf(item);
      lines.push(`- [${item.status}] ${item.content}${why ? ` (blocked: ${why})` : ""}`);
    }
    lines.push("A 'blocked' item counts as open unless its reason is a real external blocker (2FA, credential, payment/spend approval, legal sign-off).");
  }
  if (phrases.length) lines.push(`Your reply reports unfinished work instead of doing it: ${phrases.map((phrase) => `"${phrase}"`).join(", ")}.`);
  return { block: true, reason: lines.join("\n") };
}

/** Text of a message `content`: a string, or the text parts of a part list (Pi and Claude Code share this shape). */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") out = out ? `${out}\n${part.text}` : part.text;
  }
  return out;
}

/** Flatten a todo tool's `state.phases` into items; undefined when the value is not a phase list. */
export function todosOfPhases(phases: unknown): GuardTodo[] | undefined {
  if (!Array.isArray(phases)) return undefined;
  const items: GuardTodo[] = [];
  for (const phase of phases) {
    if (!phase || !Array.isArray(phase.items)) continue;
    for (const item of phase.items) {
      if (item && typeof item === "object") items.push({ content: String(item.content ?? ""), status: String(item.status ?? ""), reason: typeof item.reason === "string" ? item.reason : undefined });
    }
  }
  return items;
}

/** Pi's agent folder: PI_CODING_AGENT_DIR when set, else ~/.pi/agent. */
function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
}

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/**
 * Operator settings from `finishGuard` in `~/.pi/agent/steak-pi.json` (or steak-pi.json under PI_CODING_AGENT_DIR):
 * `false`, or `{ "enabled": true, "maxPushes": 3, "message": "..." }`. On by default; a missing or malformed
 * file keeps the defaults. STEAK_PI_FINISH_GUARD=0 turns it off whatever the file says.
 */
export function finishGuardSettings(path?: string): GuardSettings {
  const settings: GuardSettings = { enabled: true, maxPushes: FINISH_GUARD_DEFAULT_MAX_PUSHES, message: FINISH_GUARD_DEFAULT_MESSAGE };
  try {
    const raw = JSON.parse(readFileSync(path ?? join(agentDir(), "steak-pi.json"), "utf8"))?.finishGuard;
    if (raw === false) settings.enabled = false;
    else if (raw && typeof raw === "object") {
      if (raw.enabled === false) settings.enabled = false;
      if (Number.isInteger(raw.maxPushes) && raw.maxPushes >= 0) settings.maxPushes = Math.min(raw.maxPushes, MAX_PUSH_CAP);
      if (typeof raw.message === "string" && raw.message.trim()) settings.message = raw.message.trim().slice(0, MAX_MESSAGE);
    }
  } catch {
    // Missing or malformed settings keep the defaults.
  }
  if (OFF_VALUES.has((process.env[FINISH_GUARD_ENV] ?? "").trim().toLowerCase())) settings.enabled = false;
  return settings;
}

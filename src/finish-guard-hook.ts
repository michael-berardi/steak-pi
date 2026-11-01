/**
 * Claude Code Stop hook for the finish guard: `steak-pi finish-guard-hook`.
 *
 * Reads the hook JSON on stdin and prints `{"decision":"block","reason":...}` when the turn is about to
 * end with open work (same verdict as the Pi extension), or nothing. It never throws and always exits 0,
 * so a broken hook cannot trap a session.
 *
 * Transcripts reach hundreds of MB, so the file is read from the END: the last 512 KB first, then
 * further back only until the last operator message is found (see {@link tailLines}). Pushes counted,
 * the final reply and the latest TodoWrite list come from the lines after that message; when no
 * TodoWrite follows it, the latest one within the same 512 KB tail still counts.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FINISH_GUARD_MARK,
  finishGuardSettings,
  finishVerdict,
  operatorText,
  textOf,
  type GuardSettings,
  type GuardTodo,
} from "./finish-guard.ts";

export const TAIL_BYTES = 512 * 1024;
const MAX_WINDOW_BYTES = 8 * 1024 * 1024;
const MARK_SCAN = 600;
const INTERRUPTED = /^\[Request interrupted by user/;
const LOCAL_COMMAND_OUTPUT = /^<local-command-/;

/**
 * Yield the non-empty lines of a file newest first, reading backwards from the end in windows that
 * double (512 KB, 1 MB, ... capped at 8 MB). Splitting on the newline byte is safe for UTF-8, and a line
 * longer than the window is joined across windows. Stop iterating to stop reading.
 */
export function* tailLines(path: string, windowBytes = TAIL_BYTES): Generator<string> {
  const fd = openSync(path, "r");
  try {
    let position = fstatSync(fd).size;
    let size = windowBytes;
    let carry: Buffer = Buffer.alloc(0); // the older, incomplete part of the line cut by the window start
    while (position > 0) {
      const start = Math.max(0, position - size);
      const chunk = Buffer.allocUnsafe(position - start);
      for (let done = 0; done < chunk.length;) {
        const read = readSync(fd, chunk, done, chunk.length - done, start + done);
        if (read <= 0) break;
        done += read;
      }
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let from = 0;
      if (start > 0) {
        const firstNewline = data.indexOf(0x0a);
        if (firstNewline < 0) { carry = data; position = start; size = Math.min(size * 2, MAX_WINDOW_BYTES); continue; }
        carry = data.subarray(0, firstNewline);
        from = firstNewline + 1;
      } else {
        carry = Buffer.alloc(0);
      }
      let end = data.length;
      while (end > from) {
        const newline = data.lastIndexOf(0x0a, end - 1);
        const lineStart = newline >= from ? newline + 1 : from;
        if (end > lineStart) yield data.toString("utf8", lineStart, end);
        end = newline >= from ? newline : from;
      }
      position = start;
      size = Math.min(size * 2, MAX_WINDOW_BYTES);
    }
  } finally {
    closeSync(fd);
  }
}

export interface TranscriptScan {
  /** The last operator message was found (false: the transcript has none, or it is unreadable). */
  foundOperator: boolean;
  lastUser: string;
  finalText: string;
  todos: GuardTodo[];
  /** Finish guard pushes after the last operator message. */
  pushes: number;
}

/**
 * Walk transcript lines newest first. Everything after the last operator message counts (final reply,
 * pushes, newest TodoWrite list); a TodoWrite is also looked for further back, within `todoLookback`
 * characters, when none followed it.
 */
export function scanTranscript(lines: Iterable<string>, todoLookback = TAIL_BYTES): TranscriptScan {
  const scan: TranscriptScan = { foundOperator: false, lastUser: "", finalText: "", todos: [], pushes: 0 };
  let haveTodos = false;
  let replyLocked = false; // a push is newer than anything older: only the reply to it counts
  let consumed = 0;
  for (const line of lines) {
    consumed += line.length;
    if (scan.foundOperator && (haveTodos || consumed > todoLookback)) break;
    // A tool-result carrier without a text part is never operator, assistant or TodoWrite text.
    if (line.includes('"type":"tool_result"') && !line.includes('"type":"text"')) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const message = entry?.message;
    if (!message || entry.isSidechain === true) continue;
    if (entry.type === "assistant") {
      const content = message.content;
      if (!scan.foundOperator && !replyLocked && !scan.finalText) {
        const text = textOf(content);
        if (text.trim()) scan.finalText = text;
      }
      if (!haveTodos && Array.isArray(content)) {
        for (let i = content.length - 1; i >= 0; i--) {
          const part = content[i];
          if (part?.type === "tool_use" && part.name === "TodoWrite" && Array.isArray(part.input?.todos)) {
            scan.todos = part.input.todos.map((todo: any) => ({ content: String(todo?.content ?? ""), status: String(todo?.status ?? ""), reason: typeof todo?.reason === "string" ? todo.reason : undefined }));
            haveTodos = true;
            break;
          }
        }
      }
    } else if (entry.type === "user" && !scan.foundOperator) {
      const text = textOf(message.content);
      if (!text) continue;
      if (text.slice(0, MARK_SCAN).includes(FINISH_GUARD_MARK)) { scan.pushes += 1; replyLocked = true; continue; }
      if (entry.isMeta === true) continue;
      const operator = operatorText(text);
      if (!operator || INTERRUPTED.test(operator) || LOCAL_COMMAND_OUTPUT.test(operator)) continue;
      scan.lastUser = text;
      scan.foundOperator = true;
    }
  }
  return scan;
}

/** The hook's stdout for one Stop event: the block JSON, or "" when the turn may end. */
export function stopHookOutput(rawInput: string, settings: GuardSettings = finishGuardSettings(), readLines = tailLines): string {
  if (!settings.enabled) return "";
  const input = JSON.parse(rawInput || "{}");
  if (typeof input?.transcript_path !== "string" || !input.transcript_path) return "";
  const scan = scanTranscript(readLines(input.transcript_path));
  if (!scan.foundOperator) return "";
  // The hook payload carries the reply itself on current Claude Code; the transcript may not be flushed yet.
  const finalText = typeof input.last_assistant_message === "string" && input.last_assistant_message.trim() ? input.last_assistant_message : scan.finalText;
  // Already continuing because of a stop hook, yet no earlier push is visible: end rather than risk a loop.
  const continuations = input.stop_hook_active === true && scan.pushes === 0 ? settings.maxPushes : scan.pushes;
  const verdict = finishVerdict({ todos: scan.todos, finalText, lastUserText: scan.lastUser, continuations, maxPushes: settings.maxPushes, message: settings.message });
  return verdict.block ? JSON.stringify({ decision: "block", reason: verdict.reason }) : "";
}

function main(): void {
  try {
    const settings = finishGuardSettings();
    if (!settings.enabled) return;
    const output = stopHookOutput(readFileSync(0, "utf8"), settings);
    if (output) process.stdout.write(output);
  } catch {
    // Never trap a session on a hook failure.
  }
}

/** Run only as the entry point (not when a test imports it); a symlinked install path still counts. */
function isEntryPoint(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntryPoint()) main();

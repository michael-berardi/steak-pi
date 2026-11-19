// What one turn sends to agy: every user message since agy last replied, and either `--conversation <id>` (agy remembers the earlier turns,
// including what its tools did) or, when that conversation cannot be trusted to match Pi's history, a compact transcript.
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./models.ts";

/** Progress lines for agy's own tool steps start with this marker. They are display only and never replayed to a model. */
export const PROGRESS_MARK = "› agy ";
/** Cap on a replayed transcript, in UTF-8 bytes. */
export const PROMPT_MAX_BYTES = 100_000;

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");
/** The last `max` bytes of `s`, cut on a character boundary. */
export function tailBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let start = buf.length - Math.max(0, max);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

/** conversation id -> timestamp of the last assistant message agy produced in it, as this process saw it. */
export const knownConversations = new Map<string, number>();

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : part.type === "image" ? "[image omitted: the agy route is text-only]" : "")).filter(Boolean).join("\n");
}

const answerText = (message: AssistantMessage) =>
  message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
    .split("\n").filter((line) => !line.startsWith(PROGRESS_MARK)).join("\n").trim();

export interface BuiltPrompt { prompt: string; conversation?: string; replayed: boolean }

export function buildPrompt(messages: Message[], modelId: string): BuiltPrompt {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { last = i; break; }
  if (last < 0) throw new Error("agy needs a user message to answer");
  const current = textOf(messages[last].content).trim();
  const earlier = messages.slice(0, last);
  const lastAssistant = [...earlier].reverse().find((m): m is AssistantMessage => m.role === "assistant");
  if (!lastAssistant) {
    return { prompt: earlier.length ? withTranscript(earlier, current) : current, replayed: earlier.length > 0 };
  }
  const id = lastAssistant.provider === PROVIDER_ID && lastAssistant.model === modelId ? lastAssistant.responseId : undefined;
  // Resume only when Pi's history ends exactly where agy's conversation does: a branch, an edit, a compaction, a
  // restart or a model switch makes the two differ, and then a fresh conversation gets Pi's own transcript.
  if (id && knownConversations.get(id) === lastAssistant.timestamp) {
    // Everything the user said since agy's last reply, not just the last message (queued or steering messages).
    const pending = messages.slice(messages.indexOf(lastAssistant) + 1).flatMap((m) => (m.role === "user" ? [textOf(m.content).trim()] : []));
    return { prompt: pending.join("\n\n") || current, conversation: id, replayed: false };
  }
  return { prompt: withTranscript(earlier, current), replayed: true };
}

function withTranscript(earlier: Message[], current: string): string {
  const turns: string[] = [];
  for (const m of earlier) {
    if (m.role === "user") turns.push(`[user]\n${textOf(m.content).trim()}`);
    else if (m.role === "assistant") { const text = answerText(m); if (text) turns.push(`[assistant]\n${text}`); }
  }
  const head = "Earlier conversation, for context only (do not repeat it):\n";
  const tail = `\n\nCurrent request:\n${current}`;
  let body = turns.join("\n\n");
  const room = PROMPT_MAX_BYTES - byteLength(head) - byteLength(tail);
  if (byteLength(body) > room) body = `[earlier turns omitted]\n${tailBytes(body, Math.max(0, room))}`;
  return tailBytes(`${head}${body}${tail}`, PROMPT_MAX_BYTES);
}

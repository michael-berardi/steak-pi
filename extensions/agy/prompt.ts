// What one turn sends to agy: the last user message, and either `--conversation <id>` (agy remembers the earlier turns,
// including what its tools did) or, when that conversation cannot be trusted to match Pi's history, a compact transcript.
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./models.ts";

/** Progress lines for agy's own tool steps start with this marker. They are display only and never replayed to a model. */
export const PROGRESS_MARK = "› agy ";
export const PROMPT_MAX_CHARS = 100_000;

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
  if (id && knownConversations.get(id) === lastAssistant.timestamp) return { prompt: current, conversation: id, replayed: false };
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
  const room = PROMPT_MAX_CHARS - head.length - tail.length;
  if (body.length > room) body = `[earlier turns omitted]\n${body.slice(body.length - Math.max(0, room))}`;
  return `${head}${body}${tail}`.slice(-PROMPT_MAX_CHARS);
}

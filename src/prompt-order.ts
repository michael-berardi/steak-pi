/**
 * Keep per-turn content out of a route's reusable prompt prefix.
 *
 * A local llama.cpp server reuses its prompt cache only for an identical prefix, so anything that changes between two
 * consecutive turns *ahead of* the stable text costs a re-evaluation of everything after it. Steak Pi appends two such
 * blocks to the end of the fixed prompt — the route-availability line (refreshed at most once a minute, and it carries
 * clock times) and the active todo plan's guidance — which puts them in front of the whole conversation on every
 * request. One recorded session on a local route re-evaluated 20,504 to 32,736 prompt tokens per ordinary turn for
 * exactly this reason: only the fixed prefix was reusable.
 *
 * This module moves exactly those blocks, and only for a route that asks for it, to the end of the request, after the
 * conversation. Everything stable then comes first and everything that changes per turn comes last, so a change to
 * either block can no longer invalidate a single conversation token. A request without one of these blocks is returned
 * untouched, by identity, so a large-context or hosted route is byte-identical to what Pi built.
 *
 * The blocks are merged into the last user message, not appended as a new system message. The chat template of the
 * local model (Swift-1.5 / Qwen3.8, read from the GGUF header) rejects any system message that is not the first one
 * ("System message must be at the beginning."), so a trailing system message would fail every request that carried a
 * moved block. A user message is accepted anywhere in the conversation.
 */

/** The first line of each per-turn block Steak Pi appends to a session's fixed prompt. */
export const PER_TURN_MARKERS = ["USAP route availability", "## Active todo plan"] as const;

const SEPARATOR = "\n\n";

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * Split the trailing per-turn blocks off a fixed prompt.
 *
 * A block is moved only when its marker occurs exactly once in the whole prompt and the block is a trailing suffix
 * after a blank line — the shape both append sites produce. Anything else is left alone: this never guesses.
 */
export function splitPerTurnTail(head: string): { stable: string; tail?: string } {
  let stable = head;
  let tail: string | undefined;
  for (let guard = 0; guard <= PER_TURN_MARKERS.length; guard++) {
    let cut: { at: number; start: number } | undefined;
    for (const marker of PER_TURN_MARKERS) {
      if (countOf(head, marker) !== 1) continue;
      const at = stable.lastIndexOf(SEPARATOR + marker);
      if (at < 0) continue;
      if (cut === undefined || at > cut.at) cut = { at, start: at + SEPARATOR.length };
    }
    if (cut === undefined) break;
    const moved = stable.slice(cut.start);
    tail = tail === undefined ? moved : `${moved}${SEPARATOR}${tail}`;
    stable = stable.slice(0, cut.at);
  }
  return tail === undefined ? { stable: head } : { stable, tail };
}

interface ChatMessage { role?: unknown; content?: unknown }
interface ChatPayload { messages?: unknown }

/**
 * Move the per-turn blocks of the leading system message into the last user message of the request.
 *
 * The stable part stays as the only system message. The blocks are appended to the most recent user message, after its
 * text, so they sit after the whole conversation's cached prefix. A request with no string-content user message to
 * receive them is returned untouched, so the blocks stay where Pi put them (in the system message, which is accepted).
 *
 * Returns the same payload object when there is nothing to move, so a caller can tell "untouched" from "reordered" by
 * identity; otherwise a shallow copy with a reordered `messages` array. Characters are conserved: the blank line that
 * separated a block from the stable text is removed and the same blank line is added before it in the user message.
 */
export function movePerTurnTail<T>(payload: T): { payload: T; moved: string[] } {
  if (payload === null || typeof payload !== "object") return { payload, moved: [] };
  const body = payload as ChatPayload;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { payload, moved: [] };
  const messages = body.messages as ChatMessage[];
  const head = messages[0];
  if (head === undefined || (head.role !== "system" && head.role !== "developer") || typeof head.content !== "string") {
    return { payload, moved: [] };
  }
  const split = splitPerTurnTail(head.content);
  if (split.tail === undefined) return { payload, moved: [] };
  let target = -1;
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i]?.role === "user") { target = i; break; }
  }
  const user = target > 0 ? messages[target] : undefined;
  if (user === undefined || typeof user.content !== "string") return { payload, moved: [] };
  const reordered = messages.map((message, i): ChatMessage => {
    if (i === 0) return { ...message, content: split.stable };
    if (i === target) return { ...message, content: `${user.content as string}${SEPARATOR}${split.tail}` };
    return message;
  });
  return { payload: { ...(payload as Record<string, unknown>), messages: reordered } as T, moved: [split.tail] };
}

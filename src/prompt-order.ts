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
 * Move the per-turn blocks of the leading system message to the end of the request.
 *
 * Returns the same payload object when there is nothing to move, so a caller can tell "untouched" from "reordered" by
 * identity; otherwise a shallow copy with a reordered `messages` array.
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
  const reordered: ChatMessage[] = [
    { ...head, content: split.stable },
    ...messages.slice(1),
    { role: "system", content: split.tail },
  ];
  return { payload: { ...(payload as Record<string, unknown>), messages: reordered } as T, moved: [split.tail] };
}

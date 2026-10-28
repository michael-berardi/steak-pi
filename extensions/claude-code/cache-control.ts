/// Anthropic accepts at most four `cache_control` blocks in one request and
/// rejects the whole turn when a request carries more.
///
/// The Claude Code CLI marks its own breakpoints (the system prompt, the tool
/// definitions and the native environment marker) and the Steak Pi relay adds
/// one more on the newest message. A model whose request shape already uses
/// the whole budget (Fable 5.1 does) is then rejected with
/// `A maximum of 4 blocks with cache_control may be provided. Found 5.` and
/// the turn never reaches the model.
export const MAX_CACHE_BREAKPOINTS = 4;

/// One cache marker in a request, with the place it sits in.
export interface CacheBreakpoint {
  block: Record<string, unknown>;
  /// Anthropic builds the cache prefix as tools, then system, then messages.
  kind: "tools" | "system" | "message";
}

function isBlock(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/// The blocks a request can mark, in Anthropic's cache-prefix order: the tool
/// definitions, the system prompt, then the message content blocks.
///
/// Only block positions are collected. A `cache_control` key that appears
/// inside data (a tool's `input_schema`, a replayed `tool_use` input) is not a
/// cache marker and must never be counted or removed.
function* contentBlocks(content: unknown): Generator<Record<string, unknown>> {
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (!isBlock(item)) continue;
    // A tool result carries its own content blocks, which come first in the
    // cache prefix.
    if (item.type === "tool_result" && Array.isArray(item.content)) {
      for (const nested of item.content) {
        if (isBlock(nested)) yield nested;
      }
    }
    yield item;
  }
}

/// Every cache marker in the request, oldest first inside each kind.
export function collectCacheBreakpoints(payload: {
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
}): CacheBreakpoint[] {
  const found: CacheBreakpoint[] = [];
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  for (const tool of tools) {
    if (isBlock(tool) && tool.cache_control) found.push({ block: tool, kind: "tools" });
  }
  const system = Array.isArray(payload.system) ? payload.system : [];
  for (const block of system) {
    if (isBlock(block) && block.cache_control) found.push({ block, kind: "system" });
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (const message of messages) {
    if (!isBlock(message)) continue;
    for (const block of contentBlocks(message.content)) {
      if (block.cache_control) found.push({ block, kind: "message" });
    }
  }
  return found;
}

/// Keep a request inside Anthropic's four-breakpoint limit.
///
/// The static prefixes are the expensive ones and the newest message is the
/// one the relay wants cached, so the oldest message markers go first. The
/// system prompt and the tool definitions are only given up when no message
/// marker is left to drop. A request that is already inside the limit comes
/// out unchanged. Returns how many markers the request carries now and how
/// many were dropped to get there.
export function capCacheBreakpoints(payload: {
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
}): { remaining: number; dropped: number } {
  const markers = collectCacheBreakpoints(payload);
  let remaining = markers.length;
  let dropped = 0;
  const drop = (marker: CacheBreakpoint | undefined) => {
    if (!marker || remaining <= MAX_CACHE_BREAKPOINTS) return;
    delete marker.block.cache_control;
    remaining -= 1;
    dropped += 1;
  };
  const messages = markers.filter((marker) => marker.kind === "message");
  const system = markers.filter((marker) => marker.kind === "system");
  const tools = markers.filter((marker) => marker.kind === "tools");
  // Oldest message marker first, then tools, preserving the longer system prefix.
  for (const marker of messages) drop(marker);
  for (const marker of tools) drop(marker);
  for (const marker of system) drop(marker);
  return { remaining, dropped };
}

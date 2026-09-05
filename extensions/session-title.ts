import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_TITLE_CHARS = 80;

const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

const COMBINING_MARK_RE = /\p{Mark}/u;

function isGraphemeExtension(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return COMBINING_MARK_RE.test(value)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff);
}

function isRegionalIndicator(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

/**
 * Segment text with the platform Unicode implementation when available. The
 * small fallback covers the sequences titles commonly contain without adding
 * a runtime dependency: combining marks, emoji modifiers, ZWJ emoji, and
 * paired regional indicators.
 */
function splitGraphemes(value: string): string[] {
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
  }

  const codePoints = Array.from(value);
  const graphemes: string[] = [];
  for (let index = 0; index < codePoints.length;) {
    let grapheme = codePoints[index] ?? "";
    const regionalIndicator = isRegionalIndicator(grapheme);
    index += 1;

    if (regionalIndicator && index < codePoints.length && isRegionalIndicator(codePoints[index] ?? "")) {
      grapheme += codePoints[index];
      index += 1;
    }

    while (index < codePoints.length) {
      const next = codePoints[index] ?? "";
      if (isGraphemeExtension(next)) {
        grapheme += next;
        index += 1;
        continue;
      }
      if (next === "\u200d") {
        grapheme += next;
        index += 1;
        if (index < codePoints.length) {
          grapheme += codePoints[index];
          index += 1;
        }
        continue;
      }
      break;
    }
    graphemes.push(grapheme);
  }
  return graphemes;
}

/**
 * Derives a card-friendly session title from the first real user prompt.
 * Returns null for inputs that should never name a session: slash commands
 * and blank text. Whitespace collapses so multi-line prompts stay readable in
 * narrow rail cards, and truncation respects grapheme clusters so emoji,
 * combining marks, and CJK never split mid-character.
 */
export function deriveSessionTitle(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith("/")) return null;
  const collapsed = trimmed.split(/\s+/).join(" ");
  if (collapsed.length === 0) return null;
  const chars = splitGraphemes(collapsed);
  if (chars.length <= MAX_TITLE_CHARS) return collapsed;
  return `${chars.slice(0, MAX_TITLE_CHARS - 1).join("")}\u2026`;
}

/**
 * Auto-titles unnamed Steak Pi sessions from the first real prompt so the
 * UltraTerm rail cards, Pi's session selector, and resume lists all show a
 * meaningful name without requiring /rename. An explicit rename always wins:
 * the handler only acts while the session name is unset.
 */
export default function sessionTitleExtension(pi: ExtensionAPI): void {
  // Only the foreground TUI owns the pane; SDK/RPC children can inherit
  // TMUX_PANE and must never overwrite its binding. Slots are mutable labels.
  let published: { pane: string; file: string } | undefined;
  pi.on("session_start", async (_event, ctx) => {
    const pane = process.env.TMUX_PANE;
    if (ctx.mode !== "tui" || !pane || !/^%\d+$/.test(pane)) return;
    const file = ctx.sessionManager.getSessionFile();
    try {
      const args = file && !/[\r\n|]/.test(file)
        ? ["set-option", "-p", "-t", pane, "@pi-session-file", file]
        : ["set-option", "-pu", "-t", pane, "@pi-session-file"];
      const result = await pi.exec(process.env.TMUX_BIN || "tmux", args, { timeout: 1000 });
      if (result.code === 0 && file) published = { pane, file };
    } catch {
      // Optional, non-secret metadata must never prevent session startup.
    }
  });
  pi.on("session_shutdown", async () => {
    const binding = published;
    published = undefined;
    if (!binding) return;
    try {
      const tmux = process.env.TMUX_BIN || "tmux";
      const current = await pi.exec(tmux,
        ["show-options", "-pqv", "-t", binding.pane, "@pi-session-file"], { timeout: 1000 });
      if (current.code === 0 && current.stdout.trimEnd() === binding.file) {
        await pi.exec(tmux, ["set-option", "-pu", "-t", binding.pane, "@pi-session-file"], { timeout: 1000 });
      }
    } catch {
      // A closed pane already discarded its pane-local option.
    }
  });

  pi.on("input", (event) => {
    try {
      if (event.source === "extension" || pi.getSessionName()) return;
      const title = deriveSessionTitle(event.text);
      if (title) pi.setSessionName(title);
    } catch {
      // Session naming is optional metadata and must never interrupt input.
    }
  });
}

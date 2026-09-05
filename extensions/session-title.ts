import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_TITLE_CHARS = 80;

/**
 * Derives a card-friendly session title from the first real user prompt.
 * Returns null for inputs that should never name a session: slash commands
 * and blank text. Whitespace collapses so multi-line prompts stay readable in
 * narrow rail cards, and truncation respects code points so emoji and CJK
 * never split mid-character.
 */
export function deriveSessionTitle(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.startsWith("/")) return null;
  const collapsed = trimmed.split(/\s+/).join(" ");
  if (collapsed.length === 0) return null;
  const chars = Array.from(collapsed);
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
  pi.on("input", (event) => {
    if (pi.getSessionName()) return;
    const title = deriveSessionTitle(event.text);
    if (title) pi.setSessionName(title);
  });
}

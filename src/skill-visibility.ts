import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Keep a skill out of the catalog when the tool it explains is not offered.
 *
 * Steak Pi ships skills that are instructions for one of its own tools. When the operator runs a session without
 * that tool (`--exclude-tools`, `--tools`), the catalog entry still told the model to read the skill "at the start of
 * nontrivial work": a file of several thousand tokens about a tool the session cannot call. The entry is removed for
 * such a session only. With the tool offered, or when the host cannot say which tools are offered, the prompt is
 * returned untouched, by identity.
 */
type ActiveToolsApi = Pick<ExtensionAPI, "getActiveTools">;

/** False only when the host positively reports a tool list without `name`. Unknown is treated as offered. */
export function toolIsOffered(pi: Partial<ActiveToolsApi>, name: string): boolean {
  if (typeof pi.getActiveTools !== "function") return true;
  try {
    const active = pi.getActiveTools();
    return !Array.isArray(active) || active.includes(name);
  } catch {
    return true;
  }
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Remove one skill's entry from the `<available_skills>` section, in either form the prompt can carry: the host's
 * `<skill>` element or the one-line index the skill catalog extension writes. Everything else is conserved byte for
 * byte, and a prompt without that entry is returned by identity.
 */
export function hideSkill(systemPrompt: string, skillName: string): string {
  const section = /<available_skills>[\s\S]*?<\/available_skills>/.exec(systemPrompt);
  if (!section || !skillName) return systemPrompt;
  const name = escapeRegExp(escapeXml(skillName));
  const element = new RegExp(`[ \\t]*<skill>\\s*<name>\\s*${name}\\s*</name>(?:(?!<skill>)[\\s\\S])*?</skill>[ \\t]*\\n?`);
  const line = new RegExp(`^${name} \\([^\\n]*\\):[^\\n]*\\n?`, "m");
  const body = section[0];
  const next = element.test(body) ? body.replace(element, "") : body.replace(line, "");
  if (next === body) return systemPrompt;
  return systemPrompt.slice(0, section.index) + next + systemPrompt.slice(section.index + body.length);
}

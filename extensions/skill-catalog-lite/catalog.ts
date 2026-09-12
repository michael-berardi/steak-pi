/** Pure, deterministic two-tier catalog rewriting. Never opens skill files. */
export interface CatalogOptions { enabled?: boolean; byteBudget?: number; maxTriggerWords?: number }
export interface CatalogResult { systemPrompt: string; changed: boolean; beforeBytes: number; afterBytes: number; overflowBytes: number }
interface Skill { name: string; location: string; description: string }
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const positiveInt = (value: number | undefined, fallback: number) => Number.isFinite(value) && value! > 0 ? Math.floor(value!) || fallback : fallback;
const filler = /\b(?:powerful|comprehensive|seamless|seamlessly|robust|cutting-edge|best-in-class|amazing|advanced|efficient|efficiently|easy|easily|ultimate|innovative)\b/gi;

export function compressTrigger(description: string, maxWords = 15): string {
  const clean = description.replace(/\s+/g, " ").trim();
  const first = clean.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? clean;
  return first.replace(/^(?:this skill (?:helps you |allows you to |enables you to |is (?:used |designed )?to )?|use (?:this skill )?(?:when|for|to)\s+)/i, "")
    .replace(filler, "").replace(/\s+/g, " ").trim().split(" ")
    .slice(0, Math.min(15, positiveInt(maxWords, 15))).join(" ");
}

// Core emits XML-escaped text. Decode exactly once, then escape for the new section.
function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (whole, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (named[entity]) return named[entity];
    if (!entity.startsWith("#")) return whole;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
}
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\r\n]/g, " ");
}
function parse(body: string): Skill[] | undefined {
  const skills: Skill[] = [];
  const remainder = body.replace(/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g,
    (_match, name: string, description: string, location: string) => {
      skills.push({ name: decode(name.trim()), description: decode(description.trim()), location: decode(location.trim()) });
      return "";
    });
  // Fail closed for unfamiliar schema, preserving every original entry.
  return remainder.trim() || !skills.length || skills.some(s => !s.name || !s.location) ? undefined : skills;
}
export function rewriteCatalog(systemPrompt: string, options: CatalogOptions = {}): CatalogResult {
  const match = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(systemPrompt);
  const beforeBytes = match ? bytes(match[0]) : 0;
  const unchanged = { systemPrompt, changed: false, beforeBytes, afterBytes: beforeBytes, overflowBytes: 0 };
  if (options.enabled === false || !match) return unchanged;
  const budget = positiveInt(options.byteBudget, 8192);
  if (beforeBytes <= budget) return unchanged;
  const skills = parse(match[1]);
  if (!skills) return unchanged; // Includes our already compacted index: idempotent.
  const triggers = skills.map(s => compressTrigger(s.description, options.maxTriggerWords).split(/\s+/).filter(Boolean));
  const render = () => '<available_skills>\n<!-- skill-catalog-lite v1: read the listed SKILL.md for full instructions when relevant. -->\n'
    + skills.map((s, i) => `${escape(s.name)} (${escape(s.location)}):${triggers[i].length ? " " + escape(triggers[i].join(" ")) : ""}`).join("\n")
    + '\n</available_skills>';
  let catalog = render();
  // Trim the longest trigger first, deterministically, retaining all identities.
  while (bytes(catalog) > budget) {
    let longest = -1;
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i].length && (longest < 0 || bytes(triggers[i].join(" ")) > bytes(triggers[longest].join(" ")))) longest = i;
    }
    if (longest < 0) break;
    triggers[longest].pop();
    catalog = render();
  }
  const afterBytes = bytes(catalog);
  // Degenerate inputs must never inflate the original prompt.
  if (afterBytes >= beforeBytes) return { ...unchanged, overflowBytes: Math.max(0, beforeBytes - budget) };
  return { systemPrompt: systemPrompt.slice(0, match.index) + catalog + systemPrompt.slice(match.index + match[0].length), changed: true, beforeBytes, afterBytes, overflowBytes: Math.max(0, afterBytes - budget) };
}
export function optionsFromEnv(env: Record<string, string | undefined>): CatalogOptions {
  return {
    enabled: !/^(?:0|false|off|no)$/i.test(env.STEAK_PI_SKILL_CATALOG_LITE ?? ""),
    byteBudget: positiveInt(Number(env.STEAK_PI_SKILL_CATALOG_BYTES), 8192),
    maxTriggerWords: Math.min(15, positiveInt(Number(env.STEAK_PI_SKILL_CATALOG_WORDS), 15)),
  };
}

/**
 * A fixed prompt that fits a small context window.
 *
 * Pi assembles a session's fixed prompt from ordered, independently replaceable sections: the skills catalog, the
 * project instructions (AGENTS.md and siblings), the documentation hints, and whatever custom packs an extension adds
 * (here: a memory pack). On a local route the context window is a fraction of a hosted one, and that assembly can be
 * most of the window before the operator has typed anything: one recorded session on a 65,536-token route carried
 * 130,358 characters of fixed prompt (77,508 of them the skills catalog) and compacted 153 times in 875 entries.
 *
 * This module holds the fixed prompt of a small-context route to a share of its window. It shrinks sections in one
 * stated order — the skills catalog to its index form, then to names only, then the documentation block away, then the
 * memory pack to a smaller budget — and it never truncates the project instructions: they carry the operator's rules,
 * so when they alone exceed the budget they stay whole and the overage is reported with the numbers.
 *
 * Everything here is a pure function of (text, context window, config). Nothing reads a model, a provider or a person:
 * the only input that decides whether a budget applies is the route's declared context size.
 */
import { rewriteCatalog } from "../extensions/skill-catalog-lite/catalog.ts";

/** Pi's own token estimate, the same chars/4 divisor the local request cap uses. */
export const CHARS_PER_TOKEN = 4;

/** Sections this module recognises in a rendered fixed prompt, and the order it shrinks them in. */
export const SKILLS_SECTION = "skills";
export const DOCS_SECTION = "docs";
export const PROJECT_SECTION = "project_context";
/** Custom memory packs seen in the wild; the first one present is the one budgeted. */
export const MEMORY_SECTIONS = ["ultraterm-memory", "memory"] as const;

export interface PromptBudgetConfig {
  /** Off leaves every route's fixed prompt exactly as Pi assembled it. */
  enabled: boolean;
  /** Only a route whose declared context window is below this many tokens gets a fixed-prompt budget. */
  belowTokens: number;
  /** The share of that window the fixed prompt may occupy. */
  share: number;
  /** Byte budget for the skills index form. */
  skillsBytes: number;
  /** Byte budget the memory pack is reduced to when it has to give ground. */
  memoryBytes: number;
}

export const DEFAULT_PROMPT_BUDGET: PromptBudgetConfig = {
  enabled: true,
  belowTokens: 100_000,
  share: 0.25,
  skillsBytes: 8_192,
  memoryBytes: 4_096,
};

/** A named configuration problem: the key, the value, why it was refused and what was used instead. */
export interface PromptBudgetProblem { key: string; value: string; reason: string; used: string }

/** A refused budget configuration. Named like every other operator-facing refusal in this repository. */
export class PromptBudgetError extends Error {
  readonly code = "bad-prompt-budget" as const;
  readonly key: string;
  constructor(problem: PromptBudgetProblem) {
    super(`${problem.key} ${problem.reason} (got ${JSON.stringify(problem.value)}; using ${problem.used})`);
    this.name = "PromptBudgetError";
    this.key = problem.key;
  }
}

const OFF = /^(?:0|false|off|no)$/i;
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const tokensOf = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/** The fixed-prompt budget in tokens for a route, floored, never below one token. */
export const fixedPromptBudgetTokens = (contextWindow: number, config: PromptBudgetConfig = DEFAULT_PROMPT_BUDGET): number =>
  Math.max(1, Math.floor(contextWindow * config.share));

/** Whether this route is small enough that its fixed prompt needs a budget. */
export const budgetApplies = (contextWindow: number | undefined, config: PromptBudgetConfig = DEFAULT_PROMPT_BUDGET): boolean =>
  config.enabled && typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
  && contextWindow < config.belowTokens;

/** Parse and validate the operator's settings; every refused value is named, and the default is what runs. */
export function readPromptBudgetConfig(env: Record<string, string | undefined>): { config: PromptBudgetConfig; problems: PromptBudgetProblem[] } {
  const problems: PromptBudgetProblem[] = [];
  const config: PromptBudgetConfig = { ...DEFAULT_PROMPT_BUDGET };
  const enabledValue = env.STEAK_PI_PROMPT_BUDGET;
  if (enabledValue !== undefined && enabledValue.trim() !== "") config.enabled = !OFF.test(enabledValue.trim());
  const int = (name: keyof PromptBudgetConfig, raw: string | undefined, fallback: number) => {
    if (raw === undefined || raw.trim() === "") return;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      const problem = { key: `prompt-budget.${name}`, value: raw, reason: "must be a positive whole number", used: String(fallback) };
      problems.push(problem);
      return;
    }
    (config[name] as number) = value;
  };
  int("belowTokens", env.STEAK_PI_PROMPT_BUDGET_BELOW_TOKENS, DEFAULT_PROMPT_BUDGET.belowTokens);
  int("skillsBytes", env.STEAK_PI_PROMPT_BUDGET_SKILLS_BYTES, DEFAULT_PROMPT_BUDGET.skillsBytes);
  int("memoryBytes", env.STEAK_PI_PROMPT_BUDGET_MEMORY_BYTES, DEFAULT_PROMPT_BUDGET.memoryBytes);
  const shareRaw = env.STEAK_PI_PROMPT_BUDGET_SHARE;
  if (shareRaw !== undefined && shareRaw.trim() !== "") {
    const share = Number(shareRaw);
    if (!Number.isFinite(share) || share <= 0 || share > 1) {
      problems.push({ key: "prompt-budget.share", value: shareRaw, reason: "must be a number greater than 0 and at most 1", used: String(DEFAULT_PROMPT_BUDGET.share) });
    } else config.share = share;
  }
  return { config, problems };
}

/** Strict form for callers that must not run on a guessed value: the first refused key throws, by name. */
export function resolvePromptBudgetConfig(env: Record<string, string | undefined>): PromptBudgetConfig {
  const { config, problems } = readPromptBudgetConfig(env);
  if (problems.length > 0) throw new PromptBudgetError(problems[0]!);
  return config;
}

interface Section { name: string; start: number; bodyStart: number; bodyEnd: number; end: number }

/** Locate one `<name>…</name>` section of a rendered fixed prompt. */
export function findSection(text: string, name: string): Section | undefined {
  const open = `<${name}>`;
  const close = `</${name}>`;
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  const bodyStart = start + open.length;
  const bodyEnd = text.indexOf(close, bodyStart);
  if (bodyEnd < 0) return undefined;
  return { name, start, bodyStart, bodyEnd, end: bodyEnd + close.length };
}

export const sectionBody = (text: string, name: string): string | undefined => {
  const section = findSection(text, name);
  return section === undefined ? undefined : text.slice(section.bodyStart, section.bodyEnd);
};

const replaceBody = (text: string, section: Section, body: string): string =>
  `${text.slice(0, section.bodyStart)}${body}${text.slice(section.bodyEnd)}`;

const removeSection = (text: string, section: Section): string => {
  // Drop the wrapper and the blank line that separated it from its neighbours.
  const before = text.slice(0, section.start).replace(/\n+$/, "");
  const after = text.slice(section.end).replace(/^\n+/, "");
  return before.length === 0 ? after : after.length === 0 ? before : `${before}\n\n${after}`;
};

interface SkillIdentity { name: string; location: string }

/** Skill identities from either the raw catalog Pi renders or this repository's compact index form. */
export function skillIdentities(body: string): SkillIdentity[] {
  const identities: SkillIdentity[] = [];
  const raw = /<skill>\s*<name>([\s\S]*?)<\/name>[\s\S]*?<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
  for (let match = raw.exec(body); match !== null; match = raw.exec(body)) {
    identities.push({ name: decodeXml(match[1]!.trim()), location: decodeXml(match[2]!.trim()) });
  }
  if (identities.length > 0) return identities;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("<!--")) continue;
    const match = /^(.+?) \((.+?)\)(?::.*)?$/.exec(trimmed);
    if (match) identities.push({ name: match[1]!.trim(), location: match[2]!.trim() });
  }
  return identities;
}

const decodeXml = (text: string): string => text
  .replace(/&(amp|lt|gt|quot|apos);/g, (_whole, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[entity] ?? _whole);

/** The last tier of the skills block: every name and where its file is, plus the instruction to read that file. */
export function renderSkillNames(body: string, maxBytes = 4_096): string {
  const identities = skillIdentities(body);
  const header = "<!-- small-context prompt budget: skill names only. Read the SKILL.md at a skill's location before using it. -->";
  const lines: string[] = [];
  let used = bytes(header);
  for (const identity of identities) {
    const line = `${identity.name} (${identity.location})`;
    const cost = bytes(line) + 1;
    if (used + cost > maxBytes) break;
    lines.push(line);
    used += cost;
  }
  const kept = lines.length === identities.length ? "" : `\n<!-- ${identities.length - lines.length} more skills are not listed here: ask for the full catalog if you need one. -->`;
  return `\n${header}\n${lines.join("\n")}${kept}\n`;
}

/** Cut a memory pack to a byte budget at a line boundary, and say in the prompt that it was cut and by how much. */
export function shrinkMemory(body: string, budgetBytes: number): string {
  const total = bytes(body);
  if (total <= budgetBytes) return body;
  const note = `\n…memory pack shortened to PLACEHOLDER of ${total} bytes by the small-context prompt budget; everything not shown here is not in this prompt.`;
  let kept = Math.max(0, budgetBytes - bytes(note));
  let head = body.slice(0, kept);
  const boundary = head.lastIndexOf("\n");
  if (boundary > 0) head = head.slice(0, boundary);
  // UTF-8 growth can overshoot a character count; trim until the rendered pack fits.
  while (bytes(head) + bytes(note) > budgetBytes && head.length > 0) head = head.slice(0, Math.max(0, head.length - Math.ceil((bytes(head) + bytes(note) - budgetBytes))));
  return `${head}${note.replace("PLACEHOLDER", String(bytes(head)))}`;
}

export type PromptBudgetStep = "skills-index" | "skills-names" | "docs-dropped" | "memory-reduced";

export interface FixedPromptPlan {
  /** The fixed prompt to send. Byte-identical to the input when nothing had to change. */
  text: string;
  changed: boolean;
  contextWindow: number;
  budgetTokens: number;
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  steps: PromptBudgetStep[];
  /** Project instructions kept whole past the budget, with the numbers: never silently truncated. */
  keptWhole?: { section: string; tokens: number; overBy: number };
  /** What could not be brought inside the budget, when it was not the project instructions. */
  unreducible?: { tokens: number; overBy: number };
}

/**
 * Hold one rendered fixed prompt to a share of its route's context window.
 *
 * Priority order, highest first: (1) the skills catalog to its index form, and, if that is not enough, to names plus
 * the instruction to read the skill file; (2) the documentation block away; (3) the memory pack at a smaller budget,
 * halved until it fits. The project instructions are never truncated: when they alone exceed the budget they are kept
 * whole and `keptWhole` carries the numbers so a caller can report them once.
 */
export function planFixedPrompt(input: { text: string; contextWindow: number; config?: PromptBudgetConfig; memoryBytes?: number }): FixedPromptPlan {
  const config = input.config ?? DEFAULT_PROMPT_BUDGET;
  const budgetTokens = fixedPromptBudgetTokens(input.contextWindow, config);
  const beforeChars = input.text.length;
  const beforeTokens = tokensOf(beforeChars);
  const unchanged: FixedPromptPlan = {
    text: input.text, changed: false, contextWindow: input.contextWindow, budgetTokens,
    beforeChars, afterChars: beforeChars, beforeTokens, afterTokens: beforeTokens, steps: [],
  };
  if (!budgetApplies(input.contextWindow, config) || beforeTokens <= budgetTokens) return unchanged;

  const over = (text: string) => tokensOf(text.length) > budgetTokens;
  const steps: PromptBudgetStep[] = [];
  let out = input.text;

  // (1) skills: the catalog to its index form, then to names plus the instruction to read the skill file.
  const skills = findSection(out, SKILLS_SECTION);
  if (skills !== undefined) {
    const indexed = rewriteCatalog(out, { enabled: true, byteBudget: config.skillsBytes });
    if (indexed.changed) { out = indexed.systemPrompt; steps.push("skills-index"); }
    if (over(out)) {
      const current = findSection(out, SKILLS_SECTION);
      if (current !== undefined) {
        const names = renderSkillNames(out.slice(current.bodyStart, current.bodyEnd), Math.max(256, Math.floor(config.skillsBytes / 2)));
        out = replaceBody(out, current, names);
        steps.push("skills-names");
      }
    }
  }

  // (2) the documentation block: a small-context route does not need pi's own docs index in its window.
  if (over(out)) {
    const docs = findSection(out, DOCS_SECTION);
    if (docs !== undefined) { out = removeSection(out, docs); steps.push("docs-dropped"); }
  }

  // (3) the memory pack, at a smaller budget, halved until the prompt fits or the pack is minimal.
  if (over(out)) {
    let budget = Math.max(256, input.memoryBytes ?? config.memoryBytes);
    while (over(out) && budget >= 256) {
      const name = MEMORY_SECTIONS.find((candidate) => findSection(out, candidate) !== undefined);
      if (name === undefined) break;
      const section = findSection(out, name)!;
      const shrunk = shrinkMemory(out.slice(section.bodyStart, section.bodyEnd), budget);
      const next = replaceBody(out, section, shrunk);
      if (next === out) break; // already at or below this budget
      out = next;
      if (!steps.includes("memory-reduced")) steps.push("memory-reduced");
      budget = Math.floor(budget / 2);
    }
  }

  const afterTokens = tokensOf(out.length);
  const project = findSection(out, PROJECT_SECTION);
  const projectTokens = project === undefined ? 0 : tokensOf(project.end - project.start);
  const keptWhole = over(out) && projectTokens > budgetTokens
    ? { section: PROJECT_SECTION, tokens: projectTokens, overBy: projectTokens - budgetTokens }
    : undefined;
  return {
    text: out,
    changed: out !== input.text,
    contextWindow: input.contextWindow,
    budgetTokens,
    beforeChars,
    afterChars: out.length,
    beforeTokens,
    afterTokens,
    steps,
    ...(keptWhole !== undefined ? { keptWhole } : {}),
    ...(over(out) && keptWhole === undefined ? { unreducible: { tokens: afterTokens, overBy: afterTokens - budgetTokens } } : {}),
  };
}

/** The one-line report a caller shows in the status line and the log. Numbers only, no model name. */
export function describePromptBudget(plan: FixedPromptPlan): string {
  const share = Math.round((plan.afterTokens / plan.contextWindow) * 1000) / 10;
  const steps = plan.steps.length > 0 ? plan.steps.join(", ") : "nothing had to change";
  const overage = plan.keptWhole !== undefined
    ? `; project instructions kept whole: ${plan.keptWhole.tokens} tokens, ${plan.keptWhole.overBy} over the ${plan.budgetTokens}-token budget`
    : plan.unreducible !== undefined ? `; ${plan.unreducible.overBy} tokens above the budget could not be removed` : "";
  return `prompt budget: fixed prompt ${plan.beforeTokens} -> ${plan.afterTokens} tokens (${share}% of the ${plan.contextWindow}-token window, budget ${plan.budgetTokens}): ${steps}${overage}`;
}

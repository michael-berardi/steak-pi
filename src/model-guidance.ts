import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Per-model guidance: short system-prompt lines the operator attaches to models whose `provider/id` matches a pattern.
 * Steak Pi ships no rule and names no model; the rules live in `modelGuidance` in `~/.pi/agent/steak-pi.json` (or
 * steak-pi.json under PI_CODING_AGENT_DIR):
 *
 *   "modelGuidance": [{ "match": "<regular expression over provider/id>", "text": "<one or two sentences>" }]
 *
 * Every matching rule is added, in file order. `STEAK_PI_MODEL_GUIDANCE=off` leaves them all out. A malformed file or
 * rule is reported by `modelGuidanceRules` (errors) and skipped; it never stops a session.
 */
export interface ModelGuidanceRule { match: RegExp; text: string }
export interface ModelGuidanceSettings { rules: ModelGuidanceRule[]; errors: string[] }

export const MODEL_GUIDANCE_ENV = "STEAK_PI_MODEL_GUIDANCE";
export const MAX_GUIDANCE_TEXT = 600;
export const MAX_GUIDANCE_RULES = 16;

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
}

export function parseModelGuidance(raw: unknown): ModelGuidanceSettings {
  const out: ModelGuidanceSettings = { rules: [], errors: [] };
  if (raw === undefined || raw === null) return out;
  if (!Array.isArray(raw)) {
    out.errors.push("modelGuidance must be a list of { match, text } rules");
    return out;
  }
  raw.slice(0, MAX_GUIDANCE_RULES).forEach((rule, index) => {
    const at = `modelGuidance[${index}]`;
    if (!rule || typeof rule !== "object") return void out.errors.push(`${at} is not an object`);
    const { match, text } = rule as { match?: unknown; text?: unknown };
    if (typeof match !== "string" || !match.trim()) return void out.errors.push(`${at}.match must be a non-empty pattern`);
    if (typeof text !== "string" || !text.trim()) return void out.errors.push(`${at}.text must be non-empty`);
    if (text.trim().length > MAX_GUIDANCE_TEXT) return void out.errors.push(`${at}.text is longer than ${MAX_GUIDANCE_TEXT} characters`);
    try {
      out.rules.push({ match: new RegExp(match, "i"), text: text.trim() });
    } catch (error) {
      out.errors.push(`${at}.match is not a valid pattern: ${(error as Error).message}`);
    }
  });
  if (raw.length > MAX_GUIDANCE_RULES) out.errors.push(`modelGuidance has more than ${MAX_GUIDANCE_RULES} rules; the rest are ignored`);
  return out;
}

export function modelGuidanceSettings(path?: string, env: NodeJS.ProcessEnv = process.env): ModelGuidanceSettings {
  if (/^(0|false|off|no)$/i.test(env[MODEL_GUIDANCE_ENV]?.trim() ?? "")) return { rules: [], errors: [] };
  const file = path ?? join(agentDir(), "steak-pi.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rules: [], errors: [] };
    return { rules: [], errors: [`${file}: ${(error as Error).message}`] };
  }
  try {
    return parseModelGuidance(JSON.parse(text)?.modelGuidance);
  } catch (error) {
    return { rules: [], errors: [`${file} is not valid JSON: ${(error as Error).message}`] };
  }
}

/** The guidance for one model, or "" when no rule matches. */
export function modelGuidanceText(model: { provider?: string; id?: string } | undefined, rules: readonly ModelGuidanceRule[]): string {
  if (!model?.id) return "";
  const ref = `${model.provider ?? ""}/${model.id}`;
  return rules.filter(rule => rule.match.test(ref)).map(rule => rule.text).join("\n");
}

/** Appends guidance for `model` to a system prompt once; returns the prompt unchanged when nothing matches. */
export function withModelGuidance(systemPrompt: string, model: { provider?: string; id?: string } | undefined, rules: readonly ModelGuidanceRule[]): string {
  const text = modelGuidanceText(model, rules);
  if (!text || systemPrompt.includes(text)) return systemPrompt;
  return `${systemPrompt}\n\n${text}`;
}

/** Section name the guidance renders under (<model_guidance>…</model_guidance>). */
export const GUIDANCE_SECTION = "model_guidance";

/**
 * Put guidance into a before_agent_start event without replacing the prompt: a named section, so other extensions'
 * sections stay. When an earlier handler already forced a whole prompt, sections no longer render, so the text is
 * appended to that forced prompt once instead. Returns the handler result.
 */
export function applyModelGuidance(event: { systemPrompt?: string; systemPromptOptions?: { forceSystemPrompt?: string; sections?: Record<string, string> } }, text: string): { systemPrompt: string } | undefined {
  const options = event.systemPromptOptions;
  if (!text) {
    if (options?.sections) delete options.sections[GUIDANCE_SECTION];
    return undefined;
  }
  if (options && options.forceSystemPrompt === undefined && options.sections) {
    options.sections[GUIDANCE_SECTION] = text;
    return undefined;
  }
  const current = String(event.systemPrompt ?? "");
  return current.includes(text) ? undefined : { systemPrompt: `${current}\n\n${text}` };
}

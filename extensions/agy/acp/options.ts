// Values learned from the ACP server instead of guessed by Steak Pi: context size, model ids and effort levels.
import type { AssistantMessage, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Windows and effort levels learned from the server, reused for model listing before the next ACP session exists. */
export const learnedContextWindows = new Map<string, number>();
export const learnedEfforts = new Map<string, ThinkingLevelMap>();

export interface AcpConfigOptionValue { value: string; name?: string; description?: string }
export interface AcpConfigOption {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string | boolean;
  options?: AcpConfigOptionValue[];
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** Accept both ACP's camelCase usage fields and the snake_case fields agy also emits. */
export interface RawAcpUsage {
  inputTokens?: number; input_tokens?: number;
  cacheReadTokens?: number; cache_read_tokens?: number;
  cacheWriteTokens?: number; cache_write_tokens?: number;
  outputTokens?: number; output_tokens?: number;
  reasoningTokens?: number; thinking_tokens?: number;
  totalTokens?: number; total_tokens?: number;
  used?: number; size?: number;
}

const pick = (raw: RawAcpUsage, camel: keyof RawAcpUsage, snake: keyof RawAcpUsage) => num(raw[camel]) || num(raw[snake]);

/** ACP counts input across every step of a tool-call turn; Pi's overflow check needs single-call occupancy. */
export function normalizeAcpUsage(raw: RawAcpUsage): AssistantMessage["usage"] {
  let input = pick(raw, "inputTokens", "input_tokens");
  let cacheRead = pick(raw, "cacheReadTokens", "cache_read_tokens");
  const output = pick(raw, "outputTokens", "output_tokens");
  const cacheWrite = pick(raw, "cacheWriteTokens", "cache_write_tokens");
  const reasoning = pick(raw, "reasoningTokens", "thinking_tokens");
  const totalTokens = pick(raw, "totalTokens", "total_tokens") || num(raw.used) || input + output;
  const prompt = input + cacheRead;
  if (totalTokens > 0 && prompt > totalTokens) {
    // Keep the cached/non-cached ratio, but make the buckets sum to this call's occupancy.
    cacheRead = Math.floor((cacheRead / prompt) * totalTokens);
    input = totalTokens - cacheRead;
  }
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return { input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost };
}

const LEVEL_ALIASES: Record<string, string[]> = {
  off: ["low", "minimal", "none", "off"],
  minimal: ["low", "minimal"],
  low: ["low", "minimal"],
  medium: ["medium", "moderate"],
  high: ["high"],
  xhigh: ["extra", "xhigh", "very high", "higher"],
  max: ["max", "maximum", "extra", "high"],
};

export function thoughtOption(options: AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((o) => o.category === "thought_level" || /thought|reason|effort|thinking/i.test(o.id))
    ?? options.find((o) => o.options?.some((v) => LEVEL_ALIASES.max.includes((v.value || v.name || "").toLowerCase())));
}

/** Map Pi's thinking level to a value the server actually advertised (e.g. Low/Medium/High/Extra/Max). */
export function effortForAcp(level: string | undefined, options: AcpConfigOption[]): string | undefined {
  const option = thoughtOption(options);
  const values = option?.options?.map((optionValue) => optionValue.value ?? optionValue.name ?? "").filter(Boolean) ?? [];
  if (values.length === 0) return undefined;
  // A reasoning level already translated by Pi may itself be a server value.
  const direct = values.find((value) => value.toLowerCase() === String(level ?? "").toLowerCase());
  if (direct) return direct;
  for (const alias of LEVEL_ALIASES[String(level ?? "medium")] ?? LEVEL_ALIASES.medium) {
    const match = values.find((value) => value.toLowerCase() === alias || (option?.options?.find((v) => v.value === value)?.name ?? "").toLowerCase() === alias);
    if (match) return match;
  }
  return values[0];
}

export function thinkingLevelMapFromOptions(options: AcpConfigOption[]): ThinkingLevelMap {
  const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const map: ThinkingLevelMap = {};
  for (const level of levels) map[level] = effortForAcp(level, options) ?? null;
  return map;
}

/** A context window can come from an ACP config option or from a `usage_update.size`. */
export function contextWindowFromOptions(options: AcpConfigOption[]): number | undefined {
  const option = options.find((o) => /context|window/i.test(o.id) || o.category === "model_config");
  const value = String(option?.currentValue ?? "").trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(value);
  if (!match) return undefined;
  const tokens = Number(match[1]) * (match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1);
  return Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : undefined;
}

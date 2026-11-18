// The operator's own custom-model entry, read raw from Pi's models.json. Pi's model composer fills an all-zero
// price for any custom model defined without one, so the composed registry cost cannot tell an operator-typed zero
// from that default. The raw file can: a cost row must be present with every price a literal zero.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PRICE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const rawModelsPath = (): string => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "models.json");

let cached: { path: string; signature: string; config: unknown } | undefined;

function readModelsJson(path: string): unknown {
  const stat = statSync(path);
  const signature = `${stat.mtimeMs}:${stat.size}`;
  if (cached?.path === path && cached.signature === signature) return cached.config;
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  cached = { path, signature, config };
  return config;
}

/** True only when models.json holds a custom entry for exactly this provider/model whose `cost` row is present with
 * input, output, cacheRead and cacheWrite all the number 0. Unreadable, missing, malformed or partial: false (fail closed). */
export function rawModelHasZeroCostRow(provider: string, id: string): boolean {
  try {
    const config = readModelsJson(rawModelsPath());
    if (!isRecord(config) || !isRecord(config.providers)) return false;
    const entry = config.providers[provider];
    if (!isRecord(entry) || !Array.isArray(entry.models)) return false;
    const matches = entry.models.filter((model): model is Record<string, unknown> => isRecord(model) && model.id === id);
    if (matches.length !== 1) return false;
    const cost = matches[0]!.cost;
    return isRecord(cost) && PRICE_KEYS.every((key) => Object.hasOwn(cost, key) && cost[key] === 0);
  } catch { return false; }
}

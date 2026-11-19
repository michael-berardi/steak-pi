// The model list is whatever `agy models` prints for the signed-in account; no model id lives in this source.
import type { Model } from "@earendil-works/pi-ai";
import { AgyError, cleanAgyText, errorFromResult } from "./errors.ts";
import { agyBin, runAgy } from "./process.ts";

export const PROVIDER_ID = "agy";
export const API_ID = "agy-stream-json";
export const ASSUMED_CONTEXT_WINDOW = 200_000;
export const ASSUMED_MAX_OUTPUT = 64_000;
const CACHE_MS = 60_000;

export interface AgyModel { id: string; name: string }

/** Parse `agy models` output: one `<slug>  <display name>` per line. Header/footer lines are skipped. */
export function parseModels(stdout: string): AgyModel[] {
  const out: AgyModel[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9._-]*)\s+(\S.*)$/.exec(line.trim());
    if (match && !out.some((m) => m.id === match[1])) out.push({ id: match[1], name: match[2].trim() });
  }
  return out;
}

const cache = new Map<string, { at: number; models: AgyModel[] }>();
export const clearModelCache = () => cache.clear();

/** The signed-in account's models. Throws a named error: agy missing, not signed in, or an empty list. Cached for 60 s. */
export async function listAgyModels(env: Record<string, string | undefined> = process.env, signal?: AbortSignal): Promise<AgyModel[]> {
  const bin = agyBin(env);
  const hit = cache.get(bin);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.models;
  const result = await runAgy({ args: ["models"], cwd: process.cwd(), env, signal, timeoutMs: 20_000 });
  const text = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) throw new AgyError("timeout", "`agy models` did not answer within 20 s");
  const models = result.code === 0 ? parseModels(result.stdout) : [];
  if (models.length === 0) {
    if (result.code === 0) throw new AgyError("model-unavailable", "`agy models` listed no models for this account's plan.");
    const error = errorFromResult(text, "");
    throw error.kind === "failed" ? new AgyError("failed", `\`agy models\` failed (exit ${result.code}): ${cleanAgyText(text.split("\n").filter((l) => l.trim() && !/^fetching/i.test(l.trim()))[0] ?? "no output")}`) : error;
  }
  cache.set(bin, { at: Date.now(), models });
  return models;
}

export function toPiModel(m: AgyModel): Model<typeof API_ID> {
  return {
    id: m.id,
    name: m.name,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "process://agy",
    input: ["text"],
    reasoning: true,
    // Used through the signed-in account's plan, not billed per token by Steak Pi.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: ASSUMED_CONTEXT_WINDOW,
    maxTokens: ASSUMED_MAX_OUTPUT,
  };
}

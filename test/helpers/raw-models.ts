// The operator's raw Pi models.json, for tests of the free-route gate: a route is free only when its custom-model
// entry carries an all-zero cost row. Points PI_CODING_AGENT_DIR at a private folder; call clearRawModels() after.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string | undefined;
let previous: string | undefined;
export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Write models.json with these custom models (an entry without `cost` models a model defined with no price). */
export function writeRawModels(models: readonly { provider: string; id: string; cost?: unknown }[]): void {
  clearRawModels();
  dir = mkdtempSync(join(tmpdir(), "steak-raw-models-"));
  previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const providers: Record<string, { models: unknown[] }> = {};
  for (const model of models) (providers[model.provider] ??= { models: [] }).models.push({ id: model.id, ...(model.cost !== undefined ? { cost: model.cost } : {}) });
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers }));
}

/** Overwrite models.json with exact text (malformed-file cases). */
export function writeRawModelsText(text: string): void {
  writeRawModels([]);
  writeFileSync(join(dir!, "models.json"), text);
}

export function clearRawModels(): void {
  if (dir === undefined) return;
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
  dir = undefined; previous = undefined;
}

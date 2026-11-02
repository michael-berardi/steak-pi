/**
 * Where the local module keeps things, and the two ways it writes them:
 *  - `~/.pi/agent/models.json` gets ONE `local` provider; other providers and unknown keys are left as they were.
 *    The file is backed up first (a few timestamped copies are kept), written to a temp file at 0600 and renamed.
 *  - `~/.pi/agent/local/` holds launch profiles, the running server record, the leases and the server log.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ID_PATTERN, PROVIDER, type LaunchProfile } from "./profile.ts";

export class LocalError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) { super(detail); this.code = code; }
}

export const agentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
export const modelsJsonPath = (): string => join(agentDir(), "models.json");
export const localDir = (): string => join(agentDir(), "local");

const BACKUPS_KEPT = 5;

/** Write `text` to `path` atomically (temp file in the same directory, then rename) at mode 0600. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, text, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export const readJson = <T>(path: string): T | undefined => {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return undefined; }
};

const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/** Insert or replace `model` under the `local` provider of `file`. Returns the backup path, if one was made. */
export function upsertLocalModel(file: string, model: { id: string; baseUrl: string } & Record<string, unknown>, now: Date = new Date()): { backup?: string } {
  let config: { providers?: Record<string, Record<string, unknown>> } & Record<string, unknown> = {};
  let backup: string | undefined;
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    if (raw.trim()) {
      try { config = JSON.parse(raw); }
      catch (error) { throw new LocalError("models-json-invalid", `${file} is not valid JSON (${(error as Error).message}); nothing was written. Fix or move it, then run the command again`); }
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new LocalError("models-json-invalid", `${file} is not a JSON object; nothing was written`);
    }
    backup = `${file}.bak-${stamp(now)}`;
    copyFileSync(file, backup);
    chmodSync(backup, 0o600);
    const old = readdirSync(dirname(file)).filter((name) => name.startsWith(`${basename(file)}.bak-`)).sort();
    for (const name of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) rmSync(join(dirname(file), name), { force: true });
  }
  const providers = config.providers && typeof config.providers === "object" ? config.providers : {};
  const existing = providers[PROVIDER] ?? {};
  const models = Array.isArray(existing.models) ? (existing.models as Array<{ id?: string }>) : [];
  providers[PROVIDER] = {
    ...existing,
    api: "openai-completions",
    apiKey: typeof existing.apiKey === "string" ? existing.apiKey : "local",
    baseUrl: typeof existing.baseUrl === "string" ? existing.baseUrl : model.baseUrl,
    models: [...models.filter((entry) => entry.id !== model.id), model],
  };
  config.providers = providers;
  writeAtomic(file, `${JSON.stringify(config, null, 2)}\n`);
  return { backup };
}

export function checkId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new LocalError("bad-id", `model id "${id}" must be lowercase letters, digits, "." "_" "-" (at most 64, starting with a letter or digit)`);
  return id;
}

const profilePath = (dir: string, id: string): string => join(dir, "profiles", `${checkId(id)}.json`);
export const writeProfile = (dir: string, profile: LaunchProfile): void => writeAtomic(profilePath(dir, profile.id), `${JSON.stringify(profile, null, 2)}\n`);
export const readProfile = (dir: string, id: string): LaunchProfile | undefined => readJson<LaunchProfile>(profilePath(dir, id));
export function listProfiles(dir: string): LaunchProfile[] {
  const folder = join(dir, "profiles");
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter((name) => name.endsWith(".json")).sort()
    .flatMap((name) => { const profile = readJson<LaunchProfile>(join(folder, name)); return profile ? [profile] : []; });
}

/** Run `fn` holding the directory lock (an atomic mkdir; a lock older than two minutes belongs to a dead process). */
export async function withLock<T>(dir: string, fn: () => T | Promise<T>, sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "lock");
  for (let attempt = 0; ; attempt++) {
    try { mkdirSync(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > 120_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (attempt > 200) throw new LocalError("lock-busy", `another steak-pi local command holds ${lock}`);
      await sleep(50);
    }
  }
  try { return await fn(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

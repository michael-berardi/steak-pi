import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Update preferences, kept in the `updates` section of Steak Pi's own settings file (`steak-pi.json`
 * in the Pi agent directory, outside any release folder) so they survive updates. Every other key in
 * the file is preserved.
 *
 *   "updates": {
 *     "checks": true,              // background checks; false turns them off
 *     "auto": false,               // opt-in automatic install, off by default
 *     "autoAsked": true,           // the "install future updates automatically?" answer was given
 *     "skippedVersion": "1.2.3",   // no notice until a strictly newer release
 *     "notice": { "version": "1.2.3", "at": 1760000000000 },
 *     "autoError": "cause of the last failed automatic install"
 *   }
 */
export const NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const KEY = "updates";

export interface UpdatePrefs {
  checks: boolean;
  auto: boolean;
  autoAsked?: boolean;
  skippedVersion?: string;
  notice?: { version: string; at: number };
  autoError?: string;
  /** Set when the settings file cannot be read; defaults apply (auto stays off). */
  error?: string;
}

export function agentConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "steak-pi.json");
}

function readSettings(path: string): Record<string, unknown> {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`${path} is not valid JSON: ${(error as Error).message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must hold a JSON object`);
  return parsed as Record<string, unknown>;
}

function writeSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.steak-pi-update.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function readUpdatePrefs(path = agentConfigPath()): UpdatePrefs {
  let section: unknown;
  try { section = readSettings(path)[KEY]; } catch (error) {
    return { checks: true, auto: false, error: (error as Error).message };
  }
  if (section !== undefined && (!section || typeof section !== "object" || Array.isArray(section))) {
    return { checks: true, auto: false, error: `${KEY} in ${path} must be an object` };
  }
  const value = (section ?? {}) as Record<string, unknown>;
  const notice = value.notice as { version?: unknown; at?: unknown } | undefined;
  return {
    checks: value.checks !== false,
    auto: value.auto === true,
    autoAsked: value.autoAsked === true || undefined,
    skippedVersion: typeof value.skippedVersion === "string" ? value.skippedVersion : undefined,
    notice: typeof notice?.version === "string" && typeof notice.at === "number" ? { version: notice.version, at: notice.at } : undefined,
    autoError: typeof value.autoError === "string" ? value.autoError : undefined,
  };
}

/** Merge `changes` into the `updates` section atomically (undefined deletes a key). Never overwrites a malformed file. */
export function writeUpdatePrefs(changes: Partial<Omit<UpdatePrefs, "error">>, path = agentConfigPath()): UpdatePrefs {
  let settings: Record<string, unknown>;
  try { settings = readSettings(path); } catch (error) { throw new Error(`cannot update ${(error as Error).message}`); }
  const previous = settings[KEY];
  const next: Record<string, unknown> = previous && typeof previous === "object" && !Array.isArray(previous) ? { ...previous } : {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  writeSettings(path, { ...settings, [KEY]: next });
  return readUpdatePrefs(path);
}

/** A notice (footer and prompt) is due at most once per 24 hours per version, never for a skipped version. */
export function isNoticeDue(state: { available: boolean; latest?: string }, prefs: UpdatePrefs, now = Date.now(), intervalMs = NOTICE_INTERVAL_MS): boolean {
  if (!state.available || !state.latest || prefs.skippedVersion === state.latest) return false;
  const shown = prefs.notice;
  return !shown || shown.version !== state.latest || shown.at > now || now - shown.at >= intervalMs;
}

export const markNoticeShown = (version: string, path?: string, now = Date.now()): UpdatePrefs =>
  writeUpdatePrefs({ notice: { version, at: now } }, path);
export const skipVersion = (version: string, path?: string): UpdatePrefs =>
  writeUpdatePrefs({ skippedVersion: version, notice: undefined }, path);
/** Any answer is remembered, so the question is never asked again. */
export const setAutoUpdate = (on: boolean, path?: string): UpdatePrefs =>
  writeUpdatePrefs({ auto: on, autoAsked: true, autoError: undefined }, path);
export const recordAutoError = (cause: string, path?: string): UpdatePrefs => writeUpdatePrefs({ autoError: cause }, path);

/** Uninstall: drop the whole `updates` section, and the file when nothing else is left in it. */
export function clearUpdatePrefs(path = agentConfigPath()): void {
  const settings = readSettings(path);
  if (!(KEY in settings)) return;
  delete settings[KEY];
  if (Object.keys(settings).length === 0) rmSync(path, { force: true });
  else writeSettings(path, settings);
}

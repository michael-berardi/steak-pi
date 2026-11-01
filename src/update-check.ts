import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where Steak Pi publishes releases. The check reads only GitHub's public "latest release" record. */
export const RELEASES_API = "https://api.github.com/repos/michael-berardi/steak-pi/releases/latest";
/** At most one network check per interval, across every Pi session on the machine (shared cache file). */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 4_000;
export const DEFAULT_CACHE_PATH = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "steak-pi", "update-check.json");

export interface UpdateCache {
  /** When the last check finished (epoch ms), successful or not. */
  checkedAt: number;
  /** Latest published version without the leading "v", when the last check succeeded. */
  latest?: string;
  /** Why the last check failed, kept so `steak-pi update --check` and the command can name it. */
  error?: string;
}

export interface UpdateState {
  current: string;
  latest?: string;
  available: boolean;
  checkedAt?: number;
  error?: string;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** True when `latest` is a strictly newer stable x.y.z than `current`. Anything unparseable is never "newer". */
export function isNewer(latest: string | undefined, current: string): boolean {
  const a = latest?.match(SEMVER), b = current.match(SEMVER);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const x = Number(a[i]), y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return false;
}

export function readCache(path = DEFAULT_CACHE_PATH): UpdateCache | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return typeof value?.checkedAt === "number" ? value as UpdateCache : undefined;
  } catch { return undefined; }
}

function writeCache(cache: UpdateCache, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, path); // atomic: concurrent sessions never read a torn file
  } catch { /* A read-only cache only means the next session checks again. */ }
}

/** Ask GitHub for the latest release tag. Throws a named error; never retries (the interval is the retry). */
export async function fetchLatest(fetchImpl: typeof fetch = fetch, timeoutMs = CHECK_TIMEOUT_MS): Promise<string> {
  const response = await fetchImpl(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "steak-pi-update-check" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub releases answered HTTP ${response.status}`);
  const tag = (await response.json() as { tag_name?: unknown }).tag_name;
  if (typeof tag !== "string" || !SEMVER.test(tag)) throw new Error(`GitHub latest release has no x.y.z tag (${String(tag)})`);
  return tag.replace(/^v/, "");
}

/**
 * The update state for `current`. Uses the shared cache while it is fresh; otherwise checks GitHub once and
 * records the answer (or the named failure) for every other session. `force` skips the cache.
 */
export async function checkForUpdate(current: string, options: {
  now?: number; cachePath?: string; force?: boolean; fetchImpl?: typeof fetch; intervalMs?: number;
} = {}): Promise<UpdateState> {
  const now = options.now ?? Date.now();
  const path = options.cachePath ?? DEFAULT_CACHE_PATH;
  let cache = options.force ? undefined : readCache(path);
  if (!cache || now - cache.checkedAt >= (options.intervalMs ?? CHECK_INTERVAL_MS) || cache.checkedAt > now) {
    try {
      cache = { checkedAt: now, latest: await fetchLatest(options.fetchImpl) };
    } catch (error) {
      // Keep the last known version so a flaky network never hides an update that was already found.
      const previous = readCache(path);
      cache = { checkedAt: now, latest: previous?.latest, error: error instanceof Error ? error.message : String(error) };
    }
    writeCache(cache, path);
  }
  return { current, latest: cache.latest, available: isNewer(cache.latest, current), checkedAt: cache.checkedAt, error: cache.error };
}

/** Opt-out for users who manage versions themselves or run offline. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.STEAK_PI_NO_UPDATE_CHECK ?? "") || /^(1|true|yes)$/i.test(env.CI ?? "");
}

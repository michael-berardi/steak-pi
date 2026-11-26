import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Release-folder hygiene: keep at most one rollback and never pull a release out from under a session.
 *
 * `<root>/<version>/package` folders are what Pi loads. A session keeps the release it started with
 * for its whole life, and its subagents load modules from it (2026-11-03: a two-day-old session lost
 * its release to an update and every dispatch failed). So an older release is removed only when all
 * of these hold:
 *   - no known Pi agent settings file pins it;
 *   - it was retired (un-pinned) before every running Pi process started, so none can be loading it;
 *   - for the newest older release (the rollback): the current release has run once, or seven days
 *     have passed since the rollback was retired.
 * Anything that cannot be proven (no retirement marker, `ps` unavailable) is kept. An agent directory
 * outside the known set (a custom PI_CODING_AGENT_DIR) that is not running is not seen, exactly as
 * `steak-pi update` does not re-point it; re-running `steak-pi update` or the installer there restores it.
 */
export const ROLLBACK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** When a release stopped being pinned (epoch ms). Written by `steak-pi update`/`--rollback`. */
export const RETIRED_MARKER = ".retired-at";
/** Written by the first interactive session that loads a release. */
export const RAN_MARKER = ".ran-at";

const VERSION = /^\d+\.\d+\.\d+$/;
const RELEASE_ENTRY = /steak-pi\/releases\/(\d+\.\d+\.\d+)\/package$/;

function compare(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function readNumber(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
}

/** Every Pi agent settings file this machine is known to use (the same set `steak-pi update` re-points). */
export function knownSettingsFiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  const files = [join(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "settings.json"), join(home, ".pi", "agent", "settings.json")];
  const accounts = join(env.ULTRATERM_HOME || join(home, ".ultraterm"), "provider-accounts");
  try {
    for (const provider of readdirSync(accounts)) {
      try {
        for (const account of readdirSync(join(accounts, provider))) files.push(join(accounts, provider, account, "agent", "settings.json"));
      } catch { /* not a directory */ }
    }
  } catch { /* no provider accounts */ }
  return [...new Set(files)];
}

/** Versions under `root` that any of `files` pins. */
export function pinnedVersions(root: string, files: string[]): Set<string> {
  const pinned = new Set<string>();
  const realRoot = real(root);
  for (const file of files) {
    let packages: unknown;
    try { packages = (JSON.parse(readFileSync(file, "utf8")) as { packages?: unknown }).packages; } catch { continue; }
    if (!Array.isArray(packages)) continue;
    for (const entry of packages) {
      const source = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
      if (typeof source !== "string") continue;
      const match = source.match(RELEASE_ENTRY);
      if (!match) continue;
      const absolute = resolve(dirname(file), source.replace(/^~(?=\/)/, homedir()));
      if (real(dirname(dirname(absolute))) === realRoot) pinned.add(match[1]);
    }
  }
  return pinned;
}

/** Start times (epoch ms) of Pi processes in `ps -o etime=,comm=` output (`[[dd-]hh:]mm:ss name`). */
export function parsePiStarts(output: string, now = Date.now()): number[] {
  const starts: number[] = [];
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s+(.+)$/);
    if (!match) continue;
    const name = match[5].trim().split("/").at(-1) ?? "";
    if (name !== "pi" && !name.startsWith("pi-")) continue;
    const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map((part) => Number(part ?? 0));
    starts.push(now - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
  }
  return starts;
}

/** Start times of running Pi processes (names only are read), or undefined when they cannot be listed. */
export function runningPiStarts(now = Date.now()): number[] | undefined {
  try {
    return parsePiStarts(execFileSync("ps", ["-axo", "etime=,comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }), now);
  } catch { return undefined; }
}

export interface PruneOptions {
  now?: number;
  /** Versions pinned by known settings files; default: read them. */
  pinned?: Set<string>;
  /** Running Pi process start times; default: read `ps`. Undefined means unknown, so nothing is removed. */
  piStarts?: number[] | undefined;
}

export interface PruneResult { removed: string[]; kept: Array<{ version: string; reason: string }> }

/** Remove older release folders that are provably unused; keep at most one rollback. */
export function pruneReleases(root: string, current: string, options: PruneOptions = {}): PruneResult {
  const now = options.now ?? Date.now();
  const result: PruneResult = { removed: [], kept: [] };
  if (!VERSION.test(current)) return result;
  let names: string[];
  try { names = readdirSync(root); } catch { return result; }
  // Only older releases are debris; a newer folder is what a rollback came from, or the next update.
  const older = names.filter((name) => VERSION.test(name) && compare(name, current) < 0 && existsSync(join(root, name, "package", "package.json")))
    .sort((a, b) => compare(b, a));
  if (older.length === 0) return result;
  const pinned = options.pinned ?? pinnedVersions(root, knownSettingsFiles());
  const piStarts = "piStarts" in options ? options.piStarts : runningPiStarts(now);
  const settled = existsSync(join(root, current, RAN_MARKER));
  older.forEach((version, index) => {
    const keep = (reason: string) => { result.kept.push({ version, reason }); };
    if (pinned.has(version)) return keep("pinned by a Pi agent settings file");
    const retiredAt = readNumber(join(root, version, RETIRED_MARKER));
    // Markers from 0.22.x were epoch seconds and are stale: treat them as unknown, like a missing one.
    if (retiredAt === undefined || retiredAt < 1e12) {
      // Unknown retirement time: start the clock now and keep it until sessions have moved on.
      try { writeFileSync(join(root, version, RETIRED_MARKER), `${now}\n`, { mode: 0o600 }); } catch { /* read-only */ }
      return keep("retirement time unknown");
    }
    if (piStarts === undefined) return keep("cannot list running Pi sessions");
    if (piStarts.some((started) => started <= retiredAt)) return keep("a running Pi session may still load it");
    if (index === 0 && !settled && now - retiredAt < ROLLBACK_MAX_AGE_MS) return keep("rollback until the new release has run once");
    try {
      rmSync(join(root, version), { recursive: true, force: true });
      result.removed.push(version);
    } catch (error) {
      keep(`cannot remove: ${(error as Error).message}`);
    }
  });
  return result;
}

/** The release folder (`<root>/<version>`) a package root lives in, when it is a release-folder install. */
export function releaseOf(packageRoot: string): { root: string; version: string } | undefined {
  const path = real(packageRoot);
  const match = path.match(/^(.*\/steak-pi\/releases)\/(\d+\.\d+\.\d+)\/package$/);
  return match ? { root: match[1], version: match[2] } : undefined;
}

/** Record that this release has run once. True when there are older folders worth pruning. */
export function markReleaseRan(packageRoot: string, now = Date.now()): { root: string; version: string } | undefined {
  const release = releaseOf(packageRoot);
  if (!release) return undefined;
  const marker = join(release.root, release.version, RAN_MARKER);
  if (!existsSync(marker)) {
    try { writeFileSync(marker, `${now}\n`, { mode: 0o600 }); } catch { return undefined; }
  }
  try {
    const hasOlder = readdirSync(release.root).some((name) => VERSION.test(name) && compare(name, release.version) < 0);
    return hasOlder ? release : undefined;
  } catch { return undefined; }
}

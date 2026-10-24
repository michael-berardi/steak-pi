/**
 * Re-resolve a module that lives in the staged runtime tree a session started from.
 *
 * A session keeps the runtime path it was launched with. When the managed runtime is
 * re-staged, the tree that session was started from can be replaced while the session
 * keeps running: a child dispatched afterwards would fail before it starts with a bare
 * "Cannot find module" that names a path no longer on disk. This module resolves the
 * module against the runtime that is actually staged, and names every runtime it tried
 * when nothing resolves.
 *
 * The rules are deliberately narrow:
 *   - the tree the session started from wins whenever it is still on disk;
 *   - a replaced tree is re-resolved only to a runtime of the SAME package version, so
 *     a session never mixes two versions of the worker code it did not review;
 *   - nothing is guessed silently: an unresolvable module fails with the runtimes it
 *     tried, and the cause ("the staged runtime was replaced") is in the message.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The pointer the managed launcher publishes for the runtime it stages now. */
export const ACTIVE_RUNTIME_FILE = "active-steak-pi.json";

/** The package root of the tree this module was loaded from (<tree>/node_modules/steak-pi). */
export function stagedPackageRoot(moduleUrl: string = import.meta.url): string {
  return dirname(dirname(dirname(fileURLToPath(moduleUrl))));
}

/** The runtime tree that holds a package root (<tree>/node_modules/steak-pi). */
export function stagedRuntimeTree(packageRoot: string): string {
  return dirname(dirname(packageRoot));
}

/** The version of a staged package, read from its own manifest. */
export function stagedPackageVersion(packageRoot: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The version of the tree this session was loaded from, captured while that tree still
 * existed. It is the only version this session may continue a worker with.
 */
const LOADED_VERSION = stagedPackageVersion(stagedPackageRoot());

/** The directory the managed runtime is staged in. */
export function stagedRuntimeRoot(): string {
  const override = process.env.ULTRATERM_RUNTIME_ROOT;
  if (override) return override;
  return join(process.env.HOME || homedir(), ".ultraterm", "runtime");
}

export interface StagedRuntimeCandidate {
  /** The package root of a staged runtime. */
  packageRoot: string;
  /** The runtime tree that holds it. */
  runtime: string;
  /** How the candidate was found, for the failure message. */
  source: string;
}

/** Every staged runtime that could serve a replacement, best candidate first. */
export function currentStagedRuntimes(root: string = stagedRuntimeRoot()): StagedRuntimeCandidate[] {
  const candidates: StagedRuntimeCandidate[] = [];
  const add = (packageRoot: string, source: string) => {
    if (!packageRoot) return;
    if (candidates.some((candidate) => candidate.packageRoot === packageRoot)) return;
    candidates.push({ packageRoot, runtime: stagedRuntimeTree(packageRoot), source });
  };
  // The pointer the managed launcher publishes names the runtime it stages now.
  try {
    const pointer = JSON.parse(readFileSync(join(root, ACTIVE_RUNTIME_FILE), "utf8")) as { package?: unknown };
    if (typeof pointer.package === "string") add(pointer.package, "the current runtime pointer");
  } catch {
    // No pointer: the staged trees on disk are still resolved below.
  }
  // Every staged tree, newest first, so a re-stage is preferred over an older tree.
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return candidates;
  }
  const trees = entries
    .filter((name) => name === "steak-pi" || name.startsWith("steak-pi-composer1-"))
    .map((name) => {
      const path = join(root, name);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { path, mtime };
    })
    .sort((left, right) => right.mtime - left.mtime);
  for (const tree of trees) add(join(tree.path, "node_modules", "steak-pi"), "a staged runtime on disk");
  return candidates;
}

export interface StagedModuleResolution {
  /** The resolved module URL. */
  url: string;
  /** The runtime tree the module was resolved from. */
  runtime: string;
  /** True when the tree the session started from was replaced. */
  replaced: boolean;
  /** Every runtime that was tried, in order. */
  tried: string[];
}

/**
 * Resolve a module that lives in the staged runtime tree, re-resolving the runtime
 * when the tree this session started from is no longer on disk.
 *
 * @param relativePath Package-relative path of the module, e.g. "src/subagents/pi-worker.ts".
 */
export function resolveStagedModule(
  relativePath: string,
  options: { moduleUrl?: string; runtimeRoot?: string } = {},
): StagedModuleResolution {
  const packageRoot = stagedPackageRoot(options.moduleUrl);
  const pinned = join(packageRoot, relativePath);
  const tried: string[] = [packageRoot];
  if (existsSync(pinned)) {
    return { url: pathToFileURL(pinned).href, runtime: stagedRuntimeTree(packageRoot), replaced: false, tried };
  }
  // The tree this session started from was replaced. Resolve the current one instead.
  const root = options.runtimeRoot ?? stagedRuntimeRoot();
  const refused: string[] = [];
  for (const candidate of currentStagedRuntimes(root)) {
    const file = join(candidate.packageRoot, relativePath);
    if (!existsSync(file)) {
      refused.push(`${candidate.runtime} (no ${relativePath})`);
      continue;
    }
    const version = stagedPackageVersion(candidate.packageRoot);
    if (!LOADED_VERSION || !version || version !== LOADED_VERSION) {
      refused.push(`${candidate.runtime} (version ${version ?? "unknown"}, this session runs ${LOADED_VERSION ?? "unknown"})`);
      continue;
    }
    return { url: pathToFileURL(file).href, runtime: candidate.runtime, replaced: true, tried: [...tried, ...refused] };
  }
  throw new Error(
    `The staged runtime ${packageRoot} was replaced and no current runtime could be resolved for ${relativePath}. ` +
      `Tried: ${[...tried, ...refused].join(", ")}.`,
  );
}

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
 *   - a replaced tree must have the same content-addressed tree id, or byte-identical
 *     package modules captured while the session's original tree still existed;
 *   - matching a version alone is never enough to mix builds;
 *   - nothing is guessed silently: an unresolvable module fails with the runtimes it
 *     tried, and the cause ("the staged runtime was replaced") is in the message.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Optional pointer for launchers that publish one; UltraTerm uses content-addressed trees. */
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

export interface StagedRuntimeIdentity {
  packageRoot: string;
  version?: string;
  treeId?: string;
  integrity?: string;
}

function contentTreeId(packageRoot: string): string | undefined {
  const name = basename(stagedRuntimeTree(packageRoot));
  return /^steak-pi-composer1-[a-f0-9]{8,64}$/iu.test(name) ? name : undefined;
}

/** Hash all package modules, not just the entry point (its relative imports matter too). */
function moduleIntegrity(packageRoot: string): string | undefined {
  try {
    const hash = createHash("sha256");
    const add = (relative: string) => {
      const bytes = readFileSync(join(packageRoot, relative));
      hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
    };
    const walk = (relative: string) => {
      for (const entry of readdirSync(join(packageRoot, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(relative, entry.name);
        if (entry.isDirectory()) walk(path);
        else add(path);
      }
    };
    add("package.json");
    // Both worker entry points can import shared src modules and extension code.
    // Include non-code assets as well, e.g. the CLI's inert MCP script.
    for (const directory of ["src", "extensions"]) {
      if (existsSync(join(packageRoot, directory))) walk(directory);
    }
    return hash.digest("hex");
  } catch {
    return undefined; // Unreadable/incomplete originals cannot authorize a fallback.
  }
}

/** Capture before cleanup removes a session's original runtime. */
export function captureStagedRuntimeIdentity(moduleUrl: string = import.meta.url): StagedRuntimeIdentity {
  const packageRoot = stagedPackageRoot(moduleUrl);
  return {
    packageRoot,
    version: stagedPackageVersion(packageRoot),
    treeId: contentTreeId(packageRoot),
    integrity: moduleIntegrity(packageRoot),
  };
}

const LOADED_IDENTITY = captureStagedRuntimeIdentity();

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
  // An optional pointer is a discovery hint, never permission to switch builds.
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
  options: { moduleUrl?: string; runtimeRoot?: string; identity?: StagedRuntimeIdentity } = {},
): StagedModuleResolution {
  const identity = options.identity ?? LOADED_IDENTITY;
  const packageRoot = options.moduleUrl ? stagedPackageRoot(options.moduleUrl) : identity.packageRoot;
  const pinned = join(packageRoot, relativePath);
  const tried: string[] = [packageRoot];
  if (existsSync(pinned)) {
    return { url: pathToFileURL(pinned).href, runtime: stagedRuntimeTree(packageRoot), replaced: false, tried };
  }
  // Prefer a relocation/re-stage of the exact content-addressed build, even when
  // a newer same-version tree or an active pointer would otherwise sort first.
  const root = options.runtimeRoot ?? stagedRuntimeRoot();
  const refused: string[] = [];
  const candidates = currentStagedRuntimes(root).sort((a, b) =>
    Number(!!identity.treeId && contentTreeId(b.packageRoot) === identity.treeId) -
    Number(!!identity.treeId && contentTreeId(a.packageRoot) === identity.treeId));
  for (const candidate of candidates) {
    const file = join(candidate.packageRoot, relativePath);
    if (!existsSync(file)) {
      refused.push(`${candidate.runtime} (no ${relativePath})`);
      continue;
    }
    const version = stagedPackageVersion(candidate.packageRoot);
    if (!identity.version || !version || version !== identity.version) {
      refused.push(`${candidate.runtime} (version ${version ?? "unknown"}, this session runs ${identity.version ?? "unknown"})`);
      continue;
    }
    const sameTree = !!identity.treeId && contentTreeId(candidate.packageRoot) === identity.treeId;
    if (!sameTree && (!identity.integrity || moduleIntegrity(candidate.packageRoot) !== identity.integrity)) {
      refused.push(`${candidate.runtime} (different build: package module integrity is not byte-identical to this session)`);
      continue;
    }
    return { url: pathToFileURL(file).href, runtime: candidate.runtime, replaced: true, tried: [...tried, ...refused] };
  }
  throw new Error(
    `The staged runtime ${packageRoot} was replaced and no current runtime could be resolved for ${relativePath}. ` +
      `Tried: ${[...tried, ...refused].join(", ")}.`,
  );
}

interface JitiCacheFailure {
  file: string;
  directory: string;
}

function errorFilePath(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" ? code !== "ENOENT" : !message.includes("ENOENT")) return undefined;
  const path = (error as { path?: unknown }).path;
  if (typeof path === "string" && isAbsolute(path)) return path;
  const match = message.match(/(?:open|stat|access|read)\s+'([^']+)'/);
  return match && isAbsolute(match[1]) ? match[1] : undefined;
}

function within(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

/** Only a real jiti cache path is recreated; an arbitrary ENOENT stays untouched. */
function jitiCacheFailure(error: unknown): JitiCacheFailure | undefined {
  const file = errorFilePath(error);
  if (!file) return undefined;
  const name = basename(file);
  if (!name.includes("-") || !/\.[a-f0-9]{6,}\.(?:m|c)?js$/iu.test(name)) return undefined;
  const directory = resolve(dirname(file));
  for (const variable of ["JITI_FS_CACHE", "JITI_CACHE"]) {
    const configured = process.env[variable]?.replace(/^["']|["']$/g, "");
    if (configured && isAbsolute(configured) && directory === resolve(configured)) return { file, directory };
  }
  if (basename(directory) !== "jiti") return undefined;
  if (within(resolve(tmpdir()), directory)) return { file, directory };
  if (directory.endsWith(join("node_modules", ".cache", "jiti"))) return { file, directory };
  return undefined;
}

/**
 * Import a staged worker module, recovering from a jiti cache directory that was
 * removed while this session still held the worker path.
 *
 * Jiti creates its transpile-cache directory once, then writes one rebuilt cache
 * file per source module. If another cleanup removes that directory mid-session,
 * the next worker import fails with ENOENT naming a cache file under it. Recreating
 * the validated cache directory lets jiti regenerate the file on one retry.
 */
export async function importStagedModule<T>(
  relativePath: string,
  options: {
    moduleUrl?: string;
    runtimeRoot?: string;
    identity?: StagedRuntimeIdentity;
    importModule?: (url: string) => T | Promise<T>;
  } = {},
): Promise<T> {
  const resolved = resolveStagedModule(relativePath, options);
  const load = options.importModule ?? ((url: string) => import(url) as Promise<T>);
  let failure: JitiCacheFailure | undefined;
  try {
    return await load(resolved.url);
  } catch (error) {
    failure = jitiCacheFailure(error);
    if (!failure) throw error;
    try {
      mkdirSync(failure.directory, { recursive: true });
    } catch (recreateError) {
      const cause = recreateError instanceof Error ? recreateError.message : String(recreateError);
      throw new Error(
        `The staged worker ${relativePath} could not start because the jiti transpile cache ${failure.file} was removed and its directory ${failure.directory} could not be recreated: ${cause}`,
        { cause: recreateError },
      );
    }
  }
  try {
    return await load(resolved.url);
  } catch (retryError) {
    const cause = retryError instanceof Error ? retryError.message : String(retryError);
    throw new Error(
      `The staged worker ${relativePath} could not start because the jiti transpile cache ${failure!.file} was removed while this session held its worker path. ` +
        `The cache directory ${failure!.directory} was recreated, but importing ${resolved.url} once more failed: ${cause}`,
      { cause: retryError },
    );
  }
}

/**
 * Explicit read-only artifact roots outside the run cwd (J-3760).
 *
 * A job cwd is often a project checkout, and a job's captures, screenshots and
 * logs must never be staged inside a checkout (no job evidence in a project
 * checkout). `--restricted` confines Claude Code file tools to the run cwd, so
 * a reviewer could not open those captures at all; `ownedPaths` cannot help
 * because dispatch refuses paths outside cwd. An explicit `readPaths` list on
 * a read-only task is the named grant that closes that gap.
 *
 * Bounds, all checked at dispatch before any checkpoint, relay peer or worker
 * exists, and re-checked per read at call time on the Pi harness:
 *   - read-only tasks only (`mayEdit` false): a task that may write cannot also
 *     read outside cwd;
 *   - only the private agent homes below, never `/`, `$HOME` or a project;
 *   - the named folder must be strictly below a private home (the cache root
 *     and a job home itself are never granted);
 *   - absolute, existing, a real directory: no file, no symlink leaf, and no
 *     symlink below the private root (the grant binds the physical path);
 *     a symlinked $HOME or private root itself is resolved and allowed;
 *   - no `..`, control characters or overlong values.
 * The grant is read-only on both harnesses: `--add-dir` on Claude Code (the
 * tool allowlist stays Read/Grep/Glob), a read-only path check on Pi.
 */
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";

/** Private agent homes a read-only reviewer may be granted; nothing else. */
export const READ_PATH_ROOTS = [
  ".cache/ut-coordinator",
  ".cache/agent-scratch",
  ".cache/ut-overseer",
] as const;

/**
 * `<root>/<one-segment>` is a job home (`ut-coordinator`, `ut-overseer`, which
 * hold that job's report and handoff) or a task home (`agent-scratch`, which
 * holds that task's own notes), so a grant always names a folder INSIDE one of
 * those and never the home itself.
 */
const MIN_GRANT_SEGMENTS = 2;

const JOB_FOLDER = /^J-\d+$/;
const MAX_READ_PATH_LENGTH = 2_000;

function refuse(field: string, reason: string): never {
  throw new Error(`${field} ${reason}`);
}

function isBelow(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function expandHome(value: string, home: string, field: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  // `~user/...` is never expanded here; resolving it would anchor it at the
  // process cwd, so it is refused by name instead.
  if (value.startsWith("~")) refuse(field, "must use ~/ for the operator home; ~user paths are not supported");
  return value;
}

/**
 * Validate one declared read path and return the physical absolute directory to
 * grant. Throws a field-prefixed, named error for every refusal.
 */
export function normalizeReadPath(input: unknown, field: string, home: string = homedir()): string {
  if (typeof input !== "string") refuse(field, "must be a string");
  // Checked before trimming: a newline or tab is never trimmed away into a
  // value that then reaches an argv or a prompt.
  if (/[\u0000-\u001f\u007f]/.test(input)) refuse(field, "must not contain control characters");
  const raw = input.trim();
  if (raw.length === 0) refuse(field, "must not be empty");
  if (raw.length > MAX_READ_PATH_LENGTH) refuse(field, `must be at most ${MAX_READ_PATH_LENGTH} characters`);
  if (raw.split(/[\\/]/).includes("..")) refuse(field, "must not contain a parent-directory segment");
  if (!raw.startsWith("~") && !isAbsolute(raw)) refuse(field, "must be an absolute path or start with ~/");
  const absolute = resolve(expandHome(raw, home, field));

  let physicalHome: string;
  try {
    physicalHome = realpathSync.native(home);
  } catch {
    refuse(field, "cannot be checked: the operator home is unavailable");
  }

  for (const root of READ_PATH_ROOTS) {
    // Accept both spellings of the home: the operator's own (`home`) and the
    // physical one. A resumed run records physical paths, and refusing them
    // because $HOME itself is reached through a symlink would break the resume.
    const rootPath = isBelow(join(home, root), absolute)
      ? join(home, root)
      : isBelow(join(physicalHome, root), absolute)
        ? join(physicalHome, root)
        : undefined;
    if (rootPath === undefined) continue;
    const segments = relative(rootPath, absolute).split(sep).filter((value) => value.length > 0);
    if (segments.length < MIN_GRANT_SEGMENTS) {
      refuse(field, `must name a folder inside a home below ~/${root} (for example ~/${root}/home/folder); the cache root and a task or job home itself are never granted`);
    }
    if (root !== ".cache/agent-scratch" && !JOB_FOLDER.test(segments[0])) {
      refuse(field, `must name a folder inside a job home (~/${root}/J-1234/folder), never another folder directly below ~/${root}`);
    }

    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      refuse(field, `does not exist as a folder (${raw})`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) refuse(field, "must be an existing real directory, never a file or a symlink");

    let physical: string;
    try {
      physical = realpathSync.native(absolute);
    } catch {
      refuse(field, "cannot be resolved on disk");
    }
    // The private home itself may be reached through an operator symlink (this
    // machine links ~/.cache/ut-coordinator to ut-overseer), so compare against
    // the resolved ROOT, then refuse any symlink below it.
    let physicalRoot: string;
    try {
      physicalRoot = realpathSync.native(rootPath);
    } catch {
      refuse(field, `cannot be resolved on disk: ~/${root} is unavailable`);
    }
    if (physical !== join(physicalRoot, ...segments)) refuse(field, "escapes its private home through a symlink");
    return physical;
  }
  refuse(field, `must be below one of ${READ_PATH_ROOTS.map((root) => `~/${root}`).join(", ")}; other locations are never granted`);
}

/**
 * Per-read check against the grant recorded at dispatch. Returns the physical
 * path when it is inside one of the declared roots, otherwise undefined. The
 * filesystem is re-read on every call: a path that turned into a symlink after
 * dispatch is refused rather than trusted.
 */
export function readUnderDeclaredRoots(readPaths: readonly string[], candidate: string): string | undefined {
  if (readPaths.length === 0) return undefined;
  const absolute = resolve(candidate);
  if (absolute.split(sep).includes("..")) return undefined;
  let physical: string;
  try {
    physical = realpathSync.native(absolute);
  } catch {
    return undefined;
  }
  for (const root of readPaths) {
    if (physical === root || isBelow(root, physical)) return physical;
  }
  return undefined;
}

/**
 * Prompt lines for a granted artifact root: a heading plus one bullet per path,
 * or nothing when the leaf has no grant. Shared by both harnesses so the
 * reviewer is told exactly what it may read and that it is never writable.
 */
export function readPathPromptLines(readPaths: readonly string[] | undefined, heading: string): string[] {
  const paths = readPaths ?? [];
  return paths.length === 0 ? [] : [heading, ...paths.map((value) => `- ${value}`)];
}

/**
 * Launch-time re-check of a grant already validated at dispatch: the folder must
 * still be the same real directory. A queued or background leaf can wait while a
 * path is replaced, and the CLI must never be handed a directory that is no
 * longer the one that was validated. Returns the validated physical path.
 */
export function verifyGrantedReadPath(path: string, field: string): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    refuse(field, "no longer exists");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse(field, "is no longer a real directory");
  let physical: string;
  try {
    physical = realpathSync.native(path);
  } catch {
    refuse(field, "cannot be resolved on disk");
  }
  if (physical !== path) refuse(field, "no longer resolves to the validated directory");
  return physical;
}

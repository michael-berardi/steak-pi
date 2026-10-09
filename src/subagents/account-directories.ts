/**
 * Filesystem checks for the account directories a router hands a worker, and for
 * the Pi session files a discarded attempt leaves behind. Only metadata is read
 * (lstat/realpath): a credential is never opened.
 *
 * An account directory chosen by a router (or recorded in a checkpoint, which is
 * untrusted data) must be strictly below the user's home, reachable without a
 * symlink, owned by the current user and, for the final directory, private (0700).
 * The primary account's legacy default directory (`~/.claude`, Pi's default agent
 * directory) is the one compatibility exception: it keeps whatever mode it has
 * (commonly 0755), is never validated against 0700 and is never modified.
 */
import { lstatSync, readFileSync, realpathSync, rmSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class AccountDirectoryError extends Error {}

function entry(path: string): Stats | undefined {
  try { return lstatSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

export function canonicalDirectory(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Whether `path` is the legacy default directory itself (lexically or through links). */
export function isLegacyDefaultDirectory(path: string, defaultDir: string): boolean {
  return resolve(path) === resolve(defaultDir) || canonicalDirectory(path) === canonicalDirectory(defaultDir);
}

/** Whether `path` lies inside `parent` (lexically or through links), the directory itself excluded. */
export function isInsideDirectory(path: string, parent: string): boolean {
  const inside = (child: string, base: string): boolean => {
    const rel = relative(base, child);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  return inside(resolve(path), resolve(parent)) || inside(canonicalDirectory(path), canonicalDirectory(parent));
}

/**
 * Throws unless `path` is a private account directory strictly below `home`.
 * Every component below `home` must be a real directory (never a symlink) owned
 * by the current user and not writable by group/other; the final one must be 0700.
 * Returns the normalised path. `home` itself may sit behind links (macOS /var).
 */
export function assertPrivateAccountDirectory(path: string, what: string, home: string = homedir()): string {
  if (!isAbsolute(path)) throw new AccountDirectoryError(`${what} is not an absolute path; no inference started and no other account was substituted`);
  const target = resolve(path);
  const base = resolve(home);
  const rel = relative(base, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new AccountDirectoryError(`${what} is outside the home directory; no inference started and no other account was substituted`);
  }
  const uid = currentUid();
  let current = base;
  const segments = rel.split(sep);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = entry(current);
    if (!stat) throw new AccountDirectoryError(`${what} is missing; no inference started and no other account was substituted`);
    if (stat.isSymbolicLink()) throw new AccountDirectoryError(`${what} passes through a symlink; no inference started and no other account was substituted`);
    if (!stat.isDirectory()) throw new AccountDirectoryError(`${what} is not a directory; no inference started and no other account was substituted`);
    if (uid !== undefined && stat.uid !== uid) throw new AccountDirectoryError(`${what} is not owned by the current user; no inference started and no other account was substituted`);
    const last = index === segments.length - 1;
    if (last ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o022) !== 0) {
      throw new AccountDirectoryError(last
        ? `${what} must be private (mode 0700); no inference started and no other account was substituted`
        : `${what} sits below a directory that group or others can write; no inference started and no other account was substituted`);
    }
  }
  // Belt and braces: the resolved location must be exactly where the walk went.
  if (realpathSync(target) !== join(realpathSync(base), rel)) {
    throw new AccountDirectoryError(`${what} resolves outside its expected location; no inference started and no other account was substituted`);
  }
  return target;
}

/** `auth.json` inside a validated agent directory: a regular, non-symlink file owned by the current user (never opened). */
export function assertAuthFileEntry(path: string, what: string): void {
  const stat = entry(path);
  const uid = currentUid();
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || (uid !== undefined && stat.uid !== uid)) {
    throw new AccountDirectoryError(`${what} has no auth.json owned by the current user; no inference started and no other account was substituted`);
  }
}

const SESSION_FILE_MAX_BYTES = 256 * 1024;

/**
 * Remove the Pi session file of an attempt that was discarded before any
 * inference. Only a file this attempt announced, directly inside the task
 * session directory it was given, a regular file, without any assistant message,
 * is removed. Returns whether a file was removed; anything doubtful is kept.
 */
export function removeDiscardedPiSession(file: string | undefined, sessionDir: string | undefined): boolean {
  if (!file || !sessionDir || !isAbsolute(file) || !isAbsolute(sessionDir) || !file.endsWith(".jsonl")) return false;
  const stat = entry(file);
  const uid = currentUid();
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > SESSION_FILE_MAX_BYTES || (uid !== undefined && stat.uid !== uid)) return false;
  let parent: string;
  try { parent = realpathSync(dirname(file)); } catch { return false; }
  if (parent !== canonicalDirectory(sessionDir) || basename(file).length === 0) return false;
  try {
    // Pre-inference means the model never answered; a session with an assistant turn is history and is kept.
    if (/"role"\s*:\s*"assistant"/.test(readFileSync(file, "utf8"))) return false;
    rmSync(file, { force: true });
    return true;
  } catch { return false; }
}

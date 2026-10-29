import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { lstatSync, realpathSync } from "node:fs";

/**
 * Read-only extra directory for Claude Code reviewers (J-3068).
 *
 * `--restricted` confines file tools to the run cwd, so a read-only reviewer
 * cannot open the staged review evidence an OverSeer job keeps under
 * ~/.cache/ut-overseer/<job>/review/. This grants exactly that one directory as
 * `--add-dir`, and only when the reviewer's own task text names a path inside
 * it (the same explicit-mention rule the Pi worker uses for staged files).
 * It never grants writes: the tool allowlist stays Read,Grep,Glob under
 * `--permission-mode dontAsk`, and the review argv guard still applies.
 * Other jobs' folders, the cache root and a job folder itself are never granted.
 */
export interface ClaudeReviewReadInput {
  role?: string;
  mayEdit?: boolean;
  task: string;
}

const JOB_ID = /^J-\d+$/;
const MENTION = /(?:~\/|\/)[^\s"'`()\[\],;]*?\.cache\/ut-overseer\/J-\d+\/review\/[^\s"'`()\[\],;]+/g;

/** Returns the review folders to add read-only, or [] when no grant applies. */
export function claudeReviewReadDirs(input: ClaudeReviewReadInput, home: string = homedir()): string[] {
  const role = typeof input.role === "string" ? input.role.trim().toLowerCase() : "";
  if (role !== "reviewer" || input.mayEdit === true) return [];
  const cacheRoot = join(home, ".cache", "ut-overseer");
  const granted = new Set<string>();
  for (const match of input.task.matchAll(MENTION)) {
    const raw = match[0];
    const expanded = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
    if (expanded.includes("\0") || expanded.split(/[\\/]/).includes("..")) continue;
    const rel = relative(cacheRoot, resolve(expanded)).split(sep);
    // rel = [J-id, "review", ...file]; the named path must sit below the review folder.
    if (rel.length < 3 || !JOB_ID.test(rel[0]) || rel[1] !== "review") continue;
    const dir = join(cacheRoot, rel[0], "review");
    try {
      // The grant must be the real directory: no symlinked review folder or cache root.
      if (!lstatSync(dir).isDirectory()) continue;
      if (realpathSync.native(dir) !== join(realpathSync.native(cacheRoot), rel[0], "review")) continue;
    } catch {
      continue;
    }
    granted.add(dir);
  }
  return [...granted];
}

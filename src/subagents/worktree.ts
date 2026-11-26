/**
 * Automatic isolated git worktrees for parallel USAP editing waves (B4).
 *
 * Under `workspace: "auto"` (default), per-task git worktrees are created ONLY when
 * `>= 2` independent tasks in a wave have `mayEdit: true` AND `run.cwd` sits inside
 * a clean git repository with a valid `HEAD`. Single-writer waves, read-only waves,
 * sequential writer chains (`mayEdit` task depending on another `mayEdit` task), and
 * dirty parent checkouts stay `"shared"` so local uncommitted work is never dropped.
 * Explicit `workspace: "worktree"` fails closed outside git; explicit `"shared"`
 * disables worktree creation.
 *
 * Worktrees are ALWAYS placed outside the repository tree (under a session-scoped
 * private directory, mode 0o700), NEVER auto-pushed, auto-cleaned ONLY when clean
 * and uncommitted, and retained whenever dirty or committed (even on cancel/abort).
 */
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunRecord, TaskRecord, TaskWorktreeReceipt } from "./types.ts";

export const DEFAULT_WORKTREE_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 5_000;
const DIFF_STAT_LIMIT = 600;
const RUN_DIR_RE = /^run-[A-Za-z0-9._-]{1,120}$/;
const META_FILE_RE = /^\.meta-[A-Za-z0-9._-]{1,120}\.json$/;
const USAP_BRANCH_RE = /^usap\/(run-[A-Za-z0-9._-]{1,120})\/[A-Za-z0-9._-]{1,120}$/;

export interface GitRepoInfo {
  repoRoot: string;
  baseCommit: string;
  dirty: boolean;
}

export interface WorktreeMetadata {
  version: 1;
  runId: string;
  taskId: string;
  ownerSessionId?: string;
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
  createdAt: number;
}

export interface PreparedWorktrees {
  active: boolean;
  repoRoot?: string;
  baseCommit?: string;
  isolatedTaskIds: string[];
  skippedReason?: "shared-mode" | "single-or-readonly" | "dependent-writers" | "not-git" | "dirty-parent";
}

export function defaultWorktreeRoot(home: string = homedir()): string {
  return join(home, ".cache", "steak-pi", "worktrees");
}

function runGit(cwd: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: "", status: 0 };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string; status?: number | null };
    const stdout = typeof err.stdout === "string" ? err.stdout : Buffer.isBuffer(err.stdout) ? err.stdout.toString("utf8") : "";
    const stderr = typeof err.stderr === "string" ? err.stderr : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8") : (err.message ?? "");
    return { ok: false, stdout, stderr, status: typeof err.status === "number" ? err.status : null };
  }
}

function comparablePath(value: string): string {
  const normalized = process.platform === "darwin" ? value.normalize("NFC") : value;
  return process.platform === "darwin" || process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(comparablePath(parent), comparablePath(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function isStrictlyInside(parent: string, child: string): boolean {
  const rel = relative(comparablePath(parent), comparablePath(child));
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function safeSlug(raw: string, maxLen: number): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "").slice(0, maxLen);
  return cleaned || "item";
}

function realOrResolved(path: string): string {
  try { return realpathSync.native(path); } catch {
    const abs = resolve(path);
    const parent = dirname(abs);
    if (parent !== abs) {
      try { return join(realpathSync.native(parent), basename(abs)); } catch { /* fall through */ }
    }
    return abs;
  }
}

/** Parse `git worktree list --porcelain` preserving entry order (index 0 is always the main worktree). */
function listedWorktreePaths(repoRoot: string): { main?: string; all: Set<string> } {
  const listed = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  const all = new Set<string>();
  let main: string | undefined;
  if (!listed.ok) return { all };
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      const raw = line.slice("worktree ".length).trim();
      if (raw) {
        const canonical = comparablePath(realOrResolved(raw));
        if (main === undefined) main = canonical;
        all.add(canonical);
      }
    }
  }
  return { main, all };
}

/**
 * True when `refs/heads/<branch>` exists and points to a commit other than `baseCommit`
 * (or cannot be read cleanly while existing). Never returns false for a branch with commits.
 */
function branchHasCommits(repoRoot: string, branch: string, baseCommit: string): boolean {
  const ref = `refs/heads/${branch}`;
  const tip = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  if (!tip.ok) {
    const exists = runGit(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
    // Exit status 1 from `git show-ref --verify --quiet` proves the ref does not exist;
    // any other failure (e.g. timeout, spawn/I/O error) fails closed to preserve the branch.
    return exists.ok || exists.status !== 1;
  }
  const sha = tip.stdout.trim();
  return sha === "" || sha !== baseCommit;
}

/**
 * Validate that a worktree receipt points strictly inside `<worktreeRoot>/<runSlug>/`,
 * matches `usap/<runSlug>/<taskSlug>`, and never aliases `repoRoot`.
 * When `expectedRunId` is provided, `<runSlug>` must equal `safeSlug(expectedRunId, 80)`.
 */
export function isSafeWorktreeReceipt(
  receipt: Pick<TaskWorktreeReceipt, "worktreePath" | "branch">,
  worktreeRoot: string,
  expectedRunId?: string,
  repoRoot?: string,
): { runSlug: string; runDir: string; branchPrefix: string } | undefined {
  const match = USAP_BRANCH_RE.exec(receipt.branch);
  if (!match) return undefined;
  const runSlug = match[1];
  if (expectedRunId !== undefined && runSlug !== safeSlug(expectedRunId, 80)) return undefined;
  const realRoot = realOrResolved(resolve(worktreeRoot));
  const runDir = join(realRoot, runSlug);
  const realRunDir = realOrResolved(runDir);
  if (!isStrictlyInside(realRoot, realRunDir)) return undefined;
  const realWt = realOrResolved(receipt.worktreePath);
  if (!isStrictlyInside(realRunDir, realWt)) return undefined;
  if (repoRoot !== undefined) {
    const realRepo = realOrResolved(repoRoot);
    if (comparablePath(realWt) === comparablePath(realRepo) || isWithin(realWt, realRepo)) return undefined;
  }
  return { runSlug, runDir, branchPrefix: `usap/${runSlug}/` };
}

/** Detect whether `cwd` sits inside a git repository with a valid `HEAD`, and whether it is dirty. */
export function resolveGitRepo(cwd: string): GitRepoInfo | undefined {
  const top = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return undefined;
  const repoRoot = top.stdout.trim();
  if (!repoRoot) return undefined;
  const head = runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return undefined;
  const baseCommit = head.stdout.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) return undefined;
  const status = runGit(repoRoot, ["status", "--porcelain"]);
  const dirty = status.ok && status.stdout.trim().length > 0;
  return { repoRoot: realOrResolved(repoRoot), baseCommit, dirty };
}

/** True when any `mayEdit` task has another `mayEdit` task anywhere in its transitive dependency ancestry. */
function hasDependentWriters(tasks: readonly TaskRecord[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, boolean>();
  const hasWriterAncestor = (taskId: string, visiting: Set<string>): boolean => {
    const cached = memo.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return false;
    visiting.add(taskId);
    const task = byId.get(taskId);
    let found = false;
    for (const depId of task?.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (!dep) continue;
      if (dep.mayEdit || hasWriterAncestor(dep.id, visiting)) {
        found = true;
        break;
      }
    }
    visiting.delete(taskId);
    memo.set(taskId, found);
    return found;
  };
  return tasks.some((task) => task.mayEdit && hasWriterAncestor(task.id, new Set()));
}

/** Whether a run's workspace policy calls for isolated git worktrees. */
export function shouldIsolateWorktrees(run: Pick<RunRecord, "workspace" | "tasks">): boolean {
  const mode = run.workspace ?? "auto";
  if (mode === "shared") return false;
  if (mode === "worktree") return true;
  if (run.tasks.filter((task) => task.mayEdit).length < 2) return false;
  if (hasDependentWriters(run.tasks)) return false;
  return true;
}

function ensurePrivateDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Unsafe USAP worktree directory: ${path}`);
  }
}

function writeMeta(path: string, meta: WorktreeMetadata): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(meta)); } finally { closeSync(fd); }
}

function readMeta(path: string): WorktreeMetadata | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const parsed = JSON.parse(readFileSync(fd, "utf8")) as Partial<WorktreeMetadata>;
      if (parsed.version !== 1 || typeof parsed.runId !== "string" || typeof parsed.taskId !== "string"
        || typeof parsed.repoRoot !== "string" || typeof parsed.worktreePath !== "string"
        || typeof parsed.branch !== "string" || typeof parsed.baseCommit !== "string"
        || typeof parsed.createdAt !== "number"
        || (parsed.ownerSessionId !== undefined && typeof parsed.ownerSessionId !== "string")) return undefined;
      return parsed as WorktreeMetadata;
    } finally { closeSync(fd); }
  } catch { return undefined; }
}

/**
 * Safely remove a verified USAP worktree and its `usap/` branch.
 * Refuses to remove anything outside `expectedRunDir`, any non-`usap/` branch,
 * any branch with commits ahead of `baseCommit`, the repository root or main
 * checkout (index 0 of `git worktree list`), or any unregistered existing path.
 */
function safeRemoveWorktreeAndBranch(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseCommit: string,
  expectedRunDir: string,
  expectedBranchPrefix: string,
): boolean {
  const realRepo = realOrResolved(repoRoot);
  const realRunDir = realOrResolved(expectedRunDir);
  const realWt = realOrResolved(worktreePath);
  if (!isStrictlyInside(realRunDir, realWt)) return false;
  if (comparablePath(realWt) === comparablePath(realRepo) || isWithin(realWt, realRepo)) return false;
  if (!branch.startsWith(expectedBranchPrefix) || !branch.startsWith("usap/")) return false;
  if (branchHasCommits(realRepo, branch, baseCommit)) return false;

  const exists = existsSync(worktreePath);
  if (exists) {
    const st = lstatSync(worktreePath);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    const listed = listedWorktreePaths(realRepo);
    const wtKey = comparablePath(realWt);
    if (!listed.all.has(wtKey) || (listed.main !== undefined && wtKey === listed.main)) return false;
    const removed = runGit(realRepo, ["worktree", "remove", "--force", worktreePath]);
    if (!removed.ok && existsSync(worktreePath)) {
      if (wtKey === comparablePath(realRepo) || (listed.main !== undefined && wtKey === listed.main)) return false;
      rmSync(worktreePath, { recursive: true, force: true });
      runGit(realRepo, ["worktree", "prune"]);
    }
  } else {
    runGit(realRepo, ["worktree", "prune"]);
  }
  runGit(realRepo, ["branch", "-D", branch]);
  return true;
}

function metaFilePath(runDir: string, taskId: string): string {
  return join(runDir, `.meta-${safeSlug(taskId, 80)}.json`);
}

function tryRemoveEmptyDir(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch { /* ignore */ }
}

/**
 * Prepare isolated git worktrees for a run when `workspace` requires it (or when
 * resumed tasks already carry retained worktrees). Mutates isolated tasks' `cwd`,
 * saves `originalOwnedPaths`, remaps `ownedPaths`, and sets initial `worktree` receipt.
 * Rolls back every newly created worktree if any creation fails.
 */
export function prepareRunWorktrees(
  run: RunRecord,
  options: { worktreeRoot?: string; now?: () => number } = {},
): PreparedWorktrees {
  const reusedTasks = run.tasks.filter((task) => task.worktree && !task.worktree.cleaned && existsSync(task.worktree.worktreePath));
  const mode = run.workspace ?? "auto";
  if (reusedTasks.length === 0) {
    if (mode === "shared") return { active: false, isolatedTaskIds: [], skippedReason: "shared-mode" };
    if (mode === "auto" && run.tasks.filter((task) => task.mayEdit).length < 2) {
      return { active: false, isolatedTaskIds: [], skippedReason: "single-or-readonly" };
    }
    if (mode === "auto" && hasDependentWriters(run.tasks)) {
      return { active: false, isolatedTaskIds: [], skippedReason: "dependent-writers" };
    }
  }

  const repo = resolveGitRepo(run.cwd);
  if (!repo) {
    if (mode === "worktree") {
      throw new Error(`USAP workspace "worktree" requires a git repository with a valid HEAD (cwd: ${run.cwd}).`);
    }
    return { active: false, isolatedTaskIds: [], skippedReason: "not-git" };
  }
  // Under default `auto`, never drop uncommitted parent edits by branching from HEAD.
  if (reusedTasks.length === 0 && mode === "auto" && repo.dirty) {
    return { active: false, isolatedTaskIds: [], skippedReason: "dirty-parent" };
  }

  const root = resolve(options.worktreeRoot ?? defaultWorktreeRoot());
  const physicalRoot = realOrResolved(root);
  if (isWithin(repo.repoRoot, physicalRoot) || isWithin(repo.repoRoot, root)) {
    throw new Error(`Refusing to create USAP git worktrees inside the repository tree (${repo.repoRoot}).`);
  }
  ensurePrivateDir(root);
  const runSlug = safeSlug(run.id, 80);
  const runDir = join(root, runSlug);

  const editTasks = run.tasks.filter((task) => task.mayEdit);
  const allTargets = shouldIsolateWorktrees(run) ? (editTasks.length > 0 ? editTasks : run.tasks) : reusedTasks;
  const targetsToCreate = allTargets.filter((task) =>
    !(task.worktree && !task.worktree.cleaned && existsSync(task.worktree.worktreePath))
    && !(!task.mayEdit && task.cwd !== undefined && task.cwd !== run.cwd && existsSync(task.cwd)));
  if (targetsToCreate.length > 0) ensurePrivateDir(runDir);

  const realRunCwd = realOrResolved(run.cwd);
  const relSubdir = relative(repo.repoRoot, realRunCwd);
  if (relSubdir.startsWith("..") || isAbsolute(relSubdir)) {
    throw new Error(`USAP run cwd (${run.cwd}) is not inside resolved git repository (${repo.repoRoot}).`);
  }

  const created: Array<{ task: TaskRecord; originalCwd: string | undefined; originalOwned: string[]; hadOriginalOwned: boolean; worktreePath: string; branch: string; metaPath: string }> = [];
  const now = (options.now ?? Date.now)();
  try {
    for (const task of targetsToCreate) {
      const taskSlug = safeSlug(task.id, 64);
      const worktreePath = join(runDir, taskSlug);
      const branch = `usap/${runSlug}/${taskSlug}`;
      const added = runGit(repo.repoRoot, ["worktree", "add", "-b", branch, worktreePath, repo.baseCommit]);
      if (!added.ok) {
        throw new Error(`Failed to create git worktree for task ${task.label}: ${added.stderr.trim().slice(0, 300)}`);
      }
      const metaPath = metaFilePath(runDir, task.id);
      writeMeta(metaPath, {
        version: 1,
        runId: run.id,
        taskId: task.id,
        ...(run.ownerSessionId ? { ownerSessionId: run.ownerSessionId } : {}),
        repoRoot: repo.repoRoot,
        worktreePath,
        branch,
        baseCommit: repo.baseCommit,
        createdAt: now,
      });
      const taskCwd = relSubdir ? join(worktreePath, relSubdir) : worktreePath;
      const originalCwd = task.cwd;
      const originalOwned = [...task.ownedPaths];
      const hadOriginalOwned = task.originalOwnedPaths !== undefined;
      task.originalOwnedPaths ??= originalOwned;
      task.cwd = taskCwd;
      task.ownedPaths = originalOwned.map((owned) => {
        const rel = relative(run.cwd, owned);
        return resolve(taskCwd, rel);
      });
      task.worktree = {
        worktreePath,
        branch,
        baseCommit: repo.baseCommit,
        dirty: false,
        committed: false,
        cleaned: false,
      };
      created.push({ task, originalCwd, originalOwned, hadOriginalOwned, worktreePath, branch, metaPath });
    }
  } catch (error) {
    for (const item of created.reverse()) {
      item.task.cwd = item.originalCwd;
      item.task.ownedPaths = item.originalOwned;
      if (!item.hadOriginalOwned) delete item.task.originalOwnedPaths;
      delete item.task.worktree;
      try { safeRemoveWorktreeAndBranch(repo.repoRoot, item.worktreePath, item.branch, repo.baseCommit, runDir, `usap/${runSlug}/`); } catch { /* best effort */ }
      try { rmSync(item.metaPath, { force: true }); } catch { /* best effort */ }
    }
    tryRemoveEmptyDir(runDir);
    throw error;
  }

  return {
    active: allTargets.length > 0,
    repoRoot: repo.repoRoot,
    baseCommit: repo.baseCommit,
    isolatedTaskIds: allTargets.map((task) => task.id),
  };
}

/**
 * Inspect and finalize a task's isolated worktree once the task settles.
 * Only clean, uncommitted worktrees verified inside `<worktreeRoot>/<runSlug>/`
 * are removed automatically; dirty or committed worktrees and branches (including
 * branches whose worktree folder was removed) are ALWAYS retained so edits are
 * never destroyed and can be integrated or resumed. Never pushes.
 */
export function finalizeTaskWorktree(
  repoRoot: string,
  task: TaskRecord,
  options: { worktreeRoot?: string; runId?: string; allowedRunIds?: readonly string[] } = {},
): TaskWorktreeReceipt | undefined {
  const receipt = task.worktree;
  if (!receipt || receipt.cleaned) return receipt;
  const { worktreePath, branch, baseCommit } = receipt;
  const root = resolve(options.worktreeRoot ?? defaultWorktreeRoot());
  const allowed = options.allowedRunIds && options.allowedRunIds.length > 0
    ? options.allowedRunIds
    : options.runId !== undefined ? [options.runId] : undefined;
  const validated = allowed
    ? allowed.map((id) => isSafeWorktreeReceipt(receipt, root, id, repoRoot)).find((v) => v !== undefined)
    : isSafeWorktreeReceipt(receipt, root, undefined, repoRoot);

  let dirty = false;
  let committed = false;
  let diffStat: string | undefined;

  if (existsSync(worktreePath)) {
    const status = runGit(worktreePath, ["status", "--porcelain"]);
    const statusLines = status.ok ? status.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean) : [];
    dirty = statusLines.length > 0;
    const head = runGit(worktreePath, ["rev-parse", "HEAD"]);
    committed = !head.ok || (head.stdout.trim() !== "" && head.stdout.trim() !== baseCommit);
    const stat = runGit(worktreePath, ["diff", "--stat", baseCommit]);
    const untracked = statusLines.filter((line) => line.startsWith("?? ")).length;
    const parts = [
      ...(stat.ok && stat.stdout.trim() ? [stat.stdout.trim()] : []),
      ...(untracked > 0 ? [`${untracked} untracked file${untracked === 1 ? "" : "s"}`] : []),
    ];
    if (parts.length > 0) diffStat = parts.join("\n").slice(0, DIFF_STAT_LIMIT);
  } else {
    // Even if the worktree folder was manually removed, preserve any branch with commits.
    committed = branchHasCommits(repoRoot, branch, baseCommit);
  }

  const wantClean = !dirty && !committed;
  let cleaned = false;
  if (wantClean && validated) {
    try {
      cleaned = safeRemoveWorktreeAndBranch(
        repoRoot,
        worktreePath,
        branch,
        baseCommit,
        validated.runDir,
        validated.branchPrefix,
      );
    } catch { cleaned = false; }
    if (cleaned) {
      try { rmSync(metaFilePath(validated.runDir, task.id), { force: true }); } catch { /* best effort */ }
      tryRemoveEmptyDir(validated.runDir);
    }
  }
  const updated: TaskWorktreeReceipt = {
    worktreePath,
    branch,
    baseCommit,
    dirty,
    committed,
    ...(diffStat ? { diffStat } : {}),
    cleaned,
  };
  task.worktree = updated;
  return updated;
}

/**
 * Bounded, owner-safe, session-scoped sweep of clean orphaned USAP worktrees on startup.
 * Skips other sessions' worktrees, active runs, symlinks, foreign uids, retained paths,
 * and ANY dirty or committed worktree/branch (user work is never auto-deleted).
 * Validates metadata paths and branch names before removal.
 */
export function sweepOrphanWorktrees(
  worktreeRoot: string = defaultWorktreeRoot(),
  options: {
    ownerSessionId?: string;
    activeRunIds?: ReadonlySet<string>;
    retainedWorktreePaths?: ReadonlySet<string>;
    maxRemovals?: number;
  } = {},
): number {
  if (!existsSync(worktreeRoot)) return 0;
  let rootStat;
  try { rootStat = lstatSync(worktreeRoot); } catch { return 0; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (process.getuid && rootStat.uid !== process.getuid())) return 0;

  const activeRunIds = options.activeRunIds ?? new Set<string>();
  const retained = new Set([...(options.retainedWorktreePaths ?? [])].map((p) => comparablePath(realOrResolved(p))));
  const maxRemovals = options.maxRemovals ?? 8;

  let removed = 0;
  let entries: string[];
  try { entries = readdirSync(worktreeRoot); } catch { return 0; }

  for (const runName of entries) {
    if (removed >= maxRemovals) break;
    if (!RUN_DIR_RE.test(runName) || activeRunIds.has(runName)) continue;
    const runDir = join(worktreeRoot, runName);
    try {
      const stat = lstatSync(runDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) continue;
      const children = readdirSync(runDir);
      for (const child of children) {
        if (removed >= maxRemovals) break;
        if (!META_FILE_RE.test(child)) continue;
        const metaPath = join(runDir, child);
        const meta = readMeta(metaPath);
        if (!meta) continue;
        // Session scoping: never touch another session's worktrees.
        if (options.ownerSessionId !== undefined && meta.ownerSessionId !== options.ownerSessionId) continue;
        if (activeRunIds.has(meta.runId)) continue;
        if (retained.has(comparablePath(realOrResolved(meta.worktreePath)))) continue;

        const expectedBranchPrefix = `usap/${runName}/`;
        if (!meta.branch.startsWith(expectedBranchPrefix)) continue;
        if (!isStrictlyInside(realOrResolved(runDir), realOrResolved(meta.worktreePath))) continue;

        const exists = existsSync(meta.worktreePath);
        let dirtyOrCommitted = false;
        if (exists) {
          const wtStat = lstatSync(meta.worktreePath);
          if (wtStat.isSymbolicLink() || !wtStat.isDirectory() || (process.getuid && wtStat.uid !== process.getuid())) continue;
          const st = runGit(meta.worktreePath, ["status", "--porcelain"]);
          const hd = runGit(meta.worktreePath, ["rev-parse", "HEAD"]);
          dirtyOrCommitted = !st.ok || st.stdout.trim().length > 0
            || !hd.ok || (hd.stdout.trim() !== "" && hd.stdout.trim() !== meta.baseCommit);
        } else {
          // Even when the worktree folder is missing, preserve any branch with commits.
          dirtyOrCommitted = branchHasCommits(meta.repoRoot, meta.branch, meta.baseCommit);
        }
        // Never auto-delete dirty or committed worktrees/branches.
        if (!dirtyOrCommitted) {
          const ok = safeRemoveWorktreeAndBranch(meta.repoRoot, meta.worktreePath, meta.branch, meta.baseCommit, runDir, expectedBranchPrefix);
          if (ok) {
            try { rmSync(metaPath, { force: true }); } catch { /* ignore */ }
            removed += 1;
          }
        }
      }
      tryRemoveEmptyDir(runDir);
    } catch { /* Never break startup on concurrent filesystem changes. */ }
  }
  return removed;
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * The operator's project routing policy, read from the coordinator's policy file. Project names live only
 * in that file, never in this code. A project is matched the way the coordinator matches a job: a name
 * equals a whole folder name (case-insensitive) in the working directory, the repository it belongs to
 * (a git worktree resolves to its main checkout) or a path a task owns.
 *
 *  - `noClaudeProjects`: the project's work never runs on a Claude plan, so the implicit walk skips every Claude tier.
 *  - `planOnlyProjects`: the project's work never runs on a paid metered route, so the implicit walk skips them.
 *
 * A missing file means no policy. A file that exists but cannot be read or parsed cannot say which projects
 * are protected, so it restricts both, exactly like the coordinator.
 */
export interface ProjectPolicy {
  /** The noClaudeProjects entry (or the unreadable-policy cause) that keeps Claude out. */
  noClaude?: string;
  /** The planOnlyProjects entry (or the unreadable-policy cause) that keeps paid routes out. */
  planOnly?: string;
}

export const projectPolicyPath = (env: NodeJS.ProcessEnv = process.env): string =>
  env.ULTRATERM_COORDINATOR_POLICY || join(homedir(), ".ultraterm", "coordinator", "policy.json");

/** The main checkout a git worktree belongs to (from its `.git` pointer file), or the repo root itself. */
function repoRootsOf(cwd: string): string[] {
  const roots: string[] = [];
  let dir = resolve(cwd);
  for (let depth = 0; depth < 40; depth += 1) {
    const marker = join(dir, ".git");
    if (existsSync(marker)) {
      roots.push(dir);
      try {
        if (statSync(marker).isFile()) {
          const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, "utf8"))?.[1]?.trim();
          if (pointer) {
            const gitdir = isAbsolute(pointer) ? pointer : resolve(dir, pointer);
            const at = gitdir.lastIndexOf(`${sep}.git${sep}worktrees${sep}`);
            if (at > 0) roots.push(gitdir.slice(0, at));
          }
        }
      } catch { /* an unreadable pointer leaves the checkout's own path */ }
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return roots;
}

/** Resolve the policy for a dispatch. `paths` are the working directory plus every path a task owns. */
export function resolveProjectPolicy(cwd: string, ownedPaths: readonly string[] = [], options: { policyPath?: string } = {}): ProjectPolicy {
  const file = options.policyPath ?? projectPolicyPath();
  let raw: string;
  try { raw = readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    const cause = `policy file unreadable (${(error as Error).message.slice(0, 80)})`;
    return { noClaude: cause, planOnly: cause };
  }
  let policy: unknown;
  try { policy = JSON.parse(raw); }
  catch {
    const cause = "policy file is not valid JSON";
    return { noClaude: cause, planOnly: cause };
  }
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    const cause = "policy file is not a JSON object";
    return { noClaude: cause, planOnly: cause };
  }
  const folders = [cwd, ...repoRootsOf(cwd), ...ownedPaths.map((path) => isAbsolute(path) ? path : resolve(cwd, path))];
  const parts = new Set(folders.flatMap((folder) => folder.split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase())));
  const match = (key: string): string | undefined => {
    const names = (policy as Record<string, unknown>)[key];
    if (!Array.isArray(names)) return undefined;
    for (const entry of names) {
      if (typeof entry !== "string" || entry.trim() === "") continue;
      const name = entry.trim().toLowerCase();
      if (parts.has(name)) return name;
    }
    return undefined;
  };
  const noClaude = match("noClaudeProjects");
  const planOnly = match("planOnlyProjects");
  return { ...(noClaude ? { noClaude } : {}), ...(planOnly ? { planOnly } : {}) };
}

export const noClaudeCause = (policy: ProjectPolicy): string =>
  `Claude is not allowed for this project (policy noClaudeProjects: ${policy.noClaude})`;
export const planOnlyCause = (policy: ProjectPolicy): string =>
  `paid metered routes are not allowed for this project (policy planOnlyProjects: ${policy.planOnly})`;

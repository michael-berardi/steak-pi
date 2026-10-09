import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { assertPrivateAccountDirectory, isLegacyDefaultDirectory } from "./account-directories.ts";

/** Claude Code session ids are lowercase UUIDs. */
export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionEntry(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Delete a finished worker's Claude transcript (and its subagent folder).
 * USAP never retains worker prompts once they are no longer needed to resume. */
export function removeClaudeWorkerSession(id: string, home: string = homedir(), configDir?: string): void {
  if (!CLAUDE_SESSION_ID.test(id)) return;
  // A task bound to a secondary account keeps its transcript in that account's config directory.
  // Checkpoint data is untrusted: a directory that is not a private account directory below
  // `home` (or the legacy default itself) is never touched.
  let claude = join(home, ".claude");
  if (configDir !== undefined && !isLegacyDefaultDirectory(configDir, claude)) {
    try { claude = assertPrivateAccountDirectory(configDir, "Claude account config directory", home); }
    catch { return; }
  }
  const projects = join(claude, "projects");
  // lstat, not stat: no intermediate project/root symlink may redirect cleanup.
  if (!sessionEntry(claude)?.isDirectory() || !sessionEntry(projects)?.isDirectory()) return;
  const projectsPath = realpathSync(projects);
  for (const dir of readdirSync(projects)) {
    const project = join(projects, dir);
    if (!sessionEntry(project)?.isDirectory()) continue;
    if (dirname(realpathSync(project)) !== projectsPath) continue;
    const transcript = join(project, `${id}.jsonl`);
    const children = join(project, id);
    if (sessionEntry(transcript)?.isFile()) rmSync(transcript, { force: true });
    // Refuse even a final-target symlink rather than asking rm to recurse on it.
    if (sessionEntry(children)?.isDirectory()) rmSync(children, { force: true, recursive: true });
  }
}

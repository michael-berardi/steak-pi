import { readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code session ids are lowercase UUIDs. */
export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Delete a finished worker's Claude transcript (and its subagent folder).
 * USAP never retains worker prompts once they are no longer needed to resume. */
export function removeClaudeWorkerSession(id: string, home: string = homedir()): void {
  if (!CLAUDE_SESSION_ID.test(id)) return;
  const projects = join(home, ".claude", "projects");
  let dirs: string[];
  try { dirs = readdirSync(projects); } catch { return; }
  for (const dir of dirs) {
    rmSync(join(projects, dir, `${id}.jsonl`), { force: true });
    rmSync(join(projects, dir, id), { force: true, recursive: true });
  }
}

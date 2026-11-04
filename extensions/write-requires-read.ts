import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * `write` replaces a whole file. A model that never saw an existing file (a failed probe read as "missing") would
 * destroy it silently. Like Claude Code, refuse a `write` to an existing path this session has not read, edited or
 * created, and name the fix in the error. `STEAK_PI_WRITE_GUARD=off` switches it off.
 */
export const FILE_RULE =
  "Files: a failed command is not proof a file is missing. Use read or `test -e` to check, and never replace a file you have not read. To add to a file, append (`>>`) or use edit.";

export default function writeRequiresRead(pi: ExtensionAPI): void {
  const known = new Set<string>();
  const pending = new Map<string, string>();
  const key = (cwd: string, path: unknown): string | null =>
    typeof path === "string" && path.length > 0 ? resolve(cwd, path.replace(/^@/, "")) : null;

  pi.on("before_agent_start", event => {
    if (process.env.STEAK_PI_WRITE_GUARD === "off" || event.systemPrompt.includes(FILE_RULE)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${FILE_RULE}` };
  });

  pi.on("session_start", () => {
    known.clear();
    pending.clear();
  });

  pi.on("tool_call", (event, ctx) => {
    if (process.env.STEAK_PI_WRITE_GUARD === "off") return undefined;
    const name = event.toolName;
    if (name !== "read" && name !== "edit" && name !== "write") return undefined;
    const file = key(ctx.cwd, (event.input as { path?: unknown })?.path);
    if (!file) return undefined;
    if (name === "write" && existsSync(file) && !known.has(file)) {
      return {
        block: true,
        reason: `${file} already exists and has not been read in this session. Read it first, then use edit to change it (or append with bash), or write only after reading it.`,
      };
    }
    pending.set(event.toolCallId, file);
    return undefined;
  });

  pi.on("tool_result", event => {
    const file = pending.get(event.toolCallId);
    if (!file) return undefined;
    pending.delete(event.toolCallId);
    if (!event.isError) known.add(file);
    return undefined;
  });
}

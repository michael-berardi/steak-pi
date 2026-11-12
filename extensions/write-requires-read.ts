import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * `write` replaces a whole file. A model that never saw an existing file (a failed probe read as "missing") would
 * destroy it silently. Like Claude Code, refuse a `write` to an existing path this session has not read, edited or
 * created, and name the fix in the error. `STEAK_PI_WRITE_GUARD=off` switches it off.
 *
 * A file also counts as seen when a shell command that prints file contents (`cat`, `head`, `tail`, `nl`, `sed`,
 * `awk`, `less`, `more`, `bat`) named it and succeeded: the model has the contents in front of it, and making it
 * read the file again costs a refused call and a repeat read for nothing. Listing, testing or searching a file does
 * not count, and neither does a command that failed.
 */
export const FILE_RULE =
  "Files: a failed command is not proof a file is missing. Use read or `test -e` to check, and never replace a file you have not read. To add to a file, append (`>>`) or use edit.";

const PRINTS_CONTENTS = /(?:^|[\s;&|(`])(?:cat|head|tail|nl|sed|awk|less|more|bat)(?=\s)/;
const MAX_SHOWN = 256;

const isFile = (path: string): boolean => {
  try { return statSync(path).isFile(); } catch { return false; }
};

/** Existing files a contents-printing shell command names: plain paths, and `*` in the last path segment. */
export function filesShownBy(cwd: string, command: unknown): string[] {
  if (typeof command !== "string" || command.length > 20_000 || !PRINTS_CONTENTS.test(command)) return [];
  const shown = new Set<string>();
  for (const raw of command.split(/[\s;&|()<>`]+/)) {
    if (shown.size >= MAX_SHOWN) break;
    const token = raw.replace(/^["']+|["']+$/g, "");
    if (!token || token.startsWith("-") || token.includes("$") || token.length > 1024) continue;
    if (!token.includes("*")) {
      const file = resolve(cwd, token);
      if (isFile(file)) shown.add(file);
      continue;
    }
    const name = basename(token);
    const dir = resolve(cwd, dirname(token));
    if (dirname(token).includes("*") || name.includes("**")) continue;
    const pattern = new RegExp(`^${name.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (shown.size >= MAX_SHOWN) break;
      if (entry.startsWith(".") && !name.startsWith(".")) continue;
      const file = resolve(dir, entry);
      if (pattern.test(entry) && isFile(file)) shown.add(file);
    }
  }
  return [...shown];
}

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

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === "bash") {
      if (!event.isError && process.env.STEAK_PI_WRITE_GUARD !== "off") {
        for (const shown of filesShownBy(ctx.cwd, (event.input as { command?: unknown })?.command)) known.add(shown);
      }
      return undefined;
    }
    const file = pending.get(event.toolCallId);
    if (!file) return undefined;
    pending.delete(event.toolCallId);
    if (!event.isError) known.add(file);
    return undefined;
  });
}

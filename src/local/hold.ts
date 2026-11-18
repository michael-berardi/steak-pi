/**
 * Holds on the local model: times when it must not run at all, whatever asks for it.
 *
 * Two rules, both the operator's, both in `~/.pi/agent/local/hold.json` (nothing here names a model, a project or a program):
 *
 *  - a timed hold (`steak-pi local hold 24h [reason]`): off until that moment, then on again by itself;
 *  - a quiet-day rule (`steak-pi local quiet path <dir>` / `quiet process <name>`): work the local model must not share the
 *    machine with. The first sign of it on a calendar day (a listed program running, or a commit, checkout, merge or
 *    rebase in a listed repository) switches the local model off for the rest of that local day. The day is remembered in the
 *    file, so it stays off after the program is closed, and the next day starts clean.
 *
 * `planStart` asks `activeHold` before anything else, so `ensure`, `start`, `check` and the session hook all refuse with the
 * same named cause, and the supervisor asks it while a server runs, so a hold that begins mid-session stops the server.
 * A hold file that cannot be read is a hold (`bad-hold`): a typo must never switch the rule off silently.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { LocalError } from "./errors.ts";
import { withLock, writeAtomic } from "./store.ts";

export interface QuietRule { paths: string[]; processes: string[] }
export interface HoldFile {
  /** Epoch ms the timed hold ends. */
  until?: number;
  reason?: string;
  quiet?: QuietRule;
  /** The local calendar day (YYYY-MM-DD) the quiet rule fired on, and what fired it. */
  quietDay?: { date: string; cause: string };
}
export interface HoldProbe {
  /** Executable names of the running processes (basenames, never command lines). */
  processNames(): string[];
  /** Modification time in epoch ms, or undefined when the path does not exist. */
  mtime(path: string): number | undefined;
  list(dir: string): string[];
}
export interface ActiveHold { code: "on-hold" | "quiet-day" | "bad-hold"; detail: string }

export const holdPath = (dir: string): string => join(dir, "hold.json");
const PROCESS_NAME = /^[\w .+-]{1,64}$/;

export const localDay = (ms: number): string => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const dayStart = (ms: number): number => { const date = new Date(ms); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
const clock = (ms: number): string => {
  const date = new Date(ms);
  return `${localDay(ms)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const strings = (value: unknown, key: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) throw new LocalError("bad-hold", `hold.json ${key} must be a list of non-empty strings`);
  return value as string[];
};

/** Read and validate hold.json. A missing file is no hold; anything unreadable throws `bad-hold` naming the fault. */
export function readHold(dir: string): HoldFile {
  const path = holdPath(dir);
  if (!existsSync(path)) return {};
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new LocalError("bad-hold", `${path} is not valid JSON (${(error as Error).message}); fix it or remove it with: steak-pi local hold off`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LocalError("bad-hold", `${path} must be a JSON object`);
  const file = raw as Record<string, unknown>;
  const out: HoldFile = {};
  if (file.until !== undefined) {
    if (typeof file.until !== "number" || !Number.isFinite(file.until)) throw new LocalError("bad-hold", "hold.json until must be a time in epoch milliseconds");
    out.until = file.until;
  }
  if (file.reason !== undefined) {
    if (typeof file.reason !== "string") throw new LocalError("bad-hold", "hold.json reason must be text");
    out.reason = file.reason;
  }
  if (file.quiet !== undefined) {
    if (!file.quiet || typeof file.quiet !== "object" || Array.isArray(file.quiet)) throw new LocalError("bad-hold", "hold.json quiet must be an object with paths and processes");
    const quiet = file.quiet as Record<string, unknown>;
    out.quiet = { paths: strings(quiet.paths, "quiet.paths"), processes: strings(quiet.processes, "quiet.processes") };
  }
  if (file.quietDay !== undefined) {
    const day = file.quietDay as Record<string, unknown> | null;
    if (!day || typeof day !== "object" || typeof day.date !== "string" || typeof day.cause !== "string") throw new LocalError("bad-hold", "hold.json quietDay must be { date, cause }");
    out.quietDay = { date: day.date, cause: day.cause };
  }
  return out;
}

const save = (dir: string, file: HoldFile): void => writeAtomic(holdPath(dir), `${JSON.stringify(file, null, 2)}\n`);

/** The files git rewrites when a repository is worked in: a commit, checkout, merge, reset or rebase, here or in a linked worktree.
 * The index is left out on purpose: `git status` refreshes it, so a tool that only looks at a repository would count as work. */
function activityFiles(repo: string, probe: HoldProbe): string[] {
  const git = join(repo, ".git");
  const own = ["HEAD", "ORIG_HEAD", join("logs", "HEAD")].map((name) => join(git, name));
  const linked = probe.list(join(git, "worktrees")).flatMap((name) => ["HEAD", "ORIG_HEAD", join("logs", "HEAD")].map((file) => join(git, "worktrees", name, file)));
  return [...own, ...linked];
}

/** What fired the quiet rule right now, or undefined. */
export function quietTrigger(rule: QuietRule, now: number, probe: HoldProbe): string | undefined {
  if (rule.processes.length) {
    const wanted = new Set(rule.processes.map((name) => name.toLowerCase()));
    const running = probe.processNames().find((name) => wanted.has(name.toLowerCase()));
    if (running) return `${running} is running`;
  }
  const since = dayStart(now);
  for (const repo of rule.paths) {
    const touched = activityFiles(repo, probe).some((file) => { const at = probe.mtime(file); return at !== undefined && at >= since; });
    if (touched) return `work in ${repo} today`;
  }
  return undefined;
}

/**
 * The hold in force now, or undefined. Evaluating it remembers a quiet day the first time the rule fires (one small atomic
 * write), so the answer stays the same for the rest of that day.
 */
export function activeHold(dir: string, now: number, probe: HoldProbe = systemHoldProbe): ActiveHold | undefined {
  let file: HoldFile;
  try { file = readHold(dir); }
  catch (error) { return { code: "bad-hold", detail: error instanceof Error ? error.message : String(error) }; }
  if (file.until !== undefined && now < file.until) {
    return { code: "on-hold", detail: `the local model is on hold until ${clock(file.until)}${file.reason ? ` (${file.reason})` : ""}; it comes back by itself, or end the hold with: steak-pi local hold off` };
  }
  const today = localDay(now);
  const off = (cause: string): ActiveHold => ({ code: "quiet-day", detail: `the local model is off for the rest of today (${today}): ${cause}; it comes back tomorrow. The rule: steak-pi local quiet` });
  if (file.quietDay?.date === today) return off(file.quietDay.cause);
  if (!file.quiet) return undefined;
  const cause = quietTrigger(file.quiet, now, probe);
  if (!cause) return undefined;
  try { save(dir, { ...readHold(dir), quietDay: { date: today, cause } }); } catch { /* still a hold now; the next check tries again */ }
  return off(cause);
}

const DURATION = /^(\d+(?:\.\d+)?)(m|h|d)$/;
export function parseDuration(text: string): number {
  const match = DURATION.exec(text);
  const ms = match ? Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"] : NaN;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 366 * 86_400_000) throw new LocalError("bad-option", `"${text}" is not a hold length; use a number and m, h or d (for example 24h), at most 366d`);
  return Math.round(ms);
}

const edit = async (dir: string, change: (file: HoldFile) => HoldFile): Promise<HoldFile> => withLock(dir, async () => {
  let current: HoldFile;
  try { current = readHold(dir); } catch { current = {}; } // an unreadable file is replaced by the command that edits it
  const next = change(current);
  save(dir, next);
  return next;
});

export const setHold = (dir: string, until: number, reason?: string): Promise<HoldFile> =>
  edit(dir, (file) => { const { reason: _old, ...rest } = file; return { ...rest, until, ...(reason ? { reason } : {}) }; });
export const clearHold = (dir: string): Promise<HoldFile> =>
  edit(dir, (file) => { const { until: _until, reason: _reason, ...rest } = file; return rest; });
export const markQuietToday = (dir: string, now: number, cause: string): Promise<HoldFile> =>
  edit(dir, (file) => ({ ...file, quietDay: { date: localDay(now), cause } }));

export function addQuiet(dir: string, kind: "path" | "process", value: string): Promise<HoldFile> {
  let entry = value;
  if (kind === "path") {
    entry = resolve(value);
    if (!isAbsolute(entry) || !existsSync(join(entry, ".git"))) throw new LocalError("bad-option", `${value} is not a git repository (no .git there); the quiet rule watches a repository's commits, checkouts and merges`);
  } else if (!PROCESS_NAME.test(value)) throw new LocalError("bad-option", `"${value}" is not a program name; give the executable's name as the process list shows it`);
  return edit(dir, (file) => {
    const quiet = file.quiet ?? { paths: [], processes: [] };
    const list = kind === "path" ? quiet.paths : quiet.processes;
    return { ...file, quiet: { ...quiet, [kind === "path" ? "paths" : "processes"]: list.includes(entry) ? list : [...list, entry] } };
  });
}
export async function removeQuiet(dir: string, value: string): Promise<{ file: HoldFile; removed: boolean }> {
  let removed = false;
  const full = resolve(value);
  const file = await edit(dir, (current) => {
    if (!current.quiet) return current;
    const paths = current.quiet.paths.filter((entry) => entry !== value && entry !== full);
    const processes = current.quiet.processes.filter((entry) => entry !== value);
    removed = paths.length !== current.quiet.paths.length || processes.length !== current.quiet.processes.length;
    return { ...current, quiet: { paths, processes } };
  });
  return { file, removed };
}

/** The lines `status` and `quiet` print. */
export function describeHold(dir: string, now: number, probe: HoldProbe = systemHoldProbe): string[] {
  const active = activeHold(dir, now, probe);
  let file: HoldFile = {};
  try { file = readHold(dir); } catch { /* reported as the active hold */ }
  const rule = file.quiet && (file.quiet.paths.length || file.quiet.processes.length)
    ? [`quiet    off for the day when: ${[...file.quiet.paths.map((path) => `work in ${path}`), ...file.quiet.processes.map((name) => `${name} runs`)].join("; ")}`]
    : [];
  return [`hold     ${active ? `${active.code}: ${active.detail}` : "none"}`, ...rule];
}

export const systemHoldProbe: HoldProbe = {
  processNames: () => {
    try {
      return execFileSync("ps", ["-axo", "comm="], { encoding: "utf8", timeout: 5000 }).split("\n").map((line) => line.trim().split("/").pop() ?? "").filter(Boolean);
    } catch { return []; }
  },
  mtime: (path) => { try { return statSync(path).mtimeMs; } catch { return undefined; } },
  list: (dir) => { try { return readdirSync(dir); } catch { return []; } },
};

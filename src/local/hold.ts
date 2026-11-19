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
import { closeSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { LocalError } from "./errors.ts";
import { tryLockSync, withLock, writeAtomic } from "./store.ts";

export interface QuietRule { paths: string[]; processes: string[] }
export interface HoldFile {
  /** Epoch ms the timed hold ends. */
  until?: number;
  reason?: string;
  quiet?: QuietRule;
  /** The local calendar day (YYYY-MM-DD) the quiet rule fired on, and what fired it. */
  quietDay?: { date: string; cause: string };
  /**
   * An operator's explicit override: until this time (epoch ms) neither the timed hold nor the quiet-day rule refuses a
   * start. The hold and the rule stay recorded and apply again when it ends. Set only by `steak-pi local bypass`.
   */
  bypass?: { until: number; reason?: string };
}
export interface HoldProbe {
  /** Executable names of the running processes (basenames, never command lines). Throws when the process list cannot be read. */
  processNames(): string[];
  /** Modification time in epoch ms, or undefined when the path does not exist. */
  mtime(path: string): number | undefined;
  list(dir: string): string[];
  /** The text of a small file (its last `tailBytes` bytes when it is longer), or undefined when it is missing or is a directory. */
  readText(path: string, tailBytes?: number): string | undefined;
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

const ONLY = (value: Record<string, unknown>, allowed: string[], where: string): void => {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new LocalError("bad-hold", `${where} has unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown.map((key) => JSON.stringify(key)).join(", ")} (known: ${allowed.join(", ")}); a typo must not switch the rule off, so fix it or remove it with: steak-pi local hold off`);
};

/**
 * Read and validate hold.json. A missing file is no hold; anything else that cannot be read, an unreadable folder
 * included, an unknown key or a wrong type throws `bad-hold` naming the fault.
 */
export function readHold(dir: string): HoldFile {
  const path = holdPath(dir);
  try { statSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Only a folder that exists and lists fine, or one that is simply not there yet, means "no hold".
      try { statSync(dir); } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw new LocalError("bad-hold", `${dir} cannot be read (${(inner as Error).message}), so whether the local model is on hold is unknown`);
      }
      return {};
    }
    throw new LocalError("bad-hold", `${path} cannot be read (${(error as Error).message}), so whether the local model is on hold is unknown`);
  }
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { throw new LocalError("bad-hold", `${path} cannot be read (${(error as Error).message}); fix its permissions or move it aside with: steak-pi local hold off`); }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch (error) { throw new LocalError("bad-hold", `${path} is not valid JSON (${(error as Error).message}); fix it, or keep a copy and start clean with: steak-pi local hold off`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new LocalError("bad-hold", `${path} must be a JSON object`);
  const file = raw as Record<string, unknown>;
  ONLY(file, ["until", "reason", "quiet", "quietDay", "bypass"], "hold.json");
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
    ONLY(quiet, ["paths", "processes"], "hold.json quiet");
    out.quiet = { paths: strings(quiet.paths, "quiet.paths"), processes: strings(quiet.processes, "quiet.processes") };
  }
  if (file.quietDay !== undefined) {
    const day = file.quietDay as Record<string, unknown> | null;
    if (!day || typeof day !== "object" || Array.isArray(day) || typeof day.date !== "string" || typeof day.cause !== "string") throw new LocalError("bad-hold", "hold.json quietDay must be { date, cause }");
    ONLY(day, ["date", "cause"], "hold.json quietDay");
    out.quietDay = { date: day.date, cause: day.cause };
  }
  if (file.bypass !== undefined) {
    const bypass = file.bypass as Record<string, unknown> | null;
    if (!bypass || typeof bypass !== "object" || Array.isArray(bypass) || typeof bypass.until !== "number" || !Number.isFinite(bypass.until) || (bypass.reason !== undefined && typeof bypass.reason !== "string")) throw new LocalError("bad-hold", "hold.json bypass must be { until, reason? }");
    ONLY(bypass, ["until", "reason"], "hold.json bypass");
    out.bypass = { until: bypass.until, ...(typeof bypass.reason === "string" ? { reason: bypass.reason } : {}) };
  }
  return out;
}

const save = (dir: string, file: HoldFile): void => writeAtomic(holdPath(dir), `${JSON.stringify(file, null, 2)}\n`);

const GIT_FILES = ["HEAD", "ORIG_HEAD", join("logs", "HEAD")];

/**
 * Where a repository's git data lives. `.git` is a folder in an ordinary clone, but a FILE (`gitdir: <path>`) in a linked
 * worktree and in a submodule, so the git folder is resolved from that line; a linked worktree names the folder it shares
 * in `commondir`. Undefined when no HEAD can be found, which means the repository cannot be watched.
 */
export function gitLayout(repo: string, probe: HoldProbe): { gitdir: string; common: string } | undefined {
  const dotGit = join(repo, ".git");
  let gitdir = dotGit;
  const pointer = probe.readText(dotGit, 4096);
  if (pointer !== undefined) {
    const line = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)?.[1];
    if (!line) return undefined;
    gitdir = resolve(repo, line);
  } else if (probe.mtime(dotGit) === undefined) return undefined;
  if (probe.mtime(join(gitdir, "HEAD")) === undefined) return undefined;
  const shared = probe.readText(join(gitdir, "commondir"), 1024)?.trim();
  return { gitdir, common: shared ? resolve(gitdir, shared) : gitdir };
}

/**
 * Epoch ms of the newest entry in a reflog file. A line is `old new name <mail> <epoch> <tz>` and, when there is a message,
 * a tab and the message; an entry with no message has no tab. Lines are tried from the newest back, so a half-written last
 * line does not hide the entry before it. The time comes first on a line, so a long message cut by the read window (the
 * window starts mid-line) loses nothing that is needed.
 */
export function lastReflogAt(path: string, probe: HoldProbe): number | undefined {
  // Widen the window until a line parses or the whole file was read: a message longer than the window must not hide its own timestamp.
  for (const window of [4096, 65536, 1 << 20, 16 << 20]) {
    const text = probe.readText(path, window);
    if (text === undefined) return undefined;
    const truncated = Buffer.byteLength(text) >= window; // the file may continue before the window; its first line is then a fragment
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= (truncated ? 1 : 0); index--) {
      const match = /^[0-9a-f]{40,64} [0-9a-f]{40,64} .*> (\d{9,}) [+-]\d{4}(?:\t|$)/.exec(lines[index]!.replace(/\r$/, ""));
      if (match) return Number(match[1]) * 1000;
    }
    if (!truncated) return undefined;
  }
  return undefined;
}

/**
 * The newest sign of work in a repository: git rewrites HEAD, ORIG_HEAD and its reflog when it is worked in (a commit, checkout,
 * merge, reset or rebase), here or in a linked worktree. The reflog is read for the time of its last entry rather than
 * the file's modification time: `git gc` and `git reflog expire` rewrite the file (verified on git 2.54) with no work done. The
 * index is left out on purpose: `git status` refreshes it, so a tool that only looks at a repository would count as work.
 */
function lastActivity(repo: string, probe: HoldProbe): number | undefined {
  const layout = gitLayout(repo, probe);
  if (!layout) return undefined;
  // A linked worktree's own git folder, the shared (main checkout's) git folder, and every linked worktree's folder: work in any of
  // them is work in this repository, so listing a linked worktree also watches the main checkout.
  const folders = [...new Set([layout.gitdir, layout.common, ...probe.list(join(layout.common, "worktrees")).map((name) => join(layout.common, "worktrees", name))])];
  const times = folders.flatMap((folder) => [
    probe.mtime(join(folder, "HEAD")),
    probe.mtime(join(folder, "ORIG_HEAD")),
    lastReflogAt(join(folder, "logs", "HEAD"), probe),
  ]);
  return times.reduce<number | undefined>((best, at) => (at !== undefined && (best === undefined || at > best) ? at : best), undefined);
}

const same = (running: string, wanted: Set<string>): boolean => {
  const name = running.toLowerCase();
  if (wanted.has(name)) return true;
  // Linux cuts a process name to 15 characters, so a longer listed name matches by that prefix.
  return name.length === 15 && [...wanted].some((entry) => entry.length > 15 && entry.startsWith(name));
};

/** What fired the quiet rule right now, or undefined. */
export function quietTrigger(rule: QuietRule, now: number, probe: HoldProbe): string | undefined {
  if (rule.processes.length) {
    const wanted = new Set(rule.processes.map((name) => name.toLowerCase()));
    let names: string[] = [];
    try { names = probe.processNames(); } catch { /* reported by quietProblems: the status line says the program rules cannot fire */ }
    const running = names.find((name) => same(name, wanted));
    if (running) return `${running} is running`;
  }
  const since = dayStart(now);
  for (const repo of rule.paths) {
    const at = lastActivity(repo, probe);
    if (at !== undefined && at >= since) return `work in ${repo} today`;
  }
  return undefined;
}

/** Parts of the quiet rule that cannot fire right now, for `status`: a rule that silently never fires is worse than none. */
export function quietProblems(rule: QuietRule, probe: HoldProbe): string[] {
  const problems: string[] = [];
  if (rule.processes.length) {
    try { probe.processNames(); }
    catch (error) { problems.push(`the process list could not be read (${error instanceof Error ? error.message.split("\n")[0] : String(error)}), so the program rules cannot fire`); }
  }
  for (const repo of rule.paths) {
    if (!gitLayout(repo, probe)) problems.push(`${repo} has no readable git HEAD (moved, removed or not a repository), so work there cannot be seen; fix it with: steak-pi local quiet remove ${repo}`);
  }
  return problems;
}

/**
 * Write the quiet day under the same lock every other edit takes (the caller says when it already holds it), re-reading the
 * file inside it, so a timed hold or a quiet entry written at the same moment is never overwritten. When someone else holds
 * the lock the write is skipped: this answer is still a hold, and the next evaluation records it.
 */
function rememberQuietDay(dir: string, date: string, cause: string, lockHeld: boolean): void {
  let release: (() => void) | undefined;
  try {
    release = lockHeld ? () => {} : tryLockSync(dir);
    if (!release) return;
    save(dir, { ...readHold(dir), quietDay: { date, cause } });
  } catch (error) {
    // Still a hold now (the caller reports it); only the memory of the day is lost, and the next check tries again.
    warnOnce(`the quiet day could not be recorded (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); the local model stays off for now and the next check tries again`);
  } finally { release?.(); }
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  process.emitWarning(message, "SteakPiLocalHold");
}

/**
 * The hold in force now, or undefined. Evaluating it remembers a quiet day the first time the rule fires (one small atomic
 * write under the lock, so `check` is not strictly read-only), so the answer stays the same for the rest of that day.
 */
export function activeHold(dir: string, now: number, probe: HoldProbe = systemHoldProbe, lockHeld = false): ActiveHold | undefined {
  let file: HoldFile;
  try { file = readHold(dir); }
  catch (error) { return { code: "bad-hold", detail: error instanceof Error ? error.message : String(error) }; }
  // The operator's explicit bypass wins over both rules while it lasts; the rules are kept and apply again after it.
  if (file.bypass && now < file.bypass.until) return undefined;
  if (file.until !== undefined && now < file.until) {
    return { code: "on-hold", detail: `the local model is on hold until ${clock(file.until)}${file.reason ? ` (${file.reason})` : ""}; it comes back by itself, or end the hold with: steak-pi local hold off` };
  }
  const today = localDay(now);
  const off = (cause: string): ActiveHold => ({ code: "quiet-day", detail: `the local model is off for the rest of today (${today}): ${cause}; it comes back tomorrow. The rule: steak-pi local quiet` });
  if (file.quietDay?.date === today) return off(file.quietDay.cause);
  if (!file.quiet) return undefined;
  const cause = quietTrigger(file.quiet, now, probe);
  if (!cause) return undefined;
  rememberQuietDay(dir, today, cause, lockHeld);
  return off(cause);
}

const DURATION = /^(\d+(?:\.\d+)?)(m|h|d)$/;
export function parseDuration(text: string): number {
  const match = DURATION.exec(text);
  const ms = match ? Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"] : NaN;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 366 * 86_400_000) throw new LocalError("bad-option", `"${text}" is not a hold length; use a number and m, h or d (for example 24h), at most 366d`);
  return Math.round(ms);
}

/** What an edit returns: the new file, and where the unreadable old one was kept when it had to be replaced. */
export type Edited = HoldFile & { quarantined?: string };

const edit = async (dir: string, change: (file: HoldFile) => HoldFile): Promise<Edited> => withLock(dir, async () => {
  let current: HoldFile;
  let quarantined: string | undefined;
  try { current = readHold(dir); }
  catch (error) {
    // An unreadable file is replaced by the command that edits it, but never destroyed: it is renamed aside first, so a typo
    // does not wipe the rest of the rule, and the caller says where it went.
    const target = `${holdPath(dir)}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try { renameSync(holdPath(dir), target); }
    catch (renameError) { throw new LocalError("bad-hold", `${(error as Error).message}; it also could not be moved aside (${(renameError as Error).message})`); }
    quarantined = target;
    current = {};
  }
  const next = change(current);
  save(dir, next);
  return quarantined ? { ...next, quarantined } : next;
});

/**
 * Hold the local model off until `until`. A shorter hold never shortens a longer one that is still in force (`hold 1h` after
 * `hold 24h` keeps the 24 h one) unless `replace` is set; `kept` says it was not changed.
 */
export const setHold = (dir: string, until: number, reason?: string, options: { replace?: boolean; now?: number } = {}): Promise<Edited & { kept?: boolean }> => {
  let kept = false;
  return edit(dir, (file) => {
    const now = options.now ?? Date.now();
    if (!options.replace && file.until !== undefined && file.until > until && file.until > now) { kept = true; return file; }
    const { reason: _old, ...rest } = file;
    return { ...rest, until, ...(reason ? { reason } : {}) };
  }).then((file) => (kept ? { ...file, kept } : file));
};
export const clearHold = (dir: string): Promise<Edited> =>
  edit(dir, (file) => { const { until: _until, reason: _reason, ...rest } = file; return rest; });
/** Let the local model run until `until` whatever the hold and the quiet rule say; they apply again afterwards. */
export const setBypass = (dir: string, until: number, reason?: string): Promise<Edited> =>
  edit(dir, (file) => ({ ...file, bypass: { until, ...(reason ? { reason } : {}) } }));
export const clearBypass = (dir: string): Promise<Edited> =>
  edit(dir, (file) => { const { bypass: _bypass, ...rest } = file; return rest; });
export const markQuietToday = (dir: string, now: number, cause: string): Promise<Edited> =>
  edit(dir, (file) => ({ ...file, quietDay: { date: localDay(now), cause } }));

export function addQuiet(dir: string, kind: "path" | "process", value: string, probe: HoldProbe = systemHoldProbe): Promise<Edited> {
  let entry = value;
  if (kind === "path") {
    entry = resolve(value);
    if (!isAbsolute(entry) || probe.mtime(join(entry, ".git")) === undefined) throw new LocalError("bad-option", `${value} is not a git repository (no .git there); the quiet rule watches a repository's commits, checkouts and merges`);
    // .git may be a file (a linked worktree or a submodule): its HEAD must be findable, or the rule would never fire.
    if (!gitLayout(entry, probe)) throw new LocalError("bad-option", `${value} has a .git that points nowhere usable (no HEAD found in the git folder it names); the quiet rule could never see work there`);
  } else if (!PROCESS_NAME.test(value)) throw new LocalError("bad-option", `"${value}" is not a program name; give the executable's name as the process list shows it`);
  return edit(dir, (file) => {
    const quiet = file.quiet ?? { paths: [], processes: [] };
    const list = kind === "path" ? quiet.paths : quiet.processes;
    return { ...file, quiet: { ...quiet, [kind === "path" ? "paths" : "processes"]: list.includes(entry) ? list : [...list, entry] } };
  });
}
export async function removeQuiet(dir: string, value: string): Promise<{ file: Edited; removed: boolean }> {
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
    ? [`quiet    off for the day when: ${[...file.quiet.paths.map((path) => `work in ${path}`), ...file.quiet.processes.map((name) => `${name} runs`)].join("; ")}`,
       "         programs are looked for only when something asks (status, check, ensure, a running server); a program opened and closed in between is not seen",
       ...quietProblems(file.quiet, probe).map((problem) => `quiet    WARNING: ${problem}`)]
    : [];
  const bypassed = file.bypass && now < file.bypass.until
    ? [`bypass   until ${clock(file.bypass.until)}${file.bypass.reason ? ` (${file.bypass.reason})` : ""}: the hold and the quiet rule do not refuse starts until then; end it early with: steak-pi local bypass off`]
    : [];
  // Under a bypass, say what is being bypassed: the timed hold or today's quiet-day record (both stay in the file).
  const today = localDay(now);
  const underneath = bypassed.length && file.until !== undefined && now < file.until ? `the timed hold until ${clock(file.until)}${file.reason ? ` (${file.reason})` : ""}`
    : bypassed.length && file.quietDay?.date === today ? `today's quiet day (${file.quietDay.cause})` : undefined;
  return [`hold     ${active ? `${active.code}: ${active.detail}` : underneath ? `bypassed: ${underneath}` : "none"}`, ...bypassed, ...rule];
}

export const systemHoldProbe: HoldProbe = {
  // A failed `ps` throws (never an empty list): the caller reports it instead of treating it as "no programs running".
  processNames: () => {
    try {
      return execFileSync("ps", ["-axo", "comm="], { encoding: "utf8", timeout: 5000 }).split("\n").map((line) => line.trim().split("/").pop() ?? "").filter(Boolean);
    } catch (error) { throw new Error(`ps failed: ${(error as Error).message.split("\n")[0]}`); }
  },
  mtime: (path) => { try { return statSync(path).mtimeMs; } catch { return undefined; } },
  list: (dir) => { try { return readdirSync(dir); } catch { return []; } },
  readText: (path, tailBytes = 4096) => {
    let fd: number | undefined;
    try {
      const size = statSync(path).size;
      if (!statSync(path).isFile()) return undefined;
      fd = openSync(path, "r");
      const length = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } catch { return undefined; }
    finally { if (fd !== undefined) closeSync(fd); }
  },
};

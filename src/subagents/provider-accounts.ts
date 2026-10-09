/**
 * Consumer of the shared UltraTerm provider-account router (`ut-provider-accounts`).
 *
 * The router owns account selection, usage knowledge, cooldowns and cross-process
 * reservations. This module only asks it for an account before a worker starts,
 * hands the worker that account's directory, and reports back when the worker
 * ends. It never reads credentials: only the router's nonsecret JSON and the
 * existence of an account's config/agent directory are inspected.
 *
 * Contract used (stdout is always one JSON object):
 *   select --provider claude|codex [--account ID] --owner OWNER --reserve [--existing]
 *       -> {ok:true, account:{id,label,configDir?,agentDir?}, lease?} | {ok:false, queued:true, error}
 *   renew --lease ID            -> {ok:true, renewed:boolean}
 *   release --lease ID
 *   limit --provider P --account ID [--reset-at EPOCH] --reason TEXT
 * Account IDs are any safe registered ID (`validProviderAccountId`), not a fixed pair.
 *
 * Invariants:
 * - No router installed means the legacy primary route (nothing changes).
 * - A task that already owns history (resume, automatic continuation) is pinned
 *   to its recorded account. If that account has no capacity the task waits; its
 *   history is never moved to another account.
 * - Unknown capacity, a broken router, or an unrecognised answer fails closed:
 *   no inference starts and no account is guessed.
 * - A queued task waits a bounded time, polls cancellably, and settles with an
 *   explicit "waiting for ... account capacity" message, never as a worker bug.
 * - The reservation is taken before the worker launches, renewed while the worker
 *   runs, and released when it (and any late cleanup) has finished.
 * - A task parked behind capacity lends its launch slots back while it waits.
 * - A worker that fails on an account usage limit is relaunched, never moved: with
 *   no history yet it starts fresh wherever the router has capacity; with history
 *   it queues for the account that owns it and resumes there. A limit the router
 *   could not be told about is never relaunched: the router would still offer the
 *   exhausted account.
 * - Best-effort calls (renew, release, limit) never fail a worker, but a failure is
 *   never silent: it is named in a bounded notice (`onNotice`) and, where it changes
 *   the outcome, in the task's error.
 * - An account directory must be a private (0700) real directory strictly below the
 *   home directory, reached without a symlink (account-directories.ts). Only the
 *   primary account's legacy default directory keeps its mode, and is never changed.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isCodexReplyLimit } from "../codex-reply-limit.ts";
import {
  AccountDirectoryError, assertAuthFileEntry, assertPrivateAccountDirectory, canonicalDirectory, isInsideDirectory,
  isLegacyDefaultDirectory, removeDiscardedPiSession,
} from "./account-directories.ts";
import { removeClaudeWorkerSession } from "./claude-session.ts";
import { workerJournal } from "./coordinator.ts";
import {
  providerAccountLabel,
  validProviderAccountId,
  addUsage,
  emptyUsage,
  sanitizeUsage,
  type ProviderAccountProvider,
  type ProviderAccountRef,
  type TaskRecord,
  type WorkerProgress,
  type WorkerResult,
  type WorkerRunContext,
  type WorkerSlots,
} from "./types.ts";

export const PROVIDER_ACCOUNT_ROUTER_ENV = "ULTRATERM_ACCOUNT_ROUTER";
/** Pause between capacity checks while a task is queued. */
export const PROVIDER_ACCOUNT_POLL_MS = 15_000;
/** Longest a queued task keeps its launch slot waiting for capacity. */
export const PROVIDER_ACCOUNT_QUEUE_MAX_WAIT_MS = 30 * 60_000;
export const PROVIDER_ACCOUNT_EXEC_TIMEOUT_MS = 10_000;
/** Pause between lease renewals while a worker runs (the router's default lease is 15 minutes). */
export const PROVIDER_ACCOUNT_RENEW_MS = 5 * 60_000;
/** Relaunches of one task after its account hit a usage limit; a limit that keeps coming back is a normal failure. */
export const PROVIDER_ACCOUNT_LIMIT_RETRIES = 2;

const FAMILY: Record<ProviderAccountProvider, string> = { claude: "Claude", codex: "GPT" };
const ROUTER_ENV_PREFIXES = ["ULTRATERM_"];
const ROUTER_ENV_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR"]);

/** An account as the router describes it, validated against the known IDs. */
export interface ProviderAccount {
  id: string;
  label: string;
  configDir?: string;
  agentDir?: string;
}

export type AccountSelection =
  | { kind: "selected"; account: ProviderAccount; lease?: string }
  | { kind: "queued"; error: string }
  | { kind: "unavailable"; error: string };

/** `expired`: the router no longer knows the lease. `failed`: no usable answer (try again later). */
export type LeaseRenewal = "renewed" | "expired" | "failed";

export interface ProviderAccountRouter {
  /** `existing`: the session already lives on `account`, so a cooldown does not refuse it (lease re-reservation only). */
  select(request: { provider: ProviderAccountProvider; account?: string; owner: string; existing?: boolean }): Promise<AccountSelection>;
  renew(lease: string): Promise<LeaseRenewal>;
  release(lease: string): Promise<void>;
  limit(request: { provider: ProviderAccountProvider; account: string; resetAt?: number; reason: string }): Promise<void>;
}

/** Narrow process seam. Non-zero exits still return stdout; spawn failure and timeout reject. */
export type RouterExec = (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ stdout: string }>;
export type AccountSleep = (ms: number, signal: AbortSignal) => Promise<boolean>;

export class ProviderAccountError extends Error {}
/** The task was parked behind account capacity and never started inference. */
export class ProviderAccountQueueError extends ProviderAccountError {}
/** The router (or a pinned account) cannot be used safely; nothing was substituted. */
export class ProviderAccountUnavailableError extends ProviderAccountError {}
/** A best-effort router call (renew, release, limit) gave no usable answer; names the operation and the cause. */
export class ProviderAccountRouterError extends Error {
  constructor(readonly operation: "renew" | "release" | "limit", readonly reason: string) { super(`${operation} failed: ${reason}`); }
}

function boundedText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return text || fallback;
}

function safeDirectory(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

/** Helper path: explicit override (tests), else the installed script, else none. */
export function providerAccountRouterPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | undefined {
  const override = env[PROVIDER_ACCOUNT_ROUTER_ENV]?.trim();
  if (override) return override;
  const installed = join(home, ".ultraterm", "bin", "ut-provider-accounts");
  return existsSync(installed) ? installed : undefined;
}

function routerEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ROUTER_ENV_KEYS.has(key) || ROUTER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  return env;
}

const defaultExec: RouterExec = (command, args, options) => new Promise((resolveExec, reject) => {
  execFile(command, [...args], { env: options.env, timeout: options.timeoutMs, maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout) => {
    // A non-zero exit may still carry the router's JSON answer ({ok:false,...}).
    if (error && typeof (error as { code?: unknown }).code !== "number") reject(error);
    else resolveExec({ stdout });
  });
});

function parseObject(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function parseAccount(provider: ProviderAccountProvider, value: unknown): ProviderAccount | undefined {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (!source || !validProviderAccountId(source.id)) return undefined;
  const configDir = source.configDir === undefined ? undefined : safeDirectory(source.configDir);
  const agentDir = source.agentDir === undefined ? undefined : safeDirectory(source.agentDir);
  if ((source.configDir !== undefined && !configDir) || (source.agentDir !== undefined && !agentDir)) return undefined;
  // A secondary account is only usable through its own directory.
  if (source.id !== "primary" && (provider === "claude" ? !configDir : !agentDir)) return undefined;
  // The label is always the canonical one, whatever the router printed.
  return { id: source.id, label: providerAccountLabel(provider, source.id, typeof source.label === "string" ? source.label : undefined), ...(configDir ? { configDir } : {}), ...(agentDir ? { agentDir } : {}) };
}

function safeToken(value: string, max: number): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, max);
}

export function createProviderAccountRouter(options: { command: string; env?: NodeJS.ProcessEnv; exec?: RouterExec; timeoutMs?: number }): ProviderAccountRouter {
  const exec = options.exec ?? defaultExec;
  const env = routerEnv(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? PROVIDER_ACCOUNT_EXEC_TIMEOUT_MS;
  const run = async (args: string[]): Promise<Record<string, unknown> | undefined> => {
    if (!isAbsolute(options.command)) throw new Error("router path must be absolute");
    return parseObject((await exec(options.command, args, { env, timeoutMs })).stdout);
  };
  /** A best-effort call: a run or parse failure becomes a named error instead of a silent catch. */
  const call = async (operation: "renew" | "release" | "limit", args: string[]): Promise<Record<string, unknown>> => {
    let answer: Record<string, unknown> | undefined;
    try { answer = await run(args); }
    catch (error) { throw new ProviderAccountRouterError(operation, boundedText(error instanceof Error ? error.message : error, "router could not be run")); }
    if (!answer) throw new ProviderAccountRouterError(operation, "router gave no usable answer");
    return answer;
  };
  /** release/limit have no payload: an explicit `ok:false` or an unusable answer is a failure. */
  const acknowledged = async (operation: "release" | "limit", args: string[]): Promise<void> => {
    const answer = await call(operation, args);
    if (answer.ok === false) throw new ProviderAccountRouterError(operation, boundedText(answer.error, "router refused the request"));
  };
  return {
    async select({ provider, account, owner, existing }) {
      let answer: Record<string, unknown> | undefined;
      try {
        answer = await run(["select", "--provider", provider, ...(account === undefined ? [] : ["--account", account]), "--owner", safeToken(owner, 200), "--reserve", ...(existing ? ["--existing"] : [])]);
      } catch (error) {
        return { kind: "unavailable", error: boundedText(error instanceof Error ? error.message : error, "router could not be run") };
      }
      if (answer?.ok === true) {
        const selected = parseAccount(provider, answer.account);
        const lease = answer.lease === undefined ? undefined : typeof answer.lease === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(answer.lease) ? answer.lease : null;
        if (!selected || lease === null) return { kind: "unavailable", error: "router returned an account or lease that was not recognised" };
        return { kind: "selected", account: selected, ...(lease ? { lease } : {}) };
      }
      if (answer?.ok === false && answer.queued === true) {
        return { kind: "queued", error: boundedText(answer.error, "no account has verified capacity") };
      }
      return { kind: "unavailable", error: boundedText(answer?.error, "router gave no usable answer") };
    },
    async renew(lease) {
      const answer = await call("renew", ["renew", "--lease", lease]);
      if (answer.ok === true && typeof answer.renewed === "boolean") return answer.renewed ? "renewed" : "expired";
      throw new ProviderAccountRouterError("renew", boundedText(answer.error, "router answered without a renewed flag"));
    },
    async release(lease) {
      await acknowledged("release", ["release", "--lease", lease]);
    },
    async limit({ provider, account, resetAt, reason }) {
      await acknowledged("limit", ["limit", "--provider", provider, "--account", account,
        ...(resetAt === undefined ? [] : ["--reset-at", String(Math.floor(resetAt))]), "--reason", safeToken(reason, 120)]);
    },
  };
}

/** The installed (or overridden) router, or undefined for the legacy primary route. */
export function resolveProviderAccountRouter(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), exec?: RouterExec): ProviderAccountRouter | undefined {
  const command = providerAccountRouterPath(env, home);
  return command ? createProviderAccountRouter({ command, env, ...(exec ? { exec } : {}) }) : undefined;
}

/** Account a task must stay on, or undefined when it has no history yet. A
 * resumable task recorded before account balancing ran on the primary account. */
export function pinnedAccountId(task: Pick<TaskRecord, "providerAccount" | "claudeSessionId" | "sessionFile">, provider: ProviderAccountProvider): string | undefined {
  const ref = task.providerAccount;
  if (ref !== undefined) {
    if (ref.provider !== provider || !validProviderAccountId(ref.id)) {
      throw new ProviderAccountUnavailableError(`Task is pinned to an unrecognised ${FAMILY[provider]} account; its history is not moved to another account and no inference started`);
    }
    return ref.id;
  }
  const resuming = provider === "claude"
    ? typeof task.claudeSessionId === "string" && task.claudeSessionId.length > 0
    : typeof task.sessionFile === "string" && task.sessionFile.trim().length > 0;
  return resuming ? "primary" : undefined;
}

/** `CLAUDE_CONFIG_DIR` for a child, or undefined when the account uses the CLI's
 * default directory. Setting the variable to the default path would still change
 * the CLI's credential lookup, so the primary account is left untouched (whatever
 * its legacy mode: that directory is neither validated against 0700 nor changed).
 * Any other directory must be a private real directory below `home`, reached
 * without a symlink, and never the default directory or anything inside it. */
export function claudeAccountConfigDir(account: ProviderAccount | undefined, home: string = homedir()): string | undefined {
  if (!account?.configDir) return undefined;
  const legacy = join(home, ".claude");
  if (isLegacyDefaultDirectory(account.configDir, legacy)) {
    if (account.id !== "primary") throw new ProviderAccountUnavailableError(`${account.label} cannot use the primary Claude config directory; no inference started`);
    return undefined;
  }
  if (isInsideDirectory(account.configDir, legacy)) {
    throw new ProviderAccountUnavailableError(`${account.label} config directory is inside the primary Claude config directory; no inference started`);
  }
  return checkedDirectory(account.configDir, `${account.label} config directory`, home);
}

function checkedDirectory(path: string, what: string, home: string): string {
  try { return assertPrivateAccountDirectory(path, what, home); }
  catch (error) {
    if (error instanceof AccountDirectoryError) throw new ProviderAccountUnavailableError(error.message);
    throw error;
  }
}

export function piDefaultAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured === "~") return home;
  if (configured?.startsWith("~/")) return join(home, configured.slice(2));
  return configured ? resolve(configured) : join(home, ".pi", "agent");
}

/** Account-bound Pi agent directory and its `auth.json` path, or undefined for
 * the account that uses Pi's default directory (legacy mode kept, never changed).
 * Any other directory is validated like a Claude config directory; `auth.json` is
 * only inspected (a regular, non-symlink file), never opened. */
export function codexAccountAgentDir(account: ProviderAccount | undefined, defaultDir: string = piDefaultAgentDir(), home: string = homedir()): { agentDir: string; authPath: string } | undefined {
  if (!account?.agentDir) return undefined;
  if (isLegacyDefaultDirectory(account.agentDir, defaultDir)) {
    if (account.id !== "primary") throw new ProviderAccountUnavailableError(`${account.label} cannot use Pi's default agent directory; no inference started`);
    return undefined;
  }
  if (isInsideDirectory(account.agentDir, defaultDir)) {
    throw new ProviderAccountUnavailableError(`${account.label} agent directory is inside Pi's default agent directory; no inference started`);
  }
  const agentDir = checkedDirectory(account.agentDir, `${account.label} agent directory`, home);
  const authPath = join(agentDir, "auth.json");
  try { assertAuthFileEntry(authPath, `${account.label} agent directory`); }
  catch (error) {
    if (error instanceof AccountDirectoryError) throw new ProviderAccountUnavailableError(error.message);
    throw error;
  }
  return { agentDir, authPath };
}

const LIMIT_ERROR = /\b(?:quota limit reached|usage[ _]limit(?:[ _]reached)?|(?:weekly|session|5-hour) limit(?: reached)?|hit your (?:weekly |usage |session |5-hour )?limit|insufficient[ _]quota|quota (?:exceeded|exhausted))\b/i;
const RELATIVE_RESET = /\b(?:try again|retry|resets?|available again)\s+in\s+(?:about\s+|~\s*)?(\d{1,4})\s*(minutes?|mins?|hours?|hrs?|days?)\b/i;
/** The observed absolute notice: "resets Oct 7 at 5pm (America/New_York)", "resets 5:30pm (UTC)". */
const ABSOLUTE_RESET = /\bresets?\s+(?:at\s+)?(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s?(am|pm)\s*\(([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2})\)/i;
/** Older CLI wording: "Claude AI usage limit reached|1760000000". */
const EPOCH_RESET = /\blimit reached\|(\d{10})\b/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MAX_RESET_MS = 14 * 24 * 3_600_000;
/** A date without a year this far in the past means next year's. */
const STALE_DATE_MS = 12 * 3_600_000;

interface ZoneClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zoneClock(epochMs: number, zone: string): ZoneClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(epochMs));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function zoneOffsetMs(epochMs: number, zone: string): number {
  const at = zoneClock(epochMs, zone);
  return Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch of a wall-clock time in an IANA zone, or undefined when that time does not exist there (a DST gap). */
function zonedEpochMs(year: number, month: number, day: number, hour: number, minute: number, zone: string): number | undefined {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let epoch = wall - zoneOffsetMs(wall, zone);
  epoch = wall - zoneOffsetMs(epoch, zone);
  return epoch + zoneOffsetMs(epoch, zone) === wall ? epoch : undefined;
}

function absoluteResetMs(match: RegExpMatchArray, nowMs: number): number | undefined {
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match;
  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return undefined;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });   // RangeError for anything that is not an IANA zone
    const today = zoneClock(nowMs, zone);
    let candidate: number | undefined;
    if (monthName === undefined) {
      candidate = zonedEpochMs(today.year, today.month, today.day, hour, minute, zone);
      if (candidate !== undefined && candidate <= nowMs) candidate = zonedEpochMs(today.year, today.month, today.day + 1, hour, minute, zone);
    } else {
      const month = MONTHS.indexOf(monthName.toLowerCase()) + 1;
      const day = Number(dayText);
      if (month < 1 || day < 1 || day > 31) return undefined;
      candidate = zonedEpochMs(today.year, month, day, hour, minute, zone);
      if (candidate !== undefined && candidate < nowMs - STALE_DATE_MS) candidate = zonedEpochMs(today.year + 1, month, day, hour, minute, zone);
    }
    return candidate;
  } catch { return undefined; }
}

/** Whether a worker error is an account usage limit (not a reply limit or a
 * transient rate limit), with a reset epoch only when the text states one that is
 * in the future and plausible: relative ("in 90 min"), absolute with an IANA zone
 * ("resets Oct 7 at 5pm (America/New_York)", the format the Claude worker's final
 * classifier prints) or the older `limit reached|EPOCH`. A reset in a zone this
 * cannot resolve, or one that already passed or is implausibly far, is dropped
 * and the router derives its own cooldown. */
export function accountLimitSignal(error: string | undefined, nowMs: number = Date.now()): { resetAt?: number } | undefined {
  const text = error?.slice(0, 4096);
  if (!text || isCodexReplyLimit(text) || !LIMIT_ERROR.test(text)) return undefined;
  const relative = text.match(RELATIVE_RESET);
  let resetMs: number | undefined;
  if (relative) {
    const unit = relative[2].toLowerCase();
    resetMs = nowMs + Number(relative[1]) * (unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000 : 60_000);
  } else {
    const absolute = text.match(ABSOLUTE_RESET);
    const epoch = text.match(EPOCH_RESET);
    resetMs = absolute ? absoluteResetMs(absolute, nowMs) : epoch ? Number(epoch[1]) * 1000 : undefined;
  }
  return resetMs !== undefined && resetMs > nowMs && resetMs - nowMs <= MAX_RESET_MS ? { resetAt: Math.floor(resetMs / 1000) } : {};
}

/** Resolves true after `ms`, false as soon as `signal` aborts. */
export const abortableSleep: AccountSleep = (ms, signal) => {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolveSleep) => {
    const done = (ok: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolveSleep(ok); };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

export interface AccountReservation {
  provider: ProviderAccountProvider;
  account: ProviderAccount;
  ref: ProviderAccountRef;
  lease?: string;
}
/** Resolves the task's account, or undefined when no account routing applies.
 * A runner that learns its provider late (the Pi route is frozen per run) names
 * it here; otherwise the run's own provider is used. */
export type ReserveAccount = (provider?: ProviderAccountProvider) => Promise<AccountReservation | undefined>;

/** Bounds of the capacity wait; every field is a test seam with a safe default. */
export interface AccountQueueOptions {
  maxWaitMs?: number;
  pollMs?: number;
  sleep?: AccountSleep;
  now?: () => number;
  /** Pause between lease renewals while the worker runs. */
  renewMs?: number;
  /** Relaunches after the account hit a usage limit. */
  limitRetries?: number;
}

export interface ProviderAccountRunInput extends AccountQueueOptions {
  /** Undefined for routes that are not account-balanced, or known only to the launch. */
  provider: ProviderAccountProvider | undefined;
  /** Undefined means no router is installed: the legacy primary route. */
  router: ProviderAccountRouter | undefined;
  runId: string;
  task: TaskRecord;
  signal: AbortSignal;
  onProgress: (progress: WorkerProgress) => void;
  /** The run's turn budget. A relaunch that resumes work gets what the earlier attempts left. */
  maxTurns?: number;
  /** The coordinator's launch slots, lent back while the task waits for capacity. */
  slots?: WorkerSlots;
  /** Home directory account directories must live under. An explicit seam for tests; the default is the user's home. */
  home?: string;
  /** The task session directory the worker's Pi session file lives in. A session file discarded before inference is only removed from it. */
  sessionDir?: string;
  /** Receives one named, bounded line per failed best-effort router call (renew, release, limit); default: the task's step line. Errors it throws are ignored. */
  onNotice?: (message: string) => void;
}

/** What one launch needs to know about the launches before it (none for the first). */
export interface AccountAttempt {
  /** Turns earlier attempts spent; the worker's turn budget shrinks by this. */
  priorTurns: number;
  /** Progress with the earlier attempts' counters folded in. */
  onProgress: (progress: WorkerProgress) => void;
}

/** The runner context for one launch attempt; the first one is the caller's own. */
export function attemptContext(context: WorkerRunContext, attempt: AccountAttempt): WorkerRunContext {
  return {
    ...context,
    onProgress: attempt.onProgress,
    ...(attempt.priorTurns > 0 ? { run: { ...context.run, maxTurns: Math.max(1, context.run.maxTurns - attempt.priorTurns) } } : {}),
  };
}

export type AccountLaunch = (reserve: ReserveAccount, attempt: AccountAttempt) => Promise<WorkerResult>;

function isTimeoutSignal(signal: AbortSignal): boolean {
  return signal.aborted
    && typeof signal.reason === "object"
    && signal.reason !== null
    && (signal.reason as { name?: unknown }).name === "TimeoutError";
}

function count(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : 0;
}

/** Whether a failed attempt got as far as inference or a tool call. A limit hit
 * before this point left nothing on its account. Turns and the report text are
 * not evidence: a worker counts the turn that the limit ended, and always
 * writes a report. */
function producedWork(result: WorkerResult, task: TaskRecord): boolean {
  const usage = sanitizeUsage(result.usage);
  return usage.totalTokens > 0 || usage.cost.total > 0 || count(result.toolSuccesses) + count(result.toolErrors) > 0
    || workerJournal(task).changedPaths.size > 0;
}

interface AttemptEnd {
  result: WorkerResult;
  /** The wrapper itself settled the attempt (queue, router or pin refusal): nothing ran. */
  refused: boolean;
  reservation?: AccountReservation;
  active?: ProviderAccountProvider;
  /** Account the task was already bound to when the attempt began. */
  pin?: string;
  /** Pi session file this attempt announced (never one the task already owned). */
  sessionFile?: string;
  release: () => Promise<void>;
}

/**
 * Run a worker launch with a reserved account. `launch` calls `reserve()` at the
 * point it is ready to start inference (after its own policy refusals), uses the
 * account's directory, and returns its normal result. Whatever happens, the
 * reservation is released after the result and any late cleanup. While the worker
 * runs the lease is renewed, and a failure that is an account usage limit is
 * reported to the router and then relaunched at most `limitRetries` times:
 * - nothing was produced yet: the task starts fresh and the router picks where
 *   (the limited account is cooling down), or queues it;
 * - the task owns history (a resume, or inference already ran): it queues for
 *   its own account and resumes there. Its session never changes account.
 */
export async function runWithProviderAccount(input: ProviderAccountRunInput, launch: AccountLaunch): Promise<WorkerResult> {
  const { router, task, signal, onProgress } = input;
  const maxWaitMs = input.maxWaitMs ?? PROVIDER_ACCOUNT_QUEUE_MAX_WAIT_MS;
  const pollMs = input.pollMs ?? PROVIDER_ACCOUNT_POLL_MS;
  const renewMs = input.renewMs ?? PROVIDER_ACCOUNT_RENEW_MS;
  const retries = input.limitRetries ?? PROVIDER_ACCOUNT_LIMIT_RETRIES;
  const sleep = input.sleep ?? abortableSleep;
  const now = input.now ?? Date.now;
  const home = input.home ?? homedir();
  const noticed = new Set<string>();
  const notice = (message: string): void => {
    if (noticed.has(message) || noticed.size >= 16) return;
    noticed.add(message);
    // Default: the step line of the task view, until the worker's next step replaces it.
    try { (input.onNotice ?? ((line: string) => onProgress({ currentTool: line })))(message); } catch { /* an observer never reaches the worker */ }
  };
  const cause = (error: unknown): string =>
    error instanceof ProviderAccountRouterError ? error.reason : boundedText(error instanceof Error ? error.message : error, "unknown failure");
  /** Work an earlier attempt left on the task's account; the next attempt resumes it. */
  const prior = { usage: emptyUsage(), turns: 0, toolErrors: 0, toolSuccesses: 0 };
  let kept = false;

  const fold = (progress: WorkerProgress): WorkerProgress => ({
    ...progress,
    ...(progress.usage ? { usage: addUsage(sanitizeUsage(prior.usage), progress.usage) } : {}),
    ...(progress.turns !== undefined ? { turns: prior.turns + progress.turns } : {}),
    ...(progress.toolErrors !== undefined ? { toolErrors: prior.toolErrors + progress.toolErrors } : {}),
    ...(progress.toolSuccesses !== undefined ? { toolSuccesses: prior.toolSuccesses + progress.toolSuccesses } : {}),
  });
  const foldResult = (result: WorkerResult): WorkerResult => ({
    ...result,
    usage: addUsage(sanitizeUsage(prior.usage), result.usage),
    turns: prior.turns + count(result.turns),
    toolErrors: prior.toolErrors + count(result.toolErrors),
    toolSuccesses: prior.toolSuccesses + count(result.toolSuccesses),
  });

  const runAttempt = async (index: number): Promise<AttemptEnd> => {
    const at: { reservation?: AccountReservation; active?: ProviderAccountProvider; pin?: string; sessionFile?: string } = { active: input.provider };
    const owner = `steak-pi:${process.pid}:${input.runId}:${task.id}${index === 0 ? "" : `:r${index}`}`;
    const idle = kept ? "no further inference started" : "no inference started";
    let pending: Promise<AccountReservation | undefined> | undefined;
    let waiting = false;
    let yielded = false;
    let released = false;
    let renewing = false;
    let renewTimer: ReturnType<typeof setInterval> | undefined;

    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      if (renewTimer) clearInterval(renewTimer);
      if (at.reservation?.lease && router) {
        try { await router.release(at.reservation.lease); }
        catch (error) { notice(`${at.reservation.account.label} lease release failed: ${cause(error)}; the router expires an abandoned lease`); }
      }
    };

    // A long-running worker outlives the router's lease; renew it so the
    // account keeps counting the worker's load. A lease the router has already
    // forgotten is re-reserved for the session that is already running on it.
    const renew = async (): Promise<void> => {
      const reservation = at.reservation;
      if (renewing || released || !router || !reservation?.lease) return;
      const label = reservation.account.label;
      renewing = true;
      try {
        let status: LeaseRenewal;
        try { status = await router.renew(reservation.lease); }
        catch (error) { notice(`${label} lease renewal failed: ${cause(error)}`); return; }
        if (status === "failed") { notice(`${label} lease renewal failed: router gave no usable answer`); return; }
        if (status !== "expired") return;
        const again = await router.select({ provider: reservation.provider, account: reservation.account.id, owner, existing: true });
        if (again.kind !== "selected" || again.account.id !== reservation.account.id || !again.lease) {
          notice(`${label} lease expired and could not be re-reserved: ${again.kind === "selected" ? "router answered a different account or no lease" : again.error}`);
          // A lease for another account is not ours to hold.
          if (again.kind === "selected" && again.lease) {
            try { await router.release(again.lease); } catch (error) { notice(`${label} stray lease release failed: ${cause(error)}`); }
          }
          return;
        }
        if (released) {
          try { await router.release(again.lease); } catch (error) { notice(`${label} lease release failed: ${cause(error)}; the router expires an abandoned lease`); }
        } else reservation.lease = again.lease;
      } finally { renewing = false; }
    };

    const acquire = async (provider: ProviderAccountProvider | undefined): Promise<AccountReservation | undefined> => {
      at.active = provider;
      if (provider === undefined) return undefined;
      const family = FAMILY[provider];
      const pin = pinnedAccountId(task, provider);
      at.pin = pin;
      if (router === undefined) {
        if (pin !== undefined && pin !== "primary") {
          throw new ProviderAccountUnavailableError(`Task is pinned to ${providerAccountLabel(provider, pin)} but no account router is installed; its history is not moved and no inference started`);
        }
        return undefined;
      }
      const startedAt = now();
      for (;;) {
        if (signal.aborted) throw new ProviderAccountQueueError(`Waiting for ${family} account capacity ended by cancellation or the run deadline; ${idle}`);
        const outcome = await router.select({ provider, ...(pin === undefined ? {} : { account: pin }), owner });
        if (outcome.kind === "unavailable") {
          throw new ProviderAccountUnavailableError(`${family} account router unavailable: ${outcome.error}; ${idle} and no account was substituted`);
        }
        if (outcome.kind === "selected") {
          // Recorded before any check so a refusal below still releases the lease.
          const reservation: AccountReservation = {
            provider, account: outcome.account, ...(outcome.lease ? { lease: outcome.lease } : {}),
            ref: {
              provider, id: outcome.account.id, label: outcome.account.label,
              ...(provider === "claude" && outcome.account.configDir ? { configDir: outcome.account.configDir } : {}),
            },
          };
          at.reservation = reservation;
          if (pin !== undefined && outcome.account.id !== pin) {
            throw new ProviderAccountUnavailableError(`Router answered ${outcome.account.label} for a task pinned to ${providerAccountLabel(provider, pin)}; its history is not moved and ${idle}`);
          }
          if (task.providerAccount?.configDir && canonicalDirectory(task.providerAccount.configDir) !== canonicalDirectory(reservation.account.configDir ?? join(home, ".claude"))) {
            throw new ProviderAccountUnavailableError("The account config directory changed; existing history is not moved");
          }
          if (signal.aborted) throw new ProviderAccountQueueError(`Waiting for ${family} account capacity ended by cancellation or the run deadline; ${idle}`);
          // Slots lent back during the wait are taken again before any work starts.
          if (yielded) { await input.slots?.reclaim(); yielded = false; }
          if (reservation.lease && renewMs > 0) {
            renewTimer = setInterval(() => { void renew().catch((error) => notice(`${reservation.account.label} lease renewal failed: ${cause(error)}`)); }, renewMs);
            renewTimer.unref?.();
          }
          const wasWaiting = waiting;
          waiting = false;
          onProgress({ ...(wasWaiting ? { state: "running" as const, currentTool: undefined } : {}), providerAccount: reservation.ref });
          return reservation;
        }
        if (!waiting) {
          waiting = true;
          onProgress({ state: "waiting", currentTool: `waiting for ${family} account capacity` });
        }
        if (!yielded && input.slots) { input.slots.yield(); yielded = true; }
        const waitedMs = now() - startedAt;
        if (waitedMs + pollMs > maxWaitMs) {
          throw new ProviderAccountQueueError(`Waiting for ${family} account capacity ended after ${Math.max(1, Math.round(waitedMs / 60_000))} min: ${outcome.error}; ${idle}`);
        }
        if (!(await sleep(pollMs, signal))) {
          throw new ProviderAccountQueueError(`Waiting for ${family} account capacity ended by cancellation or the run deadline; ${idle}`);
        }
      }
    };
    const reserve: ReserveAccount = (requested) => (pending ??= acquire(requested ?? input.provider));

    let result: WorkerResult;
    try {
      const forward = kept ? (progress: WorkerProgress) => onProgress(fold(progress)) : onProgress;
      result = await launch(reserve, {
        priorTurns: kept ? prior.turns : 0,
        onProgress: (progress) => {
          // Only a session file announced while the task owned none is this attempt's own.
          if (progress.sessionFile !== undefined && at.sessionFile === undefined && task.sessionFile === undefined) at.sessionFile = progress.sessionFile;
          forward(progress);
        },
      });
    } catch (error) {
      await release();
      if (!(error instanceof ProviderAccountError)) throw error;
      return {
        refused: true, release, ...at,
        result: { state: signal.aborted ? (isTimeoutSignal(signal) ? "timed_out" : "aborted") : "failed", output: "", turns: 0, usage: emptyUsage(), error: error.message },
      };
    }
    if (waiting && at.active && result.state !== "done" && !(result.error ?? "").match(/account capacity/i)) {
      result = { ...result, error: `${result.error ?? result.state}; waiting for ${FAMILY[at.active]} account capacity, ${idle}` };
    }
    return { refused: false, release, result, ...at };
  };

  for (let index = 0; ; index += 1) {
    const end = await runAttempt(index);
    let result = kept ? foldResult(end.result) : end.result;
    const { reservation, active } = end;
    const limit = !end.refused && router && reservation && active && end.result.state === "failed"
      ? accountLimitSignal(end.result.error, now()) : undefined;
    // A limit the router was not told about leaves it offering the exhausted account, so
    // relaunching would only burn a retry on the same failure: report it by name and stop.
    let reported = true;
    if (limit && router && reservation && active) {
      try {
        await router.limit({ provider: active, account: reservation.account.id, ...(limit.resetAt === undefined ? {} : { resetAt: limit.resetAt }), reason: "usage limit" });
      } catch (error) {
        reported = false;
        const why = cause(error);
        notice(`${reservation.account.label} usage limit could not be reported to the account router: ${why}`);
        result = { ...result, error: `${result.error ?? "usage limit"}; the usage limit could not be reported to the account router (${why}), so the task was not relaunched` };
      }
    }
    let plan: "fresh" | "resume" | undefined;
    if (limit && reported && reservation && index < retries && !signal.aborted) {
      if (end.pin === undefined && !producedWork(end.result, task)) plan = "fresh";
      else if ((input.maxTurns === undefined || count(result.turns) < input.maxTurns)
        && (limit.resetAt === undefined || limit.resetAt * 1000 - now() <= maxWaitMs)) plan = "resume";
    }
    if (!plan || !reservation) {
      if (result.cleanup) return { ...result, cleanup: result.cleanup.finally(end.release) };
      await end.release();
      return result;
    }
    // The failed worker's late disposal ends before its session pointers change.
    await end.result.cleanup;
    await end.release();
    if (plan === "fresh") {
      // Nothing ran on the account, so the empty session starts over wherever the router has capacity.
      const stale = task.claudeSessionId;
      const discarded = end.sessionFile !== undefined && end.sessionFile === task.sessionFile ? end.sessionFile : undefined;
      delete task.sessionFile;
      delete task.claudeSessionId;
      delete task.providerAccount;
      if (stale && reservation.provider === "claude") {
        try { removeClaudeWorkerSession(stale, home, reservation.account.configDir); } catch { /* best effort; the transcript is only a leftover prompt */ }
      }
      // The attempt's own empty Pi session file: removed only from the task session directory, never one the task owned before.
      if (discarded && reservation.provider === "codex") removeDiscardedPiSession(discarded, input.sessionDir);
    } else {
      kept = true;
      prior.usage = sanitizeUsage(result.usage);
      prior.turns = count(result.turns);
      prior.toolErrors = count(result.toolErrors);
      prior.toolSuccesses = count(result.toolSuccesses);
    }
  }
}

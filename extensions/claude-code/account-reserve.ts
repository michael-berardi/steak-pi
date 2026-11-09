/**
 * Owner reserves on lent Claude accounts, enforced per request.
 *
 * The UltraTerm account router (`ut-provider-accounts`) knows which Claude
 * accounts carry an owner reserve (for example "keep the last 20% of the
 * five-hour window"). Selecting an account is not enough: a long session or a
 * subagent that inherited the account keeps spending past the floor. So every
 * request on an account named by ULTRATERM_PROVIDER_ACCOUNT asks the router
 * first, and every turn's official `rate_limit_event` is fed back to it, so
 * the router's reading is never older than the previous turn.
 *
 * Nothing here names an account, person or plan: the account comes from the
 * environment and the reserve from the operator's own router config. Without
 * a router (no UltraTerm) both calls are inert.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RateLimitInfo } from "./billing.ts";

// The router promises a JSON answer within ~8s (even refusals); this is only the safety net for a loaded machine.
const ROUTER_TIMEOUT_MS = 20_000;
// ULTRATERM_ACCOUNT_ROUTER_TIMEOUT_MS overrides the safety net, bounded to 1000..60000 ms (tests, very slow machines).
const ROUTER_TIMEOUT_MIN_MS = 1_000;
const ROUTER_TIMEOUT_MAX_MS = 60_000;
const STATUS_RETRY_PAUSE_MS = 500;

function routerTimeoutMs(env: Env): number {
  const n = Number(env.ULTRATERM_ACCOUNT_ROUTER_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(ROUTER_TIMEOUT_MAX_MS, Math.max(ROUTER_TIMEOUT_MIN_MS, Math.round(n))) : ROUTER_TIMEOUT_MS;
}
const ACCOUNT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INFO_KEYS = ["status", "resetsAt", "rateLimitType", "overageStatus", "overageDisabledReason", "isUsingOverage", "unifiedWindows"];

type Env = Record<string, string | undefined>;
export type RouterCall = (args: string[], stdin?: string) => Promise<unknown>;

function routerPath(env: Env): string | undefined {
  const path = env.ULTRATERM_ACCOUNT_ROUTER ?? join(env.HOME || homedir(), ".ultraterm", "bin", "ut-provider-accounts");
  return existsSync(path) ? path : undefined;
}

function defaultRouter(env: Env): RouterCall | undefined {
  const path = routerPath(env);
  if (!path) return undefined;
  const timeout = routerTimeoutMs(env);
  return (args, stdin) => new Promise((resolve, reject) => {
    const started = Date.now();
    const child = execFile(path, args, { timeout, killSignal: "SIGTERM", maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
      if (parsed !== undefined) return resolve(parsed);
      const e = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: unknown }) | null;
      let cause: string;
      if (e?.killed || e?.signal) {
        const secs = Math.round((Date.now() - started) / 100) / 10;
        cause = e.killed && (e.signal ?? "SIGTERM") === "SIGTERM" && Date.now() - started >= timeout - 50
          ? `timed out after ${secs}s (killed by ${e.signal ?? "SIGTERM"})`
          : `stopped by signal ${e.signal ?? "SIGTERM"} after ${secs}s`;
      } else if (e) {
        cause = typeof e.code === "number" ? `exited with code ${e.code}` : `could not run (${String(e.code ?? e.message).slice(0, 100)})`;
      } else {
        cause = "exited without an answer";
      }
      const err = String(stderr ?? "").trim().slice(0, 200);
      reject(new Error(`account router ${args[0]} ${cause}; no JSON output${err ? `; stderr: ${err}` : ""}`));
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/**
 * Read the router's status. It is read-only, so one failure without JSON (timeout, crash, signal) is retried once
 * after a short pause. Writes (`ingest`, `select`) are never retried here: `select` may reserve an account.
 */
async function readStatus(id: string, call: RouterCall): Promise<any> {
  // A refusal ({ok:false}, e.g. the state lock was busy) is not a reading: treating it as "no such account" would
  // let a reserved account pass unchecked. It is retried once like a crash, then fails closed with its cause.
  const once = async () => {
    const status: any = await call(["status"]);
    if (status && typeof status === "object" && status.ok === false) {
      throw new Error(`account router status refused: ${String(status.error ?? "no cause given").slice(0, 200)}`);
    }
    return status;
  };
  try {
    try {
      return await once();
    } catch {
      await new Promise((r) => setTimeout(r, STATUS_RETRY_PAUSE_MS));
      return await once();
    }
  } catch (error) {
    throw new Error(`Claude account reserve could not be checked for ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The account this session or worker spends on, when the launcher named one. */
export function reservedAccountId(env: Env): string | undefined {
  const id = env.ULTRATERM_PROVIDER_ACCOUNT;
  return id && ACCOUNT_RE.test(id) ? id : undefined;
}

export class AccountReserveError extends Error {
  constructor(label: string, why: string, tail = "Its owner keeps this share, so no further request is sent on it (quota exceeded for this session). Switch this session to another Claude account or wait for the reset.") {
    // "quota exceeded" keeps Pi's retry classifier from retrying it (a reserve is not a transient throttle).
    super(`Claude account reserve: ${label} ${why}. ${tail}`);
    this.name = "AccountReserveError";
  }
}

/**
 * Throws AccountReserveError when the router says the account's owner reserve is reached. An account without a
 * reserve passes. A reserved account whose verdict cannot be read fails closed with the cause named.
 */
export async function assertAccountReserve(env: Env, call: RouterCall | undefined = defaultRouter(env)): Promise<void> {
  const id = reservedAccountId(env);
  if (!id || !call) return;
  const status = await readStatus(id, call);
  const accounts = status?.providers?.claude?.accounts;
  const account = Array.isArray(accounts) ? accounts.find((a: any) => a?.id === id) : undefined;
  if (!account) return; // not a router-managed account: nothing reserved here
  const reserve = account.reserve;
  if (!reserve || typeof reserve !== "object") return;
  if (reserve.ok === true) return;
  const label = typeof account.label === "string" && account.label ? account.label : id;
  throw new AccountReserveError(label, typeof reserve.why === "string" && reserve.why ? reserve.why : "is at its owner's reserve");
}

/** The router's ingest payload for one official rate_limit_event, or undefined when it lacks usage windows. */
export function rateLimitIngestPayload(account: string, info: RateLimitInfo, sessionId?: string, at = Date.now()): string | undefined {
  if (!info || typeof info !== "object" || !info.unifiedWindows || typeof info.unifiedWindows !== "object") return undefined;
  const filtered: Record<string, unknown> = {};
  for (const key of INFO_KEYS) if (info[key] !== undefined) filtered[key] = info[key];
  if (typeof filtered.isUsingOverage !== "boolean") filtered.isUsingOverage = false;
  return JSON.stringify({
    account,
    observedAt: Math.floor(at / 1000),
    type: "rate_limit_event",
    rate_limit_info: filtered,
    ...(sessionId && /^[0-9a-f-]{36}$/i.test(sessionId) ? { session_id: sessionId } : {}),
  });
}

/**
 * Feed one turn's official usage reading to the router. Returns the cause when it was not recorded, so the caller
 * can surface it; it never throws, because the reading is advisory and the next request's check still runs.
 */
export async function reportRateLimit(env: Env, info: RateLimitInfo | undefined, sessionId?: string,
  call: RouterCall | undefined = defaultRouter(env)): Promise<string | undefined> {
  const id = reservedAccountId(env);
  if (!id || !call || !info) return undefined;
  const payload = rateLimitIngestPayload(id, info, sessionId);
  if (!payload) return undefined;
  try {
    const out: any = await call(["ingest", "--provider", "claude", "--account", id], payload);
    return out?.ok === true ? undefined : `usage reading for ${id} was refused: ${String(out?.error ?? "unknown").slice(0, 200)}`;
  } catch (error) {
    return `usage reading for ${id} was not recorded: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A session never stalls on a refused reserve: it moves to the next Claude account the router would pick.
// The operator's rule: a lent plan is a spill; at its floor (or when its usage is unreadable) work goes back to
// the own plans automatically. The session stops only when no Claude account is eligible, naming every cause.
// ---------------------------------------------------------------------------------------------------------------

export type AccountOverrides = Record<string, string | undefined>;
export interface ResolvedAccount {
  /** Environment keys to layer over the request's environment (undefined deletes a key). Absent: stay as launched. */
  overrides?: AccountOverrides;
  /** One-line, user-visible notice, set only on the request that moved the session. */
  notice?: string;
}

const NO_ACCOUNT_TAIL = "No further request is sent (quota exceeded for this session). Wait for a reset or sign in another Claude account.";
const MAX_MOVES = 4;
const sessionAccounts = new Map<string, AccountOverrides>();

/** Forget the account a session moved to (the session ended); without an id, every session's. */
export function forgetSessionAccount(sessionId?: string): void {
  if (sessionId === undefined) sessionAccounts.clear();
  else sessionAccounts.delete(sessionId);
}

interface Verdict { ok: boolean; label: string; why: string }

async function reserveVerdict(id: string, call: RouterCall): Promise<Verdict> {
  const status = await readStatus(id, call);
  const accounts = status?.providers?.claude?.accounts;
  const account = Array.isArray(accounts) ? accounts.find((a: any) => a?.id === id) : undefined;
  const label = typeof account?.label === "string" && account.label ? account.label : id;
  const reserve = account?.reserve;
  if (!account || !reserve || typeof reserve !== "object" || reserve.ok === true) return { ok: true, label, why: "" };
  return { ok: false, label, why: typeof reserve.why === "string" && reserve.why ? reserve.why : "is at its owner's reserve" };
}

function overridesFor(account: any): AccountOverrides | undefined {
  if (!account || typeof account.id !== "string" || !ACCOUNT_RE.test(account.id)) return undefined;
  const launch = account.launchEnv && typeof account.launchEnv === "object" ? account.launchEnv : {};
  const folder = launch.set && typeof launch.set === "object" ? launch.set.CLAUDE_CONFIG_DIR : undefined;
  if (folder !== undefined && (typeof folder !== "string" || !folder.startsWith("/"))) return undefined;
  // PI_CLAUDE_CODE_CONFIG_DIR would otherwise win over CLAUDE_CONFIG_DIR and keep the session on the refused folder.
  return { ULTRATERM_PROVIDER_ACCOUNT: account.id, CLAUDE_CONFIG_DIR: folder, PI_CLAUDE_CODE_CONFIG_DIR: undefined };
}

/**
 * The account this request runs on. A reserved account that is at its floor (or whose usage cannot be read) hands the
 * session to the router's next eligible Claude account; the choice sticks for the session. Throws AccountReserveError
 * naming every cause only when no Claude account is eligible.
 */
export async function resolveRequestAccount(env: Env, sessionId: string | undefined,
  call: RouterCall | undefined = defaultRouter(env)): Promise<ResolvedAccount> {
  let overrides = sessionId ? sessionAccounts.get(sessionId) : undefined;
  let current: Env = overrides ? { ...env, ...overrides } : env;
  let id = reservedAccountId(current);
  if (!id || !call) return { overrides };
  const causes: string[] = [];
  const excluded: string[] = [];
  let firstCause: string | undefined;
  for (let move = 0; move <= MAX_MOVES; move++) {
    const verdict = await reserveVerdict(id, call);
    if (verdict.ok) {
      if (!firstCause) return { overrides };
      if (sessionId && overrides) sessionAccounts.set(sessionId, overrides);
      return { overrides, notice: `${firstCause}; this session continues on ${verdict.label}.` };
    }
    firstCause ??= `${verdict.label} ${verdict.why}`;
    causes.push(`${verdict.label} ${verdict.why}`);
    excluded.push(id);
    let picked: any;
    try {
      picked = await call(["select", "--provider", "claude", "--exclude", excluded.join(",")]);
    } catch (error) {
      causes.push(`the router could not pick another account: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    const next = picked?.ok === true ? overridesFor(picked.account) : undefined;
    if (!next || excluded.includes(next.ULTRATERM_PROVIDER_ACCOUNT!)) {
      causes.push(typeof picked?.error === "string" && picked.error ? picked.error : "the router offered no other Claude account");
      break;
    }
    overrides = { ...overrides, ...next };
    current = { ...env, ...overrides };
    id = next.ULTRATERM_PROVIDER_ACCOUNT!;
  }
  throw new AccountReserveError("No Claude account is eligible:", causes.join("; "), NO_ACCOUNT_TAIL);
}

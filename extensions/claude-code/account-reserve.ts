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

const ROUTER_TIMEOUT_MS = 10_000;
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
  return (args, stdin) => new Promise((resolve, reject) => {
    const child = execFile(path, args, { timeout: ROUTER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      let parsed: unknown;
      try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
      if (parsed !== undefined) return resolve(parsed);
      reject(new Error(`account router ${args[0]} failed: ${error?.message ?? (String(stderr).trim().slice(0, 200) || "no JSON output")}`));
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** The account this session or worker spends on, when the launcher named one. */
export function reservedAccountId(env: Env): string | undefined {
  const id = env.ULTRATERM_PROVIDER_ACCOUNT;
  return id && ACCOUNT_RE.test(id) ? id : undefined;
}

export class AccountReserveError extends Error {
  constructor(label: string, why: string) {
    // "quota exceeded" keeps Pi's retry classifier from retrying it (a reserve is not a transient throttle).
    super(`Claude account reserve: ${label} ${why}. Its owner keeps this share, so no further request is sent on it (quota exceeded for this session). Switch this session to another Claude account or wait for the reset.`);
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
  let status: any;
  try {
    status = await call(["status"]);
  } catch (error) {
    throw new Error(`Claude account reserve could not be checked for ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
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

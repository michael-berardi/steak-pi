import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export type AccountCommand = (args: string[]) => Promise<any>;
/** Reserve TTL this process asks of the router for a Go account lease. */
export const GO_ACCOUNT_LEASE_TTL_SECONDS = 3600;
/** Renewal cadence: a third of the reserve TTL, so one missed tick still leaves two. */
export const GO_ACCOUNT_LEASE_RENEW_INTERVAL_MS = Math.max(1, Math.floor(GO_ACCOUNT_LEASE_TTL_SECONDS * 1000 / 3));
/** Bound on every nonsecret router call a lease keeper makes, renewal included. */
export const GO_ACCOUNT_ROUTER_TIMEOUT_MS = 10_000;
/** Longest router-supplied cause echoed back into an error message. */
const ROUTER_DETAIL_LIMIT = 200;

/** Bounded, printable single-line text; used for router causes and failure details. */
function printableText(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : String(value);
  const printable = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return printable.length > 0 ? printable.slice(0, ROUTER_DETAIL_LIMIT) : fallback;
}

/** The router answers a refusal as bounded JSON on stdout before it exits nonzero.
 * That cause is the honest one: it names the real reason (queued, cooldown,
 * mismatched session) instead of an opaque "unavailable" for every failure. The
 * router is credential-free by contract, so only its own `ok:false` message is
 * echoed back, stripped of control characters and capped. */
function routerRefusalDetail(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.ok !== false) return undefined;
    if (typeof parsed.error !== "string") return undefined;
    const detail = parsed.error.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, ROUTER_DETAIL_LIMIT);
    return detail.length > 0 ? detail : undefined;
  } catch {
    return undefined;
  }
}

/** How the router invocation itself ended, without inventing a cause. */
function routerFailureStatus(error: { code?: unknown; killed?: boolean; signal?: unknown }): string {
  if (error.killed === true) return "timed out";
  if (typeof error.code === "number") return `exit ${error.code}`;
  if (typeof error.code === "string") return error.code;
  if (error.signal) return `stopped by ${String(error.signal)}`;
  return "unavailable";
}

/** Nonsecret router contract only. Never load credentials or change process.env. */
export const providerAccountCommand: AccountCommand = (args) => new Promise((resolve, reject) => {
  execFile(process.env.ULTRATERM_ACCOUNT_ROUTER ?? join(homedir(), ".ultraterm", "bin", "ut-provider-accounts"), args,
    { timeout: 10_000, maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error) {
        const detail = routerRefusalDetail(String(stdout ?? ""));
        if (detail) reject(new Error(`Provider account router refused: ${detail}`, { cause: error }));
        else reject(new Error(`Provider account router unavailable or no account eligible (${routerFailureStatus(error)})`, { cause: error }));
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid provider account router response")); }
    });
});

export interface GoAccountLease {
  id: "primary" | "b";
  label: string;
  agentDir: string;
  lease: string;
}
export async function reserveGoAccount(owner: string, command = providerAccountCommand, pinnedId?: "primary" | "b"): Promise<GoAccountLease> {
  const result = await command(["select", "--provider", "opencode-go", "--reserve", "--owner", owner, "--ttl", String(GO_ACCOUNT_LEASE_TTL_SECONDS), ...(pinnedId ? ["--account", pinnedId] : [])]);
  const account = result?.account;
  const lease = result?.lease;
  try {
    if (result?.ok !== true || !["primary", "b"].includes(account?.id) ||
        (pinnedId !== undefined && account?.id !== pinnedId) ||
        typeof lease !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(lease) ||
        account.agentDir !== join(homedir(), ".ultraterm", "provider-accounts", "opencode-go", account.id, "agent")) {
      throw new Error("Unsafe Go provider account selection; no ambient credentials selected");
    }
    return { id: account.id, label: account.id === "primary" ? "Go 1" : "Go 2", agentDir: account.agentDir, lease };
  } catch (error) {
    if (typeof lease === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(lease)) await command(["release", "--lease", lease]);
    throw error;
  }
}

/**
 * Named, fail-closed reason for a lease this worker can no longer account for.
 * USAP runs last up to 8 hours while a reservation TTL is one hour, so a native
 * Go worker must renew; a renewal that fails means the child is spending on an
 * unaccounted reservation and must stop rather than keep running.
 */
export type GoAccountLeaseFailureReason = "lease-lost" | "router-error" | "router-timeout" | "invalid-response";

export class GoAccountLeaseRenewalError extends Error {
  readonly reason: GoAccountLeaseFailureReason;
  constructor(reason: GoAccountLeaseFailureReason, detail: string) {
    super(`Go account lease renewal failed (${reason}): ${printableText(detail, "no router detail")}`);
    this.name = "GoAccountLeaseRenewalError";
    this.reason = reason;
  }
}

export interface GoAccountLeaseKeeperOptions {
  lease: string;
  command: AccountCommand;
  /** Renewal cadence. Defaults to a third of the TTL; may never exceed the TTL. */
  intervalMs?: number;
  /** Reserved TTL, in seconds, asked of the router on every renewal. */
  ttlSeconds?: number;
  /** Bound on each router call; a hung router fails closed instead of pinning the task. */
  timeoutMs?: number;
  /** First renewal failure, once. The keeper stops renewing before calling this. */
  onFailure?: (error: GoAccountLeaseRenewalError) => void;
}

export interface GoAccountLeaseKeeper {
  /** Begin periodic renewal. Idempotent; inert once stopped, released or failed. */
  start(): void;
  /** One renewal, serialized behind any renewal still in flight. Rejects on failure. */
  renew(): Promise<void>;
  /** Stop renewing and wait for the in-flight renewal. Idempotent; never throws. */
  stop(): Promise<void>;
  /** Stop, wait, then release exactly once: a release never races a renewal. */
  release(): Promise<void>;
  /** Set by the first failed renewal; every later renewal is refused. */
  failure(): GoAccountLeaseRenewalError | undefined;
  /** True once renewal stopped, by `stop()`, `release()` or a failed renewal. */
  readonly stopped: boolean;
}

/** Bound one router call so a hung router cannot pin the task's slot. */
function boundedRouterCall<T>(start: () => Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = Promise.resolve().then(start).then(
    (value) => { if (timer !== undefined) clearTimeout(timer); return value; },
    (error) => { if (timer !== undefined) clearTimeout(timer); throw error; },
  );
  // The loser of the race must never surface as an unhandled rejection.
  void call.catch(() => {});
  return Promise.race([
    call,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    }),
  ]);
}

/**
 * Serialized periodic renewal for one reserved Go account lease.
 *
 * Guarantees the router contract needs: renewals are serialized against each
 * other and against the release, the timer is cleared before the release command
 * is issued, renewal stops permanently after the first failure, and every call is
 * bounded so a hung router fails closed rather than retaining the task's slot.
 */
export function createGoAccountLeaseKeeper(options: GoAccountLeaseKeeperOptions): GoAccountLeaseKeeper {
  const lease = options.lease;
  const command = options.command;
  const ttlSeconds = options.ttlSeconds ?? GO_ACCOUNT_LEASE_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new RangeError("ttlSeconds must be a positive safe integer");
  }
  const intervalMs = options.intervalMs ?? GO_ACCOUNT_LEASE_RENEW_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > ttlSeconds * 1000) {
    throw new RangeError("intervalMs must be a positive safe integer no longer than the lease TTL");
  }
  const timeoutMs = options.timeoutMs ?? GO_ACCOUNT_ROUTER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be a positive safe integer");
  }
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let failureError: GoAccountLeaseRenewalError | undefined;
  // Serializes every router call this keeper makes: two renewals can never run at
  // once, and a release can never overlap a renewal. The chain itself never
  // rejects, because every caller handles its own attempt's rejection.
  let queue: Promise<void> = Promise.resolve();
  let releaseResult: Promise<void> | undefined;

  const stopTimer = () => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };
  const failClosed = (error: GoAccountLeaseRenewalError) => {
    if (failureError) return;
    failureError = error;
    stopped = true;
    stopTimer();
    try { options.onFailure?.(error); } catch { /* the caller's abort path must not break settling */ }
  };
  const attempt = async (): Promise<void> => {
    // A renewal that was queued but not yet started must not reach the router
    // after stop()/release(): releasing is the authoritative end of ownership.
    if (stopped) return;
    let result: any;
    try {
      result = await boundedRouterCall(
        () => command(["renew", "--lease", lease, "--ttl", String(ttlSeconds)]),
        timeoutMs,
        () => new GoAccountLeaseRenewalError("router-timeout", `no answer within ${timeoutMs} ms`),
      );
    } catch (error) {
      const failure = error instanceof GoAccountLeaseRenewalError
        ? error
        : new GoAccountLeaseRenewalError("router-error", printableText(error, "router call rejected"));
      failClosed(failure);
      throw failure;
    }
    if (result?.ok !== true || typeof result?.renewed !== "boolean") {
      const failure = new GoAccountLeaseRenewalError("invalid-response", "the router did not answer with ok:true and a boolean renewed flag");
      failClosed(failure);
      throw failure;
    }
    if (result.renewed !== true) {
      const failure = new GoAccountLeaseRenewalError("lease-lost", "the router no longer holds this reservation");
      failClosed(failure);
      throw failure;
    }
  };
  const renew = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    const pending = queue.then(attempt);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const stop = async (): Promise<void> => {
    stopped = true;
    stopTimer();
    // The in-flight renewal is bounded by timeoutMs, so this wait is bounded too.
    await queue;
  };
  const release = (): Promise<void> => {
    releaseResult ??= (async () => {
      await stop();
      await boundedRouterCall(
        () => command(["release", "--lease", lease]),
        timeoutMs,
        () => new Error(`Go account lease release timed out after ${timeoutMs} ms; the router TTL retains a bounded lease`),
      );
    })();
    return releaseResult;
  };

  return {
    start: () => {
      if (started || stopped) return;
      started = true;
      timer = setInterval(() => { void renew().catch(() => { /* recorded by failure() */ }); }, intervalMs);
    },
    renew,
    stop,
    release,
    failure: () => failureError,
    get stopped() { return stopped; },
  };
}

/** A failed/unknown router is NOT proof of Claude unavailability. */
export async function noEligibleClaudeAccount(command = providerAccountCommand): Promise<boolean> {
  try {
    const status = await command(["status"]);
    const accounts = status?.providers?.claude?.accounts;
    return Array.isArray(accounts) && accounts.length > 0 && accounts.every((account) =>
      typeof account?.eligible === "boolean" && account.eligible === false);
  } catch { return false; }
}

export type CodexAccountId = "primary" | "fallback";
export interface CodexAccount {
  id: CodexAccountId;
  label: string;
  agentDir: string;
}
export interface CodexAccountLease extends CodexAccount { lease: string }

/** Router metadata only; auth.json is consumed exclusively by the production SDK. */
export function isolatedCodexAgentDir(id: CodexAccountId): string {
  return join(homedir(), ".ultraterm", "provider-accounts", "codex", id, "agent");
}
export function isolatedAgentPaths(agentDir: string) {
  return { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json") };
}
export async function selectCodexAccount(command = providerAccountCommand, owner?: string, pinnedId?: CodexAccountId): Promise<CodexAccountLease | CodexAccount> {
  const result = await command(["select", "--provider", "codex",
    ...(owner ? ["--reserve", "--owner", owner, "--ttl", String(GO_ACCOUNT_LEASE_TTL_SECONDS)] : []),
    ...(pinnedId ? ["--account", pinnedId] : [])]);
  const account = result?.account;
  const lease = result?.lease;
  const validLease = typeof lease === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(lease);
  if (result?.ok !== true || !["primary", "fallback"].includes(account?.id) ||
      (pinnedId !== undefined && account?.id !== pinnedId) ||
      account?.agentDir !== isolatedCodexAgentDir(account.id) || (owner !== undefined && !validLease)) {
    if (validLease) await command(["release", "--lease", lease]);
    throw new Error("Unsafe Codex provider account selection; no ambient credentials selected");
  }
  return { id: account.id, label: account.id === "primary" ? "GPT1" : "GPT2", agentDir: account.agentDir,
    ...(owner !== undefined ? { lease } : {}) };
}
export async function reserveCodexAccount(owner: string, command = providerAccountCommand, pinnedId?: CodexAccountId): Promise<CodexAccountLease> {
  return await selectCodexAccount(command, owner, pinnedId) as CodexAccountLease;
}

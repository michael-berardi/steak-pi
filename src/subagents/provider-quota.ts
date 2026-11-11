import { homedir } from "node:os";
import { join } from "node:path";
import { isClaudeAccountId, type ClaudeAccountId } from "./claude-account.ts";
import { providerAccountCommand, type AccountCommand } from "./provider-accounts.ts";
import { routingConfigOrEmpty, type QuotaTierConfig } from "../routing-config.ts";

/** Account-router provider keys. The quota tiers a chain walks, and which routes belong to each,
 * are operator configuration (`providerQuotaFallback` in routing.json); "claude" is the Claude
 * Code adapter's own key. A tier with `metered: false` has no router meter: a snapshot never
 * carries it (see {@link readProviderQuota}) and only a run's own refusal proves it spent. */
export type QuotaProvider = string;
export const CLAUDE_QUOTA = "claude";
/** The router's account-leased Codex namespace (`select --provider codex`). */
export const CODEX_QUOTA = "codex";

/** The operator's quota tiers in fall-through order. */
export const quotaTiers = (): readonly QuotaTierConfig[] => routingConfigOrEmpty().providerQuotaFallback ?? [];
const providerName = (provider: QuotaProvider): string =>
  provider === CLAUDE_QUOTA ? "Claude" : quotaTiers().find((tier) => tier.quota === provider)?.label ?? provider;
/** The ordered router keys of the configured fall-through walk (duplicates collapsed). */
export const quotaChain = (): readonly QuotaProvider[] => [...new Set(quotaTiers().map((tier) => tier.quota))];
/** True when the tier has a router meter worth preflighting. */
export const isMeteredQuota = (provider: QuotaProvider): boolean =>
  provider === CLAUDE_QUOTA || quotaTiers().some((tier) => tier.quota === provider && tier.metered);
/** True when `route` belongs to the configured tier `quota` (for example the router's account-leased routes). */
export function isQuotaTierRoute(route: string, quota: QuotaProvider): boolean {
  const slash = route.indexOf("/");
  return slash > 0 && quotaProviderOf({ provider: route.slice(0, slash), id: route.slice(slash + 1) }) === quota;
}
const DETAIL_LIMIT = 120;

/** One configured account as the router's `status` reported it. */
export interface QuotaAccount {
  id: string;
  label: string;
  /** The router's own verdict; undefined when the router did not say. */
  eligible?: boolean;
  usedPercent?: number;
  leases?: number;
  /** True when the router's own evidence proves this account cannot launch right now:
   * cooling down, signed out or at a 100% usage window. Busy or unmeasured is NOT out. */
  exhausted?: boolean;
  /** The account's top-level reset time in epoch seconds, when the router reported one. */
  resetAt?: number;
  /** True only when the router's `spill` block says this lent account is draining its green
   * allowance down to pace parity and wants it to take automatic launches first. */
  draining?: boolean;
  /** The router's usage windows for this account (for example `seven_day`). */
  windows?: ReadonlyArray<{ name?: string; usedPercent?: number; resetAt?: number }>;
  /** The account's config folder as the router reported it (`~/.claude`, `~/.claude-b`, ...). Used to map
   * the CLI's own login, which runs from one folder, to the account row that describes it. */
  configDir?: string;
  /** True when this account IS the CLI's default login: the router's launch env unsets CLAUDE_CONFIG_DIR. */
  defaultLogin?: boolean;
  /** Why the router (or the usage evidence) says this account cannot launch; empty when it can. */
  why: string;
}

export interface ProviderQuota {
  provider: QuotaProvider;
  /** Configured accounts the router reported. */
  accounts: number;
  /** The same accounts, in router order. */
  rows: QuotaAccount[];
  /** At least one configured account exists and every one is proven unavailable right now:
   * cooling down, signed out or at a 100% usage window. Busy or unknown accounts never count. */
  exhausted: boolean;
  /** The router lists the provider but no configured account: nothing can launch on it. */
  unconfigured: boolean;
  /** The router itself marked every configured account `eligible: false` (the Claude guard). */
  ineligible: boolean;
  /** Epoch seconds when the earliest exhausted account returns, when the router said. */
  earliestReturn?: number;
  /** Named cause; empty unless the provider is exhausted, unconfigured or ineligible. */
  cause: string;
}

export interface QuotaSnapshot {
  /** False when the router could not be asked or answered nothing usable. That is "unknown",
   * never exhaustion: nothing is skipped on it. */
  known: boolean;
  unknownReason?: string;
  providers: Partial<Record<QuotaProvider, ProviderQuota>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
/** Bounded printable single-line text for router-supplied labels and causes. */
function printable(value: unknown, fallback: string, limit = DETAIL_LIMIT): string {
  const text = typeof value === "string" ? value : value instanceof Error ? value.message : "";
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > 0 ? clean.slice(0, limit) : fallback;
}
function formatReturn(epochSeconds: number): string {
  const when = new Date(epochSeconds * 1000);
  return when.toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");
}

/** Evidence that one account cannot launch now, read from the router's own fields only.
 * `eligible: true` is the router's verdict and always wins; `eligible: false` alone is NOT
 * evidence (an account can be ineligible for being busy or unmeasured). */
function exhaustionEvidence(account: Record<string, unknown>, now: number): { detail: string; returnsAt?: number } | undefined {
  if (account.eligible === true) return undefined;
  const cooldown = record(account.cooldown) ? account.cooldown : undefined;
  const until = finite(cooldown?.until);
  if (account.state === "cooling-down" || (until !== undefined && until > now)) {
    const returnsAt = until ?? finite(account.resetAt);
    return { detail: printable(account.stateText, "cooling down"), ...(returnsAt !== undefined ? { returnsAt } : {}) };
  }
  if (account.signedOut === true) return { detail: "signed out" };
  const windows = Array.isArray(account.windows) ? account.windows.filter(record) : [];
  const full = windows.filter((window) => (finite(window.usedPercent) ?? 0) >= 100 && (finite(window.resetAt) ?? Infinity) > now);
  const topLevelFull = (finite(account.usedPercent) ?? 0) >= 100 && (finite(account.resetAt) ?? Infinity) > now;
  if (full.length > 0 || topLevelFull) {
    const resets = [...full.map((window) => finite(window.resetAt)), ...(topLevelFull ? [finite(account.resetAt)] : [])]
      .filter((value): value is number => value !== undefined);
    return { detail: "a usage window is at 100%", ...(resets.length > 0 ? { returnsAt: Math.min(...resets) } : {}) };
  }
  return undefined;
}

function evaluateProvider(provider: QuotaProvider, block: unknown, now: number): ProviderQuota | undefined {
  if (!record(block) || !Array.isArray(block.accounts)) return undefined;
  const name = providerName(provider);
  const accounts = block.accounts.filter(record).filter((account) => account.configured !== false);
  if (accounts.length === 0) {
    return { provider, accounts: 0, rows: [], exhausted: false, unconfigured: true, ineligible: false,
      cause: `${name} has no configured account in the provider account router` };
  }
  const rows = accounts.map((account, index) => {
    const windows = Array.isArray(account.windows) ? account.windows.filter(record).map((w) => ({
      name: typeof w.name === "string" ? w.name : undefined,
      usedPercent: finite(w.usedPercent),
      resetAt: finite(w.resetAt),
    })) : undefined;
    const spill = record(account.spill) ? account.spill : undefined;
    const launch = record(account.launchEnv) ? account.launchEnv : undefined;
    const unset = Array.isArray(launch?.unset) ? launch.unset.filter((key): key is string => typeof key === "string") : [];
    return {
      id: printable(account.id, `account ${index + 1}`, 40),
      label: printable(account.label, printable(account.id, `account ${index + 1}`, 40), 40),
      evidence: exhaustionEvidence(account, now),
      eligible: typeof account.eligible === "boolean" ? account.eligible : undefined,
      eligibleFalse: account.eligible === false,
      usedPercent: finite(account.usedPercent),
      leases: finite(account.leases),
      why: printable(account.stateText, printable(account.ineligibleReason, "ineligible")),
      resetAt: finite(account.resetAt),
      windows,
      configDir: typeof account.configDir === "string" && account.configDir.length <= 1024 ? account.configDir : undefined,
      // The default login is the folder the CLI uses when nothing names one: the router says so by unsetting it.
      defaultLogin: unset.includes("CLAUDE_CONFIG_DIR"),
      // The spill signal is trusted only when the router says exactly `draining: true`; any
      // other shape (absent, null, non-boolean) is treated as not draining.
      draining: spill?.draining === true,
    };
  });
  const exhausted = rows.every((row) => row.evidence !== undefined);
  const ineligible = rows.every((row) => row.eligibleFalse);
  const returns = rows.map((row) => row.evidence?.returnsAt).filter((value): value is number => value !== undefined);
  const earliestReturn = exhausted && returns.length > 0 ? Math.min(...returns) : undefined;
  const cause = exhausted
    ? `every ${name} account is unavailable (${rows.map((row) => `${row.label}: ${row.evidence!.detail}`).join("; ")})${earliestReturn !== undefined ? `; the earliest returns at ${formatReturn(earliestReturn)}` : ""}`
    : ineligible ? `every ${name} account is ineligible (${rows.map((row) => `${row.label}: ${row.why}`).join("; ")})` : "";
  const listed: QuotaAccount[] = rows.map((row) => ({
    id: row.id, label: row.label, ...(row.eligible !== undefined ? { eligible: row.eligible } : {}),
    ...(row.usedPercent !== undefined ? { usedPercent: row.usedPercent } : {}), ...(row.leases !== undefined ? { leases: row.leases } : {}),
    ...(row.resetAt !== undefined ? { resetAt: row.resetAt } : {}), ...(row.windows !== undefined ? { windows: row.windows } : {}),
    ...(row.configDir !== undefined ? { configDir: row.configDir } : {}), ...(row.defaultLogin ? { defaultLogin: true } : {}),
    ...(row.draining ? { draining: true } : {}),
    exhausted: row.evidence !== undefined,
    why: row.eligible === true ? "" : row.evidence?.detail ?? (row.eligible === false ? row.why : "the router did not report it eligible"),
  }));
  return { provider, accounts: accounts.length, rows: listed, exhausted, unconfigured: false, ineligible, ...(earliestReturn !== undefined ? { earliestReturn } : {}), cause };
}

/** One router `status` read. Never throws: a router that is down, slow or incoherent is
 * "unknown", and unknown is not exhaustion (the launch-time router stays the authority). */
export async function readProviderQuota(command: AccountCommand = providerAccountCommand, nowMs: number = Date.now()): Promise<QuotaSnapshot> {
  let status: unknown;
  try { status = await command(["status"]); }
  catch (error) { return { known: false, unknownReason: printable(error, "provider account router unavailable", 200), providers: {} }; }
  if (!record(status) || !record(status.providers)) {
    return { known: false, unknownReason: "the provider account router answered without a providers block", providers: {} };
  }
  const now = finite(status.time) ?? nowMs / 1000;
  const providers: QuotaSnapshot["providers"] = {};
  // Unmetered tiers are deliberately absent: the router has no meter for them, so such a route is never
  // preflight-blocked; only its own refusal (402 / no endpoint) proves it spent.
  const metered = [...new Set([...quotaTiers().filter((tier) => tier.metered).map((tier) => tier.quota), CLAUDE_QUOTA])];
  for (const provider of metered) {
    const evaluated = evaluateProvider(provider, status.providers[provider], now);
    if (evaluated) providers[provider] = evaluated;
  }
  return { known: true, providers };
}

/** A provider's own wording for an exhausted usage plan, as it reaches a worker's failure text. The
 * label is what the router's `limit` report is told. A bare 429 is NOT here: it is a rate limit, and
 * only Go's `GoUsageLimitError` body or Codex's usage-limit wording proves the plan itself is spent. */
const USAGE_LIMIT_WORDING: ReadonlyArray<readonly [RegExp, string]> = [
  [/subscription_quota_exceeded/i, "subscription_quota_exceeded"],
  [/GoUsageLimitError|Go usage limit exceeded/i, "Go usage limit exceeded"],
  [/usage[_ ]limit[_ ](?:has[_ ]been[_ ])?(?:reached|exceeded)/i, "usage limit reached"],
  // The Claude Code CLI's own pre-output refusal, as this adapter renders it (claude-worker
  // syntheticClaudeCause): "quota limit reached; resets 1pm (America/Buenos_Aires); check Claude usage".
  // Without it a spent Claude plan was never classified as a quota cause (J-3759).
  [/quota limit reached/i, "quota limit reached"],
  // Pi rewrites every Codex usage_limit_reached / 429 into this sentence before a worker sees it
  // (pi-coding-agent openai-codex-responses), so it is the wording a real subscription refusal arrives with.
  [/hit your ChatGPT usage limit/i, "ChatGPT usage limit reached"],
  // A metered gateway's spent credits arrive as HTTP 402 "Insufficient credits" / "requires more credits", and a
  // request no provider endpoint can serve as "No endpoints found" / "0 endpoints out of N requested are
  // available". Either way the next configured tier must take the wave.
  [/\b402\b|insufficient[_ ]credits|requires more credits/i, "gateway credits exhausted"],
  [/no endpoints? (?:found|available)|endpoints? out of \d+ requested are available/i, "gateway has no endpoint for this request"],
];

/** The plan-exhaustion wording found in `text` (Go `GoUsageLimitError` / "Go usage limit exceeded",
 * Codex `subscription_quota_exceeded` / "usage limit has been reached"), or undefined. A worker that
 * fails with one reports its account to the router as `usage`, not `rate`. */
export function providerUsageLimit(text: string): string | undefined {
  return USAGE_LIMIT_WORDING.find(([pattern]) => pattern.test(text))?.[1];
}

/** Whether a usage-limit failure should hold the account out as a spent plan (`usage`) rather than a
 * transient `rate` limit. Pi turns every Codex rate-limit response with a JSON body (including a short burst
 * rate_limit_exceeded) into "You have hit your ChatGPT usage limit", and adds "Try again in ~N min."
 * only when the server sent a reset time; without it the sentence is reported as `rate`, so a burst
 * never takes a GPT account out for a plan's worth of time. Other plan wording is always `usage`. */
export function reportsSpentPlan(text: string): boolean {
  const label = providerUsageLimit(text);
  if (label === undefined) return false;
  if (label === "ChatGPT usage limit reached") return /Try again in\s*~?\s*\d/i.test(text);
  return true;
}

/** A router refusal that says the provider's accounts are cooling down. */
const ROUTER_COOLING_REFUSAL = /Provider account router refused:[^]*\bcooling down\b/i;

/**
 * True when a worker failed to launch because its provider's quota or usage limit is spent: plan
 * exhaustion wording ({@link providerUsageLimit}), a generic quota-exhausted phrase, or a router
 * refusal that says the accounts are cooling down. Auth, route, spawn and bare rate-limit failures
 * are not quota causes: the dispatch fails with them instead of moving to another tier.
 */
export function isQuotaLaunchFailure(text: string): boolean {
  // An unproven lease release is the headline failure and forbids moving to another route,
  // whatever quota wording the earlier failure it quotes carries.
  if (/lease release failed/i.test(text)) return false;
  return providerUsageLimit(text) !== undefined || /quota[_ -]?(?:exhausted|exceeded|reached)/i.test(text) || ROUTER_COOLING_REFUSAL.test(text);
}

/** The configured quota tier a chain step launches on (the first `providerQuotaFallback`
 * entry naming its provider and, when listed, its exact model id), or undefined for a
 * route the operator did not put in a tier (local models, unlisted providers). */
export function quotaProviderOf(step: { provider: string; id: string }): QuotaProvider | undefined {
  return quotaTiers().find((tier) => tier.provider === step.provider && (!tier.models || tier.models.includes(step.id)))?.quota;
}

/** Why `step` cannot launch, or undefined (including for unknown, busy and ungated routes).
 * An unconfigured provider is blocked too: no account can ever be reserved on it. */
export function routeQuotaBlock(snapshot: QuotaSnapshot, step: { provider: string; id: string }): string | undefined {
  const provider = quotaProviderOf(step);
  const quota = provider ? snapshot.providers[provider] : undefined;
  return quota && (quota.exhausted || quota.unconfigured) ? quota.cause : undefined;
}

/** The Claude subscription tier is never offered a proven-ineligible account set (the same
 * proof `noEligibleClaudeAccount` uses: the router marked every configured account
 * `eligible: false`). A router that lists no Claude account proves nothing about the CLI login. */
export function claudeQuotaBlock(snapshot: QuotaSnapshot): string | undefined {
  const quota = snapshot.providers.claude;
  return quota && !quota.unconfigured && (quota.exhausted || quota.ineligible) ? quota.cause : undefined;
}

/**
 * The account a Claude launch WITHOUT a pinned account actually runs on: the CLI's own login. The CLI
 * chooses it by config folder - `CLAUDE_CONFIG_DIR` when the session sets one, the default `~/.claude`
 * folder (the variable unset) otherwise - so a route that pins nothing is gated on THAT account, never
 * on "some account of this provider is eligible". Undefined when the router cannot map the folder to a
 * configured account: an unregistered or unreadable login proves nothing about any account.
 */
export function claudeLoginAccount(
  snapshot: QuotaSnapshot,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): QuotaAccount | undefined {
  if (!snapshot.known) return undefined;
  const quota = snapshot.providers.claude;
  if (!quota || quota.unconfigured || quota.rows.length === 0) return undefined;
  const configured = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  if (configured === "") return quota.rows.find((row) => row.defaultLogin === true) ?? folderRow(quota.rows, join(home, ".claude"));
  return folderRow(quota.rows, configured);
}

function folderRow(rows: readonly QuotaAccount[], folder: string): QuotaAccount | undefined {
  const wanted = folder.replace(/\/+$/, "");
  return wanted.length === 0 ? undefined : rows.find((row) => row.configDir !== undefined && row.configDir.replace(/\/+$/, "") === wanted);
}

/**
 * Why a Claude launch that pins no account cannot run on the login it would use, or undefined when that
 * login is proven launchable or the router cannot name it (unknown and unregistered are never exhaustion).
 * The router already holds this evidence, so a spent login is refused here with the account named, instead
 * of launching into the CLI's own refusal (J-3759: the per-turn line said the tier was up because another
 * account was eligible, while the parent's own login was at 100%).
 */
export function claudeLoginBlock(
  snapshot: QuotaSnapshot,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { account: QuotaAccount; cause: string } | undefined {
  const account = claudeLoginAccount(snapshot, env, home);
  if (account === undefined || account.exhausted !== true) return undefined;
  return { account, cause: `${account.label} (the Claude login an unpinned route uses): ${account.why}` };
}

export interface ClaudeAccountPick {
  /** The eligible account to pin the worker on; absent when the router shows none to pick from. */
  account?: { id: ClaudeAccountId; label: string };
  /** Why nothing was picked. Set only when the router listed Claude accounts and none is eligible. */
  cause?: string;
}

/**
 * The Claude subscription account an automatic fallback worker is pinned on. Only an account the
 * router's own snapshot shows `eligible: true` is ever picked; a launch without a pinned account
 * would run on the parent's default login, which the same snapshot may show cooling down.
 * A draining eligible account (the router's `spill.draining: true`: a lent plan being run down to
 * pace parity) wins outright, before the least-used rank — the operator wants that plan's green
 * allowance spent first. Among draining accounts, and among all non-draining ones, the least-used
 * window wins (unmeasured accounts last), then the fewest live leases, then router order, so
 * successive waves spread across the configured accounts. An account marked `draining` but
 * `eligible: false` is never picked.
 *
 * An unreadable router, or one that lists no Claude account, proves nothing about any login: it
 * returns neither an account nor a cause, and the caller keeps its pre-existing behaviour.
 */
export function pickClaudeAccount(snapshot: QuotaSnapshot): ClaudeAccountPick {
  const quota = snapshot.providers.claude;
  if (!quota || quota.unconfigured) return {};
  const ranked = rankClaudeAccounts(snapshot);
  if (ranked.length === 0) {
    return { cause: `the router shows no eligible Claude account (${quota.rows.map((row) => `${row.label}: ${row.why}`).join("; ")})` };
  }
  return { account: ranked[0] };
}

/** Every pinnable (router-eligible) Claude account, best first: the order {@link pickClaudeAccount} takes its pick from.
 * The caller walks it and keeps the first account the router's own `select` also accepts, so a snapshot that is a
 * moment stale, or a `select` that applies a stricter guard (a lent plan's reserve floor), skips to the next account
 * instead of failing the wave on one that cannot launch. */
export function rankClaudeAccounts(snapshot: QuotaSnapshot): Array<{ id: ClaudeAccountId; label: string }> {
  const quota = snapshot.providers.claude;
  if (!quota || quota.unconfigured) return [];
  const pinnable = quota.rows.filter((row): row is QuotaAccount & { id: ClaudeAccountId } =>
    row.eligible === true && isClaudeAccountId(row.id));
  // Draining sorts first; the rest is the pre-existing least-used / fewest-leases / router-order rank.
  const rank = (row: QuotaAccount) => [row.draining === true ? 0 : 1, row.usedPercent ?? Number.POSITIVE_INFINITY, row.leases ?? 0];
  return pinnable
    .map((row, index) => ({ row, index, key: rank(row) }))
    .sort((x, y) => x.key[0]! - y.key[0]! || x.key[1]! - y.key[1]! || x.key[2]! - y.key[2]! || x.index - y.index)
    .map(({ row }) => ({ id: row.id, label: row.label }));
}

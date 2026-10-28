import { SOL_MODEL_ROUTE } from "../retired-model-selection.ts";
import { providerAccountCommand, type AccountCommand } from "./provider-accounts.ts";

/** Router provider keys whose accounts gate a launch: GPT Sol (`codex`), OpenCode Go and Claude. */
export type QuotaProvider = "codex" | "opencode-go" | "claude";

const PROVIDER_NAMES: Record<QuotaProvider, string> = { codex: "GPT", "opencode-go": "Go", claude: "Claude" };
const DETAIL_LIMIT = 120;

/** One configured account as the router's `status` reported it. */
export interface QuotaAccount {
  id: string;
  label: string;
  /** The router's own verdict; undefined when the router did not say. */
  eligible?: boolean;
  usedPercent?: number;
  leases?: number;
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
  const name = PROVIDER_NAMES[provider];
  const accounts = block.accounts.filter(record).filter((account) => account.configured !== false);
  if (accounts.length === 0) {
    return { provider, accounts: 0, rows: [], exhausted: false, unconfigured: true, ineligible: false,
      cause: `${name} has no configured account in the provider account router` };
  }
  const rows = accounts.map((account, index) => ({
    id: printable(account.id, `account ${index + 1}`, 40),
    label: printable(account.label, printable(account.id, `account ${index + 1}`, 40), 40),
    evidence: exhaustionEvidence(account, now),
    eligible: typeof account.eligible === "boolean" ? account.eligible : undefined,
    eligibleFalse: account.eligible === false,
    usedPercent: finite(account.usedPercent),
    leases: finite(account.leases),
    why: printable(account.stateText, printable(account.ineligibleReason, "ineligible")),
  }));
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
  for (const provider of ["codex", "opencode-go", "claude"] as const) {
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
  // Pi rewrites every Codex usage_limit_reached / 429 into this sentence before a worker sees it
  // (pi-coding-agent openai-codex-responses), so it is the wording a real Sol refusal arrives with.
  [/hit your ChatGPT usage limit/i, "ChatGPT usage limit reached"],
];

/** The plan-exhaustion wording found in `text` (Go `GoUsageLimitError` / "Go usage limit exceeded",
 * Codex `subscription_quota_exceeded` / "usage limit has been reached"), or undefined. A worker that
 * fails with one reports its account to the router as `usage`, not `rate`. */
export function providerUsageLimit(text: string): string | undefined {
  return USAGE_LIMIT_WORDING.find(([pattern]) => pattern.test(text))?.[1];
}

/** Whether a usage-limit failure should hold the account out as a spent plan (`usage`) rather than a
 * transient `rate` limit. Pi turns every Codex 429 with a JSON body (including a short burst
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

/** The router-managed provider a chain step launches on, or undefined for a route the
 * router does not gate (MiMo, Astra, Luna, local models). */
export function quotaProviderOf(step: { provider: string; id: string }): QuotaProvider | undefined {
  if (`${step.provider}/${step.id}` === SOL_MODEL_ROUTE) return "codex";
  if (step.provider === "opencode-go") return "opencode-go";
  return undefined;
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

export type ClaudeAccountId = "primary" | "b";

export interface ClaudeAccountPick {
  /** The eligible account to pin the worker on; absent when the router shows none to pick from. */
  account?: { id: ClaudeAccountId; label: string };
  /** Why nothing was picked. Set only when the router listed Claude accounts and none is eligible. */
  cause?: string;
}

/**
 * The Claude subscription account an automatic fallback worker is pinned on. Only an account the
 * router's own snapshot shows `eligible: true` is ever picked; a launch without a pinned account
 * would run on the parent's default login (Claude 1), which the same snapshot may show cooling down.
 * Among eligible accounts the least-used window wins (unmeasured accounts last), then the fewest
 * live leases, then router order, so successive waves spread across Claude 1 and Claude 2.
 *
 * An unreadable router, or one that lists no Claude account, proves nothing about any login: it
 * returns neither an account nor a cause, and the caller keeps its pre-existing behaviour.
 */
export function pickClaudeAccount(snapshot: QuotaSnapshot): ClaudeAccountPick {
  const quota = snapshot.providers.claude;
  if (!quota || quota.unconfigured) return {};
  const pinnable = quota.rows.filter((row): row is QuotaAccount & { id: ClaudeAccountId } =>
    row.eligible === true && (row.id === "primary" || row.id === "b"));
  if (pinnable.length === 0) {
    return { cause: `the router shows no eligible Claude account (${quota.rows.map((row) => `${row.label}: ${row.why}`).join("; ")})` };
  }
  const rank = (row: QuotaAccount) => [row.usedPercent ?? Number.POSITIVE_INFINITY, row.leases ?? 0];
  const best = pinnable.reduce((chosen, row) => {
    const [a, b] = [rank(row), rank(chosen)];
    return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]) ? row : chosen;
  });
  return { account: { id: best.id, label: best.label } };
}

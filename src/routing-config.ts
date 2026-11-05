/**
 * Operator routing configuration: the one place Steak Pi learns which models,
 * chains, profiles, fallbacks and paid routes an operator chose.
 *
 * Steak Pi ships no model, provider preference, fallback chain or spending
 * grant of its own. Every such choice is read from the operator's files:
 *
 * - `~/.config/ultraterm/routing.json` (override: `STEAK_PI_ROUTING_CONFIG`),
 *   which also carries the long-standing `workerDefault`/`reviewerDefault`
 *   role defaults read by `loadRoleDefaults`;
 * - `~/.pi/agent/paid-routes.json` (override: `STEAK_PI_PAID_ROUTES`), the
 *   reviewed paid-route catalog and its allowlist (see `explicit-paid-route.ts`).
 *
 * A missing file is an empty configuration, never an error, so the tool always
 * starts and explicit selectors keep working. A malformed file is reported by
 * the routing decision that needs it ({@link RoutingConfigError}), never at
 * import time. Reads are cached by file identity, so an edit takes effect on
 * the next decision without a restart. The keys are documented in
 * docs/MODEL-ROUTING.md.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const ROUTING_CONFIG_ENV = "STEAK_PI_ROUTING_CONFIG";
export const PAID_ROUTES_ENV = "STEAK_PI_PAID_ROUTES";
/** Display form of the routing file for operator-facing messages. */
export const ROUTING_CONFIG_LABEL = "~/.config/ultraterm/routing.json";
export const PAID_ROUTES_LABEL = "~/.pi/agent/paid-routes.json";

export const routingConfigPath = (): string =>
  process.env[ROUTING_CONFIG_ENV] || join(homedir(), ".config", "ultraterm", "routing.json");
export const paidRoutesConfigPath = (): string =>
  process.env[PAID_ROUTES_ENV] || join(homedir(), ".pi", "agent", "paid-routes.json");

export class RoutingConfigError extends Error { override name = "RoutingConfigError"; }

/** A task class is a lowercase slug the operator chooses; Steak Pi ships none. */
export const TASK_CLASS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TASK_CLASS_MAX_LENGTH = 48;
export const MAX_TASK_CLASSES = 64;
export const MAX_TASK_CLASS_CHAIN = 16;
/** Bounds for a profile's `ensure.timeoutMs`. */
export const ENSURE_DEFAULT_TIMEOUT_MS = 120_000;
export const ENSURE_MIN_TIMEOUT_MS = 1_000;
export const ENSURE_MAX_TIMEOUT_MS = 600_000;

/** Clear "nothing configured" message naming the exact key an operator sets. */
export const missingConfigKey = (what: string, key: string): string =>
  `No ${what} configured: set ${key} in ${ROUTING_CONFIG_LABEL}.`;

export interface OnlyWhenCondition {
  provider: string;
  everyAccount: { remainingBelow: number; behindPaceAbove: number };
}
export interface RouteStep { provider: string; id: string; onlyWhen?: OnlyWhenCondition }
type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export interface RouteSelector { model?: string; profile?: string }

export interface ChainHeadConfig {
  /** An automatic profile whose head is this route keeps its own chain. */
  head: RouteStep;
  /** Text chain after the head. */
  then: readonly RouteStep[];
  /** Image chain after the head (usually empty). */
  multimodalThen: readonly RouteStep[];
}
export interface ExpertReviewConfig {
  model: RouteStep;
  /** Default worker thinking for the expert when the caller names none. */
  thinking?: "medium" | "high" | "xhigh";
  /** Eligibility needs an OAuth credential (default true). */
  requireOAuth: boolean;
  /** Exact native API the expert must be served by, when set. */
  api?: string;
  /** Exact base URL (origin + path, trailing slash ignored) the expert must use, when set. */
  baseUrl?: string;
}
/** A command run before a worker on the profile launches and, when `release` is set, after it ends.
 * Both are argv arrays (no shell); `timeoutMs` bounds each run. See `profile-ensure.ts`. */
export interface ProfileEnsureConfig {
  command: readonly string[];
  release?: readonly string[];
  timeoutMs?: number;
}
export interface ConfiguredWorkerProfile {
  id: string;
  model: string;
  thinking?: Thinking;
  workerDefault?: RouteSelector;
  reviewerDefault?: RouteSelector;
  autoChain?: boolean;
  autoReviewChain?: boolean;
  /** Operator-owned launch hook; read only from routing.json, never from a manifest, task or checkpoint. */
  ensure?: ProfileEnsureConfig;
}
/** One operator-named class of task and the chain that serves it before the default chain. */
export interface TaskClassConfig {
  /** Ordered steps: a worker profile id (`harness/profile`) or an exact `provider/model` route. */
  chain: readonly string[];
  /** The class is routed on the evidence that a test gate checks its results: the dispatch says so. */
  requiresTestGate: boolean;
  note?: string;
  /** Dollars one second of waiting is worth when ranking this class's routes (default 0: cost alone). */
  timeWeight?: number;
  /** Rolling pass rate under which a route is held out of this class (default 0: no floor). */
  minPassRate?: number;
  /** Share of dispatches that deliberately pick a weaker route to keep its estimate current (default 0.1). */
  explore?: number;
  /** Consecutive failures that demote a route for this class (default 3). */
  demoteAfter?: number;
  /** Decided outcomes the rolling pass rate looks at (default 10). */
  window?: number;
  /** Minutes a demoted route stays out before one re-probe (default 30). */
  cooldownMinutes?: number;
  /** Output budget for the one same-route retry of an empty or output-exhausted reply (default: double the model's own). */
  retryMaxTokens?: number;
  /** Most tasks one wave may run on this class's routes at once (a local server with one slot is 1). A wider wave skips the class. */
  slots?: number;
  /** "small": the class is for small, bounded tasks; a wave with a task that may both edit and run a shell skips it. */
  maxScope?: "small";
  /** Starting estimates per chain entry: `pass` of `n` earlier trials, and the mean cost and seconds of a trial. */
  priors?: Readonly<Record<string, { pass: number; n: number; costUsd?: number; seconds?: number }>>;
}
export interface RetiredModelPattern {
  pattern: RegExp;
  message: string;
  /** Only refuse selector strings (model/profile names), never resolved identities. */
  selectorsOnly: boolean;
}
export interface CatalogExtra { provider: string; models: readonly Record<string, unknown>[] }
export interface QuotaTierConfig {
  /** Account-router provider key (for example the key its `status` reports). */
  quota: string;
  /** Pi provider id whose routes belong to this tier. */
  provider: string;
  /** Exact model ids of that provider in this tier; absent means every model. */
  models?: readonly string[];
  /** False when the router has no meter for this tier: it is never preflight-gated,
   * only tracked so a run's own refusal holds it out of a fall-through walk. */
  metered: boolean;
  label?: string;
  /** True when routes in this tier lease an account from the provider account router
   * (`select --provider <quota>`); absent means no account leasing. */
  accountRouter?: boolean;
  /** Exact base URL the router requires for this tier's routes; absent accepts any. */
  baseUrl?: string;
}
export interface HiddenModelPattern { provider: string; pattern: RegExp }
export interface TemporaryFreeExclusion { provider: string; pattern: RegExp }
export interface SubscriptionRouteCheck {
  provider: string;
  /** Exact https hostname of the subscription endpoint. */
  host: string;
  /** Pathname pattern; absent accepts any path. */
  pathPattern?: RegExp;
  /** Route counts as subscription only with an OAuth credential. */
  oauth: boolean;
  /** Query strings and fragments disqualify the route. */
  exact: boolean;
  /** Models whose id or name match may ONLY be served through this exact route. */
  modelPattern?: RegExp;
  /** Exact native API a pinned model must use. */
  api?: string;
  /** Pinned model ids that are refused even on this route (for example a batch transport). */
  excludeIdPattern?: RegExp;
}
export interface ClaudeFallbackTierConfig { ordinary: string; substantial: string }
export interface ClaudeCodeDefaultsConfig { worker?: string; reviewer?: string }
export interface ImplicitReviewConfig { route: string; fallback?: string }
export interface VerificationGateConfig { match: RegExp; reviewer: string; fallback?: string }

/** The validated operator configuration. Every key is optional; absent means "no choice". */
export interface RoutingConfig {
  workerDefault?: RouteSelector;
  reviewerDefault?: RouteSelector;
  textWorkerChain?: readonly RouteStep[];
  multimodalWorkerChain?: readonly RouteStep[];
  defaultChainProfile?: string;
  tokenPlanChainHeads?: readonly ChainHeadConfig[];
  reviewerChainHead?: RouteStep;
  expertReview?: ExpertReviewConfig;
  workerProfiles?: readonly ConfiguredWorkerProfile[];
  /** Operator-named task classes (`taskClasses`); absent means no class steers any route. */
  taskClasses?: Readonly<Record<string, TaskClassConfig>>;
  /** Operator rules (`taskClassRules`) that give an implicit text task with no `taskClass` the first matching class; absent: none. */
  taskClassRules?: readonly TaskClassRule[];
  /** `routeConditions` by route key, kept so a class chain step gets the same `onlyWhen` as a default chain step. */
  routeConditions?: Readonly<Record<string, OnlyWhenCondition>>;
  retiredModelPatterns?: readonly RetiredModelPattern[];
  retiredProfiles?: readonly string[];
  catalogExtras?: readonly CatalogExtra[];
  providerQuotaFallback?: readonly QuotaTierConfig[];
  hiddenModelPatterns?: readonly HiddenModelPattern[];
  /** Families never usable as a temporary free identity (adapter/provider families). */
  temporaryFreeExclusions?: readonly TemporaryFreeExclusion[];
  subscriptionRouteChecks?: readonly SubscriptionRouteCheck[];
  subscriptionFirstProvider?: string;
  claudeFallbackTier?: ClaudeFallbackTierConfig;
  claudeCodeDefaults?: ClaudeCodeDefaultsConfig;
  implicitReview?: ImplicitReviewConfig;
  verificationGates?: readonly VerificationGateConfig[];
  routeLabels?: Readonly<Record<string, string>>;
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fail = (key: string, detail: string): never => {
  throw new RoutingConfigError(`${ROUTING_CONFIG_LABEL} ${key}: ${detail}`);
};
const text = (value: unknown, key: string, limit = 256): string => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > limit) {
    return fail(key, `expected a nonempty string of at most ${limit} characters`);
  }
  return value;
};
const optionalText = (value: unknown, key: string, limit = 256): string | undefined => value === undefined ? undefined : text(value, key, limit);
const numeric = (value: unknown, key: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fail(key, "expected a nonnegative number");
  return value;
};
const bool = (value: unknown, key: string, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") return fail(key, "expected true or false");
  return value;
};
/** Case-insensitive unless `flags` says otherwise (paths and slugs are matched exactly). */
const regex = (value: unknown, key: string, flags = "i"): RegExp => {
  const source = text(value, key, 1024);
  try { return new RegExp(source, flags); } catch { return fail(key, "is not a valid regular expression"); }
};
const array = (value: unknown, key: string): unknown[] => {
  if (!Array.isArray(value)) return fail(key, "expected an array");
  return value;
};

/** `provider/model` (split at the first slash, so a model id may contain slashes), or an object with `provider`, `id`, and optional `onlyWhen`. */
function parseOnlyWhen(value: unknown, key: string): OnlyWhenCondition | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) return fail(key, "expected an onlyWhen object { provider, everyAccount: { remainingBelow, behindPaceAbove } }");
  const provider = text(value.provider, `${key}.provider`);
  if (!object(value.everyAccount)) return fail(`${key}.everyAccount`, "expected { remainingBelow, behindPaceAbove }");
  const remainingBelow = numeric(value.everyAccount.remainingBelow, `${key}.everyAccount.remainingBelow`);
  const behindPaceAbove = numeric(value.everyAccount.behindPaceAbove, `${key}.everyAccount.behindPaceAbove`);
  return { provider, everyAccount: { remainingBelow, behindPaceAbove } };
}

export function parseRoute(value: unknown, key = "route"): RouteStep {
  if (typeof value === "string") {
    const route = text(value, key);
    const slash = route.indexOf("/");
    if (slash < 1 || slash === route.length - 1) return fail(key, `${JSON.stringify(route)} must use the exact provider/model form`);
    return { provider: route.slice(0, slash), id: route.slice(slash + 1) };
  }
  if (object(value)) {
    const provider = text(value.provider, `${key}.provider`);
    const id = text(value.id, `${key}.id`);
    const onlyWhen = parseOnlyWhen(value.onlyWhen, `${key}.onlyWhen`);
    return { provider, id, ...(onlyWhen !== undefined ? { onlyWhen } : {}) };
  }
  return fail(key, `expected "provider/model" or { provider, id, onlyWhen }`);
}
export const routeKey = (step: RouteStep): string => `${step.provider}/${step.id}`;
const routes = (value: unknown, key: string): RouteStep[] => array(value, key).map((entry, index) => parseRoute(entry, `${key}[${index}]`));
const thinking = (value: unknown, key: string): Thinking | undefined => {
  if (value === undefined) return undefined;
  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(value as string)) return fail(key, "expected a Pi thinking level");
  return value as Thinking;
};
const selectorOf = (value: unknown, key: string): RouteSelector => {
  // Detailed selector rules (retired routes, conflicts) stay with model-selection.ts.
  if (!object(value)) return fail(key, "expected a model/profile selector");
  return value as RouteSelector;
};

/** An argv array for a command USAP runs without a shell: the first element is an absolute path or a bare
 * command name (never a path relative to the working directory, which a repository could plant). */
function argvOf(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return fail(key, "expected an argv array of strings; a shell string is refused because USAP never runs a shell");
  if (value.length < 1 || value.length > 64) return fail(key, "expected 1 to 64 argv strings");
  const list = value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 4096 || item.includes("\0")) {
      return fail(`${key}[${index}]`, "expected a nonempty string of at most 4096 characters without NUL");
    }
    return item;
  });
  const program = list[0];
  if (program.includes("/") ? !isAbsolute(program) : /\s/.test(program)) {
    return fail(`${key}[0]`, "must be an absolute path or a bare command name without spaces (put arguments in later elements; relative paths are refused)");
  }
  return list;
}
function parseEnsure(value: unknown, key: string): ProfileEnsureConfig {
  if (!object(value)) return fail(key, "expected { command: [argv...], release: [argv...], timeoutMs }");
  for (const name of Object.keys(value)) {
    if (!["command", "release", "timeoutMs"].includes(name)) return fail(`${key}.${name}`, "unknown key (allowed: command, release, timeoutMs)");
  }
  let timeoutMs: number | undefined;
  if (value.timeoutMs !== undefined) {
    const raw = value.timeoutMs;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < ENSURE_MIN_TIMEOUT_MS || raw > ENSURE_MAX_TIMEOUT_MS) {
      return fail(`${key}.timeoutMs`, `expected an integer from ${ENSURE_MIN_TIMEOUT_MS} to ${ENSURE_MAX_TIMEOUT_MS} milliseconds`);
    }
    timeoutMs = raw;
  }
  return {
    command: argvOf(value.command, `${key}.command`),
    ...(value.release !== undefined ? { release: argvOf(value.release, `${key}.release`) } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
const TASK_CLASS_KEYS = ["chain", "requiresTestGate", "note", "timeWeight", "minPassRate", "explore", "demoteAfter", "window", "cooldownMinutes", "retryMaxTokens", "slots", "maxScope", "priors"];
function boundedNumber(value: unknown, key: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    return fail(key, `expected ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  }
  return value;
}
function parsePriors(value: unknown, key: string, chain: readonly string[]): NonNullable<TaskClassConfig["priors"]> {
  if (!object(value)) return fail(key, "expected { \"<chain entry>\": { pass, n, costUsd, seconds } }");
  const priors: Record<string, { pass: number; n: number; costUsd?: number; seconds?: number }> = {};
  for (const [entry, raw] of Object.entries(value)) {
    const at = `${key}.${entry}`;
    if (!chain.includes(entry)) return fail(at, "names no step of this class's chain (use the chain entry exactly as written)");
    if (!object(raw)) return fail(at, "expected { pass, n, costUsd, seconds }");
    for (const field of Object.keys(raw)) if (!["pass", "n", "costUsd", "seconds"].includes(field)) return fail(`${at}.${field}`, "unknown key (allowed: pass, n, costUsd, seconds)");
    const n = boundedNumber(raw.n, `${at}.n`, 0, 100_000, true);
    const pass = boundedNumber(raw.pass, `${at}.pass`, 0, n, true);
    priors[entry] = {
      pass, n,
      ...(raw.costUsd !== undefined ? { costUsd: boundedNumber(raw.costUsd, `${at}.costUsd`, 0, 1_000_000) } : {}),
      ...(raw.seconds !== undefined ? { seconds: boundedNumber(raw.seconds, `${at}.seconds`, 0, 1_000_000) } : {}),
    };
  }
  return priors;
}
export interface TaskClassRule {
  class: string;
  when: { role?: "scout" | "worker" | "reviewer"; mayEdit?: boolean; allowBash?: boolean; textPattern?: string };
}
const MAX_TASK_CLASS_RULES = 32;
function parseTaskClassRules(value: unknown, classes: Readonly<Record<string, TaskClassConfig>> | undefined): TaskClassRule[] {
  const rows = array(value, "taskClassRules");
  if (rows.length > MAX_TASK_CLASS_RULES) return fail("taskClassRules", `expected at most ${MAX_TASK_CLASS_RULES} rules`);
  return rows.map((row, index) => {
    const key = `taskClassRules[${index}]`;
    if (!object(row)) return fail(key, 'expected { class, when: { role?, mayEdit?, allowBash?, textPattern? } }');
    for (const field of Object.keys(row)) if (field !== "class" && field !== "when") return fail(`${key}.${field}`, "unknown key (allowed: class, when)");
    const name = text(row.class, `${key}.class`);
    if (!classes || !Object.hasOwn(classes, name)) return fail(`${key}.class`, `class ${JSON.stringify(name)} is not in taskClasses`);
    if (!object(row.when)) return fail(`${key}.when`, "expected an object");
    const when: TaskClassRule["when"] = {};
    for (const [field, v] of Object.entries(row.when)) {
      if (field === "role") {
        if (v !== "scout" && v !== "worker" && v !== "reviewer") return fail(`${key}.when.role`, "expected scout, worker or reviewer");
        when.role = v;
      } else if (field === "mayEdit" || field === "allowBash") {
        if (typeof v !== "boolean") return fail(`${key}.when.${field}`, "expected true or false");
        when[field] = v;
      } else if (field === "textPattern") {
        const pattern = text(v, `${key}.when.textPattern`);
        try { new RegExp(pattern, "i"); } catch (error) { return fail(`${key}.when.textPattern`, `invalid regular expression: ${(error as Error).message}`); }
        when.textPattern = pattern;
      } else return fail(`${key}.when.${field}`, "unknown key (allowed: role, mayEdit, allowBash, textPattern)");
    }
    if (Object.keys(when).length === 0) return fail(`${key}.when`, "a rule needs at least one condition");
    return { class: name, when };
  });
}
function parseTaskClasses(value: unknown): Record<string, TaskClassConfig> {
  if (!object(value)) return fail("taskClasses", 'expected { "<class>": { chain: ["harness/profile or provider/model", ...], requiresTestGate, note } }');
  const entries = Object.entries(value);
  if (entries.length > MAX_TASK_CLASSES) return fail("taskClasses", `expected at most ${MAX_TASK_CLASSES} classes`);
  const classes: Record<string, TaskClassConfig> = {};
  for (const [name, entry] of entries) {
    const key = `taskClasses.${name}`;
    if (!TASK_CLASS_PATTERN.test(name) || name.length > TASK_CLASS_MAX_LENGTH) {
      return fail("taskClasses", `class name ${JSON.stringify(name.slice(0, 60))} must be a lowercase slug of at most ${TASK_CLASS_MAX_LENGTH} characters (letters, digits and single hyphens)`);
    }
    if (!object(entry)) return fail(key, "expected { chain, requiresTestGate, note }");
    for (const field of Object.keys(entry)) {
      if (!TASK_CLASS_KEYS.includes(field)) return fail(`${key}.${field}`, `unknown key (allowed: ${TASK_CLASS_KEYS.join(", ")})`);
    }
    const chain = array(entry.chain, `${key}.chain`).map((step, index) => {
      const route = text(step, `${key}.chain[${index}]`);
      const slash = route.indexOf("/");
      if (slash < 1 || slash === route.length - 1) return fail(`${key}.chain[${index}]`, `${JSON.stringify(route)} must be a worker profile id (harness/profile) or an exact provider/model route`);
      return route;
    });
    if (chain.length < 1 || chain.length > MAX_TASK_CLASS_CHAIN) return fail(`${key}.chain`, `expected 1 to ${MAX_TASK_CLASS_CHAIN} steps`);
    const duplicate = chain.find((step, index) => chain.indexOf(step) !== index);
    if (duplicate !== undefined) return fail(`${key}.chain`, `${JSON.stringify(duplicate)} appears more than once`);
    classes[name] = {
      chain,
      requiresTestGate: bool(entry.requiresTestGate, `${key}.requiresTestGate`, false),
      ...(entry.note !== undefined ? { note: text(entry.note, `${key}.note`, 400) } : {}),
      ...(entry.timeWeight !== undefined ? { timeWeight: boundedNumber(entry.timeWeight, `${key}.timeWeight`, 0, 1_000) } : {}),
      ...(entry.minPassRate !== undefined ? { minPassRate: boundedNumber(entry.minPassRate, `${key}.minPassRate`, 0, 1) } : {}),
      ...(entry.explore !== undefined ? { explore: boundedNumber(entry.explore, `${key}.explore`, 0, 0.5) } : {}),
      ...(entry.demoteAfter !== undefined ? { demoteAfter: boundedNumber(entry.demoteAfter, `${key}.demoteAfter`, 1, 100, true) } : {}),
      ...(entry.window !== undefined ? { window: boundedNumber(entry.window, `${key}.window`, 2, 500, true) } : {}),
      ...(entry.cooldownMinutes !== undefined ? { cooldownMinutes: boundedNumber(entry.cooldownMinutes, `${key}.cooldownMinutes`, 1, 10_080) } : {}),
      ...(entry.retryMaxTokens !== undefined ? { retryMaxTokens: boundedNumber(entry.retryMaxTokens, `${key}.retryMaxTokens`, 256, 1_048_576, true) } : {}),
      ...(entry.slots !== undefined ? { slots: boundedNumber(entry.slots, `${key}.slots`, 1, 64, true) } : {}),
      ...(entry.maxScope !== undefined ? { maxScope: entry.maxScope === "small" ? "small" as const : fail(`${key}.maxScope`, 'expected "small"') } : {}),
      ...(entry.priors !== undefined ? { priors: parsePriors(entry.priors, `${key}.priors`, chain) } : {}),
    };
  }
  return classes;
}

/** Validate one parsed routing.json object. Unknown keys are ignored (other tools share the file). */
export function parseRoutingConfig(raw: unknown): RoutingConfig {
  if (!object(raw)) return fail("(file)", "expected a JSON object");
  const config: { -readonly [K in keyof RoutingConfig]: RoutingConfig[K] } = {};
  if (raw.workerDefault !== undefined) config.workerDefault = selectorOf(raw.workerDefault, "workerDefault");
  if (raw.reviewerDefault !== undefined) config.reviewerDefault = selectorOf(raw.reviewerDefault, "reviewerDefault");
  if (raw.textWorkerChain !== undefined) config.textWorkerChain = routes(raw.textWorkerChain, "textWorkerChain");
  if (raw.multimodalWorkerChain !== undefined) config.multimodalWorkerChain = routes(raw.multimodalWorkerChain, "multimodalWorkerChain");
  // `routeConditions` attaches an `onlyWhen` to plain "provider/model" chain steps by their route key. It lives in its
  // own top-level key so a routing.json that uses it stays readable by releases that only know plain string steps
  // (they ignore unknown keys); an inline object step would stop those releases from parsing the file at all.
  if (raw.routeConditions !== undefined) {
    if (!object(raw.routeConditions)) return fail("routeConditions", 'expected { "provider/model": { provider, everyAccount: { remainingBelow, behindPaceAbove } } }');
    const conditions = new Map<string, OnlyWhenCondition>();
    for (const [route, condition] of Object.entries(raw.routeConditions)) {
      const parsed = parseOnlyWhen(condition, `routeConditions.${route}`);
      if (parsed) conditions.set(route, parsed);
    }
    const apply = (chain: readonly RouteStep[] | undefined) => chain?.map((step) => {
      const condition = step.onlyWhen ?? conditions.get(routeKey(step));
      return condition ? { ...step, onlyWhen: condition } : step;
    });
    config.textWorkerChain = apply(config.textWorkerChain);
    config.multimodalWorkerChain = apply(config.multimodalWorkerChain);
    config.routeConditions = Object.fromEntries(conditions);
  }
  if (raw.defaultChainProfile !== undefined) config.defaultChainProfile = text(raw.defaultChainProfile, "defaultChainProfile");
  if (raw.tokenPlanChainHeads !== undefined) {
    config.tokenPlanChainHeads = array(raw.tokenPlanChainHeads, "tokenPlanChainHeads").map((entry, index) => {
      const key = `tokenPlanChainHeads[${index}]`;
      if (typeof entry === "string") return { head: parseRoute(entry, key), then: [], multimodalThen: [] };
      if (!object(entry)) return fail(key, "expected a route string or { head, then, multimodalThen }");
      return {
        head: parseRoute(entry.head, `${key}.head`),
        then: entry.then === undefined ? [] : routes(entry.then, `${key}.then`),
        multimodalThen: entry.multimodalThen === undefined ? [] : routes(entry.multimodalThen, `${key}.multimodalThen`),
      };
    });
  }
  if (raw.reviewerChainHead !== undefined) config.reviewerChainHead = parseRoute(raw.reviewerChainHead, "reviewerChainHead");
  if (raw.expertReview !== undefined) {
    const entry = raw.expertReview;
    if (!object(entry)) return fail("expertReview", "expected { model, thinking, requireOAuth, api, baseUrl }");
    const level = thinking(entry.thinking, "expertReview.thinking");
    if (level !== undefined && !["medium", "high", "xhigh"].includes(level)) fail("expertReview.thinking", "expected medium, high or xhigh");
    let baseUrl: string | undefined;
    if (entry.baseUrl !== undefined) {
      baseUrl = text(entry.baseUrl, "expertReview.baseUrl", 2048);
      try { new URL(baseUrl); } catch { fail("expertReview.baseUrl", "is not a URL"); }
    }
    config.expertReview = {
      model: parseRoute(entry.model, "expertReview.model"),
      ...(level ? { thinking: level as ExpertReviewConfig["thinking"] } : {}),
      requireOAuth: bool(entry.requireOAuth, "expertReview.requireOAuth", true),
      ...(entry.api !== undefined ? { api: text(entry.api, "expertReview.api") } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  if (raw.workerProfiles !== undefined) {
    config.workerProfiles = array(raw.workerProfiles, "workerProfiles").map((entry, index) => {
      const key = `workerProfiles[${index}]`;
      if (!object(entry)) return fail(key, "expected { id, model, thinking, autoChain, workerDefault, reviewerDefault, ensure }");
      const model = text(entry.model, `${key}.model`);
      if (!model.includes("/")) fail(`${key}.model`, "must use the exact provider/model form");
      const level = thinking(entry.thinking, `${key}.thinking`);
      return {
        id: text(entry.id, `${key}.id`), model,
        ...(level ? { thinking: level } : {}),
        ...(entry.workerDefault !== undefined ? { workerDefault: selectorOf(entry.workerDefault, `${key}.workerDefault`) } : {}),
        ...(entry.reviewerDefault !== undefined ? { reviewerDefault: selectorOf(entry.reviewerDefault, `${key}.reviewerDefault`) } : {}),
        ...(bool(entry.autoChain, `${key}.autoChain`, false) ? { autoChain: true } : {}),
        ...(bool(entry.autoReviewChain, `${key}.autoReviewChain`, false) ? { autoReviewChain: true } : {}),
        ...(entry.ensure !== undefined ? { ensure: parseEnsure(entry.ensure, `${key}.ensure`) } : {}),
      };
    });
  }
  if (raw.taskClasses !== undefined) config.taskClasses = parseTaskClasses(raw.taskClasses);
  if (raw.taskClassRules !== undefined) config.taskClassRules = parseTaskClassRules(raw.taskClassRules, config.taskClasses);
  if (raw.retiredModelPatterns !== undefined) {
    config.retiredModelPatterns = array(raw.retiredModelPatterns, "retiredModelPatterns").map((entry, index) => {
      const key = `retiredModelPatterns[${index}]`;
      if (typeof entry === "string") return { pattern: regex(entry, key), message: "{route} is retired by the operator; no fallback was selected.", selectorsOnly: false };
      if (!object(entry)) return fail(key, "expected a regex string or { pattern, message, selectorsOnly }");
      return {
        pattern: regex(entry.pattern, `${key}.pattern`),
        message: optionalText(entry.message, `${key}.message`, 1024) ?? "{route} is retired by the operator; no fallback was selected.",
        selectorsOnly: bool(entry.selectorsOnly, `${key}.selectorsOnly`, false),
      };
    });
  }
  if (raw.retiredProfiles !== undefined) {
    config.retiredProfiles = array(raw.retiredProfiles, "retiredProfiles").map((entry, index) => text(entry, `retiredProfiles[${index}]`));
  }
  if (raw.catalogExtras !== undefined) {
    config.catalogExtras = array(raw.catalogExtras, "catalogExtras").map((entry, index) => {
      const key = `catalogExtras[${index}]`;
      if (!object(entry)) return fail(key, "expected { provider, models: [...] }");
      const provider = text(entry.provider, `${key}.provider`);
      const models = array(entry.models, `${key}.models`).map((model, at) => {
        const field = `${key}.models[${at}]`;
        if (!object(model)) return fail(field, "expected Pi model metadata");
        text(model.id, `${field}.id`);
        text(model.api, `${field}.api`);
        text(model.baseUrl, `${field}.baseUrl`, 2048);
        if (!Array.isArray(model.input) || !model.input.every((kind) => kind === "text" || kind === "image")) fail(`${field}.input`, "expected [\"text\"] or [\"text\", \"image\"]");
        return { ...model, provider, name: typeof model.name === "string" ? model.name : model.id };
      });
      return { provider, models };
    });
  }
  if (raw.providerQuotaFallback !== undefined) {
    config.providerQuotaFallback = array(raw.providerQuotaFallback, "providerQuotaFallback").map((entry, index) => {
      const key = `providerQuotaFallback[${index}]`;
      if (!object(entry)) return fail(key, "expected { quota, provider, models, metered, label }");
      return {
        quota: text(entry.quota, `${key}.quota`), provider: text(entry.provider, `${key}.provider`),
        ...(entry.models !== undefined ? { models: array(entry.models, `${key}.models`).map((id, at) => text(id, `${key}.models[${at}]`)) } : {}),
        metered: bool(entry.metered, `${key}.metered`, true),
        ...(entry.label !== undefined ? { label: text(entry.label, `${key}.label`) } : {}),
        ...(entry.accountRouter !== undefined ? { accountRouter: bool(entry.accountRouter, `${key}.accountRouter`, false) } : {}),
        ...(entry.baseUrl !== undefined ? { baseUrl: text(entry.baseUrl, `${key}.baseUrl`, 2048) } : {}),
      };
    });
  }
  if (raw.hiddenModelPatterns !== undefined) {
    config.hiddenModelPatterns = array(raw.hiddenModelPatterns, "hiddenModelPatterns").map((entry, index) => {
      const key = `hiddenModelPatterns[${index}]`;
      if (!object(entry)) return fail(key, "expected { provider, pattern }");
      return { provider: text(entry.provider, `${key}.provider`), pattern: regex(entry.pattern, `${key}.pattern`, "") };
    });
  }
  if (raw.temporaryFreeExclusions !== undefined) {
    config.temporaryFreeExclusions = array(raw.temporaryFreeExclusions, "temporaryFreeExclusions").map((entry, index) => {
      const key = `temporaryFreeExclusions[${index}]`;
      if (!object(entry)) return fail(key, "expected { provider, pattern }");
      return { provider: text(entry.provider, `${key}.provider`), pattern: regex(entry.pattern, `${key}.pattern`) };
    });
  }
  if (raw.subscriptionRouteChecks !== undefined) {
    config.subscriptionRouteChecks = array(raw.subscriptionRouteChecks, "subscriptionRouteChecks").map((entry, index) => {
      const key = `subscriptionRouteChecks[${index}]`;
      if (!object(entry)) return fail(key, "expected { provider, host, pathPattern, oauth, exact, modelPattern, api, excludeIdPattern }");
      return {
        provider: text(entry.provider, `${key}.provider`), host: text(entry.host, `${key}.host`).toLowerCase(),
        ...(entry.pathPattern !== undefined ? { pathPattern: regex(entry.pathPattern, `${key}.pathPattern`, "") } : {}),
        oauth: bool(entry.oauth, `${key}.oauth`, false),
        exact: bool(entry.exact, `${key}.exact`, false),
        ...(entry.modelPattern !== undefined ? { modelPattern: regex(entry.modelPattern, `${key}.modelPattern`) } : {}),
        ...(entry.api !== undefined ? { api: text(entry.api, `${key}.api`) } : {}),
        ...(entry.excludeIdPattern !== undefined ? { excludeIdPattern: regex(entry.excludeIdPattern, `${key}.excludeIdPattern`) } : {}),
      };
    });
  }
  if (raw.subscriptionFirstProvider !== undefined) config.subscriptionFirstProvider = text(raw.subscriptionFirstProvider, "subscriptionFirstProvider");
  if (raw.claudeFallbackTier !== undefined) {
    const entry = raw.claudeFallbackTier;
    if (!object(entry)) return fail("claudeFallbackTier", "expected { ordinary, substantial }");
    config.claudeFallbackTier = { ordinary: text(entry.ordinary, "claudeFallbackTier.ordinary"), substantial: text(entry.substantial, "claudeFallbackTier.substantial") };
  }
  if (raw.claudeCodeDefaults !== undefined) {
    const entry = raw.claudeCodeDefaults;
    if (!object(entry)) return fail("claudeCodeDefaults", "expected { worker, reviewer }");
    config.claudeCodeDefaults = {
      ...(entry.worker !== undefined ? { worker: text(entry.worker, "claudeCodeDefaults.worker") } : {}),
      ...(entry.reviewer !== undefined ? { reviewer: text(entry.reviewer, "claudeCodeDefaults.reviewer") } : {}),
    };
  }
  if (raw.implicitReview !== undefined) {
    const entry = raw.implicitReview;
    if (!object(entry)) return fail("implicitReview", "expected { route, fallback }");
    const fallback = entry.fallback === undefined ? undefined : routeKey(parseRoute(entry.fallback, "implicitReview.fallback"));
    config.implicitReview = { route: text(entry.route, "implicitReview.route"), ...(fallback ? { fallback } : {}) };
  }
  if (raw.verificationGates !== undefined) {
    config.verificationGates = array(raw.verificationGates, "verificationGates").map((entry, index) => {
      const key = `verificationGates[${index}]`;
      if (!object(entry)) return fail(key, "expected { match, reviewer, fallback }");
      return {
        match: regex(entry.match, `${key}.match`), reviewer: text(entry.reviewer, `${key}.reviewer`),
        ...(entry.fallback !== undefined ? { fallback: text(entry.fallback, `${key}.fallback`) } : {}),
      };
    });
  }
  if (raw.routeLabels !== undefined) {
    if (!object(raw.routeLabels)) return fail("routeLabels", "expected { \"provider/model\": \"label\" }");
    config.routeLabels = Object.fromEntries(Object.entries(raw.routeLabels).map(([route, label]) => [route, text(label, `routeLabels.${route}`)]));
  }
  return config;
}

type CacheEntry = { path: string; signature: string; config?: RoutingConfig; error?: RoutingConfigError };
let cache: CacheEntry | undefined;
let override: RoutingConfig | undefined;

const signatureOf = (path: string): string | undefined => {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    return "unreadable";
  }
};

/**
 * The operator routing configuration. Missing file => `{}`. A malformed file
 * throws {@link RoutingConfigError} naming the key, so a routing decision fails
 * closed with a clear message instead of guessing.
 */
export function routingConfig(path = routingConfigPath()): RoutingConfig {
  if (override && path === routingConfigPath()) return override;
  const signature = signatureOf(path);
  if (signature === undefined) return {};
  if (cache?.path === path && cache.signature === signature && signature !== "unreadable") {
    if (cache.error) throw cache.error;
    return cache.config!;
  }
  let entry: CacheEntry;
  try {
    entry = { path, signature, config: parseRoutingConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    entry = { path, signature, error: error instanceof RoutingConfigError ? error : new RoutingConfigError(`${ROUTING_CONFIG_LABEL} cannot be read or parsed`) };
  }
  cache = entry;
  if (entry.error) throw entry.error;
  return entry.config!;
}

/** For display and catalog paths that must never throw (pickers, startup): a malformed file reads as empty. */
export function routingConfigOrEmpty(path?: string): RoutingConfig {
  try { return routingConfig(path); } catch { return {}; }
}

/** Test seam: replace the operator file with an in-memory routing.json object (undefined restores file reads). */
export function setRoutingConfigOverride(config: Record<string, unknown> | undefined): void {
  override = config === undefined ? undefined : parseRoutingConfig(config);
  cache = undefined;
}

/** Operator-chosen display label for a route, falling back to the route itself. */
export function routeLabel(step: RouteStep): string {
  return routingConfigOrEmpty().routeLabels?.[routeKey(step)] ?? routeKey(step);
}

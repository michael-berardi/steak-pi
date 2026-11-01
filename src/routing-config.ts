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
import { join } from "node:path";

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

/** Clear "nothing configured" message naming the exact key an operator sets. */
export const missingConfigKey = (what: string, key: string): string =>
  `No ${what} configured: set ${key} in ${ROUTING_CONFIG_LABEL}.`;

export interface RouteStep { provider: string; id: string }
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
export interface ConfiguredWorkerProfile {
  id: string;
  model: string;
  thinking?: Thinking;
  workerDefault?: RouteSelector;
  reviewerDefault?: RouteSelector;
  autoChain?: boolean;
  autoReviewChain?: boolean;
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
}
export interface HiddenModelPattern { provider: string; pattern: RegExp }
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
  retiredModelPatterns?: readonly RetiredModelPattern[];
  retiredProfiles?: readonly string[];
  catalogExtras?: readonly CatalogExtra[];
  providerQuotaFallback?: readonly QuotaTierConfig[];
  hiddenModelPatterns?: readonly HiddenModelPattern[];
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

/** `provider/model` (split at the first slash, so a model id may contain slashes). */
export function parseRoute(value: unknown, key = "route"): RouteStep {
  const route = text(value, key);
  const slash = route.indexOf("/");
  if (slash < 1 || slash === route.length - 1) return fail(key, `${JSON.stringify(route)} must use the exact provider/model form`);
  return { provider: route.slice(0, slash), id: route.slice(slash + 1) };
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

/** Validate one parsed routing.json object. Unknown keys are ignored (other tools share the file). */
export function parseRoutingConfig(raw: unknown): RoutingConfig {
  if (!object(raw)) return fail("(file)", "expected a JSON object");
  const config: { -readonly [K in keyof RoutingConfig]: RoutingConfig[K] } = {};
  if (raw.workerDefault !== undefined) config.workerDefault = selectorOf(raw.workerDefault, "workerDefault");
  if (raw.reviewerDefault !== undefined) config.reviewerDefault = selectorOf(raw.reviewerDefault, "reviewerDefault");
  if (raw.textWorkerChain !== undefined) config.textWorkerChain = routes(raw.textWorkerChain, "textWorkerChain");
  if (raw.multimodalWorkerChain !== undefined) config.multimodalWorkerChain = routes(raw.multimodalWorkerChain, "multimodalWorkerChain");
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
      if (!object(entry)) return fail(key, "expected { id, model, thinking, autoChain, workerDefault, reviewerDefault }");
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
      };
    });
  }
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

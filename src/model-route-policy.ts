import type { TaskClassDecision } from "./subagents/types.ts";
import { withCatalogExtras } from "./catalog-extras.ts";
import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { activeTemporaryWorkerRoute, ensureTemporaryFreeMetadata, FREE_PROVIDER, assertTemporaryFreeRequest, isTemporaryFreeModel, preferredFreeMetadata, selectPreferredFreePhysical, temporaryFreeOptions, withTemporaryFreeCatalog, TemporaryFreeRouteRequestError } from "./temporary-free-route.ts";
import { createAllowlistApproval, findPaidRoute } from "./explicit-paid-route.ts";
import { curatedPickerScope } from "./harness-profiles.ts";
import { curatedPickerModels, sharedPickerModels } from "./model-visibility.ts";
import { eligibleGoFallback, withOpenCodeGoRouting } from "./opencode-go-routing.ts";
import { assertActiveModelIdentity, isRetiredModelSelector } from "./retired-model-selection.ts";
import { missingConfigKey, routingConfig, routingConfigOrEmpty, RoutingConfigError, type ExpertReviewConfig, type SubscriptionRouteCheck } from "./routing-config.ts";
import type { QuotaSnapshot } from "./subagents/provider-quota.ts";
import { authHeadersMatch, gatedMeteredStream, isSubscriptionOrLocalRoute, matchesSubscriptionCheck, subscriptionRouteChecks, SUBSCRIPTION_FIRST_ERROR } from "./subscription-first-routing.ts";

type Registry = ExtensionContext["modelRegistry"];
type Model = NonNullable<ExtensionContext["model"]>;
type Provider = NonNullable<ReturnType<Registry["getProvider"]>>;
type GuardRegistry = Pick<Registry, "getAll" | "getProvider" | "getRegisteredNativeProvider" | "isUsingOAuth"> & {
  registerProvider(provider: Provider): void;
  getProviderAuth?: Registry["getProviderAuth"];
  hasConfiguredAuth?: Registry["hasConfiguredAuth"];
};
const GUARD_MARKER = Symbol.for("steak-pi.model-route-policy.v4-explicit-paid");
type PaidApproval = (model: Model) => boolean;
type NativeStream = ReturnType<Provider["streamSimple"]>;
type GuardMark = { root: Provider; approval?: PaidApproval; chain?: ChainFallbackOptions };
const guardMark = (provider: Provider) => (provider as unknown as Record<symbol, unknown>)[GUARD_MARKER] as GuardMark | undefined;

/** Registry surface an ordered chain needs; Pi's ModelRegistry and ModelRuntime both satisfy it.
 * `getAll()` is the published dispatch catalog and is deliberately *not* the curated
 * picker snapshot: a fallback route (for example a later chain step) must stay reachable
 * even when the operator's harness manifest does not offer it as a separate choice. */
export interface ChainRegistry {
  find(provider: string, id: string): Model | undefined;
  getAvailable(): Model[];
  getAll?(): Model[];
  hasConfiguredAuth(model: Model): boolean;
  isUsingOAuth(model: Model): boolean;
  getProvider(id: string): Provider | undefined;
}

/**
 * Pre-output runtime hop inside one ordered automatic chain. The wrapper replays
 * the identical request only while nothing has been emitted or executed, only for
 * a failure class that can plausibly succeed elsewhere (never auth, permission,
 * region or context), and only on a route that is itself authenticated and either
 * subscription/local or covered by the operator's exact allowlist grant. Every
 * forwarded event keeps the real answering provider/model, so usage and
 * transcripts name the route that actually served the request.
 */
export interface ChainFallbackOptions {
  chain: readonly WorkerRouteStep[];
  requireImages?: boolean;
  approvePaidRoute?: PaidApproval;
  registry: ChainRegistry;
  /** `cause` is the error text of the route that was left, bounded by the caller. */
  onFallback?: (from: WorkerRouteStep, to: Model, cause?: string) => void;
}

/** Caller-facing half of {@link ChainFallbackOptions}; the runtime supplies the registry. */
export type ChainFallbackInput = Omit<ChainFallbackOptions, "registry">;

/**
 * Failure class that may leave a chain step for the *next* step. It is the class the
 * subscription transport already retries (`eligibleGoFallback`) plus one deliberate
 * addition: a proven exhausted subscription plan. Same-plan retry deliberately refuses
 * that signal (retrying an exhausted plan on the same plan cannot succeed), while the
 * ordered chain may leave the plan for the next route — and that route still has to be
 * authenticated and either subscription/local or a separately approved reviewed paid
 * route, never generic PAYG. Auth, permission, region, context and 400-class failures
 * never hop, whatever transient wording they carry.
 */
/** A metered gateway's own pre-output refusals that another route can serve: spent credits (402 "Insufficient
 * credits" / "requires more credits") and a request no provider endpoint can serve ("No endpoints found" / "0
 * endpoints out of N requested are available"). Checked after the hard auth/abort class and before the generic
 * 404 refusal, so the endpoint answer hops while a plain 404 stays put. */
export const ROUTE_UNAVAILABLE_WORDING = /\b402\b|insufficient[_ ]credits|requires more credits|no endpoints? (?:found|available)|endpoints? out of \d+ requested are available/i;
/** @deprecated Former name of {@link ROUTE_UNAVAILABLE_WORDING}. */
export const OPENROUTER_ROUTE_UNAVAILABLE = ROUTE_UNAVAILABLE_WORDING;
export function eligibleChainFallback(message: string): boolean {
  // Auth, permission, region, context and 400-class failures never hop, whatever transient wording they carry.
  if (/abort|cancel|auth|permission|region|context|invalid|\b(?:400|401|403)\b/i.test(message)) return false;
  if (ROUTE_UNAVAILABLE_WORDING.test(message)) return true;
  if (/\b404\b/i.test(message)) return false;
  return eligibleGoFallback(message) || /subscription_quota_exceeded|GoUsageLimitError|usage limit|quota[_ -]?(?:exhausted|exceeded|reached)/i.test(message);
}
export const PINNED_ROUTE_ERROR = "This model family is pinned to its configured subscription route (subscriptionRouteChecks modelPattern in ~/.config/ultraterm/routing.json); other routes, API keys and excluded transports are not permitted.";
/** @deprecated Former name of {@link PINNED_ROUTE_ERROR}. */
export const GPT_ROUTE_ERROR = PINNED_ROUTE_ERROR;

/** The operator's pinned-family checks whose `modelPattern` names this model (id or display name). */
export function pinnedRouteChecks(model: { id: string; name?: string }, strict = false): SubscriptionRouteCheck[] {
  const subject = `${model.id} ${model.name ?? ""}`;
  // Dispatch-time checks read strictly: a malformed routing.json must not silently unpin a family.
  const checks = strict ? routingConfig().subscriptionRouteChecks ?? [] : subscriptionRouteChecks();
  return checks.filter((check) => check.modelPattern?.test(subject) === true);
}
/** True when an operator check pins this model family to one exact subscription route. */
export function isPinnedFamily(model: { id: string; name?: string }): boolean {
  return pinnedRouteChecks(model).length > 0;
}

/** Catalog filtering must not allocate exceptions for routinely excluded models. */
export function isModelRouteAllowed(model: { id: string; name?: string; provider: string }): boolean {
  if (isRetiredModelSelector(model.id) || isRetiredModelSelector(model.name)) return false;
  const pinned = pinnedRouteChecks(model);
  return pinned.length === 0 || pinned.some((check) => model.provider === check.provider &&
    !check.excludeIdPattern?.test(model.id) && (!model.id.includes("/") || model.id.startsWith(`${check.provider}/`)));
}

/** Validate resolved identity, never infer a provider from a friendly model name. */
export function assertModelRoute(model: { id: string; name?: string; provider: string }): void {
  assertActiveModelIdentity(model);
  if (!isModelRouteAllowed(model)) throw new Error(PINNED_ROUTE_ERROR);
}

export function assertSubscriptionRequest(model: Model, usingOAuth: boolean): void {
  assertModelRoute(model);
  const pinned = pinnedRouteChecks(model, true);
  if (pinned.length === 0) return;
  const served = pinned.some((check) => (!check.oauth || usingOAuth) && (!check.api || model.api === check.api) &&
    matchesSubscriptionCheck({ ...check, exact: true }, model));
  if (!served) throw new Error(PINNED_ROUTE_ERROR);
}

/** Supported native-provider composition; exceptions here stop dispatch, unlike event hooks. */
export function guardProvider(provider: Provider, usingOAuth: () => boolean,
  getGoKey: (() => Promise<string | undefined>) | undefined = async () => {
    throw new Error(`${SUBSCRIPTION_FIRST_ERROR} Provider authentication introspection is unavailable.`);
  }, original?: Provider,
  getProviderAuth?: GuardRegistry["getProviderAuth"], approval?: PaidApproval,
  chain?: ChainFallbackOptions): Provider {
  // Rebind policy closures without nesting an earlier guard/Go retry wrapper.
  const previous = guardMark(provider);
  if (previous) provider = previous.root;
  const root = original ?? provider;
  provider = withCatalogExtras(withOpenCodeGoRouting(provider));
  const check = (model: Model) => {
    assertActiveModelIdentity(model);
    if (model.provider !== provider.id) throw new Error(PINNED_ROUTE_ERROR);
    assertSubscriptionRequest(model, !isPinnedFamily(model) || usingOAuth());
    if (isTemporaryFreeModel(model)) assertTemporaryFreeRequest(model, undefined, undefined, false);
  };
  // Registries without authentication introspection cannot gate metered routes.
  const metering: (() => Promise<string | undefined>) | undefined =
    typeof getGoKey === "function" ? getGoKey : undefined;
  const requestOAuth = async (model: Model, options: Pick<NonNullable<Parameters<Provider["streamSimple"]>[2]>, "apiKey" | "headers"> | undefined): Promise<boolean> => {
    let oauth = usingOAuth();
    if (oauth) {
      if (getProviderAuth) {
        let auth: Awaited<ReturnType<NonNullable<GuardRegistry["getProviderAuth"]>>>;
        try { auth = await getProviderAuth(model.provider); }
        catch { throw new Error(SUBSCRIPTION_FIRST_ERROR); }
        oauth = auth?.source === "OAuth" &&
          (options?.apiKey === auth.auth.apiKey) &&
          authHeadersMatch(auth.auth.apiKey, model.headers, options?.headers);
      } else {
        // Legacy/test registries cannot prove an explicit credential override.
        oauth = options?.apiKey === undefined && authHeadersMatch(undefined, model.headers, options?.headers);
      }
    }
    assertSubscriptionRequest(model, oauth);
    return oauth;
  };
  const guarded: Provider = {
    ...provider,
    // Pi's composer uses the base catalog to decide whether to call this
    // provider or bypass it through a global API implementation. Preserve real
    // API coverage here; filter availability below, never dispatch coverage.
    getModels: () => provider.getModels(),
    ...(provider.refreshModels ? { refreshModels: provider.refreshModels.bind(provider) } : {}),
    filterModels(models, credential) {
      const filtered = provider.filterModels ? provider.filterModels(models, credential) : models;
      // This snapshot is the choice source native `/model` renders and the one
      // the machine-UI catalog publishes, so both picker rules live here once,
      // never in a second model list: the curated harness-manifest scope and the
      // operator's hidden routes. Dispatch coverage stays intact
      // because getModels() is untouched above.
      return curatedPickerModels(sharedPickerModels(filtered.filter(isModelRouteAllowed)), curatedPickerScope());
    },
    stream(model, context, options) {
      check(model);
      if (isTemporaryFreeModel(model)) return gatedMeteredStream(model, async () => {
        await ensureTemporaryFreeMetadata(model.id); assertTemporaryFreeRequest(model); return false;
      }, async () => undefined, () => provider.stream(model, context, temporaryFreeOptions(model, options)), options?.signal, () => true);
      const inner = metering && !isSubscriptionOrLocalRoute(model, false)
        ? gatedMeteredStream(model, () => requestOAuth(model, options), metering, () => provider.stream(model, context, options), options?.signal, () => approval?.(model) === true)
        : provider.stream(model, context, options);
      return chain ? withPreOutputChainFallback(inner as unknown as NativeStream, model, options?.signal, chain,
        (target) => chainRouteStream(chain, target, options, (provider, target) => provider.stream(target, context, options))) : inner;
    },
    streamSimple(model, context, options) {
      check(model);
      if (isTemporaryFreeModel(model)) return gatedMeteredStream(model, async () => {
        await ensureTemporaryFreeMetadata(model.id); assertTemporaryFreeRequest(model); return false;
      }, async () => undefined, () => provider.streamSimple(model, context, temporaryFreeOptions(model, options)), options?.signal, () => true);
      const inner = metering && !isSubscriptionOrLocalRoute(model, false)
        ? gatedMeteredStream(model, () => requestOAuth(model, options), metering, () => provider.streamSimple(model, context, options), options?.signal, () => approval?.(model) === true)
        : provider.streamSimple(model, context, options);
      return chain ? withPreOutputChainFallback(inner, model, options?.signal, chain,
        (target) => chainRouteStream(chain, target, options, (provider, target) => provider.streamSimple(target, context, options))) : inner;
    },
    ...(provider.fetchDeferred ? { fetchDeferred: ((model, handle, options) => {
      check(model);
      if (isTemporaryFreeModel(model)) throw new TemporaryFreeRouteRequestError("Temporary free route denied: deferred requests are unsupported.");
      if (metering && !isSubscriptionOrLocalRoute(model, false)) {
        return gatedMeteredStream(model, () => requestOAuth(model, options), metering, () => provider.fetchDeferred!(model, handle, options), options?.signal, () => approval?.(model) === true);
      }
      return provider.fetchDeferred!(model, handle, options);
    }) as NonNullable<Provider["fetchDeferred"]> } : {}),
    ...(provider.cancelDeferred ? { cancelDeferred: (async (model, handle, options) => {
      check(model);
      if (isTemporaryFreeModel(model)) throw new TemporaryFreeRouteRequestError("Temporary free route denied: deferred requests are unsupported.");
      return provider.cancelDeferred!(model, handle, options);
    }) as NonNullable<Provider["cancelDeferred"]> } : {}),
  };
  Object.defineProperty(guarded, GUARD_MARKER, { value: { root, approval, chain } satisfies GuardMark });
  return guarded;
}

/** Re-check registration provenance after reload/model changes without stacking wrappers. */
export function createRegistryGuard(approval?: PaidApproval, chain?: ChainFallbackOptions): (registry: GuardRegistry, active?: Pick<Model, "provider">) => void {
  const installed = new WeakSet<Provider>();
  return (registry, active) => {
    // One catalog pass rather than filtering every model once per provider on
    // every worker turn. Preserve the API coverage gate on configuration reload.
    const apisByProvider = new Map<string, Set<Model["api"]>>();
    for (const model of registry.getAll()) {
      let apis = apisByProvider.get(model.provider);
      if (!apis) {
        apisByProvider.set(model.provider, apis = new Set());
      }
      apis.add(model.api);
    }
    // Every catalog provider is guarded, as in 0.8.0. The 0.7.0 "dispatch-capable
    // providers only" filter is not merged: Pi resolves file-backed credentials
    // after this first install, so it left providers unwrapped, which skipped the
    // curated picker filter (filterModels below) and would leave pre-output chain
    // targets without the metering check. `active` is accepted for 0.7.0 callers.
    void active;
    if (apisByProvider.has(FREE_PROVIDER)) {
      // Augment the registered native root, not a recomposed config overlay;
      // otherwise every controlled turn can wrap yesterday's guard again.
      const provider = registry.getRegisteredNativeProvider(FREE_PROVIDER) ?? registry.getProvider(FREE_PROVIDER);
      if (provider) {
        const augmented = withTemporaryFreeCatalog(provider);
        if (augmented !== provider) registry.registerProvider(augmented);
      }
    }
    for (const [id, apis] of apisByProvider) {
      const native = registry.getRegisteredNativeProvider(id);
      const mark = native && guardMark(native);
      if (native && (installed.has(native) || mark)) {
        const covered = new Set(native.getModels().map(model => model.api));
        if (mark?.approval === approval && mark?.chain === chain && [...apis].every(api => covered.has(api))) continue;
        // Recompose from the original unguarded provider when a new API appears.
        // Skipping this lets the SDK bypass native guards through its global API;
        // wrapping the guarded composition instead stacks same-provider retries.
        if (mark) registry.registerProvider(mark.root);
      }
      const provider = registry.getProvider(id);
      if (!provider) continue;
      // The operator's subscription-first plan (`subscriptionFirstProvider`): while its key is
      // configured and not proven exhausted, metered routes stay denied. None configured, no veto.
      const getGoKey = registry.getProviderAuth ? async () => {
        const first = routingConfig().subscriptionFirstProvider;
        if (!first) return undefined;
        const auth = await registry.getProviderAuth!(first);
        const key = auth?.auth.apiKey;
        if (!key && (auth || registry.hasConfiguredAuth?.({ provider: first } as Model))) {
          throw new Error(SUBSCRIPTION_FIRST_ERROR);
        }
        return key;
      } : undefined;
      const guarded = guardProvider(provider, () => registry.isUsingOAuth({ provider: id } as Model), getGoKey, mark?.root, registry.getProviderAuth?.bind(registry), approval, chain);
      registry.registerProvider(guarded);
      installed.add(guarded);
    }
  };
}

/** Reapply after configuration refresh and at each controlled worker turn. The
 * optional chain installs the same pre-output hop inside an isolated child runtime;
 * `active` names the run's own provider so it is guarded even before its
 * credentials resolve (only dispatch-capable providers are guarded). */
export function guardModelRuntime(runtime: ModelRuntime, fallback?: ChainFallbackInput, active?: Pick<Model, "provider">): void {
  // SDK virtual routing runs at each model call, not just the next user turn.
  // Optional only for legacy/test SDK facades: preferred-free admission fails
  // without its virtual catalog entry, never impersonating a physical route.
  if (active?.provider === "steak-pi" || runtime.getModel("steak-pi", "preferred-free") || activeTemporaryWorkerRoute()) {
    runtime.registerVirtualModel?.({ ...preferredFreeMetadata, route: () => selectPreferredFreePhysical({
      find: (provider, id) => runtime.getModel(provider, id),
      hasConfiguredAuth: model => runtime.hasConfiguredAuth(model.provider),
      isUsingOAuth: model => runtime.isUsingOAuth(model.provider),
    }) });
  }
  const approval = fallback?.approvePaidRoute;
  const chain: ChainFallbackOptions | undefined = fallback && {
    ...fallback,
    registry: {
      find: (provider, id) => runtime.getModel(provider, id),
      getAvailable: () => [...runtime.getAvailableSnapshot()],
      getAll: () => [...runtime.getModels()],
      hasConfiguredAuth: (model) => runtime.hasConfiguredAuth(model.provider),
      isUsingOAuth: (model) => runtime.isUsingOAuth(model.provider),
      getProvider: (id) => runtime.getProvider(id),
    },
  };
  createRegistryGuard(approval, chain)({
    getAll: () => [...runtime.getModels()],
    getProvider: (id) => runtime.getProvider(id),
    getRegisteredNativeProvider: (id) => runtime.getRegisteredNativeProvider(id),
    registerProvider: (provider) => runtime.registerNativeProvider(provider),
    isUsingOAuth: (model) => runtime.isUsingOAuth(model.provider),
    hasConfiguredAuth: (model) => runtime.hasConfiguredAuth(model.provider),
    getProviderAuth: (id) => runtime.getAuth(id),
  }, active);
}

/** The operator's expert reviewer (`expertReview.thinking`, default medium) runs at its own
 * effort independently of the parent's current effort. Escalation is explicit and needs a
 * concrete task benefit, not role alone. */
export function selectWorkerThinking(
  model: Pick<Model, "id">,
  inherited: ExtensionContext["thinkingLevel"],
  requested?: "medium" | "high" | "xhigh",
  reason?: string,
): NonNullable<ExtensionContext["thinkingLevel"]> {
  if (requested !== undefined && !["medium", "high", "xhigh"].includes(requested)) {
    throw new Error("Worker thinking must be medium, high, or xhigh.");
  }
  if ((requested === "high" || requested === "xhigh") && (!reason || reason.trim().length < 16)) {
    throw new Error("High/xhigh worker thinking needs a concrete task benefit in thinkingReason.");
  }
  const expert = expertReviewConfig();
  const isExpert = expert !== undefined && (model.id === expert.model.id || model.id === `${expert.model.provider}/${expert.model.id}`);
  return requested ?? (isExpert ? expert.thinking ?? "medium" : inherited ?? "off");
}

export interface OnlyWhenCondition {
  /** The router provider whose accounts are examined. */
  provider: string;
  /** The step is eligible only while EVERY configured account of `provider` is short. */
  everyAccount: {
    /** "Short" when an account has under this percent of its window left (usedPercent > 100 - remainingBelow). */
    remainingBelow: number;
    /** "Short" when an account's usedPercent is more than this many points ahead of the elapsed share of its seven_day window. */
    behindPaceAbove: number;
  };
}
export interface WorkerRouteStep { provider: string; id: string; onlyWhen?: OnlyWhenCondition }

/** The operator's automatic text worker chain (`textWorkerChain`); empty when none is configured. */
export const textWorkerChain = (): readonly WorkerRouteStep[] => routingConfig().textWorkerChain ?? [];
/** The operator's automatic image worker chain (`multimodalWorkerChain`); empty when none is configured. */
export const multimodalWorkerChain = (): readonly WorkerRouteStep[] => routingConfig().multimodalWorkerChain ?? [];
export const defaultWorkerChain = (requireImages: boolean): readonly WorkerRouteStep[] =>
  requireImages ? multimodalWorkerChain() : textWorkerChain();
/** The configured base chain, or a clear error naming the key an operator sets. */
function requiredWorkerChain(requireImages: boolean): readonly WorkerRouteStep[] {
  const chain = defaultWorkerChain(requireImages);
  if (chain.length === 0) {
    throw new RoutingConfigError(requireImages
      ? missingConfigKey("multimodal worker chain", "multimodalWorkerChain")
      : missingConfigKey("text worker chain", "textWorkerChain"));
  }
  return chain;
}
const sameStep = (a: WorkerRouteStep, b: WorkerRouteStep) => a.provider === b.provider && a.id === b.id;
/** An automatic profile whose head is one of the operator's `tokenPlanChainHeads` keeps
 * its own chain (`[head, ...then]`, or `[head, ...multimodalThen]` for images); every
 * other automatic profile resolves the configured default chain. */
export function workerChainFor(head: WorkerRouteStep | undefined, requireImages: boolean): readonly WorkerRouteStep[] {
  const own = head && routingConfig().tokenPlanChainHeads?.find((entry) => sameStep(entry.head, head));
  const base = defaultWorkerChain(requireImages);
  if (!own || (base.length > 0 && sameStep(base[0], own.head))) return requiredWorkerChain(requireImages);
  return [own.head, ...(requireImages ? own.multimodalThen : own.then)];
}
/** Rebuild a run's recorded chain (`selection.chainRoutes`) only when it is exactly a
 * chain this policy can produce; anything else falls back to the default chain, and
 * to no chain at all when the operator no longer configures one. */
export function recordedWorkerChain(routes: readonly string[] | undefined, requireImages: boolean): readonly WorkerRouteStep[] {
  let base: readonly WorkerRouteStep[];
  try { base = defaultWorkerChain(requireImages); } catch { return []; }
  if (!routes?.length) return base;
  const head = routes[0].split("/");
  if (head.length !== 2) return base;
  let candidate: readonly WorkerRouteStep[];
  try { candidate = workerChainFor({ provider: head[0], id: head[1] }, requireImages); } catch { return base; }
  const matches = candidate.length === routes.length
    && candidate.every((step, index) => `${step.provider}/${step.id}` === routes[index]);
  return matches ? candidate : base;
}
export const noChainRouteError = (multimodal: boolean) =>
  `No authenticated route in the default ${multimodal ? "multimodal" : "text"} worker chain; no fallback was selected.`;

/** Typed "no step of the chain resolved" result. It carries the steps actually examined, so a
 * caller (the dispatch boundary's Claude subscription tier) decides from evidence about *which*
 * chain failed rather than from message equality, and records only routes really tried. */
export class NoChainRouteError extends Error {
  readonly multimodal: boolean;
  readonly tried: readonly WorkerRouteStep[];
  constructor(multimodal: boolean, tried: readonly WorkerRouteStep[]) {
    super(noChainRouteError(multimodal));
    this.name = "NoChainRouteError";
    this.multimodal = multimodal;
    // Preserve the configured step (including a generic `onlyWhen` condition) so a caller's
    // dispatch note can name why a skipped step was not eligible, not just its route.
    this.tried = tried.map((step) => ({ ...step }));
  }
}

/** True when `error` is exactly "the configured default text chain resolved nowhere" and
 * nothing else. A profile-default or reviewer chain with its own head is a different chain. */
export function isDefaultTextChainExhausted(error: unknown): error is NoChainRouteError {
  if (!(error instanceof NoChainRouteError) || error.multimodal) return false;
  const chain = routingConfigOrEmpty().textWorkerChain ?? [];
  return chain.length > 0 && error.tried.length === chain.length &&
    error.tried.every((step, index) => sameStep(step, chain[index]));
}

/** The operator's scarce expert reviewer (`expertReview`): hard planning and debugging plus
 * review/validation, never routine implementation, so it is deliberately absent from the
 * routine worker chains. Eligibility (below) requires the configured exact identity (OAuth,
 * API and endpoint when set), so a batch id, API-key endpoint, or other metered substitute
 * never enters. When the expert route is unavailable the run honestly resolves the routine
 * chain instead, and an expert review that fails at runtime fails visibly — it is never
 * silently downgraded to a weaker model. None is configured by default. */
export const expertReviewConfig = (): ExpertReviewConfig | undefined => routingConfigOrEmpty().expertReview;
export const expertReviewModel = (): WorkerRouteStep | undefined => expertReviewConfig()?.model;
/** The expert first, then the default worker chain in its own order. */
export const expertReviewChain = (requireImages: boolean): readonly WorkerRouteStep[] => {
  const expert = expertReviewModel();
  const base = defaultWorkerChain(requireImages);
  return expert ? [expert, ...base] : base;
};
export const isExpertReviewModel = (model: Pick<Model, "provider" | "id">): boolean => {
  const expert = expertReviewModel();
  return expert !== undefined && model.provider === expert.provider && model.id === expert.id;
};

/** One step of a task class's chain, resolved against the worker profiles in scope. */
export interface TaskClassStep {
  /** The chain entry exactly as the operator wrote it (a profile id or a `provider/model` route). */
  entry: string;
  step: WorkerRouteStep;
  /** The worker profile the entry named; its thinking and `ensure` apply to the run. */
  profile?: string;
  /** Set when the step can never launch (for example a retired route): the named cause. */
  blocked?: string;
}
/** A configured task class, ready to be walked before the default chain. */
export interface TaskClassWalk {
  name: string;
  steps: readonly TaskClassStep[];
  requiresTestGate: boolean;
  note?: string;
  /** Ranks the steps that passed every launch check (in chain order) on the class's evidence. Absent: chain order.
   * It names no route itself: the entries are the operator's chain entries. */
  rank?: (candidates: ReadonlyArray<{ entry: string; route: string }>) => TaskClassRanking;
}
/** What a class ranker returns: the failover order of the routes it kept, why it chose, and who it held out. */
export interface TaskClassRanking {
  order: readonly string[];
  decision: TaskClassDecision;
  excluded: ReadonlyArray<{ entry: string; cause: string }>;
}

export type ChainOptions = {
  requireImages?: boolean;
  /** The configured class that steers this implicit text wave: its chain is walked first, with the same
   * launch, quota, paid-route and `onlyWhen` checks as the default chain, and the default route follows. */
  taskClass?: TaskClassWalk;
  approvePaidRoute?: (model: Model) => boolean;
  /** Dispatch-time quota veto: a step whose provider the account router has proven
   * exhausted is skipped, so selection never lands on a route that cannot launch. A
   * skipped step is still part of the chain that was tried (see {@link NoChainRouteError}). */
  skipRoute?: (step: WorkerRouteStep) => boolean;
  /** Resolve the configured default text chain (`textWorkerChain`) instead of a profile default or
   * the legacy parent route. Only an implicit dispatch that must leave an exhausted
   * provider sets it; an explicit selector never does. */
  forceDefaultChain?: boolean;
  /** Quota snapshot used to evaluate `onlyWhen` conditions on route steps. */
  quotaSnapshot?: QuotaSnapshot;
};

/** The user allowlist is the only spending grant for automatic chain routing: a
 * reviewed paid step is reachable without inheriting a launch profile's paid
 * flag, and it is re-read on every call so revocation takes effect immediately. */
export const AUTOMATIC_CHAIN_APPROVAL: PaidApproval = createAllowlistApproval();

/** Exact, authenticated, capability-matching, spendable chain route. */
function eligibleChainRoute(registry: ChainRegistry, step: WorkerRouteStep, requireImages: boolean, approve: PaidApproval): Model | undefined {
  const model = registry.find(step.provider, step.id);
  // Exact route identity only: a fake/collapsed registry must not satisfy a step.
  if (!model || model.provider !== step.provider || model.id !== step.id) return undefined;
  const capable = requireImages ? model.input?.includes("image") === true : model.input?.includes("text") === true;
  if (!capable) return undefined;
  if (typeof registry.getProvider(model.provider)?.streamSimple !== "function") return undefined;
  if (!registry.hasConfiguredAuth(model)) return undefined;
  // The expert keeps its configured exact identity. Localhost is normally a permitted
  // no-spend route, but a local model labelled with the expert's route
  // must not impersonate the expert or inherit any paid-route approval.
  const expert = expertReviewConfig();
  if (expert && isExpertReviewModel(model)) {
    let base: URL;
    try { base = new URL(model.baseUrl); } catch { return undefined; }
    if (expert.requireOAuth && !registry.isUsingOAuth(model)) return undefined;
    if (expert.api && model.api !== expert.api) return undefined;
    if (expert.baseUrl) {
      const want = new URL(expert.baseUrl);
      if (base.origin !== want.origin || base.pathname.replace(/\/$/, "") !== want.pathname.replace(/\/$/, "") ||
          base.search || base.hash) return undefined;
    }
  }
  // Membership is checked against the published dispatch catalog, never the
  // curated picker snapshot: an ordered chain step may be reachable without
  // being a separate picker choice.
  const catalog = registry.getAll?.() ?? registry.getAvailable();
  if (!catalog.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) return undefined;
  if (!isSubscriptionOrLocalRoute(model, registry.isUsingOAuth(model))) {
    if (!findPaidRoute(model) || !approve(model)) return undefined;
  }
  return model;
}

/** First eligible route strictly after `from`; undefined fails closed. Chain order is
 * monotonic, so one request can never re-attempt a route it already used. */
export function nextChainRoute(registry: ChainRegistry, chain: readonly WorkerRouteStep[], from: WorkerRouteStep,
  options: ChainOptions = {}): Model | undefined {
  const start = chain.findIndex((step) => step.provider === from.provider && step.id === from.id);
  if (start < 0) return undefined;
  const approve = options.approvePaidRoute ?? AUTOMATIC_CHAIN_APPROVAL;
  for (const step of chain.slice(start + 1)) {
    const model = eligibleChainRoute(registry, step, options.requireImages === true, approve);
    if (model) return model;
  }
  return undefined;
}

/** Hop through the live registry so the registry's own guarded provider enforces the
 * metering gate and approval on the fallback request as well. */
function chainRouteStream(chain: ChainFallbackOptions, target: Model, options: { signal?: AbortSignal } | undefined,
  invoke: (provider: Provider, target: Model) => NativeStream): NativeStream | undefined {
  const targetProvider = chain.registry.getProvider(target.provider);
  if (!targetProvider || typeof targetProvider.streamSimple !== "function") return undefined;
  return invoke(targetProvider, target);
}

/**
 * Pre-output-only hop to the next authenticated route of one ordered chain. It fires
 * only when the attempt failed before any content/tool event with a class
 * {@link eligibleChainFallback} accepts (transient transport plus a proven exhausted
 * subscription plan), so nothing observed or executed is ever replayed. Each
 * forwarded event keeps the real answering provider/model, and the wrapper never
 * revisits a route. This is the runtime half of the automatic chain, not a selection
 * shortcut: a route absent from the registry is skipped at selection instead.
 */
export function withPreOutputChainFallback(
  first: NativeStream,
  from: Model,
  signal: AbortSignal | undefined,
  fallback: ChainFallbackOptions,
  invoke: (model: Model) => NativeStream | undefined,
): NativeStream {
  const Stream = first.constructor as new () => NativeStream;
  const output = new Stream();
  void (async () => {
    let terminal = false;
    try {
      let source = first;
      let current: WorkerRouteStep = { provider: from.provider, id: from.id };
      const attempted = new Set([`${from.provider}/${from.id}`]);
      for (;;) {
        let hop: { model: Model; stream: NativeStream; cause: string } | undefined;
        let emitted = false;
        for await (const event of source) {
          // A start event is only metadata; content/tool starts permanently end fallback.
          if (event.type !== "start" && event.type !== "error") emitted = true;
          if (event.type === "error" && !emitted && !signal?.aborted && event.error.stopReason !== "aborted" &&
              eligibleChainFallback(event.error.errorMessage ?? "")) {
            // Trust the error's own identity: a same-provider retry inside a provider
            // wrapper must not make the chain hop back to the route that just failed.
            const failed: WorkerRouteStep = { provider: event.error.provider ?? current.provider, id: event.error.model ?? current.id };
            attempted.add(`${failed.provider}/${failed.id}`);
            const candidate = nextChainRoute(fallback.registry, fallback.chain, failed,
              { requireImages: fallback.requireImages, approvePaidRoute: fallback.approvePaidRoute });
            const stream = candidate && !attempted.has(`${candidate.provider}/${candidate.id}`) ? invoke(candidate) : undefined;
            if (candidate && stream) {
              hop = { model: candidate, stream, cause: event.error.errorMessage ?? "" };
              continue;
            }
          }
          output.push(event);
          if (event.type === "done" || event.type === "error") terminal = true;
        }
        if (!hop) break;
        fallback.onFallback?.(current, hop.model, hop.cause);
        attempted.add(`${hop.model.provider}/${hop.model.id}`);
        current = { provider: hop.model.provider, id: hop.model.id };
        source = hop.stream;
      }
      if (!terminal) throw new Error("Provider stream ended without a terminal event.");
    } catch (error) {
      if (!terminal) {
        const reason = signal?.aborted ? "aborted" as const : "error" as const;
        output.push({ type: "error", reason, error: {
          role: "assistant" as const, content: [], api: from.api, provider: from.provider, model: from.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: reason, errorMessage: error instanceof Error ? error.message : "Chain fallback failed.", timestamp: Date.now(),
        } });
      }
    }
    output.end();
  })();
  return output;
}

/** True when the account's usedPercent is more than `behindPaceAbove` points ahead of the elapsed
 * share of its seven_day window. Reads the window's own resetAt (or the account's top-level resetAt);
 * a stale or missing window is NOT "behind pace". */
/** The router names the weekly window `seven_day` (its own usage probe) or `7d` (the statusline's shared snapshot). */
const WEEKLY_WINDOW_NAMES = new Set(["seven_day", "7d"]);
type WindowRow = { usedPercent?: number; resetAt?: number; windows?: ReadonlyArray<{ name?: string; usedPercent?: number; resetAt?: number }> };
function weeklyWindow(row: WindowRow) {
  return row.windows?.find((w) => typeof w.name === "string" && WEEKLY_WINDOW_NAMES.has(w.name));
}
/** An account's weekly used share. The top-level usedPercent is the router's most-limiting window, which can be the
 * five-hour one: a lent plan at 83% of its five hours but 34% of its week is not short (2026-11-02: that misread sent work to
 * a paid route while the plan had most of its week left). */
function weeklyUsedPercent(row: WindowRow): number | undefined {
  const weekly = weeklyWindow(row);
  if (weekly) return weekly.usedPercent;
  return row.windows && row.windows.length > 0 ? undefined : row.usedPercent;
}

function isBehindPace(row: WindowRow, behindPaceAbove: number, nowSeconds: number = Date.now() / 1000): boolean {
  const sevenDay = weeklyWindow(row);
  const resetAt = sevenDay?.resetAt ?? row.resetAt;
  const usedPercent = sevenDay?.usedPercent ?? row.usedPercent;
  if (resetAt === undefined || usedPercent === undefined) return false;
  if (resetAt <= nowSeconds) return false; // stale window: NOT short
  const weekSeconds = 7 * 24 * 60 * 60;
  const elapsedSeconds = weekSeconds - (resetAt - nowSeconds);
  const elapsedPercent = (elapsedSeconds / weekSeconds) * 100;
  return usedPercent - elapsedPercent > behindPaceAbove;
}

/** The named reason a step's `onlyWhen` condition is not met, or undefined when the step is
 * eligible. Semantics per the operator's 11:20 requirement: the step is eligible only while
 * EVERY configured account of the named router provider is out, has under `remainingBelow`
 * percent left, or is more than `behindPaceAbove` points behind its weekly pace. Unknown or
 * stale usage is NOT short. The reason text is what the dispatch note names when the step is
 * skipped. */
export function onlyWhenSkipReason(condition: OnlyWhenCondition, options: ChainOptions): string | undefined {
  const snapshot = options.quotaSnapshot;
  const subject = `${condition.provider} accounts`;
  if (!snapshot || !snapshot.known) return `${subject}: router usage is unknown (unknown usage is not short)`;
  const provider = snapshot.providers[condition.provider];
  if (!provider || provider.unconfigured) return `${subject}: not configured in the router`;
  if (provider.rows.length === 0) return `${subject}: no usage rows in the router`;
  const short = provider.rows.every((row) => {
    // An account the router marked ineligible (signed out) cannot serve, so it is "out" too.
    if (row.eligible === false) return true;
    if (row.exhausted === true) return true;
    const weeklyUsed = weeklyUsedPercent(row);
    if (weeklyUsed !== undefined && weeklyUsed > 100 - condition.everyAccount.remainingBelow) return true;
    if (isBehindPace(row, condition.everyAccount.behindPaceAbove)) return true;
    return false;
  });
  if (short) return undefined;
  return `${subject}: not every account is short (each needs to be out, under ${condition.everyAccount.remainingBelow}% left, or more than ${condition.everyAccount.behindPaceAbove} points behind its weekly pace)`;
}

function evaluateOnlyWhen(condition: OnlyWhenCondition, options: ChainOptions): boolean {
  return onlyWhenSkipReason(condition, options) === undefined;
}

/** One authenticated chain route or a fail-closed error. Reviewed paid
 * steps need the operator's exact allowlist grant (re-read per selection); an
 * unreviewed metered endpoint never enters an automatic chain. */
export function selectChainedWorkerModel(registry: Registry, chain: readonly WorkerRouteStep[], options: ChainOptions = {}): Model {
  const approve = options.approvePaidRoute ?? AUTOMATIC_CHAIN_APPROVAL;
  for (const step of chain) {
    if (step.onlyWhen && !evaluateOnlyWhen(step.onlyWhen, options)) continue;
    if (options.skipRoute?.(step)) continue;
    const model = eligibleChainRoute(registry, step, options.requireImages === true, approve);
    if (model) return model;
  }
  throw new NoChainRouteError(options.requireImages === true, chain);
}

/** Runs retain one explicit model for accurate telemetry; mixed/review runs stay frontier.
 * The reviewer role prefers the operator's expert (`expertReview`) when its authenticated
 * route is eligible; any metered substitute is skipped and the prior exact behavior applies
 * (reviewers of a mapped-parent default never reach this legacy path at all — they resolve
 * the expert review chain). */
export function selectWorkerModel(parent: Model, roles: readonly (string | undefined)[], registry: Registry,
  options: ChainOptions = {}): Model {
  assertModelRoute(parent);
  const expert = expertReviewModel();
  if (expert && roles.some((role) => role === "reviewer")) {
    const eligible = eligibleChainRoute(registry, expert, options.requireImages === true,
      options.approvePaidRoute ?? AUTOMATIC_CHAIN_APPROVAL);
    if (eligible) return eligible;
  }
  if (!isPinnedFamily(parent)) return parent;
  assertSubscriptionRequest(parent, registry.isUsingOAuth(parent));
  // Legacy unmapped-profile fallback: reviewers inherit the operator's own parent
  // route and nothing else is auto-selected there (no paid hop beyond the expert
  // preference above). Defaulted runs resolve the capability-aware chain through
  // reviewerDefault.
  if (roles.some((role) => role === "reviewer")) return parent;
  return selectChainedWorkerModel(registry, requiredWorkerChain(options.requireImages === true), options);
}

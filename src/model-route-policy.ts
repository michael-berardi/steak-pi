import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAllowlistApproval, findPaidRoute } from "./explicit-paid-route.ts";
import { curatedPickerScope } from "./harness-profiles.ts";
import { curatedPickerModels, sharedPickerModels } from "./model-visibility.ts";
import { eligibleGoFallback, withOpenCodeGoRouting } from "./opencode-go-routing.ts";
import { authHeadersMatch, gatedMeteredStream, isSubscriptionOrLocalRoute, SUBSCRIPTION_FIRST_ERROR } from "./subscription-first-routing.ts";

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
 * picker snapshot: a fallback route (for example the Go GLM step) must stay reachable
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
  onFallback?: (from: WorkerRouteStep, to: Model) => void;
}

/** Caller-facing half of {@link ChainFallbackOptions}; the runtime supplies the registry. */
export type ChainFallbackInput = Omit<ChainFallbackOptions, "registry">;

/**
 * Failure class that may leave a chain step for the *next* step. It is the class Go
 * already retries (`eligibleGoFallback`) plus one deliberate addition: a proven
 * exhausted Go subscription plan. Same-plan retry deliberately refuses that signal
 * (retrying an exhausted plan on the same plan cannot succeed), while the ordered
 * chain may leave the plan for the next route — and that route still has to be an
 * authenticated, separately approved reviewed subscription (Singapore Token Plan),
 * never generic PAYG. Auth, permission, region, context and 400-class failures
 * never hop, whatever transient wording they carry.
 */
export function eligibleChainFallback(message: string): boolean {
  if (/abort|cancel|auth|permission|region|context|invalid|\b(?:400|401|403|404)\b/i.test(message)) return false;
  return eligibleGoFallback(message) || /subscription_quota_exceeded|quota[_ -]?(?:exhausted|exceeded|reached)/i.test(message);
}
/** Never auto-selected: the operator scope removed automatic Luna workers/reviewers. */
export const ROUTINE_GPT_MODEL = "gpt-5.6-luna";
export const GPT_ROUTE_ERROR = "GPT-family models require the paid openai-codex subscription route, non-batch. OpenRouter and API-key routes are not permitted.";

export function isGptFamily(model: { id: string; name?: string }): boolean {
  return /(?:^|[^a-z0-9])(?:chat)?gpt(?:[^a-z]|$)/i.test(`${model.id} ${model.name ?? ""}`);
}

/** Catalog filtering must not allocate exceptions for routinely excluded models. */
export function isModelRouteAllowed(model: { id: string; name?: string; provider: string }): boolean {
  return !isGptFamily(model) || (model.provider === "openai-codex" && !/batch/i.test(model.id) &&
    (!model.id.includes("/") || model.id.startsWith("openai-codex/")));
}

/** Validate resolved identity, never infer a provider from a friendly model name. */
export function assertModelRoute(model: { id: string; name?: string; provider: string }): void {
  if (!isModelRouteAllowed(model)) throw new Error(GPT_ROUTE_ERROR);
}

export function assertSubscriptionRequest(model: Model, usingOAuth: boolean): void {
  assertModelRoute(model);
  if (!isGptFamily(model)) return;
  let url: URL;
  try { url = new URL(model.baseUrl); } catch { throw new Error(GPT_ROUTE_ERROR); }
  if (!usingOAuth || model.api !== "openai-codex-responses" || url.protocol !== "https:" ||
      url.hostname !== "chatgpt.com" || url.port || url.username || url.password ||
      !/^\/backend-api(?:\/codex)?\/?$/.test(url.pathname) || url.search || url.hash) {
    throw new Error(GPT_ROUTE_ERROR);
  }
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
  provider = withOpenCodeGoRouting(provider);
  const check = (model: Model) => {
    if (model.provider !== provider.id) throw new Error(GPT_ROUTE_ERROR);
    assertSubscriptionRequest(model, !isGptFamily(model) || usingOAuth());
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
      // removed OpenRouter DeepSeek Flash routes. Dispatch coverage stays intact
      // because getModels() is untouched above.
      return curatedPickerModels(sharedPickerModels(filtered.filter(isModelRouteAllowed)), curatedPickerScope());
    },
    stream(model, context, options) {
      check(model);
      const inner = metering && !isSubscriptionOrLocalRoute(model, false)
        ? gatedMeteredStream(model, () => requestOAuth(model, options), metering, () => provider.stream(model, context, options), options?.signal, () => approval?.(model) === true)
        : provider.stream(model, context, options);
      return chain ? withPreOutputChainFallback(inner as unknown as NativeStream, model, options?.signal, chain,
        (target) => chainRouteStream(chain, target, options, (provider, target) => provider.stream(target, context, options))) : inner;
    },
    streamSimple(model, context, options) {
      check(model);
      const inner = metering && !isSubscriptionOrLocalRoute(model, false)
        ? gatedMeteredStream(model, () => requestOAuth(model, options), metering, () => provider.streamSimple(model, context, options), options?.signal, () => approval?.(model) === true)
        : provider.streamSimple(model, context, options);
      return chain ? withPreOutputChainFallback(inner, model, options?.signal, chain,
        (target) => chainRouteStream(chain, target, options, (provider, target) => provider.streamSimple(target, context, options))) : inner;
    },
    ...(provider.fetchDeferred ? { fetchDeferred: ((model, handle, options) => {
      check(model);
      if (metering && !isSubscriptionOrLocalRoute(model, false)) {
        return gatedMeteredStream(model, () => requestOAuth(model, options), metering, () => provider.fetchDeferred!(model, handle, options), options?.signal, () => approval?.(model) === true);
      }
      return provider.fetchDeferred!(model, handle, options);
    }) as NonNullable<Provider["fetchDeferred"]> } : {}),
    ...(provider.cancelDeferred ? { cancelDeferred: (async (model, handle, options) => {
      check(model);
      return provider.cancelDeferred!(model, handle, options);
    }) as NonNullable<Provider["cancelDeferred"]> } : {}),
  };
  Object.defineProperty(guarded, GUARD_MARKER, { value: { root, approval, chain } satisfies GuardMark });
  return guarded;
}

/** Re-check registration provenance after reload/model changes without stacking wrappers. */
export function createRegistryGuard(approval?: PaidApproval, chain?: ChainFallbackOptions): (registry: GuardRegistry) => void {
  const installed = new WeakSet<Provider>();
  return (registry) => {
    // One catalog pass rather than filtering every model once per provider on
    // every worker turn. Preserve the API coverage gate on configuration reload.
    const apisByProvider = new Map<string, Set<Model["api"]>>();
    for (const model of registry.getAll()) {
      let apis = apisByProvider.get(model.provider);
      if (!apis) apisByProvider.set(model.provider, apis = new Set());
      apis.add(model.api);
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
      const getGoKey = registry.getProviderAuth ? async () => {
        const auth = await registry.getProviderAuth!("opencode-go");
        const key = auth?.auth.apiKey;
        if (!key && (auth || registry.hasConfiguredAuth?.({ provider: "opencode-go" } as Model))) {
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
 * optional chain installs the same pre-output hop inside an isolated child runtime. */
export function guardModelRuntime(runtime: ModelRuntime, fallback?: ChainFallbackInput): void {
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
  });
}

/** Astra defaults to medium independently of the parent's current effort.
 * Escalation is explicit and needs a concrete task benefit, not role alone. */
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
  return requested ?? (/(?:^|\/)gpt-6-astra$/i.test(model.id) ? "medium" : inherited ?? "off");
}

export interface WorkerRouteStep { provider: string; id: string }

/** FINAL automatic worker routing (operator scope, 2026-09-23). One unified text and
 * image chain, ordered selection priority plus one pre-output runtime hop inside the
 * same order: the first authenticated route serves the run, and a before-output
 * transient failure may hop to the next eligible route. The hop stops permanently at
 * the first content/tool event and each event keeps its real provider/model. The
 * default route is MiMo V2.6 Pro on the reviewed Singapore Token Plan endpoint, so it
 * is a prepaid subscription rather than a metered API route; the only automatic fallback is the
 * ZAI coding subscription route. No Go, Inco, OpenRouter or metered PAYG step is
 * reachable automatically, and GPT-5.6 Luna is deliberately absent. */
export const DEFAULT_TEXT_WORKER_CHAIN: readonly WorkerRouteStep[] = [
  { provider: "xiaomi", id: "mimo-v2.6-pro" },
  { provider: "zai", id: "glm-5.3-flash" },
];
/** The image chain is the same two routes: MiMo V2.6 Pro is multimodal and the ZAI
 * coding route advertises image input, so text and image runs share one order. */
export const DEFAULT_MULTIMODAL_WORKER_CHAIN: readonly WorkerRouteStep[] = [
  { provider: "xiaomi", id: "mimo-v2.6-pro" },
  { provider: "zai", id: "glm-5.3-flash" },
];
export const noChainRouteError = (multimodal: boolean) =>
  `No authenticated route in the default ${multimodal ? "multimodal" : "text"} worker chain; no fallback was selected.`;

/** Astra (openai-codex/gpt-6-astra) is the scarce expert reviewer: hard planning and
 * debugging plus review/validation. It is never routine implementation or
 * orchestration, so it is deliberately absent from the routine worker chains above.
 * The default reviewer role prefers it through the paid Codex OAuth coding plan only:
 * eligibility below requires the exact subscription identity (OAuth, Codex API,
 * official chatgpt.com backend), so a batch id, API-key endpoint, or other metered
 * substitute never enters. When the expert route is unavailable the run honestly
 * resolves the routine subscription chain instead, and an expert review that fails
 * at runtime fails visibly — it is never silently downgraded to a weaker model. */
export const EXPERT_REVIEW_MODEL: WorkerRouteStep = { provider: "openai-codex", id: "gpt-6-astra" };
export const EXPERT_TEXT_REVIEW_CHAIN: readonly WorkerRouteStep[] = [
  EXPERT_REVIEW_MODEL, ...DEFAULT_TEXT_WORKER_CHAIN,
];
export const EXPERT_MULTIMODAL_REVIEW_CHAIN: readonly WorkerRouteStep[] = [
  EXPERT_REVIEW_MODEL, ...DEFAULT_MULTIMODAL_WORKER_CHAIN,
];
export const expertReviewChain = (requireImages: boolean): readonly WorkerRouteStep[] =>
  requireImages ? EXPERT_MULTIMODAL_REVIEW_CHAIN : EXPERT_TEXT_REVIEW_CHAIN;
export const isExpertReviewModel = (model: Pick<Model, "provider" | "id">): boolean =>
  model.provider === EXPERT_REVIEW_MODEL.provider && model.id === EXPERT_REVIEW_MODEL.id;

export type ChainOptions = { requireImages?: boolean; approvePaidRoute?: (model: Model) => boolean };

/** The user allowlist is the only spending grant for automatic chain routing: a
 * reviewed Token Plan step is reachable without inheriting a launch profile's paid
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
  // Expert reviews are Codex OAuth only. Localhost is normally a permitted
  // no-spend route, but a local model labelled "openai-codex/gpt-6-astra"
  // must not impersonate the expert or inherit any paid-route approval.
  if (isExpertReviewModel(model)) {
    let base: URL;
    try { base = new URL(model.baseUrl); } catch { return undefined; }
    if (!registry.isUsingOAuth(model) || model.api !== "openai-codex-responses" ||
        base.origin !== "https://chatgpt.com" || base.pathname.replace(/\/$/, "") !== "/backend-api" ||
        base.search || base.hash) return undefined;
  }
  // Membership is checked against the published dispatch catalog, never the
  // curated picker snapshot: an ordered chain step may be reachable without
  // being a separate picker choice (the Go fallback is the operator's example).
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
        let hop: { model: Model; stream: NativeStream } | undefined;
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
              hop = { model: candidate, stream };
              continue;
            }
          }
          output.push(event);
          if (event.type === "done" || event.type === "error") terminal = true;
        }
        if (!hop) break;
        fallback.onFallback?.(current, hop.model);
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

/** One authenticated chain route or a fail-closed error. Reviewed paid/Token Plan
 * steps need the operator's exact allowlist grant (re-read per selection); an
 * unreviewed metered endpoint never enters an automatic chain. */
export function selectChainedWorkerModel(registry: Registry, chain: readonly WorkerRouteStep[], options: ChainOptions = {}): Model {
  const approve = options.approvePaidRoute ?? AUTOMATIC_CHAIN_APPROVAL;
  for (const step of chain) {
    const model = eligibleChainRoute(registry, step, options.requireImages === true, approve);
    if (model) return model;
  }
  throw new Error(noChainRouteError(options.requireImages === true));
}

/** Runs retain one explicit model for accurate telemetry; mixed/review runs stay frontier.
 * The default reviewer role prefers the scarce Astra expert when its authenticated
 * paid Codex OAuth route is available; any metered substitute is skipped and the
 * prior exact behavior applies (reviewers of a mapped-parent default never reach
 * this legacy path at all — they resolve the expert review chain). */
export function selectWorkerModel(parent: Model, roles: readonly (string | undefined)[], registry: Registry,
  options: ChainOptions = {}): Model {
  assertModelRoute(parent);
  if (roles.some((role) => role === "reviewer")) {
    const expert = eligibleChainRoute(registry, EXPERT_REVIEW_MODEL, options.requireImages === true,
      options.approvePaidRoute ?? AUTOMATIC_CHAIN_APPROVAL);
    if (expert) return expert;
  }
  if (!isGptFamily(parent)) return parent;
  assertSubscriptionRequest(parent, registry.isUsingOAuth(parent));
  // Legacy unmapped-profile fallback: reviewers inherit the operator's own parent
  // route and nothing else is auto-selected there (no implicit Luna, no paid GPT
  // hop beyond the expert preference above). Defaulted runs resolve the
  // capability-aware chain through reviewerDefault.
  if (roles.some((role) => role === "reviewer")) return parent;
  return selectChainedWorkerModel(registry,
    options.requireImages === true ? DEFAULT_MULTIMODAL_WORKER_CHAIN : DEFAULT_TEXT_WORKER_CHAIN, options);
}

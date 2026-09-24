import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { withOpenCodeGoRouting } from "./opencode-go-routing.ts";
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
type GuardMark = { root: Provider; approval?: PaidApproval };
const guardMark = (provider: Provider) => (provider as unknown as Record<symbol, unknown>)[GUARD_MARKER] as GuardMark | undefined;
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
  getGoKey: () => Promise<string | undefined> = async () => {
    throw new Error(`${SUBSCRIPTION_FIRST_ERROR} Provider authentication introspection is unavailable.`);
  }, original?: Provider,
  getProviderAuth?: GuardRegistry["getProviderAuth"], approval?: PaidApproval): Provider {
  // Rebind policy closures without nesting an earlier guard/Go retry wrapper.
  const previous = guardMark(provider);
  if (previous) provider = previous.root;
  const root = original ?? provider;
  provider = withOpenCodeGoRouting(provider);
  const check = (model: Model) => {
    if (model.provider !== provider.id) throw new Error(GPT_ROUTE_ERROR);
    assertSubscriptionRequest(model, !isGptFamily(model) || usingOAuth());
  };
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
      return filtered.filter(isModelRouteAllowed);
    },
    stream(model, context, options) {
      check(model);
      if (getGoKey && !isSubscriptionOrLocalRoute(model, false)) {
        return gatedMeteredStream(model, () => requestOAuth(model, options), getGoKey, () => provider.stream(model, context, options), options?.signal, () => approval?.(model) === true);
      }
      return provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      check(model);
      if (getGoKey && !isSubscriptionOrLocalRoute(model, false)) {
        return gatedMeteredStream(model, () => requestOAuth(model, options), getGoKey, () => provider.streamSimple(model, context, options), options?.signal, () => approval?.(model) === true);
      }
      return provider.streamSimple(model, context, options);
    },
    ...(provider.fetchDeferred ? { fetchDeferred: ((model, handle, options) => {
      check(model);
      if (getGoKey && !isSubscriptionOrLocalRoute(model, false)) {
        return gatedMeteredStream(model, () => requestOAuth(model, options), getGoKey, () => provider.fetchDeferred!(model, handle, options), options?.signal, () => approval?.(model) === true);
      }
      return provider.fetchDeferred!(model, handle, options);
    }) as NonNullable<Provider["fetchDeferred"]> } : {}),
    ...(provider.cancelDeferred ? { cancelDeferred: (async (model, handle, options) => {
      check(model);
      return provider.cancelDeferred!(model, handle, options);
    }) as NonNullable<Provider["cancelDeferred"]> } : {}),
  };
  Object.defineProperty(guarded, GUARD_MARKER, { value: { root, approval } satisfies GuardMark });
  return guarded;
}

/** Re-check registration provenance after reload/model changes without stacking wrappers. */
export function createRegistryGuard(approval?: PaidApproval): (registry: GuardRegistry, active?: Pick<Model, "provider">) => void {
  const installed = new WeakSet<Provider>();
  return (registry, active) => {
    // One catalog pass rather than filtering every model once per provider on
    // every worker turn. Preserve the API coverage gate on configuration reload.
    const apisByProvider = new Map<string, Set<Model["api"]>>();
    const sample = new Map<string, Model>();
    for (const model of registry.getAll()) {
      let apis = apisByProvider.get(model.provider);
      if (!apis) {
        apisByProvider.set(model.provider, apis = new Set());
        sample.set(model.provider, model);
      }
      apis.add(model.api);
    }
    // Only providers that can dispatch need a guard: those with configured
    // credentials, plus the active model's provider. Re-registering all ~40
    // catalog providers made Pi rebuild its model catalog once per provider,
    // costing ~0.2 s and 20-30 MB per session. Credentials added later are
    // picked up because this runs again on every prompt and model switch.
    const canDispatch = (id: string) => {
      if (id === active?.provider || !registry.hasConfiguredAuth) return true;
      // An auth lookup that cannot answer fails closed: guard the provider.
      try { return registry.hasConfiguredAuth(sample.get(id)!); } catch { return true; }
    };
    for (const [id, apis] of apisByProvider) {
      if (!canDispatch(id)) continue;
      const native = registry.getRegisteredNativeProvider(id);
      const mark = native && guardMark(native);
      if (native && (installed.has(native) || mark)) {
        const covered = new Set(native.getModels().map(model => model.api));
        if (mark?.approval === approval && [...apis].every(api => covered.has(api))) continue;
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
      const guarded = guardProvider(provider, () => registry.isUsingOAuth({ provider: id } as Model), getGoKey, mark?.root, registry.getProviderAuth?.bind(registry), approval);
      registry.registerProvider(guarded);
      installed.add(guarded);
    }
  };
}

/** Reapply after configuration refresh and at each controlled worker turn. */
export function guardModelRuntime(runtime: ModelRuntime, active?: Pick<Model, "provider">): void {
  createRegistryGuard()({
    getAll: () => [...runtime.getModels()],
    getProvider: (id) => runtime.getProvider(id),
    getRegisteredNativeProvider: (id) => runtime.getRegisteredNativeProvider(id),
    registerProvider: (provider) => runtime.registerNativeProvider(provider),
    isUsingOAuth: (model) => runtime.isUsingOAuth(model.provider),
    hasConfiguredAuth: (model) => runtime.hasConfiguredAuth(model.provider),
    getProviderAuth: (id) => runtime.getAuth(id),
  }, active);
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

/** Runs retain one explicit model for accurate telemetry; mixed/review runs stay frontier. */
export function selectWorkerModel(parent: Model, roles: readonly (string | undefined)[], registry: Registry): Model {
  assertModelRoute(parent);
  if (!isGptFamily(parent)) return parent;
  assertSubscriptionRequest(parent, registry.isUsingOAuth(parent));
  if (roles.some((role) => role === "reviewer")) return parent;
  const luna = registry.find("openai-codex", ROUTINE_GPT_MODEL);
  if (!luna || !registry.hasConfiguredAuth(luna)) {
    throw new Error(`Routine GPT work requires available paid openai-codex/${ROUTINE_GPT_MODEL}; no fallback was selected.`);
  }
  assertSubscriptionRequest(luna, registry.isUsingOAuth(luna));
  return luna;
}

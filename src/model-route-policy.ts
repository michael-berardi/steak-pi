import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";

type Registry = ExtensionContext["modelRegistry"];
type Model = NonNullable<ExtensionContext["model"]>;
type Provider = NonNullable<ReturnType<Registry["getProvider"]>>;
type GuardRegistry = Pick<Registry, "getAll" | "getProvider" | "getRegisteredNativeProvider" | "isUsingOAuth"> & {
  registerProvider(provider: Provider): void;
};
const GUARD_MARKER = Symbol.for("steak-pi.model-route-policy.v1");
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
export function guardProvider(provider: Provider, usingOAuth: () => boolean): Provider {
  const check = (model: Model) => {
    if (model.provider !== provider.id) throw new Error(GPT_ROUTE_ERROR);
    assertSubscriptionRequest(model, !isGptFamily(model) || usingOAuth());
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
      return provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      check(model);
      return provider.streamSimple(model, context, options);
    },
    ...(provider.fetchDeferred ? { fetchDeferred: ((model, handle, options) => {
      check(model);
      return provider.fetchDeferred!(model, handle, options);
    }) as NonNullable<Provider["fetchDeferred"]> } : {}),
    ...(provider.cancelDeferred ? { cancelDeferred: (async (model, handle, options) => {
      check(model);
      return provider.cancelDeferred!(model, handle, options);
    }) as NonNullable<Provider["cancelDeferred"]> } : {}),
  };
  Object.defineProperty(guarded, GUARD_MARKER, { value: true });
  return guarded;
}

/** Re-check registration provenance after reload/model changes without stacking wrappers. */
export function createRegistryGuard(): (registry: GuardRegistry) => void {
  const installed = new WeakSet<Provider>();
  return (registry) => {
    const models = registry.getAll();
    const ids = new Set(models.map((model) => model.provider));
    for (const id of ids) {
      const native = registry.getRegisteredNativeProvider(id);
      if (native && (installed.has(native) ||
          (native as unknown as Record<symbol, unknown>)[GUARD_MARKER] === true)) {
        // A models.json reload may introduce another API after registration.
        // Re-wrap the current composed provider before dispatch in that case.
        const apis = new Set(native.getModels().map((model) => model.api));
        if (models.every((model) => model.provider !== id || apis.has(model.api))) continue;
      }
      const provider = registry.getProvider(id);
      if (!provider) continue;
      const guarded = guardProvider(provider, () => registry.isUsingOAuth({ provider: id } as Model));
      registry.registerProvider(guarded);
      installed.add(guarded);
    }
  };
}

/** Reapply after configuration refresh and at each controlled worker turn. */
export function guardModelRuntime(runtime: ModelRuntime): void {
  createRegistryGuard()({
    getAll: () => [...runtime.getModels()],
    getProvider: (id) => runtime.getProvider(id),
    getRegisteredNativeProvider: (id) => runtime.getRegisteredNativeProvider(id),
    registerProvider: (provider) => runtime.registerNativeProvider(provider),
    isUsingOAuth: (model) => runtime.isUsingOAuth(model.provider),
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

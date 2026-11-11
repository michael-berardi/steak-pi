/**
 * The operator's opt-in interactive chain virtual model (`interactiveChainModel`
 * in routing.json). Absent key: nothing here registers or routes anything, and
 * interactive slots behave exactly as before.
 *
 * When configured, the extension registers ONE virtual model whose provider, id
 * and display name are the operator's own strings (Steak Pi ships none). Its
 * `route()` picks the first available step of the configured worker chain with
 * the same eligibility checks an implicit worker dispatch uses
 * (`selectChainedWorkerModel`: exact identity, capability, configured auth,
 * catalog membership, subscription/local or reviewed-and-allowed paid route,
 * `onlyWhen` quota conditions). The existing pre-output chain wrapper
 * (`guardModelRuntime` / `createRegistryGuard` with a chain) is installed beneath
 * the virtual selection by the extension, so quota, plan-limit and content-filter
 * refusals hop before any output exactly like workers — the mechanism the spec 01
 * probe proved (Pi's own `retry` routing alone misses plan-limit and
 * content-filter refusals).
 *
 * Explicit `/model` selections are never rerouted: the wrapper is installed only
 * while the selection is this virtual model, and a physical selection keeps the
 * chainless guard. Every forwarded event keeps the real answering provider/model,
 * so usage and cost stay attributed to the physical provider per assistant message.
 */
import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { eligibleChainFallback, nextChainRoute, selectChainedWorkerModel, type ChainFallbackOptions, type ChainRegistry, type WorkerRouteStep } from "./model-route-policy.ts";
import { routingConfigOrEmpty, type InteractiveChainModelConfig } from "./routing-config.ts";
import { readProviderQuota, type QuotaSnapshot } from "./subagents/provider-quota.ts";

type Model = NonNullable<ExtensionContext["model"]>;

/** Pi's catalog api id for virtual entries (`VIRTUAL_MODEL_API` in the SDK's virtual-models). */
export const VIRTUAL_MODEL_API = "pi-virtual";
/** The thinking levels the virtual selection offers; the routed physical model receives the level as chosen. */
export const INTERACTIVE_CHAIN_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
/** How long one router quota read serves interactive `onlyWhen` checks before the router is asked again. */
export const INTERACTIVE_QUOTA_TTL_MS = 60_000;

/** The operator's configured virtual model, or undefined when the key is absent (the shipped default). */
export const interactiveChainModelConfig = (): InteractiveChainModelConfig | undefined =>
  routingConfigOrEmpty().interactiveChainModel;

/** The chain the virtual model follows, re-read per decision so routing.json edits apply without a restart. */
export const interactiveChainSteps = (config = interactiveChainModelConfig()): readonly WorkerRouteStep[] =>
  config ? routingConfigOrEmpty()[config.chain ?? "textWorkerChain"] ?? [] : [];

/** True only for the configured virtual catalog entry, never for a physical model. */
export function isInteractiveChainModel(model: Pick<Model, "provider" | "id" | "api"> | undefined,
  config = interactiveChainModelConfig()): boolean {
  return !!model && !!config && model.api === VIRTUAL_MODEL_API &&
    model.provider === config.provider && model.id === config.id;
}

/** One cached router read shared by interactive selections; unknown is never exhaustion. */
let quotaCache: { at: number; snapshot: Promise<QuotaSnapshot> } | undefined;
const cachedQuotaSnapshot = (): Promise<QuotaSnapshot> => {
  const now = Date.now();
  if (!quotaCache || now - quotaCache.at > INTERACTIVE_QUOTA_TTL_MS) quotaCache = { at: now, snapshot: readProviderQuota() };
  return quotaCache.snapshot;
};

export interface InteractiveChainRouteOptions {
  registry: ChainRegistry;
  config?: InteractiveChainModelConfig;
  /** Quota seam for tests; the default asks the provider account router at most once per TTL. */
  quotaSnapshot?: () => Promise<QuotaSnapshot>;
  /** The same `from->to` hop receipt workers emit, for a hop taken by route() itself. */
  onHop?: (from: WorkerRouteStep, to: Model, cause?: string) => void;
}

/**
 * The virtual model's router. `continuation` keeps the physical model that last
 * answered; `retry` leaves the failed step for the next chain step only when
 * `eligibleChainFallback` accepts the error (otherwise the failed model is kept,
 * so Pi's own same-route retry semantics are unchanged); `user` and `direct`
 * return to the first available chain step, so a slot comes back to the preferred
 * route as soon as it can work.
 */
export function createInteractiveChainRoute(options: InteractiveChainRouteOptions):
(request: ModelRouteRequest) => Promise<ModelRoute> {
  return async (request) => {
    const config = options.config ?? interactiveChainModelConfig();
    const chain = interactiveChainSteps(config);
    const requireImages = config?.chain === "multimodalWorkerChain";
    if (request.reason === "continuation" && request.previous) {
      return { model: request.previous.model, thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel };
    }
    if (request.reason === "retry" && request.failed) {
      const failed = request.failed;
      const thinkingLevel = failed.thinkingLevel ?? request.thinkingLevel;
      const cause = failed.message.errorMessage ?? "";
      if (eligibleChainFallback(cause)) {
        const next = nextChainRoute(options.registry, chain, { provider: failed.model.provider, id: failed.model.id }, { requireImages });
        if (next && (next.provider !== failed.model.provider || next.id !== failed.model.id)) {
          options.onHop?.({ provider: failed.model.provider, id: failed.model.id }, next, cause);
          return { model: next, thinkingLevel };
        }
      }
      return { model: failed.model, thinkingLevel };
    }
    // A quota snapshot is only needed when a step carries an `onlyWhen` condition;
    // otherwise the router is never asked (unknown usage skips nothing, as for workers).
    const quotaSnapshot = chain.some((step) => step.onlyWhen)
      ? await (options.quotaSnapshot ?? cachedQuotaSnapshot)()
      : undefined;
    const model = selectChainedWorkerModel(options.registry, chain, { requireImages, quotaSnapshot });
    return { model, thinkingLevel: request.thinkingLevel };
  };
}

/**
 * Register the operator's virtual model on the extension API. Returns the config
 * when registered, undefined when the key is absent (nothing is registered then).
 * `onHop` receives the same `from->to` receipts the worker chain emits.
 */
export function registerInteractiveChainModel(pi: ExtensionAPI,
  onHop?: (from: WorkerRouteStep, to: Model, cause?: string) => void): InteractiveChainModelConfig | undefined {
  const config = interactiveChainModelConfig();
  if (!config) return undefined;
  pi.registerVirtualModel({
    provider: config.provider, id: config.id, name: config.name,
    thinkingLevels: [...INTERACTIVE_CHAIN_THINKING_LEVELS],
    route: (request, ctx) => createInteractiveChainRoute({ registry: ctx.modelRegistry, config, onHop })(request),
  });
  return config;
}

/**
 * The pre-output chain wrapper input for the CURRENT selection: defined only while
 * the selection is the configured virtual model, so an explicit physical selection
 * keeps today's chainless guard and is never rerouted. Spend approval is unchanged:
 * the caller's approval still gates every routed request through the provider guard.
 */
export function interactiveChainFallback(model: Pick<Model, "provider" | "id" | "api"> | undefined,
  registry: ChainRegistry, approvePaidRoute: ChainFallbackOptions["approvePaidRoute"],
  onFallback?: ChainFallbackOptions["onFallback"]): ChainFallbackOptions | undefined {
  const config = interactiveChainModelConfig();
  if (!isInteractiveChainModel(model, config)) return undefined;
  const chain = interactiveChainSteps(config);
  if (chain.length === 0) return undefined;
  return {
    chain, registry,
    requireImages: config!.chain === "multimodalWorkerChain",
    approvePaidRoute,
    ...(onFallback ? { onFallback } : {}),
  };
}
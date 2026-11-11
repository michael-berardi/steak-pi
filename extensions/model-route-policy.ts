import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertActiveModelIdentity } from "../src/retired-model-selection.ts";
import { createRegistryGuard, type ChainFallbackOptions, type WorkerRouteStep } from "../src/model-route-policy.ts";
import { interactiveChainFallback, registerInteractiveChainModel } from "../src/interactive-chain-model.ts";
import { temporaryRouteForRegistration, preferredFreeMetadata, selectPreferredFreePhysical, temporaryFreeStartupProvider } from "../src/temporary-free-route.ts";
import { createExplicitPaidApproval, createSelectedRouteApproval, isAllowlistedPaidRoute, PAID_ROUTE_FLAG } from "../src/explicit-paid-route.ts";
import { catalogStartupProviders } from "../src/catalog-extras.ts";
import { providerSessionCleanup } from "../src/provider-session-cleanup.ts";

type Model = NonNullable<ExtensionContext["model"]>;

/** Guard provider execution, including restored models, compaction, and model switching. */
export default function modelRoutePolicy(pi: ExtensionAPI): void {
  // Native provider registration happens before Pi resolves --model at startup.
  // Complete-provider augmentation preserves its built-in catalog and auth.
  pi.registerProvider(temporaryFreeStartupProvider());
  // Operator catalog extras (`catalogExtras` in routing.json); none are shipped.
  for (const provider of catalogStartupProviders()) pi.registerProvider(provider);
  const cleanupProviderSession = providerSessionCleanup();
  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason !== "reload") cleanupProviderSession(ctx.sessionManager.getSessionId());
  });
  if (temporaryRouteForRegistration()) {
    pi.registerVirtualModel({ ...preferredFreeMetadata, route: (_request, ctx) => selectPreferredFreePhysical(ctx.modelRegistry) });
  }
  pi.registerFlag(PAID_ROUTE_FLAG, { type: "string", description: "Exact paid profile selection; requires user paid-routes.json approval." });
  // Operator `/model` switching is no longer launch-locked: the exact paid route
  // currently selected in this runtime is authorized when the user allowlist
  // carries that same reviewed route. Another route, a provider prefix, or an
  // entry the user removed never authorizes the dispatched model. Launch flags
  // remain an additional grant for scripted launches.
  let selected: Model | undefined;
  let launch: ((model: Model) => boolean) | undefined;
  const selectedRoute = createSelectedRouteApproval(() => selected);
  // Any exact reviewed route the operator allowlisted may serve a request
  // (including a chain hop), not only the one selected at launch; removing the allowlist entry still revokes it.
  const approval = (model: Model) => launch?.(model) === true || selectedRoute(model) || isAllowlistedPaidRoute(model);
  // The operator's opt-in interactive chain virtual model (`interactiveChainModel` in
  // routing.json). Absent key: nothing is registered and every guard below stays chainless.
  let currentUi: ExtensionContext["ui"] | undefined;
  // The same `from->to` hop receipt workers emit, surfaced on the footer status band.
  const reportHop = (from: WorkerRouteStep, to: Model, _cause?: string) => {
    const hop = `model-fallback:${from.provider}/${from.id}->${to.provider}/${to.id}`;
    try {
      currentUi?.setStatus("steak-pi-route", hop);
      currentUi?.notify(hop, "info");
    } catch { /* UI may not be attached (headless modes). */ }
  };
  registerInteractiveChainModel(pi, reportHop);
  // One wrapper input per (registry, chain) so refresh events do not recompose providers
  // on every turn; a routing.json chain edit still applies on the next refresh.
  let chainMemo: { registry: ExtensionContext["modelRegistry"]; key: string; options: ChainFallbackOptions } | undefined;
  const chainFor = (model: Model | undefined, registry: ExtensionContext["modelRegistry"]): ChainFallbackOptions | undefined => {
    const options = interactiveChainFallback(model, registry, approval, reportHop);
    if (!options) { chainMemo = undefined; return undefined; }
    const key = JSON.stringify(options.chain);
    if (chainMemo && chainMemo.registry === registry && chainMemo.key === key) return chainMemo.options;
    chainMemo = { registry, key, options };
    return options;
  };
  let install = createRegistryGuard(approval);
  // Rebuild the guard only when the chain input changes: with the key absent (the default)
  // every call yields undefined, so the one chainless guard persists exactly as before and
  // providers are wrapped once, not on every turn.
  let installedChain: ChainFallbackOptions | undefined;
  const guardFor = (model: Model | undefined, registry: ExtensionContext["modelRegistry"]) => {
    const chain = chainFor(model, registry);
    if (chain !== installedChain) { installedChain = chain; install = createRegistryGuard(approval, chain); }
    return install;
  };
  pi.on("session_start", (_event, ctx) => {
    selected = ctx.model;
    currentUi = ctx.ui;
    launch = createExplicitPaidApproval(pi.getFlag(PAID_ROUTE_FLAG), ctx.model);
    // A new session starts from a fresh guard, as before this feature.
    installedChain = chainFor(selected, ctx.modelRegistry);
    install = createRegistryGuard(approval, installedChain);
    install(ctx.modelRegistry, ctx.model);
    if (ctx.model) assertActiveModelIdentity(ctx.model);
  });
  // Only dispatch-capable providers are guarded; the active model's provider
  // always is. Selecting a model is not a new paid launch authorization.
  pi.on("model_select", (event, ctx) => {
    selected = event.model ?? ctx.model;
    currentUi = ctx.ui;
    guardFor(selected, ctx.modelRegistry)(ctx.modelRegistry, selected);
    if (selected) assertActiveModelIdentity(selected);
  });
  const refresh = (_event: unknown, ctx: ExtensionContext) => {
    guardFor(ctx.model, ctx.modelRegistry)(ctx.modelRegistry, ctx.model);
    if (ctx.model) assertActiveModelIdentity(ctx.model);
  };
  pi.on("before_agent_start", refresh);
  pi.on("session_before_compact", refresh);
}

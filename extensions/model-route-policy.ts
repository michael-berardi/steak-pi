import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertActiveModelIdentity } from "../src/retired-model-selection.ts";
import { createRegistryGuard } from "../src/model-route-policy.ts";
import { activeTemporaryWorkerRoute, preferredFreeMetadata, selectPreferredFreePhysical, temporaryFreeStartupProvider } from "../src/temporary-free-route.ts";
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
  if (activeTemporaryWorkerRoute()) {
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
  let install = createRegistryGuard(approval);
  pi.on("session_start", (_event, ctx) => {
    selected = ctx.model;
    launch = createExplicitPaidApproval(pi.getFlag(PAID_ROUTE_FLAG), ctx.model);
    install = createRegistryGuard(approval);
    install(ctx.modelRegistry, ctx.model);
    if (ctx.model) assertActiveModelIdentity(ctx.model);
  });
  // Only dispatch-capable providers are guarded; the active model's provider
  // always is. Selecting a model is not a new paid launch authorization.
  pi.on("model_select", (event, ctx) => {
    selected = event.model ?? ctx.model;
    install(ctx.modelRegistry, selected);
    if (selected) assertActiveModelIdentity(selected);
  });
  const refresh = (_event: unknown, ctx: ExtensionContext) => {
    install(ctx.modelRegistry, ctx.model);
    if (ctx.model) assertActiveModelIdentity(ctx.model);
  };
  pi.on("before_agent_start", refresh);
  pi.on("session_before_compact", refresh);
}

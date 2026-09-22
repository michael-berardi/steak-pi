import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRegistryGuard } from "../src/model-route-policy.ts";
import { createExplicitPaidApproval, createSelectedRouteApproval, PAID_ROUTE_FLAG } from "../src/explicit-paid-route.ts";

type Model = NonNullable<ExtensionContext["model"]>;

/** Guard provider execution, including restored models, compaction, and model switching. */
export default function modelRoutePolicy(pi: ExtensionAPI): void {
  pi.registerFlag(PAID_ROUTE_FLAG, { type: "string", description: "Exact paid profile selection; requires user paid-routes.json approval." });
  // Operator `/model` switching is no longer launch-locked: the exact paid route
  // currently selected in this runtime is authorized when the user allowlist
  // carries that same reviewed route. Another route, a provider prefix, or an
  // entry the user removed never authorizes the dispatched model. Launch flags
  // remain an additional grant for scripted launches.
  let selected: Model | undefined;
  let launch: ((model: Model) => boolean) | undefined;
  const selectedRoute = createSelectedRouteApproval(() => selected);
  const approval = (model: Model) => launch?.(model) === true || selectedRoute(model);
  let install = createRegistryGuard(approval);
  pi.on("session_start", (_event, ctx) => {
    selected = ctx.model;
    launch = createExplicitPaidApproval(pi.getFlag(PAID_ROUTE_FLAG), ctx.model);
    install = createRegistryGuard(approval);
    install(ctx.modelRegistry);
  });
  pi.on("model_select", (_event, ctx) => { selected = ctx.model; install(ctx.modelRegistry); });
  pi.on("before_agent_start", (_event, ctx) => install(ctx.modelRegistry));
  pi.on("session_before_compact", (_event, ctx) => install(ctx.modelRegistry));
}

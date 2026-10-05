import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertActiveModelIdentity } from "../src/retired-model-selection.ts";
import { createRegistryGuard } from "../src/model-route-policy.ts";
import { createExplicitPaidApproval, PAID_ROUTE_FLAG } from "../src/explicit-paid-route.ts";

/** Guard provider execution, including restored models, compaction, and model switching. */
export default function modelRoutePolicy(pi: ExtensionAPI): void {
  pi.registerFlag(PAID_ROUTE_FLAG, { type: "string", description: "Exact paid profile selection; requires user paid-routes.json approval." });
  let install = createRegistryGuard();
  pi.on("session_start", (_event, ctx) => {
    install = createRegistryGuard(createExplicitPaidApproval(pi.getFlag(PAID_ROUTE_FLAG), ctx.model));
    install(ctx.modelRegistry);
    if (ctx.model) assertActiveModelIdentity(ctx.model);
  });
  // Selecting a model is not a new paid launch authorization.
  const refresh = (_event: unknown, ctx: ExtensionContext) => {
    install(ctx.modelRegistry);
    if (ctx.model) assertActiveModelIdentity(ctx.model);
  };
  pi.on("model_select", refresh);
  pi.on("before_agent_start", refresh);
  pi.on("session_before_compact", refresh);
}

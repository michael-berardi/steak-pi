import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRegistryGuard } from "../src/model-route-policy.ts";
import { createExplicitPaidApproval, PAID_ROUTE_FLAG } from "../src/explicit-paid-route.ts";

/** Guard provider execution, including restored models, compaction, and model switching. */
export default function modelRoutePolicy(pi: ExtensionAPI): void {
  pi.registerFlag(PAID_ROUTE_FLAG, { type: "string", description: "Exact paid profile selection; requires user paid-routes.json approval." });
  let install = createRegistryGuard();
  pi.on("session_start", (_event, ctx) => {
    install = createRegistryGuard(createExplicitPaidApproval(pi.getFlag(PAID_ROUTE_FLAG), ctx.model));
    install(ctx.modelRegistry, ctx.model);
  });
  // Selecting a model is not a new paid launch authorization.
  pi.on("model_select", (event, ctx) => install(ctx.modelRegistry, event.model ?? ctx.model));
  pi.on("before_agent_start", (_event, ctx) => install(ctx.modelRegistry, ctx.model));
  pi.on("session_before_compact", (_event, ctx) => install(ctx.modelRegistry, ctx.model));
}

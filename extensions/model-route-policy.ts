import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRegistryGuard } from "../src/model-route-policy.ts";

/** Guard provider execution, including restored models, compaction, and model switching. */
export default function modelRoutePolicy(pi: ExtensionAPI): void {
  const install = createRegistryGuard();
  pi.on("session_start", (_event, ctx) => install(ctx.modelRegistry));
  pi.on("model_select", (_event, ctx) => install(ctx.modelRegistry));
  pi.on("before_agent_start", (_event, ctx) => install(ctx.modelRegistry));
  pi.on("session_before_compact", (_event, ctx) => install(ctx.modelRegistry));
}

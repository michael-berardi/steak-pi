import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { optionsFromEnv, rewriteCatalog } from "./catalog.ts";

/** Use only the documented, chained systemPrompt hook; no core/global patching. */
export default function skillCatalogLite(pi: ExtensionAPI): void {
  pi.on("before_agent_start", event => {
    const result = rewriteCatalog(event.systemPrompt, optionsFromEnv(process.env));
    if (result.changed) return { systemPrompt: result.systemPrompt };
  });
}

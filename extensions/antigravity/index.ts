// Google Antigravity provider. Loaded by Pi on every start, so this file stays tiny: it reads the operator's config
// with node built-ins only and, when the module is not turned on, returns without importing anything else.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { steakPiVersion } from "../claude-code/catalog-guard.ts";
import { loadConfig } from "./config.ts";

export default async function antigravityExtension(pi: ExtensionAPI): Promise<void> {
  const config = loadConfig(process.env, () => steakPiVersion());
  if (!config) return;
  const { createAntigravityProvider } = await import("./provider.ts");
  pi.registerProvider(createAntigravityProvider(config));
}

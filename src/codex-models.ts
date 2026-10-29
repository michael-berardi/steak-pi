import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SOL_MODEL_ROUTE } from "./retired-model-selection.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
export const TERRA_MODEL_ID = "gpt-6.1-terra";
export const TERRA_MODEL_ROUTE = `openai-codex/${TERRA_MODEL_ID}`;
export const TERRA_PROFILE = "steak-pi/gpt-6-1-terra";
export const TERRA_LABEL = "GPT-6.1 Terra";
export function isManagedCodexRoute(route: string): boolean {
  return route === TERRA_MODEL_ROUTE || route === SOL_MODEL_ROUTE;
}
/** Official 2026-10-28 metadata; transport and OAuth stay native Codex. */
export const TERRA_MODEL: Model = {
  provider: "openai-codex", id: TERRA_MODEL_ID, name: TERRA_LABEL,
  api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true, input: ["text", "image"], contextWindow: 1_050_000, maxTokens: 128_000,
  cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
};
const CATALOG_MARK = Symbol.for("steak-pi.terra-catalog.v1");
/** Preserve all native models (including explicit Sol), APIs and authentication. */
export function withTerraCatalog(provider: Provider): Provider {
  if (provider.id !== "openai-codex" || (provider as unknown as Record<symbol, unknown>)[CATALOG_MARK]) return provider;
  const add = <T extends { id: string }>(models: readonly T[]) => models.some(model => model.id === TERRA_MODEL_ID) ? [...models] : [...models, TERRA_MODEL];
  const augmented: Provider = { ...provider, getModels: () => add(provider.getModels()),
    ...(provider.getAllModels ? { getAllModels: () => add(provider.getAllModels!()) } : {}) };
  Object.defineProperty(augmented, CATALOG_MARK, { value: true, enumerable: true });
  return augmented;
}
export function registerTerraRuntime(runtime: ModelRuntime): void {
  const provider = runtime.getRegisteredNativeProvider?.("openai-codex") ?? runtime.getProvider("openai-codex");
  if (provider) {
    const augmented = withTerraCatalog(provider);
    if (augmented !== provider) runtime.registerNativeProvider(augmented);
  }
}
/** Startup registration precedes Pi's --model lookup (no custom-model warning). */
export function terraStartupProvider(): Provider {
  const sdk = findPackageJSON(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const ai = sdk && findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdk));
  if (!sdk || !ai) throw new Error("Native Codex provider unavailable; no fallback was selected.");
  const { openaiCodexProvider } = createRequire(sdk)(join(dirname(ai), "dist/providers/openai-codex.js"));
  return withTerraCatalog(openaiCodexProvider());
}

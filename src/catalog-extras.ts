import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { routingConfigOrEmpty, type CatalogExtra } from "./routing-config.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;

/**
 * Operator catalog extras (`catalogExtras` in routing.json): model metadata an
 * operator adds to a native provider's catalog before the provider library ships
 * it. Transport, OAuth and every native model stay the provider's own; an extra
 * never replaces a native model with the same id. Steak Pi ships no extra itself.
 */
export function catalogExtras(): readonly CatalogExtra[] {
  return routingConfigOrEmpty().catalogExtras ?? [];
}
const extrasFor = (providerId: string): Model[] =>
  catalogExtras().filter((extra) => extra.provider === providerId).flatMap((extra) => extra.models as unknown as Model[]);

const CATALOG_MARK = Symbol.for("steak-pi.catalog-extras.v1");
/** Preserve all native models, APIs and authentication; add only missing configured ids. */
export function withCatalogExtras(provider: Provider): Provider {
  if ((provider as unknown as Record<symbol, unknown>)[CATALOG_MARK]) return provider;
  if (extrasFor(provider.id).length === 0) return provider;
  // Re-read per catalog call so an edited routing.json applies without a restart.
  const add = <T extends { id: string }>(models: readonly T[]) => {
    const extras = extrasFor(provider.id).filter((extra) => !models.some((model) => model.id === extra.id));
    return [...models, ...extras as unknown as T[]];
  };
  const augmented: Provider = { ...provider, getModels: () => add(provider.getModels()),
    ...(provider.getAllModels ? { getAllModels: () => add(provider.getAllModels!()) } : {}) };
  Object.defineProperty(augmented, CATALOG_MARK, { value: true, enumerable: true });
  return augmented;
}

/** True when `route` is one of the operator's configured catalog extras. */
export function isCatalogExtraRoute(route: string): boolean {
  return catalogExtras().some((extra) => extra.models.some((model) => `${extra.provider}/${String(model.id)}` === route));
}

/** Register the configured extras on a model runtime (an isolated child runtime included). */
export function registerCatalogExtras(runtime: ModelRuntime): void {
  for (const id of new Set(catalogExtras().map((extra) => extra.provider))) {
    const provider = runtime.getRegisteredNativeProvider?.(id) ?? runtime.getProvider(id);
    if (provider) {
      const augmented = withCatalogExtras(provider);
      if (augmented !== provider) runtime.registerNativeProvider(augmented);
    }
  }
}

/** `openai-codex` -> `openaiCodexProvider`: the pi-ai native provider factory naming convention. */
const factoryName = (id: string) => `${id.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())}Provider`;

/** Startup registration of every provider with configured extras, so Pi's --model lookup
 * sees them before the first turn (no custom-model warning). A configured provider the
 * installed Pi does not ship fails loudly; no fallback provider is substituted. */
export function catalogStartupProviders(): Provider[] {
  const ids = [...new Set(catalogExtras().map((extra) => extra.provider))];
  if (ids.length === 0) return [];
  const sdk = findPackageJSON(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const ai = sdk && findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdk));
  if (!sdk || !ai) throw new Error("Native provider library unavailable for catalogExtras; no fallback was selected.");
  return ids.map((id) => {
    let factory: unknown;
    try { factory = createRequire(sdk)(join(dirname(ai), `dist/providers/${id}.js`))[factoryName(id)]; }
    catch { factory = undefined; }
    if (typeof factory !== "function") throw new Error(`catalogExtras names provider ${id}, which the installed Pi does not ship natively; no fallback was selected.`);
    return withCatalogExtras((factory as () => Provider)());
  });
}

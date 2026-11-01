import { routingConfigOrEmpty } from "./routing-config.ts";

/**
 * Shared availability rules for the interactive model pickers.
 *
 * One rule is the curated scope: native `/model` and the UltraTerm composer list
 * show the profiles of the selected harness manifest (see `harness-profiles.ts`)
 * instead of every authenticated provider-library model. The other is the
 * operator's hidden-model list (`hiddenModelPatterns` in routing.json).
 *
 * Native `/model` and the UltraTerm composer picker both render the same native
 * availability snapshot (`ModelRegistry.getAvailable()` ===
 * `ModelRuntime.getAvailableSnapshot()`), so a hidden route has to be dropped
 * once, in that shared source, instead of being suppressed in a second list.
 * The snapshot is produced by each provider's `filterModels`, so the one rule
 * below is applied there and the published catalog reads the same snapshot.
 *
 * Each hidden pattern is provider-scoped and matched against the model's local
 * slug (the id after its last `/`), so no other provider and no substring of an
 * unrelated id is ever affected. Steak Pi hides nothing by default.
 *
 * Nothing is removed from the provider catalog (`Provider.getModels()`); only
 * availability is filtered, so dispatch coverage, cost accounting and the SDK's
 * global-API bypass decisions are untouched. A session already running on a
 * hidden route keeps running — the running model is published separately as
 * `currentModel` and is never re-added to the choice list.
 */
type Route = { provider: string; id: string };

const slug = (model: Route) => model.id.slice(model.id.lastIndexOf("/") + 1);

/** True only for a route the operator hid from the pickers (provider-scoped, slug-exact pattern). */
export function isHiddenModel(model: Route): boolean {
  const hidden = routingConfigOrEmpty().hiddenModelPatterns ?? [];
  return hidden.some((entry) => entry.provider === model.provider && entry.pattern.test(slug(model)));
}
/** @deprecated Former name of {@link isHiddenModel}. */
export const isRemovedOpenRouterFlash = isHiddenModel;

/**
 * Shared availability filter: the single source native `/model` and the
 * UltraTerm composer list render. Preserves the caller's order and drops only
 * the operator's hidden routes.
 */
export function sharedPickerModels<T extends Route>(models: readonly T[]): T[] {
  return models.filter(model => !isHiddenModel(model));
}

/**
 * Curated scope: keep only exact `provider/id` routes the selected harness
 * manifest configures. `undefined` means the harness manifest is unknown (no live
 * or bundled manifest yet), and callers keep the previous availability rather
 * than hiding every model in a broken install. An empty set is authority too: a
 * harness whose manifest declares no native route shows no picker choices.
 */
export function curatedPickerModels<T extends Route>(models: readonly T[], scope: ReadonlySet<string> | undefined): T[] {
  return scope ? models.filter(model => scope.has(`${model.provider}/${model.id}`)) : models.filter(() => true);
}

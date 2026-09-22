/**
 * Shared availability rule for the OpenRouter DeepSeek Flash routes the
 * operator removed from the interactive model pickers.
 *
 * Native `/model` and the UltraTerm composer picker both render the same native
 * availability snapshot (`ModelRegistry.getAvailable()` ===
 * `ModelRuntime.getAvailableSnapshot()`), so a removed route has to be dropped
 * once, in that shared source, instead of being suppressed in a second list.
 * The snapshot is produced by each provider's `filterModels`, so the one rule
 * below is applied there and the published catalog reads the same snapshot.
 *
 * Go Flash (`opencode-go/deepseek-v4.1-flash`) and INCO Fast
 * (`inco/deepseek-v4.1-flash:fast`) already cover the Flash capability, so
 * every plain OpenRouter DeepSeek V4 Flash / V4.1 Flash route is hidden
 * entirely: the canonical bare id, the released `-0731` (and `:batch`
 * transport) form, the `latest` alias — served from the `~deepseek/` namespace —
 * and the unversioned `DeepSeek Flash Latest` rolling alias. The rule is
 * deliberately narrow:
 * - only `provider === "openrouter"`, so Go Flash, INCO Fast and every other
 *   provider keep every route they have — never a blanket provider hide and
 *   never a fuzzy match across providers;
 * - only the plain DeepSeek Flash line, so `deepseek-v4-pro` (`-0813`,
 *   `:batch`, `~deepseek/deepseek-pro-latest`), the `-vision-exp` capability
 *   variants and unrelated OpenRouter models (`deepseek-chat`, `deepseek-r1`,
 *   `deepseek-v3.2`, …) stay visible.
 *
 * Nothing is removed from the provider catalog (`Provider.getModels()`); only
 * availability is filtered, so dispatch coverage, cost accounting and the SDK's
 * global-API bypass decisions are untouched. A session already running on a
 * removed route keeps running — the running model is published separately as
 * `currentModel` and is never re-added to the choice list.
 */
const OPENROUTER_PROVIDER = "openrouter";
/**
 * Local slug of every OpenRouter DeepSeek Flash route the operator removed:
 * the canonical `deepseek-v4-flash` / `deepseek-v4.1-flash`, their release
 * (`-0731`), `latest` and `:batch` forms, and the unversioned Flash alias.
 * `-vision-exp` and the Pro line deliberately do not match.
 */
const REMOVED_OPENROUTER_FLASH = /^(?:deepseek-v4(?:\.1)?-flash(?:-(?:latest|\d{4}))?|deepseek-flash-latest)(?::batch)?$/;

type Route = { provider: string; id: string };

const slug = (model: Route) => model.id.slice(model.id.lastIndexOf("/") + 1);

/**
 * True only for an OpenRouter route the operator removed from the pickers.
 * Provider-scoped and slug-exact, so no other provider and no other OpenRouter
 * model is ever affected by a substring match.
 */
export function isRemovedOpenRouterFlash(model: Route): boolean {
  return model.provider === OPENROUTER_PROVIDER && REMOVED_OPENROUTER_FLASH.test(slug(model));
}

/**
 * Shared availability filter: the single source native `/model` and the
 * UltraTerm composer list render. Preserves the caller's order and drops only
 * the removed OpenRouter DeepSeek Flash routes.
 */
export function sharedPickerModels<T extends Route>(models: readonly T[]): T[] {
  return models.filter(model => !isRemovedOpenRouterFlash(model));
}

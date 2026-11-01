import { registerCatalogExtras } from "../catalog-extras.ts";
import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveStagedModule } from "./staged-runtime.ts";
import { assertSubscriptionRequest } from "../model-route-policy.ts";
import { isolatedAgentPaths, selectCodexAccount, type AccountCommand } from "./provider-accounts.ts";
import { configuredWorkerProfiles, type WorkerProfile, type WorkerSelector } from "./model-selection.ts";
import { CODEX_QUOTA, isMeteredQuota, isQuotaTierRoute, quotaProviderOf } from "./provider-quota.ts";

export type CreateIsolatedModelRuntime = typeof ModelRuntime.create;

/** Only a selected route in the operator's account-leased Codex tier (`providerQuotaFallback`
 * entries with quota "codex") crosses stores, and only from a parent on another account-leased
 * tier. Parent registry/environment stay untouched, and the driver reserves its own account and
 * recreates this runtime on that account. */
export async function registryForAccountSelection(
  parent: NonNullable<ExtensionContext["model"]>,
  input: WorkerSelector,
  registry: ExtensionContext["modelRegistry"],
  command?: AccountCommand,
  createRuntime?: CreateIsolatedModelRuntime,
  profiles: readonly WorkerProfile[] = configuredWorkerProfiles(),
): Promise<ExtensionContext["modelRegistry"]> {
  const selected = input.model ?? profiles.find(profile => profile.id === input.profile || profile.id === `steak-pi/${input.profile}`)?.model;
  const parentTier = quotaProviderOf(parent);
  if (!selected || !isQuotaTierRoute(selected, CODEX_QUOTA) || parentTier === undefined || parentTier === CODEX_QUOTA || !isMeteredQuota(parentTier)) return registry;
  const slash = selected.indexOf("/");
  const providerId = selected.slice(0, slash);
  const modelId = selected.slice(slash + 1);
  const existing = registry.find(providerId, modelId);
  if (existing && registry.hasConfiguredAuth(existing) && registry.isUsingOAuth(existing)) return registry;
  const account = await selectCodexAccount(command);
  const create = createRuntime ?? (await (await import(resolveStagedModule("src/subagents/pi-worker.ts").url)).loadPiSdk()).ModelRuntime.create;
  const runtime = await create(isolatedAgentPaths(account.agentDir));
  registerCatalogExtras(runtime);
  const model = runtime.getModel(providerId, modelId);
  if (!model || `${model.provider}/${model.id}` !== selected) throw new Error(`USAP model ${selected} is unavailable in the isolated Codex runtime; no fallback was selected.`);
  assertSubscriptionRequest(model, runtime.isUsingOAuth(model.provider));
  if (!runtime.hasConfiguredAuth(model.provider)) throw new Error("Isolated Codex account has no configured OAuth authentication; no fallback was selected.");
  // The synchronous SDK facade's exact read methods, backed by authentic runtime status.
  // No parent registration, copied credentials, or fabricated configured/OAuth flags.
  return {
    find: (provider: string, id: string) => runtime.getModel(provider, id),
    getAll: () => [...runtime.getModels()],
    getAvailable: () => [...runtime.getAvailableSnapshot()],
    hasConfiguredAuth: (candidate: typeof model) => runtime.hasConfiguredAuth(candidate.provider),
    isUsingOAuth: (candidate: typeof model) => runtime.isUsingOAuth(candidate.provider),
    getProvider: (provider: string) => runtime.getProvider(provider),
    refresh: () => runtime.refresh(),
  } as ExtensionContext["modelRegistry"];
}
/** @deprecated Former name of {@link registryForAccountSelection}. */
export const registryForSolSelection = registryForAccountSelection;

import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveStagedModule } from "./staged-runtime.ts";
import { assertSubscriptionRequest } from "../model-route-policy.ts";
import { SOL_MODEL_ID, SOL_MODEL_ROUTE, SOL_PROFILE } from "../retired-model-selection.ts";
import { isolatedAgentPaths, selectCodexAccount, type AccountCommand } from "./provider-accounts.ts";
import { BUILTIN_WORKER_PROFILES, type WorkerProfile, type WorkerSelector } from "./model-selection.ts";

export type CreateIsolatedModelRuntime = typeof ModelRuntime.create;

/** Only the selected Sol route crosses stores. Parent registry/environment stay untouched,
 * and the driver reserves its own account and recreates this runtime on that account. */
export async function registryForSolSelection(
  parent: NonNullable<ExtensionContext["model"]>,
  input: WorkerSelector,
  registry: ExtensionContext["modelRegistry"],
  command?: AccountCommand,
  createRuntime?: CreateIsolatedModelRuntime,
  profiles: readonly WorkerProfile[] = BUILTIN_WORKER_PROFILES,
): Promise<ExtensionContext["modelRegistry"]> {
  const solRequested = input.model === SOL_MODEL_ROUTE || (input.model === undefined &&
    (input.profile === SOL_PROFILE || input.profile === "gpt-6-1-sol" || profiles.some(profile =>
      profile.model === SOL_MODEL_ROUTE && (profile.id === input.profile || profile.id === `steak-pi/${input.profile}`))));
  if (!solRequested || parent.provider !== "opencode-go") return registry;
  const existing = registry.find("openai-codex", SOL_MODEL_ID);
  if (existing && registry.hasConfiguredAuth(existing) && registry.isUsingOAuth(existing)) return registry;
  const account = await selectCodexAccount(command);
  const create = createRuntime ?? (await (await import(resolveStagedModule("src/subagents/pi-worker.ts").url)).loadPiSdk()).ModelRuntime.create;
  const runtime = await create(isolatedAgentPaths(account.agentDir));
  const model = runtime.getModel("openai-codex", SOL_MODEL_ID);
  if (!model || `${model.provider}/${model.id}` !== SOL_MODEL_ROUTE) throw new Error(`USAP model ${SOL_MODEL_ROUTE} is unavailable in the isolated Codex runtime; no fallback was selected.`);
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

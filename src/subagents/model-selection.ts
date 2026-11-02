import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertActiveModelIdentity, assertActiveModelSelector, isRetiredRoute, retiredRouteError } from "../retired-model-selection.ts";
import type { TaskClassRanking } from "../model-route-policy.ts";
import { NoChainRouteError, assertModelRoute, assertSubscriptionRequest, selectChainedWorkerModel, selectWorkerModel, selectWorkerThinking,
  workerChainFor, type ChainOptions } from "../model-route-policy.ts";
import { routingConfig, routingConfigOrEmpty, routingConfigPath } from "../routing-config.ts";
import type { DispatchInput, ModelSelection, SubagentTaskInput } from "./types.ts";
import { activeTemporaryWorkerRoute, assertTemporaryFreeRequest, isTemporaryFreeModel, PREFERRED_FREE_PROFILE } from "../temporary-free-route.ts";
export { retiredRouteError } from "../retired-model-selection.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type Registry = ExtensionContext["modelRegistry"];
type Thinking = NonNullable<ExtensionContext["thinkingLevel"]>;
export interface WorkerSelector { model?: string; profile?: string }
export interface WorkerProfile {
  id: string;
  model: string;
  thinking?: Thinking;
  workerDefault?: WorkerSelector;
  reviewerDefault?: WorkerSelector;
  /** Resolve the final automatic worker chain instead of this profile's head model.
   * Only operator-configured profiles declare it; explicit selectors never chain. */
  autoChain?: boolean;
  /** Legacy native-Pi reviewer-chain label: reviewer-role automatic defaults
   * resolve the same routine subscription chain as workers instead of freezing
   * on this profile's head expert model. It is a routing flag, NOT expert
   * sign-off; reviews still need the explicit expert or override route. */
  autoReviewChain?: boolean;
}
/** The only built-in profile is the neutral virtual temporary-free route; it names no model.
 * Every other worker profile is operator configuration (`workerProfiles` in routing.json)
 * or a harness manifest. Explicit model identities are unchanged. */
export const BUILTIN_WORKER_PROFILES: readonly WorkerProfile[] = [
  { id: PREFERRED_FREE_PROFILE, model: PREFERRED_FREE_PROFILE, thinking: "high" },
];
/** The operator's configured profiles (`workerProfiles`), after the built-in virtual route. */
export function configuredWorkerProfiles(): WorkerProfile[] {
  const profiles = new Map(BUILTIN_WORKER_PROFILES.map((profile) => [profile.id, { ...profile }]));
  for (const profile of routingConfig().workerProfiles ?? []) profiles.set(profile.id, { ...profile });
  return [...profiles.values()];
}
/** The configured profile whose head resolves the default text chain when an exhausted provider is left (`defaultChainProfile`). */
const defaultChainProfile = (): string | undefined => routingConfig().defaultChainProfile;
const PI_FAMILY_HARNESSES = new Set(["pi", "steak-pi"]);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** @deprecated Retired routes are operator configuration (`retiredModelPatterns`); use `isRetiredRoute`. */
export const RETIRED_ROUTE = { test: (route: string): boolean => isRetiredRoute(route) };

function selector(value: WorkerSelector, label: string): WorkerSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a model/profile selector.`);
  assertActiveModelSelector(value.model);
  assertActiveModelSelector(value.profile);
  for (const route of [value.model, value.profile]) {
    if (typeof route === "string" && isRetiredRoute(route)) throw new Error(`${label}: ${retiredRouteError(route)}`);
  }
  if (value.model !== undefined && value.profile !== undefined) throw new Error(`${label}: model and profile conflict; specify exactly one.`);
  for (const [key, field] of Object.entries(value)) {
    if (!["model", "profile"].includes(key) || typeof field !== "string" || !field.trim() || field !== field.trim() || field.length > 256) {
      throw new Error(`${label}: use one nonempty model or profile string (maximum 256 characters).`);
    }
  }
  if (!value.model && !value.profile) throw new Error(`${label} requires model or profile.`);
  return value;
}

export interface RoleDefaults { workerDefault?: WorkerSelector; reviewerDefault?: WorkerSelector }
/** Role metadata only; no launch args, credentials, or paid-route grants. */
export function loadRoleDefaults(path = routingConfigPath()): RoleDefaults {
  let config: any;
  try { config = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("USAP routing.json cannot be read or parsed"); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("USAP routing.json requires an object");
  return Object.fromEntries(["workerDefault", "reviewerDefault"].filter(key => config[key] !== undefined)
    .map(key => [key, selector(config[key], `USAP routing.json ${key}`)]));
}

/** Read route metadata only. Never execute profile args, commands, or credentials. */
export function loadWorkerProfiles(directory = join(homedir(), ".config", "ultraterm", "harnesses")): WorkerProfile[] {
  const profiles = new Map(configuredWorkerProfiles().map((profile) => [profile.id, { ...profile }]));
  const retired = new Set(routingConfig().retiredProfiles ?? []);
  let files: string[];
  try { files = readdirSync(directory).filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...profiles.values()]; throw new Error("USAP profile catalog cannot be read."); }
  const seen = new Set<string>();
  for (const file of files) {
    let manifest: { id?: string; executable?: string; profiles?: Array<{ id?: string; name?: string; args?: string[]; workerDefault?: WorkerSelector; reviewerDefault?: WorkerSelector }> };
    try { manifest = JSON.parse(readFileSync(join(directory, file), "utf8")); }
    catch { throw new Error(`USAP cannot parse harness metadata ${file}; repair the catalog before dispatch.`); }
    if (typeof manifest.id !== "string" || !Array.isArray(manifest.profiles)) continue;
    // Other terminal harnesses (Claude Code, Gemini CLI, ...) share this catalog
    // directory with their own model names. They are never USAP worker routes,
    // so a foreign `--model NAME` must not make every dispatch fail.
    const executable = typeof manifest.executable === "string" ? basename(manifest.executable) : "";
    const piFamily = PI_FAMILY_HARNESSES.has(manifest.id) || PI_FAMILY_HARNESSES.has(executable);
    for (const entry of manifest.profiles) {
      if (manifest.id === "steak-pi" && typeof entry.id === "string" && retired.has(entry.id)) continue;
      if (typeof entry.id !== "string") continue;
      // Operator-retired models are refused wherever the manifest names them, before any
      // CLI-only or foreign-harness skip, so a retired route cannot hide there.
      assertActiveModelSelector(entry.id);
      assertActiveModelSelector(entry.name);
      assertActiveModelSelector(`${manifest.id}/${entry.id}`);
      for (const defaults of [entry.workerDefault, entry.reviewerDefault]) {
        if (defaults && typeof defaults === "object") {
          assertActiveModelSelector(defaults.model);
          assertActiveModelSelector(defaults.profile);
        }
      }
      if (!Array.isArray(entry.args)) continue;
      for (const arg of entry.args) {
        if (typeof arg === "string" && arg.startsWith("--model=")) assertActiveModelSelector(arg.slice("--model=".length));
      }
      const modelFlags = entry.args.filter((arg) => arg === "--model");
      if (modelFlags.length === 0) continue; // CLI-only profiles are not native model routes.
      if (modelFlags.length !== 1) throw new Error(`Ambiguous model route in profile ${manifest.id}/${entry.id}.`);
      const model = entry.args[entry.args.indexOf("--model") + 1];
      assertActiveModelSelector(model);
      if (typeof model !== "string" || !model.includes("/")) {
        if (!piFamily) continue;
        throw new Error(`Profile ${manifest.id}/${entry.id} needs a provider/model route.`);
      }
      const id = `${manifest.id}/${entry.id}`;
      if (seen.has(id)) throw new Error(`Duplicate USAP profile ${id}.`);
      seen.add(id);
      const thinking = entry.args[entry.args.indexOf("--thinking") + 1];
      const previous = profiles.get(id);
      const inherited = previous?.model === model ? previous : {};
      profiles.set(id, {
        ...inherited, id, model,
        ...(entry.args.includes("--thinking") ? { thinking: thinkingLevels.has(thinking) ? thinking as Thinking : undefined } : {}),
        ...(entry.workerDefault !== undefined ? { workerDefault: selector(entry.workerDefault, `${id}.workerDefault`) } : {}),
        ...(entry.reviewerDefault !== undefined ? { reviewerDefault: selector(entry.reviewerDefault, `${id}.reviewerDefault`) } : {}),
      });
    }
  }
  return [...profiles.values()];
}

export { CLAUDE_CODE_OPUS_MODEL, CLAUDE_CODE_SONNET_MODEL, CLAUDE_CODE_HAIKU_MODEL, CLAUDE_CODE_MODEL, CLAUDE_CODE_EFFORTS, CLAUDE_CODE_DEFAULT_EFFORT,
  CLAUDE_CODE_OPUS_ROUTE, CLAUDE_CODE_SONNET_ROUTE, CLAUDE_CODE_HAIKU_ROUTE, CLAUDE_CODE_ROUTE, CLAUDE_CODE_ROUTES,
  claudeCodeModelOf, claudeCodeModelName, claudeFallbackTier, defaultClaudeCodeRoute, resolveClaudeCodeSelection,
  ClaudeCodeEffortError, isClaudeCodeEffort, resolveClaudeCodeEffort,
  assertClaudeCodeImageAdmission, type ClaudeCodeEffort, type ClaudeCodeModel, type ClaudeCodeFallbackRoute, type ClaudeFallbackTier } from "./claude-code-models.ts";

function route(model: Model): string { return `${model.provider}/${model.id}`; }
function findModel(key: string, registry: Registry): Model {
  assertActiveModelSelector(key);
  const slash = key.indexOf("/");
  if (slash < 1 || slash === key.length - 1) throw new Error("USAP model must use the exact provider/model form.");
  const model = registry.find(key.slice(0, slash), key.slice(slash + 1));
  if (model) assertActiveModelIdentity(model);
  if (!model || route(model) !== key) throw new Error(`USAP model ${key} is unavailable. Choose an exact model from the authenticated registry; no fallback was selected.`);
  return model;
}

/** Fail closed if explicit routing ever loses its provenance. */
export function assertWorkerSelectionOverride(input: WorkerSelector, selection: ModelSelection): void {
  if ((input.model !== undefined || input.profile !== undefined) && selection.source !== "override") {
    throw new Error("USAP model/profile: explicit selection must produce source override; no fallback was selected.");
  }
}

export function resolveWorkerSelection(
  parent: Model,
  inheritedThinking: ExtensionContext["thinkingLevel"],
  input: Pick<DispatchInput, "model" | "profile" | "tasks" | "thinking" | "thinkingReason" | "requireImages" | "harness">,
  registry: Registry,
  profiles: readonly WorkerProfile[] = loadWorkerProfiles(),
  parentProfileId = process.env.ULTRATERM_HARNESS_PROFILE,
  options: ChainOptions = {},
  roleDefaults?: RoleDefaults,
): { model: Model; thinkingLevel: Thinking; selection: ModelSelection; alternates?: ClassAlternate[] } {
  // The native Pi registry stream adapters cannot serve foreign harnesses.
  // Claude Code dispatch must branch to its explicit CLI route before selection;
  // fail closed here so no caller can route it through the registry by accident.
  if (input.harness === "claude-code") {
    throw new Error("USAP harness claude-code does not resolve through the native Pi registry; dispatch the explicit CLI route instead.");
  }
  // Capture caller intent once, before consulting task/profile/registry objects.
  const requested: WorkerSelector = { model: input.model, profile: input.profile };
  assertActiveModelSelector(requested.model);
  assertActiveModelSelector(requested.profile);
  assertModelRoute(parent);
  for (const task of input.tasks) {
    if ("model" in task) assertActiveModelSelector(task.model);
    if ("profile" in task) assertActiveModelSelector(task.profile);
  }
  if (input.tasks.some((task) => "model" in task || "profile" in task)) {
    throw new Error("USAP model/profile selection is run-level only; split different routes into separate runs.");
  }
  if (input.requireImages !== undefined && typeof input.requireImages !== "boolean") throw new Error("requireImages must be a boolean.");
  const explicit = requested.model !== undefined || requested.profile !== undefined;
  const parentKey = route(parent);
  const profileById = (id: string): WorkerProfile => {
    assertActiveModelSelector(id);
    const matches = profiles.filter((p) => p.id === id || (!id.includes("/") && p.id === `steak-pi/${id}`));
    if (matches.length !== 1) throw new Error(`USAP profile ${id} is unavailable or ambiguous; use its harness/profile identity.`);
    assertActiveModelSelector(matches[0].id);
    assertActiveModelSelector(matches[0].model);
    if (matches[0].id === PREFERRED_FREE_PROFILE && matches[0].model !== PREFERRED_FREE_PROFILE) {
      throw new Error("USAP approved free profile identity cannot be overridden by manifest metadata.");
    }
    return matches[0];
  };
  const parents = profiles.filter((p) => p.model === parentKey);
  const namedParent = parentProfileId && profiles.find((p) => p.id === parentProfileId || p.id === `${process.env.ULTRATERM_HARNESS_ID ?? process.env.ULTRATERM_HARNESS ?? "steak-pi"}/${parentProfileId}`);
  // A /model change must not inherit defaults belonging to a stale launch profile.
  const parentProfile = namedParent && namedParent.model === parentKey ? namedParent : parents.length === 1 ? parents[0] : undefined;
  const review = input.tasks.some((task) => task.role === "reviewer");
  // A configured task class steers an implicit text wave: its chain is walked first with the default chain's
  // own checks (authentication, catalog, spendability, quota veto, `onlyWhen`). When no step can launch the
  // normal route below resolves exactly as it would without a class.
  const classWalk = options.taskClass && !explicit && !review && input.requireImages !== true && !input.harness ? options.taskClass : undefined;
  const classUsable = classWalk?.steps.filter((entry) => entry.blocked === undefined) ?? [];
  type ClassUsable = (typeof classUsable)[number];
  /** Launchable steps with their models, ranked on evidence when the walk carries a ranker; chain order otherwise. */
  let classHit: { model: Model; index: number; entry: ClassUsable; ordered: Array<{ entry: ClassUsable; model: Model }> } | undefined;
  let classRanking: TaskClassRanking | undefined;
  if (classWalk && classUsable.length > 0) {
    // Every step that passes the default chain's own checks, in chain order: pick the first, drop it and the
    // ineligible steps before it, repeat. Ranking then reorders only these.
    const launchable: Array<{ entry: ClassUsable; model: Model }> = [];
    let rest = classUsable;
    while (rest.length > 0) {
      try {
        const picked = selectChainedWorkerModel(registry, rest.map((entry) => entry.step), { ...options, requireImages: false });
        const at = rest.findIndex((entry) => entry.step.provider === picked.provider && entry.step.id === picked.id);
        launchable.push({ entry: rest[at], model: picked });
        rest = rest.slice(at + 1);
      } catch (error) {
        if (!(error instanceof NoChainRouteError)) throw error;
        break;
      }
    }
    classRanking = launchable.length > 0 ? classWalk.rank?.(launchable.map((item) => ({ entry: item.entry.entry, route: route(item.model) }))) : undefined;
    const ordered = classRanking
      ? classRanking.order.flatMap((entry) => launchable.filter((item) => item.entry.entry === entry))
      : launchable;
    if (ordered.length > 0) classHit = { model: ordered[0].model, index: classUsable.indexOf(ordered[0].entry), entry: ordered[0].entry, ordered };
  }
  // An implicit dispatch whose profile default landed on an exhausted provider re-resolves the
  // configured default text chain (`textWorkerChain`) with that provider skipped. An explicit selector
  // never takes this path, and neither do reviewer or image waves.
  const forceChain = options.forceDefaultChain === true && !explicit && !review && input.requireImages !== true;
  // Only ordinary implicit text workers observe the temporary preference;
  // explicit model/profile/harness and all review/image gates remain exact.
  const temporary = !explicit && !review && !forceChain && !input.harness && !input.requireImages ? activeTemporaryWorkerRoute() : undefined;
  const defaults = explicit || temporary || forceChain ? {} : roleDefaults ?? loadRoleDefaults();
  const chainProfile = forceChain ? defaultChainProfile() : undefined;
  const configured = temporary ? { profile: PREFERRED_FREE_PROFILE } : forceChain ? (chainProfile ? { profile: chainProfile } : undefined) : review ? defaults.reviewerDefault ?? parentProfile?.reviewerDefault ?? parentProfile?.workerDefault : defaults.workerDefault ?? parentProfile?.workerDefault;
  const chosen = explicit ? selector({ ...(requested.model !== undefined ? { model: requested.model } : {}), ...(requested.profile !== undefined ? { profile: requested.profile } : {}) }, "USAP selection") : configured ? selector(configured, "USAP profile default") : undefined;
  const profile = classHit
    ? classHit.entry.profile !== undefined ? profiles.find((candidate) => candidate.id === classHit.entry.profile) : undefined
    : forceChain
      ? (chainProfile ? profiles.find((candidate) => candidate.id === chainProfile) ?? configuredWorkerProfiles().find((candidate) => candidate.id === chainProfile) : undefined)
      : chosen?.profile ? profileById(chosen.profile) : undefined;
  // Automatic defaults resolve the final chain; an explicit selector stays exact.
  const automatic = classHit !== undefined || forceChain || (!explicit && (chosen === undefined || (chosen.model === undefined && (profile?.autoChain === true || (review && profile?.autoReviewChain === true)))));
  // Explicit native Pi reviewer waves retain configured role metadata. Implicit
  // all-reviewer waves are admitted separately by the official Claude boundary.
  const headRoute = (key: string | undefined) => {
    const slash = key?.indexOf("/") ?? -1;
    return key && slash > 0 ? { provider: key.slice(0, slash), id: key.slice(slash + 1) } : undefined;
  };
  const chainImages = input.requireImages === true;
  // Chains are resolved only for automatic selections, so an explicit selector never needs
  // (or fails on) a configured chain. A reviewer wave whose profile head keeps no chain of its
  // own leads with the operator's `reviewerChainHead`, when one is configured.
  const resolveChain = (): readonly { provider: string; id: string }[] => {
    if (classHit) return classHit.ordered.map((item) => item.entry.step);
    if (forceChain) return workerChainFor(undefined, chainImages);
    const head = headRoute(profile?.model);
    const config = routingConfig();
    const ownHead = head !== undefined && (config.tokenPlanChainHeads ?? []).some((entry) => entry.head.provider === head.provider && entry.head.id === head.id);
    return review && config.reviewerChainHead && !ownHead
      ? workerChainFor(config.reviewerChainHead, chainImages)
      : workerChainFor(head, chainImages);
  };
  const chain = automatic ? resolveChain() : [];
  const key = automatic ? undefined : profile?.model ?? chosen?.model;
  const model = classHit ? classHit.model : automatic
    ? selectChainedWorkerModel(registry, chain, { ...options, requireImages: input.requireImages === true })
    : key ? findModel(key, registry)
    : selectWorkerModel(parent, input.tasks.map((task) => task.role), registry, options);
  assertSubscriptionRequest(model, registry.isUsingOAuth(model));
  // Selection is not dispatch: lazy official proof is fetched at the call boundary.
  if (isTemporaryFreeModel(model)) assertTemporaryFreeRequest(model, undefined, undefined, false);
  // Authentication and dispatch membership consult the published catalog, never the
  // curated picker snapshot: an operator can still dispatch an authenticated route
  // that is deliberately not a picker choice (an ordered chain step).
  const dispatchCatalog = registry.getAll?.() ?? registry.getAvailable();
  if (!registry.hasConfiguredAuth(model) || !dispatchCatalog.some((candidate) => route(candidate) === route(model))) {
    throw new Error(`USAP model ${route(model)} is not available with configured authentication. Authenticate that provider in Pi; no fallback was selected.`);
  }
  if (!model.input?.includes("text") || typeof registry.getProvider(model.provider)?.streamSimple !== "function") {
    throw new Error(`USAP model ${route(model)} needs a native text/tool streaming adapter.`);
  }
  const images = model.input.includes("image");
  if (model.api === "pi-virtual" && (model.provider !== "steak-pi" || model.id !== "preferred-free")) throw new Error("USAP virtual worker route is not approved.");
  if (input.requireImages && !images) throw new Error(`USAP model ${route(model)} does not advertise image input. Select an authenticated vision model for image inspection; no fallback was selected.`);
  const thinkingLevel = selectWorkerThinking(model, profile?.thinking ?? inheritedThinking, input.thinking, input.thinkingReason);
  const result: { model: Model; thinkingLevel: Thinking; selection: ModelSelection; alternates?: ClassAlternate[] } = {
    model, thinkingLevel,
    selection: {
      provider: model.provider, modelId: model.id,
      ...(profile ? { profile: profile.id } : {}),
      ...(parentProfile ? { parentProfile: parentProfile.id } : {}),
      source: explicit ? "override" : automatic ? "chain" : configured ? "profile-default" : "legacy-default",
      ...(classWalk ? { taskClass: {
        name: classWalk.name,
        outcome: classHit ? "served" as const : "fallback" as const,
        reason: classHit ? `step ${classHit.index + 1} of ${classUsable.length} (${classHit.entry.entry}) launched`
          : classRanking && classRanking.excluded.length > 0 ? `every launchable step of the class chain is held out (${classRanking.excluded.map((item) => `${item.entry}: ${item.cause}`).join(" | ")})`
          : "no step of the class chain could launch",
        ...(classHit ? { step: classHit.entry.entry } : {}),
        ...(classRanking ? { decision: classRanking.decision } : {}),
        ...(classWalk.requiresTestGate ? { requiresTestGate: true } : {}),
        ...(classWalk.note ? { note: classWalk.note } : {}),
      } } : {}),
      // Ordered automatic routes, so a receipt shows the chain that produced the run.
      ...(automatic ? { chainRoutes: chain.map((step) => `${step.provider}/${step.id}`) } : {}),
      harness: "pi" as const,
      images, tools: true,
    },
  };
  assertWorkerSelectionOverride(requested, result.selection);
  // The ranked routes behind the winner, resolved now: a reply that comes back empty after its one retry moves to
  // the next of these without a new dispatch. A route whose profile runs an `ensure` hook is not offered, because
  // that hook only wraps the route the run started on.
  if (classHit) {
    const hooked = new Set((routingConfigOrEmpty().workerProfiles ?? []).filter((candidate) => candidate.ensure !== undefined).map((candidate) => candidate.id));
    const alternates = classHit.ordered.slice(1).flatMap((item): ClassAlternate[] => {
      if (item.entry.profile !== undefined && hooked.has(item.entry.profile)) return [];
      try {
        const level = selectWorkerThinking(item.model, profiles.find((candidate) => candidate.id === item.entry.profile)?.thinking ?? inheritedThinking, input.thinking, input.thinkingReason);
        return [{ entry: item.entry.entry, model: item.model, thinkingLevel: level, ...(item.entry.profile ? { profile: item.entry.profile } : {}) }];
      } catch { return []; }
    });
    if (alternates.length > 0) result.alternates = alternates;
  }
  return result;
}

/** A ranked class route behind the winner, resolved at dispatch for a per-task failover. */
export interface ClassAlternate { entry: string; model: Model; thinkingLevel: Thinking; profile?: string }

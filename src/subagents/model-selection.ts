import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertActiveModelIdentity, assertActiveModelSelector, SOL_MODEL_ROUTE, SOL_PROFILE } from "../retired-model-selection.ts";
import { assertModelRoute, assertSubscriptionRequest, selectChainedWorkerModel, selectWorkerModel, selectWorkerThinking,
  DEFAULT_MULTIMODAL_WORKER_CHAIN, DEFAULT_TEXT_WORKER_CHAIN, workerChainFor, type ChainOptions } from "../model-route-policy.ts";
import type { DispatchInput, ModelSelection } from "./types.ts";

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
   * Only the built-in default profile declares it; explicit selectors never chain. */
  autoChain?: boolean;
  /** Legacy native-Pi reviewer-chain label: reviewer-role automatic defaults
   * resolve the same routine subscription chain as workers instead of freezing
   * on this profile's head expert model. It is a routing flag, NOT expert
   * sign-off; reviews still need the explicit Opus Pass or override route. */
  autoReviewChain?: boolean;
}
/** Explicit model identities are unchanged. Routine role defaults use Go;
 * legacy native-review profiles keep their exact Pro/image chain. The dispatch
 * boundary handles automatic Opus -> Sol separately, never as a worker chain. */
export const BUILTIN_WORKER_PROFILES: readonly WorkerProfile[] = [
  { id: "steak-pi/gpt-6-astra", model: "openai-codex/gpt-6-astra", thinking: "medium", autoReviewChain: true,
    workerDefault: { profile: "steak-pi/opencode-go" }, reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
  { id: SOL_PROFILE, model: SOL_MODEL_ROUTE, thinking: "high",
    workerDefault: { profile: "steak-pi/opencode-go" }, reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
  { id: "steak-pi/gpt-6-luna", model: "openai-codex/gpt-6-luna", thinking: "high",
    workerDefault: { profile: "steak-pi/opencode-go" }, reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
  { id: "steak-pi/mimo-v2-6-flash", model: "xiaomi/mimo-v2.6-flash", thinking: "high", autoChain: true,
    workerDefault: { profile: "steak-pi/opencode-go" }, reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
  { id: "steak-pi/mimo-v2-6-pro", model: "xiaomi/mimo-v2.6-pro", thinking: "high", autoChain: true,
    workerDefault: { profile: "steak-pi/opencode-go" }, reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
  { id: "steak-pi/opencode-go", model: "opencode-go/deepseek-v4.1-flash", thinking: "high", autoChain: true,
    workerDefault: { profile: "steak-pi/opencode-go" }, reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
];
const PI_FAMILY_HARNESSES = new Set(["pi", "steak-pi"]);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

/** GLM 5.3, GLM 5.3 Flash and the Z.ai plan were retired by the operator on 2026-10-03. */
export const RETIRED_ROUTE = /(?:^|[/:])(?:zai|z-ai)\/|(?:^|\/)glm[-.]/i;
export const retiredRouteError = (route: string) =>
  `${route} is retired: GLM 5.3 and the Z.ai plan were removed on 2026-10-03. Use steak-pi/gpt-6-1-sol (openai-codex/gpt-6.1-sol) or the automatic default.`;

function selector(value: WorkerSelector, label: string): WorkerSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a model/profile selector.`);
  assertActiveModelSelector(value.model);
  assertActiveModelSelector(value.profile);
  for (const route of [value.model, value.profile]) {
    if (typeof route === "string" && RETIRED_ROUTE.test(route)) throw new Error(`${label}: ${retiredRouteError(route)}`);
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
export function loadRoleDefaults(path = join(homedir(), ".config", "ultraterm", "routing.json")): RoleDefaults {
  let config: any;
  try { config = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new Error("USAP routing.json cannot be read or parsed"); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("USAP routing.json requires an object");
  return Object.fromEntries(["workerDefault", "reviewerDefault"].filter(key => config[key] !== undefined)
    .map(key => [key, selector(config[key], `USAP routing.json ${key}`)]));
}

/** Read route metadata only. Never execute profile args, commands, or credentials. */
export function loadWorkerProfiles(directory = join(homedir(), ".config", "ultraterm", "harnesses")): WorkerProfile[] {
  const profiles = new Map(BUILTIN_WORKER_PROFILES.map((profile) => [profile.id, { ...profile }]));
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
      if (manifest.id === "steak-pi" && entry.id === "claude-opus-5-5") continue;
      if (typeof entry.id !== "string") continue;
      // Retired Sol is refused wherever the manifest names it, before any
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

/** Exact spellings pinned by the candidate manifest (docs/opus-5-5.models.json):
 * model ids `claude-sonnet-5-5` and `claude-opus-5-5`. The `claude-code`
 * provider namespace is deliberately NOT `anthropic/…`: that Pi registry route
 * would imply API-key billing, which this harness never touches (CLI OAuth
 * existing auth only, with API-key/billing override env stripped at spawn). */
export const CLAUDE_CODE_OPUS_MODEL = "claude-opus-5-5" as const;
export const CLAUDE_CODE_SONNET_MODEL = "claude-sonnet-5-5" as const;
/** The Opus Pass model, kept under its historical name for callers. */
export const CLAUDE_CODE_MODEL = CLAUDE_CODE_OPUS_MODEL;
export const CLAUDE_CODE_EFFORT = "xhigh" as const;
export const CLAUDE_CODE_OPUS_ROUTE = `claude-code/${CLAUDE_CODE_OPUS_MODEL}` as const;
export const CLAUDE_CODE_SONNET_ROUTE = `claude-code/${CLAUDE_CODE_SONNET_MODEL}` as const;
/** The Opus Pass route (expert review and explicit Opus escalation). */
export const CLAUDE_CODE_ROUTE = CLAUDE_CODE_OPUS_ROUTE;
export type ClaudeCodeModel = typeof CLAUDE_CODE_OPUS_MODEL | typeof CLAUDE_CODE_SONNET_MODEL;
export const CLAUDE_CODE_ROUTES: readonly string[] = [CLAUDE_CODE_SONNET_ROUTE, CLAUDE_CODE_OPUS_ROUTE];

/** The pinned Claude model behind a `claude-code/…` route, or undefined for
 * anything else (never a prefix or fuzzy match). */
export function claudeCodeModelOf(route: string | undefined): ClaudeCodeModel | undefined {
  if (route === CLAUDE_CODE_OPUS_ROUTE) return CLAUDE_CODE_OPUS_MODEL;
  if (route === CLAUDE_CODE_SONNET_ROUTE) return CLAUDE_CODE_SONNET_MODEL;
  return undefined;
}

/** Product name for messages: "Opus 5.5" / "Sonnet 5.5". */
export function claudeCodeModelName(model: ClaudeCodeModel): string {
  return model === CLAUDE_CODE_OPUS_MODEL ? "Opus 5.5" : "Sonnet 5.5";
}

/** Which Claude model a claude-code wave runs when the caller named none:
 * all-reviewer waves are expert review and take the Opus Pass; every other
 * wave is routine work and takes Sonnet 5.5, which preserves Opus quota. */
export function defaultClaudeCodeRoute(tasks: readonly { role?: string }[]): string {
  return tasks.length > 0 && tasks.every((task) => task.role === "reviewer") ? CLAUDE_CODE_OPUS_ROUTE : CLAUDE_CODE_SONNET_ROUTE;
}

/** The explicit foreign-harness routes in this USAP slice: the official
 * headless Claude Code CLI at xhigh effort on Sonnet 5.5 (the default Claude
 * worker) or Opus 5.5 (the operator's "Opus Pass" route for expert review and
 * frontier work). Both are override-provenance, never an automatic chain step,
 * and neither falls back to the other or to any other model. */
export function resolveClaudeCodeSelection(model: ClaudeCodeModel = CLAUDE_CODE_OPUS_MODEL): ModelSelection {
  return {
    provider: "claude-code",
    modelId: model,
    source: "override",
    harness: "claude-code",
    // Image review (P-0579) is the CLI's native Read tool on image files staged
    // under the run cwd. It is not an inline attachment or relay capability and
    // it never widens the Read/Grep/Glob allowlist, so it is advertised on both
    // pinned routes and nowhere else.
    images: true,
    tools: true,
  };
}

/** Admission for `requireImages: true` on the claude-code harness: only the exact
 * pinned Sonnet 5.5 or Opus 5.5 route passes, and the caller keeps the route it
 * asked for. There is no fallback, default or auth change; anything that is not
 * an exact route (undefined, prefix, fuzzy, other provider) fails closed. */
export function assertClaudeCodeImageAdmission(route: string | undefined): ClaudeCodeModel {
  const model = claudeCodeModelOf(route);
  if (model === undefined) {
    throw new Error(`USAP claude-code image review admits only ${CLAUDE_CODE_SONNET_ROUTE} or ${CLAUDE_CODE_OPUS_ROUTE} (staged image files read natively under cwd); no fallback was selected.`);
  }
  return model;
}

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
): { model: Model; thinkingLevel: Thinking; selection: ModelSelection } {
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
    return matches[0];
  };
  const parents = profiles.filter((p) => p.model === parentKey);
  const namedParent = parentProfileId && profiles.find((p) => p.id === parentProfileId || p.id === `${process.env.ULTRATERM_HARNESS_ID ?? process.env.ULTRATERM_HARNESS ?? "steak-pi"}/${parentProfileId}`);
  // A /model change must not inherit defaults belonging to a stale launch profile.
  const parentProfile = namedParent && namedParent.model === parentKey ? namedParent : parents.length === 1 ? parents[0] : undefined;
  const review = input.tasks.some((task) => task.role === "reviewer");
  const defaults = explicit ? {} : roleDefaults ?? loadRoleDefaults();
  const configured = review ? defaults.reviewerDefault ?? parentProfile?.reviewerDefault ?? parentProfile?.workerDefault : defaults.workerDefault ?? parentProfile?.workerDefault;
  const chosen = explicit ? selector({ ...(requested.model !== undefined ? { model: requested.model } : {}), ...(requested.profile !== undefined ? { profile: requested.profile } : {}) }, "USAP selection") : configured ? selector(configured, "USAP profile default") : undefined;
  const profile = chosen?.profile ? profileById(chosen.profile) : undefined;
  // Automatic defaults resolve the final chain; an explicit selector stays exact.
  const automatic = !explicit && (chosen === undefined || (chosen.model === undefined && (profile?.autoChain === true || (review && profile?.autoReviewChain === true))));
  // Explicit native Pi reviewer waves retain configured role metadata. Implicit
  // all-reviewer waves are admitted separately by the official Claude boundary.
  const headRoute = (key: string | undefined) => {
    const slash = key?.indexOf("/") ?? -1;
    return key && slash > 0 ? { provider: key.slice(0, slash), id: key.slice(slash + 1) } : undefined;
  };
  const chainImages = input.requireImages === true;
  const profileChain = workerChainFor(headRoute(profile?.model), chainImages);
  const chain = review && !chainImages && !["mimo-v2.6-pro", "mimo-v2.6-flash"].includes(headRoute(profile?.model)?.id ?? "")
    ? workerChainFor({ provider: "xiaomi", id: "mimo-v2.6-pro" }, chainImages)
    : profileChain;
  const key = automatic ? undefined : profile?.model ?? chosen?.model;
  const model = automatic
    ? selectChainedWorkerModel(registry, chain, { ...options, requireImages: input.requireImages === true })
    : key ? findModel(key, registry)
    : selectWorkerModel(parent, input.tasks.map((task) => task.role), registry, options);
  assertSubscriptionRequest(model, registry.isUsingOAuth(model));
  // Authentication and dispatch membership consult the published catalog, never the
  // curated picker snapshot: an operator can still dispatch an authenticated route
  // that is deliberately not a picker choice (the ordered chain's Go fallback).
  const dispatchCatalog = registry.getAll?.() ?? registry.getAvailable();
  if (!registry.hasConfiguredAuth(model) || !dispatchCatalog.some((candidate) => route(candidate) === route(model))) {
    throw new Error(`USAP model ${route(model)} is not available with configured authentication. Authenticate that provider in Pi; no fallback was selected.`);
  }
  if (!model.input?.includes("text") || typeof registry.getProvider(model.provider)?.streamSimple !== "function") {
    throw new Error(`USAP model ${route(model)} needs a native text/tool streaming adapter.`);
  }
  const images = model.input.includes("image");
  if (input.requireImages && !images) throw new Error(`USAP model ${route(model)} does not advertise image input. Select an authenticated vision model for image inspection; no fallback was selected.`);
  const thinkingLevel = selectWorkerThinking(model, profile?.thinking ?? inheritedThinking, input.thinking, input.thinkingReason);
  const result: { model: Model; thinkingLevel: Thinking; selection: ModelSelection } = {
    model, thinkingLevel,
    selection: {
      provider: model.provider, modelId: model.id,
      ...(profile ? { profile: profile.id } : {}),
      ...(parentProfile ? { parentProfile: parentProfile.id } : {}),
      source: explicit ? "override" : automatic ? "chain" : configured ? "profile-default" : "legacy-default",
      // Ordered automatic routes, so a receipt shows the chain that produced the run.
      ...(automatic ? { chainRoutes: chain.map((step) => `${step.provider}/${step.id}`) } : {}),
      harness: "pi" as const,
      images, tools: true,
    },
  };
  assertWorkerSelectionOverride(requested, result.selection);
  return result;
}

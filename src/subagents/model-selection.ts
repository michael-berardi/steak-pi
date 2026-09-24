import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assertSubscriptionRequest, selectChainedWorkerModel, selectWorkerModel, selectWorkerThinking,
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
export const BUILTIN_WORKER_PROFILES: readonly WorkerProfile[] = [
  { id: "steak-pi/glm-5-3-flash", model: "zai/glm-5.3-flash", thinking: "high",
    workerDefault: { profile: "steak-pi/mimo-v2-6-flash" },
    reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
  { id: "steak-pi/gpt-6-astra", model: "openai-codex/gpt-6-astra", thinking: "medium", autoReviewChain: true,
    workerDefault: { profile: "steak-pi/mimo-v2-6-flash" },
    // Reviewers keep the same automatic MiMo→ZAI subscription chain as every
    // other profile. Astra stays scarce — it is never an automatic route in any
    // role, and an explicit selector stays exact.
    reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
  // Parent-added GPT-6 routes (2026-09-23): exact explicit-selection profiles only.
  // Their workerDefault keeps routine workers on the MiMo→ZAI automatic chain, so
  // launching or selecting them never makes Sol or Luna an automatic worker, and
  // reviewer runs resolve the same routine subscription chain. High
  // reasoning applies to explicit runs of these profiles.
  { id: "steak-pi/gpt-6-sol", model: "openai-codex/gpt-6-sol", thinking: "high",
    workerDefault: { profile: "steak-pi/mimo-v2-6-flash" },
    reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
  { id: "steak-pi/gpt-6-luna", model: "openai-codex/gpt-6-luna", thinking: "high",
    workerDefault: { profile: "steak-pi/mimo-v2-6-flash" },
    reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" } },
  // Operator default for every routine worker: MiMo V2.6 Flash on the reviewed
  // Singapore Token Plan endpoint, resolved through the ordered automatic chain
  // (MiMo V2.6 Flash, then the ZAI coding subscription route) instead of this
  // profile's head model. Reviewer selectors keep their existing exact defaults.
  { id: "steak-pi/mimo-v2-6-flash", model: "xiaomi/mimo-v2.6-flash", thinking: "high",
    workerDefault: { profile: "steak-pi/mimo-v2-6-flash" },
    reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" }, autoChain: true },
  // Legacy operator default (2026-09-23) for every routine worker: MiMo V2.6 Pro on the
  // reviewed Singapore Token Plan endpoint, resolved through the ordered automatic
  // chain (MiMo V2.6 Pro, then the ZAI coding subscription route) instead of this
  // profile's head model. Reviewer runs resolve the same automatic routine
  // chain (xiaomi/mimo-v2.6-pro first, then the ZAI coding route). Profiles whose
  // reviewerDefault names an exact model — or a profile without an automatic
  // chain flag — stay exact and never gain a chain they did not declare.
  // Note: reviewerDefault applies only once a wave is routed to native Pi. The
  // extension sends an implicit all-reviewer wave to the official Claude Code
  // Opus route first, so reviewerDefault governs explicitly native reviewer waves.
  { id: "steak-pi/mimo-v2-6-pro", model: "xiaomi/mimo-v2.6-pro", thinking: "high",
    workerDefault: { profile: "steak-pi/mimo-v2-6-flash" },
    reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" }, autoChain: true },
  // Legacy Go profile, kept for exact explicit selection and for owner manifests that
  // still declare `workerDefault: steak-pi/opencode-go`: it carries the same automatic
  // chain, so an unmigrated owner default never falls back to a Go automatic route.
  { id: "steak-pi/opencode-go", model: "opencode-go/deepseek-v4.1-flash", thinking: "high",
    workerDefault: { profile: "steak-pi/mimo-v2-6-flash" },
    reviewerDefault: { profile: "steak-pi/mimo-v2-6-pro" }, autoChain: true },
];
const PI_FAMILY_HARNESSES = new Set(["pi", "steak-pi"]);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function selector(value: WorkerSelector, label: string): WorkerSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a model/profile selector.`);
  if (value.model !== undefined && value.profile !== undefined) throw new Error(`${label}: model and profile conflict; specify exactly one.`);
  for (const [key, field] of Object.entries(value)) {
    if (!["model", "profile"].includes(key) || typeof field !== "string" || !field.trim() || field !== field.trim() || field.length > 256) {
      throw new Error(`${label}: use one nonempty model or profile string (maximum 256 characters).`);
    }
  }
  if (!value.model && !value.profile) throw new Error(`${label} requires model or profile.`);
  return value;
}

/** Read route metadata only. Never execute profile args, commands, or credentials. */
export function loadWorkerProfiles(directory = join(homedir(), ".config", "ultraterm", "harnesses")): WorkerProfile[] {
  const profiles = new Map(BUILTIN_WORKER_PROFILES.map((profile) => [profile.id, { ...profile }]));
  let files: string[];
  try { files = readdirSync(directory).filter((name) => !name.startsWith(".") && name.endsWith(".json")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...profiles.values()]; throw new Error("USAP profile catalog cannot be read."); }
  const seen = new Set<string>();
  for (const file of files) {
    let manifest: { id?: string; executable?: string; profiles?: Array<{ id?: string; args?: string[]; workerDefault?: WorkerSelector; reviewerDefault?: WorkerSelector }> };
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
      if (typeof entry.id !== "string" || !Array.isArray(entry.args)) continue;
      const modelFlags = entry.args.filter((arg) => arg === "--model");
      if (modelFlags.length === 0) continue; // CLI-only profiles are not native model routes.
      if (modelFlags.length !== 1) throw new Error(`Ambiguous model route in profile ${manifest.id}/${entry.id}.`);
      const model = entry.args[entry.args.indexOf("--model") + 1];
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
 * model id `claude-opus-5-5`. The `claude-code` provider namespace is
 * deliberately NOT `anthropic/…`: that Pi registry route would imply API-key
 * billing, which this harness never touches (CLI OAuth existing auth only, with
 * API-key/billing override env stripped at spawn). */
export const CLAUDE_CODE_MODEL = "claude-opus-5-5" as const;
export const CLAUDE_CODE_EFFORT = "xhigh" as const;
export const CLAUDE_CODE_ROUTE = `claude-code/${CLAUDE_CODE_MODEL}` as const;

/** The one explicit foreign-harness route in this USAP slice: the official
 * headless Claude Code CLI on Opus 5.5 at xhigh effort (the operator's "Opus
 * Pass" route). It is override-provenance, never an automatic chain step, and
 * it never falls back to Astra or any other model. */
export function resolveClaudeCodeSelection(): ModelSelection {
  return {
    provider: "claude-code",
    modelId: CLAUDE_CODE_MODEL,
    source: "override",
    harness: "claude-code",
    // No advertised image inspection in this slice: requireImages is refused.
    images: false,
    tools: true,
  };
}

function route(model: Model): string { return `${model.provider}/${model.id}`; }
function findModel(key: string, registry: Registry): Model {
  const slash = key.indexOf("/");
  if (slash < 1 || slash === key.length - 1) throw new Error("USAP model must use the exact provider/model form.");
  const model = registry.find(key.slice(0, slash), key.slice(slash + 1));
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
): { model: Model; thinkingLevel: Thinking; selection: ModelSelection } {
  // The native Pi registry stream adapters cannot serve foreign harnesses.
  // Claude Code dispatch must branch to its explicit CLI route before selection;
  // fail closed here so no caller can route it through the registry by accident.
  if (input.harness === "claude-code") {
    throw new Error("USAP harness claude-code does not resolve through the native Pi registry; dispatch the explicit CLI route instead.");
  }
  // Capture caller intent once, before consulting task/profile/registry objects.
  const requested: WorkerSelector = { model: input.model, profile: input.profile };
  if (input.tasks.some((task) => "model" in task || "profile" in task)) {
    throw new Error("USAP model/profile selection is run-level only; split different routes into separate runs.");
  }
  if (input.requireImages !== undefined && typeof input.requireImages !== "boolean") throw new Error("requireImages must be a boolean.");
  const explicit = requested.model !== undefined || requested.profile !== undefined;
  const parentKey = route(parent);
  const profileById = (id: string): WorkerProfile => {
    const matches = profiles.filter((p) => p.id === id || (!id.includes("/") && p.id === `steak-pi/${id}`));
    if (matches.length !== 1) throw new Error(`USAP profile ${id} is unavailable or ambiguous; use its harness/profile identity.`);
    return matches[0];
  };
  const parents = profiles.filter((p) => p.model === parentKey);
  const namedParent = parentProfileId && profiles.find((p) => p.id === parentProfileId || p.id === `${process.env.ULTRATERM_HARNESS_ID ?? process.env.ULTRATERM_HARNESS ?? "steak-pi"}/${parentProfileId}`);
  // A /model change must not inherit defaults belonging to a stale launch profile.
  const parentProfile = namedParent && namedParent.model === parentKey ? namedParent : parents.length === 1 ? parents[0] : undefined;
  const review = input.tasks.some((task) => task.role === "reviewer");
  const configured = review ? parentProfile?.reviewerDefault ?? parentProfile?.workerDefault : parentProfile?.workerDefault;
  const chosen = explicit ? selector({ ...(requested.model !== undefined ? { model: requested.model } : {}), ...(requested.profile !== undefined ? { profile: requested.profile } : {}) }, "USAP selection") : configured ? selector(configured, "USAP profile default") : undefined;
  const profile = chosen?.profile ? profileById(chosen.profile) : undefined;
  // Automatic defaults resolve the final chain; an explicit selector stays exact.
  const automatic = !explicit && (chosen === undefined || (chosen.model === undefined && (profile?.autoChain === true || (review && profile?.autoReviewChain === true))));
  // The default reviewer role rides the same prepaid MiMo→ZAI subscription chain
  // as routine workers. No automatic expert step remains in the native review
  // chain: an expert review is a deliberate explicit choice (the Opus Pass CLI
  // route or an exact model/profile override), never a silent substitution.
  // An automatic profile that names a Token Plan model keeps it as the chain head.
  // Automatic reviewer runs stay on [MiMo V2.6 Pro, ZAI] unless their profile names
  // Flash; routine workers resolve the Flash-led default worker chain.
  const headRoute = (key: string | undefined) => {
    const slash = key?.indexOf("/") ?? -1;
    return key && slash > 0 ? { provider: key.slice(0, slash), id: key.slice(slash + 1) } : undefined;
  };
  const chainImages = input.requireImages === true;
  const profileChain = workerChainFor(headRoute(profile?.model), chainImages);
  const chain = review && profileChain[0].id === "mimo-v2.6-flash" && headRoute(profile?.model)?.id !== "mimo-v2.6-flash"
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

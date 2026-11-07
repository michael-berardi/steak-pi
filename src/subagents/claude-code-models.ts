/**
 * Claude Code CLI adapter catalog. This file names the CLI's own models because
 * the adapter must pin exact spellings; it is the one shipped place allowed to
 * (see test/neutrality.test.ts). No default here selects any of them: which
 * Claude model a defaulted claude-code wave, an implicit review or the quota
 * fallback tier runs is operator configuration (`claudeCodeDefaults`,
 * `implicitReview`, `claudeFallbackTier` in routing.json).
 */
import type { DispatchInput, ModelSelection, SubagentTaskInput } from "./types.ts";
import { missingConfigKey, routingConfig, RoutingConfigError } from "../routing-config.ts";

/** Exact spellings pinned by the candidate manifest (docs/opus-5-5.models.json):
 * model ids `claude-sonnet-5-5` and `claude-opus-5-5`. The `claude-code`
 * provider namespace is deliberately NOT `anthropic/…`: that Pi registry route
 * would imply API-key billing, which this harness never touches (CLI OAuth
 * existing auth only, with API-key/billing override env stripped at spawn). */
export const CLAUDE_CODE_OPUS_MODEL = "claude-opus-5-5" as const;
export const CLAUDE_CODE_SONNET_MODEL = "claude-sonnet-5-5" as const;
/** Haiku is an explicit subscription route like Sonnet and Opus (the operator's standing worker
 * chain includes it as a worker tier), with the same effort, account, quota and image rules.
 * It is still never a default: only an operator-configured tier or an exact name selects it. */
export const CLAUDE_CODE_HAIKU_MODEL = "claude-haiku-5-5" as const;
/** The largest pinned model, kept under its historical name for callers. */
export const CLAUDE_CODE_MODEL = CLAUDE_CODE_OPUS_MODEL;
/** Reasoning efforts a claude-code run may carry; anything else is refused by name. */
export const CLAUDE_CODE_EFFORTS = ["medium", "high", "xhigh"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];
/** Operator rule: every Claude model runs at medium effort unless the dispatch asks for more. */
export const CLAUDE_CODE_DEFAULT_EFFORT: ClaudeCodeEffort = "medium";
export const CLAUDE_CODE_OPUS_ROUTE = `claude-code/${CLAUDE_CODE_OPUS_MODEL}` as const;
export const CLAUDE_CODE_SONNET_ROUTE = `claude-code/${CLAUDE_CODE_SONNET_MODEL}` as const;
export const CLAUDE_CODE_HAIKU_ROUTE = `claude-code/${CLAUDE_CODE_HAIKU_MODEL}` as const;
export const CLAUDE_CODE_ROUTE = CLAUDE_CODE_OPUS_ROUTE;
export type ClaudeCodeModel = typeof CLAUDE_CODE_OPUS_MODEL | typeof CLAUDE_CODE_SONNET_MODEL | typeof CLAUDE_CODE_HAIKU_MODEL;
/** Routes a caller may name explicitly. Fable and older models are not listed and stay refused. */
export const CLAUDE_CODE_ROUTES: readonly string[] = [CLAUDE_CODE_HAIKU_ROUTE, CLAUDE_CODE_SONNET_ROUTE, CLAUDE_CODE_OPUS_ROUTE];
export type ClaudeCodeFallbackRoute = typeof CLAUDE_CODE_HAIKU_ROUTE | typeof CLAUDE_CODE_SONNET_ROUTE | typeof CLAUDE_CODE_OPUS_ROUTE;

/** A claude-code effort outside medium/high/xhigh, or high/xhigh asked for without a reason. */
export class ClaudeCodeEffortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeEffortError";
  }
}

export function isClaudeCodeEffort(value: unknown): value is ClaudeCodeEffort {
  return typeof value === "string" && (CLAUDE_CODE_EFFORTS as readonly string[]).includes(value);
}

/** The effort a claude-code (or claude-code-api) dispatch runs at: its own `thinking` when given,
 * else medium. high/xhigh need a concrete reason, like on the native route; low, max and every
 * other level are refused. */
export function resolveClaudeCodeEffort(thinking?: unknown, reason?: string): ClaudeCodeEffort {
  if (thinking === undefined) return CLAUDE_CODE_DEFAULT_EFFORT;
  if (!isClaudeCodeEffort(thinking)) {
    throw new ClaudeCodeEffortError(`Claude Code effort must be ${CLAUDE_CODE_EFFORTS.join(", ")}, not ${JSON.stringify(String(thinking).slice(0, 32))}; no run was started.`);
  }
  if (thinking !== CLAUDE_CODE_DEFAULT_EFFORT && (!reason || reason.trim().length < 16)) {
    throw new ClaudeCodeEffortError(`Claude Code ${thinking} effort needs a concrete task benefit in thinkingReason; it runs at ${CLAUDE_CODE_DEFAULT_EFFORT} by default.`);
  }
  return thinking;
}

/** The pinned Claude model behind a `claude-code/…` route, or undefined for
 * anything else (never a prefix or fuzzy match). */
export function claudeCodeModelOf(route: string | undefined): ClaudeCodeModel | undefined {
  if (route === CLAUDE_CODE_OPUS_ROUTE) return CLAUDE_CODE_OPUS_MODEL;
  if (route === CLAUDE_CODE_SONNET_ROUTE) return CLAUDE_CODE_SONNET_MODEL;
  if (route === CLAUDE_CODE_HAIKU_ROUTE) return CLAUDE_CODE_HAIKU_MODEL;
  return undefined;
}

/** Product name for messages: "Opus 5.5" / "Sonnet 5.5" / "Haiku 5.5". */
export function claudeCodeModelName(model: ClaudeCodeModel): string {
  return model === CLAUDE_CODE_OPUS_MODEL ? "Opus 5.5" : model === CLAUDE_CODE_HAIKU_MODEL ? "Haiku 5.5" : "Sonnet 5.5";
}

export interface ClaudeFallbackTier {
  route: ClaudeCodeFallbackRoute;
  model: ClaudeCodeModel;
  /** Why this tier, in the words a receipt and the dispatch note both carry. */
  reason: string;
}

const pinned = (route: string, key: string): { route: ClaudeCodeFallbackRoute; model: ClaudeCodeModel } => {
  const model = claudeCodeModelOf(route);
  if (!model) throw new RoutingConfigError(`~/.config/ultraterm/routing.json ${key}: ${route} is not a claude-code adapter route.`);
  return { route: route as ClaudeCodeFallbackRoute, model };
};

/** The operator's Claude subscription tier (`claudeFallbackTier`) for a wave whose configured
 * worker chain is out of quota, or undefined when none is configured (the wave then fails
 * with every cause). `substantial` takes substantial code work (a leaf that may edit AND run a
 * shell), any requested high/xhigh reasoning and every reviewer; `ordinary` takes the rest. The
 * choice reads only the dispatch's own declared capabilities, never the task text. */
export function claudeFallbackTier(
  input: Pick<DispatchInput, "thinking"> & { tasks: readonly Partial<SubagentTaskInput>[] },
): ClaudeFallbackTier | undefined {
  const tiers = routingConfig().claudeFallbackTier;
  if (!tiers) return undefined;
  const substantial = (reason: string): ClaudeFallbackTier => ({ ...pinned(tiers.substantial, "claudeFallbackTier.substantial"), reason });
  if (input.tasks.some((task) => task.role === "reviewer")) return substantial("a reviewer leaf needs the substantial tier");
  if (input.thinking === "high" || input.thinking === "xhigh") return substantial(`thinking ${input.thinking} was requested`);
  if (input.tasks.some((task) => task.mayEdit === true && task.allowBash === true)) {
    return substantial("substantial code work: a leaf may edit files and run a shell");
  }
  return { ...pinned(tiers.ordinary, "claudeFallbackTier.ordinary"),
    reason: "ordinary leaves (no leaf may both edit and run a shell, no high reasoning requested): the configured ordinary tier" };
}

/** Which Claude model a claude-code wave runs when the caller named none
 * (`claudeCodeDefaults`): all-reviewer waves take `reviewer` (else `worker`);
 * every other wave takes `worker`. Nothing configured fails with the key to set. */
export function defaultClaudeCodeRoute(tasks: readonly { role?: string }[]): string {
  const defaults = routingConfig().claudeCodeDefaults;
  const review = tasks.length > 0 && tasks.every((task) => task.role === "reviewer");
  const route = review ? defaults?.reviewer ?? defaults?.worker : defaults?.worker;
  if (!route) {
    throw new RoutingConfigError(`${missingConfigKey("Claude Code model", review ? "claudeCodeDefaults.reviewer" : "claudeCodeDefaults.worker")} Or name model ${CLAUDE_CODE_SONNET_ROUTE} / ${CLAUDE_CODE_OPUS_ROUTE} explicitly.`);
  }
  return pinned(route, review ? "claudeCodeDefaults.reviewer" : "claudeCodeDefaults.worker").route;
}

/** The explicit foreign-harness routes in this USAP slice: the official headless
 * Claude Code CLI on one of its pinned models, at medium effort unless the
 * dispatch asks for high/xhigh (see {@link resolveClaudeCodeEffort}). Both are
 * override-provenance, never an automatic chain step, and neither falls back to
 * the other or to any other model. */
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

/** Admission for `requireImages: true` on the claude-code harness: only an exact
 * explicit pinned route passes, and the caller keeps the route it asked for.
 * There is no fallback, default or auth change; anything that is not an exact
 * route (undefined, prefix, fuzzy, other provider) fails closed. */
export function assertClaudeCodeImageAdmission(route: string | undefined): ClaudeCodeModel {
  const model = claudeCodeModelOf(route);
  if (model === undefined) {
    throw new Error(`USAP claude-code image review admits only ${CLAUDE_CODE_ROUTES.join(", ")} (staged image files read natively under cwd); no fallback was selected.`);
  }
  return model;
}

/** The short profile name a claude-code route is offered under (`claude-code/claude-haiku-5-5` -> `haiku-5-5`),
 * the id the UltraTerm steak-pi manifest ships it with. */
export const claudeCodeProfileName = (route: string): string => route.replace(/^claude-code\/(?:claude-)?/, "");

/**
 * A worker profile id that names a Claude Code route, resolved independent of whichever harness manifest
 * the loader happened to read (the user's copy can lag the one the app bundles): a loaded profile whose
 * model is a `claude-code/<model>` route, or the route's own short name under any harness prefix
 * (`steak-pi/haiku-5-5`, `haiku-5-5`). `route` is a dispatchable subscription route; `refused` names why a
 * claude-code profile cannot run and which route to use instead. Undefined: not a Claude Code profile.
 */
export function claudeCodeRouteOfProfile(id: string, profiles: readonly { id: string; model: string }[]): { route: string } | { refused: string } | undefined {
  const loaded = profiles.filter((profile) => profile.id === id || (!id.includes("/") && profile.id === `steak-pi/${id}`));
  const viaProfile = loaded.length === 1 && loaded[0].model.startsWith("claude-code/") ? loaded[0].model : undefined;
  const short = id.slice(id.lastIndexOf("/") + 1);
  const viaName = viaProfile === undefined && loaded.length === 0 ? CLAUDE_CODE_ROUTES.find((route) => claudeCodeProfileName(route) === short) : undefined;
  const route = viaProfile ?? viaName;
  if (route === undefined) return undefined;
  if (CLAUDE_CODE_ROUTES.includes(route)) return { route };
  return { refused: `USAP profile ${id} names ${route}, which the claude-code harness does not run; use one of ${CLAUDE_CODE_ROUTES.join(", ")} (model: <route>).` };
}

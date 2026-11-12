import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { deferredToolsEnabled, setToolActive } from "./deferred-tools.ts";

/**
 * One package that adapts. A one-shot run (`print`, `json`) starts light: no dispatch, hub or todo tool and none of
 * their guidance. The dispatch and todo tools arrive once, for the rest of the session, when the work needs them: the
 * user's prompt asks for delegation, parallel work or task tracking, the run passes CALL_THRESHOLD tool calls, the
 * model asks through the small loader tool, or the session already holds a todo plan or checkpointed dispatch runs.
 * Interactive and hosted sessions (`tui`, `rpc`) keep every tool from the first request.
 *
 * What a mid-run change carries (settled with the scripted model, see benchmarks/overhead): the next request has the
 * new tool schemas, but the run's system prompt text is the one built before the prompt started, so the tools'
 * guidelines do not arrive with it. They are delivered in the tool result that carried the change instead.
 */
export const LOADER_TOOL = "load_tools";
export const DISPATCH_TOOL = "ultraterm_subagents";
export const HUB_TOOL = "ultraterm_hub";
export const TODO_TOOL = "todo";
/** Tools the light shape leaves out. The hub is not in GROWN_TOOLS: it follows the first dispatch, as before. */
export const LIGHT_OFF_TOOLS = [DISPATCH_TOOL, HUB_TOOL, TODO_TOOL] as const;
export const GROWN_TOOLS = [DISPATCH_TOOL, TODO_TOOL] as const;
/** Short tasks make 4 to 7 tool calls and long ones 10 to 40, so the tenth call marks long work. */
export const CALL_THRESHOLD = 10;

interface AdaptiveState { light: boolean; grown: boolean; reason?: string; signal?: string; calls: number }
const KEY = Symbol.for("steak-pi.adaptive-tools");

/** Process-wide on purpose: the extensions that raise a start signal load as separate modules. */
export function adaptiveState(): AdaptiveState {
  const holder = globalThis as unknown as Record<symbol, AdaptiveState | undefined>;
  return (holder[KEY] ??= { light: false, grown: false, calls: 0 });
}

export function resetAdaptiveState(): void {
  const state = adaptiveState();
  state.light = false; state.grown = false; state.calls = 0; delete state.reason; delete state.signal;
}

/** True while this run is in its light shape (tools not loaded yet). */
export function lightShapeActive(): boolean {
  const state = adaptiveState();
  return state.light && !state.grown;
}

export function isOneShotMode(mode: string | undefined): boolean {
  return mode === "print" || mode === "json";
}

/** An explicit tool selection from the operator always wins over the adaptive loadout. */
export function explicitToolSelection(argv: readonly string[] = process.argv): boolean {
  return argv.some((arg) => /^(--tools|--no-tools|--exclude-tools|-t|-nt)(=|$)/.test(arg));
}

export function lightShapeWanted(mode: string | undefined, env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): boolean {
  return isOneShotMode(mode) && deferredToolsEnabled(env) && !explicitToolSelection(argv);
}

const ASKS_FOR_HEAVY_TOOLS = new RegExp(
  "\\b(?:sub-?agents?|delegat\\w*|in parallel|parallel(?:ly)? (?:workers?|tasks?|agents?|waves?|work)|fan[- ]?out|" +
  "dispatch (?:the )?(?:tasks?|work|agents?|workers?|sub-?agents?)|spawn (?:\\w+ )?(?:agents?|workers?)|" +
  "ultraterm_subagents|to-?do (?:list|tool)|todo (?:list|tool)|task (?:list|tracking)|track (?:the |these |your |each )?(?:tasks|steps|progress))\\b",
  "i",
);

/** Whether the user's prompt asks for delegation, parallel work or task tracking. */
export function promptAsksForHeavyTools(prompt: string): boolean {
  return ASKS_FOR_HEAVY_TOOLS.test(prompt);
}

type GrowApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

/** Activate the dispatch and todo tools, once. Returns true only on the call that changed the tool list. */
export function growTools(pi: Partial<GrowApi>, reason: string): boolean {
  const state = adaptiveState();
  if (state.grown) return false;
  state.grown = true;
  state.reason = reason;
  let changed = false;
  for (const name of GROWN_TOOLS) changed = setToolActive(pi, name, true) || changed;
  return changed;
}

/** The guidelines of the tools that just arrived, as text: the run's own system prompt cannot take them mid-run. */
export function growthGuidance(pi: Pick<ExtensionAPI, "getAllTools">): string {
  let tools: ReturnType<ExtensionAPI["getAllTools"]> = [];
  try { tools = pi.getAllTools(); } catch { /* guidance is advisory */ }
  const parts = [`Tools now available: ${GROWN_TOOLS.join(", ")}. Use ${DISPATCH_TOOL} for independent parallel work and ${TODO_TOOL} for tracked work.`];
  for (const name of GROWN_TOOLS) {
    const lines = tools.find((tool) => tool.name === name)?.promptGuidelines ?? [];
    if (lines.length > 0) parts.push(`${name}:\n${lines.map((line) => `- ${line}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * A session start signal (a todo plan, checkpointed dispatch runs) means the work already needs the tools. It may
 * arrive before or after the adaptive extension has decided the starting shape: before, it is remembered; after, the
 * tools are loaded now (still before the first request, so nothing is sent without them).
 */
export function signalStart(pi: Partial<GrowApi>, reason: string): void {
  const state = adaptiveState();
  if (state.grown) return;
  if (state.light) growTools(pi, reason);
  else state.signal ??= reason;
}

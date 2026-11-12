import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setToolActive } from "../src/deferred-tools.ts";
import {
  adaptiveState, CALL_THRESHOLD, DISPATCH_TOOL, growthGuidance, growTools, LIGHT_OFF_TOOLS, LOADER_TOOL,
  lightShapeWanted, promptAsksForHeavyTools,
} from "../src/adaptive-tools.ts";

/**
 * Adaptive tool loadout (see src/adaptive-tools.ts). Interactive and hosted sessions are untouched; a one-shot run
 * starts light and grows once, on a prompt that asks for it, on the tenth tool call, or when the model calls the loader.
 */
export default function adaptiveTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: LOADER_TOOL,
    label: "Load tools",
    description: "Load the delegation and task-list tools. Call it for long, parallel or tracked work.",
    parameters: Type.Object({}),
    async execute() {
      growTools(pi, "loader");
      return { content: [{ type: "text", text: growthGuidance(pi) }], details: {} };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const state = adaptiveState();
    const registered = (() => { try { return pi.getAllTools().some((tool) => tool.name === DISPATCH_TOOL); } catch { return false; } })();
    // Without the dispatch tool (explicitly left out) there is nothing to load, so the loader stays out too.
    if (!registered || !lightShapeWanted(ctx.mode)) {
      setToolActive(pi, LOADER_TOOL, false);
      return;
    }
    state.light = true;
    if (state.signal) { state.grown = true; state.reason = state.signal; return; } // a start signal (todo plan, checkpointed runs) already asked for the tools
    if (state.grown) return;
    for (const name of LIGHT_OFF_TOOLS) setToolActive(pi, name, false);
  });

  // The prompt asks for delegation, parallel work or tracking: load before the system prompt is built, so the
  // guidance arrives with the first request in its normal place.
  pi.on("input", (event) => {
    if (adaptiveState().light && !adaptiveState().grown && promptAsksForHeavyTools(event.text)) growTools(pi, "prompt");
    return undefined;
  });

  pi.on("tool_result", (event) => {
    const state = adaptiveState();
    if (!state.light || event.toolName === LOADER_TOOL) return undefined;
    state.calls += 1;
    if (state.grown || state.calls < CALL_THRESHOLD) return undefined;
    growTools(pi, "calls");
    return { content: [...event.content, { type: "text" as const, text: growthGuidance(pi) }] };
  });
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Deferred tool exposure. Tools that can only do useful work after some
 * session event (a compaction, a first subagent run, a large tool result)
 * stay registered but inactive until then, so their schemas are not sent on
 * every request. Activation happens once and never flips back within a
 * session, so the tool list changes at most once per tool: the next request
 * sees the tool, and the provider prompt cache pays for one change, not one
 * per turn.
 */
type ToolToggleApi = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

export function setToolActive(pi: Partial<ToolToggleApi>, name: string, active: boolean): boolean {
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return false;
  let current: string[];
  try { current = pi.getActiveTools(); } catch { return false; }
  const has = current.includes(name);
  if (has === active) return false;
  try {
    pi.setActiveTools(active ? [...current, name] : current.filter((tool) => tool !== name));
  } catch { return false; }
  return true;
}

/** Opt-out for operators who want every tool on every request. */
export function deferredToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|off|no)$/i.test(env.STEAK_PI_DEFER_TOOLS?.trim() ?? "");
}

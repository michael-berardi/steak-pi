import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

/** Thinking level sent as `generation_config.thinking_level`; the Interactions API also takes `xhigh`. */
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "max">;

/**
 * Upstream pi-ai `resolveGoogleThinkingLevel` with the `xhigh` case PR 12614 adds. The pinned Pi's copy stops at
 * `high`, so Neon and Hydrogen at xhigh would fail there.
 */
export function resolveGoogleThinkingLevel(model: Model<any>, level: ThinkingLevel): ResolvedGoogleThinkingLevel {
	const mapped = model.thinkingLevelMap?.[level];
	const resolved = typeof mapped === "string" ? mapped.toLowerCase() : level;
	switch (resolved) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
		case "xhigh":
			return resolved;
		default:
			throw new Error(`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`);
	}
}

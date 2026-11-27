import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";

// Fixed list from PR 12614 (`packages/ai/catalog/providers/google-ai-plan.ts`): the plan has no model list endpoint,
// so Google's partner docs require this list. Usage is covered by the plan: no cost.
// Thinking levels per the partner docs: Neon and Hydrogen low..xhigh, Carbon low..high, Flash-Lite minimal..high.
export const PROVIDER_ID = "google-ai-plan";
export const API_ID = "google-interactions";
export const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const XHIGH: ThinkingLevelMap = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null };
const HIGH: ThinkingLevelMap = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null };
const FLASH_LITE: ThinkingLevelMap = { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };

const CATALOG: { id: string; name: string; thinkingLevelMap: ThinkingLevelMap }[] = [
	{ id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", thinkingLevelMap: XHIGH },
	{ id: "gemini-4-neon", name: "Gemini 4 Neon", thinkingLevelMap: XHIGH },
	{ id: "gemini-4-carbon", name: "Gemini 4 Carbon", thinkingLevelMap: HIGH },
	{ id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", thinkingLevelMap: FLASH_LITE },
];

export const GOOGLE_AI_PLAN_MODELS: Record<string, Model<typeof API_ID>> = Object.fromEntries(
	CATALOG.map(({ id, name, thinkingLevelMap }) => [
		id,
		{
			id,
			name,
			api: API_ID,
			provider: PROVIDER_ID,
			baseUrl: BASE_URL,
			reasoning: true,
			thinkingLevelMap,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		} satisfies Model<typeof API_ID>,
	]),
);

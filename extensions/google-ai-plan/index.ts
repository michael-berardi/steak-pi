// Google AI Ultra plan provider, ported from earendil-works/pi PR 12614 until the pinned Pi ships it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoogleAiPlanProvider } from "./provider.ts";

/** A variable specifier: the module exists only in a Pi that ships the provider, so typecheck must not resolve it. */
const BUILTIN_SPECIFIER: string = "@earendil-works/pi-ai/providers/google-ai-plan";

/** True when the running Pi already ships the PR's provider (pi-ai `providers/google-ai-plan`). */
export async function piShipsGoogleAiPlan(load: () => Promise<unknown> = () => import(BUILTIN_SPECIFIER)): Promise<boolean> {
	try {
		const module = (await load()) as { googleAiPlanProvider?: unknown } | undefined;
		return typeof module?.googleAiPlanProvider === "function";
	} catch {
		return false;
	}
}

export default async function googleAiPlanExtension(pi: ExtensionAPI): Promise<void> {
	// Pi's own provider carries pi's Google-approved client; the port steps aside instead of replacing it.
	if (await piShipsGoogleAiPlan()) return;
	pi.registerProvider(createGoogleAiPlanProvider());
}

// Google AI Ultra plan provider, ported from earendil-works/pi PR 12614 until the pinned Pi ships it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGoogleAiPlanProvider } from "./provider.ts";

export default function googleAiPlanExtension(pi: ExtensionAPI): void {
	pi.registerProvider(createGoogleAiPlanProvider());
}

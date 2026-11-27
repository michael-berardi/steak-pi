import { createProvider, type OAuthAuth, type Provider } from "@earendil-works/pi-ai";
import { googleAiPlanClient } from "./client.ts";
import { createGoogleAiPlanOAuth } from "./google-ai-plan.ts";
import { stream, streamSimple } from "./google-interactions.ts";
import { API_ID, BASE_URL, GOOGLE_AI_PLAN_MODELS, PROVIDER_ID } from "./models.ts";

/**
 * Google AI Ultra plan provider (PR 12614): Google OAuth with DPoP, models on the plan's per-user quota. The OAuth
 * client is read when a sign-in or refresh runs, so a missing client is a named error there, never at startup.
 */
export function createGoogleAiPlanProvider(env: Record<string, string | undefined> = process.env): Provider<typeof API_ID> {
	const flow = (): OAuthAuth => createGoogleAiPlanOAuth(googleAiPlanClient(env));
	return createProvider({
		id: PROVIDER_ID,
		name: "Google AI Ultra plan",
		baseUrl: BASE_URL,
		auth: {
			oauth: {
				name: "Google AI Ultra plan",
				isSubscription: true,
				loginLabel: "Sign in with Google (AI Ultra)",
				login: (interaction, options) => flow().login(interaction, options),
				refresh: (credential, signal) => flow().refresh(credential, signal),
				toAuth: (credential) => flow().toAuth(credential),
			},
		},
		models: Object.values(GOOGLE_AI_PLAN_MODELS),
		api: { stream, streamSimple },
	});
}

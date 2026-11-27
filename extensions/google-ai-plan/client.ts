import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GoogleAiPlanClient } from "./google-ai-plan.ts";

/**
 * The Google `Desktop app` OAuth client used for the Google AI Ultra plan sign-in. Google approves each app's client
 * separately (PR 12614), so Steak Pi ships none: the operator supplies one, either with both
 * `STEAK_PI_GOOGLE_AI_PLAN_CLIENT_ID` and `STEAK_PI_GOOGLE_AI_PLAN_CLIENT_SECRET`, or in
 * `~/.pi/agent/google-ai-plan-client.json` (`{ "clientId": "...", "clientSecret": "..." }`, under
 * `PI_CODING_AGENT_DIR` when set). Without one, sign-in fails with this named error.
 */
export class GoogleAiPlanClientError extends Error {}

export const clientConfigPath = (env: Record<string, string | undefined> = process.env): string =>
	join(env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME || homedir(), ".pi", "agent"), "google-ai-plan-client.json");

export function googleAiPlanClient(env: Record<string, string | undefined> = process.env): GoogleAiPlanClient {
	const clientId = env.STEAK_PI_GOOGLE_AI_PLAN_CLIENT_ID?.trim();
	const clientSecret = env.STEAK_PI_GOOGLE_AI_PLAN_CLIENT_SECRET?.trim();
	if (clientId || clientSecret) {
		if (!clientId || !clientSecret) {
			throw new GoogleAiPlanClientError("Set both STEAK_PI_GOOGLE_AI_PLAN_CLIENT_ID and STEAK_PI_GOOGLE_AI_PLAN_CLIENT_SECRET, or neither");
		}
		return { clientId, clientSecret };
	}
	const path = clientConfigPath(env);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		throw new GoogleAiPlanClientError(
			code === "ENOENT"
				? `No Google AI Ultra plan OAuth client is configured: add ${path} with clientId and clientSecret, or set STEAK_PI_GOOGLE_AI_PLAN_CLIENT_ID and _SECRET (see docs/GOOGLE-AI-PLAN.md)`
				: `Cannot read ${path}: ${(error as Error).message}`,
		);
	}
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { throw new GoogleAiPlanClientError(`${path} is not valid JSON`); }
	const { clientId: id, clientSecret: secret } = (parsed ?? {}) as Record<string, unknown>;
	if (typeof id !== "string" || !id.trim() || typeof secret !== "string" || !secret.trim()) {
		throw new GoogleAiPlanClientError(`${path} needs non-empty string clientId and clientSecret`);
	}
	return { clientId: id.trim(), clientSecret: secret.trim() };
}

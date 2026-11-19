import { createProvider } from "@earendil-works/pi-ai";
import { AgyError } from "./errors.ts";
import { API_ID, listAgyModels, PROVIDER_ID, toPiModel } from "./models.ts";
import { streamAgy } from "./stream.ts";

export const MARKER_KEY = "agy-external";

/** Status for `agy-status` and for check(): ok with the model count, or the named cause. */
export async function agyStatus(signal?: AbortSignal): Promise<{ ok: true; models: number } | { ok: false; error: AgyError }> {
  try { return { ok: true, models: (await listAgyModels(process.env, signal)).length }; }
  catch (error) { return { ok: false, error: error instanceof AgyError ? error : new AgyError("failed", String((error as Error)?.message ?? error)) }; }
}

export function createAgyProvider() {
  return createProvider({
    id: PROVIDER_ID,
    name: "Google Antigravity CLI (agy)",
    baseUrl: "process://agy",
    auth: {
      apiKey: {
        name: "agy sign-in",
        // Configured only when agy is installed and signed in, so Pi hides the models otherwise. agy owns its credentials.
        async check({ signal }) {
          const status = await agyStatus(signal);
          return status.ok ? { type: "api_key" as const, source: "Antigravity CLI (agy)" } : undefined;
        },
        async resolve({ signal }) {
          signal.throwIfAborted();
          return { auth: { apiKey: "external-process" }, source: "Antigravity CLI (agy)" };
        },
      },
    },
    models: [],
    async fetchModels({ signal }) {
      return (await listAgyModels(process.env, signal)).map(toPiModel);
    },
    api: { stream: streamAgy, streamSimple: streamAgy },
  });
}

export { API_ID, PROVIDER_ID };

import { createProvider } from "@earendil-works/pi-ai";
import type { Session } from "./client.ts";
import { API_ID, PROVIDER_ID, type AntigravityConfig } from "./config.ts";
import { listModels } from "./models.ts";
import { createOAuth } from "./oauth.ts";
import { createStream } from "./stream.ts";

/** The provider. It carries no models of its own: a signed-in account's live list is the only source. */
export function createAntigravityProvider(config: AntigravityConfig) {
  const stream = createStream(config);
  return createProvider({
    id: PROVIDER_ID,
    name: "Google Antigravity",
    baseUrl: config.baseUrls[0],
    auth: { oauth: createOAuth(config) },
    models: [],
    async fetchModels({ credential, signal }) {
      // Not signed in: no models, and no network call.
      if (!credential || credential.type !== "oauth") return [];
      const projectId = typeof credential.projectId === "string" ? credential.projectId : config.projectId;
      if (!projectId) return [];
      const session: Session = { token: credential.access, projectId };
      return listModels(config, session, { signal });
    },
    api: { stream, streamSimple: stream },
  });
}

export { API_ID, PROVIDER_ID };

import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The startup providers are loaded from the SDK's pi-ai package, which may be
 * separate from the copy bundled into Pi. Dispose that copy's resources too. */
export function providerSessionCleanup(): (sessionId: string) => void {
  const sdk = findPackageJSON(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const ai = sdk && findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdk));
  if (!sdk || !ai) throw new Error("Native provider session cleanup is unavailable.");
  const { cleanupSessionResources } = createRequire(sdk)(join(dirname(ai), "dist/index.js"));
  if (typeof cleanupSessionResources !== "function") throw new Error("Native provider session cleanup is unavailable.");
  return (sessionId) => {
    if (!sessionId) throw new Error("Cannot clean up provider resources without a session ID.");
    cleanupSessionResources(sessionId);
  };
}

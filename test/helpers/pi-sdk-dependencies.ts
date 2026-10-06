import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const sdkRequire = createRequire(sdkEntry);

function resolveAiEntry(): string {
  try {
    return sdkRequire.resolve("@earendil-works/pi-ai");
  } catch (error) {
    // Official Pi 1.0.4 has import-only exports. Node's ESM package resolver
    // still starts at the SDK entry, not at this test's potentially different AI.
    if ((error as NodeJS.ErrnoException).code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    const manifest = findPackageJSON("@earendil-works/pi-ai", sdkEntry);
    if (!manifest) throw new Error("Cannot resolve the SDK's pi-ai package");
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const entry = pkg.exports?.["."]?.import;
    if (typeof entry !== "string") throw new Error("Unsupported pi-ai public import export");
    return resolve(dirname(manifest), entry);
  }
}

export const sdkPiAiUrl = pathToFileURL(resolveAiEntry()).href;

/** Unexported fixture APIs come from the same resolved AI distribution. */
export function sdkPiAiInternalUrl(relativePath: string): string {
  return pathToFileURL(resolve(dirname(fileURLToPath(sdkPiAiUrl)), relativePath)).href;
}

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKER_PI_DEPENDENCIES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;

/** Resolve only against the actual Pi CLI package hosting this process.
 * Pi 0.87 exports its SDK for ESM `import` only: createRequire.resolve() cannot
 * see it even when the package is installed. Read the host's import export
 * directly, without loading code or scanning globals, cwd, or runtime trees.
 */
function hostPiImport(specifier: string, hostEntrypoint: string): string {
  let root = dirname(realpathSync(hostEntrypoint));
  while (true) {
    try {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
      if (manifest.name === "@earendil-works/pi-coding-agent") break;
    } catch { /* Keep walking only the canonical host entrypoint's ancestors. */ }
    const parent = dirname(root);
    if (parent === root) throw new Error("Host is not a Pi SDK package");
    root = parent;
  }
  const packageRoot = specifier === "@earendil-works/pi-coding-agent"
    ? root : join(dirname(root), "pi-tui");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    name?: string; main?: string; exports?: string | Record<string, unknown>;
  };
  if (manifest.name !== specifier) throw new Error("Host Pi peer identity mismatch");
  const dot = typeof manifest.exports === "object" && manifest.exports !== null
    ? manifest.exports["."] : manifest.exports;
  // A declared exports map without an import condition is intentionally not
  // replaced with `main` or `require`: that would hide a broken SDK install.
  const target = manifest.exports !== undefined
    ? (typeof dot === "string" ? dot : typeof dot === "object" && dot !== null
      ? (dot as Record<string, unknown>).import : undefined)
    : manifest.main;
  if (typeof target !== "string" || isAbsolute(target)) throw new Error("Host Pi import export is missing");
  const resolved = realpathSync(join(packageRoot, target));
  const inside = relative(realpathSync(packageRoot), resolved);
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || !statSync(resolved).isFile()) {
    throw new Error("Host Pi import export escapes its package or is not a file");
  }
  return pathToFileURL(resolved).href;
}

/** Resolve an extension's own installed peers first, then its actual Pi host.
 * Broken local exports remain errors rather than silently switching SDKs.
 */
export function resolveWorkerDependency(
  specifier: string,
  localResolve: (specifier: string) => string,
  hostEntrypoint: string | undefined = process.argv[1],
): string {
  try {
    return localResolve(specifier);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") throw error;
    if (!hostEntrypoint || !WORKER_PI_DEPENDENCIES.includes(specifier as typeof WORKER_PI_DEPENDENCIES[number])) throw error;
    try { return hostPiImport(specifier, hostEntrypoint); }
    catch { throw error; } // Preserve the original actionable installation diagnostic.
  }
}

/** The resolver MUST be import.meta.resolve from the worker entrypoint itself.
 * Passing a manager's resolver (or require.resolve) checks a different context.
 * Resolution does not evaluate SDK code, access credentials, or install packages.
 */
export function assertWorkerDependencies(entrypoint: string, resolve: (specifier: string) => string): void {
  let root = dirname(fileURLToPath(entrypoint));
  while (true) {
    try {
      readFileSync(join(root, "package.json"));
      break;
    } catch {
      const parent = dirname(root);
      if (parent === root) break;
      root = parent;
    }
  }
  const failures: Error[] = [];
  for (const specifier of WORKER_PI_DEPENDENCIES) {
    try {
      const resolved = resolve(specifier);
      // import.meta.resolve can return a file URL even when an exports target
      // has vanished. Check the target too, without guessing node_modules paths.
      if (!statSync(fileURLToPath(resolved)).isFile()) {
        throw new Error(`Resolved entry is not a file: ${resolved}`);
      }
    } catch (cause) {
      failures.push(new Error(`Cannot resolve ${specifier} from ${entrypoint}`, { cause }));
    }
  }
  if (failures.length) {
    throw new Error(
      `USAP worker dependency preflight failed: ${failures.map((error) => error.message).join("; ")}. ` +
      `Repair the dependency installation at package root ${JSON.stringify(root)} ` +
      `(for a writable checkout: cd ${JSON.stringify(root)} && npm install --no-audit --no-fund). ` +
      "Ensure declared Pi peers are installed, not omitted. For an immutable runtime, rebuild its candidate instead. " +
      "No usable peer was found via the worker resolver or its explicit host fallback. No worker session started; no automatic install or model fallback.",
      { cause: new AggregateError(failures, "Worker dependency resolution failures") },
    );
  }
}

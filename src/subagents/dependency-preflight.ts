import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKER_PI_DEPENDENCIES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;

/** Resolve a git-installed extension against its own peers first, then the
 * actual running host. Never search globals, cwd, runtime trees or install peers.
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
    try {
      // Resolve symlinked launchers to the package actually hosting this process.
      const require = createRequire(realpathSync(hostEntrypoint));
      return pathToFileURL(require.resolve(specifier)).href;
    } catch {
      throw error; // Preserve the original actionable installation diagnostic.
    }
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

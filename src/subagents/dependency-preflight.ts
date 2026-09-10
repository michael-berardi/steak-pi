import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_PI_DEPENDENCIES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
] as const;

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
      "A manager/global Pi installation is not a substitute. No worker session started; no automatic install or model fallback.",
      { cause: new AggregateError(failures, "Worker dependency resolution failures") },
    );
  }
}

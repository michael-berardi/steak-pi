/**
 * A node path that survives a package-manager upgrade.
 *
 * `process.execPath` is a realpath. Under Homebrew it is `<prefix>/Cellar/<formula>/<version>/bin/node`, and a
 * `brew upgrade` deletes that directory while a long-running session keeps going. Every later child spawn that used it
 * then failed with `spawn <old Cellar path> ENOENT` (2026-11-18: two sessions died that way). The stable name for the
 * same keg is the `<prefix>/opt/<formula>/bin/node` link, which Homebrew repoints on upgrade.
 *
 * Call `stableNodePath()` at each spawn, never once at startup, so an upgrade in the middle of a session is survived.
 * It never throws anything but `NodeRuntimeMovedError`, which callers surface as a normal error instead of an
 * uncaught `error` event on a child process.
 */
import { accessSync, constants, statSync } from "node:fs";

export const NODE_PATH_ENV = "STEAK_PI_NODE";

export class NodeRuntimeMovedError extends Error {
  readonly code = "ERR_NODE_RUNTIME_MOVED";
  readonly oldPath: string;
  constructor(oldPath: string) {
    super(`node runtime moved: ${oldPath}; restart this session`);
    this.name = "NodeRuntimeMovedError";
    this.oldPath = oldPath;
  }
}

export interface NodePathDeps {
  execPath: string;
  env: Record<string, string | undefined>;
  isExecutable: (path: string) => boolean;
}

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `<prefix>/Cellar/<formula>/<version>/bin/node` -> `<prefix>/opt/<formula>/bin/node`, or undefined for any other path. */
export function homebrewOptNodePath(execPath: string): string | undefined {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  return match ? `${match[1]}/opt/${match[2]}/bin/node` : undefined;
}

function defaultDeps(): NodePathDeps {
  return { execPath: process.execPath, env: process.env, isExecutable: isExecutableFile };
}

/** Explicit override, then the stable Homebrew opt link, then `execPath` if it still exists; else a named error. */
export function stableNodePath(deps: Partial<NodePathDeps> = {}): string {
  const { execPath, env, isExecutable } = { ...defaultDeps(), ...deps };
  const override = env[NODE_PATH_ENV]?.trim();
  if (override && isExecutable(override)) return override;
  const opt = homebrewOptNodePath(execPath);
  if (opt && isExecutable(opt)) return opt;
  if (isExecutable(execPath)) return execPath;
  throw new NodeRuntimeMovedError(execPath);
}

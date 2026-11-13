import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pi keeps one cached catalog row per provider in models-store.json, shared by every running Pi on the machine. Each
 * running Steak Pi writes its own discovery result there, so after an upgrade a pane still running the older release
 * could replace the newer catalog with its own shorter one. The row therefore carries the version that wrote it.
 *
 * Rule: a discovery result that would store FEWER models than the stored row is not written when the stored row was
 * written by a NEWER Steak Pi than this one. Every other result is written and stamped with this version: the same or
 * a newer version may shrink the row (an account can lose a model), and any version may grow it.
 */
export const VERSION_MARKER = "steakPiVersion";

export interface CatalogRow {
  models: readonly { id: string; provider?: string }[];
  checkedAt?: number;
}

function parts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Negative when `left` is the older release, positive when newer, 0 when equal or either is not a release version. */
export function compareVersions(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

/** The Steak Pi version that wrote a stored row; undefined for a row written before the marker existed. */
export function rowVersion(row: CatalogRow | undefined): string | undefined {
  const value = (row as Record<string, unknown> | undefined)?.[VERSION_MARKER];
  return typeof value === "string" && parts(value) ? value : undefined;
}

/** Whether this version must leave the stored row in place instead of storing `fetchedCount` models. */
export function keepsStoredRow(stored: CatalogRow | undefined, fetchedCount: number, ownVersion: string | undefined): boolean {
  const writer = rowVersion(stored);
  if (!stored || !writer || !ownVersion) return false;
  return fetchedCount < stored.models.length && compareVersions(ownVersion, writer) < 0;
}

/**
 * Whether a stored row must not replace this session's own discovery in memory: it was written by an older Steak Pi
 * (or one from before the marker) and lacks a model this session discovered itself.
 */
export function storedRowIsOlderAndShorter(stored: CatalogRow, own: CatalogRow, ownVersion: string | undefined): boolean {
  if (!ownVersion) return false;
  const writer = rowVersion(stored);
  if (writer && compareVersions(writer, ownVersion) >= 0) return false;
  const ids = new Set(stored.models.map((model) => model.id));
  return own.models.some((model) => !ids.has(model.id));
}

/** This package's version, or undefined when the extension runs outside the Steak Pi package. */
export function steakPiVersion(root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    return manifest.name === "steak-pi" && typeof manifest.version === "string" && parts(manifest.version) ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

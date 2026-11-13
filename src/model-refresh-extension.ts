// Loaded by `steak-pi update --models` into the installed Pi (pi -e <this file>), next to the operator's own
// extensions. Pi's `pi update --models` refreshes catalogs without loading extensions, so a provider an extension
// registers keeps its cached row; here every provider is registered before the refresh runs.
// Inert unless STEAK_PI_MODEL_REFRESH_RESULT names the file the result is written to.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RESULT_ENV = "STEAK_PI_MODEL_REFRESH_RESULT";

export interface ProviderRefresh {
  provider: string;
  status: "refreshed" | "failed" | "skipped";
  /** Models in the provider's catalog after the refresh. */
  models?: number;
  /** The provider's error, or why nothing was fetched. */
  detail?: string;
}

export interface ModelRefreshReport {
  providers: ProviderRefresh[];
  /** Providers Pi did not fetch because no credential is configured for them. */
  unconfigured: number;
  ok: boolean;
}

/** The part of Pi's model registry the refresh uses. */
export interface RefreshRegistry {
  refresh(options: { allowNetwork: boolean; force: boolean; providers?: readonly string[]; signal?: AbortSignal }): Promise<{ aborted: boolean; errors: ReadonlyMap<string, Error> }>;
  getAll(): readonly { provider: string }[];
  getRegisteredProviderIds(): readonly string[];
  getProviderAuthStatus(provider: string): { configured: boolean };
  /** The registered provider, to tell one with a refreshable catalog (refreshModels) from one with a fixed list. */
  getProvider?(provider: string): { refreshModels?: unknown } | undefined;
}

type Store = Record<string, { models?: unknown; checkedAt?: unknown } | undefined>;

export function readModelsStore(path: string): Store {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/u, "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/**
 * Refresh every provider's catalog with network access, bypassing freshness windows, and say what happened to each.
 * A provider counts as refreshed only when its stored row carries a check time from this run: Pi reports no error for
 * a refresh that another refresh superseded.
 */
export async function refreshModelCatalogs(
  registry: RefreshRegistry,
  readStore: () => Store,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<ModelRefreshReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const signal = AbortSignal.timeout(options.timeoutMs ?? 90_000);
  const errors = new Map<string, Error>();
  const first = await registry.refresh({ allowNetwork: true, force: true, signal });
  for (const [provider, error] of first.errors) errors.set(provider, error);
  let aborted = first.aborted;
  let store = readStore();
  const checked = (provider: string) => {
    const checkedAt = store[provider]?.checkedAt;
    return typeof checkedAt === "number" && checkedAt >= startedAt;
  };
  // Only a provider with a refreshable catalog writes a row; one whose models are a fixed list (models.json, a static
  // extension table) has nothing to fetch, so its missing row is not a failure (it is reported as a fixed list).
  const refreshable = (provider: string) => {
    const entry = registry.getProvider?.(provider);
    return entry === undefined ? true : typeof entry.refreshModels === "function";
  };
  const registered = [...registry.getRegisteredProviderIds()];
  // Pi starts its own catalog refresh at launch; whichever starts later supersedes the other without an error.
  const unsettled = () => registered.filter((provider) => refreshable(provider) && !errors.has(provider) && !checked(provider) && registry.getProviderAuthStatus(provider).configured);
  if (!aborted && unsettled().length > 0) {
    const retry = await registry.refresh({ allowNetwork: true, force: true, providers: unsettled(), signal });
    for (const [provider, error] of retry.errors) errors.set(provider, error);
    aborted = retry.aborted;
    store = readStore();
  }
  const counts = new Map<string, number>();
  for (const model of registry.getAll()) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  const known = new Set([...counts.keys(), ...registered, ...errors.keys(), ...Object.keys(store)]);
  const providers: ProviderRefresh[] = [];
  let unconfigured = 0;
  for (const provider of [...known].sort()) {
    const error = errors.get(provider);
    if (error) {
      providers.push({ provider, status: "failed", detail: error.message || error.name });
    } else if (checked(provider)) {
      const stored = store[provider]?.models;
      const models = Array.isArray(stored) && stored.length > 0 ? stored.length : (counts.get(provider) ?? 0);
      providers.push({ provider, status: "refreshed", models });
    } else if (registered.includes(provider) && !refreshable(provider)) {
      providers.push({ provider, status: "skipped", detail: `fixed list of ${counts.get(provider) ?? 0} model${counts.get(provider) === 1 ? "" : "s"}, nothing to fetch` });
    } else if (registered.includes(provider) && registry.getProviderAuthStatus(provider).configured) {
      providers.push({ provider, status: "failed", detail: aborted ? "the refresh timed out" : "the refresh did not complete" });
    } else if (registered.includes(provider)) {
      providers.push({ provider, status: "skipped", detail: "not configured" });
    } else {
      unconfigured += 1;
    }
  }
  if (aborted && !providers.some((entry) => entry.status === "failed")) {
    providers.push({ provider: "(all)", status: "failed", detail: "the refresh timed out" });
  }
  return { providers, unconfigured, ok: providers.every((entry) => entry.status !== "failed") };
}

export function formatModelRefreshReport(report: ModelRefreshReport): string[] {
  const lines = report.providers.map((entry) => {
    if (entry.status === "refreshed") return `${entry.provider}: refreshed with ${entry.models} model${entry.models === 1 ? "" : "s"}`;
    if (entry.status === "failed") return `${entry.provider}: FAILED: ${entry.detail}`;
    return `${entry.provider}: skipped (${entry.detail})`;
  });
  if (report.unconfigured > 0) {
    lines.push(`${report.unconfigured} provider${report.unconfigured === 1 ? "" : "s"} without a configured credential ${report.unconfigured === 1 ? "was" : "were"} not fetched.`);
  }
  if (!report.providers.some((entry) => entry.status === "refreshed") && report.ok) lines.push("No provider had a catalog to refresh.");
  return lines;
}

export default function modelRefreshExtension(pi: ExtensionAPI): void {
  const resultPath = process.env[RESULT_ENV];
  if (!resultPath) return;
  let started = false;
  pi.on("session_start", async (_event, ctx) => {
    if (started) return;
    started = true;
    let report: ModelRefreshReport;
    try {
      const storePath = join(getAgentDir(), "models-store.json");
      report = await refreshModelCatalogs(ctx.modelRegistry, () => readModelsStore(storePath));
    } catch (error) {
      report = { providers: [{ provider: "(all)", status: "failed", detail: error instanceof Error ? error.message : String(error) }], unconfigured: 0, ok: false };
    }
    // Written whole, then renamed: the waiting CLI never reads half a file.
    writeFileSync(`${resultPath}.tmp`, JSON.stringify(report), { mode: 0o600 });
    renameSync(`${resultPath}.tmp`, resultPath);
  });
}

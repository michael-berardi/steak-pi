import { readFileSync } from "node:fs";
import { paidRoutesConfigPath } from "./routing-config.ts";

export const PAID_ROUTE_FLAG = "steak-pi-paid-route";
export type Route = { provider: string; id: string; baseUrl: string };
const label = (route: Route) => `${route.provider}/${route.id}`;
const sameRoute = (route: Route, model: Route | undefined) => model !== undefined &&
  model.provider === route.provider && model.id === route.id && model.baseUrl === route.baseUrl;
/** The operator's paid-route file: `STEAK_PI_PAID_ROUTES`, else `~/.pi/agent/paid-routes.json`.
 * Resolved per call, so a test or operator override applies without a reload. */
export const paidRoutesPath = (): string => paidRoutesConfigPath();
/** @deprecated Resolved at import time; use {@link paidRoutesPath}. */
export const PAID_ROUTES_CONFIG_PATH = paidRoutesPath();

type PaidRoutesFile = { version: 1 | 2; reviewed?: unknown[]; allow: unknown[] };
function readPaidRoutesFile(configPath: string): PaidRoutesFile | undefined {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if ((config?.version !== 1 && config?.version !== 2) || !Array.isArray(config.allow)) return undefined;
    // A reviewed table may appear in either format: version 2 made it explicit, but a
    // version 1 file can carry one so one operator file serves both the released
    // 0.17.0 (which reads only `allow`) and this build (which reads `reviewed`).
    if (config.reviewed !== undefined && !Array.isArray(config.reviewed)) return undefined;
    return config as PaidRoutesFile;
  } catch { return undefined; }
}
/** Exact `{ provider, model, baseUrl }` entries only; anything else is skipped, never coerced. */
function entries(list: readonly unknown[] | undefined): Route[] {
  const routes: Route[] = [];
  for (const entry of list ?? []) {
    if (entry === null || typeof entry !== "object") continue;
    const { provider, model, baseUrl } = entry as Record<string, unknown>;
    if (typeof provider !== "string" || typeof model !== "string" || typeof baseUrl !== "string") continue;
    if (!provider || !model || !baseUrl) continue;
    routes.push({ provider, id: model, baseUrl });
  }
  return routes;
}

/**
 * The operator's reviewed paid-route catalog: the `reviewed` table of a paid-routes.json,
 * read from either format. Steak Pi ships no reviewed route of its own; adding an entry
 * there is a spending review, so it stays an exact list (no wildcard, no provider prefix
 * match). Version 2 introduced the explicit table; a version 1 file may carry the same
 * `reviewed` array so a single operator file serves both the released 0.17.0 (which reads
 * only `allow`) and this build. A version 1 file without a table of its own is checked
 * against the operator's catalog file; with no reviewed table anywhere nothing is reviewed.
 */
export function reviewedPaidRoutes(configPath = paidRoutesPath()): Route[] {
  const own = readPaidRoutesFile(configPath);
  // Version 2 owns its table: a version 2 file without `reviewed` reviews nothing and
  // never borrows the operator's catalog (that fallback would grant routes the file
  // deliberately left out).
  if (own?.version === 2) return entries(own.reviewed);
  // Version 1 may carry the same table so one operator file serves both builds.
  if (own?.reviewed !== undefined) return entries(own.reviewed);
  const catalogPath = paidRoutesPath();
  if (catalogPath === configPath) return [];
  const catalog = readPaidRoutesFile(catalogPath);
  return catalog ? entries(catalog.reviewed) : [];
}
/** @deprecated The reviewed table is operator configuration now; this is always empty. Use {@link reviewedPaidRoutes}. */
export const PAID_ROUTES: readonly Route[] = Object.freeze([]);

/** Exact reviewed route identity. A friendly name, provider prefix, or trailing
 * slash is a different billing target and never resolves to a reviewed route. */
export function findPaidRoute(model: { provider: string; id: string; baseUrl: string }, configPath = paidRoutesPath()): Route | undefined {
  return reviewedPaidRoutes(configPath).find(candidate => sameRoute(candidate, model as Route));
}

/** Re-read the user allowlist for revocation. Missing, malformed, unreadable, or
 * unmatched entries grant nothing, and entries outside the reviewed table are
 * never promoted into reviewed routes. */
export function readApprovedPaidRoutes(configPath = paidRoutesPath()): Route[] {
  const config = readPaidRoutesFile(configPath);
  if (!config) return [];
  const reviewed = reviewedPaidRoutes(configPath);
  const approved: Route[] = [];
  for (const entry of entries(config.allow)) {
    const route = reviewed.find(candidate => sameRoute(candidate, entry));
    if (route) approved.push(route);
  }
  return approved;
}

/** The user allowlist itself is the spending grant for one exact reviewed route. */
export function isAllowlistedPaidRoute(
  model: { provider: string; id: string; baseUrl: string },
  configPath = paidRoutesPath(),
): boolean {
  const route = findPaidRoute(model, configPath);
  return route !== undefined && readApprovedPaidRoutes(configPath).some(candidate => sameRoute(route, candidate));
}

/** Allowlist-only approval for automatic default routing. The called model must
 * itself be the reviewed route; approval is never inherited by a sibling route. */
export function createAllowlistApproval(configPath?: string): (model: Route) => boolean {
  return (model) => isAllowlistedPaidRoute(model, configPath ?? paidRoutesPath());
}

/** Operator `/model` switching without launch-profile locking: the dispatched
 * model must be the reviewed route the user allowlisted AND the route currently
 * selected in this runtime. Selecting a different route never authorizes the
 * dispatched one, and the allowlist is re-read on every dispatch for revocation. */
export function createSelectedRouteApproval(
  getSelected: () => Route | undefined,
  configPath?: string,
): (model: Route) => boolean {
  return (model) => {
    const path = configPath ?? paidRoutesPath();
    const selected = getSelected();
    const route = findPaidRoute(model, path);
    return route !== undefined && selected !== undefined && sameRoute(route, selected) && isAllowlistedPaidRoute(route, path);
  };
}

/** A launch argument alone is never spending permission. The flag must name one
 * exact approved route and the model Pi resolved at launch must already be that
 * same route. User-owned configuration and the resolved request identity must
 * agree; no environment state is inherited. Model selection events and UI
 * controls cannot create additional spending grants. */
export function createExplicitPaidApproval(
  flag: unknown,
  selected: Route | undefined,
  configPath = paidRoutesPath(),
): (model: Route) => boolean {
  const route = typeof flag === "string" ? reviewedPaidRoutes(configPath).find(candidate => label(candidate) === flag) : undefined;
  const launched = route !== undefined && sameRoute(route, selected);
  return (model) => {
    // The flag's own route, never merely "some approved route", must be the
    // dispatched model: a mismatched or extra selected route cannot spend.
    if (route === undefined || !launched || !sameRoute(route, model)) return false;
    // Re-read for revocation (both the reviewed table and the allowlist); missing,
    // malformed, or unreadable files fail closed.
    return isAllowlistedPaidRoute(route, configPath);
  };
}

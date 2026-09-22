import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PAID_ROUTE_FLAG = "steak-pi-paid-route";
/** The one verified Inco endpoint. A swallowed trailing slash, path, port, query
 * or alternate host is a different billing target and never matches by substring. */
export const PAID_INCO_BASE_URL = "https://api.inco.ai/v1";
export type Route = { provider: string; id: string; baseUrl: string };
// These reviewed exceptions authorize the user-requested Inco products and
// Xiaomi Singapore Token Plan models at their exact verified endpoints. Adding an entry here is a spending
// grant, so it stays an exact, hand-maintained list: no wildcard, no provider
// prefix match, and no route inherited by automatic worker routing or fallback.
export const PAID_ROUTES: readonly Route[] = [
  { provider: "inco", id: "glm-5.3-flash:fast", baseUrl: PAID_INCO_BASE_URL },
  { provider: "inco", id: "deepseek-v4.1-flash:fast", baseUrl: PAID_INCO_BASE_URL },
  { provider: "xiaomi", id: "mimo-v2.6-pro", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
  { provider: "xiaomi", id: "mimo-v2.6-flash", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
];
const label = (route: Route) => `${route.provider}/${route.id}`;
const sameRoute = (route: Route, model: Route | undefined) => model !== undefined &&
  model.provider === route.provider && model.id === route.id && model.baseUrl === route.baseUrl;
/** One default user-owned approval file; exact reviewed-route entries only. */
export const PAID_ROUTES_CONFIG_PATH = join(homedir(), ".pi", "agent", "paid-routes.json");

/** Exact reviewed route identity. A friendly name, provider prefix, or trailing
 * slash is a different billing target and never resolves to a reviewed route. */
export function findPaidRoute(model: { provider: string; id: string; baseUrl: string }): Route | undefined {
  return PAID_ROUTES.find(candidate => sameRoute(candidate, model as Route));
}

/** Re-read the user allowlist for revocation. Missing, malformed, unreadable, or
 * unmatched entries grant nothing, and entries outside the reviewed table are
 * never promoted into reviewed routes. */
export function readApprovedPaidRoutes(configPath = PAID_ROUTES_CONFIG_PATH): Route[] {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config?.version !== 1 || !Array.isArray(config.allow)) return [];
    const approved: Route[] = [];
    for (const entry of config.allow) {
      if (entry === null || typeof entry !== "object") continue;
      const { provider, model, baseUrl } = entry as Record<string, unknown>;
      if (typeof provider !== "string" || typeof model !== "string" || typeof baseUrl !== "string") continue;
      const route = PAID_ROUTES.find(candidate => sameRoute(candidate, { provider, id: model, baseUrl }));
      if (route) approved.push(route);
    }
    return approved;
  } catch { return []; }
}

/** The user allowlist itself is the spending grant for one exact reviewed route. */
export function isAllowlistedPaidRoute(
  model: { provider: string; id: string; baseUrl: string },
  configPath = PAID_ROUTES_CONFIG_PATH,
): boolean {
  const route = findPaidRoute(model);
  return route !== undefined && readApprovedPaidRoutes(configPath).some(candidate => sameRoute(route, candidate));
}

/** Allowlist-only approval for automatic default routing. The called model must
 * itself be the reviewed route; approval is never inherited by a sibling route. */
export function createAllowlistApproval(configPath = PAID_ROUTES_CONFIG_PATH): (model: Route) => boolean {
  return (model) => isAllowlistedPaidRoute(model, configPath);
}

/** Operator `/model` switching without launch-profile locking: the dispatched
 * model must be the reviewed route the user allowlisted AND the route currently
 * selected in this runtime. Selecting a different route never authorizes the
 * dispatched one, and the allowlist is re-read on every dispatch for revocation. */
export function createSelectedRouteApproval(
  getSelected: () => Route | undefined,
  configPath = PAID_ROUTES_CONFIG_PATH,
): (model: Route) => boolean {
  return (model) => {
    const selected = getSelected();
    const route = findPaidRoute(model);
    return route !== undefined && selected !== undefined && sameRoute(route, selected) && isAllowlistedPaidRoute(route, configPath);
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
  configPath = PAID_ROUTES_CONFIG_PATH,
): (model: Route) => boolean {
  const route = typeof flag === "string" ? PAID_ROUTES.find(candidate => label(candidate) === flag) : undefined;
  const launched = route !== undefined && sameRoute(route, selected);
  return (model) => {
    // The flag's own route, never merely "some approved route", must be the
    // dispatched model: a mismatched or extra selected route cannot spend.
    if (route === undefined || !launched || !sameRoute(route, model)) return false;
    try {
      // Re-read for revocation; missing, malformed, or unreadable files fail closed.
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      return config?.version === 1 && Array.isArray(config.allow) && config.allow.some(
        (entry: unknown) => entry !== null && typeof entry === "object" &&
          "provider" in entry && "model" in entry && "baseUrl" in entry &&
          sameRoute(route, { provider: entry.provider, id: entry.model, baseUrl: entry.baseUrl } as Route),
      );
    } catch { return false; }
  };
}

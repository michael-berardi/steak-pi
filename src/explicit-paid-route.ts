import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PAID_ROUTE_FLAG = "steak-pi-paid-route";
/** The one verified Inco endpoint. A swallowed trailing slash, path, port, query
 * or alternate host is a different billing target and never matches by substring. */
export const PAID_INCO_BASE_URL = "https://api.inco.ai/v1";
export type Route = { provider: string; id: string; baseUrl: string };
// This reviewed exception deliberately authorizes just the two user-requested
// Inco products at the verified endpoint. Adding an entry here is a spending
// grant, so it stays an exact, hand-maintained list: no wildcard, no provider
// prefix match, and no route inherited by automatic worker routing or fallback.
export const PAID_ROUTES: readonly Route[] = [
  { provider: "inco", id: "glm-5.3-flash:fast", baseUrl: PAID_INCO_BASE_URL },
  { provider: "inco", id: "deepseek-v4.1-flash:fast", baseUrl: PAID_INCO_BASE_URL },
];
const label = (route: Route) => `${route.provider}/${route.id}`;
const sameRoute = (route: Route, model: Route | undefined) => model !== undefined &&
  model.provider === route.provider && model.id === route.id && model.baseUrl === route.baseUrl;

/** A launch argument alone is never spending permission. The flag must name one
 * exact approved route and the model Pi resolved at launch must already be that
 * same route. User-owned configuration and the resolved request identity must
 * agree; no environment state is inherited. Model selection events and UI
 * controls cannot create additional spending grants. */
export function createExplicitPaidApproval(
  flag: unknown,
  selected: Route | undefined,
  configPath = join(homedir(), ".pi", "agent", "paid-routes.json"),
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

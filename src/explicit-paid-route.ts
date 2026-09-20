import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PAID_ROUTE_FLAG = "steak-pi-paid-route";
type Route = { provider: string; id: string; baseUrl: string };
// This exception deliberately authorizes just the user-requested product.
const route = { provider: "inco", id: "glm-5.3-flash:fast", baseUrl: "https://api.inco.ai/v1" };

/** A launch argument alone is never spending permission. User-owned configuration
 * and the resolved request identity must agree; no environment state is inherited.
 * Model selection events and UI controls cannot create additional spending grants. */
export function createExplicitPaidApproval(
  flag: unknown,
  selected: Route | undefined,
  configPath = join(homedir(), ".pi", "agent", "paid-routes.json"),
): (model: Route) => boolean {
  const matches = (model: Route | undefined) => model?.provider === route.provider &&
    model.id === route.id && model.baseUrl === route.baseUrl;
  const launched = flag === `${route.provider}/${route.id}` && matches(selected);
  return (model) => {
    if (!launched || !matches(model)) return false;
    try {
      // Re-read for revocation; missing, malformed, or unreadable files fail closed.
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      return config?.version === 1 && Array.isArray(config.allow) && config.allow.some(
        (entry: unknown) => entry !== null && typeof entry === "object" &&
          "provider" in entry && "model" in entry && "baseUrl" in entry &&
          matches({ provider: entry.provider, id: entry.model, baseUrl: entry.baseUrl } as Route),
      );
    } catch { return false; }
  };
}

/**
 * Routine workers run on the operator's configured worker chain. A wave that names an explicit
 * `model` or `profile` is never rerouted: when that route is at its limit the wave fails where an
 * implicit wave would have moved on to the next tier. So, like `thinking: high` needs a
 * `thinkingReason`, an explicit route for worker or scout tasks needs a `routeReason` that says why
 * the configured chain is not right for this wave. Reviewer-only waves are exempt.
 *
 * Which routes count is not a shipped list: the routing config carries no list of expert routes
 * (only single reviewer selectors), so the rule applies to every explicit route.
 */
import type { SubagentRole } from "./types.ts";

export const ROUTE_REASON_MIN_LENGTH = 16;
export const ROUTE_REASON_MAX_LENGTH = 2_000;

export class RouteReasonRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteReasonRequiredError";
  }
}

export interface RouteReasonInput {
  model?: unknown;
  profile?: unknown;
  routeReason?: unknown;
  tasks?: readonly { label?: unknown; role?: SubagentRole | string }[];
}

const routineRole = (role: unknown): boolean => role === undefined || role === "worker" || role === "scout";

/**
 * The routeReason a wave carries, validated. Returns undefined for a wave that needs none (no explicit
 * model or profile, or only reviewer tasks); throws {@link RouteReasonRequiredError} when one is required
 * and missing or malformed.
 */
export function requireRouteReason(input: RouteReasonInput): string | undefined {
  const selector = input.model !== undefined ? { field: "model", value: input.model } : input.profile !== undefined ? { field: "profile", value: input.profile } : undefined;
  if (selector === undefined) return undefined;
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const routine = tasks.filter((task) => routineRole(task?.role));
  if (routine.length === 0) return undefined;
  const reason = input.routeReason;
  if (typeof reason === "string" && reason.trim().length >= ROUTE_REASON_MIN_LENGTH && reason.length <= ROUTE_REASON_MAX_LENGTH) return reason;
  const labels = routine.slice(0, 8).map((task) => JSON.stringify(typeof task.label === "string" ? task.label.slice(0, 40) : "?")).join(", ");
  const named = `${selector.field} ${JSON.stringify(String(selector.value).slice(0, 256))}`;
  const problem = reason === undefined
    ? "routeReason is missing"
    : typeof reason !== "string" ? "routeReason must be a string"
    : reason.length > ROUTE_REASON_MAX_LENGTH ? `routeReason is longer than ${ROUTE_REASON_MAX_LENGTH} characters`
    : `routeReason is shorter than ${ROUTE_REASON_MIN_LENGTH} characters`;
  throw new RouteReasonRequiredError(`RouteReasonRequiredError: this wave names explicit ${named} for worker/scout task${routine.length === 1 ? "" : "s"} ${labels}${routine.length > 8 ? ", ..." : ""}, and ${problem}. `
    + `Routine workers run on the configured worker chain; an explicit route is for hard or review work and is never rerouted when it is at its limit. `
    + `Add the field routeReason: "<why the configured chain is not right for this wave, ${ROUTE_REASON_MIN_LENGTH} to ${ROUTE_REASON_MAX_LENGTH} characters>" to the dispatch, `
    + `or omit model and profile so the configured chain chooses (and spills to the next tier when a route is at its limit). No worker was started.`);
}

import { onlyWhenSkipReason, type WorkerRouteStep } from "../model-route-policy.ts";
import { dshRouteModel } from "./dsh-routes.ts";
import { DEFAULT_FREE_ROUTE_COOLDOWN_MINUTES, routeKey, type RouteStep, routeLabel, routingConfigOrEmpty } from "../routing-config.ts";
import { noClaudeCause, planOnlyCause, type ProjectPolicy } from "./project-policy.ts";
import { claudeQuotaBlock, quotaProviderOf, routeQuotaBlock, routeUnsupportedBlock, type QuotaSnapshot } from "./provider-quota.ts";

/** Free routes held out after a pre-output 429/limit refusal: route -> epoch ms the hold ends. Shared by every
 * dispatch in this process, so the next dispatch does not retry a route that just refused. */
const freeHolds = new Map<string, number>();

/** The one key a hold and its availability check share: the canonical routeKey, so a harness-qualified (dsh) route is
 * held and looked up under the same name. A route string is canonicalized through its dsh shape. */
export function freeHoldKey(route: string | RouteStep): string {
  if (typeof route !== "string") return routeKey(route);
  const inner = dshRouteModel(route);
  return inner === undefined ? route : routeKey({ ...inner, harness: "steak-dsh" });
}

/** Hold a free route out for the configured cooldown (`freeRouteCooldownMinutes`, default 10). Returns the end time. */
export function holdFreeRoute(route: string | RouteStep, now: number): number {
  const until = now + (routingConfigOrEmpty().freeRouteCooldownMinutes ?? DEFAULT_FREE_ROUTE_COOLDOWN_MINUTES) * 60_000;
  freeHolds.set(freeHoldKey(route), until);
  return until;
}

/** The epoch ms a free route's cooldown ends, or undefined when it is not (or no longer) held. */
export function freeRouteHeldUntil(route: string | RouteStep, now: number): number | undefined {
  const key = freeHoldKey(route);
  const until = freeHolds.get(key);
  if (until === undefined) return undefined;
  if (until <= now) { freeHolds.delete(key); return undefined; }
  return until;
}

/** Clear every free-route hold (tests, reload). */
export function clearFreeRouteHolds(): void { freeHolds.clear(); }

/** How long a rendered availability line may be reused before the router is asked again. */
export const AVAILABILITY_TTL_MS = 60_000;

export interface AvailabilityStep {
  label: string;
  state: "up" | "cooling" | "held" | "policy" | "unavailable";
  /** Bounded cause for a step that is not up. */
  cause?: string;
  /** Epoch seconds the step returns, when the router said. */
  returnsAt?: number;
  /** Bounded caveat on a step that IS up: what a launch on it must avoid. */
  note?: string;
}

/** The CLI login an UNPINNED Claude launch would use, when the router proves it cannot launch. */
export interface AvailabilityLogin {
  label: string;
  cause: string;
  returnsAt?: number;
}

export interface Availability {
  steps: AvailabilityStep[];
  /** The first step that is up, in chain order; undefined when none is. */
  next?: string;
  /** The compact line handed to the parent. */
  line: string;
}

const clock = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");

export interface AvailabilityInput {
  snapshot: QuotaSnapshot;
  /** The implicit chain, in order (textWorkerChain). */
  chain: readonly WorkerRouteStep[];
  /** The Claude subscription tier the chain falls to (route name), when the operator configured one. */
  claudeTier?: string;
  policy: ProjectPolicy;
  /** True for a step on a paid metered route (never offered to a planOnly project). */
  isPaid?: (step: WorkerRouteStep) => boolean;
  /** Recognize an operator-listed route (freeRoutes) whose models.json entry carries an all-zero cost row. */
  isFree?: (step: WorkerRouteStep) => boolean;
  /** Epoch ms for free-route cooldown checks; default Date.now(). */
  now?: number;
  /** Set when the router proves the parent's own Claude login spent: the Claude tier is still up for a
   * launch that pins an eligible account, but an unpinned claude-code route would be refused on it. */
  login?: AvailabilityLogin;
}

/** One state per chain step, then the Claude tier: up, cooling until a time, or out by project policy. */
export function computeAvailability(input: AvailabilityInput): Availability {
  const { snapshot, policy } = input;
  const steps: AvailabilityStep[] = [];
  for (const step of input.chain) {
    const label = routeLabel(step);
    if (policy.planOnly !== undefined && input.isPaid?.(step)) { steps.push({ label, state: "policy", cause: planOnlyCause(policy) }); continue; }
    const onlyWhen = step.onlyWhen ? onlyWhenSkipReason(step.onlyWhen, { quotaSnapshot: snapshot }) : undefined;
    if (onlyWhen !== undefined) { steps.push({ label, state: "held", cause: onlyWhen }); continue; }
    const free = input.isFree?.(step) === true;
    const heldUntil = free ? freeRouteHeldUntil(step, input.now ?? Date.now()) : undefined;
    if (heldUntil !== undefined) { steps.push({ label, state: "cooling", cause: "free route refused a request (rate limit) and is cooling down", returnsAt: Math.ceil(heldUntil / 1000) }); continue; }
    const block = snapshot.known
      ? (free ? routeUnsupportedBlock(snapshot, step) : routeQuotaBlock(snapshot, step))
      : undefined;
    if (block === undefined) { steps.push({ label, state: "up" }); continue; }
    const provider = quotaProviderOf(step);
    // Out for its plan, with no cooldown that ends by itself and none the other accounts are waiting on: unavailable.
    const quota = provider ? snapshot.providers[provider] : undefined;
    if (quota?.unsupported === true && quota.earliestReturn === undefined) { steps.push({ label, state: "unavailable", cause: block }); continue; }
    const returnsAt = quota?.earliestReturn;
    steps.push({ label, state: "cooling", cause: block, ...(returnsAt !== undefined ? { returnsAt } : {}) });
  }
  if (input.claudeTier !== undefined) {
    const label = `Claude subscription tier (${input.claudeTier})`;
    if (policy.noClaude !== undefined) steps.push({ label, state: "policy", cause: noClaudeCause(policy) });
    else {
      const block = snapshot.known ? claudeQuotaBlock(snapshot) : undefined;
      const returnsAt = snapshot.providers.claude?.earliestReturn;
      // The tier is up while one account can take a pinned launch. Say plainly that the parent's own login is
      // spent, so a route that pins nothing is refused instead of dying at the CLI (J-3759).
      const note = input.login === undefined ? undefined
        : `this session's Claude login ${input.login.label} is COOLING${input.login.returnsAt !== undefined ? ` until ${clock(input.login.returnsAt)}` : ""}, so an unpinned claude-code route is refused`;
      steps.push(block === undefined
        ? { label, state: "up", ...(note !== undefined ? { note } : {}) }
        : { label, state: "cooling", cause: block, ...(returnsAt !== undefined ? { returnsAt } : {}) });
    }
  }
  const next = steps.find((step) => step.state === "up")?.label;
  return { steps, ...(next !== undefined ? { next } : {}), line: renderAvailability(steps, next, snapshot.known) };
}

function renderAvailability(steps: readonly AvailabilityStep[], next: string | undefined, known: boolean): string {
  if (steps.length === 0) return "";
  const parts = steps.map((step) => step.state === "up" ? `${step.label}: up${step.note !== undefined ? ` (${step.note})` : ""}`
    : step.state === "held" ? `${step.label}: HELD BACK (${step.cause})`
    : step.state === "cooling" ? `${step.label}: COOLING${step.returnsAt !== undefined ? ` until ${clock(step.returnsAt)}` : ""}`
    : step.state === "unavailable" ? `${step.label}: UNAVAILABLE (${step.cause})`
    : `${step.label}: NOT ALLOWED (project policy)`);
  return `USAP route availability${known ? "" : " (router unreadable, treat as unknown)"}: ${parts.join("; ")}. `
    + (next !== undefined ? `Next usable route: ${next}. ` : "No route is usable now; the implicit dispatch refuses once and names when each returns. ")
    + "Omit model, profile and harness on ultraterm_subagents and let the router choose; never pin a COOLING, HELD BACK, UNAVAILABLE or NOT ALLOWED route.";
}

/** The one-shot refusal for an implicit wave with no allowed, available step: every skipped step and when it returns. */
export function noRouteMessage(steps: readonly AvailabilityStep[]): string {
  return steps.map((step) => step.state === "up" ? `${step.label}: not launchable in this session`
    : `${step.label}: ${step.cause ?? step.state}${step.returnsAt !== undefined ? `; returns ${clock(step.returnsAt)}` : ""}`).join(" | ");
}

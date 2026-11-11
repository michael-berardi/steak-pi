import { onlyWhenSkipReason, type WorkerRouteStep } from "../model-route-policy.ts";
import { routeLabel } from "../routing-config.ts";
import { noClaudeCause, planOnlyCause, type ProjectPolicy } from "./project-policy.ts";
import { claudeQuotaBlock, quotaProviderOf, routeQuotaBlock, type QuotaSnapshot } from "./provider-quota.ts";

/** How long a rendered availability line may be reused before the router is asked again. */
export const AVAILABILITY_TTL_MS = 60_000;

export interface AvailabilityStep {
  label: string;
  state: "up" | "cooling" | "held" | "policy";
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
    const block = snapshot.known ? routeQuotaBlock(snapshot, step) : undefined;
    if (block === undefined) { steps.push({ label, state: "up" }); continue; }
    const provider = quotaProviderOf(step);
    const returnsAt = provider ? snapshot.providers[provider]?.earliestReturn : undefined;
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
    : `${step.label}: NOT ALLOWED (project policy)`);
  return `USAP route availability${known ? "" : " (router unreadable, treat as unknown)"}: ${parts.join("; ")}. `
    + (next !== undefined ? `Next usable route: ${next}. ` : "No route is usable now; the implicit dispatch refuses once and names when each returns. ")
    + "Omit model, profile and harness on ultraterm_subagents and let the router choose; never pin a COOLING, HELD BACK or NOT ALLOWED route.";
}

/** The one-shot refusal for an implicit wave with no allowed, available step: every skipped step and when it returns. */
export function noRouteMessage(steps: readonly AvailabilityStep[]): string {
  return steps.map((step) => step.state === "up" ? `${step.label}: not launchable in this session`
    : `${step.label}: ${step.cause ?? step.state}${step.returnsAt !== undefined ? `; returns ${clock(step.returnsAt)}` : ""}`).join(" | ");
}

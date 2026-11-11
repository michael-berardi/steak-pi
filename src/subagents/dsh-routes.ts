/**
 * Steak DSH harness routes (`steak-dsh/<provider>/<model-id>`).
 *
 * The steak-dsh harness runs the DSH headless CLI with the Steak DSH bundle on a
 * model the Pi registry already knows: the inner `<provider>/<model-id>` is an
 * exact native route, and admission applies the SAME policy checks a Pi-native
 * route passes (retired patterns, pinned subscription families, paid-route
 * approval, configured authentication) plus two harness-specific gates: the
 * provider must hold an API key the CLI can use (an OAuth-only login is refused,
 * the harness cannot refresh it) and the `steak-dsh` executable must resolve.
 *
 * This file pins no model, provider or price: every identity comes from the
 * registry and the operator's routing.json. The route grammar constant lives in
 * routing-config.ts so the config parser and this adapter cannot drift.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DSH_ROUTE_PREFIX } from "../routing-config.ts";
import { assertActiveModelIdentity, isRetiredRoute, retiredRouteError } from "../retired-model-selection.ts";
import { createAllowlistApproval, findPaidRoute } from "../explicit-paid-route.ts";
import { isSubscriptionOrLocalRoute } from "../subscription-first-routing.ts";

type Model = NonNullable<ExtensionContext["model"]>;

/** The fixed child-environment name the route's API key is passed under. The key
 * itself never appears in argv, prompts, logs or the run record. */
export const DSH_KEY_ENV = "STEAK_DSH_ROUTE_KEY";
/** The executable override; without it `steak-dsh` is resolved on PATH. */
export const DSH_BIN_ENV = "STEAK_DSH_BIN";
export const DSH_DEFAULT_EXECUTABLE = "steak-dsh";
/** The native APIs the steak-dsh CLI can declare a gateway route for. */
export const DSH_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type DshApi = (typeof DSH_APIS)[number];
/** Reasoning efforts a steak-dsh run may carry; anything else is refused by name. */
export const DSH_EFFORTS = ["medium", "high", "xhigh"] as const;
export type DshEffort = (typeof DSH_EFFORTS)[number];
export const DSH_DEFAULT_EFFORT: DshEffort = "medium";

/** The inner `{provider, id}` of an exact `steak-dsh/<provider>/<model-id>` route, or undefined for
 * anything else. The model id may itself contain slashes (split at the first inner slash only).
 * Shape only: this says which harness owns the route, not that the model is admitted. */
export function dshRouteModel(route: string | undefined): { provider: string; id: string } | undefined {
  if (route === undefined || !route.startsWith(DSH_ROUTE_PREFIX)) return undefined;
  const inner = route.slice(DSH_ROUTE_PREFIX.length);
  const slash = inner.indexOf("/");
  if (slash < 1 || slash === inner.length - 1) return undefined;
  const provider = inner.slice(0, slash);
  const id = inner.slice(slash + 1);
  if (provider.includes("/") || id.length === 0) return undefined;
  return { provider, id };
}

/** True when the string is shaped like a steak-dsh route (admission is a separate gate). */
export const isDshRoute = (route: string | undefined): boolean => dshRouteModel(route) !== undefined;

/** The full harness-qualified route string of an inner route. */
export const dshRouteOf = (inner: { provider: string; id: string }): string => `${DSH_ROUTE_PREFIX}${inner.provider}/${inner.id}`;

/** The named refusal for a route that is not a well-formed steak-dsh route. */
export function dshRouteShapeRefusal(route: string | undefined): string {
  return `USAP harness steak-dsh requires the exact route form steak-dsh/<provider>/<model-id> (the model id may contain slashes); ${JSON.stringify(String(route ?? "").slice(0, 120))} is not one, so no run was started and no fallback was selected.`;
}

/** The named refusal for an inner route the harness cannot serve, naming the inner route and the cause. */
export function dshRouteRefusal(route: string, cause: string): string {
  const inner = dshRouteModel(route);
  const named = inner ? `${inner.provider}/${inner.id}` : route;
  return `USAP harness steak-dsh cannot serve ${route} (inner route ${named}): ${cause}. No run was started and no fallback was selected.`;
}

/** The named "harness not installed" cause, with the install hint (also used for child exit 78). */
export const DSH_NOT_INSTALLED =
  "steak-dsh harness not installed: the steak-dsh executable does not resolve. Install the Steak DSH bundle so `steak-dsh` is on PATH, or point STEAK_DSH_BIN at the executable";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

/** Resolve the steak-dsh executable: STEAK_DSH_BIN when it names an executable file, else `steak-dsh`
 * on PATH. Undefined when neither resolves (the launch check names the install hint). */
export function resolveDshExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[DSH_BIN_ENV]?.trim();
  if (override) return isExecutableFile(override) ? override : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, DSH_DEFAULT_EXECUTABLE);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export function isDshEffort(value: unknown): value is DshEffort {
  return typeof value === "string" && (DSH_EFFORTS as readonly string[]).includes(value);
}

/** The effort an explicit steak-dsh dispatch runs at: its own `thinking` when given, else medium.
 * high/xhigh need a concrete reason, like on the native and claude-code routes; every other level
 * is refused by name. */
export function resolveDshEffort(thinking?: unknown, reason?: string): DshEffort {
  if (thinking === undefined) return DSH_DEFAULT_EFFORT;
  if (!isDshEffort(thinking)) {
    throw new Error(`Steak DSH effort must be ${DSH_EFFORTS.join(", ")}, not ${JSON.stringify(String(thinking).slice(0, 32))}; no run was started.`);
  }
  if (thinking !== DSH_DEFAULT_EFFORT && (!reason || reason.trim().length < 16)) {
    throw new Error(`Steak DSH ${thinking} effort needs a concrete task benefit in thinkingReason; it runs at ${DSH_DEFAULT_EFFORT} by default.`);
  }
  return thinking;
}

/** Map a resolved Pi thinking level onto a steak-dsh effort: the native off/minimal/low levels have
 * no CLI equivalent and run at medium; medium/high/xhigh pass through. Unknown levels are refused. */
export function dshEffortOf(level: string): DshEffort {
  if (level === "off" || level === "minimal" || level === "low") return DSH_DEFAULT_EFFORT;
  if (isDshEffort(level)) return level;
  throw new Error(`Steak DSH effort must be ${DSH_EFFORTS.join(", ")}, not ${JSON.stringify(level.slice(0, 32))}; no run was started.`);
}

/** The registry surface steak-dsh admission reads: the same one a Pi-native chain step uses. */
export interface DshRegistry {
  find(provider: string, id: string): Model | undefined;
  getAll?(): Model[];
  getAvailable(): Model[];
  hasConfiguredAuth(model: Model): boolean;
  isUsingOAuth(model: Model): boolean;
}

export interface DshAdmissionOptions {
  /** The operator's reviewed paid-route grant (defaults to the on-disk allowlist, re-read per call). */
  approvePaidRoute?: (model: Model) => boolean;
  /** Environment the executable resolution reads (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Durable admission for a `steak-dsh/<provider>/<model-id>` route. The inner model must be one the
 * Pi registry already knows and must pass the SAME policy checks the Pi-native route passes
 * (retired patterns, pinned subscription families, paid-route approval, configured authentication),
 * plus the harness gates: an API key the CLI can use (OAuth-only logins are refused) and a resolved
 * steak-dsh executable. Every refusal is a named error naming the inner route; nothing falls back.
 */
export async function admitDshRoute(route: string | undefined, registry: DshRegistry, options: DshAdmissionOptions = {}): Promise<Model> {
  const inner = dshRouteModel(route);
  if (inner === undefined) throw new Error(dshRouteShapeRefusal(route));
  const full = route!;
  const innerRoute = `${inner.provider}/${inner.id}`;
  if (isRetiredRoute(full) || isRetiredRoute(innerRoute)) throw new Error(retiredRouteError(isRetiredRoute(full) ? full : innerRoute));
  const model = registry.find(inner.provider, inner.id);
  if (!model || model.provider !== inner.provider || model.id !== inner.id) {
    throw new Error(dshRouteRefusal(full, `the Pi model registry does not know the inner model ${innerRoute}`));
  }
  assertActiveModelIdentity(model);
  const catalog = registry.getAll?.() ?? registry.getAvailable();
  if (!catalog.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
    throw new Error(dshRouteRefusal(full, `the inner model ${innerRoute} is not in the dispatch catalog`));
  }
  if (model.input?.includes("text") !== true) {
    throw new Error(dshRouteRefusal(full, `the inner model ${innerRoute} does not advertise text input`));
  }
  // The same policy asserts a Pi-native selection passes (pinned families, retired identities).
  const { assertModelRoute, assertSubscriptionRequest } = await import("../model-route-policy.ts");
  try {
    assertModelRoute(model);
    assertSubscriptionRequest(model, registry.isUsingOAuth(model));
  } catch (error) {
    throw new Error(dshRouteRefusal(full, error instanceof Error ? error.message : String(error)));
  }
  if (!registry.hasConfiguredAuth(model)) {
    throw new Error(dshRouteRefusal(full, `the inner model ${innerRoute} has no configured authentication in Pi`));
  }
  if (registry.isUsingOAuth(model)) {
    throw new Error(dshRouteRefusal(full, `the inner model ${innerRoute} is served by an OAuth-only login; the steak-dsh harness needs an API key it can read from the environment and cannot refresh OAuth tokens`));
  }
  if (!isSubscriptionOrLocalRoute(model, false)) {
    const approve = options.approvePaidRoute ?? paidAllowlisted;
    if (!findPaidRoute(model) || !approve(model)) {
      throw new Error(dshRouteRefusal(full, `the inner model ${innerRoute} is a paid metered route that is not approved in ~/.pi/agent/paid-routes.json`));
    }
  }
  if (resolveDshExecutable(options.env ?? process.env) === undefined) {
    throw new Error(dshRouteRefusal(full, DSH_NOT_INSTALLED));
  }
  return model;
}

/** The default paid approval is the operator's exact allowlist grant, re-read per call. */
const paidAllowlisted = createAllowlistApproval();

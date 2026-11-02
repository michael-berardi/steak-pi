/**
 * Task classes: the operator's per-class routing, read from `taskClasses` in routing.json.
 *
 * A task may declare a class (a lowercase slug the operator chose). When the wave is implicit
 * and the class is configured, the dispatch walks that class's chain first (a worker profile id or an
 * exact `provider/model`, with the same launch, quota, paid-route and `onlyWhen` checks as the default
 * chain) and falls back to the normal route. Steak Pi ships no class, chain or profile: the whole table
 * is operator configuration, and a class the operator did not configure is ignored, never an error.
 *
 * One run uses one frozen route, so a wave steers on one class. Tasks that declare no class (or one that
 * is not configured) ride on that route and the dispatch note names them; two different configured
 * classes in one wave are refused, because they ask for different routes.
 */
import { isRetiredRoute } from "../retired-model-selection.ts";
import { routeKey, routingConfigOrEmpty, TASK_CLASS_MAX_LENGTH, TASK_CLASS_PATTERN, type TaskClassConfig } from "../routing-config.ts";
import type { TaskClassRanking, TaskClassStep, TaskClassWalk } from "../model-route-policy.ts";
import type { WorkerProfile } from "./model-selection.ts";
import type { RouteEvidenceStore } from "./route-evidence.ts";
import { rankClassRoutes, settingsOf, type Rng } from "./route-ranking.ts";
import type { ModelSelection, SubagentTaskInput, TaskClassSelection } from "./types.ts";

export class TaskClassConflictError extends Error { override name = "TaskClassConflictError"; }

export const isTaskClassSlug = (value: unknown): value is string =>
  typeof value === "string" && value.length <= TASK_CLASS_MAX_LENGTH && TASK_CLASS_PATTERN.test(value);

/** The operator's configuration for one class, or undefined. Own keys only: a class is never inherited. */
export function configuredTaskClass(name: string): TaskClassConfig | undefined {
  const classes = routingConfigOrEmpty().taskClasses;
  return classes !== undefined && isTaskClassSlug(name) && Object.hasOwn(classes, name) ? classes[name] : undefined;
}

export interface WaveTaskClass {
  /** The one configured class that steers the wave. */
  active?: { name: string; config: TaskClassConfig };
  /** Every class the tasks declared, in first-seen order. */
  declared: string[];
  /** Declared classes the operator did not configure. */
  unknown: string[];
  /** Labels of tasks that declared no class, or one that is not configured, and so ride the wave's route. */
  riders: string[];
}

/** Read what a wave's tasks declare. Throws {@link TaskClassConflictError} for two configured classes. */
export function analyzeWaveClasses(tasks: readonly Pick<SubagentTaskInput, "label" | "taskClass">[], opts: { refuseConflict: boolean }): WaveTaskClass {
  const declared = [...new Set(tasks.flatMap((task) => typeof task.taskClass === "string" ? [task.taskClass] : []))];
  const configured = declared.filter((name) => configuredTaskClass(name) !== undefined);
  const unknown = declared.filter((name) => !configured.includes(name));
  if (configured.length > 1 && opts.refuseConflict) {
    throw new TaskClassConflictError(`Tasks of one wave declare task classes with different chains (${configured.join(", ")}); one run uses one route, so dispatch each class as its own wave. No fallback was selected.`);
  }
  const name = configured[0];
  const active = name === undefined ? undefined : { name, config: configuredTaskClass(name)! };
  const riders = active === undefined ? [] : tasks.filter((task) => task.taskClass !== name).map((task) => task.label);
  return { ...(active ? { active } : {}), declared, unknown, riders };
}

/** What ranks a class on evidence: the store, a random source and a clock, each injectable. */
export interface ClassRankingDeps { store: RouteEvidenceStore; rng?: Rng; now?: () => number }

function rankClass(name: string, config: TaskClassConfig, deps: ClassRankingDeps, candidates: ReadonlyArray<{ entry: string; route: string }>): TaskClassRanking {
  const now = (deps.now ?? Date.now)();
  const result = rankClassRoutes(name, candidates, settingsOf(config), deps.store.view(), deps.rng ?? Math.random, now);
  // A re-probe is one pick: the marker starts the cooldown again, so the next dispatch does not probe too.
  if (result.decision.mode === "probe") deps.store.recordProbe({ taskClass: name, route: result.decision.winner, at: now });
  return { order: result.order, decision: result.decision, excluded: result.excluded };
}

/** Resolve a class chain against the profiles in scope. An entry that is exactly a profile id is that
 * profile's model (and carries its thinking and `ensure`); any other entry is an exact `provider/model`.
 * Each step gets the `onlyWhen` the operator attached to its route with `routeConditions`. With `ranking`,
 * the steps that can launch are ranked on the store's evidence; without it the chain order stands. */
export function resolveTaskClassWalk(name: string, config: TaskClassConfig, profiles: readonly WorkerProfile[], ranking?: ClassRankingDeps): TaskClassWalk {
  const conditions = routingConfigOrEmpty().routeConditions;
  const steps = config.chain.map((entry): TaskClassStep => {
    const profile = profiles.find((candidate) => candidate.id === entry);
    const route = profile ? profile.model : entry;
    const slash = route.indexOf("/");
    if (slash < 1 || slash === route.length - 1) {
      return { entry, step: { provider: route, id: "" }, ...(profile ? { profile: profile.id } : {}), blocked: `profile ${entry} does not name a provider/model route` };
    }
    const step = { provider: route.slice(0, slash), id: route.slice(slash + 1) };
    const onlyWhen = conditions?.[routeKey(step)];
    return {
      entry,
      step: onlyWhen ? { ...step, onlyWhen } : step,
      ...(profile ? { profile: profile.id } : {}),
      ...(isRetiredRoute(route) || isRetiredRoute(entry) ? { blocked: "retired by the operator" } : {}),
    };
  });
  return {
    name, steps, requiresTestGate: config.requiresTestGate, ...(config.note ? { note: config.note } : {}),
    ...(ranking ? { rank: (candidates: ReadonlyArray<{ entry: string; route: string }>) => rankClass(name, config, ranking, candidates) } : {}),
  };
}

/**
 * The ranked class chain a run recorded, when it is exactly routes of the operator's configured class. A runtime
 * hop may follow it (402, 5xx, a transient transport failure) and no other order: a route the class does not name,
 * from a stale or forged record, never becomes a hop target.
 */
export function recordedClassChain(selection: Pick<ModelSelection, "source" | "chainRoutes" | "taskClass"> | undefined, profiles: readonly WorkerProfile[]): ReadonlyArray<{ provider: string; id: string }> | undefined {
  const receipt = selection?.taskClass;
  if (selection?.source !== "chain" || receipt?.outcome !== "served" || !selection.chainRoutes?.length) return undefined;
  const config = configuredTaskClass(receipt.name);
  if (!config) return undefined;
  const allowed = new Set(resolveTaskClassWalk(receipt.name, config, profiles).steps.filter((step) => step.blocked === undefined).map((step) => routeKey(step.step)));
  if (!selection.chainRoutes.every((route) => allowed.has(route))) return undefined;
  return selection.chainRoutes.map((route) => ({ provider: route.slice(0, route.indexOf("/")), id: route.slice(route.indexOf("/") + 1) }));
}

/** The receipt for a class that did not steer the wave. */
export function ignoredTaskClass(wave: WaveTaskClass, reason: string): TaskClassSelection | undefined {
  if (wave.declared.length === 0) return undefined;
  const name = wave.declared[0];
  return { name, outcome: "ignored", reason };
}

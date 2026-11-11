/**
 * Task classes: the operator's per-class routing, read from `taskClasses` in routing.json.
 *
 * A task may declare a class (a lowercase slug the operator chose). When the wave is implicit
 * and the class is configured, the dispatch walks that class's chain first (a worker profile id or an
 * exact `provider/model`, with the same launch, quota, paid-route and `onlyWhen` checks as the default
 * chain) and falls back to the normal route. Steak Pi ships no class, chain or profile: the whole table
 * is operator configuration, and a class the operator did not configure is ignored, never an error.
 *
 * One run uses one frozen route, so a wave steers on one class, and only when the class fits the WHOLE wave: every
 * task carries it, the wave is no wider than the class's `slots`, and a `maxScope: "small"` class sees no task that may
 * both edit and run a shell. Otherwise the class is skipped and the normal chain runs (2026-11-04: one classed
 * task sent a four-task payments implementation wave onto a one-slot local model). Two different configured classes in
 * one wave are refused, because they ask for different routes.
 */
import { isRetiredRoute } from "../retired-model-selection.ts";
import { DSH_ROUTE_PREFIX, routeKey, routingConfigOrEmpty, TASK_CLASS_MAX_LENGTH, TASK_CLASS_PATTERN, type TaskClassConfig, type TaskClassRule } from "../routing-config.ts";
import { dshRouteModel, dshRouteShapeRefusal } from "./dsh-routes.ts";
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
  /** Labels of tasks that declared no class, or one that is not configured. */
  riders: string[];
  /** Why the configured class does not steer this wave (it then runs the normal route), or undefined when it does. */
  skipped?: string;
}

/** A task as the class-fit check sees it. */
export interface FitTask { label: string; taskClass?: string; mayEdit?: boolean; allowBash?: boolean }

/** Why a configured class cannot steer this wave, or undefined when it fits. */
export function classWaveMisfit(name: string, config: TaskClassConfig, tasks: readonly FitTask[]): string | undefined {
  const riders = tasks.filter((task) => task.taskClass !== name);
  if (riders.length > 0) {
    return `tasks without it (${riders.slice(0, 8).map((task) => JSON.stringify(task.label.slice(0, 40))).join(", ")}) would ride its route; dispatch the ${name} task${tasks.length - riders.length === 1 ? "" : "s"} as a separate wave to use it`;
  }
  if (config.slots !== undefined && tasks.length > config.slots) {
    return `the wave has ${tasks.length} tasks and its routes take ${config.slots} at a time`;
  }
  if (config.maxScope === "small") {
    const big = tasks.filter((task) => task.mayEdit === true && task.allowBash === true);
    if (big.length > 0) return `it is configured for small tasks and ${big.length === 1 ? "a task" : `${big.length} tasks`} may edit and run a shell`;
  }
  return undefined;
}

/** A task as the rules see it. */
export interface RuleTask { label: string; task: string; role?: string; mayEdit?: boolean; allowBash?: boolean; taskClass?: string }

/** The class the operator's `taskClassRules` give a task that names none, or undefined. Only configured classes are returned.
 * Explicit classes always win; Steak Pi ships no rule (routing.json only). */
export function inferTaskClass(task: RuleTask, rules: readonly TaskClassRule[] | undefined = routingConfigOrEmpty().taskClassRules): { name: string; rule: number } | undefined {
  if (typeof task.taskClass === "string" || !rules) return undefined;
  const role = task.role ?? "worker";
  for (const [index, rule] of rules.entries()) {
    const w = rule.when;
    if (w.role !== undefined && w.role !== role) continue;
    if (w.mayEdit !== undefined && (task.mayEdit === true) !== w.mayEdit) continue;
    if (w.allowBash !== undefined && (task.allowBash === true) !== w.allowBash) continue;
    if (w.textPattern !== undefined && !new RegExp(w.textPattern, "i").test(task.task)) continue;
    if (configuredTaskClass(rule.class) === undefined) continue;
    return { name: rule.class, rule: index };
  }
  return undefined;
}

/** Give every task that names no class its inferred class (copies; the input is not changed). One wave runs one route, so when
 * the inferred classes differ, only the class of the first inferred task is kept and the others ride the wave's route. */
export function applyInferredTaskClasses<T extends RuleTask>(tasks: readonly T[], rules?: readonly TaskClassRule[]): { tasks: T[]; inferred: Array<{ label: string; name: string; rule: number }> } {
  const explicit = tasks.find((task) => typeof task.taskClass === "string" && configuredTaskClass(task.taskClass) !== undefined)?.taskClass;
  let chosen: string | undefined = explicit;
  const inferred: Array<{ label: string; name: string; rule: number }> = [];
  const out = tasks.map((task) => {
    const hit = inferTaskClass(task, rules);
    if (!hit) return task;
    if (chosen !== undefined && hit.name !== chosen) return task;
    chosen = hit.name;
    inferred.push({ label: task.label, ...hit });
    return { ...task, taskClass: hit.name };
  });
  return { tasks: out, inferred };
}

/** Read what a wave's tasks declare. Throws {@link TaskClassConflictError} for two configured classes. */
export function analyzeWaveClasses(tasks: readonly (Pick<SubagentTaskInput, "label" | "taskClass"> & { mayEdit?: boolean; allowBash?: boolean })[], opts: { refuseConflict: boolean }): WaveTaskClass {
  const declared = [...new Set(tasks.flatMap((task) => typeof task.taskClass === "string" ? [task.taskClass] : []))];
  const configured = declared.filter((name) => configuredTaskClass(name) !== undefined);
  const unknown = declared.filter((name) => !configured.includes(name));
  if (configured.length > 1 && opts.refuseConflict) {
    throw new TaskClassConflictError(`Tasks of one wave declare task classes with different chains (${configured.join(", ")}); one run uses one route, so dispatch each class as its own wave. No fallback was selected.`);
  }
  const name = configured[0];
  const config = name === undefined ? undefined : configuredTaskClass(name)!;
  const riders = name === undefined ? [] : tasks.filter((task) => task.taskClass !== name).map((task) => task.label);
  const skipped = name === undefined ? undefined : classWaveMisfit(name, config!, tasks);
  const active = name === undefined || skipped !== undefined ? undefined : { name, config: config! };
  return { ...(active ? { active } : {}), declared, unknown, riders, ...(skipped !== undefined ? { skipped } : {}) };
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
 * profile's model (and carries its thinking and `ensure`); a `steak-dsh/<provider>/<model-id>` entry is a
 * harness-qualified step on the inner registry route; any other entry is an exact `provider/model`.
 * Each step gets the `onlyWhen` the operator attached to its route with `routeConditions`. With `ranking`,
 * the steps that can launch are ranked on the store's evidence; without it the chain order stands. */
export function resolveTaskClassWalk(name: string, config: TaskClassConfig, profiles: readonly WorkerProfile[], ranking?: ClassRankingDeps): TaskClassWalk {
  const conditions = routingConfigOrEmpty().routeConditions;
  const steps = config.chain.map((entry): TaskClassStep => {
    const profile = profiles.find((candidate) => candidate.id === entry);
    const route = profile ? profile.model : entry;
    // A harness-qualified steak-dsh entry (directly, or through a profile that names one): the step
    // keeps the inner provider/id and carries the harness, so evidence records the entry verbatim
    // while quota, onlyWhen and policy checks apply to the inner route.
    if (route.startsWith(DSH_ROUTE_PREFIX)) {
      const inner = dshRouteModel(route);
      if (inner === undefined) {
        return { entry, step: { provider: route, id: "" }, ...(profile ? { profile: profile.id } : {}), blocked: dshRouteShapeRefusal(route) };
      }
      const innerRoute = `${inner.provider}/${inner.id}`;
      const step = { provider: inner.provider, id: inner.id, harness: "steak-dsh" as const };
      const onlyWhen = conditions?.[route] ?? conditions?.[innerRoute];
      return {
        entry,
        step: onlyWhen ? { ...step, onlyWhen } : step,
        ...(profile ? { profile: profile.id } : {}),
        ...(isRetiredRoute(route) || isRetiredRoute(innerRoute) || isRetiredRoute(entry) ? { blocked: "retired by the operator" } : {}),
      };
    }
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

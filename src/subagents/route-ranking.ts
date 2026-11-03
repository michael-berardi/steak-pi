/**
 * Evidence-driven ranking inside one task class's chain.
 *
 * Every step that already passed the launch checks (authentication, paid-route approval, quota veto, `onlyWhen`)
 * is ranked by its expected cost per correct result, `(E[cost] + timeWeight x E[seconds]) / p(pass)`, where p(pass)
 * is a Beta posterior over the store's pass and fail counts seeded by the operator's priors. The winner is a Thompson
 * draw, with a small `explore` share that deliberately picks a weaker route so its estimate keeps getting evidence.
 * A route that keeps failing is demoted with a named cause, held out for a cooldown, re-probed once, and promoted
 * again by a pass. With neither priors nor evidence the configured chain order stands.
 *
 * This file names no route, model or class: it only reads what the operator configured and what the store holds.
 * The random source and the clock are injected, so every decision is reproducible.
 */
import type { TaskClassConfig } from "../routing-config.ts";
import type { EvidenceView, FailureKind, TaskEvidence } from "./route-evidence.ts";
import type { TaskClassDecision, TaskClassEstimate } from "./types.ts";

export interface RoutePrior { pass: number; n: number; costUsd?: number; seconds?: number }
export interface RankSettings {
  /** Dollars one second of waiting is worth. 0 ranks on cost alone. */
  timeWeight: number;
  /** A route whose rolling pass rate falls under this is held out. 0 disables the floor. */
  minPassRate: number;
  /** Share of dispatches that pick a weaker route on purpose. */
  explore: number;
  /** Consecutive failures that demote a route. */
  demoteAfter: number;
  /** Decided outcomes the rolling pass rate looks at. */
  window: number;
  /** How long a demoted route stays out before one re-probe. */
  cooldownMs: number;
  priors: Readonly<Record<string, RoutePrior>>;
}
export const RANK_DEFAULTS = { timeWeight: 0, minPassRate: 0, explore: 0.1, demoteAfter: 3, window: 10, cooldownMinutes: 30 } as const;
/** The floor judges a rolling window only once it holds this many decided outcomes (or the whole window, if smaller). */
export const FLOOR_MIN_SAMPLES = 5;
/** A Thompson draw is never allowed to make a route look free. */
const MIN_P = 0.01;

export function settingsOf(config: Pick<TaskClassConfig, "timeWeight" | "minPassRate" | "explore" | "demoteAfter" | "window" | "cooldownMinutes" | "priors">): RankSettings {
  return {
    timeWeight: config.timeWeight ?? RANK_DEFAULTS.timeWeight,
    minPassRate: config.minPassRate ?? RANK_DEFAULTS.minPassRate,
    explore: config.explore ?? RANK_DEFAULTS.explore,
    demoteAfter: config.demoteAfter ?? RANK_DEFAULTS.demoteAfter,
    window: config.window ?? RANK_DEFAULTS.window,
    cooldownMs: (config.cooldownMinutes ?? RANK_DEFAULTS.cooldownMinutes) * 60_000,
    priors: config.priors ?? {},
  };
}

/** A uniform [0, 1) source. Tests inject a seeded one; production uses Math.random. */
export type Rng = () => number;

function normal(rng: Rng): number {
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
}
/** Marsaglia-Tsang. The iteration cap only matters for a degenerate injected source. */
function gamma(shape: number, rng: Rng): number {
  if (shape < 1) return gamma(shape + 1, rng) * Math.pow(Math.max(rng(), Number.MIN_VALUE), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 200; i += 1) {
    const x = normal(rng);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(Math.max(u, Number.MIN_VALUE)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
  return d;
}
export function sampleBeta(alpha: number, beta: number, rng: Rng): number {
  const a = gamma(alpha, rng);
  const b = gamma(beta, rng);
  return a + b > 0 ? a / (a + b) : alpha / (alpha + beta);
}

export interface RouteStats {
  pass: number;
  fail: number;
  unknown: number;
  /** Decided outcomes whose source is a verdict, a test gate or the operator, not only the worker's own state. */
  verified: number;
  priorN: number;
  alpha: number;
  beta: number;
  /** Posterior mean of p(pass); null with neither a prior nor any evidence. */
  passRate: number | null;
  costUsd: number | null;
  seconds: number | null;
  tokens: number | null;
  failureKinds: Partial<Record<FailureKind, number>>;
}

/** What the store and the prior say about one route of one class. */
export function routeStats(tasks: readonly TaskEvidence[], prior: RoutePrior | undefined): RouteStats {
  let pass = 0; let fail = 0; let unknown = 0; let verified = 0;
  const failureKinds: RouteStats["failureKinds"] = {};
  let costSum = 0; let secondsSum = 0; let tokensSum = 0; let observed = 0;
  for (const task of tasks) {
    if (task.outcome === "pass") pass += 1; else if (task.outcome === "fail") fail += 1; else unknown += 1;
    if (task.outcome !== "unknown" && task.source !== "worker-state") verified += 1;
    if (task.outcome === "fail" && task.failureKind) failureKinds[task.failureKind] = (failureKinds[task.failureKind] ?? 0) + 1;
    // A hop away from a route records that it failed, not what a whole attempt costs.
    if (!task.hop) { costSum += task.costUsd; secondsSum += task.wallSeconds; tokensSum += task.tokens; observed += 1; }
  }
  const priorN = prior?.n ?? 0;
  const priorPass = prior ? Math.min(prior.pass, prior.n) : 0;
  const alpha = 1 + priorPass + pass;
  const beta = 1 + (priorN - priorPass) + fail;
  const hasData = priorN > 0 || tasks.length > 0;
  const mix = (observedSum: number, priorMean: number | undefined): number | null => {
    const weight = (priorMean !== undefined ? priorN : 0) + observed;
    return weight > 0 ? ((priorMean !== undefined ? priorMean * priorN : 0) + observedSum) / weight : null;
  };
  return {
    pass, fail, unknown, verified, priorN, alpha, beta,
    passRate: hasData ? alpha / (alpha + beta) : null,
    costUsd: mix(costSum, prior?.costUsd),
    seconds: mix(secondsSum, prior?.seconds),
    tokens: observed > 0 ? tokensSum / observed : null,
    failureKinds,
  };
}

export interface RouteHealth {
  state: "healthy" | "demoted" | "probe-due";
  /** `failures`: consecutive failures. `floor`: the rolling pass rate. `quota`: spent credits. */
  reason?: "failures" | "floor" | "quota";
  cause?: string;
  /** When the route was last held out (the failure, or the last re-probe marker). */
  since?: number;
  consecutiveFailures: number;
  windowN: number;
  windowPassRate: number | null;
}

/**
 * Replay a route's decided outcomes in order. K consecutive failures, a rolling pass rate under the floor, or one
 * spent-credit failure demotes it; any later pass promotes it and restarts the rolling window. A demoted route is
 * `demoted` until its cooldown (counted from the last failure or the last re-probe marker) ends, then `probe-due`.
 */
export function routeHealth(tasks: readonly TaskEvidence[], probeTimes: readonly number[], settings: RankSettings, now: number): RouteHealth {
  const decided = tasks.filter((task) => task.outcome !== "unknown");
  let consecutive = 0; let windowStart = 0;
  let demoted: { reason: NonNullable<RouteHealth["reason"]>; cause: string; since: number } | undefined;
  const need = Math.min(settings.window, FLOOR_MIN_SAMPLES);
  decided.forEach((task, index) => {
    if (task.outcome === "pass") {
      consecutive = 0;
      if (demoted) { demoted = undefined; windowStart = index; }
      return;
    }
    consecutive += 1;
    if (demoted) { demoted = { ...demoted, since: task.at }; return; }
    const window = decided.slice(Math.max(windowStart, index + 1 - settings.window), index + 1);
    const passes = window.filter((item) => item.outcome === "pass").length;
    if (task.failureKind === "quota") demoted = { reason: "quota", cause: "route refused on spent credits or a usage limit (quota)", since: task.at };
    else if (task.failureKind === "rate-limit") demoted = { reason: "quota", cause: "route is rate-limited (429)", since: task.at };
    else if (consecutive >= settings.demoteAfter) {
      const kinds = [...new Set(decided.slice(index + 1 - consecutive, index + 1).map((item) => item.failureKind ?? "other"))].join(", ");
      demoted = { reason: "failures", cause: `${consecutive} consecutive failures (${kinds})`, since: task.at };
    } else if (settings.minPassRate > 0 && window.length >= need && passes / window.length < settings.minPassRate) {
      demoted = { reason: "floor", cause: `rolling pass rate ${Math.round(100 * passes / window.length)}% over the last ${window.length} is under the ${Math.round(100 * settings.minPassRate)}% floor`, since: task.at };
    }
  });
  const window = decided.slice(Math.max(windowStart, decided.length - settings.window));
  const base = { consecutiveFailures: consecutive, windowN: window.length, windowPassRate: window.length > 0 ? window.filter((item) => item.outcome === "pass").length / window.length : null };
  if (!demoted) return { state: "healthy", ...base };
  const lastProbe = Math.max(0, ...probeTimes.filter((at) => at > demoted!.since));
  const heldSince = Math.max(demoted.since, lastProbe);
  const due = now - heldSince >= settings.cooldownMs;
  return { state: due ? "probe-due" : "demoted", reason: demoted.reason, cause: demoted.cause, since: heldSince, ...base };
}

export interface RankCandidate { entry: string; route: string }
export interface RankResult {
  /** Launchable, non-demoted entries in failover order; empty when every route is held out. */
  order: string[];
  decision: TaskClassDecision;
  /** Entries held out, each with its named cause. */
  excluded: Array<{ entry: string; cause: string }>;
}

const round = (value: number | null, digits: number): number | null => value === null ? null : Number(value.toFixed(digits));

/**
 * Choose among the candidates (already launchable, in chain order). Pure given the evidence view, the settings,
 * the random source and the clock.
 */
export function rankClassRoutes(taskClass: string, candidates: readonly RankCandidate[], settings: RankSettings, view: EvidenceView, rng: Rng, now: number): RankResult {
  const classTasks = view.tasks.filter((task) => task.taskClass === taskClass);
  const rows = candidates.map((candidate) => {
    const tasks = classTasks.filter((task) => task.route === candidate.entry);
    const probes = view.probes.filter((probe) => probe.taskClass === taskClass && probe.route === candidate.entry).map((probe) => probe.at);
    const stats = routeStats(tasks, settings.priors[candidate.entry]);
    return { ...candidate, stats, health: routeHealth(tasks, probes, settings, now) };
  });
  const known = (pick: (row: (typeof rows)[number]) => number | null): number[] => rows.flatMap((row) => { const value = pick(row); return value === null ? [] : [value]; });
  const mean = (values: number[], fallback: number): number => values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
  // A route with no cost or time yet is judged at the class's average, so only p(pass) separates it.
  const poolCost = mean(known((row) => row.stats.costUsd), 1);
  const poolSeconds = mean(known((row) => row.stats.seconds), 0);
  const costOf = (row: (typeof rows)[number]) => row.stats.costUsd ?? poolCost;
  const secondsOf = (row: (typeof rows)[number]) => row.stats.seconds ?? poolSeconds;
  const scoreAt = (row: (typeof rows)[number], p: number) => (costOf(row) + settings.timeWeight * secondsOf(row)) / Math.max(p, MIN_P);
  const meanScore = (row: (typeof rows)[number]) => scoreAt(row, row.stats.passRate ?? 0.5);

  const estimate = (row: (typeof rows)[number], extra: Partial<TaskClassEstimate> = {}): TaskClassEstimate => ({
    entry: row.entry,
    status: row.health.state === "healthy" ? "ranked" : row.health.state === "probe-due" ? "probe" : row.health.reason === "floor" ? "floor" : "demoted",
    ...(row.health.cause ? { cause: row.health.cause } : {}),
    n: row.stats.pass + row.stats.fail, priorN: row.stats.priorN,
    passRate: round(row.stats.passRate, 4),
    expectedCostUsd: round(row.stats.costUsd, 6), expectedSeconds: round(row.stats.seconds, 2),
    score: row.stats.passRate === null && row.stats.costUsd === null ? null : round(meanScore(row), 6),
    ...extra,
  });
  const header = { timeWeight: settings.timeWeight, minPassRate: settings.minPassRate, explore: settings.explore };
  const asOrder = (entries: readonly string[]) => entries.map((entry) => ({ entry, route: candidates.find((candidate) => candidate.entry === entry)!.route }));

  // Nothing known about any route: the operator's order is the only evidence there is.
  if (rows.every((row) => row.stats.passRate === null)) {
    return {
      order: candidates.map((candidate) => candidate.entry), excluded: [],
      decision: { mode: "chain-order", winner: candidates[0]?.entry ?? "", explored: false, order: asOrder(candidates.map((candidate) => candidate.entry)), estimates: rows.map((row) => estimate(row)), ...header },
    };
  }

  const healthy = rows.filter((row) => row.health.state === "healthy");
  const due = rows.filter((row) => row.health.state === "probe-due");
  const excluded = rows.filter((row) => row.health.state === "demoted").map((row) => ({ entry: row.entry, cause: `${row.health.cause}; held out until its cooldown ends` }));
  // The exploration roll comes first so the share does not depend on how many draws the posteriors consume.
  const roll = rng();
  const draws = new Map(healthy.map((row) => [row.entry, sampleBeta(row.stats.alpha, row.stats.beta, rng)] as const));
  const byMean = [...healthy].sort((a, b) => meanScore(a) - meanScore(b) || candidates.findIndex((c) => c.entry === a.entry) - candidates.findIndex((c) => c.entry === b.entry));
  const best = byMean[0];
  let winner = best;
  let mode: TaskClassDecision["mode"] = "exploit";
  if (healthy.length >= 2) {
    const sampled = [...healthy].sort((a, b) => scoreAt(a, draws.get(a.entry)!) - scoreAt(b, draws.get(b.entry)!) || candidates.findIndex((c) => c.entry === a.entry) - candidates.findIndex((c) => c.entry === b.entry));
    if (roll < settings.explore) {
      const others = byMean.slice(1);
      winner = others[Math.min(others.length - 1, Math.floor(rng() * others.length))];
      mode = "explore";
    } else if (sampled[0].entry !== best.entry) {
      winner = sampled[0];
      mode = "thompson";
    }
  }
  const failover = byMean.filter((row) => row.entry !== winner?.entry).map((row) => row.entry);
  // A route due for its one re-probe goes first; the healthy ones behind it take over if it fails before output.
  const probe = due[0];
  const order = probe ? [probe.entry, ...(winner ? [winner.entry] : []), ...failover] : winner ? [winner.entry, ...failover] : [];
  const leader = probe ?? winner;
  const estimates = rows.map((row) => estimate(row, draws.has(row.entry) ? { sampledPassRate: round(draws.get(row.entry)!, 4)! } : {}));
  return {
    order,
    excluded: [...excluded, ...due.slice(1).map((row) => ({ entry: row.entry, cause: `${row.health.cause}; its re-probe waits for the next dispatch` }))],
    decision: {
      mode: probe ? "probe" : leader ? mode : "exploit", winner: leader?.entry ?? "",
      explored: probe !== undefined || (leader !== undefined && best !== undefined && leader.entry !== best.entry),
      order: asOrder(order), estimates, ...header,
    },
  };
}

/** The decision in the words of a dispatch note: winner, per-route estimates, evidence counts, demotions. */
export function describeDecision(decision: TaskClassDecision): string {
  const money = (value: number | null) => value === null ? "?" : `$${value < 0.01 ? value.toPrecision(2) : value.toFixed(3)}`;
  const parts = decision.estimates.map((item) => {
    const p = item.passRate === null ? "?" : item.passRate.toFixed(2);
    const state = item.status === "ranked" ? "" : ` [${item.status}: ${item.cause ?? "held out"}]`;
    return `${item.entry} p(pass) ${p}, E[cost] ${money(item.expectedCostUsd)}, E[s] ${item.expectedSeconds ?? "?"}, n=${item.n}${item.priorN > 0 ? `+${item.priorN} prior` : ""}${state}`;
  });
  return `winner ${decision.winner || "none"} (${decision.mode}; explored ${decision.explored ? "yes" : "no"}; timeWeight ${decision.timeWeight}, floor ${decision.minPassRate}, explore ${decision.explore}); ${parts.join(" | ")}`;
}

export interface RouteReportRow {
  entry: string;
  pass: number; fail: number; unknown: number; verified: number;
  priorN: number;
  passRate: number | null;
  expectedCostUsd: number | null;
  expectedSeconds: number | null;
  /** Expected cost per correct result at the posterior mean. */
  score: number | null;
  health: RouteHealth["state"];
  cause?: string;
  failureKinds: RouteStats["failureKinds"];
}
export interface ClassReport { taskClass: string; settings: Omit<RankSettings, "priors">; routes: RouteReportRow[] }

/** The read-only per-class estimate table the hub prints: no draws, no exploration, just the store. */
export function classReport(taskClass: string, entries: readonly string[], settings: RankSettings, view: EvidenceView, now: number): ClassReport {
  const classTasks = view.tasks.filter((task) => task.taskClass === taskClass);
  const known = [...new Set([...entries, ...classTasks.map((task) => task.route)])];
  const rows = known.map((entry) => {
    const tasks = classTasks.filter((task) => task.route === entry);
    const probes = view.probes.filter((probe) => probe.taskClass === taskClass && probe.route === entry).map((probe) => probe.at);
    return { entry, stats: routeStats(tasks, settings.priors[entry]), health: routeHealth(tasks, probes, settings, now) };
  });
  const costs = rows.flatMap((row) => row.stats.costUsd === null ? [] : [row.stats.costUsd]);
  const seconds = rows.flatMap((row) => row.stats.seconds === null ? [] : [row.stats.seconds]);
  const poolCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : 1;
  const poolSeconds = seconds.length > 0 ? seconds.reduce((a, b) => a + b, 0) / seconds.length : 0;
  const { priors: _priors, ...rest } = settings;
  return {
    taskClass, settings: rest,
    routes: rows.map(({ entry, stats, health }) => ({
      entry, pass: stats.pass, fail: stats.fail, unknown: stats.unknown, verified: stats.verified, priorN: stats.priorN,
      passRate: round(stats.passRate, 4), expectedCostUsd: round(stats.costUsd, 6), expectedSeconds: round(stats.seconds, 2),
      score: stats.passRate === null ? null : round(((stats.costUsd ?? poolCost) + settings.timeWeight * (stats.seconds ?? poolSeconds)) / Math.max(stats.passRate, MIN_P), 6),
      health: health.state, ...(health.cause ? { cause: health.cause } : {}), failureKinds: stats.failureKinds,
    })),
  };
}

export function formatClassReport(report: ClassReport): string {
  const money = (value: number | null) => value === null ? "?" : `$${value < 0.01 ? value.toPrecision(2) : value.toFixed(3)}`;
  const lines = [`class ${report.taskClass} · timeWeight ${report.settings.timeWeight} · floor ${report.settings.minPassRate} · explore ${report.settings.explore} · demote after ${report.settings.demoteAfter} failures / window ${report.settings.window} / cooldown ${Math.round(report.settings.cooldownMs / 60_000)} min`];
  for (const row of report.routes) {
    const kinds = Object.entries(row.failureKinds).map(([kind, count]) => `${kind}×${count}`).join(", ");
    lines.push(`  ${row.entry}: ${row.health}${row.cause ? ` (${row.cause})` : ""} · p(pass) ${row.passRate === null ? "?" : row.passRate.toFixed(2)} · pass ${row.pass} fail ${row.fail} unknown ${row.unknown} (verified ${row.verified}${row.priorN > 0 ? `, prior n ${row.priorN}` : ""}) · E[cost] ${money(row.expectedCostUsd)} · E[s] ${row.expectedSeconds ?? "?"} · cost per correct ${money(row.score)}${kinds ? ` · failures ${kinds}` : ""}`);
  }
  return lines.join("\n");
}

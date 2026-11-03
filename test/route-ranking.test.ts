// Evidence-driven ranking inside a task class: the decision must follow the evidence, never a hardcoded winner.
// Every name is synthetic. The random source and the clock are injected, so each decision is reproducible.
import { describe, expect, it } from "vitest";
import type { TaskEvidence } from "../src/subagents/route-evidence.ts";
import { FLOOR_MIN_SAMPLES, classReport, describeDecision, formatClassReport, rankClassRoutes, routeHealth, routeStats, sampleBeta, settingsOf, type Rng } from "../src/subagents/route-ranking.ts";

function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60_000;
let clock = 1_000_000;
function row(route: string, outcome: TaskEvidence["outcome"], over: Partial<TaskEvidence> = {}): TaskEvidence {
  clock += 1_000;
  return { v: 1, kind: "task", at: clock, runId: `run-${clock}`, taskId: `task-${clock}`, label: "leaf", taskClass: "class-a", route, outcome, source: "worker-state", wallSeconds: 10, costUsd: 0.01, tokens: 100, ...(outcome === "fail" ? { failureKind: "other" as const } : {}), ...over };
}
const many = (route: string, passes: number, fails: number, over: Partial<TaskEvidence> = {}): TaskEvidence[] => [
  ...Array.from({ length: passes }, () => row(route, "pass", over)),
  ...Array.from({ length: fails }, () => row(route, "fail", over)),
];
const A = { entry: "route-a", route: "p-a/model-a" };
const B = { entry: "route-b", route: "p-b/model-b" };
const view = (tasks: TaskEvidence[], probes: Array<{ at: number; route: string }> = []) => ({
  tasks, probes: probes.map((probe) => ({ v: 1 as const, kind: "probe" as const, at: probe.at, taskClass: "class-a", route: probe.route })),
});
const settings = (over: Parameters<typeof settingsOf>[0] = {}) => settingsOf({ explore: 0, ...over });
const NOW = clock + 10 * MIN;
const winners = (tasks: TaskEvidence[], config: Parameters<typeof settingsOf>[0], draws = 60, now = NOW) =>
  Array.from({ length: draws }, (_, index) => rankClassRoutes("class-a", [A, B], settings(config), view(tasks), seeded(index + 1), now).decision.winner);

describe("beta sampling", () => {
  it("draws from the posterior: the mean follows alpha and beta", () => {
    const rng = seeded(7);
    const draws = Array.from({ length: 4000 }, () => sampleBeta(8, 2, rng));
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
    expect(mean).toBeGreaterThan(0.77);
    expect(mean).toBeLessThan(0.83);
    expect(Math.min(...draws)).toBeGreaterThan(0);
    expect(Math.max(...draws)).toBeLessThan(1);
  });
  it("terminates for a degenerate injected source", () => {
    expect(sampleBeta(5, 5, () => 0.5)).toBeGreaterThan(0);
    expect(sampleBeta(5, 5, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

describe("route stats", () => {
  it("combines the operator prior with the evidence", () => {
    const stats = routeStats([...many("route-a", 3, 1, { costUsd: 0.02, wallSeconds: 20 })], { pass: 8, n: 10, costUsd: 0.01, seconds: 10 });
    expect(stats).toMatchObject({ pass: 3, fail: 1, priorN: 10 });
    expect(stats.alpha).toBe(1 + 8 + 3);
    expect(stats.beta).toBe(1 + 2 + 1);
    // 10 prior trials at $0.01 + 4 observed at $0.02, weighted by count.
    expect(stats.costUsd).toBeCloseTo((10 * 0.01 + 4 * 0.02) / 14, 9);
    expect(stats.seconds).toBeCloseTo((10 * 10 + 4 * 20) / 14, 9);
  });
  it("has no estimate with neither prior nor evidence, and counts verified outcomes apart", () => {
    expect(routeStats([], undefined)).toMatchObject({ passRate: null, costUsd: null, seconds: null });
    const stats = routeStats([row("route-a", "pass", { source: "verification" }), row("route-a", "pass"), row("route-a", "unknown")], undefined);
    expect(stats).toMatchObject({ pass: 2, unknown: 1, verified: 1 });
  });
  it("does not let a failover hop pose as a whole attempt's cost", () => {
    const stats = routeStats([row("route-a", "pass", { costUsd: 0.04 }), row("route-a", "fail", { costUsd: 0, wallSeconds: 0, hop: true })], undefined);
    expect(stats.costUsd).toBeCloseTo(0.04, 9);
    expect(stats).toMatchObject({ pass: 1, fail: 1 });
  });
});

describe("ranking follows the evidence", () => {
  it("keeps the configured order with neither priors nor evidence", () => {
    const result = rankClassRoutes("class-a", [A, B], settings(), view([]), seeded(1), NOW);
    expect(result.decision).toMatchObject({ mode: "chain-order", winner: "route-a", explored: false });
    expect(result.order).toEqual(["route-a", "route-b"]);
    const flipped = rankClassRoutes("class-a", [B, A], settings(), view([]), seeded(1), NOW);
    expect(flipped.order).toEqual(["route-b", "route-a"]);
  });

  it("flips the winner when the evidence flips (no hardcoded winner)", () => {
    const aGood = [...many("route-a", 18, 2), ...many("route-b", 6, 14)];
    const bGood = [...many("route-a", 6, 14), ...many("route-b", 18, 2)];
    expect(new Set(winners(aGood, { demoteAfter: 50 }))).toEqual(new Set(["route-a"]));
    expect(new Set(winners(bGood, { demoteAfter: 50 }))).toEqual(new Set(["route-b"]));
    // And the chain order is not what decides it: the first-listed route loses when the evidence says so.
    const result = rankClassRoutes("class-a", [A, B], settings({ demoteAfter: 50 }), view(bGood), seeded(3), NOW);
    expect(result.order).toEqual(["route-b", "route-a"]);
    expect(result.decision.mode).not.toBe("chain-order");
  });

  it("ranks on cost per correct result, not on pass rate alone", () => {
    // A passes more often but costs ten times as much per attempt.
    const tasks = [...many("route-a", 18, 2, { costUsd: 0.1 }), ...many("route-b", 16, 4, { costUsd: 0.01 })];
    expect(new Set(winners(tasks, { demoteAfter: 50 }))).toEqual(new Set(["route-b"]));
    const cheap = rankClassRoutes("class-a", [A, B], settings({ demoteAfter: 50 }), view(tasks), seeded(2), NOW).decision;
    const scoreA = cheap.estimates.find((item) => item.entry === "route-a")!.score!;
    const scoreB = cheap.estimates.find((item) => item.entry === "route-b")!.score!;
    expect(scoreB).toBeLessThan(scoreA);
    expect(scoreA).toBeCloseTo(0.1 / (19 / 22), 3);
  });

  it("weighs time by timeWeight: the same evidence ranks differently once seconds cost money", () => {
    const tasks = [...many("route-a", 18, 2, { costUsd: 0.01, wallSeconds: 600 }), ...many("route-b", 18, 2, { costUsd: 0.02, wallSeconds: 5 })];
    expect(new Set(winners(tasks, { demoteAfter: 50, timeWeight: 0 }))).toEqual(new Set(["route-a"]));
    expect(new Set(winners(tasks, { demoteAfter: 50, timeWeight: 0.001 }))).toEqual(new Set(["route-b"]));
  });

  it("starts from the operator's priors and lets evidence outweigh them", () => {
    const priors = { "route-a": { pass: 19, n: 20, costUsd: 0.01, seconds: 10 }, "route-b": { pass: 8, n: 20, costUsd: 0.01, seconds: 10 } };
    const none = rankClassRoutes("class-a", [B, A], settings({ priors }), view([]), seeded(5), NOW);
    expect(none.order[0]).toBe("route-a");
    expect(none.decision.mode).not.toBe("chain-order");
    expect(none.decision.estimates.find((item) => item.entry === "route-a")).toMatchObject({ n: 0, priorN: 20 });
    // Fresh evidence contradicts the priors: A fails, B passes.
    const later = [...many("route-a", 1, 60, { failureKind: "other" }), ...many("route-b", 60, 0)];
    expect(new Set(winners(later, { priors, demoteAfter: 500, window: 500 }))).toEqual(new Set(["route-b"]));
  });

  it("explains each route: pass rate, expected cost and seconds, evidence count", () => {
    const tasks = [...many("route-a", 9, 1, { costUsd: 0.02, wallSeconds: 8 }), ...many("route-b", 2, 2, { costUsd: 0.05, wallSeconds: 30 })];
    const { decision } = rankClassRoutes("class-a", [A, B], settings({ priors: { "route-b": { pass: 3, n: 4 } }, timeWeight: 0.0005 }), view(tasks), seeded(9), NOW);
    expect(decision.estimates).toHaveLength(2);
    const a = decision.estimates.find((item) => item.entry === "route-a")!;
    expect(a).toMatchObject({ status: "ranked", n: 10, priorN: 0, expectedCostUsd: 0.02, expectedSeconds: 8 });
    expect(a.passRate).toBeCloseTo(10 / 12, 3);
    expect(a.sampledPassRate).toBeGreaterThan(0);
    expect(decision.estimates.find((item) => item.entry === "route-b")).toMatchObject({ n: 4, priorN: 4 });
    expect(decision.timeWeight).toBe(0.0005);
    const text = describeDecision(decision);
    expect(text).toContain(`winner ${decision.winner}`);
    expect(text).toContain("route-a p(pass) 0.83");
    expect(text).toContain("n=10");
    expect(text).toContain("n=4+4 prior");
  });
});

describe("exploration keeps a weaker route's estimate alive", () => {
  const strong = [...many("route-a", 40, 0), ...many("route-b", 5, 35)];
  const run = (explore: number, draws: number) => {
    const rng = seeded(20_260_211);
    const picks = Array.from({ length: draws }, () => rankClassRoutes("class-a", [A, B], settings({ explore, demoteAfter: 500, window: 500 }), view(strong), rng, NOW).decision);
    return { weaker: picks.filter((pick) => pick.winner === "route-b"), picks };
  };

  it("picks the weaker route at about the explore share, and says it explored", () => {
    const { weaker, picks } = run(0.1, 4000);
    const share = weaker.length / picks.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.12);
    expect(weaker.every((pick) => pick.explored && pick.mode === "explore")).toBe(true);
    expect(picks.filter((pick) => pick.winner === "route-a").every((pick) => !pick.explored && pick.mode === "exploit")).toBe(true);
  });
  it("follows the configured share", () => {
    const { weaker, picks } = run(0.3, 3000);
    expect(weaker.length / picks.length).toBeGreaterThan(0.27);
    expect(weaker.length / picks.length).toBeLessThan(0.33);
  });
  it("never explores with a share of 0", () => {
    expect(run(0, 2000).weaker).toHaveLength(0);
  });
  it("puts the explored route first and the expected best behind it for a failover", () => {
    const { weaker } = run(0.5, 50);
    expect(weaker.length).toBeGreaterThan(0);
    const rng = seeded(1);
    for (let index = 0; index < 200; index += 1) {
      const result = rankClassRoutes("class-a", [A, B], settings({ explore: 0.5, demoteAfter: 500, window: 500 }), view(strong), rng, NOW);
      if (result.decision.winner === "route-b") { expect(result.order).toEqual(["route-b", "route-a"]); return; }
    }
    throw new Error("no explored pick in 200 draws");
  });
  it("does not explore when only one route is eligible", () => {
    const result = rankClassRoutes("class-a", [A], settings({ explore: 0.5 }), view(many("route-a", 5, 1)), seeded(1), NOW);
    expect(result.decision).toMatchObject({ winner: "route-a", explored: false });
  });
});

describe("self-healing: the floor, demotion, re-probe and promotion", () => {
  it("excludes a route under the pass-rate floor even when it is the cheapest", () => {
    // K is raised out of the way: only the rolling rate demotes it (4 of 7 is 57%, under the 60% floor).
    const bad = ["pass", "pass", "pass", "pass", "fail", "fail", "fail", "fail", "fail", "fail"].map((outcome) => row("route-b", outcome as "pass" | "fail", { costUsd: 0.0005 }));
    const tasks = [...many("route-a", 9, 1, { costUsd: 0.05 }), ...bad];
    expect(bad.length).toBeGreaterThanOrEqual(FLOOR_MIN_SAMPLES);
    const open = rankClassRoutes("class-a", [A, B], settings({ demoteAfter: 50 }), view(tasks), seeded(4), NOW);
    expect(open.order[0]).toBe("route-b"); // without a floor the cheap route wins on cost per correct result
    const floored = rankClassRoutes("class-a", [A, B], settings({ demoteAfter: 50, minPassRate: 0.6 }), view(tasks), seeded(4), NOW);
    expect(floored.order).toEqual(["route-a"]);
    expect(floored.decision.estimates.find((item) => item.entry === "route-b")).toMatchObject({ status: "floor" });
    expect(floored.excluded[0].entry).toBe("route-b");
    expect(floored.excluded[0].cause).toMatch(/rolling pass rate 57% over the last 7 is under the 60% floor/);
  });
  it("does not judge a floor on a window thinner than the minimum sample", () => {
    const tasks = many("route-b", 0, FLOOR_MIN_SAMPLES - 1);
    const health = routeHealth(tasks, [], settings({ demoteAfter: 50, minPassRate: 0.9 }), NOW);
    expect(health.state).toBe("healthy");
  });

  it("demotes a route after K consecutive failures and names why", () => {
    const failing = [row("route-a", "fail", { failureKind: "empty-output" }), row("route-a", "fail", { failureKind: "reasoning-exhausted" }), row("route-a", "fail", { failureKind: "empty-output" })];
    const tasks = [...many("route-a", 9, 0), ...failing, ...many("route-b", 8, 2)];
    const result = rankClassRoutes("class-a", [A, B], settings({ demoteAfter: 3 }), view(tasks), seeded(1), NOW);
    expect(result.order).toEqual(["route-b"]);
    expect(result.decision.estimates.find((item) => item.entry === "route-a")).toMatchObject({ status: "demoted", cause: "3 consecutive failures (empty-output, reasoning-exhausted)" });
    expect(result.excluded[0].cause).toContain("held out until its cooldown ends");
    // Two in a row is not K.
    const two = [...many("route-a", 9, 0), ...failing.slice(0, 2), ...many("route-b", 8, 2)];
    expect(rankClassRoutes("class-a", [A, B], settings({ demoteAfter: 3 }), view(two), seeded(1), NOW).order).toContain("route-a");
    // And a pass in between resets the streak.
    const broken = [row("route-a", "fail"), row("route-a", "fail"), row("route-a", "pass"), row("route-a", "fail")];
    expect(routeHealth(broken, [], settings({ demoteAfter: 3 }), NOW).state).toBe("healthy");
  });
  it("demotes at once on spent credits (quota), whatever K is", () => {
    const tasks = [...many("route-a", 10, 0), row("route-a", "fail", { failureKind: "quota" })];
    const health = routeHealth(tasks, [], settings({ demoteAfter: 50 }), clock + 1000);
    expect(health).toMatchObject({ state: "demoted", reason: "quota" });
  });
  it("holds a rate-limited route out at once (2026-11-03: a route kept getting scouts while returning 429)", () => {
    const tasks = [...many("route-a", 10, 0), row("route-a", "fail", { failureKind: "rate-limit" })];
    const health = routeHealth(tasks, [], settings({ demoteAfter: 50 }), clock + 1000);
    expect(health).toMatchObject({ state: "demoted", cause: "route is rate-limited (429)" });
  });
  it("ignores unknown outcomes", () => {
    const tasks = [row("route-a", "fail"), row("route-a", "unknown"), row("route-a", "fail"), row("route-a", "unknown"), row("route-a", "fail")];
    expect(routeHealth(tasks, [], settings({ demoteAfter: 3 }), clock + 1)).toMatchObject({ state: "demoted", consecutiveFailures: 3 });
  });

  it("re-probes a demoted route once after the cooldown, then promotes it on a pass", () => {
    const failures = many("route-a", 0, 3, { failureKind: "http-5xx" });
    const lastFailure = failures[failures.length - 1].at;
    const base = [...many("route-b", 8, 2), ...failures];
    const config = { demoteAfter: 3, cooldownMinutes: 30 };
    const at = (offsetMs: number, tasks: TaskEvidence[], probes: Array<{ at: number; route: string }> = []) =>
      rankClassRoutes("class-a", [A, B], settings(config), view(tasks, probes), seeded(11), lastFailure + offsetMs);

    // Inside the cooldown: skipped, with the cause named.
    const held = at(29 * MIN, base);
    expect(held.order).toEqual(["route-b"]);
    expect(held.decision.estimates.find((item) => item.entry === "route-a")).toMatchObject({ status: "demoted", cause: "3 consecutive failures (http-5xx)" });

    // Cooldown over: exactly one exploratory pick of the demoted route, healthy route behind it for a failover.
    const probe = at(30 * MIN, base);
    expect(probe.decision).toMatchObject({ mode: "probe", winner: "route-a", explored: true });
    expect(probe.order).toEqual(["route-a", "route-b"]);

    // The probe's marker restarts the cooldown: the next dispatch does not probe again.
    const marker = [{ at: lastFailure + 30 * MIN, route: "route-a" }];
    expect(at(31 * MIN, base, marker).order).toEqual(["route-b"]);
    expect(at(31 * MIN, base, marker).decision.mode).not.toBe("probe");

    // A failed probe holds it out for another full cooldown.
    const failedProbe = [...base, row("route-a", "fail", { failureKind: "http-5xx", at: lastFailure + 30 * MIN + 5_000 })];
    expect(rankClassRoutes("class-a", [A, B], settings(config), view(failedProbe, marker), seeded(11), lastFailure + 31 * MIN).order).toEqual(["route-b"]);
    expect(rankClassRoutes("class-a", [A, B], settings(config), view(failedProbe, marker), seeded(11), lastFailure + 30 * MIN + 5_000 + 30 * MIN).decision.mode).toBe("probe");

    // A passing probe promotes it: it is ranked again, with its failure streak cleared.
    const promoted = [...base, row("route-a", "pass", { at: lastFailure + 30 * MIN + 5_000 })];
    const after = rankClassRoutes("class-a", [A, B], settings(config), view(promoted, marker), seeded(11), lastFailure + 31 * MIN);
    expect(after.decision.estimates.find((item) => item.entry === "route-a")).toMatchObject({ status: "ranked" });
    expect(after.order).toHaveLength(2);
    expect(routeHealth(promoted.filter((item) => item.route === "route-a"), [], settings(config), lastFailure + 31 * MIN)).toMatchObject({ state: "healthy", consecutiveFailures: 0 });
  });
  it("restarts the rolling window on promotion, so one new failure does not re-demote on old history", () => {
    const old = ["fail", "fail", "pass", "fail", "fail", "fail"].map((outcome) => row("route-a", outcome as "pass" | "fail"));
    const healed = [...old, row("route-a", "pass"), row("route-a", "fail")];
    expect(routeHealth(healed, [], settings({ demoteAfter: 3, minPassRate: 0.8 }), clock + 1).state).toBe("healthy");
  });
  it("returns no route when every route is held out, and lists every cause", () => {
    const tasks = [...many("route-a", 0, 3), ...many("route-b", 0, 3)];
    const result = rankClassRoutes("class-a", [A, B], settings({ demoteAfter: 3 }), view(tasks), seeded(1), clock + MIN);
    expect(result.order).toEqual([]);
    expect(result.decision.winner).toBe("");
    expect(result.excluded.map((item) => item.entry)).toEqual(["route-a", "route-b"]);
  });
});

describe("the read-only view", () => {
  it("reports per-route estimates, health and failure kinds from the store", () => {
    const tasks = [...many("route-a", 8, 2, { costUsd: 0.02, wallSeconds: 6, source: "verification" }), ...many("route-b", 0, 3, { failureKind: "quota" })];
    const report = classReport("class-a", ["route-a", "route-b", "route-c"], settings({ demoteAfter: 3 }), view(tasks), clock + MIN);
    expect(report.routes.map((item) => item.entry)).toEqual(["route-a", "route-b", "route-c"]);
    expect(report.routes[0]).toMatchObject({ pass: 8, fail: 2, verified: 10, health: "healthy", expectedCostUsd: 0.02, expectedSeconds: 6 });
    expect(report.routes[1]).toMatchObject({ health: "demoted", failureKinds: { quota: 3 } });
    expect(report.routes[2]).toMatchObject({ pass: 0, fail: 0, passRate: null });
    const text = formatClassReport(report);
    expect(text).toContain("class class-a");
    expect(text).toContain("route-b: demoted");
    expect(text).toContain("quota×3");
  });
});

// Harness choice per job: a candidate is (harness, model route), ranked by the same per-class machinery as a model
// route. Quality is a gate (a candidate credibly below the best is out), verified outcomes count more than a worker's
// own "done", a timeout is a quality and a speed failure, the receipt names the harness and why, project policy
// filters candidates before they are ranked, and no harness is preferred by code. Every name is synthetic.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createUltratermSubagentsExtension } from "../extensions/ultraterm-subagents.ts";
import { parseRoutingConfig, RoutingConfigError } from "../src/routing-config.ts";
import { RouteEvidenceStore, settledTaskEvidence, type TaskEvidence } from "../src/subagents/route-evidence.ts";
import { RANK_DEFAULTS, describeDecision, rankClassRoutes, routeStats, settingsOf, type Rng } from "../src/subagents/route-ranking.ts";
import { HARNESS_IDS, emptyUsage, type RunRecord, type TaskRecord, type WorkerRunContext } from "../src/subagents/types.ts";

type Model = NonNullable<ExtensionContext["model"]>;
const dir = mkdtempSync(join(tmpdir(), "steak-pi-harness-routing-"));
let files = 0;
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

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
  return { v: 1, kind: "task", at: clock, runId: `run-${clock}`, taskId: `task-${clock}`, label: "leaf", taskClass: "class-h", route, outcome, source: "verification", wallSeconds: 10, costUsd: 0.01, tokens: 100, ...(outcome === "fail" ? { failureKind: "other" as const } : {}), ...over };
}
/** Passes spread evenly between the fails, so no streak demotes a route by accident. */
function spread(route: string, passes: number, fails: number, over: Partial<TaskEvidence> = {}): TaskEvidence[] {
  const total = passes + fails;
  return Array.from({ length: total }, (_, index) => {
    const pass = Math.floor(((index + 1) * passes) / total) > Math.floor((index * passes) / total);
    return row(route, pass ? "pass" : "fail", over);
  });
}
const view = (tasks: TaskEvidence[]) => ({ tasks, probes: [] });
const NATIVE = { entry: "alpha-p/alpha-model", route: "alpha-p/alpha-model", harness: "pi" };
const DSH = { entry: "steak-dsh/alpha-p/alpha-model", route: "steak-dsh/alpha-p/alpha-model", harness: "steak-dsh" };
const NOW = () => clock + 10 * MIN;
const settings = (over: Parameters<typeof settingsOf>[0] = {}) => settingsOf({ explore: 0, demoteAfter: 100, window: 500, ...over });

describe("quality is a gate, not a trade", () => {
  // The cheap candidate passes a third of its verified runs; the dear one passes every run. Cost per pass alone
  // would pick the cheap one (0.001 / 0.33 is far under 0.05 / 1.0).
  const evidence = () => [...spread(NATIVE.entry, 30, 0, { costUsd: 0.05 }), ...spread(DSH.entry, 10, 20, { costUsd: 0.001 })];

  it("holds out a candidate whose verified pass rate is credibly below the best, whatever it costs", () => {
    const tasks = evidence();
    for (let draw = 1; draw <= 40; draw += 1) {
      const result = rankClassRoutes("class-h", [NATIVE, DSH], settings(), view(tasks), seeded(draw), NOW());
      expect(result.decision.winner).toBe(NATIVE.entry);
      expect(result.decision.mode).not.toBe("explore");
      // Never the pick; only the last resort of a runtime failover once every better route has failed.
      expect(result.order).toEqual([NATIVE.entry, DSH.entry]);
      const gated = result.decision.estimates.find((item) => item.entry === DSH.entry)!;
      expect(gated.status).toBe("gated");
      expect(gated.cause).toMatch(/credibly below/);
    }
  });
  it("never explores a gated candidate, whatever the exploration share", () => {
    const tasks = evidence();
    for (let draw = 1; draw <= 60; draw += 1) {
      const result = rankClassRoutes("class-h", [NATIVE, DSH], settings({ explore: 0.5 }), view(tasks), seeded(draw), NOW());
      expect(result.decision.winner).toBe(NATIVE.entry);
    }
  });
  it("keeps a gated candidate behind every ungated one in the failover order", () => {
    const third = { entry: "gamma-p/gamma-model", route: "gamma-p/gamma-model", harness: "pi" };
    const tasks = [...evidence(), ...spread(third.entry, 28, 2, { costUsd: 0.04 })];
    const result = rankClassRoutes("class-h", [DSH, NATIVE, third], settings(), view(tasks), seeded(1), NOW());
    expect(result.order.at(-1)).toBe(DSH.entry);
  });
  it("does not gate a candidate whose interval still overlaps the best", () => {
    const tasks = [...spread(NATIVE.entry, 9, 1, { costUsd: 0.05 }), ...spread(DSH.entry, 7, 3, { costUsd: 0.001 })];
    const result = rankClassRoutes("class-h", [NATIVE, DSH], settings(), view(tasks), seeded(1), NOW());
    expect(result.decision.estimates.every((item) => item.status === "ranked")).toBe(true);
    // Not credibly worse, and far cheaper: the cheap candidate is the expected-best pick.
    expect(result.decision.winner).toBe(DSH.entry);
  });
  it("is the operator's to turn off (qualityGate 0 ranks on cost per pass alone)", () => {
    const result = rankClassRoutes("class-h", [NATIVE, DSH], settings({ qualityGate: 0 }), view(evidence()), seeded(1), NOW());
    expect(result.decision.winner).toBe(DSH.entry);
  });
  it("re-probes a gated candidate once its cooldown has passed, so a harness that improved is tried again", () => {
    const tasks = evidence();
    const later = Math.max(...tasks.map((item) => item.at)) + 31 * MIN;
    const result = rankClassRoutes("class-h", [NATIVE, DSH], settings({ cooldownMinutes: 30 }), view(tasks), seeded(1), later);
    expect(result.decision.mode).toBe("probe");
    expect(result.order[0]).toBe(DSH.entry);
  });
});

describe("verified outcomes count more than a worker's own report", () => {
  it("weighs a self-reported pass below a verified one; a failure counts fully either way", () => {
    const self = routeStats(spread("r", 4, 0, { source: "worker-state" }), undefined, 0.5);
    const verified = routeStats(spread("r", 4, 0, { source: "verification" }), undefined, 0.5);
    expect(self.alpha).toBe(1 + 2);
    expect(verified.alpha).toBe(1 + 4);
    const failed = routeStats([row("r", "fail", { source: "worker-state" })], undefined, 0.5);
    expect(failed.beta).toBe(1 + 1);
  });
  it("ranks 20 verified passes above 30 self-reported ones at the default weight", () => {
    const tasks = [...spread(NATIVE.entry, 30, 0, { source: "worker-state" }), ...spread(DSH.entry, 20, 0, { source: "test-gate" })];
    const result = rankClassRoutes("class-h", [NATIVE, DSH], settings(), view(tasks), seeded(1), NOW());
    const p = (entry: string) => result.decision.estimates.find((item) => item.entry === entry)!.passRate!;
    expect(p(DSH.entry)).toBeGreaterThan(p(NATIVE.entry));
    expect(RANK_DEFAULTS.selfReportWeight).toBeLessThan(1);
  });
});

describe("a timeout is a quality failure and a speed failure", () => {
  it("records a timed-out task as a fail named timeout, with its full wall time and spend", () => {
    const run = {
      id: "run-t", model: "alpha-p/alpha-model",
      selection: { taskClass: { name: "class-h", outcome: "served", step: "alpha-p/alpha-model", reason: "r" } },
    } as unknown as RunRecord;
    const task = {
      id: "task-t", label: "leaf", taskClass: "class-h", state: "timed_out", output: "", error: "Worker timed out after 600000ms",
      startedAt: 1_000, endedAt: 601_000, usage: { ...emptyUsage(), cost: { ...emptyUsage().cost, total: 0.2 }, totalTokens: 900 },
    } as unknown as TaskRecord;
    const [record] = settledTaskEvidence(run, task, 2_000_000);
    expect(record).toMatchObject({ outcome: "fail", failureKind: "timeout", wallSeconds: 600, costUsd: 0.2, harness: "pi" });
  });
});

describe("the decision names the harness of every candidate", () => {
  it("carries each candidate's harness and says which harness won and why", () => {
    const tasks = [...spread(NATIVE.entry, 30, 0, { costUsd: 0.05 }), ...spread(DSH.entry, 30, 0, { costUsd: 0.01 })];
    const result = rankClassRoutes("class-h", [NATIVE, DSH], settings(), view(tasks), seeded(1), NOW());
    expect(result.decision.estimates.map((item) => item.harness)).toEqual(["pi", "steak-dsh"]);
    expect(result.decision.winnerHarness).toBe("steak-dsh");
    expect(describeDecision(result.decision)).toMatch(/winner steak-dsh\/alpha-p\/alpha-model on harness steak-dsh/);
  });
});

describe("no harness is preferred by code", () => {
  it("ranks two harnesses with identical evidence by the operator's chain order alone, in either order", () => {
    for (const evidence of [[], [...spread(NATIVE.entry, 5, 0), ...spread(DSH.entry, 5, 0)]]) {
      for (const [first, second] of [[NATIVE, DSH], [DSH, NATIVE]]) {
        // With no data: chain order. With identical data: the mean-best tie breaks by chain order.
        const result = rankClassRoutes("class-h", [first, second], settings(), view(evidence), () => 0.999, NOW());
        expect(result.decision.winner).toBe(first.entry);
        expect(result.order).toEqual([first.entry, second.entry]);
        if (evidence.length > 0) {
          // Identical evidence must give identical estimates: a harness name may not move a score.
          const [x, y] = result.decision.estimates;
          expect({ p: x.passRate, cost: x.expectedCostUsd, s: x.expectedSeconds, score: x.score }).toEqual({ p: y.passRate, cost: y.expectedCostUsd, s: y.expectedSeconds, score: y.score });
          expect(result.decision.mode).toBe("exploit");
        }
      }
    }
  });
  it("ships no harness name, prior or weight in the ranking defaults", () => {
    const defaults = settingsOf({});
    expect(defaults.priors).toEqual({});
    const shipped = JSON.stringify({ RANK_DEFAULTS, defaults });
    for (const harness of [...HARNESS_IDS, "steak-pi", "stock-pi"]) expect(shipped).not.toContain(harness);
  });
  it("names no harness in the ranking source: harness is data from the candidates, never a literal", () => {
    for (const file of ["src/subagents/route-ranking.ts"]) {
      const source = readFileSync(join(import.meta.dirname, "..", file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      for (const harness of [...HARNESS_IDS, "steak-pi", "stock-pi"]) expect(source, `${file} names ${harness}`).not.toMatch(new RegExp(`["'\`]${harness}["'\`]`));
    }
  });
});

describe("the class settings are operator configuration", () => {
  const base = { chain: ["alpha-p/alpha-model", "steak-dsh/alpha-p/alpha-model"], requiresTestGate: false };
  it("accepts qualityGate and selfReportWeight in range", () => {
    const parsed = parseRoutingConfig({ taskClasses: { "class-h": { ...base, qualityGate: 0.9, selfReportWeight: 0.25 } } });
    expect(parsed.taskClasses?.["class-h"]).toMatchObject({ qualityGate: 0.9, selfReportWeight: 0.25 });
    expect(settingsOf(parsed.taskClasses!["class-h"])).toMatchObject({ qualityGate: 0.9, selfReportWeight: 0.25 });
  });
  it("refuses them out of range with a named key", () => {
    expect(() => parseRoutingConfig({ taskClasses: { "class-h": { ...base, qualityGate: 1 } } })).toThrow(RoutingConfigError);
    expect(() => parseRoutingConfig({ taskClasses: { "class-h": { ...base, selfReportWeight: 2 } } })).toThrow(/selfReportWeight/);
  });
});

// Through the real dispatch boundary: project policy filters candidates before ranking, and the receipt names the harness.
const A = "alpha-p/alpha-model";
const B = "beta-p/beta-model";
const DSH_A = `steak-dsh/${A}`;
const CLAUDE = "anthropic/claude-synthetic";
const model = (provider: string, id: string): Model => ({
  provider, id, name: id, api: "openai-completions", baseUrl: `https://${provider}.example/v1`,
  input: ["text"], contextWindow: 100_000, maxTokens: 8_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model);
const alpha = model("alpha-p", "alpha-model");
const beta = model("beta-p", "beta-model");
const claude = model("anthropic", "claude-synthetic");
const registryOf = (models: readonly Model[]) => ({
  find: (provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
  getAll: () => [...models], getAvailable: () => [...models],
  hasConfiguredAuth: () => true, isUsingOAuth: () => false, getProvider: () => ({ streamSimple() {} }),
});
const CONFIG = {
  textWorkerChain: [B],
  subscriptionRouteChecks: ["alpha-p", "beta-p", "anthropic"].map((provider) => ({ provider, host: `${provider}.example` })),
  taskClasses: {
    "class-h": { chain: [A, DSH_A], requiresTestGate: false, explore: 0,
      priors: { [A]: { pass: 5, n: 10 }, [DSH_A]: { pass: 10, n: 10 } } },
    "class-nc": { chain: [CLAUDE, B], requiresTestGate: false, explore: 0,
      priors: { [CLAUDE]: { pass: 50, n: 50 }, [B]: { pass: 25, n: 50 } } },
  },
};
function configure(): void {
  const file = join(dir, `routing-${++files}.json`);
  writeFileSync(file, JSON.stringify(CONFIG));
  vi.stubEnv("STEAK_PI_ROUTING_CONFIG", file);
  const bin = join(dir, `fake-bin-${++files}`);
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  vi.stubEnv("STEAK_DSH_BIN", bin);
}
function build(policy?: Record<string, unknown>) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = { appendEntry() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); }, sendMessage() {} } as unknown as ExtensionAPI;
  const calls: string[] = [];
  const runner = async (context: WorkerRunContext) => {
    calls.push(context.run.model);
    context.onProgress({ outputStarted: true });
    return { state: "done" as const, output: "Evidence: ok", turns: 1, usage: emptyUsage() };
  };
  const cwd = mkdtempSync(join(tmpdir(), "steak-pi-harness-routing-ext-"));
  const policyPath = join(dir, `policy-${++files}.json`);
  if (policy) writeFileSync(policyPath, JSON.stringify(Object.fromEntries(Object.entries(policy).map(([key, value]) => [key, value === "$project" ? [basename(cwd).toLowerCase()] : value]))));
  let id = 0;
  createUltratermSubagentsExtension({
    createRunner: () => runner, idFactory: () => `fixed-${files}-${++id}`, startupWindowMs: 2_000,
    routeEvidence: new RouteEvidenceStore(join(dir, `evidence-${++files}.jsonl`)), rng: seeded(4), projectPolicyPath: policyPath,
  })(pi);
  const ctx = {
    cwd, model: beta, modelRegistry: registryOf([alpha, beta, claude]), thinkingLevel: "medium",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => cwd, getEntries: () => [] }, ui: { setStatus() {} },
  } as any;
  const dispatch = (params: Record<string, unknown>) => tools.get("ultraterm_subagents").execute("t", { goal: "harness routing", ...params }, undefined, undefined, ctx);
  const close = async () => { await handlers.get("session_shutdown")?.({}, ctx); rmSync(cwd, { recursive: true, force: true }); };
  return { dispatch, calls, close };
}
const leaf = (taskClass: string) => ({ label: "leaf", task: "Do the leaf", taskClass });

describe("dispatch: the chosen harness runs the leaf and the receipt names it and why", () => {
  it("names the harness the class picked, with the evidence behind the pick", async () => {
    configure();
    const t = build();
    try {
      const result = await t.dispatch({ tasks: [leaf("class-h")] });
      expect(result.details.run.harness).toBe("steak-dsh");
      expect(result.content[0].text).toMatch(/Harness: steak-dsh, chosen by task class class-h/);
      expect(result.content[0].text).toMatch(/winner steak-dsh\/alpha-p\/alpha-model on harness steak-dsh/);
    } finally { await t.close(); }
  });
  it("names the Pi harness too when Pi is the pick", async () => {
    configure();
    const t = build({ noClaudeProjects: [] });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-nc")] });
      expect(result.details.run.model).toBe(CLAUDE);
      expect(result.content[0].text).toMatch(/Harness: pi, chosen by task class class-nc/);
    } finally { await t.close(); }
  });
  it("filters a Claude candidate out for a noClaude project before ranking: unavailable, not a loss", async () => {
    configure();
    const t = build({ noClaudeProjects: "$project" });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-nc")] });
      expect(result.details.run.model).toBe(B);
      expect(t.calls).toEqual([B]);
      expect(result.details.run.selection.taskClass.decision.estimates.map((item: { entry: string }) => item.entry)).toEqual([B]);
    } finally { await t.close(); }
  });
});

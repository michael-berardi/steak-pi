// Evidence-driven task-class routing through the real dispatch boundary: selection, receipts, the evidence a settled
// task leaves, self-healing (retry, failover, demotion, re-probe) and the read-only hub view. A fake worker runner and a
// seeded random source stand in for providers; every name is synthetic.
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createUltratermSubagentsExtension } from "../extensions/ultraterm-subagents.ts";
import { configuredTaskClass, resolveTaskClassWalk } from "../src/subagents/task-class.ts";
import { loadWorkerProfiles, resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import { classifyPiWorkerState, createChainFallbackReporter, createPiWorkerRunner, workerChainFallback, type PiWorkerSession } from "../src/subagents/pi-worker.ts";
import { RouteEvidenceStore, type TaskEvidence } from "../src/subagents/route-evidence.ts";
import type { Rng } from "../src/subagents/route-ranking.ts";
import { RelayBroker } from "../src/subagents/relay.ts";
import { USAP_VERSION, emptyUsage, type DispatchInput, type RunRecord, type TaskRecord, type WorkerRunner, type WorkerRunContext } from "../src/subagents/types.ts";

const dir = mkdtempSync(join(tmpdir(), "steak-pi-class-routing-"));
let files = 0;
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const A = "alpha-p/alpha-model";
const B = "beta-p/beta-model";
const FALLBACK = "fallback-p/fb-model";
const MIN = 60_000;
const PRIORS = { [A]: { pass: 9, n: 10, costUsd: 0.01, seconds: 10 }, [B]: { pass: 6, n: 10, costUsd: 0.01, seconds: 10 } };
// Far enough apart that a posterior draw never prefers the second route: the dispatch tests can name the winner.
const SURE_PRIORS = { [A]: { pass: 98, n: 100, costUsd: 0.01, seconds: 10 }, [B]: { pass: 50, n: 100, costUsd: 0.01, seconds: 10 } };
const CONFIG = {
  textWorkerChain: [FALLBACK],
  subscriptionRouteChecks: ["alpha-p", "beta-p", "fallback-p"].map((provider) => ({ provider, host: `${provider}.example` })),
  taskClasses: {
    "class-a": { chain: [A, B], explore: 0, demoteAfter: 50, window: 50, priors: PRIORS },
    "class-heal": { chain: [A, B], explore: 0, demoteAfter: 3, cooldownMinutes: 30, retryMaxTokens: 24_000, priors: SURE_PRIORS },
    "class-b": { chain: [B, A], explore: 0 },
    "class-fuzzy": { chain: [A, B], explore: 0.2, demoteAfter: 100, window: 500, priors: PRIORS },
  },
};
function configure(config: Record<string, unknown> = CONFIG): void {
  const file = join(dir, `routing-${++files}.json`);
  writeFileSync(file, JSON.stringify(config));
  vi.stubEnv("STEAK_PI_ROUTING_CONFIG", file);
}
const newStore = () => new RouteEvidenceStore(join(dir, `evidence-${++files}.jsonl`));

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
/** Records for one route with the passes spread evenly between the fails, so no streak demotes it by accident. */
function seed(store: RouteEvidenceStore, taskClass: string, route: string, passes: number, fails: number, over: Partial<TaskEvidence> = {}): void {
  const total = passes + fails;
  for (let index = 0; index < total; index += 1) {
    const pass = Math.floor(((index + 1) * passes) / total) > Math.floor((index * passes) / total);
    store.recordTask({ runId: `seed-${files}-${index}`, taskId: `seed-task-${index}`, label: "seed", taskClass, route, outcome: pass ? "pass" : "fail", source: "worker-state",
      wallSeconds: 10, costUsd: 0.01, tokens: 100, ...(pass ? {} : { failureKind: "other" as const }), ...over });
  }
}

type Model = Parameters<typeof resolveWorkerSelection>[0];
const model = (provider: string, id: string, input: string[] = ["text"]) => ({ provider, id, name: id, api: "openai-completions", baseUrl: `https://${provider}.example/v1`, input, maxTokens: 8_000 }) as unknown as Model;
const alpha = model("alpha-p", "alpha-model");
const beta = model("beta-p", "beta-model");
const fallbackModel = model("fallback-p", "fb-model");
function registryOf(models: readonly Model[]) {
  return {
    find: (provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
    getAll: () => [...models], getAvailable: () => [...models],
    hasConfiguredAuth: () => true, isUsingOAuth: () => false, getProvider: () => ({ streamSimple() {} }),
  };
}

describe("selection ranks the launchable class routes on the store", () => {
  const select = (name: string, store: RouteEvidenceStore, rng: Rng, models: readonly Model[] = [alpha, beta, fallbackModel]) => {
    const profiles = loadWorkerProfiles(join(dir, "no-harnesses"));
    const walk = resolveTaskClassWalk(name, configuredTaskClass(name)!, profiles, { store, rng });
    const input = { goal: "g", tasks: [{ label: "leaf", task: "t", taskClass: name }] } as unknown as DispatchInput;
    return resolveWorkerSelection(fallbackModel, "high", input, registryOf(models) as never, profiles, "", { taskClass: walk }, {});
  };
  const routeOf = (result: ReturnType<typeof select>) => `${result.model.provider}/${result.model.id}`;

  it("flips the served route when the evidence flips, whatever the chain order says", () => {
    configure();
    const aBetter = newStore();
    seed(aBetter, "class-a", A, 28, 2);
    seed(aBetter, "class-a", B, 5, 25);
    const bBetter = newStore();
    seed(bBetter, "class-a", A, 5, 25);
    seed(bBetter, "class-a", B, 28, 2);
    for (let draw = 1; draw <= 12; draw += 1) {
      expect(routeOf(select("class-a", aBetter, seeded(draw)))).toBe(A);
      const flipped = select("class-a", bBetter, seeded(draw));
      expect(routeOf(flipped)).toBe(B);
      // The failover order behind the winner is the ranked one, and the next route is resolved for a per-task failover.
      expect(flipped.selection.chainRoutes).toEqual([B, A]);
      expect(flipped.alternates?.map((item) => `${item.model.provider}/${item.model.id}`)).toEqual([A]);
    }
  });
  it("uses the operator's priors before any evidence, and the configured order with none", () => {
    configure();
    expect(routeOf(select("class-a", newStore(), seeded(1)))).toBe(A); // priors favour the first
    const noPriors = select("class-b", newStore(), seeded(1));
    expect(routeOf(noPriors)).toBe(B);
    expect(noPriors.selection.taskClass?.decision).toMatchObject({ mode: "chain-order", winner: B, explored: false });
  });
  it("explores the weaker route at about the configured share through the real selection", () => {
    configure();
    const store = newStore();
    seed(store, "class-fuzzy", A, 60, 0);
    seed(store, "class-fuzzy", B, 6, 54);
    const rng = seeded(31_337);
    const picks = Array.from({ length: 600 }, () => select("class-fuzzy", store, rng));
    const weaker = picks.filter((pick) => routeOf(pick) === B);
    expect(weaker.length / picks.length).toBeGreaterThan(0.15);
    expect(weaker.length / picks.length).toBeLessThan(0.25);
    expect(weaker.every((pick) => pick.selection.taskClass?.decision?.explored === true && pick.selection.taskClass?.decision?.mode === "explore")).toBe(true);
    // The explored run still fails over to the expected best.
    expect(weaker[0].selection.chainRoutes).toEqual([B, A]);
  });
  it("applies the existing launch checks first: only a launchable route can win", () => {
    configure();
    const store = newStore();
    seed(store, "class-a", A, 30, 0);
    seed(store, "class-a", B, 1, 29);
    const noAlpha = select("class-a", store, seeded(2), [beta, fallbackModel]);
    expect(routeOf(noAlpha)).toBe(B);
    expect(noAlpha.selection.taskClass).toMatchObject({ outcome: "served", step: B });
  });
  it("serves the normal route, naming why, when every launchable route is held out", () => {
    configure();
    const store = newStore();
    seed(store, "class-heal", A, 0, 3);
    seed(store, "class-heal", B, 0, 3);
    const result = select("class-heal", store, seeded(1));
    expect(routeOf(result)).toBe(FALLBACK);
    expect(result.selection.taskClass).toMatchObject({ outcome: "fallback" });
    expect(result.selection.taskClass?.reason).toMatch(/every launchable step of the class chain is held out \(alpha-p\/alpha-model: 3 consecutive failures \(other\); held out until its cooldown ends/);
  });
});

// The dispatch boundary: the real coordinator and extension, a fake worker.
function build(options: { runner?: WorkerRunner; store: RouteEvidenceStore; rng?: Rng; models?: readonly Model[] }) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    appendEntry() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); }, sendMessage() {},
  } as unknown as ExtensionAPI;
  const calls: Array<{ route: string; reply: WorkerRunContext["reply"] }> = [];
  const runner = vi.fn(async (context: WorkerRunContext) => {
    calls.push({ route: context.run.model, reply: context.reply });
    // A worker that got as far as a model reply has announced its first output, so a failure afterwards settles the
    // task instead of failing the dispatch call itself.
    context.onProgress({ outputStarted: true });
    return options.runner ? options.runner(context) : { state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() };
  });
  let id = 0;
  createUltratermSubagentsExtension({
    createRunner: () => runner, idFactory: () => `fixed-${files}-${++id}`, startupWindowMs: 2_000, routeEvidence: options.store, rng: options.rng ?? seeded(1),
  })(pi);
  const cwd = mkdtempSync(join(tmpdir(), "steak-pi-class-routing-ext-"));
  const ctx = {
    cwd, model: fallbackModel, modelRegistry: registryOf(options.models ?? [alpha, beta, fallbackModel]), thinkingLevel: "high",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => cwd, getEntries: () => [] },
    ui: { setStatus() {} },
  } as any;
  const dispatch = (params: Record<string, unknown>) => tools.get("ultraterm_subagents").execute("t", { goal: "Class routing", ...params }, undefined, undefined, ctx);
  const hub = (params: Record<string, unknown>) => tools.get("ultraterm_hub").execute("hub", params, undefined, undefined, ctx);
  const close = async () => { await handlers.get("session_shutdown")?.({}, ctx); rmSync(cwd, { recursive: true, force: true }); };
  return { dispatch, hub, runner, calls, close };
}
const leaf = (taskClass: string | undefined, label = "leaf") => ({ label, task: "Do the leaf", ...(taskClass ? { taskClass } : {}) });
const usageWith = (cost: number, tokens: number) => { const usage = emptyUsage(); usage.cost.total = cost; usage.totalTokens = tokens; return usage; };

describe("the receipt and the dispatch note carry the decision", () => {
  it("names the winner, every route's estimates, the evidence counts and whether it explored", async () => {
    configure();
    const store = newStore();
    seed(store, "class-a", A, 5, 25, { costUsd: 0.01, wallSeconds: 10 });
    seed(store, "class-a", B, 38, 2, { costUsd: 0.01, wallSeconds: 10 });
    const t = build({ store, rng: seeded(4) });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      expect(result.details.run.model).toBe(B);
      const decision = result.details.run.selection.taskClass.decision;
      expect(decision).toMatchObject({ winner: B, explored: false, timeWeight: 0, minPassRate: 0, explore: 0 });
      expect(decision.mode).toMatch(/exploit|thompson/);
      expect(decision.order.map((item: { entry: string }) => item.entry)).toEqual([B, A]);
      const a = decision.estimates.find((item: { entry: string }) => item.entry === A);
      const b = decision.estimates.find((item: { entry: string }) => item.entry === B);
      expect(a).toMatchObject({ status: "ranked", n: 30, priorN: 10, expectedCostUsd: 0.01, expectedSeconds: 10 });
      expect(b).toMatchObject({ status: "ranked", n: 40, priorN: 10 });
      expect(b.passRate).toBeGreaterThan(a.passRate);
      expect(typeof a.sampledPassRate).toBe("number");
      const text = result.content[0].text as string;
      expect(text).toContain("Route evidence: winner beta-p/beta-model");
      expect(text).toContain("alpha-p/alpha-model p(pass)");
      expect(text).toMatch(/n=30\+10 prior/);
      expect(text).toMatch(/explored no/);
      expect(result.details.summary.taskClass.decision.winner).toBe(B);
      expect(result.details.run.selection.taskClass.reason).toMatch(/launched as the (?:exploit|thompson) pick, ranked on evidence/);
    } finally { await t.close(); }
  });
  it("says it explored when the exploration share picked the weaker route", async () => {
    configure({ ...CONFIG, taskClasses: { "class-a": { ...CONFIG.taskClasses["class-a"], explore: 0.5 } } });
    const store = newStore();
    seed(store, "class-a", A, 40, 0);
    seed(store, "class-a", B, 4, 36);
    const t = build({ store, rng: seeded(99) });
    try {
      const modes: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const result = await t.dispatch({ tasks: [leaf("class-a")] });
        const decision = result.details.run.selection.taskClass.decision;
        modes.push(`${decision.winner === B ? "weaker" : "best"}:${decision.explored}`);
        if (decision.winner === B) expect(result.content[0].text).toMatch(/explore; explored yes/);
      }
      expect(modes).toContain("weaker:true");
      expect(modes).toContain("best:false");
    } finally { await t.close(); }
  });
  it("keeps a wave that declared no class out of the store", async () => {
    configure();
    const store = newStore();
    const t = build({ store });
    try {
      const result = await t.dispatch({ tasks: [leaf(undefined)] });
      expect(result.details.run.selection).not.toHaveProperty("taskClass");
      expect(store.view().tasks).toEqual([]);
    } finally { await t.close(); }
  });
});

describe("one evidence record when each task of a classed wave settles", () => {
  it("records route, outcome, source, dollars and tokens for each task that declared the class", async () => {
    configure();
    const store = newStore();
    const t = build({ store, runner: async () => ({ state: "done", output: "Evidence: fine", turns: 2, usage: usageWith(0.0123, 345) }) });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a", "first"), leaf("class-a", "second"), leaf(undefined, "rider")] });
      const records = store.view().tasks;
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.label).sort()).toEqual(["first", "second"]);
      for (const record of records) {
        expect(record).toMatchObject({ runId: result.details.run.runId, taskClass: "class-a", route: A, outcome: "pass", source: "worker-state", costUsd: 0.0123, tokens: 345 });
        expect(record.wallSeconds).toBeGreaterThanOrEqual(0);
      }
    } finally { await t.close(); }
  });
  it("records a failure with its kind", async () => {
    configure();
    const store = newStore();
    const t = build({ store, runner: async () => ({ state: "failed", output: "", error: "provider exploded", turns: 1, usage: usageWith(0.002, 50) }) });
    try {
      await t.dispatch({ tasks: [leaf("class-a")] });
      expect(store.view().tasks).toEqual([expect.objectContaining({ route: A, outcome: "fail", failureKind: "other", costUsd: 0.002 })]);
    } finally { await t.close(); }
  });
  it("takes a test gate result in the report as the stronger source", async () => {
    configure();
    const store = newStore();
    const t = build({ store, runner: async () => ({ state: "done", output: "Focused checks: 3 passed\nTEST-GATE: fail", turns: 1, usage: emptyUsage() }) });
    try {
      await t.dispatch({ tasks: [leaf("class-a")] });
      expect(store.view().tasks[0]).toMatchObject({ outcome: "fail", source: "test-gate" });
    } finally { await t.close(); }
  });
});

describe("self-healing at the dispatch boundary", () => {
  it("fails over at once on spent credits, records the cause, and ranks the route away from the next wave", async () => {
    configure();
    const store = newStore();
    const t = build({
      store, rng: seeded(3),
      runner: async (context) => context.run.model === A && context.reply?.alternate === undefined
        ? { state: "failed", output: "", error: "HTTP 402: Insufficient credits", turns: 1, usage: emptyUsage() }
        : { state: "done", output: "Evidence: served by the next route", turns: 1, usage: usageWith(0.01, 100) },
    });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(t.calls.map((call) => call.reply)).toEqual([undefined, { alternate: 0 }]);
      expect(result.details.run.tasks[0].state).toBe("done");
      const rows = store.view().tasks.map((row) => `${row.route}:${row.outcome}:${row.failureKind ?? "-"}${row.hop ? ":hop" : ""}`);
      expect(rows).toEqual([`${A}:fail:quota:hop`, `${B}:pass:-`]);
      // One spent-credit failure holds the route out; the next wave names why and starts on the other.
      const next = await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(next.details.run.model).toBe(B);
      expect(next.details.run.selection.taskClass.decision.estimates.find((item: { entry: string }) => item.entry === A)).toMatchObject({ status: "demoted", cause: expect.stringMatching(/spent credits or a usage limit \(quota\)/) });
      expect(next.content[0].text).toMatch(/alpha-p\/alpha-model p\(pass\)[^|]*\[demoted: route refused on spent credits/);
    } finally { await t.close(); }
  });
  it("fails over at once on a server error after output began", async () => {
    configure();
    const store = newStore();
    const t = build({
      store,
      runner: async (context) => context.reply?.alternate === undefined
        ? { state: "failed", output: "", error: "503 Service Unavailable", turns: 1, usage: emptyUsage() }
        : { state: "done", output: "Evidence: next route", turns: 1, usage: emptyUsage() },
    });
    try {
      await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(t.calls.map((call) => call.reply?.alternate)).toEqual([undefined, 0]);
      expect(store.view().tasks[0]).toMatchObject({ route: A, outcome: "fail", failureKind: "http-5xx", hop: true });
    } finally { await t.close(); }
  });
  it("retries an empty reply once on the same route with a higher output budget", async () => {
    configure();
    const store = newStore();
    const t = build({
      store,
      runner: async (context) => context.reply?.boost
        ? { state: "done", output: "Evidence: recovered", turns: 2, usage: usageWith(0.02, 400) }
        : { state: "done", output: "", turns: 1, usage: usageWith(0.01, 300) },
    });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(t.calls.map((call) => call.reply)).toEqual([undefined, { boost: true, maxTokens: 24_000 }]);
      expect(t.calls.map((call) => call.route)).toEqual([A, A]);
      expect(result.details.run.tasks[0].state).toBe("done");
      expect(store.view().tasks).toEqual([expect.objectContaining({ route: A, outcome: "pass", retried: true })]);
    } finally { await t.close(); }
  });
  it("leaves the output budget to the runner when the class names none", async () => {
    configure({ ...CONFIG, taskClasses: { "class-heal": { ...CONFIG.taskClasses["class-heal"], retryMaxTokens: undefined } } });
    const t = build({ store: newStore(), runner: async (context) => context.reply?.boost ? { state: "done", output: "Evidence: ok", turns: 1, usage: emptyUsage() } : { state: "done", output: "", turns: 1, usage: emptyUsage() } });
    try {
      await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(t.calls[1].reply).toEqual({ boost: true });
    } finally { await t.close(); }
  });
  it("reads a reply that ran out of output tokens the same way: one retry, then the next ranked route", async () => {
    configure();
    const store = newStore();
    const exhausted = { state: "failed" as const, output: "", error: "Child ran out of output tokens before a final answer (stopReason length)", turns: 1, usage: usageWith(0.01, 900) };
    const t = build({
      store,
      runner: async (context) => context.reply?.alternate === 0 ? { state: "done", output: "Evidence: next route", turns: 1, usage: usageWith(0.005, 100) } : exhausted,
    });
    try {
      await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(t.calls.map((call) => call.reply)).toEqual([undefined, { boost: true, maxTokens: 24_000 }, { alternate: 0 }]);
      expect(t.calls.map((call) => call.route)).toEqual([A, A, A]); // run.model is frozen; the runner resolves the alternate
      const rows = store.view().tasks;
      expect(rows.map((row) => `${row.route}:${row.outcome}:${row.failureKind ?? "-"}${row.hop ? ":hop" : ""}`)).toEqual([`${A}:fail:reasoning-exhausted:hop`, `${B}:pass:-`]);
      expect(rows[0].costUsd).toBeGreaterThan(0); // what the route cost before it was left is its own evidence
    } finally { await t.close(); }
  });
  it("gives up after the retry and every ranked route, and records the failure on the last one", async () => {
    configure();
    const store = newStore();
    const t = build({ store, runner: async () => ({ state: "done", output: "", turns: 1, usage: emptyUsage() }) });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(t.calls).toHaveLength(3);
      expect(result.details.run.tasks[0].state).toBe("failed");
      expect(store.view().tasks.map((row) => `${row.route}:${row.outcome}:${row.failureKind}`)).toEqual([`${A}:fail:empty-output`, `${B}:fail:empty-output`]);
    } finally { await t.close(); }
  });
  it("does none of this for a task that declared no class", async () => {
    configure();
    const t = build({ store: newStore(), runner: async () => ({ state: "done", output: "", turns: 1, usage: emptyUsage() }) });
    try {
      await t.dispatch({ tasks: [leaf(undefined)] });
      expect(t.calls).toHaveLength(1);
    } finally { await t.close(); }
  });

  it("demotes a route after K consecutive failures and names the cause in the next dispatch", async () => {
    configure();
    const store = newStore();
    let failing = true;
    const t = build({ store, rng: seeded(8), runner: async () => failing ? { state: "failed", output: "", error: "provider exploded", turns: 1, usage: emptyUsage() } : { state: "done", output: "Evidence: ok", turns: 1, usage: emptyUsage() } });
    try {
      for (let index = 0; index < 3; index += 1) expect((await t.dispatch({ tasks: [leaf("class-heal")] })).details.run.model).toBe(A);
      failing = false;
      const after = await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(after.details.run.model).toBe(B);
      expect(after.details.run.selection.taskClass.decision.estimates.find((item: { entry: string }) => item.entry === A)).toMatchObject({ status: "demoted", cause: "3 consecutive failures (other)" });
      expect(after.details.run.selection.taskClass.reason).toContain("not used: alpha-p/alpha-model: 3 consecutive failures (other)");
    } finally { await t.close(); }
  });
  it("re-probes a demoted route once after its cooldown, then promotes it on a pass", async () => {
    configure();
    const store = newStore();
    seed(store, "class-heal", A, 0, 3, { at: Date.now() - 31 * MIN });
    seed(store, "class-heal", B, 8, 2, { at: Date.now() - 40 * MIN });
    const t = build({ store, rng: seeded(5) });
    try {
      const probe = await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(probe.details.run.model).toBe(A);
      expect(probe.details.run.selection.taskClass.decision).toMatchObject({ mode: "probe", winner: A, explored: true });
      expect(probe.details.run.selection.chainRoutes).toEqual([A, B]);
      expect(probe.content[0].text).toMatch(/probe; explored yes/);
      expect(store.view().probes).toEqual([expect.objectContaining({ taskClass: "class-heal", route: A })]);
      // The probe passed: the route is promoted and ranked normally again.
      const next = await t.dispatch({ tasks: [leaf("class-heal")] });
      const estimate = next.details.run.selection.taskClass.decision.estimates.find((item: { entry: string }) => item.entry === A);
      expect(estimate.status).toBe("ranked");
      expect(next.details.run.selection.taskClass.decision.mode).not.toBe("probe");
    } finally { await t.close(); }
  });
  it("does not probe a second time while the first probe is in its cooldown, and holds a failed probe out again", async () => {
    configure();
    const store = newStore();
    seed(store, "class-heal", A, 0, 3, { at: Date.now() - 31 * MIN });
    seed(store, "class-heal", B, 8, 2, { at: Date.now() - 40 * MIN });
    let probing = true;
    const t = build({ store, rng: seeded(6), runner: async (context) => context.run.model === A && probing ? { state: "failed", output: "", error: "still broken", turns: 1, usage: emptyUsage() } : { state: "done", output: "Evidence: ok", turns: 1, usage: emptyUsage() } });
    try {
      const first = await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(first.details.run.selection.taskClass.decision.mode).toBe("probe");
      probing = false;
      const second = await t.dispatch({ tasks: [leaf("class-heal")] });
      expect(second.details.run.model).toBe(B);
      expect(second.details.run.selection.taskClass.decision.mode).not.toBe("probe");
      expect(second.details.run.selection.taskClass.decision.estimates.find((item: { entry: string }) => item.entry === A)).toMatchObject({ status: "demoted" });
      expect(store.view().probes).toHaveLength(1);
    } finally { await t.close(); }
  });
});

describe("hub: routes and record-outcome", () => {
  it("prints the per-class estimates from the store and writes nothing", async () => {
    configure();
    const store = newStore();
    seed(store, "class-a", A, 18, 2, { source: "verification" });
    seed(store, "class-heal", A, 0, 3, { failureKind: "quota" });
    const t = build({ store });
    try {
      const before = statSync(store.path);
      const result = await t.hub({ action: "routes" });
      const text = result.content[0].text as string;
      expect(text).toContain(`Route evidence: 23 task record(s) in ${store.path}`);
      expect(text).toMatch(/class class-a · timeWeight 0 · floor 0 · explore 0/);
      expect(text).toMatch(/alpha-p\/alpha-model: healthy · p\(pass\) 0\.\d+ · pass 18 fail 2 unknown 0 \(verified 20, prior n 10\)/);
      expect(text).toMatch(/class class-heal[\s\S]*alpha-p\/alpha-model: demoted \(route refused on spent credits or a usage limit \(quota\)\)[\s\S]*quota×3/);
      expect(text).toContain("class class-b"); // configured classes with no evidence still show their routes
      expect(result.details.reports.map((report: { taskClass: string }) => report.taskClass)).toEqual(["class-a", "class-b", "class-fuzzy", "class-heal"]);
      const after = statSync(store.path);
      expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
      const one = await t.hub({ action: "routes", taskClass: "class-heal" });
      expect(one.details.reports).toHaveLength(1);
      expect(one.content[0].text).not.toContain("class class-a ·");
    } finally { await t.close(); }
  });
  it("says so when there is nothing to show", async () => {
    configure({ textWorkerChain: [FALLBACK] });
    const t = build({ store: newStore() });
    try {
      const result = await t.hub({ action: "routes" });
      expect(result.content[0].text).toContain("No task class is configured and the store holds no classed record.");
    } finally { await t.close(); }
  });
  it("attaches a later verdict to the run's evidence, and the estimates move", async () => {
    configure();
    const store = newStore();
    const t = build({ store });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      const runId = result.details.run.runId as string;
      expect(store.view().tasks[0]).toMatchObject({ outcome: "pass", source: "worker-state" });
      const recorded = await t.hub({ action: "record-outcome", runId, taskId: result.details.run.tasks[0].taskId, outcome: "fail", source: "verification", body: "reviewer rejected it" });
      expect(recorded.details).toMatchObject({ recorded: true, runId, tasks: 1 });
      expect(recorded.content[0].text).toContain(`Recorded fail (verification) for 1 task record(s) of run ${runId}`);
      expect(store.view().tasks[0]).toMatchObject({ outcome: "fail", source: "verification" });
      const routes = await t.hub({ action: "routes", taskClass: "class-a" });
      expect(routes.content[0].text).toMatch(/pass 0 fail 1 unknown 0 \(verified 1,/);
    } finally { await t.close(); }
  });
  it("refuses to record against a run that left no classed evidence, and writes nothing", async () => {
    configure();
    const store = newStore();
    seed(store, "class-a", A, 1, 0);
    const t = build({ store });
    try {
      const before = statSync(store.path).size;
      const result = await t.hub({ action: "record-outcome", runId: "run-unknown", outcome: "pass" });
      expect(result.details).toMatchObject({ recorded: false });
      expect(result.content[0].text).toContain("nothing was recorded");
      expect(statSync(store.path).size).toBe(before);
      await expect(t.hub({ action: "record-outcome", runId: "run-unknown" })).rejects.toThrow(/outcome pass or fail/);
    } finally { await t.close(); }
  });
});

describe("the runtime follows the ranked chain and keeps the cause", () => {
  const selection = (routes: string[], extra: Record<string, unknown> = {}) => ({
    source: "chain" as const, images: false, chainRoutes: routes,
    taskClass: { name: "class-a", outcome: "served" as const, reason: "ok", step: routes[0] },
    ...extra,
  });
  it("hops along the class's ranked chain, best remaining first", () => {
    configure();
    const hop = workerChainFallback(selection([B, A]), beta as never);
    expect(hop?.chain.map((step) => `${step.provider}/${step.id}`)).toEqual([B, A]);
  });
  it("ignores a recorded chain that names a route the class does not", () => {
    configure();
    expect(workerChainFallback(selection([B, "evil-p/evil-model"]), beta as never)).toBeUndefined();
    configure({ ...CONFIG, taskClasses: {} });
    expect(workerChainFallback(selection([B, A]), beta as never)).toBeUndefined();
  });
  it("records why each route was left", () => {
    const task = { routeFallbacks: undefined, lastStep: undefined } as unknown as TaskRecord;
    const report = createChainFallbackReporter(task, () => {});
    report({ provider: "alpha-p", id: "alpha-model" }, beta as never, "HTTP 402: Insufficient credits");
    expect(task.routeFallbacks).toEqual([`${A}->${B}`]);
    expect(task.routeHopDetails).toEqual([{ from: A, to: B, cause: "HTTP 402: Insufficient credits", costUsd: 0, seconds: 0 }]);
  });
});

describe("the Pi worker: output budget, alternate route, exhausted reply", () => {
  class Session implements PiWorkerSession {
    isStreaming = false;
    private listeners = new Set<(event: any) => void>();
    subscribe(listener: (event: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async prompt() {
      const message = { role: "assistant", content: [{ type: "text", text: "Evidence: done" }], api: "t", provider: "t", model: "t", usage: emptyUsage(), stopReason: "stop", timestamp: 1 };
      for (const listener of this.listeners) listener({ type: "message_end", message });
    }
    async steer() {}
    async abort() {}
    dispose() {}
  }
  const task = (): TaskRecord => ({ id: "run-w-task-1", label: "leaf", task: "t", role: "worker", mayEdit: false, ownedPaths: [], allowBash: false, state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false });
  const run = (record: TaskRecord): RunRecord => ({ version: USAP_VERSION, id: "run-w", goal: "g", constraints: [], cwd: process.cwd(), model: "alpha-p/alpha-model", thinkingLevel: "low", concurrency: 1, timeoutMs: 10_000, maxTurns: 8, background: false, state: "running", createdAt: 1, tasks: [record], usage: emptyUsage() });
  async function launch(reply: WorkerRunContext["reply"]) {
    const captured: Array<{ model: { provider: string; id: string; maxTokens: number }; thinkingLevel: string }> = [];
    const relay = new RelayBroker();
    relay.createRun("run-w", ["run-w-task-1"]);
    const record = task();
    const runner = createPiWorkerRunner({
      relay,
      resolveRuntime: () => ({ model: alpha as never, thinkingLevel: "low", alternates: [{ entry: B, model: beta as never, thinkingLevel: "high" }] }),
      sessionFactory: async (options) => { captured.push(options as never); return { session: new Session() }; },
    });
    const result = await runner({ run: run(record), task: record, signal: new AbortController().signal, onProgress: () => {}, ...(reply ? { reply } : {}) });
    return { result, captured };
  }
  it("runs the frozen route at its own output budget by default", async () => {
    const { result, captured } = await launch(undefined);
    expect(result.state).toBe("done");
    expect(captured[0].model).toMatchObject({ provider: "alpha-p", id: "alpha-model", maxTokens: 8_000 });
  });
  it("raises the output budget on a boosted retry: the class's figure, or double the model's", async () => {
    expect((await launch({ boost: true, maxTokens: 24_000 })).captured[0].model.maxTokens).toBe(24_000);
    expect((await launch({ boost: true })).captured[0].model.maxTokens).toBe(16_000);
  });
  it("runs a requested alternate route at its own thinking level, and refuses one that was never frozen", async () => {
    const { captured } = await launch({ alternate: 0 });
    expect(captured[0]).toMatchObject({ model: { provider: "beta-p", id: "beta-model", maxTokens: 8_000 }, thinkingLevel: "high" });
    const missing = await launch({ alternate: 3 });
    expect(missing.result.state).toBe("failed");
    expect(missing.result.error).toMatch(/No alternate class route 3 was frozen/);
    expect(missing.captured).toEqual([]);
  });
  it("calls a reply cut off at the output limit exhausted reasoning, not an idle model", () => {
    const base = { signal: new AbortController().signal, turnLimitReached: false };
    const snapshot = (stopReason: string) => ({ text: "", toolCalls: false, stopReason }) as never;
    expect(classifyPiWorkerState({ ...base, finalAssistant: snapshot("length") })).toEqual({ state: "failed", error: "Child ran out of output tokens before a final answer (stopReason length)" });
    expect(classifyPiWorkerState({ ...base, finalAssistant: snapshot("stop") })).toEqual({ state: "failed", error: "Child produced no final output" });
  });
});

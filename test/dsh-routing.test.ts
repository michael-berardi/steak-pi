// steak-dsh as a third USAP harness through the real dispatch boundary: the schema enum derives from
// HARNESS_IDS, explicit routes are admitted and never fall back, a task class ranks a harness-qualified
// step beside a native one on the same evidence, the hub refuses steering/resume, and `routing check`
// validates the inner model. A fake worker runner / fake spawn stands in for the CLI; every name is
// synthetic. No network, no real model.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createUltratermSubagentsExtension, ultratermSubagentsSchema } from "../extensions/ultraterm-subagents.ts";
import { HARNESS_IDS, emptyUsage, type RunRecord, type WorkerRunContext } from "../src/subagents/types.ts";
import { RouteEvidenceStore } from "../src/subagents/route-evidence.ts";
import { resolveTaskClassWalk, configuredTaskClass } from "../src/subagents/task-class.ts";
import { selectChainedWorkerStep } from "../src/model-route-policy.ts";
import { loadWorkerProfiles } from "../src/subagents/model-selection.ts";
import type { DshSpawn, DshSpawnHandle } from "../src/subagents/dsh-worker.ts";
import type { Rng } from "../src/subagents/route-ranking.ts";

type Model = NonNullable<ExtensionContext["model"]>;
const dir = mkdtempSync(join(tmpdir(), "steak-pi-dsh-routing-"));
let files = 0;
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const A = "alpha-p/alpha-model";
const B = "beta-p/beta-model";
const DSH_A = `steak-dsh/${A}`;
const KEY = "sk-test-DO-NOT-LOG-routing-abcdef";

const model = (provider: string, id: string): Model => ({
  provider, id, name: id, api: "openai-completions", baseUrl: `https://${provider}.example/v1`,
  input: ["text"], contextWindow: 100_000, maxTokens: 8_000, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model);
const alpha = model("alpha-p", "alpha-model");
const beta = model("beta-p", "beta-model");

function registryOf(models: readonly Model[], withAuth = false) {
  return {
    find: (provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
    getAll: () => [...models], getAvailable: () => [...models],
    hasConfiguredAuth: () => true, isUsingOAuth: () => false, getProvider: () => ({ streamSimple() {} }),
    ...(withAuth ? { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: KEY }) } : {}),
  };
}

const CONFIG = {
  textWorkerChain: [B],
  subscriptionRouteChecks: [{ provider: "alpha-p", host: "alpha-p.example" }, { provider: "beta-p", host: "beta-p.example" }],
  taskClasses: {
    "class-a": { chain: [A, DSH_A], explore: 0, demoteAfter: 50, window: 50,
      priors: { [A]: { pass: 6, n: 10, costUsd: 0.01, seconds: 10 }, [DSH_A]: { pass: 9, n: 10, costUsd: 0.01, seconds: 10 } } },
    "class-quota": { chain: [DSH_A, B], explore: 0,
      priors: { [DSH_A]: { pass: 9, n: 10, costUsd: 0.01, seconds: 10 }, [B]: { pass: 6, n: 10, costUsd: 0.01, seconds: 10 } } },
  },
};
function configure(config: Record<string, unknown> = CONFIG): void {
  const file = join(dir, `routing-${++files}.json`);
  writeFileSync(file, JSON.stringify(config));
  vi.stubEnv("STEAK_PI_ROUTING_CONFIG", file);
}
/** A fake executable the harness launch check can resolve. */
function fakeBin(): string {
  const path = join(dir, `fake-bin-${++files}`);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  vi.stubEnv("STEAK_DSH_BIN", path);
  return path;
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
function seed(store: RouteEvidenceStore, taskClass: string, route: string, passes: number, fails: number): void {
  const total = passes + fails;
  for (let index = 0; index < total; index += 1) {
    const pass = Math.floor(((index + 1) * passes) / total) > Math.floor((index * passes) / total);
    store.recordTask({ runId: `seed-${files}-${index}`, taskId: `seed-task-${index}`, label: "seed", taskClass, route,
      outcome: pass ? "pass" : "fail", source: "worker-state", wallSeconds: 10, costUsd: 0.01, tokens: 100,
      ...(pass ? {} : { failureKind: "other" as const }) });
  }
}

function build(options: { runner?: (context: WorkerRunContext) => Promise<any>; store?: RouteEvidenceStore; rng?: Rng; models?: readonly Model[]; dshSpawn?: DshSpawn; withAuth?: boolean }) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    appendEntry() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); }, sendMessage() {},
  } as unknown as ExtensionAPI;
  const calls: Array<{ route: string; harness: string | undefined }> = [];
  const runner = async (context: WorkerRunContext) => {
    calls.push({ route: context.run.model, harness: context.run.harness });
    if (options.runner) return options.runner(context);
    context.onProgress({ outputStarted: true });
    return { state: "done" as const, output: "Evidence: ok", turns: 1, usage: emptyUsage() };
  };
  let id = 0;
  createUltratermSubagentsExtension({
    ...(options.dshSpawn ? { dshSpawn: options.dshSpawn } : { createRunner: () => runner }),
    idFactory: () => `fixed-${files}-${++id}`, startupWindowMs: 2_000,
    ...(options.store ? { routeEvidence: options.store } : {}), rng: options.rng ?? seeded(1),
  })(pi);
  const cwd = mkdtempSync(join(tmpdir(), "steak-pi-dsh-routing-ext-"));
  const ctx = {
    cwd, model: beta, modelRegistry: registryOf(options.models ?? [alpha, beta], options.withAuth === true), thinkingLevel: "medium",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => cwd, getEntries: () => [] },
    ui: { setStatus() {} },
  } as any;
  const dispatch = (params: Record<string, unknown>) => tools.get("ultraterm_subagents").execute("t", { goal: "DSH routing", ...params }, undefined, undefined, ctx);
  const hub = (params: Record<string, unknown>) => tools.get("ultraterm_hub").execute("hub", params, undefined, undefined, ctx);
  const close = async () => { await handlers.get("session_shutdown")?.({}, ctx); rmSync(cwd, { recursive: true, force: true }); };
  return { dispatch, hub, calls, close };
}
const leaf = (taskClass?: string) => ({ label: "leaf", task: "Do the leaf", ...(taskClass ? { taskClass } : {}) });

describe("the dispatch schema enum derives from HARNESS_IDS", () => {
  it("exposes exactly the canonical harness ids, with no second hard-coded copy", () => {
    const harness = (ultratermSubagentsSchema as any).properties.harness;
    expect(harness.enum).toEqual([...HARNESS_IDS]);
    expect(HARNESS_IDS).toContain("steak-dsh");
  });
});

describe("explicit steak-dsh dispatch", () => {
  it("admits harness steak-dsh with an inner model and records the verbatim route", async () => {
    configure(); fakeBin();
    const t = build({});
    try {
      const result = await t.dispatch({ harness: "steak-dsh", model: A, tasks: [leaf()] });
      expect(result.details.run.harness).toBe("steak-dsh");
      expect(result.details.run.model).toBe(DSH_A);
      expect(result.details.summary.harness).toBe("steak-dsh");
      expect(result.details.run.selection).toMatchObject({ provider: "alpha-p", modelId: "alpha-model", harness: "steak-dsh", source: "override" });
      expect(result.content[0].text).toContain("Harness note: this wave runs on the steak-dsh harness");
      expect(t.calls).toEqual([{ route: DSH_A, harness: "steak-dsh" }]);
    } finally { await t.close(); }
  });
  it("admits an exact steak-dsh/<provider>/<model-id> model with no harness field", async () => {
    configure(); fakeBin();
    const t = build({});
    try {
      const result = await t.dispatch({ model: DSH_A, tasks: [leaf()] });
      expect(result.details.run.harness).toBe("steak-dsh");
      expect(result.details.run.model).toBe(DSH_A);
    } finally { await t.close(); }
  });
  it("refuses unknown inner models, missing models, profiles and images with named errors", async () => {
    configure(); fakeBin();
    const t = build({});
    try {
      await expect(t.dispatch({ harness: "steak-dsh", model: "alpha-p/missing", tasks: [leaf()] }))
        .rejects.toThrow(/inner route alpha-p\/missing.*does not know the inner model/s);
      await expect(t.dispatch({ harness: "steak-dsh", tasks: [leaf()] }))
        .rejects.toThrow(/requires model <provider>\/<model-id>/);
      await expect(t.dispatch({ harness: "steak-dsh", profile: "steak-pi/x", model: A, tasks: [leaf()] }))
        .rejects.toThrow(/profile selectors are refused/);
      await expect(t.dispatch({ model: DSH_A, requireImages: true, tasks: [leaf()] }))
        .rejects.toThrow(/does not support image input/);
      await expect(t.dispatch({ model: "steak-dsh/alpha-p", tasks: [leaf()] }))
        .rejects.toThrow(/steak-dsh\/<provider>\/<model-id>/);
    } finally { await t.close(); }
  });
  it("refuses an OAuth-only inner provider with a named error", async () => {
    configure(); fakeBin();
    const tools = new Map<string, any>();
    const pi = { appendEntry() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, on() {}, sendMessage() {} } as unknown as ExtensionAPI;
    createUltratermSubagentsExtension({ idFactory: () => `oauth-${++files}`, startupWindowMs: 0 })(pi);
    const cwd = mkdtempSync(join(tmpdir(), "steak-pi-dsh-oauth-"));
    const registry = { ...registryOf([alpha, beta]), isUsingOAuth: () => true };
    const ctx = { cwd, model: beta, modelRegistry: registry, thinkingLevel: "medium", sessionManager: { getSessionFile: () => undefined, getSessionId: () => cwd, getEntries: () => [] }, ui: { setStatus() {} } } as any;
    try {
      await expect(tools.get("ultraterm_subagents").execute("t", { goal: "g", model: DSH_A, tasks: [leaf()] }, undefined, undefined, ctx))
        .rejects.toThrow(/OAuth-only login/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  it("runs the frozen runtime through defaultWorkerRunner's third branch; the key stays in the environment", async () => {
    configure(); fakeBin();
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const dshSpawn: DshSpawn = ({ args, env }) => {
      seen.push({ args, env });
      const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
      const stdoutListeners: Array<(chunk: string) => void> = [];
      const handle: DshSpawnHandle = {
        pid: 4242,
        onExit(listener) { exitListeners.push(listener); }, onError() {},
        onStdout(listener) { stdoutListeners.push(listener); }, onStderr() {},
        writeStdin() {}, endStdin() {}, kill() { return true; },
      };
      queueMicrotask(() => {
        const frames = [
          { type: "session", sessionId: "s-1", cwd: "/tmp" },
          { type: "status", phase: "step_start", turn: 1, step: 1 },
          { type: "text", text: "working" },
          { type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
          { type: "final", sessionId: "s-1", reason: { kind: "completed" }, text: "Evidence: served by the fake CLI" },
        ];
        for (const frame of frames) for (const listener of stdoutListeners) listener(JSON.stringify(frame) + "\n");
        for (const listener of exitListeners) listener(0, null);
      });
      return handle;
    };
    const t = build({ dshSpawn, withAuth: true });
    try {
      const result = await t.dispatch({ model: DSH_A, tasks: [leaf()] });
      expect(result.details.run.harness).toBe("steak-dsh");
      expect(result.details.run.tasks[0].state).toBe("done");
      expect(result.details.run.tasks[0].output).toContain("served by the fake CLI");
      expect(seen).toHaveLength(1);
      expect(seen[0].args.join(" ")).not.toContain(KEY);
      expect(seen[0].args).toContain("--key-env");
      expect(seen[0].env.STEAK_DSH_ROUTE_KEY).toBe(KEY);
      // Usage was priced from the registry model's own cost table (1/M input, 2/M output).
      expect(result.details.run.totalTokens).toBe(15);
      expect(result.details.run.totalCost).toBeCloseTo((10 * 1 + 5 * 2) / 1_000_000, 10);
    } finally { await t.close(); }
  });
});

describe("a task class ranks a steak-dsh step beside a native one", () => {
  it("yields harness-qualified steps and ranks the two routes on the same evidence", () => {
    configure(); fakeBin();
    const profiles = loadWorkerProfiles(join(dir, "no-harnesses"));
    const walk = resolveTaskClassWalk("class-a", configuredTaskClass("class-a")!, profiles);
    expect(walk.steps.map((step) => step.entry)).toEqual([A, DSH_A]);
    expect(walk.steps[1].step).toMatchObject({ provider: "alpha-p", id: "alpha-model", harness: "steak-dsh" });
    // Both steps are launchable on the same registry: the native and the harness-qualified route are two routes.
    const registry = registryOf([alpha, beta]);
    const steps = walk.steps.map((step) => step.step);
    const first = selectChainedWorkerStep(registry as never, steps);
    expect(first.step.harness).toBeUndefined();
    expect(first.model.provider).toBe("alpha-p");
    const dshOnly = selectChainedWorkerStep(registry as never, steps, { skipRoute: (step) => step.harness !== "steak-dsh" });
    expect(dshOnly.step.harness).toBe("steak-dsh");
    expect(dshOnly.model.id).toBe("alpha-model");
    // Without the executable the harness step cannot launch; the native step still can.
    vi.stubEnv("STEAK_DSH_BIN", join(dir, "missing-executable"));
    const nativeOnly = selectChainedWorkerStep(registry as never, steps);
    expect(nativeOnly.step.harness).toBeUndefined();
  });
  it("sets run.harness from the ranked winner and records the route verbatim in evidence", async () => {
    configure(); fakeBin();
    const store = newStore();
    const t = build({ store, rng: seeded(2) });
    try {
      // Priors favour the harness-qualified route: it wins the first dispatch.
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      expect(result.details.run.harness).toBe("steak-dsh");
      expect(result.details.run.model).toBe(DSH_A);
      expect(result.details.run.selection.taskClass).toMatchObject({ outcome: "served", step: DSH_A });
      const decision = result.details.run.selection.taskClass.decision;
      expect(decision.estimates.map((item: { entry: string }) => item.entry).sort()).toEqual([A, DSH_A].sort());
      expect(decision.order.map((item: { entry: string }) => item.entry)).toContain(A);
      expect(result.content[0].text).toContain(DSH_A);
      // The settled task leaves evidence keyed by the verbatim harness-qualified entry.
      const rows = store.view().tasks;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ route: DSH_A, taskClass: "class-a", outcome: "pass" });
      // Flip the evidence: the native route wins the next wave, and the run is a Pi run again.
      seed(store, "class-a", DSH_A, 2, 28);
      seed(store, "class-a", A, 28, 2);
      const next = await t.dispatch({ tasks: [leaf("class-a")] });
      expect(next.details.run.model).toBe(A);
      expect(next.details.run.harness).toBeUndefined();
      // The hub routes view shows the harness-qualified entry beside the native one.
      const routes = await t.hub({ action: "routes", taskClass: "class-a" });
      expect(routes.content[0].text).toContain(DSH_A);
      expect(routes.content[0].text).toContain(A);
    } finally { await t.close(); }
  });
  it("falls through to the next tier when the steak-dsh worker dies on quota before output", async () => {
    configure({ ...CONFIG, providerQuotaFallback: [{ quota: "alpha-quota", provider: "alpha-p", metered: true }] });
    fakeBin();
    const store = newStore();
    const t = build({
      store, rng: seeded(3),
      runner: async (context) => context.run.harness === "steak-dsh"
        ? { state: "failed" as const, output: "", error: "steak-dsh provider quota limit reached: HTTP 429 insufficient_quota", turns: 1, usage: emptyUsage() }
        : (context.onProgress({ outputStarted: true }), { state: "done" as const, output: "Evidence: served by the next tier", turns: 1, usage: emptyUsage() }),
    });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-quota")] });
      expect(result.details.run.model).toBe(B);
      expect(result.details.run.harness).toBeUndefined();
      expect(result.details.run.tasks[0].state).toBe("done");
      expect(result.content[0].text).toMatch(/Fall-through|fall-through/);
      // The refused harness-qualified route left a quota failure row under its verbatim entry.
      const rows = store.view().tasks.filter((row) => row.route === DSH_A);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toMatchObject({ outcome: "fail", failureKind: "quota" });
    } finally { await t.close(); }
  });
});

describe("the hub refuses steering and resume on steak-dsh runs", () => {
  it("refuses send/redirect with a named error", async () => {
    configure(); fakeBin();
    const t = build({});
    try {
      const result = await t.dispatch({ model: DSH_A, tasks: [leaf()] });
      const runId = result.details.run.runId;
      const taskId = result.details.run.tasks[0].taskId;
      await expect(t.hub({ action: "send", runId, to: taskId, body: "steer" })).rejects.toThrow(/does not support relay steering/);
      await expect(t.hub({ action: "redirect", runId, to: taskId, body: "steer" })).rejects.toThrow(/does not support relay steering/);
    } finally { await t.close(); }
  });
  it("refuses resume with a named error", async () => {
    configure(); fakeBin();
    const t = build({
      runner: async (context) => {
        context.onProgress({ outputStarted: true });
        return { state: "failed" as const, output: "partial", error: "the CLI stopped", turns: 1, usage: emptyUsage() };
      },
    });
    try {
      const result = await t.dispatch({ model: DSH_A, tasks: [leaf()] });
      expect(result.details.run.tasks[0].state).toBe("failed");
      await expect(t.hub({ action: "resume", runId: result.details.run.runId }))
        .rejects.toThrow(/harness steak-dsh keeps no resumable worker session/);
    } finally { await t.close(); }
  });
});

describe("steak-pi routing check validates steak-dsh entries", () => {
  const check = fileURLToPath(new URL("../src/routing-check.ts", import.meta.url));
  // A private Pi agent dir whose models.json defines the synthetic provider, so the check resolves
  // the inner model against the same registry Pi uses (offline, no network).
  const agentDir = join(dir, "agent-dir");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { "alpha-p": { baseUrl: "https://alpha-p.example/v1", api: "openai-completions", models: [{ id: "alpha-model", input: ["text"], contextWindow: 100_000, maxTokens: 8_000 }] } },
  }));
  const run = (file: string) => {
    try { return { code: 0, out: execFileSync(process.execPath, ["--no-warnings", check, file], { encoding: "utf8", stdio: "pipe", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }) }; }
    catch (error) { const e = error as { status: number; stderr: string }; return { code: e.status, out: e.stderr }; }
  };
  const write = (value: unknown) => { const path = join(dir, `check-${++files}.json`); writeFileSync(path, JSON.stringify(value)); return path; };
  it("accepts a class chain and a textWorkerChain entry whose inner model the registry knows", () => {
    const file = write({ textWorkerChain: [DSH_A], taskClasses: { "class-a": { chain: [DSH_A], requiresTestGate: false } } });
    const result = run(file);
    expect(result.out, result.out).toContain("ok");
    expect(result.code).toBe(0);
  }, 60_000);
  it("refuses an unknown inner model with a named error", () => {
    const file = write({ taskClasses: { "class-a": { chain: ["steak-dsh/alpha-p/missing-model"], requiresTestGate: false } } });
    const result = run(file);
    expect(result.code).toBe(1);
    expect(result.out).toContain("inner model alpha-p/missing-model is not in the Pi model registry");
  }, 60_000);
  it("refuses a malformed harness-qualified entry at parse time", () => {
    const file = write({ taskClasses: { "class-a": { chain: ["steak-dsh/alpha-p"], requiresTestGate: false } } });
    const result = run(file);
    expect(result.code).toBe(1);
    expect(result.out).toContain("taskClasses.class-a.chain[0]");
  });
});

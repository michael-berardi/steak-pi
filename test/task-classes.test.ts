// Task classes: routing.json `taskClasses` + the per-task `taskClass`, and the profile `ensure` hook as the
// dispatch sees it. Every name here is synthetic; Steak Pi ships no class, chain or profile of its own.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CheckpointStore } from "../src/subagents/checkpoints.ts";
import { createUltratermSubagentsExtension, ultratermSubagentsSchema, type UltratermSubagentsDependencies } from "../extensions/ultraterm-subagents.ts";
import { parseRoutingConfig, routingConfigOrEmpty, RoutingConfigError } from "../src/routing-config.ts";
import { loadWorkerProfiles, resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import { normalizeDispatch, SubagentPolicyError } from "../src/subagents/policy.ts";
import { buildPiWorkerSystemPrompt } from "../src/subagents/pi-worker.ts";
import { analyzeWaveClasses, configuredTaskClass, resolveTaskClassWalk, TaskClassConflictError } from "../src/subagents/task-class.ts";
import type { EnsureExec, EnsureExecResult } from "../src/subagents/profile-ensure.ts";
import { emptyUsage, type DispatchInput, type WorkerRunner } from "../src/subagents/types.ts";

const dir = mkdtempSync(join(tmpdir(), "steak-pi-task-classes-"));
let files = 0;
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const ENSURE = { command: ["/opt/hook/up", "--start"], release: ["/opt/hook/down"], timeoutMs: 5_000 };
const LOCAL_PROFILE = "hub/local";
const LOCAL = "local-p/fast-model";
const CLOUD = "cloud-p/cloud-model";
const FALLBACK = "fallback-p/fb-model";
const CONFIG = {
  textWorkerChain: [FALLBACK],
  subscriptionRouteChecks: [{ provider: "cloud-p", host: "cloud-p.example" }, { provider: "fallback-p", host: "fallback-p.example" }],
  workerProfiles: [{ id: LOCAL_PROFILE, model: LOCAL, thinking: "low", ensure: ENSURE }],
  taskClasses: {
    "class-a": { chain: [LOCAL_PROFILE, CLOUD], requiresTestGate: true, note: "measured against a test gate" },
    "class-b": { chain: [CLOUD] },
  },
};
function configure(config: Record<string, unknown>): void {
  const file = join(dir, `routing-${++files}.json`);
  writeFileSync(file, JSON.stringify(config));
  vi.stubEnv("STEAK_PI_ROUTING_CONFIG", file);
  // Each configuration starts with an empty route evidence store, so no test inherits another's outcomes.
  vi.stubEnv("STEAK_PI_ROUTE_EVIDENCE", join(dir, `evidence-${files}.jsonl`));
}

describe("routing.json taskClasses and ensure: validation", () => {
  const parse = (extra: Record<string, unknown>) => parseRoutingConfig({ ...extra });

  it("reads a class table and a profile hook", () => {
    const config = parse({
      workerProfiles: [{ id: "hub/local", model: "local-p/fast-model", ensure: { command: ["/opt/up", "--x"], release: ["down"], timeoutMs: 30_000 } }],
      taskClasses: { "class-a": { chain: ["hub/local", "cloud-p/cloud-model"], requiresTestGate: true, note: "why" }, b2: { chain: ["cloud-p/cloud-model"] } },
    });
    expect(config.taskClasses).toEqual({
      "class-a": { chain: ["hub/local", "cloud-p/cloud-model"], requiresTestGate: true, note: "why" },
      b2: { chain: ["cloud-p/cloud-model"], requiresTestGate: false },
    });
    expect(config.workerProfiles?.[0].ensure).toEqual({ command: ["/opt/up", "--x"], release: ["down"], timeoutMs: 30_000 });
  });

  it("has no class and no hook by default", () => {
    expect(parse({}).taskClasses).toBeUndefined();
    expect(parse({ workerProfiles: [{ id: "hub/local", model: "local-p/fast-model" }] }).workerProfiles?.[0]).not.toHaveProperty("ensure");
  });

  it("keeps routeConditions so a class step carries the same onlyWhen as a default chain step", () => {
    const condition = { provider: "claude", everyAccount: { remainingBelow: 20, behindPaceAbove: 15 } };
    expect(parse({ routeConditions: { "cloud-p/cloud-model": condition } }).routeConditions).toEqual({ "cloud-p/cloud-model": condition });
  });

  it.each([
    ["a non-object table", { taskClasses: [] }, /taskClasses: expected/],
    ["an uppercase class name", { taskClasses: { "Class-A": { chain: ["a/b"] } } }, /class name "Class-A" must be a lowercase slug/],
    ["an underscore class name", { taskClasses: { class_a: { chain: ["a/b"] } } }, /lowercase slug/],
    ["a class name over 48 characters", { taskClasses: { [`a${"b".repeat(48)}`]: { chain: ["a/b"] } } }, /at most 48 characters/],
    ["a non-object class", { taskClasses: { x: "a/b" } }, /taskClasses\.x: expected \{ chain/],
    ["a missing chain", { taskClasses: { x: {} } }, /taskClasses\.x\.chain: expected an array/],
    ["an empty chain", { taskClasses: { x: { chain: [] } } }, /taskClasses\.x\.chain: expected 1 to 16 steps/],
    ["a chain of 17 steps", { taskClasses: { x: { chain: Array.from({ length: 17 }, (_, i) => `p/m${i}`) } } }, /expected 1 to 16 steps/],
    ["a step with no slash", { taskClasses: { x: { chain: ["just-a-model"] } } }, /taskClasses\.x\.chain\[0\]: "just-a-model" must be a worker profile id/],
    ["a step ending in a slash", { taskClasses: { x: { chain: ["p/"] } } }, /chain\[0\]/],
    ["a non-string step", { taskClasses: { x: { chain: [{ provider: "p", id: "m" }] } } }, /taskClasses\.x\.chain\[0\]: expected a nonempty string/],
    ["a duplicate step", { taskClasses: { x: { chain: ["p/m", "q/n", "p/m"] } } }, /"p\/m" appears more than once/],
    ["a non-boolean gate flag", { taskClasses: { x: { chain: ["p/m"], requiresTestGate: "yes" } } }, /taskClasses\.x\.requiresTestGate: expected true or false/],
    ["a misspelled key (a silently dropped gate flag)", { taskClasses: { x: { chain: ["p/m"], requireTestGate: true } } }, /taskClasses\.x\.requireTestGate: unknown key/],
    ["an oversized note", { taskClasses: { x: { chain: ["p/m"], note: "n".repeat(401) } } }, /taskClasses\.x\.note/],
  ])("refuses %s with the key named", (_name, config, message) => {
    expect(() => parse(config)).toThrow(RoutingConfigError);
    expect(() => parse(config)).toThrow(message);
  });

  const profile = (ensure: unknown) => ({ workerProfiles: [{ id: "hub/local", model: "local-p/fast-model", ensure }] });
  it.each([
    ["a shell string for command", { command: "start-server --now" }, /ensure\.command: expected an argv array of strings.*never runs a shell/],
    ["an empty argv", { command: [] }, /ensure\.command: expected 1 to 64 argv strings/],
    ["a non-string argv element", { command: ["/opt/up", 3] }, /ensure\.command\[1\]: expected a nonempty string/],
    ["an empty argv element", { command: ["/opt/up", ""] }, /ensure\.command\[1\]/],
    ["a NUL in an argv element", { command: ["/opt/up", "a\u0000b"] }, /ensure\.command\[1\].*without NUL/],
    ["a repository-relative program", { command: ["./up.sh"] }, /ensure\.command\[0\]: must be an absolute path or a bare command name/],
    ["a parent-relative program", { command: ["../up.sh"] }, /ensure\.command\[0\]/],
    ["a bare name with spaces (a shell line in one string)", { command: ["up --start"] }, /ensure\.command\[0\]/],
    ["a bad release", { command: ["/opt/up"], release: "down" }, /ensure\.release: expected an argv array/],
    ["a relative release", { command: ["/opt/up"], release: ["bin/down"] }, /ensure\.release\[0\]/],
    ["a timeout under a second", { command: ["/opt/up"], timeoutMs: 999 }, /ensure\.timeoutMs: expected an integer from 1000 to 600000/],
    ["a timeout over ten minutes", { command: ["/opt/up"], timeoutMs: 600_001 }, /ensure\.timeoutMs/],
    ["a fractional timeout", { command: ["/opt/up"], timeoutMs: 1500.5 }, /ensure\.timeoutMs/],
    ["an unknown key", { command: ["/opt/up"], env: {} }, /ensure\.env: unknown key/],
    ["a non-object", ["/opt/up"], /ensure: expected \{ command/],
  ])("refuses an ensure with %s with the key named", (_name, ensure, message) => {
    expect(() => parse(profile(ensure))).toThrow(RoutingConfigError);
    expect(() => parse(profile(ensure))).toThrow(/workerProfiles\[0\]\.ensure/);
    expect(() => parse(profile(ensure))).toThrow(message);
  });

  it("accepts an absolute program, a bare PATH program and both boundary timeouts", () => {
    for (const command of [["/opt/up"], ["up-server", "--flag"], ["/Applications/My App/up"]]) expect(parse(profile({ command })).workerProfiles?.[0].ensure?.command).toEqual(command);
    expect(parse(profile({ command: ["/opt/up"], timeoutMs: 1_000 })).workerProfiles?.[0].ensure?.timeoutMs).toBe(1_000);
    expect(parse(profile({ command: ["/opt/up"], timeoutMs: 600_000 })).workerProfiles?.[0].ensure?.timeoutMs).toBe(600_000);
  });
});

describe("dispatch input: taskClass", () => {
  const input = (taskClass?: unknown): DispatchInput => ({ goal: "g", tasks: [{ label: "leaf", task: "t", ...(taskClass === undefined ? {} : { taskClass: taskClass as string }) }] });
  const cwd = mkdtempSync(join(tmpdir(), "steak-pi-class-cwd-"));
  afterAll(() => { rmSync(cwd, { recursive: true, force: true }); });

  it("is an optional lowercase slug in the tool schema", () => {
    const items = (ultratermSubagentsSchema.properties.tasks as unknown as { items: { properties: Record<string, { type: string; pattern: string; maxLength: number }>; required: string[] } }).items;
    expect(items.properties.taskClass).toMatchObject({ type: "string", maxLength: 48 });
    expect(new RegExp(items.properties.taskClass.pattern).test("class-a")).toBe(true);
    expect(new RegExp(items.properties.taskClass.pattern).test("Class_A")).toBe(false);
    expect(items.required).not.toContain("taskClass");
  });

  it("is kept on the normalized task and rejected when malformed", () => {
    const run = normalizeDispatch(input("class-a"), cwd, "p/m", "high");
    expect(run.tasks[0].taskClass).toBe("class-a");
    expect(normalizeDispatch(input(), cwd, "p/m", "high").tasks[0]).not.toHaveProperty("taskClass");
    for (const bad of ["Class", "a_b", "-a", "a--b", "", 7, "a".repeat(49)]) {
      expect(() => normalizeDispatch(input(bad), cwd, "p/m", "high"), String(bad)).toThrow(SubagentPolicyError);
      expect(() => normalizeDispatch(input(bad), cwd, "p/m", "high"), String(bad)).toThrow(/tasks\[0\]\.taskClass must be a lowercase slug/);
    }
  });
});

describe("wave classes", () => {
  const tasks = (...classes: Array<string | undefined>) => classes.map((taskClass, index) => ({ label: `leaf-${index}`, ...(taskClass ? { taskClass } : {}) }));

  it("knows only the classes the operator configured", () => {
    configure(CONFIG);
    expect(configuredTaskClass("class-a")?.chain).toEqual([LOCAL_PROFILE, CLOUD]);
    expect(configuredTaskClass("mystery")).toBeUndefined();
    expect(configuredTaskClass("__proto__")).toBeUndefined();
    expect(configuredTaskClass("constructor")).toBeUndefined();
  });

  it("names the one configured class, the unknown ones and the tasks that ride along", () => {
    configure(CONFIG);
    const wave = analyzeWaveClasses(tasks("class-a", "mystery", undefined, "class-a"), { refuseConflict: true });
    expect(wave.active?.name).toBe("class-a");
    expect(wave.unknown).toEqual(["mystery"]);
    expect(wave.riders).toEqual(["leaf-1", "leaf-2"]);
  });

  it("refuses two configured classes, but ignores them when the wave is not steered", () => {
    configure(CONFIG);
    expect(() => analyzeWaveClasses(tasks("class-a", "class-b"), { refuseConflict: true })).toThrow(TaskClassConflictError);
    expect(() => analyzeWaveClasses(tasks("class-a", "class-b"), { refuseConflict: true })).toThrow(/class-a, class-b.*dispatch each class as its own wave/);
    expect(analyzeWaveClasses(tasks("class-a", "class-b"), { refuseConflict: false }).declared).toEqual(["class-a", "class-b"]);
  });

  it("steers nothing with no taskClasses configured", () => {
    configure({ textWorkerChain: [FALLBACK] });
    const wave = analyzeWaveClasses(tasks("class-a"), { refuseConflict: true });
    expect(wave.active).toBeUndefined();
    expect(wave.unknown).toEqual(["class-a"]);
  });
});

type Model = Parameters<typeof resolveWorkerSelection>[0];
const model = (provider: string, id: string, baseUrl: string, input: string[] = ["text"]) => ({ provider, id, name: id, api: "openai-completions", baseUrl, input }) as unknown as Model;
const localModel = model("local-p", "fast-model", "http://127.0.0.1:8080/v1");
const cloudModel = model("cloud-p", "cloud-model", "https://cloud-p.example/v1");
const fallbackModel = model("fallback-p", "fb-model", "https://fallback-p.example/v1");
const meteredModel = model("metered-p", "metered-model", "https://metered-p.example/v1");

function registryOf(models: readonly Model[], unauthenticated: readonly string[] = []) {
  return {
    find: (provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
    getAll: () => [...models], getAvailable: () => [...models],
    hasConfiguredAuth: (candidate: Model) => !unauthenticated.includes(candidate.provider),
    isUsingOAuth: () => false,
    getProvider: () => ({ streamSimple() {} }),
  };
}

describe("class chain selection (same checks as the default chain)", () => {
  const dispatch = (extra: Record<string, unknown> = {}, taskExtra: Record<string, unknown> = {}) =>
    ({ goal: "g", tasks: [{ label: "leaf", task: "t", taskClass: "class-a", ...taskExtra }], ...extra }) as unknown as DispatchInput;
  function select(registry: ReturnType<typeof registryOf>, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}, name = "class-a") {
    const profiles = loadWorkerProfiles(join(dir, "no-harnesses"));
    const walk = resolveTaskClassWalk(name, configuredTaskClass(name)!, profiles);
    return resolveWorkerSelection(fallbackModel, "high", dispatch(extra, over), registry as never, profiles, "", { taskClass: walk, ...options }, {});
  }

  it("walks the class chain first and resolves a profile step to its model, thinking and profile id", () => {
    configure(CONFIG);
    const result = select(registryOf([localModel, cloudModel, fallbackModel]));
    expect(`${result.model.provider}/${result.model.id}`).toBe(LOCAL);
    expect(result.thinkingLevel).toBe("low");
    expect(result.selection).toMatchObject({ profile: LOCAL_PROFILE, source: "chain", chainRoutes: [LOCAL, CLOUD] });
    expect(result.selection.taskClass).toMatchObject({ name: "class-a", outcome: "served", step: LOCAL_PROFILE, requiresTestGate: true, note: "measured against a test gate" });
  });

  it("moves to the next class step when an earlier one is not authenticated, then to the normal chain", () => {
    configure(CONFIG);
    const second = select(registryOf([localModel, cloudModel, fallbackModel], ["local-p"]));
    expect(`${second.model.provider}/${second.model.id}`).toBe(CLOUD);
    expect(second.selection).not.toHaveProperty("profile");
    expect(second.selection.taskClass).toMatchObject({ outcome: "served", step: CLOUD, reason: "step 2 of 2 (cloud-p/cloud-model) launched" });
    const none = select(registryOf([localModel, cloudModel, fallbackModel], ["local-p", "cloud-p"]));
    expect(`${none.model.provider}/${none.model.id}`).toBe(FALLBACK);
    expect(none.selection).toMatchObject({ source: "chain", chainRoutes: [FALLBACK] });
    expect(none.selection.taskClass).toMatchObject({ name: "class-a", outcome: "fallback" });
    expect(none.selection.taskClass).not.toHaveProperty("step");
  });

  it("skips a class step missing from the dispatch catalog", () => {
    configure(CONFIG);
    const result = select(registryOf([cloudModel, fallbackModel]));
    expect(`${result.model.provider}/${result.model.id}`).toBe(CLOUD);
  });

  it("applies the paid-route rule: an unreviewed metered step never serves a class", () => {
    configure({ ...CONFIG, taskClasses: { "class-a": { chain: ["metered-p/metered-model", CLOUD] } } });
    const result = select(registryOf([meteredModel, cloudModel, fallbackModel]), {}, {}, { approvePaidRoute: () => true });
    expect(`${result.model.provider}/${result.model.id}`).toBe(CLOUD);
  });

  it("applies the quota veto (skipRoute) to class steps", () => {
    configure(CONFIG);
    const result = select(registryOf([localModel, cloudModel, fallbackModel]), {}, {}, { skipRoute: (step: { provider: string }) => step.provider === "local-p" });
    expect(`${result.model.provider}/${result.model.id}`).toBe(CLOUD);
  });

  it("applies routeConditions onlyWhen to class steps: unknown usage is not short", () => {
    const condition = { provider: "claude", everyAccount: { remainingBelow: 20, behindPaceAbove: 15 } };
    configure({ ...CONFIG, routeConditions: { [CLOUD]: condition }, taskClasses: { "class-a": { chain: [CLOUD, LOCAL_PROFILE] } } });
    const unknown = select(registryOf([localModel, cloudModel, fallbackModel]));
    expect(`${unknown.model.provider}/${unknown.model.id}`).toBe(LOCAL);
    const short = select(registryOf([localModel, cloudModel, fallbackModel]), {}, {}, { quotaSnapshot: { known: true, providers: { claude: { rows: [{ eligible: true, windows: [{ name: "seven_day", usedPercent: 95, resetAt: Date.now() / 1000 + 86_400 }] }] } } } });
    expect(`${short.model.provider}/${short.model.id}`).toBe(CLOUD);
  });

  it("never serves a retired class step", () => {
    configure({ ...CONFIG, retiredModelPatterns: [{ pattern: "^local-p/", message: "{route} is retired" }] });
    const result = select(registryOf([localModel, cloudModel, fallbackModel]));
    expect(`${result.model.provider}/${result.model.id}`).toBe(CLOUD);
  });

  it("leaves explicit, reviewer and image selections exact", () => {
    configure(CONFIG);
    const registry = registryOf([localModel, cloudModel, fallbackModel, model("vision-p", "vision-model", "https://vision-p.example/v1", ["text", "image"])]);
    const explicit = select(registry, {}, { model: FALLBACK });
    expect(`${explicit.model.provider}/${explicit.model.id}`).toBe(FALLBACK);
    expect(explicit.selection).toMatchObject({ source: "override" });
    expect(explicit.selection).not.toHaveProperty("taskClass");
    const reviewer = select(registry, { role: "reviewer" });
    expect(reviewer.selection).not.toHaveProperty("taskClass");
    expect(() => select(registry, {}, { requireImages: true })).toThrow();
  });

  it("is exactly the normal route when no class walk is passed", () => {
    configure(CONFIG);
    const profiles = loadWorkerProfiles(join(dir, "no-harnesses"));
    const result = resolveWorkerSelection(fallbackModel, "high", dispatch(), registryOf([localModel, cloudModel, fallbackModel]) as never, profiles, "", {}, {});
    expect(`${result.model.provider}/${result.model.id}`).toBe(FALLBACK);
    expect(result.selection).not.toHaveProperty("taskClass");
  });
});

// The dispatch boundary, with a fake worker runner and a fake ensure command.
describe("dispatch: task class routing and the ensure hook", () => {
  const okExec = (): EnsureExecResult => ({ ok: true, code: 0, signal: null, timedOut: false, aborted: false, stderr: "" });
  const badExec = (stderr = "port 8080 is busy"): EnsureExecResult => ({ ok: false, code: 3, signal: null, timedOut: false, aborted: false, stderr });

  function build(options: { models?: readonly Model[]; unauthenticated?: readonly string[]; exec?: EnsureExec; runner?: WorkerRunner; deps?: Partial<UltratermSubagentsDependencies>; durable?: { root: string; parent: string } } = {}) {
    const tools = new Map<string, any>();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const pi = {
      appendEntry() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); }, sendMessage() {},
    } as unknown as ExtensionAPI;
    const events: string[] = [];
    const exec = vi.fn(options.exec ?? (async (argv: readonly string[]) => { events.push(argv[0].split("/").pop()!); return okExec(); }));
    const runner = vi.fn(options.runner ?? (async ({ run }: Parameters<WorkerRunner>[0]) => { events.push(`worker:${run.model}`); return { state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }; }));
    let id = 0;
    createUltratermSubagentsExtension({
      createRunner: () => runner, idFactory: () => `fixed-${++id}`, startupWindowMs: 2_000, ensureExec: exec, checkpointRoot: options.durable?.root, ...options.deps,
    })(pi);
    const cwd = mkdtempSync(join(tmpdir(), "steak-pi-class-ext-"));
    const models = options.models ?? [localModel, cloudModel, fallbackModel];
    const registry = registryOf(models, options.unauthenticated);
    const ctx = {
      cwd, model: fallbackModel, modelRegistry: registry, thinkingLevel: "high",
      sessionManager: { getSessionFile: () => options.durable?.parent, getSessionId: () => options.durable?.parent ?? cwd, getEntries: () => [] },
      ui: { setStatus() {} },
    } as any;
    const dispatch = (params: Record<string, unknown>, signal?: AbortSignal) => tools.get("ultraterm_subagents").execute("t", { goal: "Class routing", ...params }, signal, undefined, ctx);
    const close = async () => { await handlers.get("session_shutdown")?.({}, ctx); rmSync(cwd, { recursive: true, force: true }); };
    const hub = (params: Record<string, unknown>) => tools.get("ultraterm_hub").execute("hub", params, undefined, undefined, ctx);
    return { dispatch, runner, exec, events, close, hub, start: () => handlers.get("session_start")!({}, ctx) };
  }
  const leaf = (taskClass?: string, extra: Record<string, unknown> = {}) => ({ label: "leaf", task: "Implement the leaf", ...(taskClass ? { taskClass } : {}), ...extra });

  it("runs a configured class on its first chain step with ensure before and release after the worker", async () => {
    configure(CONFIG);
    const t = build();
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a", { mayEdit: true, ownedPaths: ["src/a.ts"] })] });
      expect(result.details.run.model).toBe(LOCAL);
      expect(result.details.run.selection).toMatchObject({ profile: LOCAL_PROFILE, source: "chain" });
      expect(result.details.run.selection.taskClass).toMatchObject({ name: "class-a", outcome: "served", step: LOCAL_PROFILE, requiresTestGate: true });
      expect(t.events).toEqual(["up", `worker:${LOCAL}`, "down"]);
      expect(t.exec.mock.calls[0][0]).toEqual(ENSURE.command);
      expect(t.exec.mock.calls[1][0]).toEqual(ENSURE.release);
      expect(result.details.run.tasks[0].profileEnsure).toEqual({ profile: LOCAL_PROFILE, state: "released" });
      expect(result.details.summary.taskClass).toMatchObject({ name: "class-a", outcome: "served" });
      expect(result.details.summary.tasks[0]).toMatchObject({ taskClass: "class-a", modelRoute: LOCAL });
      const text = result.content[0].text as string;
      expect(text).toMatch(/Task class class-a: served; step 1 of 2 \(hub\/local\) launched\./);
      expect(text).toMatch(/test gate checks its results: run that gate before accepting the work/);
      expect(text).toContain("Operator note: measured against a test gate");
    } finally { await t.close(); }
  });

  it("falls to the next class step, naming why the first was not chosen", async () => {
    configure(CONFIG);
    const t = build({ unauthenticated: ["local-p"] });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      expect(result.details.run.model).toBe(CLOUD);
      expect(result.details.run.selection.taskClass).toMatchObject({ outcome: "served", step: CLOUD });
      expect(result.details.run.selection.taskClass.reason).toMatch(/^step 2 of 2 \(cloud-p\/cloud-model\) launched; earlier steps: hub\/local: not launchable in this session/);
      expect(t.exec).not.toHaveBeenCalled(); // the cloud step has no profile, so no ensure
    } finally { await t.close(); }
  });

  it("falls back to the normal chain when no class step can launch, and says so", async () => {
    configure(CONFIG);
    const t = build({ unauthenticated: ["local-p", "cloud-p"] });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      expect(result.details.run.model).toBe(FALLBACK);
      expect(result.details.run.selection.taskClass).toMatchObject({ name: "class-a", outcome: "fallback" });
      expect(result.details.run.selection.taskClass.reason).toMatch(/^no step of the class chain could launch \(hub\/local: not launchable.*cloud-p\/cloud-model: not launchable.*\); the normal route ran$/);
      expect(result.content[0].text).toMatch(/Task class class-a: not served; no step of the class chain could launch/);
      expect(t.exec).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("ignores an unknown class with a note in the dispatch summary and routes normally", async () => {
    configure(CONFIG);
    const t = build();
    try {
      const result = await t.dispatch({ tasks: [leaf("mystery")] });
      expect(result.details.run.model).toBe(FALLBACK);
      expect(result.details.run.selection.taskClass).toMatchObject({ name: "mystery", outcome: "ignored" });
      expect(result.details.run.selection.taskClass.reason).toMatch(/task class mystery is not configured in ~\/\.config\/ultraterm\/routing\.json taskClasses, so the normal route ran/);
      expect(result.details.summary.taskClass).toMatchObject({ name: "mystery", outcome: "ignored" });
      expect(result.content[0].text).toMatch(/Task class mystery: ignored; task class mystery is not configured/);
      expect(t.exec).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("ignores every class when the operator configured none", async () => {
    configure({ textWorkerChain: [FALLBACK], subscriptionRouteChecks: CONFIG.subscriptionRouteChecks });
    const t = build();
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      expect(result.details.run.model).toBe(FALLBACK);
      expect(result.details.run.selection.taskClass).toMatchObject({ outcome: "ignored" });
    } finally { await t.close(); }
  });

  it("records nothing for a wave that declared no class", async () => {
    configure(CONFIG);
    const t = build();
    try {
      const result = await t.dispatch({ tasks: [leaf()] });
      expect(result.details.run.model).toBe(FALLBACK);
      expect(result.details.run.selection).not.toHaveProperty("taskClass");
      expect(result.details.summary).not.toHaveProperty("taskClass");
      expect(result.content[0].text).not.toMatch(/Task class/);
    } finally { await t.close(); }
  });

  it("refuses two configured classes in one wave before anything starts", async () => {
    configure(CONFIG);
    const t = build();
    try {
      await expect(t.dispatch({ tasks: [leaf("class-a"), { ...leaf("class-b"), label: "other" }] })).rejects.toThrow(/class-a, class-b.*dispatch each class as its own wave/);
      expect(t.runner).not.toHaveBeenCalled();
      expect(t.exec).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("lets tasks without the class ride the wave's route and names them", async () => {
    configure(CONFIG);
    const t = build();
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a"), { ...leaf(), label: "rider" }, { ...leaf("mystery"), label: "stray" }] });
      expect(result.details.run.model).toBe(LOCAL);
      expect(result.content[0].text).toMatch(/Tasks without this class \("rider", "stray"\) ride the same route/);
      expect(result.content[0].text).toContain("Ignored, not configured: mystery.");
    } finally { await t.close(); }
  });

  it("keeps an explicit model exact and ignores the class with a note", async () => {
    configure(CONFIG);
    const t = build();
    try {
      const result = await t.dispatch({ model: FALLBACK, tasks: [leaf("class-a")] });
      expect(result.details.run.model).toBe(FALLBACK);
      expect(result.details.run.selection).toMatchObject({ source: "override", taskClass: { name: "class-a", outcome: "ignored" } });
      expect(result.details.run.selection.taskClass.reason).toMatch(/steers only an implicit wave/);
      expect(t.exec).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("an explicit profile with an ensure hook still gets its hook", async () => {
    configure(CONFIG);
    const t = build();
    try {
      const result = await t.dispatch({ profile: LOCAL_PROFILE, tasks: [leaf()] });
      expect(result.details.run.model).toBe(LOCAL);
      expect(t.events).toEqual(["up", `worker:${LOCAL}`, "down"]);
    } finally { await t.close(); }
  });

  it("a refused ensure falls through to the next class step inside the same call", async () => {
    configure(CONFIG);
    const t = build({ exec: async () => badExec() });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      // Two launches from ONE call: the local profile (refused by its hook, worker never started), then the cloud step.
      expect(t.runner.mock.calls.map(([context]) => context.run.model)).toEqual([CLOUD]);
      expect(t.exec).toHaveBeenCalledTimes(1); // the failed command holds nothing, so no release
      expect(result.details.run.model).toBe(CLOUD);
      expect(result.details.run.selection.taskClass).toMatchObject({ outcome: "served", step: CLOUD });
      expect(result.details.run.selection.taskClass.reason).toMatch(/earlier steps: hub\/local: run run-fixed-1 was refused by its profile ensure hook before any worker started \(.*port 8080 is busy/);
      const text = result.content[0].text as string;
      expect(text).toMatch(/Fall-through: run run-fixed-1 · local-p\/fast-model was refused by its profile ensure hook before any worker started/);
      expect(text).toContain("port 8080 is busy");
    } finally { await t.close(); }
  });

  it("a refused ensure on the last class step falls back to the normal chain", async () => {
    configure({ ...CONFIG, taskClasses: { "class-a": { chain: [LOCAL_PROFILE] } } });
    const t = build({ exec: async () => badExec("model weights missing") });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      expect(result.details.run.model).toBe(FALLBACK);
      expect(result.details.run.selection.taskClass).toMatchObject({ outcome: "fallback" });
      expect(result.details.run.selection.taskClass.reason).toContain("model weights missing");
      expect(result.details.run.selection.fallbackReason ?? "").toBe("");
    } finally { await t.close(); }
  });

  it("an explicit profile whose ensure is refused fails the call with the command's cause and never reroutes", async () => {
    configure(CONFIG);
    const t = build({ exec: async () => badExec() });
    try {
      await expect(t.dispatch({ profile: LOCAL_PROFILE, tasks: [leaf()] })).rejects.toThrow(/USAP dispatch failed before any worker produced model output \(run run-fixed-1 · local-p\/fast-model\).*USAP profile ensure refused \(hub\/local\): port 8080 is busy/);
      expect(t.runner).not.toHaveBeenCalled();
    } finally { await t.close(); }
  });

  it("releases when the worker fails after a successful ensure", async () => {
    configure(CONFIG);
    const t = build({ runner: async () => ({ state: "failed", output: "", error: "worker crashed", turns: 1, usage: emptyUsage() }), deps: { startupWindowMs: 0 } });
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      expect(result.details.run.tasks[0]).toMatchObject({ state: "failed", profileEnsure: { state: "released" } });
      expect(t.exec.mock.calls.map(([argv]) => argv[0].split("/").pop())).toEqual(["up", "down"]);
    } finally { await t.close(); }
  });

  it("releases when the dispatch is cancelled while the worker runs", async () => {
    configure(CONFIG);
    const t = build({
      runner: async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { state: "aborted", output: "", turns: 1, usage: emptyUsage() };
      },
      deps: { startupWindowMs: 0 },
    });
    try {
      const controller = new AbortController();
      const pending = t.dispatch({ tasks: [leaf("class-a")] }, controller.signal);
      await vi.waitFor(() => expect(t.runner).toHaveBeenCalled());
      expect(t.exec.mock.calls.map(([argv]) => argv[0].split("/").pop())).toEqual(["up"]); // the worker holds the lease
      controller.abort();
      const result = await pending;
      expect(result.details.run.tasks[0].state).toBe("aborted");
      expect(t.exec.mock.calls.map(([argv]) => argv[0].split("/").pop())).toEqual(["up", "down"]);
      expect(result.details.run.tasks[0].profileEnsure).toEqual({ profile: LOCAL_PROFILE, state: "released" });
    } finally { await t.close(); }
  });

  it("a bounded resume of a run on a hook profile runs the hook again and keeps the class receipt", async () => {
    configure({ ...CONFIG, workerProfiles: [{ id: LOCAL_PROFILE, model: LOCAL, thinking: "medium", ensure: ENSURE }] });
    const root = mkdtempSync(join(tmpdir(), "steak-pi-class-resume-"));
    try {
      const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl") };
      const store = new CheckpointStore(durable.parent, durable.root, durable.parent);
      const run = normalizeDispatch({ goal: "continue", background: true, tasks: [{ label: "unfinished", task: "continue", taskClass: "class-a" }] }, root, LOCAL, "medium", Date.now(), () => "interrupted");
      run.selection = { provider: "local-p", modelId: "fast-model", profile: LOCAL_PROFILE, source: "chain", images: false, tools: true,
        taskClass: { name: "class-a", outcome: "served", step: LOCAL_PROFILE, reason: "step 1 of 2 (hub/local) launched" } };
      run.tasks[0].state = "running"; run.tasks[0].startedAt = Date.now();
      const sessionFile = join(store.sessionsDirectory, "native.jsonl"); writeFileSync(sessionFile, "checkpoint", { mode: 0o600 });
      run.tasks[0].sessionFile = sessionFile;
      store.save(run, true); store.close();
      const t = build({ durable, deps: { startupWindowMs: 0 } });
      try {
        await t.start();
        const resumed = await t.hub({ action: "resume", runId: run.id });
        await vi.waitFor(() => expect(t.events).toEqual(["up", `worker:${LOCAL}`, "down"]));
        expect(resumed.details.run.selection).toMatchObject({ profile: LOCAL_PROFILE, taskClass: { name: "class-a", outcome: "served" } });
      } finally { await t.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("the worker prompt carries the test-gate line only for an editing worker on a gated class", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steak-pi-class-prompt-"));
    try {
      const run = normalizeDispatch({ goal: "g", tasks: [{ label: "edit", task: "t", mayEdit: true, ownedPaths: ["a.ts"], taskClass: "class-a" }, { label: "read", task: "t" }] }, cwd, LOCAL, "low");
      const gated = { provider: "local-p", modelId: "fast-model", source: "chain" as const, images: false, tools: true, taskClass: { name: "class-a", outcome: "served" as const, reason: "r", requiresTestGate: true } };
      run.selection = gated;
      expect(buildPiWorkerSystemPrompt(run, run.tasks[0])).toContain("Test gate: this leaf was routed as test-checkable work.");
      expect(buildPiWorkerSystemPrompt(run, run.tasks[1])).not.toContain("Test gate:");
      run.selection = { ...gated, taskClass: { ...gated.taskClass, requiresTestGate: false } };
      expect(buildPiWorkerSystemPrompt(run, run.tasks[0])).not.toContain("Test gate:");
      run.selection = { ...gated, taskClass: { ...gated.taskClass, outcome: "ignored" as const } };
      expect(buildPiWorkerSystemPrompt(run, run.tasks[0])).not.toContain("Test gate:");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it("reads the operator's file only: the config in force decides each dispatch", async () => {
    configure(CONFIG);
    expect(routingConfigOrEmpty().taskClasses).toBeDefined();
    configure({ textWorkerChain: [FALLBACK], subscriptionRouteChecks: CONFIG.subscriptionRouteChecks });
    const t = build();
    try {
      const result = await t.dispatch({ tasks: [leaf("class-a")] });
      expect(result.details.run.model).toBe(FALLBACK);
    } finally { await t.close(); }
  });
});

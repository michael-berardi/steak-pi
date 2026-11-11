// Follow-up build of spec 01: the opt-in interactive chain virtual model
// (`interactiveChainModel` in routing.json). The six probe cases now run under
// the shipped wiring (extension registration + pre-output chain wrapper beneath
// the virtual selection): quota, plan-limit and content-filter refusals end the
// turn successfully on the next chain step, controls are unchanged, an absent
// key registers nothing, and an explicit physical selection is never rerouted.
// In-process Pi SDK, deterministic local transports, no network. All provider
// and model names are test-local placeholders.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager, SettingsManager, createAgentSession, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import modelRoutePolicy from "../extensions/model-route-policy.ts";
import { createInteractiveChainRoute, interactiveChainFallback, isInteractiveChainModel, VIRTUAL_MODEL_API } from "../src/interactive-chain-model.ts";
import { parseRoutingConfig, setRoutingConfigOverride } from "../src/routing-config.ts";
import { initialCompanionState } from "../src/tui/model.ts";
import { collectUsage, emptyUsage, lastRoutedModel, plainPalette, renderComposerBands } from "../src/tui/render.ts";
import { createIsolatedResourceLoader } from "../src/subagents/pi-worker.ts";
import { sdkPiAiUrl } from "./helpers/pi-sdk-dependencies.ts";

// Resolve the SDK's own pi-ai, whether nested or hoisted.
const { AssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } = await import(/* @vite-ignore */ sdkPiAiUrl);

const SLOT_ID = "slot-model";
const VIRTUAL = { provider: "probe", id: "chain", name: "Probe chain" };
const CONFIG = {
  interactiveChainModel: VIRTUAL,
  textWorkerChain: [`probe-a/${SLOT_ID}`, `probe-b/${SLOT_ID}`],
};

/** One physical placeholder model per fake provider. Loopback base URL keeps the
 * route subscription/local by construction; the transport never opens a socket. */
const physicalModel = (provider: string) => ({
  id: SLOT_ID, name: "Probe slot model", provider,
  api: "openai-completions" as const, baseUrl: "http://127.0.0.1:9/v1",
  reasoning: false, input: ["text" as const], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

// Isolate every operator-file read (routing, paid routes, temporary free route)
// so the shipped defaults alone are under test.
const envKeys = ["HOME", "STEAK_PI_ROUTING_CONFIG", "STEAK_PI_PAID_ROUTES"] as const;
const saved: Record<string, string | undefined> = {};
let isolationDir: string;
beforeAll(async () => {
  isolationDir = await mkdtemp(join(tmpdir(), "interactive-chain-"));
  for (const key of envKeys) saved[key] = process.env[key];
  process.env.HOME = isolationDir;
  process.env.STEAK_PI_ROUTING_CONFIG = join(isolationDir, "absent-routing.json");
  process.env.STEAK_PI_PAID_ROUTES = join(isolationDir, "absent-paid.json");
});
afterEach(() => setRoutingConfigOverride(undefined));
afterAll(async () => {
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(isolationDir, { recursive: true, force: true });
});

interface CaseResult {
  hops: string[];
  statuses: { key: string; text: string | undefined }[];
  assistants: { provider: string; model: string; stopReason: string; errorMessage?: string; usage?: unknown }[];
  modelChanges: { provider: string; modelId: string }[];
}

/** Drive the REAL extension in-process against an SDK runtime, then run one prompt.
 * `select` chooses the virtual model (default) or the explicit physical probe-a. */
async function runCase(errorMessage: string, select: "virtual" | "explicit" = "virtual"): Promise<CaseResult> {
  const cwd = await mkdtemp(join(tmpdir(), "interactive-chain-case-"));
  const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in interactive-chain tests"); });
  try {
    setRoutingConfigOverride(CONFIG);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const modelA = physicalModel("probe-a");
    const modelB = physicalModel("probe-b");
    const failStream = () => {
      const message = { role: "assistant" as const, content: [], api: modelA.api, provider: modelA.provider,
        model: modelA.id, usage: zeroUsage(), stopReason: "error" as const, errorMessage, timestamp: Date.now() };
      const events = new AssistantMessageEventStream();
      events.push({ type: "error", reason: "error", error: message });
      events.end();
      return events;
    };
    const answerStream = () => {
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "Probe answer." }],
        api: modelB.api, provider: modelB.provider, model: modelB.id, usage: zeroUsage(), stopReason: "stop" as const, timestamp: Date.now() };
      const events = new AssistantMessageEventStream();
      events.push({ type: "start", partial: message });
      events.push({ type: "done", reason: "stop", message });
      events.end();
      return events;
    };
    runtime.registerNativeProvider({ id: "probe-a", name: "Probe A", getModels: () => [modelA],
      auth: { apiKey: { name: "Stub key", resolve: async () => ({ auth: {}, source: "test-local stub credential" }) } },
      stream: failStream, streamSimple: failStream });
    runtime.registerNativeProvider({ id: "probe-b", name: "Probe B", getModels: () => [modelB],
      auth: { apiKey: { name: "Stub key", resolve: async () => ({ auth: {}, source: "test-local stub credential" }) } },
      stream: answerStream, streamSimple: answerStream });
    await runtime.setRuntimeApiKey("probe-a", "test-local-stub-not-a-secret");
    await runtime.setRuntimeApiKey("probe-b", "test-local-stub-not-a-secret");
    await runtime.refresh({ allowNetwork: false });

    // The registry surface the extension sees, backed by the live runtime
    // (the same adapter guardModelRuntime builds for workers).
    const registry = {
      find: (provider: string, id: string) => runtime.getModel(provider, id),
      getAvailable: () => [...runtime.getAvailableSnapshot()],
      getAll: () => [...runtime.getModels()],
      hasConfiguredAuth: (model: { provider: string }) => runtime.hasConfiguredAuth(model.provider),
      isUsingOAuth: (model: { provider: string }) => runtime.isUsingOAuth(model.provider),
      getProvider: (id: string) => runtime.getProvider(id),
      getRegisteredNativeProvider: (id: string) => runtime.getRegisteredNativeProvider(id),
      registerProvider: (provider: Parameters<typeof runtime.registerNativeProvider>[0]) => runtime.registerNativeProvider(provider),
      getProviderAuth: (id: string) => runtime.getAuth(id),
    };
    const statuses: CaseResult["statuses"] = [];
    const ui = {
      setStatus: (key: string, text: string | undefined) => { statuses.push({ key, text }); },
      notify: vi.fn(),
    };
    const ctx: { model: unknown; modelRegistry: typeof registry; ui: typeof ui } = { model: undefined, modelRegistry: registry, ui };

    // Load the shipped extension and capture its event handlers.
    const handlers = new Map<string, ((event: never, ctx: never) => unknown)[]>();
    const virtuals: { provider: string; id: string; name: string; route: (request: never, ctx: never) => unknown }[] = [];
    const pi = {
      registerProvider: vi.fn(),
      registerVirtualModel: (definition: (typeof virtuals)[number]) => { virtuals.push(definition); },
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: (event: string, handler: (event: never, ctx: never) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    };
    modelRoutePolicy(pi as never);
    expect(virtuals).toHaveLength(1);
    expect(virtuals[0]).toMatchObject(VIRTUAL);
    // Register the extension's virtual model on the runtime, routing through the
    // extension's own route() with the extension context.
    const definition = virtuals[0];
    runtime.registerVirtualModel({ ...definition, route: (request: never) => definition.route(request, ctx as never) } as never);

    const selected = select === "virtual" ? runtime.getModel(VIRTUAL.provider, VIRTUAL.id)! : runtime.getModel("probe-a", SLOT_ID)!;
    ctx.model = selected;
    for (const handler of handlers.get("session_start") ?? []) handler({ reason: "startup" } as never, ctx as never);

    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime,
      model: selected, thinkingLevel: "off", noTools: "all",
      sessionManager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }),
      resourceLoader: createIsolatedResourceLoader("Offline interactive-chain fixture. Answer with one short sentence.", createExtensionRuntime()),
    });
    await session.prompt("Reply with one short sentence.");

    const assistants = session.messages
      .filter((message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant")
      .map(message => ({ provider: String(message.provider), model: String(message.model), stopReason: String(message.stopReason), errorMessage: message.errorMessage, usage: message.usage }));
    const modelChanges = sessionManager.getBranch()
      .filter(entry => entry.type === "model_change")
      .map(entry => ({ provider: (entry as { provider: string }).provider, modelId: (entry as { modelId: string }).modelId }));
    const hops = statuses.filter(entry => entry.key === "steak-pi-route" && entry.text?.startsWith("model-fallback:")).map(entry => entry.text!);
    expect(fetchGuard).not.toHaveBeenCalled();
    return { hops, statuses, assistants, modelChanges };
  } finally {
    fetchGuard.mockRestore();
    await rm(cwd, { recursive: true, force: true });
  }
}

/** A successful hop keeps the virtual selection and attributes the answer to the physical provider. */
function expectSuccessfulHop(result: CaseResult) {
  const last = result.assistants.at(-1)!;
  expect(last.provider).toBe("probe-b");
  expect(last.model).toBe(SLOT_ID);
  expect(last.stopReason).toBe("stop");
  // Cost/usage attribution stays on the physical provider per assistant message.
  expect(last.usage).toBeDefined();
  expect(result.hops).toEqual([`model-fallback:probe-a/${SLOT_ID}->probe-b/${SLOT_ID}`]);
  expect(result.modelChanges.at(-1)).toEqual({ provider: VIRTUAL.provider, modelId: VIRTUAL.id });
}

describe("interactive chain virtual model: the probe cases under the shipped wiring", () => {
  it("quota (429 subscription_quota_exceeded) hops pre-output and the turn ends successfully", async () => {
    expectSuccessfulHop(await runCase("429 subscription_quota_exceeded"));
  }, 30000);

  it("plan limit (GoUsageLimitError) hops pre-output and the turn ends successfully", async () => {
    expectSuccessfulHop(await runCase("GoUsageLimitError: usage limit reached"));
  }, 30000);

  it("content filter (400 data_inspection_failed) hops pre-output and the turn ends successfully", async () => {
    expectSuccessfulHop(await runCase("400 data_inspection_failed"));
  }, 30000);

  it("transient control (503 overloaded) still ends successfully", async () => {
    const result = await runCase("503 overloaded");
    expect(result.assistants.at(-1)?.stopReason).toBe("stop");
    expect(result.assistants.at(-1)?.provider).toBe("probe-b");
    expect(result.modelChanges.at(-1)).toEqual({ provider: VIRTUAL.provider, modelId: VIRTUAL.id });
  }, 30000);

  it("hard-stop control (401 invalid api key) never hops and still ends on the error", async () => {
    const result = await runCase("401 invalid api key");
    expect(result.hops).toEqual([]);
    const last = result.assistants.at(-1)!;
    expect(last.provider).toBe("probe-a");
    expect(last.stopReason).toBe("error");
    expect(last.errorMessage).toContain("401");
  }, 30000);

  it("combined wiring: the wrapper beneath the virtual selection is the default, with one hop receipt", async () => {
    const result = await runCase("429 subscription_quota_exceeded");
    expectSuccessfulHop(result);
    // The hop receipt is the same from->to record workers emit, surfaced as a status.
    expect(result.statuses.some(entry => entry.key === "steak-pi-route")).toBe(true);
  }, 30000);

  it("an explicit physical selection is never rerouted: the same quota error ends the turn", async () => {
    const result = await runCase("429 subscription_quota_exceeded", "explicit");
    expect(result.hops).toEqual([]);
    const last = result.assistants.at(-1)!;
    expect(last.provider).toBe("probe-a");
    expect(last.stopReason).toBe("error");
    expect(result.modelChanges.at(-1)).toEqual({ provider: "probe-a", modelId: SLOT_ID });
  }, 30000);
});

describe("opt-in registration", () => {
  it("absent key: no virtual model is registered and no chain is installed", () => {
    setRoutingConfigOverride({ textWorkerChain: [`probe-a/${SLOT_ID}`, `probe-b/${SLOT_ID}`] });
    const registerVirtualModel = vi.fn();
    const handlers = new Map<string, (event: never, ctx: never) => unknown>();
    modelRoutePolicy({ registerProvider: vi.fn(), registerVirtualModel, registerFlag: vi.fn(), getFlag: vi.fn(),
      on: (event: string, handler: never) => { handlers.set(event, handler); } } as never);
    expect(registerVirtualModel).not.toHaveBeenCalled();
    // Even a model that names the would-be virtual identity gets no chain while the key is absent.
    const virtualLike = { provider: VIRTUAL.provider, id: VIRTUAL.id, api: VIRTUAL_MODEL_API };
    expect(interactiveChainFallback(virtualLike as never, {} as never, () => true)).toBeUndefined();
    expect(isInteractiveChainModel(virtualLike as never)).toBe(false);
  });

  it("configured key: the virtual identity is recognized and the wrapper input follows the configured chain", () => {
    setRoutingConfigOverride(CONFIG);
    const virtualModel = { provider: VIRTUAL.provider, id: VIRTUAL.id, api: VIRTUAL_MODEL_API };
    expect(isInteractiveChainModel(virtualModel as never)).toBe(true);
    expect(isInteractiveChainModel({ ...virtualModel, api: "openai-completions" } as never)).toBe(false);
    const registry = {} as never;
    const options = interactiveChainFallback(virtualModel as never, registry, () => true);
    expect(options?.chain).toEqual([{ provider: "probe-a", id: SLOT_ID }, { provider: "probe-b", id: SLOT_ID }]);
    expect(options?.registry).toBe(registry);
    // A physical selection never acquires the chain.
    expect(interactiveChainFallback({ provider: "probe-a", id: SLOT_ID, api: "openai-completions" } as never, registry, () => true)).toBeUndefined();
  });
});

describe("route() semantics", () => {
  const modelA = physicalModel("probe-a");
  const modelB = physicalModel("probe-b");
  const registryFor = (authA: boolean) => ({
    find: (provider: string, id: string) => [modelA, modelB].find(m => m.provider === provider && m.id === id),
    getAvailable: () => [modelA, modelB],
    getAll: () => [modelA, modelB],
    hasConfiguredAuth: (model: { provider: string }) => model.provider !== "probe-a" || authA,
    isUsingOAuth: () => false,
    getProvider: () => ({ streamSimple() {} }),
  });
  const request = (extra: Record<string, unknown>) => ({
    model: { ...modelA, provider: VIRTUAL.provider, id: VIRTUAL.id, api: VIRTUAL_MODEL_API },
    thinkingLevel: "off", reason: "user", messages: [], ...extra,
  }) as never;

  it("user: the first available chain step, with the worker chain's auth check", async () => {
    setRoutingConfigOverride(CONFIG);
    const route = createInteractiveChainRoute({ registry: registryFor(false) as never });
    expect((await route(request({}))).model.provider).toBe("probe-b");
    const headUp = createInteractiveChainRoute({ registry: registryFor(true) as never });
    expect((await headUp(request({}))).model.provider).toBe("probe-a");
  });

  it("continuation: keeps the physical model that last answered", async () => {
    setRoutingConfigOverride(CONFIG);
    const route = createInteractiveChainRoute({ registry: registryFor(true) as never });
    const routed = await route(request({ reason: "continuation", previous: { model: modelB, thinkingLevel: "high" } }));
    expect(routed.model.provider).toBe("probe-b");
    expect(routed.thinkingLevel).toBe("high");
  });

  it("retry: an eligible error leaves for the next step and emits the hop receipt", async () => {
    setRoutingConfigOverride(CONFIG);
    const hops: string[] = [];
    const route = createInteractiveChainRoute({ registry: registryFor(true) as never,
      onHop: (from, to) => { hops.push(`${from.provider}/${from.id}->${to.provider}/${to.id}`); } });
    const failed = { model: modelA, message: { errorMessage: "429 subscription_quota_exceeded" } };
    const routed = await route(request({ reason: "retry", failed }));
    expect(routed.model.provider).toBe("probe-b");
    expect(hops).toEqual([`probe-a/${SLOT_ID}->probe-b/${SLOT_ID}`]);
  });

  it("retry: a hard-stop error keeps the failed model (Pi's own semantics unchanged)", async () => {
    setRoutingConfigOverride(CONFIG);
    const route = createInteractiveChainRoute({ registry: registryFor(true) as never });
    const failed = { model: modelA, message: { errorMessage: "401 invalid api key" } };
    expect((await route(request({ reason: "retry", failed }))).model.provider).toBe("probe-a");
    // A failed route outside the chain also stays put.
    const outsider = { model: { ...modelA, provider: "probe-x" }, message: { errorMessage: "429 subscription_quota_exceeded" } };
    expect((await route(request({ reason: "retry", failed: outsider }))).model.provider).toBe("probe-x");
  });

  it("user: an onlyWhen step is eligible only while every router account is short, exactly as for workers", async () => {
    setRoutingConfigOverride({
      interactiveChainModel: VIRTUAL,
      textWorkerChain: [
        { provider: "probe-a", id: SLOT_ID, onlyWhen: { provider: "router-x", everyAccount: { remainingBelow: 10, behindPaceAbove: 5 } } },
        `probe-b/${SLOT_ID}`,
      ],
    });
    const snapshot = { known: true, providers: { "router-x": { provider: "router-x", accounts: 1,
      rows: [{ id: "acct", label: "acct", exhausted: true, why: "a usage window is at 100%" }],
      exhausted: true, unconfigured: false, ineligible: false, cause: "out" } } };
    const route = createInteractiveChainRoute({ registry: registryFor(true) as never, quotaSnapshot: async () => snapshot as never });
    // Every account out: the conditional step is eligible and serves first.
    expect((await route(request({}))).model.provider).toBe("probe-a");
    const healthy = { known: true, providers: { "router-x": { ...snapshot.providers["router-x"],
      rows: [{ id: "acct", label: "acct", usedPercent: 10, why: "" }], exhausted: false, cause: "" } } };
    const routeUp = createInteractiveChainRoute({ registry: registryFor(true) as never, quotaSnapshot: async () => healthy as never });
    // Accounts healthy: the conditional step is held back and the next step serves.
    expect((await routeUp(request({}))).model.provider).toBe("probe-b");
  });
});

describe("routing.json validation (steak-pi routing check uses this parser)", () => {
  it("accepts the key with and without an explicit chain", () => {
    expect(parseRoutingConfig({ interactiveChainModel: VIRTUAL }).interactiveChainModel).toEqual(VIRTUAL);
    expect(parseRoutingConfig({ interactiveChainModel: { ...VIRTUAL, chain: "multimodalWorkerChain" } }).interactiveChainModel?.chain).toBe("multimodalWorkerChain");
  });
  it("rejects a malformed key, naming it", () => {
    expect(() => parseRoutingConfig({ interactiveChainModel: { provider: "probe", id: "chain" } })).toThrow(/interactiveChainModel\.name/);
    expect(() => parseRoutingConfig({ interactiveChainModel: { ...VIRTUAL, chain: "someOtherChain" } })).toThrow(/interactiveChainModel\.chain/);
    expect(() => parseRoutingConfig({ interactiveChainModel: { ...VIRTUAL, extra: true } })).toThrow(/interactiveChainModel\.extra/);
    expect(() => parseRoutingConfig({ interactiveChainModel: "probe/chain" })).toThrow(/interactiveChainModel/);
  });
});

describe("footer and usage attribution", () => {
  const assistantEntry = (provider: string, model: string, api: string, cost: number) => ({
    type: "message", message: { role: "assistant", provider, model, api,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } },
  });

  it("lastRoutedModel names the latest physical answerer and skips failed virtual routing", () => {
    const entries = [
      assistantEntry("probe-a", SLOT_ID, "openai-completions", 0.1),
      assistantEntry("probe-b", SLOT_ID, "openai-completions", 0.2),
      assistantEntry(VIRTUAL.provider, VIRTUAL.id, VIRTUAL_MODEL_API, 0),
    ];
    expect(lastRoutedModel(entries)).toBe(`probe-b/${SLOT_ID}`);
    expect(lastRoutedModel([])).toBeUndefined();
  });

  it("the band shows the virtual selection name plus the routed physical model", () => {
    const snapshot = {
      state: initialCompanionState(), cwd: "/tmp", model: { id: VIRTUAL.id, name: VIRTUAL.name },
      routed: `probe-b/${SLOT_ID}`, thinking: "off", usage: emptyUsage(),
    };
    const line = renderComposerBands(120, snapshot, plainPalette).join("\n");
    expect(line).toContain(`${VIRTUAL.id} → probe-b/${SLOT_ID}`);
    // Without a virtual selection nothing changes: no routed suffix is rendered.
    const plain = renderComposerBands(120, { ...snapshot, routed: undefined }, plainPalette).join("\n");
    expect(plain).not.toContain("→");
  });

  it("usage and cost stay attributed per assistant message (physical provider), not to the virtual selection", () => {
    const entries = [
      assistantEntry("probe-a", SLOT_ID, "openai-completions", 0.1),
      assistantEntry("probe-b", SLOT_ID, "openai-completions", 0.2),
    ];
    const usage = collectUsage(entries);
    expect(usage.cost).toBeCloseTo(0.3, 6);
    expect(usage.requests).toBe(2);
    // Each persisted message keeps its own physical provider for attribution.
    expect(entries.map(entry => entry.message.provider)).toEqual(["probe-a", "probe-b"]);
  });
});
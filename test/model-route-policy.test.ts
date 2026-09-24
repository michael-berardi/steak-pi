import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertModelRoute, assertSubscriptionRequest, guardProvider, selectWorkerModel, selectWorkerThinking,
  createRegistryGuard, GPT_ROUTE_ERROR, isModelRouteAllowed, guardModelRuntime, isExpertReviewModel,
  selectChainedWorkerModel, DEFAULT_TEXT_WORKER_CHAIN, DEFAULT_MULTIMODAL_WORKER_CHAIN, ROUTINE_GPT_MODEL,
  EXPERT_TEXT_REVIEW_CHAIN, EXPERT_MULTIMODAL_REVIEW_CHAIN,
  eligibleChainFallback, type WorkerRouteStep,
} from "../src/model-route-policy.ts";
import { eligibleGoFallback } from "../src/opencode-go-routing.ts";

// The SDK's own pi-ai event stream: chain tests exercise real provider streams.
const { createAssistantMessageEventStream } = await import(/* @vite-ignore */ new URL(
  "../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
).href);

type Model = Parameters<typeof assertSubscriptionRequest>[0];
type Provider = Parameters<typeof guardProvider>[0];

// These are provider-policy tests: pin an empty harness directory so the curated
// picker scope stays unknown (fail open) instead of reading the operator's live
// manifests. Curation itself is covered by test/model-visibility.test.ts.
const emptyHarnessDir = mkdtempSync(join(tmpdir(), "policy-no-harness-"));
beforeAll(() => { vi.stubEnv("ULTRATERM_HARNESS_DIR", emptyHarnessDir); vi.stubEnv("ULTRATERM_HARNESS_RESOURCES", emptyHarnessDir); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(emptyHarnessDir, { recursive: true, force: true }); });
// Resolve the SDK's own pi-ai: 0.86 requires normalization before provider dispatch.
const { normalizeContext } = await import(/* @vite-ignore */ new URL(
  "../node_modules/@earendil-works/pi-ai/dist/index.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
).href);
function emptyContext(): Parameters<Provider["streamSimple"]>[1] {
  // 0.85 accepts Context directly and does not export normalizeContext.
  const normalize = typeof normalizeContext === "function" ? normalizeContext : (context: { messages: never[] }) => context;
  return normalize({ messages: [] });
}

type Registry = Parameters<typeof selectWorkerModel>[2];
const astra = {
  id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai-codex",
  api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api",
  input: ["text", "image"],
} as Model;
const luna = { ...astra, id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const glm = { ...astra, id: "glm-5.3-flash", name: "GLM-5.3 Flash", provider: "zai", api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" } as Model;
// FINAL automatic worker chain fixtures: real verified endpoints only.
const chainModels = {
  goPrimary: { ...astra, id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "opencode-go", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1", input: ["text"] } as Model,
  goFallback: { ...astra, id: "glm-5.3-flash", name: "GLM 5.3 Flash", provider: "opencode-go", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1", input: ["text"] } as Model,
  mimoPro: { ...astra, id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", provider: "xiaomi", api: "openai-completions", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", input: ["text", "image"] } as Model,
  zaiGlm: { ...astra, id: "glm-5.3-flash", name: "GLM-5.3 Flash", provider: "zai", api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4", input: ["text", "image"] } as Model,
};

/** Chain registries resolve exact provider/id pairs, like the native registry. */
function chainRegistry(models: readonly Model[] = Object.values(chainModels) as Model[]): Registry {
  return {
    find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
    getAvailable: () => [...models],
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => true,
    getProvider: () => ({ streamSimple() {} }),
  } as unknown as Registry;
}

function fakeProvider(id = "openai-codex") {
  return {
    id, name: id, auth: {}, getModels: () => id === "zai" ? [glm] : [astra],
    stream: vi.fn(() => "stream"), streamSimple: vi.fn(() => "simple"),
    fetchDeferred: vi.fn(() => "deferred"), cancelDeferred: vi.fn(async () => {}),
  } as unknown as Provider;
}

function fakeRegistry() {
  const native = new Map<string, Provider>();
  const registry = {
    getAll: () => [astra, glm],
    getProvider: (id: string) => native.get(id) ?? fakeProvider(id),
    getRegisteredNativeProvider: (id: string) => native.get(id),
    registerProvider: vi.fn((provider: Provider) => native.set(provider.id, provider)),
    isUsingOAuth: vi.fn(() => true),
    hasConfiguredAuth: vi.fn((_model: Model) => true),
    getAvailable: vi.fn(() => [astra, glm]),
    find: vi.fn(() => luna),
  };
  return { registry: registry as unknown as Registry, native, methods: registry };
}

describe("GPT coding-plan route policy", () => {
  it.each(["gpt-6-astra", "gpt-5.6-luna", "gpt4", "chatgpt-4o-latest", "openai/gpt-6-astra", "GPT-7"])('denies GPT family %s outside Codex', (id) => {
    for (const provider of ["openrouter", "openai", "azure", "zai", "OPENAI-CODEX", "openai-codex "]) {
      expect(() => assertModelRoute({ id, provider })).toThrow(GPT_ROUTE_ERROR);
    }
  });
  it("detects friendly-name aliases and rejects batch or nested provider routes", () => {
    expect(() => assertModelRoute({ id: "alias", name: "GPT-6 Astra", provider: "openrouter" })).toThrow();
    for (const id of ["gpt-6-astra:batch", "gpt-6-astra-batch", "openrouter/openai/gpt-6-astra"]) {
      expect(() => assertModelRoute({ id, provider: "openai-codex" })).toThrow();
    }
  });
  it("allows non-GPT routes unchanged", () => {
    expect(() => assertSubscriptionRequest(glm, false)).not.toThrow();
    expect(() => assertModelRoute({ ...glm, provider: "openrouter" })).not.toThrow();
  });
  it("requires actual OAuth, Codex API, and official coding-plan endpoint", () => {
    expect(() => assertSubscriptionRequest(astra, true)).not.toThrow();
    expect(() => assertSubscriptionRequest(astra, false)).toThrow();
    expect(() => assertSubscriptionRequest({ ...astra, api: "openai-responses" }, true)).toThrow();
    for (const baseUrl of ["https://openrouter.ai/api/v1", "https://api.openai.com/v1", "https://chatgpt.com.evil.test/backend-api", "http://chatgpt.com/backend-api", "https://chatgpt.com/backend-api?proxy=1", "https://user@chatgpt.com/backend-api"]) {
      expect(() => assertSubscriptionRequest({ ...astra, baseUrl }, true)).toThrow();
    }
  });
  it("blocks every provider execution entry before any delegate is called", async () => {
    const provider = fakeProvider("openrouter");
    const guarded = guardProvider(provider, () => true);
    const blocked = { ...astra, provider: "openrouter" };
    expect(() => guarded.stream(blocked, emptyContext())).toThrow();
    expect(() => guarded.streamSimple(blocked, emptyContext())).toThrow();
    expect(() => guarded.fetchDeferred!(blocked, {} as never)).toThrow();
    await expect(guarded.cancelDeferred!(blocked, {} as never)).rejects.toThrow();
    for (const key of ["stream", "streamSimple", "fetchDeferred", "cancelDeferred"] as const) {
      expect(provider[key]).not.toHaveBeenCalled();
    }
  });
  it("preserves dispatch API coverage while hiding forbidden availability without removing GLM images", () => {
    const blocked = { ...astra, provider: "openrouter" };
    const batch = { ...astra, id: "gpt-6-astra:batch" };
    const imageGlm = { ...glm, input: ["text", "image"] } as Model;
    const models = [astra, blocked, batch, imageGlm];
    const filterModels = vi.fn((items: Model[]) => items);
    const guarded = guardProvider({ ...fakeProvider(), getModels: () => models, filterModels }, () => true);
    expect(guarded.getModels()).toEqual(models);
    expect(guarded.filterModels!(models, undefined)).toEqual([astra, imageGlm]);
    expect(filterModels).toHaveBeenCalledWith(models, undefined);
    expect(models).toHaveLength(4);
    expect(imageGlm.input).toContain("image");
  });

  it("keeps nonthrowing catalog decisions equivalent to dispatch route assertions", () => {
    const cases = [
      [astra, true], [glm, true], [{ ...glm, provider: "openrouter" }, true],
      [{ ...astra, id: "openai-codex/gpt-6-astra" }, true],
      [{ ...astra, provider: "openrouter" }, false],
      [{ ...astra, provider: "OPENAI-CODEX" }, false],
      [{ ...astra, id: "gpt-6-astra:batch" }, false],
      [{ ...astra, id: "openrouter/openai/gpt-6-astra" }, false],
      [{ ...astra, id: "alias", provider: "zai" }, false],
    ] as const;
    for (const [model, allowed] of cases) {
      expect(isModelRouteAllowed(model)).toBe(allowed);
      if (allowed) expect(() => assertModelRoute(model)).not.toThrow();
      else expect(() => assertModelRoute(model)).toThrow(GPT_ROUTE_ERROR);
    }
  });

  it("allocates no rejection exceptions while filtering a mixed catalog", () => {
    const models = Array.from({ length: 1024 }, (_, index) =>
      index % 2 ? { ...astra, provider: "openrouter" } : glm);
    const guarded = guardProvider({ ...fakeProvider(), getModels: () => models }, () => true);
    const { visible, filtered, errorCount } = (() => {
      const errors = vi.spyOn(globalThis, "Error");
      try {
        const visible = guarded.getModels();
        const filtered = guarded.filterModels!(models, undefined);
        return { visible, filtered, errorCount: errors.mock.calls.length };
      } finally {
        errors.mockRestore();
      }
    })();
    expect(errorCount).toBe(0);
    expect(visible).toHaveLength(1024);
    expect(filtered).toHaveLength(512);
    expect(filtered.every((model) => model === glm)).toBe(true);
  });

  it("checks OAuth at execution time and passes allowed requests through unchanged", async () => {
    const provider = fakeProvider();
    let oauth = true;
    const guarded = guardProvider(provider, () => oauth);
    const context = emptyContext();
    const options = { signal: new AbortController().signal };
    const events = guarded.streamSimple(astra, context, options);
    for await (const _event of events) { /* drain native gate */ }
    expect(provider.streamSimple).toHaveBeenCalledWith(astra, context, options);
    oauth = false;
    expect(() => guarded.streamSimple(astra, context, options)).toThrow();
    expect(provider.streamSimple).toHaveBeenCalledTimes(1);
  });
  it("installs once per provider and re-guards a replaced provider", () => {
    const { registry, native, methods } = fakeRegistry();
    const install = createRegistryGuard();
    install(registry); install(registry);
    createRegistryGuard()(registry); // A fresh extension factory after /reload.
    expect(methods.registerProvider).toHaveBeenCalledTimes(2);
    native.delete("openai-codex");
    install(registry);
    expect(methods.registerProvider).toHaveBeenCalledTimes(3);
  });
  it("guards every catalog provider even before its credentials resolve", () => {
    // 0.8.1 keeps guard-all: the guard also carries the curated picker filter and
    // the pre-output fallback metering check, and Pi resolves file-backed auth
    // after the first install, so a credentials-only filter would skip both.
    const { registry, native, methods } = fakeRegistry();
    const openrouterGpt = { ...astra, provider: "openrouter" } as Model;
    registry.getAll = () => [astra, glm, openrouterGpt];
    methods.hasConfiguredAuth.mockImplementation((model: Model) => model.provider === "zai");
    createRegistryGuard()(registry);
    expect([...native.keys()].sort()).toEqual(["openai-codex", "openrouter", "zai"]);
    expect(() => native.get("openrouter")!.streamSimple(openrouterGpt, emptyContext())).toThrow(GPT_ROUTE_ERROR);
    // The 0.7.0 `active` argument is accepted and changes nothing.
    createRegistryGuard()(registry, openrouterGpt);
    expect([...native.keys()].sort()).toEqual(["openai-codex", "openrouter", "zai"]);
  });
  it("re-guards a new configured API without stacking unchanged wrappers", () => {
    const { registry, native, methods } = fakeRegistry();
    const install = createRegistryGuard();
    install(registry);
    const overlay = { ...astra, api: "openai-completions" } as Model;
    const base = native.get("openai-codex")!;
    registry.getAll = () => [overlay, glm];
    registry.getProvider = (id) => id === "openai-codex"
      ? { ...base, getModels: () => [overlay] } : native.get(id);
    install(registry);
    expect(methods.registerProvider).toHaveBeenCalledTimes(4);
    expect(() => native.get("openai-codex")!.streamSimple(overlay, emptyContext())).toThrow(GPT_ROUTE_ERROR);
    install(registry);
    expect(methods.registerProvider).toHaveBeenCalledTimes(4);
  });

  it("reapplies worker runtime guards after an API refresh without stacking unchanged providers", () => {
    const { registry, native, methods } = fakeRegistry();
    const runtime = {
      getModels: () => registry.getAll(),
      getProvider: (id: string) => registry.getProvider(id),
      getRegisteredNativeProvider: (id: string) => registry.getRegisteredNativeProvider(id),
      registerNativeProvider: (provider: Provider) => registry.registerProvider(provider),
      isUsingOAuth: () => true,
    } as unknown as Parameters<typeof guardModelRuntime>[0];
    guardModelRuntime(runtime); guardModelRuntime(runtime);
    expect(methods.registerProvider).toHaveBeenCalledTimes(2);
    const overlay = { ...astra, api: "openai-completions" } as Model;
    const base = native.get("openai-codex")!;
    registry.getAll = () => [overlay, glm];
    registry.getProvider = (id) => id === "openai-codex"
      ? { ...base, getModels: () => [overlay] } : native.get(id);
    guardModelRuntime(runtime);
    expect(methods.registerProvider).toHaveBeenCalledTimes(4);
    expect(() => native.get("openai-codex")!.streamSimple(overlay, emptyContext())).toThrow(GPT_ROUTE_ERROR);
  });

  it("defaults Astra worker effort to medium without changing other models", () => {
    expect(selectWorkerThinking(astra, "high")).toBe("medium");
    expect(selectWorkerThinking({ id: "openai-codex/gpt-6-astra" }, "xhigh")).toBe("medium");
    expect(selectWorkerThinking(glm, "high")).toBe("high");
    expect(selectWorkerThinking(luna, "low")).toBe("low");
  });
  it.each(["high", "xhigh"] as const)("requires a concrete benefit before escalating Astra to %s", (level) => {
    expect(() => selectWorkerThinking(astra, "high", level)).toThrow(/concrete task benefit/);
    expect(selectWorkerThinking(astra, "medium", level, "Analyze concurrent credential rotation and crash recovery invariants.")).toBe(level);
  });

  it("routes routine GPT runs through the final text chain, retaining the parent for review", () => {
    const chain = chainRegistry();
    expect(selectWorkerModel(astra, ["scout", "worker"], chain)).toEqual(chainModels.mimoPro);
    expect(selectWorkerModel(astra, [undefined], chain)).toEqual(chainModels.mimoPro);
    // Reviewer role prefers the scarce Astra expert; with the expert route absent
    // from this registry, the legacy fallback still retains the parent exactly.
    expect(selectWorkerModel(astra, ["worker", "reviewer"], chain)).toBe(astra);
    // Unmapped non-GPT parents keep their own model; automatic routing never
    // substitutes a paid route for a parent the operator already selected.
    expect(selectWorkerModel(glm, ["worker"], chain)).toBe(glm);
  });
  it("prefers the scarce Astra expert for the default reviewer role, never a metered substitute", () => {
    // The expert review chains are pinned exactly: Astra first, then the routine
    // subscription order. Astra is deliberately absent from the routine chains.
    expect([...EXPERT_TEXT_REVIEW_CHAIN]).toEqual([
      { provider: "openai-codex", id: "gpt-6-astra" },
      { provider: "xiaomi", id: "mimo-v2.6-pro" }, { provider: "zai", id: "glm-5.3-flash" }]);
    expect(EXPERT_MULTIMODAL_REVIEW_CHAIN).toEqual(EXPERT_TEXT_REVIEW_CHAIN);
    expect(isExpertReviewModel(astra)).toBe(true);
    expect(isExpertReviewModel({ ...astra, id: "gpt-5.6-luna" })).toBe(false);
    expect(DEFAULT_TEXT_WORKER_CHAIN.some(isExpertReviewModel)).toBe(false);
    // Subscription-authenticated Astra serves the default reviewer role.
    const withAstra = chainRegistry([astra, chainModels.mimoPro, chainModels.zaiGlm]);
    expect(selectWorkerModel(chainModels.mimoPro, ["reviewer"], withAstra)).toBe(astra);
    expect(selectChainedWorkerModel(withAstra, EXPERT_TEXT_REVIEW_CHAIN)).toBe(astra);
    // An API-key/metered Astra-shaped route is never the expert: the chain skips
    // it and lands on the routine prepaid subscription order instead.
    const metered = { ...astra, baseUrl: "https://api.openai.com/v1" } as Model;
    expect(selectChainedWorkerModel(chainRegistry([metered, chainModels.mimoPro, chainModels.zaiGlm]), EXPERT_TEXT_REVIEW_CHAIN))
      .toBe(chainModels.mimoPro);
    expect(selectWorkerModel(chainModels.mimoPro, ["reviewer"], chainRegistry([metered, chainModels.mimoPro])))
      .toBe(chainModels.mimoPro);
    // Without Codex OAuth the exact subscription identity is unproven: no expert.
    const noOAuth = { ...chainRegistry([astra, chainModels.mimoPro]), isUsingOAuth: () => false } as unknown as Registry;
    expect(selectChainedWorkerModel(noOAuth, EXPERT_TEXT_REVIEW_CHAIN)).toBe(chainModels.mimoPro);
    // A localhost impostor cannot become the expert even when local routes are
    // normally allowed; a fake OAuth bit or a generous paid approval cannot help.
    const local = { ...astra, baseUrl: "http://localhost:8080/v1" } as Model;
    const locallyApproved = chainRegistry([local, chainModels.mimoPro]);
    expect(selectChainedWorkerModel(locallyApproved, EXPERT_TEXT_REVIEW_CHAIN,
      { approvePaidRoute: () => true })).toBe(chainModels.mimoPro);
    // Nothing eligible fails closed with the same contract as the routine chain.
    expect(() => selectChainedWorkerModel(chainRegistry([metered]), EXPERT_TEXT_REVIEW_CHAIN)).toThrow(/no fallback was selected/);
  });
  it("never auto-selects GPT-5.6 Luna and fails closed without an authenticated chain route", () => {
    const { registry } = fakeRegistry();
    expect(() => selectWorkerModel(astra, ["worker"], registry)).toThrow(/no fallback was selected/);
    for (const chain of [DEFAULT_TEXT_WORKER_CHAIN, DEFAULT_MULTIMODAL_WORKER_CHAIN]) {
      expect(chain.some((step) => step.id === ROUTINE_GPT_MODEL ||
        ["openai-codex", "opencode-go", "inco", "openrouter"].includes(step.provider))).toBe(false);
    }
  });

  it("resolves the final ordered text chain: MiMo Token Plan Pro, then ZAI coding GLM", () => {
    // The operator-final chain, pinned exactly: one unified text/image order.
    expect([...DEFAULT_TEXT_WORKER_CHAIN]).toEqual([
      { provider: "xiaomi", id: "mimo-v2.6-pro" }, { provider: "zai", id: "glm-5.3-flash" }]);
    expect(DEFAULT_MULTIMODAL_WORKER_CHAIN).toEqual(DEFAULT_TEXT_WORKER_CHAIN);
    // Both steps are actual subscription routes: selected with NO paid allowlist grant.
    expect(selectChainedWorkerModel(chainRegistry(), DEFAULT_TEXT_WORKER_CHAIN)).toBe(chainModels.mimoPro);
    expect(selectChainedWorkerModel(chainRegistry(), DEFAULT_TEXT_WORKER_CHAIN, { approvePaidRoute: () => false }))
      .toBe(chainModels.mimoPro);
    // MiMo unavailable: the ZAI coding subscription route serves the run.
    expect(selectChainedWorkerModel(chainRegistry([chainModels.zaiGlm]), DEFAULT_TEXT_WORKER_CHAIN))
      .toBe(chainModels.zaiGlm);
    // Go routes are no automatic chain step and never satisfy one, whatever the grant.
    expect(() => selectChainedWorkerModel(chainRegistry([chainModels.goPrimary, chainModels.goFallback]),
      DEFAULT_TEXT_WORKER_CHAIN, { approvePaidRoute: () => true })).toThrow(/no fallback was selected/);
  });
  it("requires the operator's authenticated available catalog to carry the route", () => {
    const catalog = (models: readonly Model[], available: readonly Model[] = models, authenticated: readonly Model[] = models) => ({
      find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => [...available],
      hasConfiguredAuth: (model: Model) => authenticated.includes(model),
      isUsingOAuth: () => true,
      getProvider: () => ({ streamSimple() {} }),
    } as unknown as Registry);
    const approve = () => true;
    // The reviewed Singapore Token Plan route is an actual subscription route:
    // authenticated, catalog-available and selected with NO paid grant (regression).
    expect(selectChainedWorkerModel(catalog([chainModels.mimoPro]), DEFAULT_TEXT_WORKER_CHAIN, { approvePaidRoute: () => false }))
      .toBe(chainModels.mimoPro);
    // Reviewed routes outside the subscription set still need the operator's exact grant.
    const inco = { id: "glm-5.3-flash:fast", name: "GLM 5.3 Flash (Inco)", provider: "inco", api: "openai-completions", baseUrl: "https://api.inco.ai/v1", input: ["text"] } as Model;
    const incoChain = [{ provider: "inco", id: "glm-5.3-flash:fast" }];
    expect(selectChainedWorkerModel(catalog([chainModels.mimoPro, inco]), incoChain, { approvePaidRoute: approve })).toBe(inco);
    expect(() => selectChainedWorkerModel(catalog([chainModels.mimoPro, inco]), incoChain, { approvePaidRoute: () => false }))
      .toThrow(/no fallback was selected/);
    // Absent from the operator's available catalog, or unauthenticated, both fail
    // closed regardless of grants; none of them may spend.
    expect(() => selectChainedWorkerModel(catalog([chainModels.mimoPro], []), DEFAULT_TEXT_WORKER_CHAIN, { approvePaidRoute: () => false }))
      .toThrow(/no fallback was selected/);
    expect(() => selectChainedWorkerModel(catalog([chainModels.mimoPro], undefined, []), DEFAULT_TEXT_WORKER_CHAIN, { approvePaidRoute: () => false }))
      .toThrow(/no fallback was selected/);
  });

  it("rejects lookalike, query, hash, port, credential, and non-plan MiMo endpoints at chain selection", () => {
    for (const baseUrl of [
      "https://token-plan-sgp.xiaomimimo.com.evil.test/v1",
      "https://token-plan-sgp.xiaomimimo.com.attacker.test/anthropic",
      "https://token-plan-sgp.xiaomimimo.com:8443/v1",
      "https://token-plan-sgp.xiaomimimo.com/v1?plan=sgp",
      "https://token-plan-sgp.xiaomimimo.com/v1#token",
      "https://user:secret@token-plan-sgp.xiaomimimo.com/v1",
      "http://token-plan-sgp.xiaomimimo.com/v1",
      "https://token-plan-sgp.xiaomimimo.com/v1/payg",
      "https://token-plan-sgp.xiaomimimo.com/payg",
      "https://token-plan-cn.xiaomimimo.com/v1",
      "https://api.xiaomimimo.com/v1",
    ]) {
      const model = { ...chainModels.mimoPro, baseUrl } as Model;
      // Never a subscription route, never a reviewed exact route, never auto-selected:
      // the chain must fail closed rather than spend on a different billing target.
      expect(() => selectChainedWorkerModel(chainRegistry([model]), DEFAULT_TEXT_WORKER_CHAIN, { approvePaidRoute: () => true }))
        .toThrow(/no fallback was selected/);
    }
  });

  it("resolves the multimodal chain and rejects unreviewed or unreachable endpoints", () => {
    const approve = () => true;
    expect(selectChainedWorkerModel(chainRegistry(), DEFAULT_MULTIMODAL_WORKER_CHAIN, { requireImages: true, approvePaidRoute: approve }))
      .toBe(chainModels.mimoPro);
    const withoutMimo = chainRegistry([chainModels.zaiGlm]);
    expect(selectChainedWorkerModel(withoutMimo, DEFAULT_MULTIMODAL_WORKER_CHAIN, { requireImages: true, approvePaidRoute: approve }))
      .toBe(chainModels.zaiGlm);
    // Same-named provider pointed at a different host is a different billing
    // target and never enters the default chain.
    const offPlan = { ...chainModels.mimoPro, baseUrl: "https://api.xiaomimimo.com/v1" } as Model;
    expect(() => selectChainedWorkerModel(chainRegistry([offPlan]), DEFAULT_TEXT_WORKER_CHAIN, { approvePaidRoute: approve }))
      .toThrow(/no fallback was selected/);
    // A non-subscription, unreviewed endpoint never substitutes for the coding-plan route.
    const offPlanGlm = { ...chainModels.zaiGlm, baseUrl: "https://metered.example/v1" } as Model;
    expect(() => selectChainedWorkerModel(chainRegistry([offPlanGlm]), DEFAULT_MULTIMODAL_WORKER_CHAIN, { requireImages: true, approvePaidRoute: approve }))
      .toThrow(/no fallback was selected/);
    // Text chain steps still require text capability, multimodal steps images.
    expect(() => selectChainedWorkerModel(chainRegistry([{ ...chainModels.goPrimary, input: ["image"] } as Model]), DEFAULT_TEXT_WORKER_CHAIN, { approvePaidRoute: approve }))
      .toThrow(/no fallback was selected/);
  });
});

/** Scripted per-model provider events, forwarded through the real pi-ai stream. */
type RouteEvent = Record<string, unknown>;
function routedMessage(model: Model, errorMessage?: string) {
  return {
    role: "assistant" as const, content: [], api: model.api, provider: model.provider, model: model.id, timestamp: 1,
    stopReason: errorMessage ? "error" as const : "stop" as const, ...(errorMessage ? { errorMessage } : {}),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
const routeStart = (model: Model): RouteEvent => ({ type: "start", partial: routedMessage(model) });
const routeText = (model: Model, delta = "served"): RouteEvent[] => [
  { type: "text_start", contentIndex: 0, partial: routedMessage(model) },
  { type: "text_delta", contentIndex: 0, delta, partial: routedMessage(model) },
];
const routeTool = (model: Model): RouteEvent => ({ type: "toolcall_start", contentIndex: 0, partial: routedMessage(model) });
const routeFail = (model: Model, errorMessage: string): RouteEvent => ({ type: "error", reason: "error", error: routedMessage(model, errorMessage) });
const routeDone = (model: Model): RouteEvent => ({ type: "done", reason: "stop", message: routedMessage(model) });

/** A registry whose providers are the guarded compositions the worker runtime
 * installs, so a hop re-enters the same gate/approval boundary as production. */
function chainRuntime(options: {
  models: readonly Model[];
  scripts: Record<string, (model: Model) => RouteEvent[]>;
  chain: readonly WorkerRouteStep[];
  approve?: (model: Model) => boolean;
}) {
  const native = new Map<string, Provider>();
  const calls = new Map<string, ReturnType<typeof vi.fn>>();
  const registry = {
    getAll: () => [...options.models],
    find: (provider: string, id: string) => options.models.find((model) => model.provider === provider && model.id === id),
    getAvailable: () => [...options.models],
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => true,
    getProvider: (id: string) => {
      const installed = native.get(id);
      if (installed) return installed;
      const models = options.models.filter((model) => model.provider === id);
      if (!models.length) return undefined;
      const streamSimple = vi.fn((model: Model) => {
        const stream = createAssistantMessageEventStream();
        for (const event of (options.scripts[id] ?? ((target: Model) => [routeStart(target), routeDone(target)]))(model)) {
          stream.push(event as never);
        }
        stream.end();
        return stream;
      });
      calls.set(id, streamSimple);
      return { id, name: id, getModels: () => [...models], stream: streamSimple, streamSimple } as unknown as Provider;
    },
    getRegisteredNativeProvider: (id: string) => native.get(id),
    registerProvider: (provider: Provider) => { native.set(provider.id, provider); },
  };
  const fallbacks: Array<{ from: WorkerRouteStep; to: Model }> = [];
  const installed = createRegistryGuard(options.approve ?? (() => false), {
    chain: options.chain,
    ...(options.chain === DEFAULT_MULTIMODAL_WORKER_CHAIN ? { requireImages: true } : {}),
    approvePaidRoute: options.approve ?? (() => false),
    registry: registry as never,
    onFallback: (from, to) => fallbacks.push({ from, to }),
  });
  installed(registry as never);
  return { registry, calls, fallbacks };
}

async function drain(stream: AsyncIterable<unknown>) {
  const events: Array<Record<string, any>> = [];
  for await (const event of stream) events.push(event as Record<string, any>);
  return events;
}

describe("pre-output custom-chain fallback (real provider streams)", () => {
  // Exercise the generic chain engine with a three-step test chain. This is
  // deliberately not the shipped MiMo -> ZAI default, tested separately below.
  const DEFAULT_TEXT_WORKER_CHAIN = [chainModels.goPrimary, chainModels.goFallback, chainModels.mimoPro]
    .map(({ provider, id }) => ({ provider, id }));
  const context = () => emptyContext();
  const session = (signal?: AbortSignal) => ({ sessionId: "chain-session", ...(signal ? { signal } : {}) });
  const goPrimary = chainModels.goPrimary;
  const goFallback = chainModels.goFallback;
  const mimoPro = chainModels.mimoPro;
  const offPlanMimo = { ...mimoPro, baseUrl: "https://api.xiaomimimo.com/v1" } as Model;
  const meteredGlm = { ...chainModels.zaiGlm, baseUrl: "https://metered.example/v1" } as Model;

  it("keeps a transient Go failure on Go's own same-plan retry and never spends elsewhere", async () => {
    const runtime = chainRuntime({
      models: [goPrimary, goFallback, mimoPro],
      scripts: {
        "opencode-go": (model) => model.id === goPrimary.id
          ? [routeStart(model), routeFail(model, "429 rate limit exceeded")]
          : [routeStart(model), ...routeText(model, "glm answered"), routeDone(model)],
      },
      chain: DEFAULT_TEXT_WORKER_CHAIN,
      approve: () => true,
    });
    const events = await drain(runtime.registry.getProvider("opencode-go")!.streamSimple(goPrimary, context(), session() as never));
    expect(runtime.calls.get("opencode-go")!.mock.calls.map((call) => call[0].id)).toEqual([goPrimary.id, goFallback.id]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const done = events.find((event) => event.type === "done");
    expect(done?.message).toMatchObject({ provider: "opencode-go", model: goFallback.id });
    expect(events.find((event) => event.type === "text_delta")?.partial)
      .toMatchObject({ provider: "opencode-go", model: goFallback.id });
    // The same-plan retry answered inside the Go wrapper: no cross-provider chain
    // hop was taken and no Token Plan spend was triggered.
    expect(runtime.fallbacks).toHaveLength(0);
    expect(runtime.calls.get("xiaomi")!.mock.calls).toHaveLength(0);
  });

  it("hops before output to the next route with real provenance when no same-plan route exists", async () => {
    const runtime = chainRuntime({
      models: [goPrimary, mimoPro],
      scripts: {
        "opencode-go": (model) => [routeStart(model), routeFail(model, "503 service unavailable")],
        xiaomi: (model) => [routeStart(model), ...routeText(model, "token plan answered"), routeDone(model)],
      },
      chain: DEFAULT_TEXT_WORKER_CHAIN,
      approve: () => true,
    });
    const events = await drain(runtime.registry.getProvider("opencode-go")!.streamSimple(goPrimary, context(), session() as never));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.find((event) => event.type === "done")?.message)
      .toMatchObject({ provider: "xiaomi", model: mimoPro.id });
    expect(events.find((event) => event.type === "text_delta")?.partial)
      .toMatchObject({ provider: "xiaomi", model: mimoPro.id });
    expect(runtime.fallbacks.map((hop) => `${hop.from.provider}/${hop.from.id}->${hop.to.provider}/${hop.to.id}`))
      .toEqual([`opencode-go/${goPrimary.id}->xiaomi/${mimoPro.id}`]);
  });

  it("leaves an exhausted Go plan for the approved Singapore Token Plan route", async () => {
    const runtime = chainRuntime({
      models: [goPrimary, goFallback, mimoPro],
      scripts: {
        "opencode-go": (model) => [routeStart(model), routeFail(model, "subscription_quota_exceeded")],
        xiaomi: (model) => [routeStart(model), ...routeText(model, "token plan answered"), routeDone(model)],
      },
      chain: DEFAULT_TEXT_WORKER_CHAIN,
      approve: () => true,
    });
    const events = await drain(runtime.registry.getProvider("opencode-go")!.streamSimple(goPrimary, context(), session() as never));
    expect(events.find((event) => event.type === "done")?.message)
      .toMatchObject({ provider: "xiaomi", model: mimoPro.id });
    expect(runtime.calls.get("xiaomi")!.mock.calls.map((call) => call[0].id)).toEqual([mimoPro.id]);
    expect(runtime.calls.get("opencode-go")!.mock.calls.map((call) => call[0].id)).toEqual([goPrimary.id, goFallback.id]);
    expect(runtime.fallbacks.map((hop) => `${hop.from.id}->${hop.to.provider}/${hop.to.id}`))
      .toEqual([`${goPrimary.id}->opencode-go/${goFallback.id}`, `${goFallback.id}->xiaomi/${mimoPro.id}`]);
  });

  it("reaches the Token Plan route directly when Go has no same-plan retry route left", async () => {
    const runtime = chainRuntime({
      models: [goPrimary, mimoPro],
      scripts: {
        "opencode-go": (model) => [routeStart(model), routeFail(model, "quota exhausted for this subscription plan")],
        xiaomi: (model) => [routeStart(model), routeDone(model)],
      },
      chain: DEFAULT_TEXT_WORKER_CHAIN,
      approve: () => true,
    });
    const events = await drain(runtime.registry.getProvider("opencode-go")!.streamSimple(goPrimary, context(), session() as never));
    expect(events.find((event) => event.type === "done")?.message).toMatchObject({ provider: "xiaomi", model: mimoPro.id });
    expect(runtime.fallbacks.map((hop) => hop.to.provider)).toEqual(["xiaomi"]);
  });

  it.each(["401 unauthorized", "403 permission denied", "region unsupported", "context length exceeded", "403 temporarily unavailable region"])(
    "never hops for %s", async (message) => {
      const runtime = chainRuntime({
        models: [goPrimary, goFallback, mimoPro],
        scripts: { "opencode-go": (model) => [routeStart(model), routeFail(model, message)] },
        chain: DEFAULT_TEXT_WORKER_CHAIN,
        approve: () => true,
      });
      const events = await drain(runtime.registry.getProvider("opencode-go")!.streamSimple(goPrimary, context(), session() as never));
      expect(runtime.calls.get("opencode-go")!.mock.calls).toHaveLength(1);
      expect(runtime.calls.get("xiaomi")!.mock.calls).toHaveLength(0);
      expect(events.at(-1)).toMatchObject({ type: "error", error: { provider: "opencode-go", model: goPrimary.id } });
    });

  it.each([
    ["text", 0],
    ["tool", 1],
  ])("stops permanently once %s output starts", async (kind, index) => {
    const runtime = chainRuntime({
      models: [goPrimary, goFallback, mimoPro],
      scripts: {
        "opencode-go": (model) => [routeStart(model), ...(index === 0 ? routeText(model) : [routeTool(model)]), routeFail(model, "503 service unavailable")],
      },
      chain: DEFAULT_TEXT_WORKER_CHAIN,
      approve: () => true,
    });
    const events = await drain(runtime.registry.getProvider("opencode-go")!.streamSimple(goPrimary, context(), session() as never));
    expect(runtime.calls.get("opencode-go")!.mock.calls).toHaveLength(1);
    expect(runtime.calls.get("xiaomi")!.mock.calls).toHaveLength(0);
    expect(events.at(-1)?.error).toMatchObject({ provider: "opencode-go", model: goPrimary.id });
    expect(runtime.fallbacks).toHaveLength(0);
  });

  it("never spends on an unapproved or off-plan metered route", async () => {
    for (const [models, approve, label, goCalls] of [
      [[goPrimary, goFallback, offPlanMimo], () => true, "off-plan Xiaomi endpoint", 2],
      [[goPrimary, meteredGlm], () => true, "generic metered PAYG", 1],
    ] as const) {
      const runtime = chainRuntime({
        models: models as readonly Model[],
        scripts: {
          "opencode-go": (model) => [routeStart(model), routeFail(model, "subscription_quota_exceeded")],
          xiaomi: (model) => [routeStart(model), routeDone(model)],
          zai: (model) => [routeStart(model), routeDone(model)],
        },
        chain: DEFAULT_TEXT_WORKER_CHAIN,
        approve,
      });
      const events = await drain(runtime.registry.getProvider("opencode-go")!.streamSimple(goPrimary, context(), session() as never));
      expect([label, runtime.calls.get("opencode-go")!.mock.calls.length]).toEqual([label, goCalls]);
      expect([label, runtime.calls.get("xiaomi")?.mock.calls.length ?? 0]).toEqual([label, 0]);
      expect([label, runtime.calls.get("zai")?.mock.calls.length ?? 0]).toEqual([label, 0]);
      expect(events.at(-1)?.type).toBe("error");
      expect(events.at(-1)?.error).toMatchObject({ provider: "opencode-go" });
    }
  });

  it("never hops an aborted request and never revisits a route", async () => {
    const controller = new AbortController();
    const runtime = chainRuntime({
      models: [goPrimary, goFallback, mimoPro],
      scripts: { "opencode-go": (model) => [routeStart(model), routeFail(model, "429 rate limit")] },
      chain: DEFAULT_TEXT_WORKER_CHAIN,
      approve: () => true,
    });
    controller.abort();
    await drain(runtime.registry.getProvider("opencode-go")!.streamSimple(goPrimary, context(), session(controller.signal) as never));
    expect(runtime.calls.get("opencode-go")!.mock.calls).toHaveLength(1);
    expect(runtime.fallbacks).toHaveLength(0);
  });

  it("classifies chain hops as the Go retry class plus proven plan exhaustion only", () => {
    for (const message of ["429 rate limit", "503 service unavailable", "temporarily overloaded", "subscription_quota_exceeded", "quota exhausted"]) {
      expect(eligibleChainFallback(message)).toBe(true);
    }
    for (const message of ["401 auth failed", "403 permission denied", "region unsupported", "context length exceeded", "400 invalid request", "cancelled", "unknown failure"]) {
      expect(eligibleChainFallback(message)).toBe(false);
    }
    // Same-plan Go retry still refuses the exhaustion signal; only the chain may leave.
    expect(eligibleGoFallback("subscription_quota_exceeded")).toBe(false);
    expect(eligibleChainFallback("subscription_quota_exceeded")).toBe(true);
  });
});

describe("shipped MiMo Token Plan -> ZAI subscription stream chain", () => {
  it("streams the prepaid primary without a paid-route grant", async () => {
    const runtime = chainRuntime({
      models: [chainModels.mimoPro, chainModels.zaiGlm],
      scripts: { xiaomi: model => [routeStart(model), ...routeText(model, "primary"), routeDone(model)] },
      chain: DEFAULT_TEXT_WORKER_CHAIN, approve: () => false,
    });
    const events = await drain(runtime.registry.getProvider("xiaomi")!.streamSimple(chainModels.mimoPro, emptyContext(), { sessionId: "prepaid" } as never));
    expect(events.at(-1)?.message).toMatchObject({ provider: "xiaomi", model: "mimo-v2.6-pro" });
    expect(runtime.fallbacks).toHaveLength(0);
    expect(runtime.calls.get("zai")!.mock.calls).toHaveLength(0);
  });

  it.each(["503 service unavailable", "subscription_quota_exceeded"])("falls back to ZAI before output on %s", async message => {
    const runtime = chainRuntime({
      models: [chainModels.mimoPro, chainModels.zaiGlm, chainModels.goPrimary],
      scripts: {
        xiaomi: model => [routeStart(model), routeFail(model, message)],
        zai: model => [routeStart(model), ...routeText(model, "subscription fallback"), routeDone(model)],
      },
      chain: DEFAULT_TEXT_WORKER_CHAIN, approve: () => false,
    });
    const events = await drain(runtime.registry.getProvider("xiaomi")!.streamSimple(chainModels.mimoPro, emptyContext(), { sessionId: "fallback" } as never));
    expect(events.at(-1)?.message).toMatchObject({ provider: "zai", model: "glm-5.3-flash" });
    expect(events.find(e => e.type === "text_delta")?.partial).toMatchObject({ provider: "zai", model: "glm-5.3-flash" });
    expect(runtime.fallbacks.map(h => `${h.from.provider}->${h.to.provider}`)).toEqual(["xiaomi->zai"]);
    expect(runtime.calls.get("opencode-go")!.mock.calls).toHaveLength(0);
  });
});

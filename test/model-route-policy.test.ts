import { describe, expect, it, vi } from "vitest";
import {
  assertModelRoute, assertSubscriptionRequest, guardProvider, selectWorkerModel,
  createRegistryGuard, GPT_ROUTE_ERROR, isModelRouteAllowed, guardModelRuntime,
} from "../src/model-route-policy.ts";

type Model = Parameters<typeof assertSubscriptionRequest>[0];
type Provider = Parameters<typeof guardProvider>[0];
type Registry = Parameters<typeof selectWorkerModel>[2];
const astra = {
  id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai-codex",
  api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api",
} as Model;
const luna = { ...astra, id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const glm = { ...astra, id: "glm-5.3-flash", name: "GLM-5.3 Flash", provider: "zai", api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" } as Model;

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
    hasConfiguredAuth: vi.fn(() => true),
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
    expect(() => guarded.stream(blocked, { messages: [] })).toThrow();
    expect(() => guarded.streamSimple(blocked, { messages: [] })).toThrow();
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

  it("checks OAuth at execution time and passes allowed requests through unchanged", () => {
    const provider = fakeProvider();
    let oauth = true;
    const guarded = guardProvider(provider, () => oauth);
    const context = { messages: [] };
    const options = { signal: new AbortController().signal };
    expect(guarded.streamSimple(astra, context, options)).toBe("simple");
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
    expect(methods.registerProvider).toHaveBeenCalledTimes(3);
    expect(() => native.get("openai-codex")!.streamSimple(overlay, { messages: [] })).toThrow(GPT_ROUTE_ERROR);
    install(registry);
    expect(methods.registerProvider).toHaveBeenCalledTimes(3);
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
    expect(methods.registerProvider).toHaveBeenCalledTimes(3);
    expect(() => native.get("openai-codex")!.streamSimple(overlay, { messages: [] })).toThrow(GPT_ROUTE_ERROR);
  });

  it("routes routine GPT runs to Luna, retaining frontier review and GLM", () => {
    const { registry } = fakeRegistry();
    expect(selectWorkerModel(astra, ["scout", "worker"], registry)).toEqual(luna);
    expect(selectWorkerModel(astra, [undefined], registry)).toEqual(luna);
    expect(selectWorkerModel(astra, ["worker", "reviewer"], registry)).toEqual(astra);
    expect(selectWorkerModel(glm, ["worker"], registry)).toBe(glm);
  });
  it("fails closed when Luna/auth is unavailable, with no fallback", () => {
    const { registry, methods } = fakeRegistry();
    methods.hasConfiguredAuth.mockReturnValue(false);
    expect(() => selectWorkerModel(astra, ["worker"], registry)).toThrow(/no fallback/);
    methods.isUsingOAuth.mockReturnValue(false);
    expect(() => selectWorkerModel(astra, ["reviewer"], registry)).toThrow();
  });
});

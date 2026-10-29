import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { TERRA_MODEL, terraStartupProvider, withTerraCatalog, registerTerraRuntime } from "../src/codex-models.ts";
import modelRoutePolicy from "../extensions/model-route-policy.ts";
import { assertSubscriptionRequest, DEFAULT_TEXT_WORKER_CHAIN } from "../src/model-route-policy.ts";
import { BUILTIN_WORKER_PROFILES, resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import { SOL_MODEL_ROUTE, SOL_PROFILE, RetiredModelSelectionError } from "../src/retired-model-selection.ts";
import { recordReviewFallback } from "../src/subagents/reviewer-fallback.ts";
import { quotaProviderOf } from "../src/subagents/provider-quota.ts";
import { validateTemporaryWorkerRoute } from "../src/temporary-free-route.ts";

const sol = { ...TERRA_MODEL, id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
const go = { ...sol, provider: "opencode-go", id: "deepseek-v4.1-flash", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1" } as typeof sol;
const models = [sol, TERRA_MODEL, go];
const registry = {
  find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
  getAll: () => models, getAvailable: () => models, hasConfiguredAuth: () => true,
  isUsingOAuth: (model: typeof sol) => model.provider === "openai-codex", getProvider: () => ({ streamSimple() {} }),
};
function select(selector = {}, role: "worker" | "scout" = "worker") {
  return resolveWorkerSelection(sol, "high", { ...selector, tasks: [{ label: "synthetic", task: "Inspect", role }] }, registry as never, BUILTIN_WORKER_PROFILES, "", {}, {});
}
describe("synthetic: Terra defaults and compatibility", () => {
  it.each(["worker", "scout"] as const)("selects Terra for implicit %s waves with an auditable ordered chain", role => {
    const selected = select({}, role);
    expect(selected.model).toBe(TERRA_MODEL);
    expect(selected.selection).toMatchObject({ provider: "openai-codex", modelId: "gpt-6.1-terra", source: "chain",
      chainRoutes: ["openai-codex/gpt-6.1-terra", "opencode-go/deepseek-v4.1-flash"] });
    expect(DEFAULT_TEXT_WORKER_CHAIN[0].id).toBe("gpt-6.1-terra");
  });
  it.each([{ model: SOL_MODEL_ROUTE }, { profile: SOL_PROFILE }, { profile: "gpt-6-1-sol" }])("honors explicit Sol %j", selector => {
    expect(select(selector).model).toBe(sol);
    expect(select(selector).selection.source).toBe("override");
    expect(select(selector).selection.chainRoutes).toBeUndefined();
  });
  it("declares the exact high-effort Terra profile and role metadata", () => {
    expect(BUILTIN_WORKER_PROFILES.find(profile => profile.id === "steak-pi/gpt-6-1-terra")).toMatchObject({
      model: "openai-codex/gpt-6.1-terra", thinking: "high", workerDefault: { profile: "steak-pi/gpt-6-1-terra" }, reviewerDefault: { profile: "steak-pi/gpt-6-1-terra" },
    });
  });
  it("keeps the named 6.0 retirement error and never remaps it", () => {
    for (const model of ["openai-codex/gpt-6-sol", "openai-codex/gpt-6.0-sol"]) expect(() => select({ model })).toThrow(RetiredModelSelectionError);
  });
  it("records actual Terra review fallback, not fabricated Claude approval, and gates both GPT identities on Codex quota", () => {
    const task = {} as Parameters<typeof recordReviewFallback>[0];
    recordReviewFallback(task, "quota");
    expect(task.reviewFallback).toMatchObject({ to: "openai-codex/gpt-6.1-terra", reason: "quota" });
    expect(task.lastStep).toBe("model-fallback:openai-codex/gpt-6.1-terra");
    for (const model of [TERRA_MODEL, sol]) expect(quotaProviderOf({ provider: model.provider, id: model.id })).toBe("codex");
  });
  it.each([
    [TERRA_MODEL, false], [{ ...TERRA_MODEL, provider: "openrouter" }, true],
    [{ ...TERRA_MODEL, baseUrl: "https://api.openai.com/v1" }, true], [{ ...TERRA_MODEL, api: "openai-responses" }, true],
  ] as const)("refuses non-Codex-OAuth Terra routes", (model, oauth) => {
    expect(() => assertSubscriptionRequest(model as typeof TERRA_MODEL, oauth)).toThrow();
  });
  it("accepts Terra normal-return metadata while preserving explicit legacy Sol", () => {
    const config = { schemaVersion: 1, provider: "openrouter", model: "minimax/minimax-m3.1-flash:free", harness: "steak-pi", profile: "preferred-free",
      startsAt: "2026-10-28T00:00:00Z", expiresAt: "2026-10-29T00:00:00Z", fallbackHarness: "steak-pi", fallbackProfile: "gpt-6-1-terra", zeroPriceOnly: true, source: "synthetic", evidence: "synthetic" };
    expect(validateTemporaryWorkerRoute(config).fallbackProfile).toBe("gpt-6-1-terra");
    expect(validateTemporaryWorkerRoute({ ...config, fallbackProfile: "gpt-6-1-sol" }).fallbackProfile).toBe("gpt-6-1-sol");
  });
});
describe("synthetic: native Terra catalog", () => {
  it("resolves Terra through the actual isolated SDK catalog without a custom-model fallback", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
      credentials: { read: async () => undefined, list: async () => [],
        modify: async () => { throw new Error("Synthetic credentials are read-only"); },
        delete: async () => { throw new Error("Synthetic credentials are read-only"); } } });
    registerTerraRuntime(runtime);
    expect(runtime.getModel("openai-codex", "gpt-6.1-terra")).toMatchObject(TERRA_MODEL);
    expect(runtime.getModels().some(model => model.provider === "openai-codex" && model.id === "gpt-6.1-terra")).toBe(true);
    expect(runtime.isUsingOAuth("openai-codex")).toBe(false); // registration never fabricates auth
  });
  it("registers Terra before CLI model lookup with native transport and OAuth intact", () => {
    const registered: ReturnType<typeof terraStartupProvider>[] = [];
    modelRoutePolicy({ registerProvider: (provider: ReturnType<typeof terraStartupProvider>) => registered.push(provider), registerFlag() {}, on() {} } as never);
    const codex = registered.find(provider => provider.id === "openai-codex")!;
    expect(codex.getModels().find(model => model.id === "gpt-6.1-terra")).toEqual(TERRA_MODEL);
    expect(codex.auth?.oauth).toBeDefined();
    expect(codex.streamSimple).toBeTypeOf("function");
  });
  it("preserves explicit Sol, native metadata, all-model catalogs and idempotence", () => {
    const provider = { id: "openai-codex", auth: { marker: true }, getModels: () => [sol], getAllModels: () => [sol], streamSimple: vi.fn() } as never;
    const augmented = withTerraCatalog(provider);
    expect(augmented.getModels()).toEqual([sol, TERRA_MODEL]);
    expect(augmented.getAllModels!()).toEqual([sol, TERRA_MODEL]);
    expect(augmented.auth).toBe((provider as typeof augmented).auth);
    expect(augmented.streamSimple).toBe((provider as typeof augmented).streamSimple);
    expect(withTerraCatalog(augmented)).toBe(augmented);
    const nativeTerra = { ...TERRA_MODEL, contextWindow: 2_000_000 };
    expect(withTerraCatalog({ ...augmented, getModels: () => [nativeTerra] }).getModels()).toEqual([nativeTerra]);
  });
  it("registers Terra in isolated runtimes without touching another provider", () => {
    const provider = { id: "openai-codex", getModels: () => [sol] } as never;
    const registerNativeProvider = vi.fn();
    registerTerraRuntime({ getProvider: () => provider, registerNativeProvider } as never);
    expect(registerNativeProvider.mock.calls[0][0].getModels()).toContainEqual(TERRA_MODEL);
    const other = { id: "openrouter", getModels: () => [sol] } as never;
    expect(withTerraCatalog(other)).toBe(other);
  });
});

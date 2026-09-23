import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKER_PROFILES, loadWorkerProfiles, resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import { DEFAULT_TEXT_WORKER_CHAIN, type ChainOptions } from "../src/model-route-policy.ts";
import type { DispatchInput } from "../src/subagents/types.ts";

type Model = Parameters<typeof resolveWorkerSelection>[0];
const astra = { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] } as Model;
const luna = { ...astra, id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const glm = { ...astra, id: "glm-5.3-flash", name: "GLM-5.3 Flash", provider: "zai", api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" } as Model;
const go = { ...glm, id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "opencode-go", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1", input: ["text"] } as Model;
const goFallback = { ...go, id: "glm-5.3-flash", name: "GLM 5.3 Flash" } as Model;
const mimoPro = { ...go, id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", provider: "xiaomi", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", input: ["text", "image"] } as Model;
const other = { ...glm, id: "custom-vision", name: "Custom vision", provider: "custom" };
function registry(models = [astra, luna, glm, go, mimoPro, other]) {
  return {
    find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
    getAvailable: vi.fn(() => models),
    hasConfiguredAuth: vi.fn((_model: Model) => true),
    isUsingOAuth: vi.fn((model: Model) => model.provider === "openai-codex"),
    getProvider: vi.fn(() => ({ streamSimple() {} })),
  };
}
const input = (extra: Partial<DispatchInput> = {}): DispatchInput => ({ goal: "test", tasks: [{ label: "leaf", task: "test" }], ...extra });
function choose(parent: Model, extra: Partial<DispatchInput> = {}, r = registry(), profiles = BUILTIN_WORKER_PROFILES, options: ChainOptions = {}) {
  return resolveWorkerSelection(parent, "high", input(extra), r as never, profiles, "", options);
}

describe("USAP 1.1 explicit model/profile contract", () => {
  it("ignores hidden migration backups and staging files", () => {
    const dir = mkdtempSync(join(tmpdir(), "usap-hidden-catalog-"));
    try {
      const manifest = JSON.stringify({ id: "custom", profiles: [{ id: "worker", name: "Worker", args: ["--model", "xiaomi/mimo-v2.6-pro"] }] });
      writeFileSync(join(dir, "custom.json"), manifest);
      writeFileSync(join(dir, ".custom.before-ultraterm-test.json"), manifest);
      writeFileSync(join(dir, ".custom.staging.json"), "incomplete JSON");
      expect(loadWorkerProfiles(dir).filter(profile => profile.id === "custom/worker")).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("skips a foreign CLI harness's own model names instead of failing every dispatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "usap-foreign-catalog-"));
    try {
      writeFileSync(join(dir, "claude-code.json"), JSON.stringify({ id: "claude-code", executable: "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", profiles: [
        { id: "opus-5-5", args: ["--model", "claude-opus-5-5"] }, { id: "fable-5-1", args: ["--model", "claude-fable-5-1"] },
      ] }));
      writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ id: "steak-pi", profiles: [{ id: "custom", args: ["--model", "custom/custom-vision"] }] }));
      const profiles = loadWorkerProfiles(dir);
      expect(profiles.some(profile => profile.id.startsWith("claude-code/"))).toBe(false);
      expect(profiles.some(profile => profile.id === "steak-pi/custom")).toBe(true);
      writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ id: "steak-pi", profiles: [{ id: "broken", args: ["--model", "no-provider"] }] }));
      expect(() => loadWorkerProfiles(dir)).toThrow(/steak-pi\/broken needs a provider\/model route/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(["steak-pi/glm-5-3-flash", "glm-5-3-flash"])("selects Astra→GLM profile %s with truthful receipt", (profile) => {
    const result = choose(astra, { profile, requireImages: true });
    expect(result.model).toBe(glm);
    expect(result.selection).toEqual({ harness: "pi", provider: "zai", modelId: "glm-5.3-flash", profile: "steak-pi/glm-5-3-flash", parentProfile: "steak-pi/gpt-6-astra", source: "override", tools: true, images: true });
  });
  it("selects any authorized native provider without a hard-coded model allowlist", () => {
    expect(choose(astra, { model: "custom/custom-vision" }).model).toBe(other);
  });
  it("keeps every automatic native-Pi role on the routine MiMo→ZAI chain", () => {
    // Routine workers and reviewer-role runs share one automatic subscription
    // chain; the reviewer role alone never prefers another expert silently.
    const worker = choose(other, { tasks: [{ label: "leaf", task: "test", role: "worker" }] });
    expect(worker.model).toBe(mimoPro);
    expect(worker.selection).toMatchObject({ source: "chain", chainRoutes: ["xiaomi/mimo-v2.6-pro", "zai/glm-5.3-flash"] });
    const reviewer = choose(other, { tasks: [{ label: "leaf", task: "test", role: "reviewer" }] });
    expect(reviewer.model).toBe(mimoPro);
    expect(reviewer.selection).toMatchObject({ source: "chain",
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "zai/glm-5.3-flash"] });
  });
  it("selects GLM→paid Codex and retains Astra medium", () => {
    const result = choose(glm, { model: "openai-codex/gpt-6-astra" });
    expect(result.model).toBe(astra); expect(result.thinkingLevel).toBe("medium");
  });
  it("never overrides an explicit reviewer model with role/default policy", () => {
    expect(choose(astra, { profile: "steak-pi/glm-5-3-flash", tasks: [{ label: "review", task: "review", role: "reviewer" }] }).model).toBe(glm);
  });
  it("preserves omitted default routes and configured per-profile overrides", () => {
    expect(choose(astra).model).toBe(mimoPro);
    expect(choose(astra).selection.source).toBe("chain");
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }).model).toBe(mimoPro);
    expect(choose(glm).model).toBe(mimoPro);
    const profiles = [{ id: "steak-pi/gpt-6-astra", model: "openai-codex/gpt-6-astra", workerDefault: { profile: "steak-pi/glm-5-3-flash" } }, BUILTIN_WORKER_PROFILES[0]];
    expect(choose(astra, {}, registry(), profiles).model).toBe(glm);
  });
  it("routes automatic defaults through the final MiMo→ZAI chain with chain provenance", () => {
    // No Luna, ever: the automatic default never resolves a GPT-family worker.
    const result = choose(astra);
    expect(result.model).toBe(mimoPro);
    expect(result.selection).toMatchObject({ provider: "xiaomi", modelId: "mimo-v2.6-pro", source: "chain",
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "zai/glm-5.3-flash"] });
    // MiMo unavailable: the ZAI coding subscription route is the only automatic fallback.
    expect(choose(astra, {}, registry([glm])).model).toBe(glm);
    // Subscription-first regression: the reviewed Token Plan step is selected with
    // no paid allowlist grant at all (revoked or absent), never spend-gated.
    const tokenPlan = registry([astra, glm, mimoPro]);
    expect(choose(astra, {}, tokenPlan, BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => false }).model).toBe(mimoPro);
    // A non-plan Xiaomi endpoint (general PAYG) is a different billing target: the
    // chain skips it rather than approving it in, and falls through to ZAI.
    expect(choose(astra, {}, registry([{ ...mimoPro, baseUrl: "https://api.xiaomimimo.com/v1" } as Model, glm])).model).toBe(glm);
    // Unmapped parents use the same chain through the legacy default path.
    expect(choose(astra, {}, tokenPlan, [], { approvePaidRoute: () => false }).model).toBe(mimoPro);
    // Go routes are no automatic chain step: with neither subscription step present, fail closed.
    expect(() => choose(astra, {}, registry([go]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => true })).toThrow(/no fallback was selected/);
  });
  it("keeps automatic native-Pi reviewer defaults on the routine chain, never another expert", () => {
    const review = choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] });
    // Even with authenticated Astra present, the automatic reviewer default is
    // the same prepaid MiMo→ZAI chain workers use; no expert is auto-selected.
    expect(review.model).toBe(mimoPro);
    expect(review.selection).toMatchObject({ source: "chain", provider: "xiaomi", modelId: "mimo-v2.6-pro",
      parentProfile: "steak-pi/gpt-6-astra", profile: "steak-pi/mimo-v2-6-pro",
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "zai/glm-5.3-flash"] });
    // Astra absent or metered makes no difference: the routine chain is the
    // whole automatic reviewer chain, with no expert step before it.
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, registry([glm, mimoPro])).model).toBe(mimoPro);
    const metered = registry([{ ...astra, baseUrl: "https://api.openai.com/v1" } as Model, glm, mimoPro]);
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, metered).model).toBe(mimoPro);
    // requireImages keeps the same automatic chain capability-matching end to end.
    const visual = choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }], requireImages: true });
    expect(visual.model).toBe(mimoPro);
    // An explicit reviewer choice still wins exactly, with override provenance.
    const explicit = choose(astra, { model: "zai/glm-5.3-flash", tasks: [{ label: "r", task: "review", role: "reviewer" }] });
    expect(explicit.selection).toMatchObject({ source: "override", provider: "zai", modelId: "glm-5.3-flash" });
    expect(explicit.selection.chainRoutes).toBeUndefined();
  });
  it("resolves a reviewerDefault naming the Astra profile through the routine chain, not an exact expert freeze", () => {
    const profiles = BUILTIN_WORKER_PROFILES.map(p => p.id === "steak-pi/glm-5-3-flash"
      ? { ...p, reviewerDefault: { profile: "steak-pi/gpt-6-astra" } }
      : p);
    const request = { tasks: [{ label: "r", task: "review", role: "reviewer" as const }] };
    const selected = choose(glm, request, registry(), profiles);
    // The legacy native-Pi reviewer-chain label keeps the default automatic —
    // on the subscription chain — instead of freezing the Astra expert model.
    expect(selected.model).toBe(mimoPro);
    expect(selected.selection).toMatchObject({ source: "chain", profile: "steak-pi/gpt-6-astra",
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "zai/glm-5.3-flash"] });
    expect(choose(glm, request, registry([glm, mimoPro]), profiles).model).toBe(mimoPro);
    expect(choose(glm, { ...request, profile: "steak-pi/gpt-6-astra" }, registry(), profiles).selection.source).toBe("override");
  });
  it("skips text-only chain heads for image requests rather than rejecting a capable fallback", () => {
    const textOnlyAstra = { ...astra, input: ["text"] } as Model;
    const textOnlyMimo = { ...mimoPro, input: ["text"] } as Model;
    const reviewer = choose(glm, { requireImages: true, tasks: [{ label: "r", task: "inspect image", role: "reviewer" }] },
      registry([textOnlyAstra, mimoPro, glm]));
    expect(reviewer.model).toBe(mimoPro);
    const worker = choose(glm, { requireImages: true }, registry([textOnlyMimo, glm]));
    expect(worker.model).toBe(glm);
  });
  it("keeps an explicit chain-step model exact: no cross-provider chain provenance", () => {
    const result = choose(astra, { model: "opencode-go/deepseek-v4.1-flash" });
    expect(result.model).toBe(go);
    expect(result.selection).toMatchObject({ source: "override", provider: "opencode-go", modelId: "deepseek-v4.1-flash" });
    expect(result.selection.chainRoutes).toBeUndefined();
  });
  it("keeps parent-added GPT-6 Sol/Luna profiles explicit-only", () => {
    const sol = { ...astra, id: "gpt-6-sol", name: "GPT-6 Sol" } as Model;
    const added = BUILTIN_WORKER_PROFILES.filter((profile) => ["steak-pi/gpt-6-sol", "steak-pi/gpt-6-luna"].includes(profile.id));
    expect(added.map((profile) => profile.id)).toEqual(["steak-pi/gpt-6-sol", "steak-pi/gpt-6-luna"]);
    for (const profile of added) {
      // Never an automatic worker default: routine workers stay on the chain.
      expect(profile.workerDefault).toEqual({ profile: "steak-pi/mimo-v2-6-pro" });
      expect(DEFAULT_TEXT_WORKER_CHAIN.some((step) => step.id === profile.model.split("/")[1])).toBe(false);
    }
    // Explicit selection is exact, with the profile's high thinking preference.
    const explicit = choose(astra, { profile: "steak-pi/gpt-6-sol" }, registry([astra, sol, glm, mimoPro]));
    expect(explicit.model).toBe(sol);
    expect(explicit.selection).toMatchObject({ source: "override", provider: "openai-codex", modelId: "gpt-6-sol", profile: "steak-pi/gpt-6-sol" });
    expect(explicit.thinkingLevel).toBe("high");
    // A Sol parent keeps workers and reviewers on the routine chain — Sol and
    // Astra are never automatic defaults in any role.
    const solParent = choose(sol, {}, registry([astra, sol, glm, mimoPro]));
    expect(solParent.model).toBe(mimoPro);
    expect(solParent.selection).toMatchObject({ source: "chain", parentProfile: "steak-pi/gpt-6-sol" });
    const solReview = choose(sol, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, registry([astra, sol, glm, mimoPro]));
    expect(solReview.model).toBe(mimoPro);
  });
  it("requires the authenticated available catalog before operator selection includes a route", () => {
    const approved = { approvePaidRoute: () => true };
    // Approved Token Plan route, absent from the authenticated available catalog.
    const hidden = registry([astra, mimoPro]);
    hidden.getAvailable.mockReturnValue([astra]);
    expect(() => choose(astra, {}, hidden, BUILTIN_WORKER_PROFILES, approved)).toThrow(/no fallback was selected/);
    const unauthenticated = registry([astra, mimoPro]);
    unauthenticated.hasConfiguredAuth.mockImplementation((model: Model) => model.provider !== "xiaomi");
    expect(() => choose(astra, {}, unauthenticated, BUILTIN_WORKER_PROFILES, approved)).toThrow(/no fallback was selected/);
    // Authenticated and available subscription route: selected with NO paid grant.
    expect(choose(astra, {}, registry([astra, mimoPro]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => false }).selection)
      .toMatchObject({ source: "chain", provider: "xiaomi", modelId: "mimo-v2.6-pro" });
    // A present/absent grant is equally irrelevant: the Token Plan step is prepaid.
    expect(choose(astra, {}, registry([astra, mimoPro]), BUILTIN_WORKER_PROFILES, approved).selection)
      .toMatchObject({ source: "chain", provider: "xiaomi", modelId: "mimo-v2.6-pro" });
  });
  it("routes automatic multimodal defaults through MiMo Pro, then ZAI coding GLM", () => {
    const tokenPlan = registry([astra, glm, mimoPro]);
    expect(choose(astra, { requireImages: true }, tokenPlan, BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => true }).model).toBe(mimoPro);
    expect(choose(astra, { requireImages: true }, registry([astra, glm]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => false }).model).toBe(glm);
    expect(() => choose(astra, { requireImages: true }, registry([astra, go]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => true }))
      .toThrow(/no fallback was selected/);
  });
  it("keeps an explicit chain-profile selection exact instead of silently chaining", () => {
    expect(() => choose(astra, { profile: "steak-pi/opencode-go" }, registry([astra, glm, mimoPro]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => true }))
      .toThrow(/unavailable/);
  });
  it("binds defaults to UltraTerm's actual harness identity when profile IDs overlap", () => {
    vi.stubEnv("ULTRATERM_HARNESS_ID", "custom-host");
    try {
      const profiles = [...BUILTIN_WORKER_PROFILES, { id: "custom-host/gpt-6-astra", model: "openai-codex/gpt-6-astra", workerDefault: { model: "zai/glm-5.3-flash" } }];
      const result = resolveWorkerSelection(astra, "medium", input(), registry() as never, profiles, "gpt-6-astra");
      expect(result.model).toBe(glm);
      expect(result.selection.parentProfile).toBe("custom-host/gpt-6-astra");
    } finally { vi.unstubAllEnvs(); }
  });
  it("does not inherit a stale launch profile after /model changes", () => {
    const r = registry();
    const result = resolveWorkerSelection(glm, "high", input(), r as never, BUILTIN_WORKER_PROFILES, "gpt-6-astra");
    expect(result.model).toBe(mimoPro);
  });
  it.each([
    { model: "zai/glm-5.3-flash", profile: "steak-pi/glm-5-3-flash" },
    { model: "glm-5.3-flash" }, { model: "zai/missing" }, { profile: "missing" },
    { model: "" }, { profile: " " },
  ])("fails closed for invalid/conflicting/unavailable selectors %j", (extra) => {
    expect(() => choose(astra, extra)).toThrow();
  });
  it("requires configured auth AND authenticated availability", () => {
    const r = registry(); r.hasConfiguredAuth.mockReturnValue(false);
    expect(() => choose(astra, { model: "zai/glm-5.3-flash" }, r)).toThrow(/authentication/);
    r.hasConfiguredAuth.mockReturnValue(true); r.getAvailable.mockReturnValue([astra]);
    expect(() => choose(astra, { model: "zai/glm-5.3-flash" }, r)).toThrow(/authentication/);
  });
  it.each(["openrouter", "openai", "azure"])('rejects explicit GPT on %s', (provider) => {
    const model = { ...astra, provider };
    expect(() => choose(glm, { model: `${provider}/${model.id}` }, registry([model]))).toThrow(/paid/);
  });
  it("rejects batch, API-key Codex, and forged Codex endpoints", () => {
    const batch = { ...astra, id: "gpt-6-astra-batch" };
    expect(() => choose(glm, { model: `openai-codex/${batch.id}` }, registry([batch]))).toThrow(/paid/);
    const r = registry(); r.isUsingOAuth.mockReturnValue(false);
    expect(() => choose(glm, { model: "openai-codex/gpt-6-astra" }, r)).toThrow(/paid/);
    expect(() => choose(glm, { model: "openai-codex/gpt-6-astra" }, registry([{ ...astra, baseUrl: "https://example.test" }]))).toThrow(/paid/);
  });
  it("checks image input and native tool-adapter availability before dispatch", () => {
    const text = { ...glm, input: ["text"] } as Model;
    expect(() => choose(astra, { model: "zai/glm-5.3-flash", requireImages: true }, registry([text]))).toThrow(/image input/);
    const r = registry(); r.getProvider.mockReturnValue({} as never);
    expect(() => choose(astra, { model: "zai/glm-5.3-flash" }, r)).toThrow(/tool streaming adapter/);
  });
  it("loads only route/default metadata from existing native profile catalogs", () => {
    const dir = mkdtempSync(join(tmpdir(), "usap-profiles-"));
    try {
      writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ id: "steak-pi", executable: "never-execute", profiles: [
        { id: "gpt-6-astra", args: ["--model", "openai-codex/gpt-6-astra", "--thinking", "medium"], workerDefault: { profile: "steak-pi/glm-5-3-flash" } },
        { id: "custom", args: ["--model", "custom/custom-vision"] },
      ] }));
      const profiles = loadWorkerProfiles(dir);
      expect(choose(astra, {}, registry(), profiles).model).toBe(glm);
      expect(choose(astra, { profile: "steak-pi/custom" }, registry(), profiles).model).toBe(other);
      writeFileSync(join(dir, "bad.json"), "not json");
      expect(() => loadWorkerProfiles(dir)).toThrow(/parse harness metadata/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

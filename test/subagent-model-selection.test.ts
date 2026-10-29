import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKER_PROFILES, CLAUDE_CODE_HAIKU_ROUTE, CLAUDE_CODE_OPUS_ROUTE, CLAUDE_CODE_ROUTES, CLAUDE_CODE_SONNET_ROUTE, assertClaudeCodeImageAdmission, claudeCodeModelName, claudeCodeModelOf, claudeFallbackTier, loadWorkerProfiles, loadRoleDefaults,
  resolveClaudeCodeSelection, resolveWorkerSelection, RETIRED_ROUTE, retiredRouteError } from "../src/subagents/model-selection.ts";
import { DEFAULT_TEXT_WORKER_CHAIN, NoChainRouteError, type ChainOptions } from "../src/model-route-policy.ts";
import type { DispatchInput, SubagentTaskInput } from "../src/subagents/types.ts";

type Model = Parameters<typeof resolveWorkerSelection>[0];
const astra = { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] } as Model;
const luna = { ...astra, id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const sol = { ...astra, id: "gpt-6.1-terra", name: "GPT-6.1 Terra", input: ["text"] } as Model;
const go = { ...sol, id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", provider: "opencode-go", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1", input: ["text"] } as Model;
const mimoPro = { ...go, id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", provider: "xiaomi", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", input: ["text", "image"] } as Model;
const mimoFlash = { ...mimoPro, id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash" } as Model;
const other = { ...mimoPro, id: "custom-vision", name: "Custom vision", provider: "custom" };
function registry(models = [astra, luna, sol, go, mimoPro, mimoFlash, other]) {
  return {
    find: vi.fn((provider: string, id: string) => models.find(m => m.provider === provider && m.id === id)),
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

describe("synthetic: USAP 1.1 explicit model/profile contract", () => {
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
  it.each([
    { model: "zai/glm-5.3" }, { model: "zai/glm-5.3-flash" },
    { model: "zai/custom" }, { model: "z-ai/custom" },
    { model: "glm-5.3" }, { model: "glm-5.3-flash" },
    { model: "opencode-go/glm-5.3-flash" }, { model: "inco/glm-5.3-flash:fast" },
    { profile: "steak-pi/glm-5-3-flash" }, { profile: "glm-5-3-flash" },
  ])("refuses retired selectors before registry lookup: %j", (extra) => {
    const route = extra.model ?? extra.profile!;
    const r = registry([]);
    expect(RETIRED_ROUTE.test(route)).toBe(true);
    expect(() => choose(astra, extra, r)).toThrow(retiredRouteError(route));
    expect(r.find).not.toHaveBeenCalled();
    expect(r.getAvailable).not.toHaveBeenCalled();
  });
  it.each(["steak-pi/mimo-v2-6-flash", "mimo-v2-6-flash"])("keeps explicit profile %s exact with a truthful receipt", profile => {
    const result = choose(astra, { profile, requireImages: true });
    expect(result.model).toBe(mimoFlash);
    expect(result.selection).toEqual({ harness: "pi", provider: "xiaomi", modelId: "mimo-v2.6-flash",
      profile: "steak-pi/mimo-v2-6-flash", parentProfile: "steak-pi/gpt-6-astra", source: "override", tools: true, images: true });
  });
  it.each(["workerDefault", "reviewerDefault"] as const)("refuses retired configured %s selectors", key => {
    const route = "zai/glm-5.3-flash";
    const profiles = BUILTIN_WORKER_PROFILES.map(profile => profile.model === "openai-codex/gpt-6-astra"
      ? { ...profile, [key]: { model: route } } : profile);
    const role = key === "reviewerDefault" ? "reviewer" : "worker";
    expect(() => choose(astra, { tasks: [{ label: "leaf", task: "test", role }] }, registry(), profiles))
      .toThrow(retiredRouteError(route));
  });
  it("selects any authorized native provider without a hard-coded model allowlist", () => {
    expect(choose(astra, { model: "custom/custom-vision" }).model).toBe(other);
  });
  it("keeps automatic native-Pi roles on MiMo→Terra chains without retired routes", () => {
    // Both roles use subscription chains with their own MiMo head, never Z.ai.
    const worker = choose(other, { tasks: [{ label: "leaf", task: "test", role: "worker" }] });
    expect(worker.model).toBe(sol);
    expect(worker.selection).toMatchObject({ source: "chain", chainRoutes: ["openai-codex/gpt-6.1-terra", "opencode-go/deepseek-v4.1-flash"] });
    // Reviewers keep their MiMo V2.6 Pro head; only routine workers moved to Flash.
    const reviewer = choose(other, { tasks: [{ label: "leaf", task: "test", role: "reviewer" }] });
    expect(reviewer.model).toBe(mimoPro);
    expect(reviewer.selection).toMatchObject({ source: "chain",
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "openai-codex/gpt-6.1-terra"] });
  });
  it("resolves an implicit worker with the configured Terra profile", () => {
    const result = resolveWorkerSelection(astra, "high", input(), registry() as never,
      BUILTIN_WORKER_PROFILES, "", {}, { workerDefault: { profile: "steak-pi/gpt-6-1-terra" } });
    expect(result.selection).toMatchObject({ provider: "openai-codex", modelId: "gpt-6.1-terra", profile: "steak-pi/gpt-6-1-terra" });
    expect(result.model).toBe(sol);
  });
  it("selects Terra→Codex OAuth and retains Astra medium", () => {
    const result = choose(sol, { model: "openai-codex/gpt-6-astra" });
    expect(result.model).toBe(astra); expect(result.thinkingLevel).toBe("medium");
  });
  it("never overrides an explicit reviewer model with role/default policy", () => {
    expect(choose(astra, { profile: "steak-pi/mimo-v2-6-flash", tasks: [{ label: "review", task: "review", role: "reviewer" }] }).model).toBe(mimoFlash);
  });
  it("preserves omitted default routes and configured per-profile overrides", () => {
    expect(choose(astra).model).toBe(sol);
    expect(choose(astra).selection.source).toBe("chain");
    expect(choose(astra).selection.chainRoutes?.some(route => RETIRED_ROUTE.test(route))).toBe(false);
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }).model).toBe(mimoPro);
    expect(choose(sol).model).toBe(sol);
    const profiles = BUILTIN_WORKER_PROFILES.map(profile => profile.model === "openai-codex/gpt-6-astra"
      ? { ...profile, workerDefault: { model: "openai-codex/gpt-6.1-terra" } } : profile);
    const configured = choose(astra, {}, registry(), profiles);
    expect(configured.model).toBe(sol);
    expect(configured.selection.source).toBe("profile-default");
    expect(configured.selection.chainRoutes).toBeUndefined();
  });
  it("routes automatic defaults through the final MiMo→Terra chain with chain provenance", () => {
    // Luna and Astra never enter the automatic worker chain; only Terra is a fallback.
    const result = choose(astra);
    expect(result.model).toBe(sol);
    expect(result.selection).toMatchObject({ provider: "openai-codex", modelId: "gpt-6.1-terra", source: "chain",
      chainRoutes: ["openai-codex/gpt-6.1-terra", "opencode-go/deepseek-v4.1-flash"] });
    // MiMo unavailable: the Codex OAuth coding subscription route is the only automatic fallback.
    expect(choose(astra, {}, registry([sol])).model).toBe(sol);
    // Subscription-first regression: the reviewed Token Plan step is selected with
    // no paid allowlist grant at all (revoked or absent), never spend-gated.
    const tokenPlan = registry([astra, sol, go]);
    expect(choose(astra, {}, tokenPlan, BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => false }).model).toBe(sol);
    // A non-plan Xiaomi endpoint (general PAYG) is a different billing target: the
    // chain skips it rather than approving it in, and falls through to Codex OAuth.
    expect(choose(astra, {}, registry([{ ...mimoFlash, baseUrl: "https://api.xiaomimimo.com/v1" } as Model, sol])).model).toBe(sol);
    // Unmapped parents use the same chain through the legacy default path.
    expect(choose(astra, {}, tokenPlan, [], { approvePaidRoute: () => false }).model).toBe(sol);
    // Go routes are no automatic chain step: with neither subscription step present, fail closed.
    expect(choose(astra, {}, registry([go]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => true }).model).toBe(go);
  });
  it("keeps automatic native-Pi reviewer defaults on the routine chain, never another expert", () => {
    const review = choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] });
    // Even with authenticated Astra present, the automatic reviewer default is
    // the same prepaid MiMo→Terra chain workers use; no expert is auto-selected.
    expect(review.model).toBe(mimoPro);
    expect(review.selection).toMatchObject({ source: "chain", provider: "xiaomi", modelId: "mimo-v2.6-pro",
      parentProfile: "steak-pi/gpt-6-astra", profile: "steak-pi/mimo-v2-6-pro",
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "openai-codex/gpt-6.1-terra"] });
    // Astra absent or metered makes no difference: the routine chain is the
    // whole automatic reviewer chain, with no expert step before it.
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, registry([sol, mimoPro])).model).toBe(mimoPro);
    // Pro unavailable: the reviewer chain's only fallback is Codex OAuth, never the Flash worker head.
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, registry([sol, mimoFlash])).model).toBe(sol);
    const metered = registry([{ ...astra, baseUrl: "https://api.openai.com/v1" } as Model, sol, mimoPro]);
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, metered).model).toBe(mimoPro);
    // Image review stays on the capable Pro head alone, without a Terra fallback.
    const visual = choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }], requireImages: true });
    expect(visual.model).toBe(mimoPro);
    expect(visual.selection.chainRoutes).toEqual(["xiaomi/mimo-v2.6-pro"]);
    // An explicit reviewer choice still wins exactly, with override provenance.
    const explicit = choose(astra, { model: "openai-codex/gpt-6.1-terra", tasks: [{ label: "r", task: "review", role: "reviewer" }] });
    expect(explicit.selection).toMatchObject({ source: "override", provider: "openai-codex", modelId: "gpt-6.1-terra" });
    expect(explicit.selection.chainRoutes).toBeUndefined();
  });
  it("resolves a reviewerDefault naming the Astra profile through the routine chain, not an exact expert freeze", () => {
    const profiles = BUILTIN_WORKER_PROFILES.map(p => p.id === "steak-pi/mimo-v2-6-flash"
      ? { ...p, reviewerDefault: { profile: "steak-pi/gpt-6-astra" } }
      : p);
    const request = { tasks: [{ label: "r", task: "review", role: "reviewer" as const }] };
    const selected = choose(mimoFlash, request, registry(), profiles);
    // The legacy native-Pi reviewer-chain label keeps the default automatic —
    // on the subscription chain — instead of freezing the Astra expert model.
    expect(selected.model).toBe(mimoPro);
    expect(selected.selection).toMatchObject({ source: "chain", profile: "steak-pi/gpt-6-astra",
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "openai-codex/gpt-6.1-terra"] });
    expect(choose(mimoFlash, request, registry([sol, mimoPro]), profiles).model).toBe(mimoPro);
    expect(choose(mimoFlash, { ...request, profile: "steak-pi/gpt-6-astra" }, registry(), profiles).selection.source).toBe("override");
  });
  it("requires a capable MiMo head for image requests and never uses Terra as fallback", () => {
    const textOnlyAstra = { ...astra, input: ["text"] } as Model;
    const textOnlyFlash = { ...mimoFlash, input: ["text"] } as Model;
    const reviewer = choose(sol, { requireImages: true, tasks: [{ label: "r", task: "inspect image", role: "reviewer" }] },
      registry([textOnlyAstra, mimoPro, sol]));
    expect(reviewer.model).toBe(mimoPro);
    expect(() => choose(sol, { requireImages: true }, registry([textOnlyFlash, sol])))
      .toThrow(/no fallback was selected/);
  });
  it("keeps an explicit chain-step model exact: no cross-provider chain provenance", () => {
    const result = choose(astra, { model: "opencode-go/deepseek-v4.1-flash" });
    expect(result.model).toBe(go);
    expect(result.selection).toMatchObject({ source: "override", provider: "opencode-go", modelId: "deepseek-v4.1-flash" });
    expect(result.selection.chainRoutes).toBeUndefined();
  });
  it("keeps parent-added GPT-6.1 Terra/Luna profiles explicit-only and refuses retired GPT-6.0 Sol", () => {
    const added = BUILTIN_WORKER_PROFILES.filter((profile) => ["steak-pi/gpt-6-1-terra", "steak-pi/gpt-6-luna"].includes(profile.id));
    expect(added.map((profile) => profile.id)).toEqual(["steak-pi/gpt-6-1-terra", "steak-pi/gpt-6-luna"]);
    for (const profile of added) {
      // Never an automatic worker default: routine workers stay on the chain.
      expect(profile.workerDefault).toEqual({ profile: profile.id.endsWith("terra") ? profile.id : "steak-pi/opencode-go" });
      expect(DEFAULT_TEXT_WORKER_CHAIN.some((step) => step.id === profile.model.split("/")[1] && step.id !== "gpt-6.1-terra")).toBe(false);
    }
    // Explicit selection is exact, with the profile's high thinking preference.
    const explicit = choose(astra, { profile: "steak-pi/gpt-6-1-terra" }, registry([astra, sol, mimoFlash]));
    expect(explicit.model).toBe(sol);
    expect(explicit.selection).toMatchObject({ source: "override", provider: "openai-codex", modelId: "gpt-6.1-terra", profile: "steak-pi/gpt-6-1-terra" });
    expect(explicit.thinkingLevel).toBe("high");
    // GPT-6.0 Sol is retired: no built-in profile names it and selectors are refused, never remapped to 6.1.
    expect(BUILTIN_WORKER_PROFILES.some((profile) => /gpt-6-sol/.test(profile.id) || /gpt-6-sol/.test(profile.model))).toBe(false);
    const retired = { ...astra, id: "gpt-6-sol", name: "GPT-6 Sol" } as Model;
    expect(() => choose(astra, { profile: "steak-pi/gpt-6-sol" }, registry([astra, sol, retired, mimoFlash]))).toThrow(/RetiredModelSelectionError/);
    // A Terra parent keeps workers and reviewers on the routine chain — Terra and
    // Astra are never automatic defaults in any role.
    const solParent = choose(sol, {}, registry([astra, sol, go, mimoFlash]));
    expect(solParent.model).toBe(sol);
    expect(solParent.selection).toMatchObject({ source: "chain", parentProfile: "steak-pi/gpt-6-1-terra" });
    const solReview = choose(sol, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, registry([astra, sol, mimoPro, mimoFlash]));
    expect(solReview.model).toBe(mimoPro);
  });
  it("requires the authenticated available catalog before operator selection includes a route", () => {
    const approved = { approvePaidRoute: () => true };
    // Approved Token Plan route, absent from the authenticated available catalog.
    const hidden = registry([astra, go]);
    hidden.getAvailable.mockReturnValue([astra]);
    expect(() => choose(astra, {}, hidden, BUILTIN_WORKER_PROFILES, approved)).toThrow(/no fallback was selected/);
    const unauthenticated = registry([astra, go]);
    unauthenticated.hasConfiguredAuth.mockImplementation((model: Model) => model.provider !== "opencode-go");
    expect(() => choose(astra, {}, unauthenticated, BUILTIN_WORKER_PROFILES, approved)).toThrow(/no fallback was selected/);
    // Authenticated and available subscription route: selected with NO paid grant.
    expect(choose(astra, {}, registry([astra, go]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => false }).selection)
      .toMatchObject({ source: "chain", provider: "opencode-go", modelId: "deepseek-v4.1-flash" });
    // A present/absent grant is equally irrelevant: the Token Plan step is prepaid.
    expect(choose(astra, {}, registry([astra, go]), BUILTIN_WORKER_PROFILES, approved).selection)
      .toMatchObject({ source: "chain", provider: "opencode-go", modelId: "deepseek-v4.1-flash" });
  });
  it("routes automatic multimodal defaults through MiMo Flash only, with no fallback", () => {
    const tokenPlan = registry([astra, sol, mimoFlash]);
    expect(choose(astra, { requireImages: true }, tokenPlan, BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => true }).model).toBe(mimoFlash);
    expect(() => choose(astra, { requireImages: true }, registry([astra, sol]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => false }))
      .toThrow(/no fallback was selected/);
    expect(() => choose(astra, { requireImages: true }, registry([astra, go]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => true }))
      .toThrow(/no fallback was selected/);
  });
  it("keeps an explicit chain-profile selection exact instead of silently chaining", () => {
    expect(() => choose(astra, { profile: "steak-pi/opencode-go" }, registry([astra, sol, mimoPro]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => true }))
      .toThrow(/unavailable/);
  });
  it("binds defaults to UltraTerm's actual harness identity when profile IDs overlap", () => {
    vi.stubEnv("ULTRATERM_HARNESS_ID", "custom-host");
    try {
      const profiles = [...BUILTIN_WORKER_PROFILES, { id: "custom-host/gpt-6-astra", model: "openai-codex/gpt-6-astra", workerDefault: { model: "openai-codex/gpt-6.1-terra" } }];
      const result = resolveWorkerSelection(astra, "medium", input(), registry() as never, profiles, "gpt-6-astra");
      expect(result.model).toBe(sol);
      expect(result.selection.parentProfile).toBe("custom-host/gpt-6-astra");
    } finally { vi.unstubAllEnvs(); }
  });
  it("does not inherit a stale launch profile after /model changes", () => {
    const r = registry();
    const result = resolveWorkerSelection(sol, "high", input(), r as never, BUILTIN_WORKER_PROFILES, "gpt-6-astra");
    expect(result.model).toBe(sol);
  });
  it.each([
    { model: "openai-codex/gpt-6.1-terra", profile: "steak-pi/mimo-v2-6-flash" },
    { model: "gpt-6.1-terra" }, { model: "custom/missing" }, { profile: "missing" },
    { model: "" }, { profile: " " },
  ])("fails closed for invalid/conflicting/unavailable selectors %j", (extra) => {
    expect(() => choose(astra, extra)).toThrow();
  });
  it("requires configured auth AND authenticated availability", () => {
    const r = registry(); r.hasConfiguredAuth.mockReturnValue(false);
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-terra" }, r)).toThrow(/authentication/);
    r.hasConfiguredAuth.mockReturnValue(true); r.getAvailable.mockReturnValue([astra]);
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-terra" }, r)).toThrow(/authentication/);
  });
  it.each(["openrouter", "openai", "azure"])('rejects explicit GPT on %s', (provider) => {
    const model = { ...astra, provider };
    expect(() => choose(sol, { model: `${provider}/${model.id}` }, registry([model]))).toThrow(/paid/);
  });
  it("rejects batch, API-key Codex, and forged Codex endpoints", () => {
    const batch = { ...astra, id: "gpt-6-astra-batch" };
    expect(() => choose(sol, { model: `openai-codex/${batch.id}` }, registry([batch]))).toThrow(/paid/);
    const r = registry(); r.isUsingOAuth.mockReturnValue(false);
    expect(() => choose(sol, { model: "openai-codex/gpt-6-astra" }, r)).toThrow(/paid/);
    expect(() => choose(sol, { model: "openai-codex/gpt-6-astra" }, registry([{ ...astra, baseUrl: "https://example.test" }]))).toThrow(/paid/);
    // The generic chain helper permits local routes, but a Codex-labelled
    // localhost route must still fail the USAP subscription dispatch guard.
    expect(() => choose(astra, {}, registry([{ ...sol, baseUrl: "http://localhost:8080/v1" } as Model]))).toThrow(/paid/);
  });
  it("checks image input and native tool-adapter availability before dispatch", () => {
    const text = { ...sol, input: ["text"] } as Model;
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-terra", requireImages: true }, registry([text]))).toThrow(/image input/);
    const r = registry(); r.getProvider.mockReturnValue({} as never);
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-terra" }, r)).toThrow(/tool streaming adapter/);
  });
  it("loads only route/default metadata from existing native profile catalogs", () => {
    const dir = mkdtempSync(join(tmpdir(), "usap-profiles-"));
    try {
      writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ id: "steak-pi", executable: "never-execute", profiles: [
        { id: "gpt-6-astra", args: ["--model", "openai-codex/gpt-6-astra", "--thinking", "medium"], workerDefault: { model: "openai-codex/gpt-6.1-terra" } },
        { id: "custom", args: ["--model", "custom/custom-vision"] },
      ] }));
      const profiles = loadWorkerProfiles(dir);
      expect(choose(astra, {}, registry(), profiles).model).toBe(sol);
      expect(choose(astra, { profile: "steak-pi/custom" }, registry(), profiles).model).toBe(other);
      writeFileSync(join(dir, "bad.json"), "not json");
      expect(() => loadWorkerProfiles(dir)).toThrow(/parse harness metadata/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// All cases are synthetic: no CLI is spawned and no image is read. The parent's
// real staged-image CLI smoke is what proves native Read-image behavior.
describe("synthetic: P-0579 claude-code staged native Read-image admission (synthetic)", () => {
  const routes = [
    { route: CLAUDE_CODE_SONNET_ROUTE, model: "claude-sonnet-5-5" },
    { route: CLAUDE_CODE_OPUS_ROUTE, model: "claude-opus-5-5" },
  ] as const;
  it.each(routes)("admits the exact pinned route $route with images=true and no fallback", ({ route, model }) => {
    expect(assertClaudeCodeImageAdmission(route)).toBe(model);
    const selection = resolveClaudeCodeSelection(assertClaudeCodeImageAdmission(route));
    expect(selection).toEqual({ provider: "claude-code", modelId: model, source: "override", harness: "claude-code", images: true, tools: true });
    // Explicit pin only: no chain, profile or parent-profile provenance appears.
    expect(selection).not.toHaveProperty("chainRoutes");
    expect(selection).not.toHaveProperty("profile");
    expect(selection).not.toHaveProperty("parentProfile");
  });
  it.each([
    undefined, "", "claude-opus-5-5", "claude-sonnet-5-5", "anthropic/claude-opus-5-5", "claude-code/claude-opus-5",
    "claude-code/claude-opus-5-5-fast", "claude-code/claude-fable-5-1", "claude-code/claude-haiku-5-5", " claude-code/claude-opus-5-5",
    "claude-code/claude-opus-5-5 ", "CLAUDE-CODE/claude-opus-5-5", "claude-code/", "openai-codex/gpt-6.1-terra", "xiaomi/mimo-v2.6-flash",
  ])("refuses a non-exact route %j before any image review starts", (route) => {
    expect(() => assertClaudeCodeImageAdmission(route)).toThrow(/admits only claude-code\/claude-sonnet-5-5 or claude-code\/claude-opus-5-5.*no fallback/);
  });
  it("keeps the two admitted selections distinct instead of defaulting one to the other", () => {
    expect(resolveClaudeCodeSelection("claude-sonnet-5-5").modelId).toBe("claude-sonnet-5-5");
    expect(resolveClaudeCodeSelection("claude-opus-5-5").modelId).toBe("claude-opus-5-5");
  });
  it("never resolves the claude-code harness through the native Pi registry, even for image requests", () => {
    const r = registry();
    expect(() => choose(astra, { harness: "claude-code", requireImages: true }, r)).toThrow(/does not resolve through the native Pi registry/);
    expect(r.find).not.toHaveBeenCalled();
    expect(r.getAvailable).not.toHaveBeenCalled();
  });
  it("keeps Pi image admission fail-closed and unable to address a claude-code route", () => {
    const r = registry();
    for (const route of [CLAUDE_CODE_SONNET_ROUTE, CLAUDE_CODE_OPUS_ROUTE]) {
      expect(() => choose(astra, { model: route, requireImages: true }, r)).toThrow(/unavailable.*no fallback was selected/);
    }
    // Text-only Pi routes still refuse images and nothing substitutes another model.
    const text = { ...sol, input: ["text"] } as Model;
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-terra", requireImages: true }, registry([text]))).toThrow(/image input/);
    expect(() => choose(sol, { requireImages: true }, registry([sol]))).toThrow();
  });
});

describe("synthetic: operator role routing precedence", () => {
  it("prefers role metadata over stale profile defaults but never explicit selection", () => {
    const defaults = { workerDefault: { model: "opencode-go/deepseek-v4.1-flash" }, reviewerDefault: { model: "openai-codex/gpt-6.1-terra" } };
    const resolve = (extra: Partial<DispatchInput>) => resolveWorkerSelection(astra, "high", input(extra), registry() as never, BUILTIN_WORKER_PROFILES, "", {}, defaults);
    expect(resolve({}).model).toBe(go);
    expect(resolve({ model: "openai-codex/gpt-6-astra" }).selection.source).toBe("override");
    expect(resolve({ model: "openai-codex/gpt-6-astra" }).model).toBe(astra);
    expect(resolve({ tasks: [{ label: "review", task: "review", role: "reviewer" }] }).model).toBe(sol);
    expect(() => resolve({ requireImages: true })).toThrow(/image/);
  });
  it("loads only validated selectors, preserves annotations and fails malformed defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "usap-role-defaults-"));
    try {
      const file = join(dir, "routing.json");
      writeFileSync(file, JSON.stringify({ workerDefault: { profile: "steak-pi/opencode-go" }, note: "operator annotation" }));
      expect(loadRoleDefaults(file)).toEqual({ workerDefault: { profile: "steak-pi/opencode-go" } });
      writeFileSync(file, JSON.stringify({ workerDefault: { model: "one/two", profile: "one/three" } }));
      expect(() => loadRoleDefaults(file)).toThrow(/conflict/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("synthetic: automatic quota fallback tier (cheapest capable Claude model)", () => {
  const leaf = (extra: Partial<SubagentTaskInput> = {}): SubagentTaskInput => ({ label: "leaf", task: "work", ...extra });
  it("takes Haiku 5.5 for ordinary leaves, whatever their read or scout role or limited edits", () => {
    for (const tasks of [
      [leaf({ role: "scout" })],
      [leaf({ role: "worker" }), leaf({ role: "worker" })],
      [leaf({ role: "worker", mayEdit: true, ownedPaths: ["/tmp/x"] })], // edits without a shell
      [leaf({ role: "worker", allowBash: true })], // a shell without edits
    ]) {
      expect(claudeFallbackTier({ tasks })).toMatchObject({ route: CLAUDE_CODE_HAIKU_ROUTE, model: "claude-haiku-5-5" });
    }
    expect(claudeFallbackTier({ tasks: [leaf()], thinking: "medium" }).route).toBe(CLAUDE_CODE_HAIKU_ROUTE);
  });
  it("takes Sonnet 5.5 for substantial code work, requested high/xhigh reasoning and every reviewer, and says why", () => {
    const cases = [
      { tasks: [leaf(), leaf({ mayEdit: true, allowBash: true, ownedPaths: ["/tmp/x"] })], why: /edit files and run a shell/ },
      { tasks: [leaf()], thinking: "xhigh" as const, why: /thinking xhigh/ },
      { tasks: [leaf()], thinking: "high" as const, why: /thinking high/ },
      { tasks: [leaf({ role: "reviewer" })], why: /reviewer/ },
      { tasks: [leaf({ role: "scout" }), leaf({ role: "reviewer" })], why: /reviewer/ },
    ];
    for (const { why, ...dispatch } of cases) {
      const tier = claudeFallbackTier(dispatch);
      expect(tier).toMatchObject({ route: CLAUDE_CODE_SONNET_ROUTE, model: "claude-sonnet-5-5" });
      expect(tier.reason).toMatch(why);
    }
  });
  it("keeps Haiku an internal tier: pinned to its exact route, never an explicit route and never admitted for images", () => {
    expect(CLAUDE_CODE_HAIKU_ROUTE).toBe("claude-code/claude-haiku-5-5");
    expect(claudeCodeModelOf(CLAUDE_CODE_HAIKU_ROUTE)).toBe("claude-haiku-5-5");
    expect(claudeCodeModelName("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(CLAUDE_CODE_ROUTES).not.toContain(CLAUDE_CODE_HAIKU_ROUTE);
    expect(() => assertClaudeCodeImageAdmission(CLAUDE_CODE_HAIKU_ROUTE)).toThrow(/admits only claude-code\/claude-sonnet-5-5 or claude-code\/claude-opus-5-5/);
    for (const near of ["claude-code/claude-haiku-5", "claude-code/haiku", "claude-code-api/claude-haiku-5-5", "anthropic/claude-haiku-5-5"]) {
      expect(claudeCodeModelOf(near)).toBeUndefined();
    }
  });
});

describe("synthetic: exhausted-provider chain skipping for implicit routes", () => {
  // The profile default is the exact Terra profile (not an automatic chain).
  const solFirst = BUILTIN_WORKER_PROFILES.map(profile => profile.model === "openai-codex/gpt-6.1-terra" ? { ...profile, workerDefault: { profile: profile.id } } : profile);
  const skipTerra: ChainOptions = { forceDefaultChain: true, skipRoute: step => step.provider === "openai-codex" && step.id === "gpt-6.1-terra" };
  const skipGo: ChainOptions = { forceDefaultChain: true, skipRoute: step => step.provider === "opencode-go" };
  it("resolves exact Terra from the profile default when nothing is skipped", () => {
    const resolved = choose(sol, {}, registry(), solFirst);
    expect(resolved.model).toBe(sol);
    expect(resolved.selection).toMatchObject({ source: "chain", profile: "steak-pi/gpt-6-1-terra" });
    expect(resolved.selection.chainRoutes).toEqual(["openai-codex/gpt-6.1-terra", "opencode-go/deepseek-v4.1-flash"]);
  });
  it("walks the default chain past a skipped Terra to Go, recording the whole chain", () => {
    const resolved = choose(sol, {}, registry(), solFirst, skipTerra);
    expect(resolved.model).toBe(go);
    expect(resolved.selection).toMatchObject({ source: "chain", provider: "opencode-go", profile: "steak-pi/opencode-go",
      chainRoutes: DEFAULT_TEXT_WORKER_CHAIN.map(step => `${step.provider}/${step.id}`) });
  });
  it("walks the default chain past a skipped Go to Terra", () => {
    const resolved = choose(go, {}, registry(), BUILTIN_WORKER_PROFILES, skipGo);
    expect(resolved.model).toBe(sol);
    expect(resolved.selection).toMatchObject({ source: "chain", provider: "openai-codex",
      chainRoutes: DEFAULT_TEXT_WORKER_CHAIN.map(step => `${step.provider}/${step.id}`) });
  });
  it("works with no profile catalog at all (the built-in default profile is the fallback)", () => {
    const resolved = choose(sol, {}, registry(), [], skipTerra);
    expect(resolved.model).toBe(go);
    expect(resolved.selection.source).toBe("chain");
  });
  it("fails with the typed default-chain result when every step is skipped or unauthenticated", () => {
    const skipBoth: ChainOptions = { forceDefaultChain: true, skipRoute: () => true };
    try { choose(sol, {}, registry(), solFirst, skipBoth); throw new Error("expected NoChainRouteError"); }
    catch (error) {
      expect(error).toBeInstanceOf(NoChainRouteError);
      expect((error as NoChainRouteError).tried.map(step => `${step.provider}/${step.id}`)).toEqual(DEFAULT_TEXT_WORKER_CHAIN.map(step => `${step.provider}/${step.id}`));
    }
    // Go skipped and unauthenticated Terra: same typed result.
    expect(() => choose(sol, {}, registry([go]), solFirst, { forceDefaultChain: true, skipRoute: step => step.provider === "opencode-go" })).toThrow(NoChainRouteError);
  });
  it("never reroutes or skips an explicit selector, a reviewer wave or an image wave", () => {
    const options: ChainOptions = { forceDefaultChain: true, skipRoute: () => true };
    expect(choose(sol, { model: "openai-codex/gpt-6.1-terra" }, registry(), solFirst, options)).toMatchObject({ model: sol, selection: { source: "override" } });
    expect(choose(sol, { profile: "steak-pi/gpt-6-1-terra" }, registry(), solFirst, options).selection.source).toBe("override");
    expect(choose(sol, { tasks: [{ label: "r", task: "r", role: "reviewer" }] }, registry(), solFirst, { forceDefaultChain: true }).selection.profile).not.toBe("steak-pi/opencode-go");
  });
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKER_PROFILES, claudeCodeAccountOf, claudeCodeModelOf, CLAUDE_CODE_OPUS_ROUTE, CLAUDE_CODE_SONNET_ROUTE, assertClaudeCodeImageAdmission, loadWorkerProfiles,
  resolveClaudeCodeSelection, resolveWorkerSelection, RETIRED_ROUTE, retiredRouteError } from "../src/subagents/model-selection.ts";
import { DEFAULT_TEXT_WORKER_CHAIN, type ChainOptions } from "../src/model-route-policy.ts";
import type { DispatchInput } from "../src/subagents/types.ts";

type Model = Parameters<typeof resolveWorkerSelection>[0];
const astra = { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] } as Model;
const luna = { ...astra, id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const sol = { ...astra, id: "gpt-6.1-sol", name: "GPT-6.1 Sol", input: ["text"] } as Model;
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
  it("keeps automatic native-Pi roles on MiMo→Sol chains without retired routes", () => {
    // Both roles use subscription chains with their own MiMo head, never Z.ai.
    const worker = choose(other, { tasks: [{ label: "leaf", task: "test", role: "worker" }] });
    expect(worker.model).toBe(mimoFlash);
    expect(worker.selection).toMatchObject({ source: "chain", chainRoutes: ["xiaomi/mimo-v2.6-flash", "openai-codex/gpt-6.1-sol"] });
    // Reviewers keep their MiMo V2.6 Pro head; only routine workers moved to Flash.
    const reviewer = choose(other, { tasks: [{ label: "leaf", task: "test", role: "reviewer" }] });
    expect(reviewer.model).toBe(mimoPro);
    expect(reviewer.selection).toMatchObject({ source: "chain",
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "openai-codex/gpt-6.1-sol"] });
  });
  it("selects Sol→Codex OAuth and retains Astra medium", () => {
    const result = choose(sol, { model: "openai-codex/gpt-6-astra" });
    expect(result.model).toBe(astra); expect(result.thinkingLevel).toBe("medium");
  });
  it("never overrides an explicit reviewer model with role/default policy", () => {
    expect(choose(astra, { profile: "steak-pi/mimo-v2-6-flash", tasks: [{ label: "review", task: "review", role: "reviewer" }] }).model).toBe(mimoFlash);
  });
  it("preserves omitted default routes and configured per-profile overrides", () => {
    expect(choose(astra).model).toBe(mimoFlash);
    expect(choose(astra).selection.source).toBe("chain");
    expect(choose(astra).selection.chainRoutes?.some(route => RETIRED_ROUTE.test(route))).toBe(false);
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }).model).toBe(mimoPro);
    expect(choose(sol).model).toBe(mimoFlash);
    const profiles = BUILTIN_WORKER_PROFILES.map(profile => profile.model === "openai-codex/gpt-6-astra"
      ? { ...profile, workerDefault: { model: "openai-codex/gpt-6.1-sol" } } : profile);
    const configured = choose(astra, {}, registry(), profiles);
    expect(configured.model).toBe(sol);
    expect(configured.selection.source).toBe("profile-default");
    expect(configured.selection.chainRoutes).toBeUndefined();
  });
  it("routes automatic defaults through the final MiMo→Sol chain with chain provenance", () => {
    // Luna and Astra never enter the automatic worker chain; only Sol is a fallback.
    const result = choose(astra);
    expect(result.model).toBe(mimoFlash);
    expect(result.selection).toMatchObject({ provider: "xiaomi", modelId: "mimo-v2.6-flash", source: "chain",
      chainRoutes: ["xiaomi/mimo-v2.6-flash", "openai-codex/gpt-6.1-sol"] });
    // MiMo unavailable: the Codex OAuth coding subscription route is the only automatic fallback.
    expect(choose(astra, {}, registry([sol])).model).toBe(sol);
    // Subscription-first regression: the reviewed Token Plan step is selected with
    // no paid allowlist grant at all (revoked or absent), never spend-gated.
    const tokenPlan = registry([astra, sol, mimoFlash]);
    expect(choose(astra, {}, tokenPlan, BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => false }).model).toBe(mimoFlash);
    // A non-plan Xiaomi endpoint (general PAYG) is a different billing target: the
    // chain skips it rather than approving it in, and falls through to Codex OAuth.
    expect(choose(astra, {}, registry([{ ...mimoFlash, baseUrl: "https://api.xiaomimimo.com/v1" } as Model, sol])).model).toBe(sol);
    // Unmapped parents use the same chain through the legacy default path.
    expect(choose(astra, {}, tokenPlan, [], { approvePaidRoute: () => false }).model).toBe(mimoFlash);
    // Go routes are no automatic chain step: with neither subscription step present, fail closed.
    expect(() => choose(astra, {}, registry([go]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => true })).toThrow(/no fallback was selected/);
  });
  it("keeps automatic native-Pi reviewer defaults on the routine chain, never another expert", () => {
    const review = choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] });
    // Even with authenticated Astra present, the automatic reviewer default is
    // the same prepaid MiMo→Sol chain workers use; no expert is auto-selected.
    expect(review.model).toBe(mimoPro);
    expect(review.selection).toMatchObject({ source: "chain", provider: "xiaomi", modelId: "mimo-v2.6-pro",
      parentProfile: "steak-pi/gpt-6-astra", profile: "steak-pi/mimo-v2-6-pro",
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "openai-codex/gpt-6.1-sol"] });
    // Astra absent or metered makes no difference: the routine chain is the
    // whole automatic reviewer chain, with no expert step before it.
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, registry([sol, mimoPro])).model).toBe(mimoPro);
    // Pro unavailable: the reviewer chain's only fallback is Codex OAuth, never the Flash worker head.
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, registry([sol, mimoFlash])).model).toBe(sol);
    const metered = registry([{ ...astra, baseUrl: "https://api.openai.com/v1" } as Model, sol, mimoPro]);
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, metered).model).toBe(mimoPro);
    // Image review stays on the capable Pro head alone, without a Sol fallback.
    const visual = choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }], requireImages: true });
    expect(visual.model).toBe(mimoPro);
    expect(visual.selection.chainRoutes).toEqual(["xiaomi/mimo-v2.6-pro"]);
    // An explicit reviewer choice still wins exactly, with override provenance.
    const explicit = choose(astra, { model: "openai-codex/gpt-6.1-sol", tasks: [{ label: "r", task: "review", role: "reviewer" }] });
    expect(explicit.selection).toMatchObject({ source: "override", provider: "openai-codex", modelId: "gpt-6.1-sol" });
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
      chainRoutes: ["xiaomi/mimo-v2.6-pro", "openai-codex/gpt-6.1-sol"] });
    expect(choose(mimoFlash, request, registry([sol, mimoPro]), profiles).model).toBe(mimoPro);
    expect(choose(mimoFlash, { ...request, profile: "steak-pi/gpt-6-astra" }, registry(), profiles).selection.source).toBe("override");
  });
  it("requires a capable MiMo head for image requests and never uses Sol as fallback", () => {
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
  it("keeps parent-added GPT-6.1 Sol/Luna profiles explicit-only and refuses retired GPT-6.0 Sol", () => {
    const added = BUILTIN_WORKER_PROFILES.filter((profile) => ["steak-pi/gpt-6-1-sol", "steak-pi/gpt-6-luna"].includes(profile.id));
    expect(added.map((profile) => profile.id)).toEqual(["steak-pi/gpt-6-1-sol", "steak-pi/gpt-6-luna"]);
    for (const profile of added) {
      // Never an automatic worker default: routine workers stay on the chain.
      expect(profile.workerDefault).toEqual({ profile: "steak-pi/mimo-v2-6-flash" });
      expect(DEFAULT_TEXT_WORKER_CHAIN.some((step) => step.id === profile.model.split("/")[1] && step.id !== "gpt-6.1-sol")).toBe(false);
    }
    // Explicit selection is exact, with the profile's high thinking preference.
    const explicit = choose(astra, { profile: "steak-pi/gpt-6-1-sol" }, registry([astra, sol, mimoFlash]));
    expect(explicit.model).toBe(sol);
    expect(explicit.selection).toMatchObject({ source: "override", provider: "openai-codex", modelId: "gpt-6.1-sol", profile: "steak-pi/gpt-6-1-sol" });
    expect(explicit.thinkingLevel).toBe("high");
    // GPT-6.0 Sol is retired: no built-in profile names it and selectors are refused, never remapped to 6.1.
    expect(BUILTIN_WORKER_PROFILES.some((profile) => /gpt-6-sol/.test(profile.id) || /gpt-6-sol/.test(profile.model))).toBe(false);
    const retired = { ...astra, id: "gpt-6-sol", name: "GPT-6 Sol" } as Model;
    expect(() => choose(astra, { profile: "steak-pi/gpt-6-sol" }, registry([astra, sol, retired, mimoFlash]))).toThrow(/RetiredModelSelectionError/);
    // A Sol parent keeps workers and reviewers on the routine chain — Sol and
    // Astra are never automatic defaults in any role.
    const solParent = choose(sol, {}, registry([astra, sol, mimoFlash]));
    expect(solParent.model).toBe(mimoFlash);
    expect(solParent.selection).toMatchObject({ source: "chain", parentProfile: "steak-pi/gpt-6-1-sol" });
    const solReview = choose(sol, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }, registry([astra, sol, mimoPro, mimoFlash]));
    expect(solReview.model).toBe(mimoPro);
  });
  it("requires the authenticated available catalog before operator selection includes a route", () => {
    const approved = { approvePaidRoute: () => true };
    // Approved Token Plan route, absent from the authenticated available catalog.
    const hidden = registry([astra, mimoFlash]);
    hidden.getAvailable.mockReturnValue([astra]);
    expect(() => choose(astra, {}, hidden, BUILTIN_WORKER_PROFILES, approved)).toThrow(/no fallback was selected/);
    const unauthenticated = registry([astra, mimoFlash]);
    unauthenticated.hasConfiguredAuth.mockImplementation((model: Model) => model.provider !== "xiaomi");
    expect(() => choose(astra, {}, unauthenticated, BUILTIN_WORKER_PROFILES, approved)).toThrow(/no fallback was selected/);
    // Authenticated and available subscription route: selected with NO paid grant.
    expect(choose(astra, {}, registry([astra, mimoFlash]), BUILTIN_WORKER_PROFILES, { approvePaidRoute: () => false }).selection)
      .toMatchObject({ source: "chain", provider: "xiaomi", modelId: "mimo-v2.6-flash" });
    // A present/absent grant is equally irrelevant: the Token Plan step is prepaid.
    expect(choose(astra, {}, registry([astra, mimoFlash]), BUILTIN_WORKER_PROFILES, approved).selection)
      .toMatchObject({ source: "chain", provider: "xiaomi", modelId: "mimo-v2.6-flash" });
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
      const profiles = [...BUILTIN_WORKER_PROFILES, { id: "custom-host/gpt-6-astra", model: "openai-codex/gpt-6-astra", workerDefault: { model: "openai-codex/gpt-6.1-sol" } }];
      const result = resolveWorkerSelection(astra, "medium", input(), registry() as never, profiles, "gpt-6-astra");
      expect(result.model).toBe(sol);
      expect(result.selection.parentProfile).toBe("custom-host/gpt-6-astra");
    } finally { vi.unstubAllEnvs(); }
  });
  it("does not inherit a stale launch profile after /model changes", () => {
    const r = registry();
    const result = resolveWorkerSelection(sol, "high", input(), r as never, BUILTIN_WORKER_PROFILES, "gpt-6-astra");
    expect(result.model).toBe(mimoFlash);
  });
  it.each([
    { model: "openai-codex/gpt-6.1-sol", profile: "steak-pi/mimo-v2-6-flash" },
    { model: "gpt-6.1-sol" }, { model: "custom/missing" }, { profile: "missing" },
    { model: "" }, { profile: " " },
  ])("fails closed for invalid/conflicting/unavailable selectors %j", (extra) => {
    expect(() => choose(astra, extra)).toThrow();
  });
  it("requires configured auth AND authenticated availability", () => {
    const r = registry(); r.hasConfiguredAuth.mockReturnValue(false);
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-sol" }, r)).toThrow(/authentication/);
    r.hasConfiguredAuth.mockReturnValue(true); r.getAvailable.mockReturnValue([astra]);
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-sol" }, r)).toThrow(/authentication/);
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
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-sol", requireImages: true }, registry([text]))).toThrow(/image input/);
    const r = registry(); r.getProvider.mockReturnValue({} as never);
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-sol" }, r)).toThrow(/tool streaming adapter/);
  });
  it("loads only route/default metadata from existing native profile catalogs", () => {
    const dir = mkdtempSync(join(tmpdir(), "usap-profiles-"));
    try {
      writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ id: "steak-pi", executable: "never-execute", profiles: [
        { id: "gpt-6-astra", args: ["--model", "openai-codex/gpt-6-astra", "--thinking", "medium"], workerDefault: { model: "openai-codex/gpt-6.1-sol" } },
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

describe("Claude Code route account selectors", () => {
  it("pins the vendor model and an explicit safe account ID from route@account, for any registered account", () => {
    expect(claudeCodeModelOf("claude-code/claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(claudeCodeAccountOf("claude-code/claude-sonnet-5-5")).toBeUndefined();
    for (const [route, model, account] of [
      ["claude-code/claude-sonnet-5-5@b", "claude-sonnet-5-5", "b"],
      ["claude-code/claude-opus-5-5@b", "claude-opus-5-5", "b"],
      ["claude-code/claude-opus-5-5@primary", "claude-opus-5-5", "primary"],
      ["claude-code/claude-sonnet-5-5@team-3", "claude-sonnet-5-5", "team-3"],
      ["claude-code/claude-sonnet-5-5@" + "x".repeat(24), "claude-sonnet-5-5", "x".repeat(24)],
    ] as const) {
      expect(claudeCodeModelOf(route), route).toBe(model);
      expect(claudeCodeAccountOf(route), route).toBe(account);
    }
  });

  it("refuses anything that is not exactly a known route plus one safe account ID", () => {
    for (const route of ["claude-code/claude-sonnet-5-5@", "claude-code/claude-sonnet-5-5@B", "claude-code/claude-sonnet-5-5@a--b", "claude-code/claude-sonnet-5-5@-b",
      "claude-code/claude-sonnet-5-5@b-", "claude-code/claude-sonnet-5-5@b@c", "claude-code/claude-sonnet-5-5@../b", "claude-code/claude-sonnet-5-5@b/c",
      "claude-code/claude-sonnet-5-5@" + "x".repeat(25), "claude-code/claude-haiku-5-5@b", "claude-code/claude-sonnet-5-5-extra@b", "anthropic/claude-sonnet-5-5@b", "@b", ""]) {
      expect(claudeCodeModelOf(route), route).toBeUndefined();
      expect(claudeCodeAccountOf(route), route).toBeUndefined();
    }
    expect(claudeCodeModelOf(undefined)).toBeUndefined();
  });
});

// All cases are synthetic: no CLI is spawned and no image is read. The parent's
// real staged-image CLI smoke is what proves native Read-image behavior.
describe("P-0579 claude-code staged native Read-image admission (synthetic)", () => {
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
    "claude-code/claude-opus-5-5 ", "CLAUDE-CODE/claude-opus-5-5", "claude-code/", "openai-codex/gpt-6.1-sol", "xiaomi/mimo-v2.6-flash",
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
    expect(() => choose(astra, { model: "openai-codex/gpt-6.1-sol", requireImages: true }, registry([text]))).toThrow(/image input/);
    expect(() => choose(sol, { requireImages: true }, registry([sol]))).toThrow();
  });
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKER_PROFILES, loadWorkerProfiles, resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import type { DispatchInput } from "../src/subagents/types.ts";

type Model = Parameters<typeof resolveWorkerSelection>[0];
const astra = { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] } as Model;
const luna = { ...astra, id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const glm = { ...astra, id: "glm-5.3-flash", name: "GLM-5.3 Flash", provider: "zai", api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" } as Model;
const other = { ...glm, id: "custom-vision", name: "Custom vision", provider: "custom" };
function registry(models = [astra, luna, glm, other]) {
  return {
    find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
    getAvailable: vi.fn(() => models),
    hasConfiguredAuth: vi.fn(() => true),
    isUsingOAuth: vi.fn((model: Model) => model.provider === "openai-codex"),
    getProvider: vi.fn(() => ({ streamSimple() {} })),
  };
}
const input = (extra: Partial<DispatchInput> = {}): DispatchInput => ({ goal: "test", tasks: [{ label: "leaf", task: "test" }], ...extra });
function choose(parent: Model, extra: Partial<DispatchInput> = {}, r = registry(), profiles = BUILTIN_WORKER_PROFILES) {
  return resolveWorkerSelection(parent, "high", input(extra), r as never, profiles, "");
}

describe("USAP 1.1 explicit model/profile contract", () => {
  it.each(["steak-pi/glm-5-3-flash", "glm-5-3-flash"])("selects Astra→GLM profile %s with truthful receipt", (profile) => {
    const result = choose(astra, { profile, requireImages: true });
    expect(result.model).toBe(glm);
    expect(result.selection).toEqual({ provider: "zai", modelId: "glm-5.3-flash", profile: "steak-pi/glm-5-3-flash", parentProfile: "steak-pi/gpt-6-astra", source: "override", tools: true, images: true });
  });
  it("selects any authorized native provider without a hard-coded model allowlist", () => {
    expect(choose(astra, { model: "custom/custom-vision" }).model).toBe(other);
  });
  it("selects GLM→paid Codex and retains Astra medium", () => {
    const result = choose(glm, { model: "openai-codex/gpt-6-astra" });
    expect(result.model).toBe(astra); expect(result.thinkingLevel).toBe("medium");
  });
  it("never overrides an explicit reviewer model with role/default policy", () => {
    expect(choose(astra, { profile: "steak-pi/glm-5-3-flash", tasks: [{ label: "review", task: "review", role: "reviewer" }] }).model).toBe(glm);
  });
  it("preserves omitted default routes and configured per-profile overrides", () => {
    expect(choose(astra).model).toBe(luna);
    expect(choose(astra).selection.source).toBe("profile-default");
    expect(choose(astra, { tasks: [{ label: "r", task: "review", role: "reviewer" }] }).model).toBe(astra);
    expect(choose(glm).model).toBe(glm);
    const profiles = [{ id: "steak-pi/gpt-6-astra", model: "openai-codex/gpt-6-astra", workerDefault: { profile: "steak-pi/glm-5-3-flash" } }, BUILTIN_WORKER_PROFILES[0]];
    expect(choose(astra, {}, registry(), profiles).model).toBe(glm);
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
    expect(result.model).toBe(glm);
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

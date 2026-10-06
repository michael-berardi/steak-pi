import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertModelRoute, assertSubscriptionRequest, guardProvider, isModelRouteAllowed, selectWorkerModel } from "../src/model-route-policy.ts";
import { RetiredModelSelectionError, SOL_MODEL_ID, SOL_MODEL_ROUTE, SOL_PROFILE } from "../src/retired-model-selection.ts";
import { BUILTIN_WORKER_PROFILES, loadWorkerProfiles, resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import { normalizeDispatch } from "../src/subagents/policy.ts";
import { catalogModels, decodeRequest, readProfiles } from "../extensions/ultraterm-ui.ts";
import modelRoutePolicy from "../extensions/model-route-policy.ts";
import { readHarnessProfiles } from "../src/harness-profiles.ts";

type Model = Parameters<typeof resolveWorkerSelection>[0];
const astra = { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] } as Model;
const sol = { ...astra, id: SOL_MODEL_ID, name: "GPT-6.1 Sol" };
const retired = { ...astra, id: "gpt-6-sol", name: "GPT-6 Sol" };
const aliases = ["gpt-6-sol", "openai-codex/gpt-6-sol", "steak-pi/gpt-6-sol", "gpt-6-sol-pro", "gpt-6-sol-900k", "gpt-6-sol-2026-09-01", "gpt-6.0-sol", "gpt-6-0-sol", "gpt-6.0-sol-900k", "GPT 6 Sol", "GPT-6.0 Sol", "GPT6 Sol"];
function registry(models = [astra, sol, retired]) {
  return {
    find: vi.fn((provider: string, id: string) => models.find(m => m.provider === provider && m.id === id)),
    isUsingOAuth: () => true, hasConfiguredAuth: () => true,
    getAvailable: () => models, getProvider: () => ({ streamSimple() {} }),
  };
}
const input = { goal: "bounded test", tasks: [{ label: "leaf", task: "test" }] };
function fixture(check: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "sol-ingestion-"));
  try { check(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function manifest(directory: string, profile: unknown) {
  writeFileSync(join(directory, "steak-pi.json"), JSON.stringify({ id: "steak-pi", schemaVersion: 1, profiles: [profile] }));
}
const profile = { id: "friendly", name: "Friendly", args: ["--model", SOL_MODEL_ROUTE, "--thinking", "medium"] };

describe("GPT-6.0 Sol retirement (2026-10-05)", () => {
  // The fixtures are Steak Pi manifests: never read the harness of the shell running the tests.
  beforeEach(() => { vi.stubEnv("ULTRATERM_HARNESS_ID", "steak-pi"); vi.stubEnv("ULTRATERM_HARNESS", "steak-pi"); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it.each(aliases)("rejects %s at profile ingestion and child resolution with one named error", alias => {
    fixture(directory => {
      manifest(directory, { ...profile, args: ["--model", alias, "--thinking", "medium"] });
      expect(() => loadWorkerProfiles(directory)).toThrow(RetiredModelSelectionError);
      expect(() => readProfiles(directory)).toThrow(RetiredModelSelectionError);
    });
    const r = registry();
    for (const field of ["model", "profile"] as const) {
      expect(() => resolveWorkerSelection(astra, "medium", { ...input, [field]: alias }, r as never, BUILTIN_WORKER_PROFILES, "")).toThrow(RetiredModelSelectionError);
      expect(() => normalizeDispatch({ ...input, [field]: alias }, process.cwd(), SOL_MODEL_ROUTE, "medium")).toThrow(RetiredModelSelectionError);
    }
    expect(r.find).not.toHaveBeenCalled();
  });
  it.each(["workerDefault", "reviewerDefault"])("rejects retired %s during ingestion and resolution", field => {
    fixture(directory => {
      manifest(directory, { ...profile, [field]: { profile: "steak-pi/gpt-6-sol" } });
      expect(() => loadWorkerProfiles(directory)).toThrow(RetiredModelSelectionError);
    });
    const profiles = [{ id: SOL_PROFILE, model: SOL_MODEL_ROUTE, [field]: { model: "openai-codex/gpt-6-sol" } }];
    const tasks = [{ label: "leaf", task: "test", role: field === "reviewerDefault" ? "reviewer" as const : "worker" as const }];
    expect(() => resolveWorkerSelection(sol, "medium", { ...input, tasks }, registry() as never, profiles, "")).toThrow(RetiredModelSelectionError);
  });
  it("rejects nested child selectors and registry aliases before generic selection errors", () => {
    const r = registry();
    for (const field of ["model", "profile"] as const) {
      const tasks = [{ ...input.tasks[0], [field]: "gpt-6-sol" }];
      expect(() => resolveWorkerSelection(astra, "medium", { ...input, tasks }, r as never, BUILTIN_WORKER_PROFILES, "")).toThrow(RetiredModelSelectionError);
    }
    r.find.mockReturnValue(retired);
    expect(() => resolveWorkerSelection(astra, "medium", { ...input, model: "openai-codex/friendly" }, r as never, BUILTIN_WORKER_PROFILES, "")).toThrow(RetiredModelSelectionError);
  });
  it("rejects retired profile identities even if remapped to 6.1; rejects aliases pointing to 6.0", () => {
    fixture(directory => {
      manifest(directory, { ...profile, id: "gpt-6-sol" });
      expect(() => loadWorkerProfiles(directory)).toThrow(RetiredModelSelectionError);
      expect(() => readProfiles(directory)).toThrow(RetiredModelSelectionError);
    });
    const profiles = [{ id: "steak-pi/friendly-sol", model: "openai-codex/gpt-6-sol" }];
    expect(() => resolveWorkerSelection(astra, "medium", { ...input, profile: profiles[0].id }, registry() as never, profiles, "")).toThrow(RetiredModelSelectionError);
  });
  it("routes Sol only to 6.1: explicit selection is exact, defaults stay on the 0.9.8 chain, never 6.0", () => {
    // 0.9.8 keeps every role default on the MiMo -> GPT-6.1 Sol chain; a Sol parent adds no Sol default.
    for (const role of ["worker", "reviewer"] as const) {
      const result = resolveWorkerSelection(sol, "high", { ...input, tasks: [{ label: "leaf", task: "test", role }] }, registry([astra, sol]) as never, BUILTIN_WORKER_PROFILES, "");
      expect(result.model).toBe(sol);
      expect(result.selection).toMatchObject({ modelId: SOL_MODEL_ID, source: "chain" });
      expect(result.selection.chainRoutes?.at(-1)).toBe(SOL_MODEL_ROUTE);
    }
    for (const selector of [{ profile: SOL_PROFILE }, { profile: "gpt-6-1-sol" }, { model: SOL_MODEL_ROUTE }]) {
      const result = resolveWorkerSelection(astra, "medium", { ...input, ...selector }, registry() as never, BUILTIN_WORKER_PROFILES, "");
      expect(result.model).toBe(sol);
      expect(result.selection).toMatchObject({ modelId: SOL_MODEL_ID, source: "override" });
    }
    expect(selectWorkerModel(sol, ["worker"], registry() as never)).toBe(sol);
    const r = registry([astra]);
    expect(() => resolveWorkerSelection(sol, "medium", input, r as never, BUILTIN_WORKER_PROFILES, "")).toThrow(/no fallback|no chain route/i);
  });
  it("refuses to spawn children from a retired parent even for an explicit non-retired route", () => {
    expect(() => resolveWorkerSelection(retired, "medium", { ...input, model: SOL_MODEL_ROUTE }, registry() as never, BUILTIN_WORKER_PROFILES, "")).toThrow(RetiredModelSelectionError);
    expect(() => resolveWorkerSelection({ ...astra, id: "opaque-alias", name: "GPT-6.0 Sol" }, "medium", input, registry() as never, BUILTIN_WORKER_PROFILES, "")).toThrow(RetiredModelSelectionError);
  });
  it("rejects retired resolved identities and opaque aliases at all request boundaries", async () => {
    const stream = vi.fn();
    const provider = { id: "openai-codex", getModels: () => [astra, sol, retired], stream, streamSimple: stream, fetchDeferred: stream, cancelDeferred: stream } as never;
    const guarded = guardProvider(provider, () => true);
    for (const model of [retired, { ...retired, id: "opaque-alias" }]) {
      expect(isModelRouteAllowed(model)).toBe(false);
      expect(() => assertModelRoute(model)).toThrow(RetiredModelSelectionError);
      expect(() => assertSubscriptionRequest(model, true)).toThrow(RetiredModelSelectionError);
      expect(() => guarded.stream(model, {} as never)).toThrow(RetiredModelSelectionError);
      expect(() => guarded.streamSimple(model, {} as never)).toThrow(RetiredModelSelectionError);
      expect(() => guarded.fetchDeferred!(model, {} as never)).toThrow(RetiredModelSelectionError);
      await expect(guarded.cancelDeferred!(model, {} as never)).rejects.toThrow(RetiredModelSelectionError);
    }
    expect(stream).not.toHaveBeenCalled();
  });
  it("rejects UI ingestion, hides retired native choices, and preserves Astra and non-Sol routes", () => {
    const request = { version: 1, action: "model", sessionId: "s", generation: "g", model: { provider: "openai-codex", id: "gpt-6-sol" }, thinking: "medium" };
    expect(() => decodeRequest(Buffer.from(JSON.stringify(request)).toString("base64url"))).toThrow(RetiredModelSelectionError);
    // The curated manifest scope names retired Sol too; retirement still hides it from the picker.
    const curated = [astra, sol, retired].map(m => ({ profileId: `steak-pi/${m.id}`, label: m.name, provider: m.provider, id: m.id, thinking: "medium" as const }));
    expect(catalogModels({ scopedModels: [], modelRegistry: registry() } as never, () => curated).map(m => m.id)).toEqual([astra.id, sol.id]);
    expect(() => catalogModels({ scopedModels: [], modelRegistry: registry() } as never, () => { throw new RetiredModelSelectionError(); })).toThrow(RetiredModelSelectionError);
    expect(resolveWorkerSelection(astra, "high", { ...input, model: "openai-codex/gpt-6-astra" }, registry() as never, BUILTIN_WORKER_PROFILES, "").model).toBe(astra);
    for (const id of ["gpt-6-luna", "claude-sonnet-4-6", "claude-opus-4-6", "mimo-v2.5", "deepseek-v4.1-flash"]) {
      const model = id.startsWith("gpt") ? { ...astra, id, name: id } : { ...astra, id, name: id, provider: "non-gpt", api: "openai-completions" } as Model;
      expect(resolveWorkerSelection(model, "medium", { ...input, model: `${model.provider}/${id}` }, registry([model]) as never, [], "").model).toBe(model);
    }
  });
  it("refuses a retired active model at every policy-extension hook, but accepts 6.1 Sol", () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    modelRoutePolicy({ registerFlag: vi.fn(), getFlag: () => undefined, on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(name, handler); } } as never);
    const modelRegistry = { getAll: () => [], getProvider: () => undefined, getRegisteredNativeProvider: () => undefined, registerProvider: vi.fn(), isUsingOAuth: () => true };
    for (const hook of ["session_start", "model_select", "before_agent_start", "session_before_compact"]) {
      expect(() => handlers.get(hook)!({ model: retired }, { model: retired, modelRegistry })).toThrow(RetiredModelSelectionError);
      expect(() => handlers.get(hook)!({ model: sol }, { model: sol, modelRegistry })).not.toThrow();
    }
  });
  it("refuses a retired profile in an otherwise ignorable or merged harness manifest, never a 6.1 one", () => {
    const named = (extra: Record<string, unknown>) => ({ id: "friendly", name: "Friendly", args: ["--model", SOL_MODEL_ROUTE, "--thinking", "medium"], ...extra });
    for (const entry of [named({ name: "GPT-6.0 Sol" }), named({ name: "GPT 6 Sol (old)" }), named({ id: "gpt-6-0-sol" }), named({ workerDefault: { model: "openai-codex/gpt-6.0-sol" } }), named({ args: ["--model=openai-codex/gpt-6-sol", "--thinking", "medium"] })]) {
      fixture(directory => {
        manifest(directory, entry);
        expect(() => readHarnessProfiles(directory, "steak-pi")).toThrow(RetiredModelSelectionError);
        expect(() => loadWorkerProfiles(directory)).toThrow(RetiredModelSelectionError);
      });
    }
    fixture(directory => {
      manifest(directory, named({ id: "gpt-6-1-sol", name: "GPT-6.1 Sol" }));
      expect(readHarnessProfiles(directory, "steak-pi").map(p => p.id)).toContain(SOL_MODEL_ID);
      expect(loadWorkerProfiles(directory).some(p => p.id === "steak-pi/gpt-6-1-sol")).toBe(true);
    });
  });
});

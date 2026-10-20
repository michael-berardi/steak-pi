import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire, findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  activeTemporaryWorkerRoute, assertTemporaryFreeRequest, ensureTemporaryFreeMetadata, FREE_BASE_URL, FREE_MODEL, FREE_PROFILE,
  protectTemporaryFreePayload, readTemporaryWorkerRoute, temporaryFreeOptions, temporaryFreeStartupProvider,
  TemporaryFreeRouteConfigError, TemporaryFreeRouteRequestError, TemporaryFreeRouteUnavailableError,
  TemporaryFreeRouteReturnToNormalError, TemporaryFreeRouteMetadataUnavailableError, RETURN_TO_NORMAL,
  validateTemporaryWorkerRoute, withTemporaryFreeCatalog, PREFERRED_FREE_PROFILE, selectPreferredFreePhysical,
} from "../src/temporary-free-route.ts";
import { BUILTIN_WORKER_PROFILES, resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import { guardModelRuntime, guardProvider } from "../src/model-route-policy.ts";
import modelRoutePolicy from "../extensions/model-route-policy.ts";
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = Date.parse("2026-10-20T14:00:00Z");
const config = () => ({ schemaVersion: 1, provider: "openrouter", model: FREE_MODEL, harness: "steak-pi", profile: "preferred-free", startsAt: "2026-10-20T13:00:00Z", expiresAt: "2026-10-22T12:01:04Z", fallbackHarness: "steak-pi", fallbackProfile: "gpt-6-1-sol", zeroPriceOnly: true, source: "authenticated coordinator synthetic approval", evidence: "official synthetic fixture" });
function catalogEntry(id: string) { return { id, name: id, pricing: { prompt: "0", completion: "0", request: "0", image: "0", input_cache_read: "0" }, supported_parameters: ["tools", "tool_choice", "reasoning"], architecture: { input_modalities: ["text"], output_modalities: ["text"] }, context_length: 128000, top_provider: { max_completion_tokens: 8192 } }; }
function officialFetch(id: string, mutate: (m: any) => void = () => {}, mutateEndpoints: (e: any) => void = () => {}) {
  return vi.fn(async (url: string) => {
    const m = catalogEntry(id); mutate(m);
    const endpoints = { id, endpoints: [{ pricing: m.pricing, supported_parameters: m.supported_parameters }] }; mutateEndpoints(endpoints);
    if (url !== `${FREE_BASE_URL}/models` && url !== `${FREE_BASE_URL}/models/${id.split("/").map(encodeURIComponent).join("/")}/endpoints`) throw new Error("unexpected network URL");
    return new Response(JSON.stringify({ data: url.endsWith("/endpoints") ? endpoints : [m] }), { status: 200 });
  });
}
function fixture() {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "steak-free-")); dirs.push(home);
  const directory = join(home, ".config", "ultraterm"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "temporary-worker-route.json"); writeFileSync(path, JSON.stringify(config()), { mode: 0o600 });
  vi.stubEnv("HOME", home); vi.useFakeTimers(); vi.setSystemTime(now);
  vi.stubGlobal("fetch", officialFetch(FREE_MODEL)); return { path, home };
}
type Model = Parameters<typeof assertTemporaryFreeRequest>[0];
const free = { provider: "openrouter", id: FREE_MODEL, name: "MiniMax free", api: "openai-completions", baseUrl: FREE_BASE_URL, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 } as Model;
const sol = { ...free, provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" } as Model;
const preferred = { ...free, provider: "steak-pi", id: "preferred-free", api: "pi-virtual" } as Model;
const registry = () => ({ find: (provider: string, id: string) => [free, sol, preferred].find(m => m.provider === provider && m.id === id), getAll: () => [free, sol, preferred], getAvailable: () => [free, sol, preferred], hasConfiguredAuth: () => true, isUsingOAuth: () => true, getProvider: () => ({ streamSimple() {} }) });
const input = { tasks: [{ label: "leaf", task: "synthetic", role: "worker" as const }] };
function nativeStream() {
  const sdk = findPackageJSON(import.meta.resolve("@earendil-works/pi-coding-agent"))!;
  const ai = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdk))!;
  return createRequire(sdk)(join(dirname(ai), "dist/utils/event-stream.js")).createAssistantMessageEventStream();
}
const receipt = (model: Model) => ({ role: "assistant", content: [{ type: "text", text: "synthetic" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: now });
describe("bounded generic approved free route", () => {
  it("normalizes canonical UTC milliseconds and admits generic data, retaining exact legacy alias", () => {
    expect(validateTemporaryWorkerRoute(config()).startsAt).toBe("2026-10-20T13:00:00.000Z");
    expect(validateTemporaryWorkerRoute({ ...config(), profile: "minimax-m3-1-flash-free" }).profile).toBe("minimax-m3-1-flash-free");
    expect(validateTemporaryWorkerRoute({ ...config(), model: "example/second-worker:free" }).model).toBe("example/second-worker:free");
  });
  it("checks inclusive start, exclusive expiry and absent files", () => {
    const { path } = fixture();
    expect(activeTemporaryWorkerRoute(path, Date.parse(config().startsAt) - 1)).toBeUndefined();
    expect(activeTemporaryWorkerRoute(path, Date.parse(config().startsAt))?.model).toBe(FREE_MODEL);
    expect(activeTemporaryWorkerRoute(path, Date.parse(config().expiresAt))).toBeUndefined();
    expect(readTemporaryWorkerRoute(path + ".missing")).toBeUndefined();
  });
  it.each([{ schemaVersion: 2 }, { unknown: true }, { provider: "other" }, { model: "minimax/minimax-m3.1-flash" }, { model: "openai/gpt-6.1-sol:free" }, { model: "vendor/gptfoo:free" }, { model: "vendor/gpt4:free" }, { model: "z-ai/glm-5.3:free" }, { model: "xiaomi/mimo-v2.6-flash:free" }, { model: "vendor/mimo-v3:free" }, { model: "openai/o3:free" }, { model: "anthropic/claude-sonnet-5.5:free" }, { model: "vendor/claude-free:free" }, { model: "deepseek/deepseek-v4.1-flash:free" }, { model: "deepseek/deepseek-flash-latest:free" }, { model: "https://evil.invalid/a:free" }, { zeroPriceOnly: false }, { expiresAt: "2026-10-24T14:00:00Z" }, { startsAt: "2026-02-30T13:00:00Z" }, { startsAt: "2026-10-20T13:00:00+00:00" }, { fallbackProfile: "paid" }, { evidence: "" }])("rejects malformed/forbidden fields %j", change => {
    expect(() => validateTemporaryWorkerRoute({ ...config(), ...change })).toThrow(TemporaryFreeRouteConfigError);
  });
  it("rejects duplicate/escaped keys, malformed, oversize, links and nonprivate file", () => {
    const { path, home } = fixture();
    for (const text of ["{", "x".repeat(16385), JSON.stringify(config()).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), JSON.stringify(config()).replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1')]) {
      writeFileSync(path, text); expect(() => readTemporaryWorkerRoute(path)).toThrow(TemporaryFreeRouteConfigError);
    }
    writeFileSync(path, JSON.stringify(config()));
    for (const mode of [0o644, 0o666, 0o400]) { chmodSync(path, mode); expect(() => readTemporaryWorkerRoute(path)).toThrow(TemporaryFreeRouteConfigError); }
    chmodSync(path, 0o600); const hard = join(home, "hard"); linkSync(path, hard); expect(() => readTemporaryWorkerRoute(path)).toThrow(TemporaryFreeRouteConfigError); rmSync(hard);
    const link = join(home, "link"); symlinkSync(path, link); expect(() => readTemporaryWorkerRoute(link)).toThrow(TemporaryFreeRouteConfigError);
    const dirlink = join(home, "dirlink"); symlinkSync(join(home, ".config"), dirlink); expect(() => readTemporaryWorkerRoute(join(dirlink, "ultraterm", "temporary-worker-route.json"))).toThrow(TemporaryFreeRouteConfigError);
  });
  it("observes atomic data replacement, never trusts a mutated cached object", () => {
    const { path } = fixture(); readTemporaryWorkerRoute(path)!.model = "tampered";
    expect(readTemporaryWorkerRoute(path)!.model).toBe(FREE_MODEL);
    const next = path + ".next"; writeFileSync(next, JSON.stringify({ ...config(), model: "example/atomic:free" }), { mode: 0o600 }); renameSync(next, path);
    expect(readTemporaryWorkerRoute(path)!.model).toBe("example/atomic:free");
    writeFileSync(path, "{"); expect(() => readTemporaryWorkerRoute(path)).toThrow(TemporaryFreeRouteConfigError);
  });
  it("selects implicit workers, preserves explicit/reviewer/harness/image rules and normal new-run selection", () => {
    fixture(); const choose = (extra = {}) => resolveWorkerSelection(sol, "high", { ...input, ...extra } as never, registry() as never, BUILTIN_WORKER_PROFILES, "", {}, {});
    expect(choose().selection).toMatchObject({ profile: PREFERRED_FREE_PROFILE, source: "profile-default", modelId: "preferred-free" });
    expect(choose({ model: "openai-codex/gpt-6.1-sol" }).selection).toMatchObject({ source: "override", modelId: sol.id });
    expect(choose({ profile: FREE_PROFILE }).model.id).toBe(FREE_MODEL);
    for (const extra of [{ harness: "pi" }, { tasks: [{ ...input.tasks[0], role: "reviewer" }] }]) expect(choose(extra).model.id).toBe(sol.id);
    expect(() => choose({ requireImages: true })).toThrow();
    vi.setSystemTime(Date.parse(config().expiresAt)); expect(choose().model.id).toBe(sol.id);
    expect(() => choose({ profile: FREE_PROFILE })).toThrow(TemporaryFreeRouteUnavailableError);
  });
  it("never routes unleased Sol: expiry/auth/price loss produce a named checkpoint-switch signal", async () => {
    const { path } = fixture(); const r = registry();
    expect((await selectPreferredFreePhysical(r)).model.id).toBe(FREE_MODEL);
    await expect(selectPreferredFreePhysical({ ...r, hasConfiguredAuth: () => false })).rejects.toThrow(RETURN_TO_NORMAL);
    const previous = r.find; r.find = (provider, id) => { const m = previous(provider, id); return m?.id === FREE_MODEL ? { ...m, cost: { ...m.cost, output: 1 } } : m; };
    await expect(selectPreferredFreePhysical(r)).rejects.toThrow(TemporaryFreeRouteReturnToNormalError);
    vi.setSystemTime(Date.parse(config().expiresAt)); await expect(selectPreferredFreePhysical(registry())).rejects.toThrow(RETURN_TO_NORMAL);
    writeFileSync(path, "{"); await expect(selectPreferredFreePhysical(registry())).rejects.toThrow(TemporaryFreeRouteConfigError);
  });
  it("requires exact model/endpoint/known zero price at dispatch", async () => {
    const { path } = fixture(); await ensureTemporaryFreeMetadata(FREE_MODEL);
    expect(() => assertTemporaryFreeRequest(free, path)).not.toThrow();
    for (const change of [{ baseUrl: FREE_BASE_URL + "/" }, { api: "anthropic-messages" }, { cost: undefined }, { cost: { ...free.cost, input: 1 } }]) expect(() => assertTemporaryFreeRequest({ ...free, ...change } as Model, path)).toThrow(TemporaryFreeRouteRequestError);
  });
  it("enforces all zero max prices after caller replacement and rechecks expiry", async () => {
    fixture(); await ensureTemporaryFreeMetadata(FREE_MODEL);
    const options = temporaryFreeOptions(free, { onPayload: (_payload: unknown, _model: Model) => ({ model: FREE_MODEL, provider: { allow_fallbacks: true, max_price: { prompt: 99 } } }) });
    const payload = await options.onPayload!({ model: FREE_MODEL }, free) as any;
    expect(payload.provider.allow_fallbacks).toBe(false); expect(payload.provider.require_parameters).toBe(true);
    expect(Object.values(payload.provider.max_price).every(p => p === 0)).toBe(true);
    expect(Object.keys(payload.provider.max_price)).toEqual(expect.arrayContaining(["prompt", "completion", "request", "image", "audio", "input_cache_read", "input_cache_write", "internal_reasoning", "web_search"]));
    expect(payload.reasoning).toEqual({ effort: "high" });
    vi.setSystemTime(Date.parse(config().expiresAt)); await expect(options.onPayload!({ model: FREE_MODEL }, free)).rejects.toThrow(TemporaryFreeRouteUnavailableError);
  });
  it.each([{ model: "minimax/minimax-m3.1-flash" }, { models: ["paid"] }, { route: "fallback" }, { plugins: [] }, { transforms: [] }, { tool_choice: "required" }, { tool_choice: "none" }, { web_search_options: {} }])("rejects alternate/paid payload %j", change => {
    expect(() => protectTemporaryFreePayload({ model: FREE_MODEL, ...change })).toThrow(TemporaryFreeRouteRequestError);
  });
  it.each(["paid", "missing-price", "unknown-price", "tools", "reasoning", "identity", "endpoints", "catalog-duplicate"])("refuses unsafe or unknown official metadata: %s", async kind => {
    fixture(); const id = `example/reject-${kind}:free`;
    const fetcher = officialFetch(id, m => {
      if (kind === "paid") m.pricing.completion = "0.001";
      if (kind === "missing-price") delete m.pricing.prompt;
      if (kind === "unknown-price") m.pricing.image = null;
      if (kind === "tools") m.supported_parameters = ["reasoning"];
      if (kind === "reasoning") m.supported_parameters = ["tools", "tool_choice"];
      if (kind === "identity") m.name = "GPT-6.1 Sol";
    }, e => { if (kind === "endpoints") e.endpoints = []; });
    const actual = kind === "catalog-duplicate" ? vi.fn(async () => new Response(JSON.stringify({ data: [catalogEntry(id), catalogEntry(id)] }))) : fetcher;
    await expect(ensureTemporaryFreeMetadata(id, actual as typeof fetch)).rejects.toThrow(TemporaryFreeRouteRequestError);
  });
  it("bounds metadata body/redirect/error handling and refuses unknown catalog entries", async () => {
    fixture();
    for (const [suffix, response] of [["unknown", new Response('{"data":[]}')], ["oversize", new Response("x".repeat(16 * 1024 * 1024 + 1))], ["http", new Response("", { status: 404 })]] as const) {
      await expect(ensureTemporaryFreeMetadata(`example/${suffix}:free`, vi.fn(async () => response) as typeof fetch)).rejects.toThrow(TemporaryFreeRouteRequestError);
    }
  });
  it.each([429, 503])("retains free preference on transient metadata HTTP %s without a normal-return signal", async status => {
    const { path } = fixture(); const id = `example/transient-${status}:free`;
    writeFileSync(path, JSON.stringify({ ...config(), model: id }));
    const fetcher = vi.fn(async () => new Response("", { status })); vi.stubGlobal("fetch", fetcher);
    await expect(selectPreferredFreePhysical(registry())).rejects.toThrow(TemporaryFreeRouteMetadataUnavailableError);
    expect(activeTemporaryWorkerRoute(path)?.model).toBe(id); expect(fetcher).toHaveBeenCalledTimes(1);
    const stream = vi.fn(); const physical = { ...free, id };
    const guarded = guardProvider({ id: "openrouter", getModels: () => [physical], stream, streamSimple: stream, auth: {} } as never, () => false);
    const result = await guarded.streamSimple(physical, { messages: [] } as never).result();
    expect(result.errorMessage).toContain(String(status)); expect(result.errorMessage).not.toContain(RETURN_TO_NORMAL); expect(stream).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent lazy metadata, caches it and refreshes only after TTL", async () => {
    fixture(); const id = "example/concurrent:free"; const fetcher = officialFetch(id);
    const models = await Promise.all([ensureTemporaryFreeMetadata(id, fetcher as typeof fetch), ensureTemporaryFreeMetadata(id, fetcher as typeof fetch)]);
    expect(models[0]).toBe(models[1]); expect(fetcher).toHaveBeenCalledTimes(2);
    await ensureTemporaryFreeMetadata(id, fetcher as typeof fetch); expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(now + 300001); await ensureTemporaryFreeMetadata(id, fetcher as typeof fetch); expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[0][0]).toBe(`${FREE_BASE_URL}/models`);
  });
  it.each(["revocation", "expiry"])("refuses %s races during lazy metadata without any model dispatch", async kind => {
    const { path } = fixture(); const id = `example/racing-${kind}:free`;
    writeFileSync(path, JSON.stringify({ ...config(), model: id }));
    const real = officialFetch(id); vi.stubGlobal("fetch", vi.fn(async (url: string) => { const response = await real(url); if (url.endsWith("/endpoints")) { if (kind === "revocation") rmSync(path); else vi.setSystemTime(Date.parse(config().expiresAt)); } return response; }));
    await expect(selectPreferredFreePhysical(registry())).rejects.toThrow(RETURN_TO_NORMAL);
  });
  it("startup virtual route rechecks continuation/retry/direct without reloading or falling back on 429/5xx", async () => {
    fixture(); let definition: any; const registerProvider = vi.fn();
    modelRoutePolicy({ registerProvider, registerVirtualModel: (value: unknown) => { definition = value; }, registerFlag: vi.fn(), on: vi.fn() } as never);
    expect(registerProvider).toHaveBeenCalledTimes(1); expect(definition.id).toBe("preferred-free");
    const ctx = { modelRegistry: registry() };
    for (const reason of ["user", "continuation", "retry", "direct"]) expect((await definition.route({ reason, failed: { message: { errorMessage: "429 503" } } }, ctx)).model.id).toBe(FREE_MODEL);
    vi.setSystemTime(Date.parse(config().expiresAt));
    for (const reason of ["continuation", "retry", "direct"]) await expect(definition.route({ reason }, ctx)).rejects.toThrow(RETURN_TO_NORMAL);
  });
  it("preserves built-in models/auth/transport and dynamic complete-provider metadata", () => {
    fixture(); const native = temporaryFreeStartupProvider(); expect(native.id).toBe("openrouter");
    expect(native.getModels().some(m => m.id === FREE_MODEL)).toBe(true); expect(native.getModels().some(m => m.id !== FREE_MODEL)).toBe(true);
    expect(native.auth).toBeDefined(); expect(withTemporaryFreeCatalog(native)).toBe(native);
    const auth = {}; const stream = () => undefined; const provider = { id: "openrouter", auth, stream, getModels: () => [sol] } as never;
    const augmented = withTemporaryFreeCatalog(provider); expect(augmented.auth).toBe(auth); expect(augmented.stream).toBe(stream); expect(augmented.getModels()[0]).toBe(sol);
  });
  it("proves second-model data hot-swap through native SDK with actual physical per-call receipts", async () => {
    const { path, home } = fixture(); vi.useRealTimers(); vi.stubEnv("OPENROUTER_API_KEY", "synthetic-non-secret");
    // Use a future-safe bounded synthetic permission relative to the real clock.
    const permission = { ...config(), startsAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
    writeFileSync(path, JSON.stringify(permission));
    const native = temporaryFreeStartupProvider();
    const transport = vi.fn((model: Model, _context: unknown, options: any) => {
      const output = nativeStream();
      void (async () => { try { await options.onPayload({ model: model.id }, model); const message = receipt(model); output.push({ type: "done", reason: "stop", message }); } catch (error) { output.push({ type: "error", reason: "error", error: { ...receipt(model), stopReason: "error", errorMessage: String(error) } }); } finally { output.end(); } })();
      return output;
    });
    const runtime = await ModelRuntime.create({ authPath: join(home, "auth.json"), modelsPath: null, modelsStorePath: join(home, "models-cache"), refreshOnCreate: false });
    runtime.registerNativeProvider({ ...native, stream: transport, streamSimple: transport } as never);
    guardModelRuntime(runtime); await runtime.setRuntimeApiKey("openrouter", "synthetic-non-secret");
    expect(await runtime.checkAuth("openrouter")).toBeDefined();
    await runtime.getAvailable();
    expect(runtime.hasConfiguredAuth("openrouter")).toBe(true);
    expect(runtime.getModel("openrouter", FREE_MODEL)?.id).toBe(FREE_MODEL);
    const guardedNative = runtime.getRegisteredNativeProvider("openrouter");
    for (let turn = 0; turn < 3; turn++) { guardModelRuntime(runtime); expect(runtime.getRegisteredNativeProvider("openrouter")).toBe(guardedNative); }
    const virtual = runtime.getModel("steak-pi", "preferred-free")!;
    const answer = async (reason: "user" | "continuation" | "retry" | "direct") => {
      const routed = await runtime.resolveModel(virtual, [], { reason, thinkingLevel: "high" });
      const message = await runtime.completeSimple(routed.model, { messages: [] });
      expect(message.provider).toBe("openrouter"); expect(message.model).toBe(routed.model.id); return message.model;
    };
    expect(await answer("user")).toBe(FREE_MODEL);
    const second = "example/second-native-worker:free"; vi.stubGlobal("fetch", officialFetch(second));
    writeFileSync(path, JSON.stringify({ ...permission, model: second }));
    for (const reason of ["continuation", "retry", "direct"] as const) expect(await answer(reason)).toBe(second);
    expect(runtime.getModel("openrouter", second)?.id).toBe(second);
    expect(transport).toHaveBeenCalledTimes(4);
    rmSync(path); await expect(runtime.resolveModel(virtual, [], { reason: "continuation", thinkingLevel: "high" })).rejects.toThrow(RETURN_TO_NORMAL);
    expect(transport).toHaveBeenCalledTimes(4); // Never dispatched Sol under the virtual worker's unleased namespace.
  });
  it("direct free dispatch lazily verifies metadata and refuses revocation before transport", async () => {
    const { path } = fixture(); const id = "example/direct-worker:free";
    writeFileSync(path, JSON.stringify({ ...config(), model: id })); vi.stubGlobal("fetch", officialFetch(id));
    const physical = { ...free, id }; const stream = vi.fn((m: Model) => { const s = nativeStream(); s.push({ type: "done", reason: "stop", message: receipt(m) }); s.end(); return s; });
    const provider = { id: "openrouter", getModels: () => [physical], stream, streamSimple: stream, auth: {} } as never;
    const guarded = guardProvider(provider, () => false, async () => { throw new Error("must not read Go credentials"); });
    const result = await guarded.streamSimple(physical, { messages: [] } as never).result(); expect(result.model).toBe(id); expect(stream).toHaveBeenCalledTimes(1);
    rmSync(path); expect(() => guarded.streamSimple(physical, { messages: [] } as never)).toThrow(TemporaryFreeRouteUnavailableError); expect(stream).toHaveBeenCalledTimes(1);
  });
});

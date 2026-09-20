import modelRoutePolicy from "../extensions/model-route-policy.ts";
import * as paidRoute from "../src/explicit-paid-route.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { createExplicitPaidApproval, PAID_ROUTE_FLAG } from "../src/explicit-paid-route.ts";
import { guardProvider, createRegistryGuard } from "../src/model-route-policy.ts";
import { beginGoAttempt, observeGoQuota, hasConfirmedGoExhaustion, SUBSCRIPTION_FIRST_ERROR } from "../src/subscription-first-routing.ts";

const sdk = findPackageJSON(import.meta.resolve("@earendil-works/pi-coding-agent"))!;
const ai = dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdk))!);
const { createAssistantMessageEventStream } = await import(pathToFileURL(join(ai, "dist/utils/event-stream.js")).href);
const { isRetryableAssistantError } = await import(pathToFileURL(join(ai, "dist/utils/retry.js")).href);
const { normalizeContext } = await import(pathToFileURL(join(ai, "dist/index.js")).href);
function emptyContext(): Parameters<Parameters<typeof guardProvider>[0]["streamSimple"]>[1] {
  const normalize = typeof normalizeContext === "function" ? normalizeContext : (context: { messages: never[] }) => context;
  return normalize({ messages: [] });
}
type Model = Parameters<Parameters<typeof guardProvider>[0]["streamSimple"]>[0];
const model = { provider: "inco", id: "glm-5.3-flash:fast", name: "GLM Fast", api: "openai-completions", baseUrl: "https://api.inco.ai/v1" } as Model;
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
function approval() {
  const dir = mkdtempSync(join(tmpdir(), "paid-route-test-")); dirs.push(dir);
  const path = join(dir, "paid-routes.json");
  writeFileSync(path, JSON.stringify({ version: 1, allow: [{ provider: model.provider, model: model.id, baseUrl: model.baseUrl }] }));
  return { path, approve: createExplicitPaidApproval("inco/glm-5.3-flash:fast", model, path) };
}
function provider() {
  const stream = vi.fn(() => {
    const output = createAssistantMessageEventStream();
    output.push({ type: "done", reason: "stop", message: { role: "assistant", stopReason: "stop", content: [], provider: model.provider, model: model.id } });
    output.end(); return output;
  });
  return { id: "inco", name: "Inco", getModels: () => [model], auth: {}, stream, streamSimple: stream } as unknown as Parameters<typeof guardProvider>[0];
}
const drain = async (stream: ReturnType<Parameters<typeof guardProvider>[0]["streamSimple"]>) => { const events = []; for await (const event of stream) events.push(event); return events; };
describe("explicit paid route permission", () => {
  it("requires launch intent, selected model and persistent exact route; revocation is immediate", () => {
    const { path, approve } = approval();
    expect(approve(model)).toBe(true);
    for (const changed of [{ provider: "openrouter" }, { id: "glm-5.3-flash" }, { baseUrl: model.baseUrl + "/" }, { baseUrl: model.baseUrl + "?proxy=1" }]) expect(approve({ ...model, ...changed })).toBe(false);
    expect(createExplicitPaidApproval(undefined, model, path)(model)).toBe(false);
    expect(createExplicitPaidApproval("inco/glm-5.3-flash:fast", { ...model, provider: "openrouter" }, path)(model)).toBe(false);
    writeFileSync(path, "{}"); expect(approve(model)).toBe(false);
    writeFileSync(path, "invalid"); expect(approve(model)).toBe(false);
  });
  it("allows explicit Inco with Go available, creates no quota evidence, and blocks automatic requests", async () => {
    beginGoAttempt(); const key = "synthetic-test-key";
    const base = provider(); const { approve } = approval();
    const allowed = guardProvider(base, () => false, async () => key, undefined, undefined, approve);
    expect((await drain(allowed.streamSimple(model, emptyContext())))[0].type).toBe("done");
    expect(hasConfirmedGoExhaustion(key)).toBe(false);
    const denied = guardProvider(base, () => false, async () => key);
    const events = await drain(denied.streamSimple(model, emptyContext()));
    expect(events[0]).toMatchObject({ type: "error", error: { errorMessage: SUBSCRIPTION_FIRST_ERROR } });
    expect(base.streamSimple).toHaveBeenCalledTimes(1);
    expect(isRetryableAssistantError((events[0] as any).error)).toBe(false);
    expect(isRetryableAssistantError({ stopReason: "error", errorMessage: "HTTP 429" })).toBe(true);
  });
  it("rebinds parent guards without carrying paid approval into a worker registry", async () => {
    const base = provider(); let current = base;
    const registry = { getAll: () => [model], getProvider: () => current,
      getRegisteredNativeProvider: () => current, registerProvider: (p: typeof base) => { current = p; },
      isUsingOAuth: () => false, getProviderAuth: async () => ({ source: "env", auth: { apiKey: "synthetic-go" } }) };
    const { approve } = approval();
    createRegistryGuard(approve)(registry as never);
    await drain(current.streamSimple(model, emptyContext()));
    createRegistryGuard()(registry as never);
    expect((await drain(current.streamSimple(model, emptyContext())))[0].type).toBe("error");
    expect(base.streamSimple).toHaveBeenCalledTimes(1);
  });
  it("paid approval never overrides GPT endpoint policy", () => {
    const guarded = guardProvider(provider(), () => false, async () => "go", undefined, undefined, () => true);
    expect(() => guarded.streamSimple({ ...model, id: "gpt-6-astra" }, emptyContext())).toThrow(/GPT-family/);
  });
  it("requires structured quota evidence and revokes stale/concurrent grants", () => {
    const now = Date.now(); const key = "unit-test-only";
    const attempt = beginGoAttempt();
    observeGoQuota(key, "error", "429 temporary rate limit", now, attempt);
    expect(hasConfirmedGoExhaustion(key, now)).toBe(false);
    const evidence = JSON.stringify({ error: { status: 429, code: "subscription_quota_exceeded", scope: "subscription", remaining: 0, reset_at: new Date(now + 600_000).toISOString() } });
    observeGoQuota(key, "error", evidence, now, attempt);
    expect(hasConfirmedGoExhaustion(key, now)).toBe(true);
    expect(hasConfirmedGoExhaustion("other-credential", now)).toBe(false);
    expect(hasConfirmedGoExhaustion(key, now + 300_001)).toBe(false);
    observeGoQuota(key, "error", evidence, now, attempt);
    beginGoAttempt();
    observeGoQuota(key, "error", evidence, now, attempt);
    expect(hasConfirmedGoExhaustion(key, now)).toBe(false);
  });
});


describe("policy extension launch-only paid authorization", () => {
  const go = { ...model, provider: "opencode-go", id: "glm-5.3" };
  const launchFlag = "inco/glm-5.3-flash:fast";
  const transitions = [
    ["model_select", "set"],
    ["model_select", "cycle"],
    ["model_select", "restore"],
    ["before_agent_start", undefined],
    ["session_before_compact", undefined],
  ] as const;
  afterEach(() => vi.restoreAllMocks());

  function setup(flag: string | undefined, initialModel: Model) {
    const { path } = approval();
    const create = paidRoute.createExplicitPaidApproval;
    const factory = vi.spyOn(paidRoute, "createExplicitPaidApproval")
      .mockImplementation((intent, selected) => create(intent, selected, path));
    const base = provider();
    let current = base;
    const registry = {
      getAll: () => [model], getProvider: () => current,
      getRegisteredNativeProvider: () => current,
      registerProvider: (next: typeof base) => { current = next; },
      isUsingOAuth: () => false,
      getProviderAuth: vi.fn(async () => ({ source: "env", auth: { apiKey: "synthetic-extension-go" } })),
    };
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const registerFlag = vi.fn();
    const getFlag = vi.fn(() => flag);
    modelRoutePolicy({ registerFlag, getFlag,
      on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, handler),
    } as any);
    const ctx = { mode: "tui", hasUI: true, model: initialModel, sessionManager: {},
      isIdle: () => true, modelRegistry: registry, ui: { confirm: vi.fn(async () => true) } };
    const emit = async (name: string, source?: string) => {
      expect(handlers.has(name)).toBe(true);
      await handlers.get(name)!({ model: ctx.model, source }, ctx);
    };
    const dispatch = async (expected: "done" | "error") => {
      for (const method of ["stream", "streamSimple"] as const) {
        const events = await drain(current[method](model, emptyContext()));
        if (expected === "error") {
          expect(events[0]).toMatchObject({ type: "error", error: { errorMessage: SUBSCRIPTION_FIRST_ERROR } });
          expect(isRetryableAssistantError((events[0] as any).error)).toBe(false);
        } else expect(events[0].type).toBe("done");
      }
    };
    expect(registerFlag).toHaveBeenCalledWith(PAID_ROUTE_FLAG, expect.objectContaining({ type: "string" }));
    return { base, ctx, emit, dispatch, factory, getFlag,
      replaceProvider: () => { current = base; } };
  }

  for (const [reason, flag, initial] of [
    ["missing flag", undefined, model],
    ["wrong initial launch model", launchFlag, go],
  ] as const) {
    it.each(transitions)(`${reason}: %s/%s cannot authorize paid dispatch`, async (event, source) => {
      const h = setup(flag, initial);
      await h.emit("session_start");
      expect(h.getFlag).toHaveBeenCalledWith(PAID_ROUTE_FLAG);
      expect(h.factory).toHaveBeenCalledWith(flag, initial);
      await h.dispatch("error");
      h.ctx.model = model;
      // A fresh native registration must also be protected by each event hook.
      h.replaceProvider();
      await h.emit(event, source);
      await h.dispatch("error");
      expect(h.factory).toHaveBeenCalledTimes(1);
      expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
      expect(h.base.streamSimple).not.toHaveBeenCalled();
    });
  }

  it("preserves an approved flagged Inco launch across selection, agent and compaction events", async () => {
    beginGoAttempt();
    const h = setup(launchFlag, model);
    await h.emit("session_start");
    await h.dispatch("done");
    for (const [event, source] of transitions) {
      h.replaceProvider();
      await h.emit(event, source);
      await h.dispatch("done");
    }
    expect(h.base.streamSimple).toHaveBeenCalledTimes(12);
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(hasConfirmedGoExhaustion("synthetic-extension-go")).toBe(false);
  });

  it.each(["missing flag", "wrong initial model"])("session replacement clears previous approval: %s", async reason => {
    const h = setup(launchFlag, model);
    await h.emit("session_start");
    await h.dispatch("done");
    expect(h.base.streamSimple).toHaveBeenCalledTimes(2);
    vi.mocked(h.base.streamSimple).mockClear();
    h.ctx.sessionManager = {};
    if (reason === "missing flag") h.getFlag.mockReturnValue(undefined);
    else h.ctx.model = go;
    // Keep the old guarded provider to exercise rebinding of its approval closure.
    await h.emit("session_start");
    await h.dispatch("error");
    h.ctx.model = model;
    for (const [event, source] of transitions) {
      await h.emit(event, source);
      await h.dispatch("error");
    }
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(h.base.streamSimple).not.toHaveBeenCalled();
  });
});

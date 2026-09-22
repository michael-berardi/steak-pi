import modelRoutePolicy from "../extensions/model-route-policy.ts";
import * as paidRoute from "../src/explicit-paid-route.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { createAllowlistApproval, createExplicitPaidApproval, createSelectedRouteApproval, isAllowlistedPaidRoute, PAID_INCO_BASE_URL, PAID_ROUTES, PAID_ROUTE_FLAG, readApprovedPaidRoutes } from "../src/explicit-paid-route.ts";
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
  return approvalFor("inco/glm-5.3-flash:fast", model);
}
function approvalFor(flag: string, target: Model, allow: unknown[] = [{ provider: target.provider, model: target.id, baseUrl: target.baseUrl }]) {
  const dir = mkdtempSync(join(tmpdir(), "paid-route-test-")); dirs.push(dir);
  const path = join(dir, "paid-routes.json");
  writeFileSync(path, JSON.stringify({ version: 1, allow }));
  return { path, approve: createExplicitPaidApproval(flag, target, path) };
}
function providerFor(target: Model) {
  const stream = vi.fn(() => {
    const output = createAssistantMessageEventStream();
    output.push({ type: "done", reason: "stop", message: { role: "assistant", stopReason: "stop", content: [], provider: target.provider, model: target.id } });
    output.end(); return output;
  });
  return { id: target.provider, name: "Inco", getModels: () => [target], auth: {}, stream, streamSimple: stream } as unknown as Parameters<typeof guardProvider>[0];
}
function provider() {
  return providerFor(model);
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

  const deepseek = { provider: "inco", id: "deepseek-v4.1-flash:fast", name: "DeepSeek V4.1 Flash Fast", api: "openai-completions", baseUrl: PAID_INCO_BASE_URL } as Model;
  const deepseekFlag = "inco/deepseek-v4.1-flash:fast";

  it("requires the exact flag, model and verified https://api.inco.ai/v1 endpoint for Inco DeepSeek", () => {
    expect(PAID_ROUTES).toEqual([
      { provider: "inco", id: "glm-5.3-flash:fast", baseUrl: PAID_INCO_BASE_URL },
      { provider: "inco", id: "deepseek-v4.1-flash:fast", baseUrl: PAID_INCO_BASE_URL },
      { provider: "xiaomi", id: "mimo-v2.6-pro", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
      { provider: "xiaomi", id: "mimo-v2.6-flash", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
    ]);
    const { path, approve } = approvalFor(deepseekFlag, deepseek);
    expect(approve(deepseek)).toBe(true);
    for (const changed of [
      { provider: "openrouter" }, { provider: "opencode-go" }, { provider: "inco", id: "deepseek-v4.1-flash" },
      { id: "deepseek-v4.1-flash:fast:extra" }, { id: "deepseek-v4.1-flash:fast " }, { id: "openrouter/deepseek-v4.1-flash:fast" },
      { baseUrl: "https://api.inco.ai/v1/" }, { baseUrl: "https://api.inco.ai/v1?proxy=1" }, { baseUrl: "https://api.inco.ai/v1#x" },
      { baseUrl: "http://api.inco.ai/v1" }, { baseUrl: "https://api.inco.ai" }, { baseUrl: "https://api.inco.ai:443/v1" },
      { baseUrl: "https://user:secret@api.inco.ai/v1" }, { baseUrl: "https://inco.ai/v1" }, { baseUrl: "https://evil.example/v1" },
    ]) expect(approve({ ...deepseek, ...changed }), JSON.stringify(changed)).toBe(false);
    // Launch intent alone, a mismatched selection, or another product's flag never grants this route.
    expect(createExplicitPaidApproval(undefined, deepseek, path)(deepseek)).toBe(false);
    expect(createExplicitPaidApproval(deepseekFlag, undefined, path)(deepseek)).toBe(false);
    expect(createExplicitPaidApproval(deepseekFlag, { ...deepseek, baseUrl: "https://api.inco.ai/v1/" }, path)(deepseek)).toBe(false);
    expect(createExplicitPaidApproval("inco/glm-5.3-flash:fast", deepseek, path)(deepseek)).toBe(false);
    expect(createExplicitPaidApproval(deepseekFlag, model, path)(deepseek)).toBe(false);
    expect(createExplicitPaidApproval(deepseekFlag, { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go" }, path)(deepseek)).toBe(false);
    expect(createExplicitPaidApproval(`${deepseekFlag}\u00a0`, deepseek, path)(deepseek)).toBe(false);
    // The user allowlist must carry this exact route; the sibling entry does not satisfy it.
    expect(approvalFor(deepseekFlag, deepseek, [{ provider: "inco", model: "glm-5.3-flash:fast", baseUrl: PAID_INCO_BASE_URL }]).approve(deepseek)).toBe(false);
    expect(approvalFor(deepseekFlag, deepseek, [{ provider: "inco", model: "deepseek-v4.1-flash:fast", baseUrl: "https://api.inco.ai/v1/" }]).approve(deepseek)).toBe(false);
    // Revocation is immediate for this route too.
    writeFileSync(path, "{}"); expect(approve(deepseek)).toBe(false);
  });

  it("pins Xiaomi Token Plan approvals to Singapore and never grants PAYG or automatic routing", () => {
    for (const id of ["mimo-v2.6-pro", "mimo-v2.6-flash"]) {
      const selected = { ...model, provider: "xiaomi", id, baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" } as Model;
      const { path, approve } = approvalFor(`xiaomi/${id}`, selected);
      expect(approve(selected)).toBe(true);
      expect(createExplicitPaidApproval(undefined, selected, path)(selected)).toBe(false);
      for (const baseUrl of ["https://api.xiaomimimo.com/v1", "https://token-plan-cn.xiaomimimo.com/v1", "https://token-plan-sgp.xiaomimimo.com/v1/"]) expect(approve({ ...selected, baseUrl })).toBe(false);
      expect(approve({ ...selected, id: "mimo-v2.6-pro-ultraspeed" })).toBe(false);
      writeFileSync(path, "{}"); expect(approve(selected)).toBe(false);
    }
  });

  it("never crosses the two paid products or widens into automatic routing", async () => {
    beginGoAttempt(); const key = "synthetic-deepseek-key";
    const base = providerFor(deepseek); const { approve } = approvalFor(deepseekFlag, deepseek);
    const allowed = guardProvider(base, () => false, async () => key, undefined, undefined, approve);
    expect((await drain(allowed.streamSimple(deepseek, emptyContext())))[0].type).toBe("done");
    expect(hasConfirmedGoExhaustion(key)).toBe(false);
    // No approval, and an approval for the sibling product, both stay blocked.
    for (const approvalFn of [undefined, approval().approve]) {
      const guarded = guardProvider(base, () => false, async () => key, undefined, undefined, approvalFn);
      expect((await drain(guarded.streamSimple(deepseek, emptyContext())))[0]).toMatchObject({ type: "error", error: { errorMessage: SUBSCRIPTION_FIRST_ERROR } });
    }
    expect(base.streamSimple).toHaveBeenCalledTimes(1);
    // The GLM launch approval is not broadened by the DeepSeek entry existing.
    const glm = approval();
    expect(glm.approve(model)).toBe(true);
    expect(glm.approve(deepseek)).toBe(false);
    expect(approve(deepseek)).toBe(true);
    expect(approve(model)).toBe(false);
  });
});


describe("operator /model paid authorization across all approved profiles", () => {
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

  function setup(flag: string | undefined, initialModel: Model, allow: unknown[] = [{ provider: model.provider, model: model.id, baseUrl: model.baseUrl }]) {
    const { path } = approvalFor(launchFlag, model, allow);
    const createLaunch = paidRoute.createExplicitPaidApproval;
    const createSelected = paidRoute.createSelectedRouteApproval;
    const factory = vi.spyOn(paidRoute, "createExplicitPaidApproval")
      .mockImplementation((intent, selected) => createLaunch(intent, selected, path));
    vi.spyOn(paidRoute, "createSelectedRouteApproval")
      .mockImplementation(getSelected => createSelected(getSelected, path));
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
    return { base, ctx, emit, dispatch, factory, getFlag, path,
      replaceProvider: () => { current = base; } };
  }

  it("authorizes an allowlisted route switched in through /model without any launch flag", async () => {
    const h = setup(undefined, go);
    await h.emit("session_start");
    expect(h.getFlag).toHaveBeenCalledWith(PAID_ROUTE_FLAG);
    expect(h.factory).toHaveBeenCalledWith(undefined, go);
    // The launch route is not the allowlisted paid route, so dispatch stays blocked.
    await h.dispatch("error");
    h.ctx.model = model;
    for (const [event, source] of transitions) {
      h.replaceProvider();
      await h.emit(event, source);
      await h.dispatch("done");
    }
    expect(h.base.streamSimple).toHaveBeenCalledTimes(10);
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(hasConfirmedGoExhaustion("synthetic-extension-go")).toBe(false);
  });

  it("never authorizes a selected route the user allowlist does not carry", async () => {
    const h = setup(undefined, model, []);
    await h.emit("session_start");
    await h.dispatch("error");
    h.ctx.model = model;
    for (const [event, source] of transitions) {
      h.replaceProvider();
      await h.emit(event, source);
      await h.dispatch("error");
    }
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.base.streamSimple).not.toHaveBeenCalled();
  });

  it("requires the exact reviewed endpoint, not a sibling entry or a near miss", async () => {
    const h = setup(undefined, model, [
      { provider: "inco", model: "glm-5.3-flash:fast", baseUrl: `${PAID_INCO_BASE_URL}/` },
    ]);
    await h.emit("session_start");
    await h.dispatch("error");
    h.ctx.model = model;
    for (const [event, source] of transitions) {
      await h.emit(event, source);
      await h.dispatch("error");
    }
    expect(h.base.streamSimple).not.toHaveBeenCalled();
  });

  it("keeps a launch-flag grant while the flagged route stays selected, and honors revocation", async () => {
    const h = setup(launchFlag, model);
    await h.emit("session_start");
    await h.dispatch("done");
    expect(h.base.streamSimple).toHaveBeenCalledTimes(2);
    vi.mocked(h.base.streamSimple).mockClear();
    // The user revokes the route; the re-launched session re-reads the file.
    writeFileSync(h.path, JSON.stringify({ version: 1, allow: [] }));
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

describe("reviewed-route allowlist reads", () => {
  const deepseek = { ...model, id: "deepseek-v4.1-flash:fast" };
  function tempAllow(allow: unknown, version = 1) {
    const dir = mkdtempSync(join(tmpdir(), "paid-route-allow-")); dirs.push(dir);
    const path = join(dir, "paid-routes.json");
    writeFileSync(path, JSON.stringify({ version, allow }));
    return path;
  }

  it("fails closed on missing, malformed, wrong-version, or unreviewed allowlists", () => {
    const missing = join(tmpdir(), "paid-routes-absent.json");
    expect(readApprovedPaidRoutes(missing)).toEqual([]);
    expect(isAllowlistedPaidRoute(model, missing)).toBe(false);
    expect(createAllowlistApproval(missing)(model)).toBe(false);
    expect(readApprovedPaidRoutes(tempAllow([{ provider: "inco", model: "glm-5.3-flash:fast", baseUrl: PAID_INCO_BASE_URL }], 2))).toEqual([]);
    // Entries outside the reviewed table are never promoted into reviewed routes.
    expect(readApprovedPaidRoutes(tempAllow([
      { provider: "openai-codex", model: "gpt-6-astra", baseUrl: "https://chatgpt.com/backend-api" },
      { provider: "inco", model: "glm-5.3-flash:fast", baseUrl: `${PAID_INCO_BASE_URL}/` },
    ]))).toEqual([]);
  });

  it("resolves only exact reviewed identities into the allowlist", () => {
    const path = tempAllow([
      { provider: "inco", model: "glm-5.3-flash:fast", baseUrl: PAID_INCO_BASE_URL },
      { provider: "xiaomi", model: "mimo-v2.6-pro", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
      { provider: "inco", model: "glm-5.3-flash:fast", baseUrl: "https://api.inco.ai/v2" },
    ]);
    expect(readApprovedPaidRoutes(path)).toEqual([
      { provider: "inco", id: "glm-5.3-flash:fast", baseUrl: PAID_INCO_BASE_URL },
      { provider: "xiaomi", id: "mimo-v2.6-pro", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" },
    ]);
    expect(isAllowlistedPaidRoute(model, path)).toBe(true);
    expect(createAllowlistApproval(path)(model)).toBe(true);
    expect(isAllowlistedPaidRoute(deepseek, path)).toBe(false);
  });

  it("scopes selection approval to the exact allowlisted route currently selected", () => {
    const path = tempAllow([{ provider: "inco", model: "glm-5.3-flash:fast", baseUrl: PAID_INCO_BASE_URL }]);
    let selected: typeof model | undefined = model;
    const approve = createSelectedRouteApproval(() => selected, path);
    expect(approve(model)).toBe(true);
    expect(approve(deepseek)).toBe(false);
    expect(approve({ ...model, baseUrl: `${PAID_INCO_BASE_URL}/` })).toBe(false);
    selected = deepseek;
    expect(approve(model)).toBe(false);
    selected = undefined;
    expect(approve(model)).toBe(false);
    expect(createSelectedRouteApproval(() => model, tempAllow([]))(model)).toBe(false);
  });
});


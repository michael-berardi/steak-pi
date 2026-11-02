// Steak Pi with NO operator configuration: no chain, profile, expert, paid route, retirement,
// catalog extra, hidden model, quota tier, subscription endpoint or Claude default. An implicit
// dispatch fails naming the config key; explicit selectors are still served; the tool starts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { catalogExtras, catalogStartupProviders } from "../src/catalog-extras.ts";
import { createAllowlistApproval, createExplicitPaidApproval, findPaidRoute, isAllowlistedPaidRoute, readApprovedPaidRoutes, reviewedPaidRoutes } from "../src/explicit-paid-route.ts";
import { expertReviewModel, isModelRouteAllowed, multimodalWorkerChain, selectWorkerThinking, textWorkerChain } from "../src/model-route-policy.ts";
import { isHiddenModel } from "../src/model-visibility.ts";
import { isRetiredModelSelector } from "../src/retired-model-selection.ts";
import { routingConfig, RoutingConfigError, setRoutingConfigOverride } from "../src/routing-config.ts";
import { isSubscriptionOrLocalRoute } from "../src/subscription-first-routing.ts";
import { claudeFallbackTier, configuredWorkerProfiles, defaultClaudeCodeRoute, loadWorkerProfiles, resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import { quotaChain, quotaProviderOf } from "../src/subagents/provider-quota.ts";
import { ensureOf, withProfileEnsure } from "../src/subagents/profile-ensure.ts";
import { analyzeWaveClasses, configuredTaskClass } from "../src/subagents/task-class.ts";
import { BUILTIN_WORKER_PROFILES } from "../src/subagents/model-selection.ts";
import { implicitReviewRoute } from "../src/subagents/reviewer-fallback.ts";
import modelRoutePolicy from "../extensions/model-route-policy.ts";

type Model = Parameters<typeof resolveWorkerSelection>[0];
const dir = mkdtempSync(join(tmpdir(), "steak-pi-neutral-"));
const env = { routing: process.env.STEAK_PI_ROUTING_CONFIG, paid: process.env.STEAK_PI_PAID_ROUTES };
const empty = join(dir, "absent");

const parent = { provider: "provider-a", id: "parent-model", name: "Parent", api: "openai-completions", baseUrl: "https://provider-a.example/v1", input: ["text"] } as Model;
const worker = { ...parent, id: "model-name", name: "Model name" } as Model;
const vision = { ...parent, id: "vision-model", name: "Vision", input: ["text", "image"] } as Model;
const registry = (models = [parent, worker, vision]) => ({
  find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
  getAvailable: vi.fn(() => models),
  hasConfiguredAuth: vi.fn(() => true),
  isUsingOAuth: vi.fn(() => false),
  getProvider: vi.fn(() => ({ streamSimple() {} })),
});
const dispatch = (extra: Record<string, unknown> = {}) => ({ goal: "neutral", tasks: [{ label: "leaf", task: "test" }], ...extra });
const select = (extra: Record<string, unknown> = {}, r = registry()) =>
  resolveWorkerSelection(parent, "high", dispatch(extra) as never, r as never, loadWorkerProfiles(empty), "", {}, {});

beforeAll(() => {
  // Point both operator files at paths that do not exist: the shipped defaults alone.
  process.env.STEAK_PI_ROUTING_CONFIG = join(dir, "routing.json");
  process.env.STEAK_PI_PAID_ROUTES = join(dir, "paid-routes.json");
});
afterEach(() => {
  setRoutingConfigOverride(undefined);
  rmSync(join(dir, "routing.json"), { force: true });
  rmSync(join(dir, "paid-routes.json"), { force: true });
});
afterAll(() => {
  process.env.STEAK_PI_ROUTING_CONFIG = env.routing;
  process.env.STEAK_PI_PAID_ROUTES = env.paid;
  rmSync(dir, { recursive: true, force: true });
});

describe("shipped defaults are empty", () => {
  it("names no chain, expert, profile, retirement, catalog extra, hidden route or quota tier", () => {
    expect(routingConfig()).toEqual({});
    expect(textWorkerChain()).toEqual([]);
    expect(multimodalWorkerChain()).toEqual([]);
    expect(expertReviewModel()).toBeUndefined();
    // Only the neutral virtual temporary-free profile is built in; it names no model.
    expect(configuredWorkerProfiles().map((profile) => profile.id)).toEqual(["steak-pi/preferred-free"]);
    expect(configuredWorkerProfiles()[0].model).toBe("steak-pi/preferred-free");
    expect(isRetiredModelSelector("provider-a/any-model")).toBe(false);
    expect(catalogExtras()).toEqual([]);
    expect(catalogStartupProviders()).toEqual([]);
    expect(isHiddenModel({ provider: "provider-b", id: "any-model" })).toBe(false);
    expect(quotaChain()).toEqual([]);
    expect(quotaProviderOf({ provider: "provider-a", id: "model-name" })).toBeUndefined();
    expect(implicitReviewRoute()).toBeUndefined();
    expect(claudeFallbackTier({ tasks: [{ role: "worker" }] })).toBeUndefined();
    expect(() => defaultClaudeCodeRoute([{ role: "worker" }])).toThrow(/No Claude Code model configured: set claudeCodeDefaults\.worker/);
    expect(() => defaultClaudeCodeRoute([{ role: "reviewer" }])).toThrow(/claudeCodeDefaults\.reviewer/);
  });

  it("treats only local endpoints and the Claude Code CLI adapter as subscription routes, and pins no family", () => {
    expect(isSubscriptionOrLocalRoute({ provider: "provider-a", baseUrl: "https://provider-a.example/v1" }, true)).toBe(false);
    expect(isSubscriptionOrLocalRoute({ provider: "local", baseUrl: "http://127.0.0.1:8080/v1" }, false)).toBe(true);
    expect(isSubscriptionOrLocalRoute({ provider: "claude-code", baseUrl: "process://claude-code" }, false)).toBe(true);
    expect(isModelRouteAllowed({ provider: "provider-b", id: "family-x-1" })).toBe(true);
    expect(selectWorkerThinking({ id: "any-model" }, "low")).toBe("low");
  });

  it("reviews and grants no paid route without the operator's paid-routes.json", () => {
    const route = { provider: "provider-b", id: "model-name", baseUrl: "https://gateway.example/api/v1" };
    expect(reviewedPaidRoutes()).toEqual([]);
    expect(findPaidRoute(route)).toBeUndefined();
    expect(readApprovedPaidRoutes()).toEqual([]);
    expect(isAllowlistedPaidRoute(route)).toBe(false);
    expect(createAllowlistApproval()(route)).toBe(false);
    expect(createExplicitPaidApproval("provider-b/model-name", route)(route)).toBe(false);
  });
});

describe("task classes and ensure hooks ship empty", () => {
  it("configures no class, no chain for a class and no launch hook", () => {
    expect(routingConfig().taskClasses).toBeUndefined();
    expect(configuredTaskClass("any-class")).toBeUndefined();
    expect(configuredWorkerProfiles().some((profile) => "ensure" in profile)).toBe(false);
    expect(BUILTIN_WORKER_PROFILES.some((profile) => "ensure" in profile)).toBe(false);
    expect(ensureOf({ model: "provider-a/model-name", selection: { profile: "steak-pi/preferred-free", provider: "steak-pi", modelId: "preferred-free", source: "chain", images: false, tools: true } })).toBeUndefined();
  });

  it("ignores a declared class with nothing configured, and routes exactly as without it", () => {
    const wave = analyzeWaveClasses([{ label: "leaf", taskClass: "any-class" }], { refuseConflict: true });
    expect(wave.active).toBeUndefined();
    expect(wave.unknown).toEqual(["any-class"]);
    // The class is not an input of selection at all: an implicit dispatch fails with the same config key.
    expect(() => select({ tasks: [{ label: "leaf", task: "test", taskClass: "any-class" }] })).toThrow("No text worker chain configured: set textWorkerChain in ~/.config/ultraterm/routing.json.");
  });

  it("runs a profile launch with no hook straight through to the worker", async () => {
    const runner = vi.fn(async () => ({ state: "done" as const, output: "", turns: 0, usage: {} as never }));
    const run = { id: "run-1", model: "steak-pi/preferred-free", selection: { profile: "steak-pi/preferred-free" } } as never;
    await withProfileEnsure(runner)({ run, task: {} as never, signal: new AbortController().signal, onProgress: () => {} });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});

describe("implicit and explicit dispatch with no configuration", () => {
  it("fails an implicit dispatch with the config key to set", () => {
    expect(() => select()).toThrow("No text worker chain configured: set textWorkerChain in ~/.config/ultraterm/routing.json.");
    expect(() => select({ requireImages: true })).toThrow("No multimodal worker chain configured: set multimodalWorkerChain in ~/.config/ultraterm/routing.json.");
    expect(() => select({ tasks: [{ label: "review", task: "review", role: "reviewer" }] })).toThrow(/set textWorkerChain/);
  });

  it("still serves an explicit model exactly", () => {
    const result = select({ model: "provider-a/model-name" });
    expect(result.model).toBe(worker);
    expect(result.selection.source).toBe("override");
    expect(result.selection.chainRoutes).toBeUndefined();
  });

  it("resolves a configured chain once the operator supplies one", () => {
    setRoutingConfigOverride({ textWorkerChain: ["provider-a/model-name"] });
    // A metered https route is neither subscription nor reviewed: the chain refuses it.
    expect(() => select()).toThrow(/No authenticated route in the default text worker chain/);
    setRoutingConfigOverride({ textWorkerChain: ["provider-a/model-name"],
      subscriptionRouteChecks: [{ provider: "provider-a", host: "provider-a.example", pathPattern: "^/v1/?$" }] });
    const result = select();
    expect(result.model).toBe(worker);
    expect(result.selection).toMatchObject({ source: "chain", chainRoutes: ["provider-a/model-name"] });
  });

  it("starts the policy extension and registers no catalog extra", () => {
    const registerProvider = vi.fn();
    modelRoutePolicy({ registerProvider, registerVirtualModel: vi.fn(), registerFlag: vi.fn(), on: vi.fn(), getFlag: vi.fn() } as never);
    // Only the free-tier adapter's own provider composition; no operator catalog extra.
    expect(registerProvider).toHaveBeenCalledTimes(1);
  });
});

describe("operator files", () => {
  it("reports a malformed routing.json at the decision that needs it, naming the key", () => {
    writeFileSync(join(dir, "routing.json"), JSON.stringify({ textWorkerChain: ["no-slash"] }));
    expect(() => routingConfig()).toThrow(RoutingConfigError);
    expect(() => textWorkerChain()).toThrow(/textWorkerChain\[0\].*provider\/model/);
    // Picker and catalog paths read a malformed file as empty instead of throwing.
    expect(isHiddenModel({ provider: "provider-b", id: "x" })).toBe(false);
  });

  it("reads paid-routes.json version 2: reviewed is the catalog, allow the granted subset", () => {
    const granted = { provider: "provider-b", id: "model-name", baseUrl: "https://gateway.example/api/v1" };
    const reviewedOnly = { ...granted, id: "other-model" };
    writeFileSync(join(dir, "paid-routes.json"), JSON.stringify({ version: 2,
      reviewed: [granted, reviewedOnly].map(({ provider, id, baseUrl }) => ({ provider, model: id, baseUrl })),
      allow: [{ provider: "provider-b", model: "model-name", baseUrl: granted.baseUrl },
        { provider: "provider-c", model: "unreviewed", baseUrl: "https://c.example/v1" }] }));
    expect(reviewedPaidRoutes()).toEqual([granted, reviewedOnly]);
    expect(readApprovedPaidRoutes()).toEqual([granted]);
    expect(isAllowlistedPaidRoute(granted)).toBe(true);
    expect(isAllowlistedPaidRoute(reviewedOnly)).toBe(false);
    expect(isAllowlistedPaidRoute({ ...granted, baseUrl: `${granted.baseUrl}/` })).toBe(false);
    expect(createExplicitPaidApproval("provider-b/model-name", granted)(granted)).toBe(true);
  });

  it("grants openrouter/deepseek/deepseek-v4.1-flash-1017:exacto under both formats", () => {
    // The operator's file carries both tables so one file serves the released 0.17.0
    // (which reads only `allow`) and this build (which reads `reviewed`). The same
    // route must be reviewed and granted from a version 1 file and a version 2 file.
    const route = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017:exacto", baseUrl: "https://openrouter.ai/api/v1" };
    const entry = { provider: route.provider, model: route.id, baseUrl: route.baseUrl };
    const operator = join(dir, "paid-routes.json");

    // Version 1 with the reviewed table 0.18 introduced: reviewed and granted.
    writeFileSync(operator, JSON.stringify({ version: 1, reviewed: [entry], allow: [entry] }));
    expect(reviewedPaidRoutes()).toEqual([route]);
    expect(readApprovedPaidRoutes()).toEqual([route]);
    expect(isAllowlistedPaidRoute(route)).toBe(true);

    // The same grant in version 2: reviewed and granted identically.
    writeFileSync(operator, JSON.stringify({ version: 2, reviewed: [entry], allow: [entry] }));
    expect(reviewedPaidRoutes()).toEqual([route]);
    expect(readApprovedPaidRoutes()).toEqual([route]);
    expect(isAllowlistedPaidRoute(route)).toBe(true);

    // A version 1 file with only `allow` (0.17.0's shape) still grants nothing on its own:
    // the reviewed table is the spending review, and it is absent.
    writeFileSync(operator, JSON.stringify({ version: 1, allow: [entry] }));
    expect(reviewedPaidRoutes()).toEqual([]);
    expect(readApprovedPaidRoutes()).toEqual([]);
    expect(isAllowlistedPaidRoute(route)).toBe(false);
  });

  it("a version 2 file without a reviewed table grants nothing and never borrows", () => {
    const route = { provider: "provider-b", id: "model-name", baseUrl: "https://gateway.example/api/v1" };
    const entry = { provider: route.provider, model: route.id, baseUrl: route.baseUrl };
    // The operator's own file reviews and grants the route.
    writeFileSync(join(dir, "paid-routes.json"), JSON.stringify({ version: 2, reviewed: [entry], allow: [entry] }));
    expect(isAllowlistedPaidRoute(route)).toBe(true);
    // A separate version 2 file with only `allow` must fail closed: a v2 file owns its
    // table and never borrows the operator's reviewed catalog.
    const v2 = join(dir, "v2-allow-only.json");
    writeFileSync(v2, JSON.stringify({ version: 2, allow: [entry] }));
    expect(reviewedPaidRoutes(v2)).toEqual([]);
    expect(readApprovedPaidRoutes(v2)).toEqual([]);
    expect(isAllowlistedPaidRoute(route, v2)).toBe(false);
    // Version 1 without `reviewed` still borrows from the operator's catalog, as before.
    const v1 = join(dir, "v1-allow-only.json");
    writeFileSync(v1, JSON.stringify({ version: 1, allow: [entry] }));
    expect(readApprovedPaidRoutes(v1)).toEqual([route]);
    expect(isAllowlistedPaidRoute(route, v1)).toBe(true);
  });

  it("keeps version 1 allow files working only against a reviewed table", () => {
    const route = { provider: "provider-b", id: "model-name", baseUrl: "https://gateway.example/api/v1" };
    const v1 = join(dir, "v1.json");
    writeFileSync(v1, JSON.stringify({ version: 1, allow: [{ provider: route.provider, model: route.id, baseUrl: route.baseUrl }] }));
    // No reviewed table anywhere: nothing is granted, also when the v1 file is the operator's own.
    expect(readApprovedPaidRoutes(v1)).toEqual([]);
    writeFileSync(join(dir, "paid-routes.json"), JSON.stringify({ version: 1, allow: [{ provider: route.provider, model: route.id, baseUrl: route.baseUrl }] }));
    expect(isAllowlistedPaidRoute(route)).toBe(false);
    // With the operator's v2 catalog the same v1 allow entry grants, exactly as before.
    writeFileSync(join(dir, "paid-routes.json"), JSON.stringify({ version: 2, reviewed: [{ provider: route.provider, model: route.id, baseUrl: route.baseUrl }], allow: [] }));
    expect(readApprovedPaidRoutes(v1)).toEqual([route]);
    expect(isAllowlistedPaidRoute(route, v1)).toBe(true);
    expect(isAllowlistedPaidRoute(route)).toBe(false);
    rmSync(v1);
  });
});

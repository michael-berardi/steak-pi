// steak-dsh route grammar, executable resolution, effort mapping and admission. Every identity is
// synthetic; no network, no real CLI, no real model. Admission refusals must name the inner route.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DSH_KEY_ENV, admitDshRoute, dshEffortOf, dshRouteModel, dshRouteOf, dshRouteShapeRefusal, isDshRoute,
  resolveDshEffort, resolveDshExecutable,
} from "../src/subagents/dsh-routes.ts";
import { setRoutingConfigOverride } from "../src/routing-config.ts";
import { isQuotaLaunchFailure } from "../src/subagents/provider-quota.ts";

type Model = NonNullable<ExtensionContext["model"]>;
const dir = mkdtempSync(join(tmpdir(), "steak-pi-dsh-routes-"));
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); setRoutingConfigOverride(undefined); });

const model = (provider: string, id: string, over: Partial<Record<string, unknown>> = {}): Model => ({
  provider, id, name: id, api: "openai-completions", baseUrl: `https://${provider}.example/v1`,
  input: ["text"], contextWindow: 100_000, maxTokens: 8_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...over,
} as unknown as Model);

function registryOf(models: readonly Model[], over: { oauth?: boolean; auth?: boolean } = {}) {
  return {
    find: (provider: string, id: string) => models.find((candidate) => candidate.provider === provider && candidate.id === id),
    getAll: () => [...models], getAvailable: () => [...models],
    hasConfiguredAuth: () => over.auth !== false, isUsingOAuth: () => over.oauth === true,
  };
}

/** A fake executable file the admission's launch check can resolve. */
function fakeBin(name = "steak-dsh"): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("dshRouteModel grammar", () => {
  it("parses provider and model id, including slashes in the model id", () => {
    expect(dshRouteModel("steak-dsh/alpha-p/alpha-model")).toEqual({ provider: "alpha-p", id: "alpha-model" });
    expect(dshRouteModel("steak-dsh/alpha-p/vendor/alpha-model:tag")).toEqual({ provider: "alpha-p", id: "vendor/alpha-model:tag" });
    expect(dshRouteOf({ provider: "alpha-p", id: "vendor/alpha-model" })).toBe("steak-dsh/alpha-p/vendor/alpha-model");
  });
  it("refuses every malformed shape", () => {
    for (const route of [undefined, "", "alpha-p/alpha-model", "steak-dsh/", "steak-dsh/alpha-p", "steak-dsh//alpha-model", "steak-dsh/alpha-p/", "claude-code/x", "steak-dsh"]) {
      expect(dshRouteModel(route), String(route)).toBeUndefined();
      expect(isDshRoute(route), String(route)).toBe(false);
    }
    expect(dshRouteShapeRefusal("steak-dsh/alpha-p")).toContain("steak-dsh/<provider>/<model-id>");
  });
});

describe("executable resolution", () => {
  it("prefers STEAK_DSH_BIN when it names an executable file", () => {
    const bin = fakeBin();
    expect(resolveDshExecutable({ STEAK_DSH_BIN: bin, PATH: "" })).toBe(bin);
    expect(resolveDshExecutable({ STEAK_DSH_BIN: join(dir, "missing"), PATH: "" })).toBeUndefined();
  });
  it("resolves steak-dsh on PATH and fails closed without one", () => {
    const binDir = mkdtempSync(join(dir, "bin-"));
    const bin = join(binDir, "steak-dsh");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(resolveDshExecutable({ PATH: binDir })).toBe(bin);
    expect(resolveDshExecutable({ PATH: join(dir, "empty") })).toBeUndefined();
    expect(resolveDshExecutable({})).toBeUndefined();
  });
});

describe("effort mapping", () => {
  it("defaults to medium and requires a reason for high/xhigh", () => {
    expect(resolveDshEffort(undefined)).toBe("medium");
    expect(resolveDshEffort("medium")).toBe("medium");
    expect(() => resolveDshEffort("high")).toThrow(/thinkingReason/);
    expect(resolveDshEffort("high", "a concrete task benefit here")).toBe("high");
    expect(resolveDshEffort("xhigh", "a concrete task benefit here")).toBe("xhigh");
    expect(() => resolveDshEffort("low")).toThrow(/medium, high, xhigh/);
  });
  it("maps native thinking levels onto CLI efforts", () => {
    expect(dshEffortOf("off")).toBe("medium");
    expect(dshEffortOf("minimal")).toBe("medium");
    expect(dshEffortOf("low")).toBe("medium");
    expect(dshEffortOf("high")).toBe("high");
    expect(() => dshEffortOf("max")).toThrow(/medium, high, xhigh/);
  });
});

describe("admitDshRoute", () => {
  const alpha = model("alpha-p", "alpha-model");
  const subscriptionConfig = { subscriptionRouteChecks: [{ provider: "alpha-p", host: "alpha-p.example" }] };
  const admit = (route: string, registry = registryOf([alpha]), options = {}) =>
    admitDshRoute(route, registry, { env: { STEAK_DSH_BIN: fakeBin() }, ...options });

  it("admits an exact authenticated subscription route the registry knows", async () => {
    setRoutingConfigOverride(subscriptionConfig);
    await expect(admit("steak-dsh/alpha-p/alpha-model")).resolves.toBe(alpha);
  });
  it("refuses a malformed route by name", async () => {
    await expect(admit("steak-dsh/alpha-p")).rejects.toThrow(/steak-dsh\/<provider>\/<model-id>/);
  });
  it("refuses an unknown inner model, naming the inner route", async () => {
    setRoutingConfigOverride(subscriptionConfig);
    await expect(admit("steak-dsh/alpha-p/missing-model")).rejects.toThrow(/inner route alpha-p\/missing-model.*does not know the inner model/s);
  });
  it("refuses a retired inner route", async () => {
    setRoutingConfigOverride({ ...subscriptionConfig, retiredModelPatterns: ["alpha-model"] });
    await expect(admit("steak-dsh/alpha-p/alpha-model")).rejects.toThrow(/retired/i);
  });
  it("refuses an unapproved paid inner route", async () => {
    setRoutingConfigOverride({});
    await expect(admit("steak-dsh/alpha-p/alpha-model", registryOf([alpha]), { approvePaidRoute: () => false }))
      .rejects.toThrow(/paid metered route that is not approved/);
    // Even an approving grant cannot admit a route absent from the reviewed paid catalog.
    await expect(admit("steak-dsh/alpha-p/alpha-model", registryOf([alpha]), { approvePaidRoute: () => true }))
      .rejects.toThrow(/paid metered route that is not approved/);
  });
  it("refuses an OAuth-only provider with a named error", async () => {
    setRoutingConfigOverride(subscriptionConfig);
    await expect(admit("steak-dsh/alpha-p/alpha-model", registryOf([alpha], { oauth: true })))
      .rejects.toThrow(/OAuth-only login.*needs an API key/s);
  });
  it("refuses an unauthenticated inner model", async () => {
    setRoutingConfigOverride(subscriptionConfig);
    await expect(admit("steak-dsh/alpha-p/alpha-model", registryOf([alpha], { auth: false })))
      .rejects.toThrow(/no configured authentication/);
  });
  it("refuses when the steak-dsh executable does not resolve, with the install hint", async () => {
    setRoutingConfigOverride(subscriptionConfig);
    await expect(admitDshRoute("steak-dsh/alpha-p/alpha-model", registryOf([alpha]), { env: { PATH: "" } }))
      .rejects.toThrow(/steak-dsh harness not installed.*STEAK_DSH_BIN/s);
  });
  it("refuses a pinned family served off its pinned route", async () => {
    setRoutingConfigOverride({ subscriptionRouteChecks: [{ provider: "alpha-p", host: "alpha-p.example", modelPattern: "alpha-model", oauth: true }] });
    await expect(admit("steak-dsh/alpha-p/alpha-model")).rejects.toThrow(/pinned/i);
  });
  it("keeps the key env name fixed", () => {
    expect(DSH_KEY_ENV).toBe("STEAK_DSH_ROUTE_KEY");
  });
  it("renders quota causes the implicit wave classifier recognizes", async () => {
    // The worker's quota wording must be the provider-quota failure kind the Pi runner reports.
    const { classifyDshWorkerState } = await import("../src/subagents/dsh-worker.ts");
    const { emptyUsage } = await import("../src/subagents/types.ts");
    const state = { outputParts: [], outputLength: 0, toolErrors: 0, toolSuccesses: 0, turns: 0, turnLimitReached: false, usage: emptyUsage(), sawFinal: false };
    const result = classifyDshWorkerState({ signal: new AbortController().signal, state, maxTurns: 8, exitCode: 1, exitSignal: null, stderrLine: "HTTP 429: quota exceeded for this account" });
    expect(result.state).toBe("failed");
    expect(isQuotaLaunchFailure(result.error!)).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { rawModelHasZeroCostRow } from "../src/raw-model-cost.ts";
import { setRoutingConfigOverride } from "../src/routing-config.ts";
import { clearFreeRouteHolds, computeAvailability, freeRouteHeldUntil, holdFreeRoute } from "../src/subagents/route-availability.ts";
import { isProvenFreeModel } from "../src/subagents/provider-quota.ts";
import { clearRawModels, writeRawModels, writeRawModelsText, ZERO_COST } from "./helpers/raw-models.ts";

const model = { provider: "prov-free", id: "m1", cost: { ...ZERO_COST } };
const listed = { freeRoutes: [{ route: "prov-free/m1", source: "price page", evidence: "checked" }] };
afterEach(() => { clearRawModels(); clearFreeRouteHolds(); setRoutingConfigOverride(undefined); });

describe("free route gate: operator allowlist plus a raw all-zero cost row", () => {
  it("accepts a listed route whose models.json entry types every price as 0", () => {
    setRoutingConfigOverride(listed);
    writeRawModels([model]);
    expect(isProvenFreeModel(model)).toBe(true);
  });
  it("rejects a listed route whose models.json entry has no cost row (the composer's default zero)", () => {
    setRoutingConfigOverride(listed);
    writeRawModels([{ provider: "prov-free", id: "m1" }]);
    expect(rawModelHasZeroCostRow("prov-free", "m1")).toBe(false);
    expect(isProvenFreeModel(model)).toBe(false);
  });
  it("rejects partial, non-zero and non-numeric cost rows", () => {
    for (const cost of [{ input: 0, output: 0 }, { ...ZERO_COST, output: 1 }, { ...ZERO_COST, input: "0" }]) {
      writeRawModels([{ provider: "prov-free", id: "m1", cost }]);
      expect(rawModelHasZeroCostRow("prov-free", "m1")).toBe(false);
    }
  });
  it("fails closed when models.json is missing or malformed", () => {
    setRoutingConfigOverride(listed);
    writeRawModels([]);
    expect(isProvenFreeModel(model)).toBe(false);
    writeRawModelsText("{ nope");
    expect(isProvenFreeModel(model)).toBe(false);
  });
  it("still requires the operator listing", () => {
    writeRawModels([model]);
    expect(isProvenFreeModel(model)).toBe(false);
  });
});

describe("free route cooldown uses one key", () => {
  const dshStep = { provider: "prov-free", id: "m1", harness: "steak-dsh" as const };
  const policy = {};
  const snapshot = { known: true, providers: {} } as never;
  it("a hold taken under the dsh label shows the dsh chain step as cooling, and a plain hold does not", () => {
    const now = 1_000_000;
    holdFreeRoute("steak-dsh/prov-free/m1", now);
    expect(freeRouteHeldUntil(dshStep, now)).toBeDefined();
    expect(freeRouteHeldUntil({ provider: "prov-free", id: "m1" }, now)).toBeUndefined();
    const dsh = computeAvailability({ snapshot, chain: [dshStep], policy, isFree: () => true, now });
    expect(dsh.steps[0]?.state).toBe("cooling");
    const plain = computeAvailability({ snapshot, chain: [{ provider: "prov-free", id: "m1" }], policy, isFree: () => true, now });
    expect(plain.steps[0]?.state).toBe("up");
  });
  it("a hold taken from a step is found by the same step and by its label", () => {
    holdFreeRoute(dshStep, 5);
    expect(freeRouteHeldUntil("steak-dsh/prov-free/m1", 6)).toBeDefined();
  });
});

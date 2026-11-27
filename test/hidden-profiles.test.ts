import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { curatedPickerScope } from "../src/harness-profiles.ts";
import { guardProvider, selectChainedWorkerModel, type WorkerRouteStep } from "../src/model-route-policy.ts";
import { curatedPickerModels, sharedPickerModels } from "../src/model-visibility.ts";
import { parseRoutingConfig, RoutingConfigError, setRoutingConfigOverride } from "../src/routing-config.ts";
import { routingFixture } from "./helpers/routing-fixture.ts";

// Synthetic ids only: the operator's routing.json owns real profile names.
const HARNESS = "steak-pi";
const HIDDEN_PROFILE = `${HARNESS}/hidden-profile`;
const OFFLINE = "http://127.0.0.1:1/v1";
type Model = NonNullable<ExtensionContext["model"]>;
type Provider = Parameters<typeof guardProvider>[0];
type ChainRegistry = Parameters<typeof selectChainedWorkerModel>[0];
const routeOf = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
const hiddenModel = { provider: "alpha", id: "hidden-model", name: "Hidden Model", api: "openai-completions", baseUrl: OFFLINE, input: ["text"] } as Model;
const keptModel = { provider: "beta", id: "kept-model", name: "Kept Model", api: "openai-completions", baseUrl: OFFLINE, input: ["text"] } as Model;

function pickerFixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-hidden-profiles-"));
  let tick = 0;
  const manifest = (profiles: unknown[]) => {
    const path = join(dir, `${HARNESS}.json`);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, id: HARNESS, name: "Fixture Harness",
      description: "synthetic manifest", executable: "stub", launcher: "generic", profileSource: "static", profiles }));
    tick += 1;
    const stamp = new Date(Date.now() + tick * 1000);
    utimesSync(path, stamp, stamp);
  };
  vi.stubEnv("ULTRATERM_HARNESS_ID", HARNESS);
  vi.stubEnv("ULTRATERM_HARNESS_DIR", dir);
  vi.stubEnv("ULTRATERM_HARNESS_RESOURCES", join(dir, "no-bundled-catalog"));
  return {
    manifest,
    cleanup: () => { setRoutingConfigOverride(undefined); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const profile = (id: string, model: string) => ({ id, name: id, description: `synthetic ${id}`, args: ["--model", model, "--thinking", "high"] });
const configured = () => ({ ...routingFixture(), hiddenProfiles: [HIDDEN_PROFILE] });

it("validates hiddenProfiles as an optional string array like retiredProfiles", () => {
  expect(parseRoutingConfig({}).hiddenProfiles).toBeUndefined();
  expect(parseRoutingConfig({ hiddenProfiles: [HIDDEN_PROFILE] }).hiddenProfiles).toEqual([HIDDEN_PROFILE]);
  expect(() => parseRoutingConfig({ hiddenProfiles: HIDDEN_PROFILE })).toThrow(RoutingConfigError);
  expect(() => parseRoutingConfig({ hiddenProfiles: [7] })).toThrow(/hiddenProfiles\[0\]/);
});

it("hides only the listed harness/profile from the shared picker scope", () => {
  const f = pickerFixture();
  try {
    f.manifest([profile("hidden-profile", routeOf(hiddenModel)), profile("kept-profile", routeOf(keptModel))]);
    setRoutingConfigOverride(routingFixture());
    const baseline = [...curatedPickerScope()!].sort();
    expect(baseline).toEqual([routeOf(hiddenModel), routeOf(keptModel)]);
    // No hiddenProfiles: both configured profiles remain picker choices.
    expect(curatedPickerModels(sharedPickerModels([hiddenModel, keptModel]), curatedPickerScope()).map(routeOf)).toEqual(baseline);

    setRoutingConfigOverride(configured());
    expect([...curatedPickerScope()!]).toEqual([routeOf(keptModel)]);
    expect(curatedPickerModels(sharedPickerModels([hiddenModel, keptModel]), curatedPickerScope()).map(routeOf))
      .toEqual([routeOf(keptModel)]);
    // The list is harness-qualified: another harness with the same profile id is not hidden.
    setRoutingConfigOverride({ ...routingFixture(), hiddenProfiles: ["other-harness/hidden-profile"] });
    expect([...curatedPickerScope()!].sort()).toEqual(baseline);
    // Removing the key restores the unchanged manifest scope, even with no manifest revision change.
    setRoutingConfigOverride(routingFixture());
    expect([...curatedPickerScope()!].sort()).toEqual(baseline);
  } finally { f.cleanup(); }
});

it("keeps a hidden profile's route dispatchable while its picker snapshot drops it", () => {
  const f = pickerFixture();
  try {
    f.manifest([profile("hidden-profile", routeOf(hiddenModel))]);
    setRoutingConfigOverride(configured());
    expect([...curatedPickerScope()!]).toEqual([]);

    // The native snapshot is what /model renders; the provider catalog is not filtered.
    const provider = {
      id: hiddenModel.provider, getModels: () => [hiddenModel], filterModels: (models: Model[]) => models,
      stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); },
    } as unknown as Provider;
    const guarded = guardProvider(provider, () => false);
    expect(guarded.getModels()).toEqual([hiddenModel]);
    expect(guarded.filterModels!([hiddenModel], undefined)).toEqual([]);

    // A chain resolves against getAll(), not the curated availability snapshot.
    const registry = {
      find: (provider: string, id: string) => provider === hiddenModel.provider && id === hiddenModel.id ? hiddenModel : undefined,
      getAvailable: () => [],
      getAll: () => [hiddenModel],
      hasConfiguredAuth: () => true,
      isUsingOAuth: () => false,
      getProvider: () => ({ streamSimple: () => undefined }),
    } as unknown as ChainRegistry;
    const chain: readonly WorkerRouteStep[] = [{ provider: hiddenModel.provider, id: hiddenModel.id }];
    expect(selectChainedWorkerModel(registry, chain)).toBe(hiddenModel);
  } finally { f.cleanup(); }
});

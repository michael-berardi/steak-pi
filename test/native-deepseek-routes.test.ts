import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createExplicitPaidApproval, PAID_INCO_BASE_URL } from "../src/explicit-paid-route.ts";
import { assertModelRoute, assertSubscriptionRequest, isModelRouteAllowed } from "../src/model-route-policy.ts";
import { BUILTIN_WORKER_PROFILES } from "../src/subagents/model-selection.ts";

// Regression coverage for the 0.7.1 removal of the DeepSeek-specific DSH
// harness/launcher/vendor runtime: DeepSeek models must keep running through
// ordinary routes, and the explicit paid-route admission must stay intact.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })); });

const goModel = {
  provider: "opencode-go", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash",
  api: "openai-completions", baseUrl: "https://api.opencode.ai/v1",
};
const incoFast = {
  provider: "inco", id: "deepseek-v4.1-flash:fast", name: "DeepSeek V4.1 Flash Fast",
  api: "openai-completions", baseUrl: PAID_INCO_BASE_URL,
} as Parameters<typeof assertSubscriptionRequest>[0];

function paidConfig(allow: unknown[], name = "deepseek-v4.1-flash-fast"): string {
  const dir = mkdtempSync(join(tmpdir(), `steak-native-route-${name}-`));
  dirs.push(dir);
  const path = join(dir, "paid-routes.json");
  writeFileSync(path, JSON.stringify({ version: 1, allow }));
  return path;
}

describe("ordinary DeepSeek model routes", () => {
  it("ships no DSH extension, launcher, vendor runtime, harness doc or package entry", () => {
    for (const path of [
      "extensions/deepseek-harness.ts", "src/deepseek-primary.ts", "src/deepseek-harness",
      "bin/steak-pi-dsh", "vendor/pi-dsh-minimal", "docs/DEEPSEEK-HARNESS.md",
      "scripts/benchmark-deepseek-harness.ts",
    ]) expect(existsSync(join(root, path)), path).toBe(false);

    const manifest = JSON.parse(read("package.json"));
    expect(manifest.bin).toEqual({ "steak-pi": "bin/steak-pi" });
    expect(manifest.files.some((entry: string) => /dsh|DEEPSEEK-HARNESS|vendor/i.test(entry))).toBe(false);
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(JSON.parse(read("package-lock.json")).packages[""].bin).toEqual({ "steak-pi": "bin/steak-pi" });
  });

  it("keeps native worker tools and prompts free of DeepSeek-special overrides", () => {
    const worker = read("src/subagents/pi-worker.ts");
    expect(worker).not.toMatch(/deepseek|dsh|harness|persistentBash/i);
  });

  it("admits the OpenCode Go DeepSeek route as an ordinary subscription route", () => {
    expect(isModelRouteAllowed(goModel)).toBe(true);
    expect(() => assertModelRoute(goModel)).not.toThrow();
    expect(() => assertSubscriptionRequest(goModel as Parameters<typeof assertSubscriptionRequest>[0], false)).not.toThrow();
    expect(BUILTIN_WORKER_PROFILES.find((profile) => profile.id === "steak-pi/opencode-go"))
      .toMatchObject({ model: "opencode-go/deepseek-v4.1-flash" });
  });

  it("still requires the explicit paid flag and exact route for Inco DeepSeek Fast", () => {
    const path = paidConfig([{ provider: incoFast.provider, model: incoFast.id, baseUrl: incoFast.baseUrl }]);
    const approve = createExplicitPaidApproval(`inco/${incoFast.id}`, incoFast, path);
    expect(approve(incoFast)).toBe(true);
    expect(createExplicitPaidApproval(undefined, incoFast, path)(incoFast)).toBe(false);
    expect(createExplicitPaidApproval("inco/glm-5.3-flash:fast", incoFast, path)(incoFast)).toBe(false);
    // A same-named provider pointed elsewhere is a different billing target.
    expect(createExplicitPaidApproval(`inco/${incoFast.id}`, { ...incoFast, baseUrl: `${PAID_INCO_BASE_URL}/` }, path)(incoFast)).toBe(false);
    // The ordinary Go route never inherits paid authorization.
    const goPath = paidConfig([{ provider: goModel.provider, model: goModel.id, baseUrl: goModel.baseUrl }], "go");
    expect(createExplicitPaidApproval(`opencode-go/${goModel.id}`, goModel as typeof incoFast, goPath)(goModel as typeof incoFast)).toBe(false);
  });
});

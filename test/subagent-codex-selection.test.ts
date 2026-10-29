import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as stagedRuntime from "../src/subagents/staged-runtime.ts";
import { registryForSolSelection } from "../src/subagents/codex-selection.ts";
import { resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import { isolatedAgentPaths, isolatedCodexAgentDir } from "../src/subagents/provider-accounts.ts";
import { SOL_MODEL_ROUTE } from "../src/retired-model-selection.ts";

let fixtureHome: string;
beforeEach(() => {
  const root = join(process.cwd(), ".leaf-check");
  mkdirSync(root, { recursive: true });
  fixtureHome = mkdtempSync(join(root, "codex-fixture-"));
  vi.stubEnv("HOME", fixtureHome);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(fixtureHome, { recursive: true, force: true }); });

const parent = { provider: "opencode-go", id: "deepseek-v4.1-flash", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1", input: ["text"] } as any;
const sol = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] } as any;
const goRegistry = () => ({ find: () => undefined, getAll: () => [parent], hasConfiguredAuth: () => false, isUsingOAuth: () => false }) as any;
function runtime(model = sol, oauth = true, configured = true): ModelRuntime {
  return { getModel: () => model, getModels: () => [model], getAvailableSnapshot: () => [model],
    hasConfiguredAuth: () => configured, isUsingOAuth: () => oauth, getProvider: () => ({ streamSimple() {} }) } as unknown as ModelRuntime;
}

describe("fresh Go parent isolated Codex Sol admission", () => {
  it.each(["primary", "fallback"] as const)("uses authentic SDK status from canonical %s without copying Go auth or changing env", async id => {
    const goDir = join(homedir(), ".ultraterm/provider-accounts/opencode-go/primary/agent");
    mkdirSync(goDir, { recursive: true });
    const authFile = join(goDir, "auth.json");
    const fixtureAuth = '{"opencode-go":{"type":"api_key","key":"fixture-go-only"}}';
    writeFileSync(authFile, fixtureAuth);
    const environment = { ...process.env };
    const command = vi.fn(async (_args: string[]) => ({ ok: true, account: { id, agentDir: isolatedCodexAgentDir(id) } }));
    const create = vi.fn(async () => runtime());
    const registry = await registryForSolSelection(parent, { model: SOL_MODEL_ROUTE }, goRegistry(), command, create);
    const resolved = resolveWorkerSelection(parent, "high", { model: SOL_MODEL_ROUTE, tasks: [{ role: "reviewer" }] as any }, registry, [], undefined, {}, {});
    expect(resolved.selection.provider).toBe("openai-codex");
    expect(resolved.selection.modelId).toBe("gpt-6.1-sol");
    expect(create).toHaveBeenCalledWith(isolatedAgentPaths(isolatedCodexAgentDir(id)));
    expect(command).toHaveBeenCalledWith(["select", "--provider", "codex"]);
    expect(readFileSync(authFile, "utf8")).toBe(fixtureAuth);
    expect(existsSync(join(goDir, "models.json"))).toBe(false);
    expect(process.env).toEqual(environment);
  });
  it.each([
    [sol, false, true], [sol, true, false],
    [{ ...sol, baseUrl: "https://api.openai.com/v1" }, true, true],
    [{ ...sol, api: "openai-responses" }, true, true],
    [{ ...sol, provider: "openrouter" }, true, true],
  ])("rejects unauthenticated/non-OAuth or wrong endpoint/provider/adapter", async (model, oauth, configured) => {
    const command = async () => ({ ok: true, account: { id: "primary", agentDir: isolatedCodexAgentDir("primary") } });
    await expect(registryForSolSelection(parent, { model: SOL_MODEL_ROUTE }, goRegistry(), command,
      async () => runtime(model, oauth as boolean, configured as boolean))).rejects.toThrow();
  });
  it("never bridges Astra or an explicit Claude route", async () => {
    const registry = goRegistry();
    const command = vi.fn();
    for (const model of ["openai-codex/gpt-6-astra", "claude-code/claude-opus-5-5"]) {
      expect(await registryForSolSelection(parent, { model }, registry, command)).toBe(registry);
    }
    expect(command).not.toHaveBeenCalled();
  });
  it("supports explicit Sol profile without substituting an image downgrade", async () => {
    const command = async () => ({ ok: true, account: { id: "primary", agentDir: isolatedCodexAgentDir("primary") } });
    const registry = await registryForSolSelection(parent, { profile: "steak-pi/gpt-6-1-sol" }, goRegistry(), command,
      async () => runtime({ ...sol, input: ["text"] }));
    expect(() => resolveWorkerSelection(parent, "high", { profile: "steak-pi/gpt-6-1-sol", requireImages: true, tasks: [] }, registry, undefined, undefined, {}, {})).toThrow(/image input/);
  });
});


it("resolves the isolated Codex worker SDK through the staged-runtime resolver", async () => {
  const model = JSON.stringify(sol);
  const source = `export async function loadPiSdk() { return { ModelRuntime: { create: async () => ({
    getModel: () => (${model}), getModels: () => [${model}], getAvailableSnapshot: () => [${model}],
    isUsingOAuth: () => true, hasConfiguredAuth: () => true, getProvider: () => ({})
  }) } }; }`;
  const resolver = vi.spyOn(stagedRuntime, "resolveStagedModule").mockReturnValue({
    url: `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`, runtime: "fixture", replaced: true, tried: [],
  });
  try {
    const command = async () => ({ ok: true, account: { id: "primary", agentDir: isolatedCodexAgentDir("primary") } });
    const registry = await registryForSolSelection(parent, { model: SOL_MODEL_ROUTE }, goRegistry(), command);
    expect(resolver).toHaveBeenCalledWith("src/subagents/pi-worker.ts");
    expect(registry.find("openai-codex", "gpt-6.1-sol")).toEqual(sol);
  } finally { resolver.mockRestore(); }
});

const terra = { ...sol, id: "gpt-6.1-terra", name: "GPT-6.1 Terra" };
describe("synthetic: Terra isolated Codex admission", () => {
  it.each([{ model: "openai-codex/gpt-6.1-terra" }, { profile: "steak-pi/gpt-6-1-terra" }, { profile: "gpt-6-1-terra" }])("bridges exact Terra selector %j without changing parent auth", async selector => {
    const registry = goRegistry();
    const command = vi.fn(async () => ({ ok: true, account: { id: "primary", agentDir: isolatedCodexAgentDir("primary") } }));
    const selected = await registryForSolSelection(parent, selector, registry, command, async () => runtime(terra));
    expect(selected.find("openai-codex", terra.id)).toEqual(terra);
    expect(registry.getAll()).toEqual([parent]);
    expect(command).toHaveBeenCalledWith(["select", "--provider", "codex"]);
  });
  it.each([[terra, false, true], [terra, true, false], [sol, true, true],
    [{ ...terra, baseUrl: "https://api.openai.com/v1" }, true, true]])("rejects wrong identity, non-OAuth, missing auth or paid endpoint", async (model, oauth, configured) => {
    const command = async () => ({ ok: true, account: { id: "primary", agentDir: isolatedCodexAgentDir("primary") } });
    await expect(registryForSolSelection(parent, { model: "openai-codex/gpt-6.1-terra" }, goRegistry(), command,
      async () => runtime(model, oauth as boolean, configured as boolean))).rejects.toThrow();
  });
});

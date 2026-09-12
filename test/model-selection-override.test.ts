import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createUltratermSubagentsExtension } from "../extensions/ultraterm-subagents.ts";
import { assertWorkerSelectionOverride, resolveWorkerSelection, type WorkerProfile } from "../src/subagents/model-selection.ts";
import { emptyUsage, type DispatchInput, type ModelSelection } from "../src/subagents/types.ts";

type Model = NonNullable<ExtensionContext["model"]>;
const parent = { provider: "zai", id: "glm-5.3-flash", input: ["text"] } as Model;
const astra = { provider: "openai-codex", id: "gpt-6-astra", input: ["text", "image"], api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" } as Model;
const profiles: WorkerProfile[] = [
  { id: "steak-pi/glm-5-3-flash", model: "zai/glm-5.3-flash", workerDefault: { model: "zai/glm-5.3-flash" } },
  { id: "steak-pi/gpt-6-astra", model: "openai-codex/gpt-6-astra", thinking: "medium" },
];
const registry = {
  find: (provider: string, id: string) => [parent, astra].find((model) => model.provider === provider && model.id === id),
  isUsingOAuth: () => true,
  hasConfiguredAuth: () => true,
  getAvailable: () => [parent, astra],
  getProvider: () => ({ streamSimple() {} }),
} as unknown as ExtensionContext["modelRegistry"];
const input: DispatchInput = {
  goal: "Check explicit route", model: "openai-codex/gpt-6-astra", thinking: "medium", timeoutMs: 1500000,
  tasks: [{ label: "one", task: "Check route", role: "worker" }],
};

describe("run-level override invariants", () => {
  // Written before the guard implementation: the missing export makes this regression fail first.
  it.each(["model", "profile"] as const)("rejects degraded provenance for explicit %s", (field) => {
    const requested = { [field]: field === "model" ? input.model : "steak-pi/gpt-6-astra" };
    for (const source of ["profile-default", "legacy-default"] as const) {
      const selection: ModelSelection = { provider: parent.provider, modelId: parent.id, source, images: false, tools: true };
      expect(() => assertWorkerSelectionOverride(requested, selection)).toThrow(/model\/profile.*override/);
    }
  });

  it.each(["worker", "reviewer"] as const)("keeps the exact explicit model for %s", (role) => {
    const result = resolveWorkerSelection(parent, "high", { ...input, tasks: [{ ...input.tasks[0], role }] }, registry, profiles);
    expect(result.model).toBe(astra);
    expect(result.thinkingLevel).toBe("medium");
    expect(result.selection).toMatchObject({ source: "override", provider: astra.provider, modelId: astra.id });
  });

  it("keeps explicit profile provenance", () => {
    const result = resolveWorkerSelection(parent, "high", { ...input, model: undefined, profile: "steak-pi/gpt-6-astra" }, registry, profiles);
    expect(result.model).toBe(astra);
    expect(result.selection).toMatchObject({ source: "override", profile: "steak-pi/gpt-6-astra" });
  });

  it("preserves the incident arguments through the registered handler without live Pi", async () => {
    const tools = new Map<string, any>();
    const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, on() {}, appendEntry() {}, sendMessage() {} } as unknown as ExtensionAPI;
    createUltratermSubagentsExtension({
      profiles,
      createRunner: () => async ({ run }) => {
        expect(run.model).toBe(input.model);
        expect(run.timeoutMs).toBe(1500000);
        return { state: "done", output: "ok", turns: 1, usage: emptyUsage() };
      },
    })(pi);
    const ctx = { cwd: process.cwd(), model: parent, modelRegistry: registry, thinkingLevel: "high", ui: { setStatus() {} } };
    const result = await tools.get("ultraterm_subagents").execute("override", JSON.parse(JSON.stringify(input)), undefined, undefined, ctx);
    expect(result.details.run.state).toBe("done");
    expect(result.details.run.model).toBe(input.model);
    expect(result.details.run.selection.source).toBe("override");
    expect(result.details.run.thinkingLevel).toBe("medium");
  });
});

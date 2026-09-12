import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUltratermSubagentsExtension } from "../extensions/ultraterm-subagents.ts";
import { emptyUsage } from "../src/subagents/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness() {
  const tools = new Map<string, any>();
  const runner = vi.fn(async () => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }));
  const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, on() {}, appendEntry() {}, sendMessage() {} } as unknown as ExtensionAPI;
  createUltratermSubagentsExtension({ createRunner: () => runner, profiles: [], idFactory: () => "ergonomics" })(pi);
  const cwd = mkdtempSync(join(tmpdir(), "steak-dispatch-ergonomics-"));
  dirs.push(cwd);
  const model = { provider: "zai", id: "glm-5.3-flash", input: ["text", "image"] };
  const ctx = { cwd, model, thinkingLevel: "medium", modelRegistry: {
    isUsingOAuth: () => false, hasConfiguredAuth: () => true, getAvailable: () => [model],
    getProvider: () => ({ streamSimple() {} }), find: () => model,
  }, ui: { setStatus() {} } };
  return { runner, execute: (params: unknown) => tools.get("ultraterm_subagents").execute("call", params, undefined, undefined, ctx) };
}

describe("dispatch ergonomics regressions", () => {
  it("returns a bounded field-path diagnostic without echoing task text", async () => {
    const h = harness();
    const task = "PRIVATE TASK TEXT ".repeat(300);
    const result = await h.execute({ goal: "validate", tasks: [{ label: "edit", task, mayEdit: "true" }] });
    const serialized = JSON.stringify(result);
    expect(result.isError).toBe(true);
    expect(serialized).toContain("tasks[0].mayEdit");
    expect(serialized).toContain("edit");
    expect(serialized).not.toContain(task.slice(0, 201));
    expect(serialized).not.toContain("PRIVATE TASK TEXT");
    expect(h.runner).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports effective permissions and route (background=%s)", async (background) => {
    const h = harness();
    const result = await h.execute({ goal: "permissions", model: "zai/glm-5.3-flash", background, tasks: [
      { label: "edit", task: "change file", mayEdit: true, ownedPaths: ["one.ts"], allowBash: true },
      { label: "read", task: "mayEdit mentioned only in prose", role: "reviewer" },
    ] });
    expect(result.details.summary).toEqual({
      model: "zai/glm-5.3-flash", profile: null, thinking: "medium", background,
      tasks: [
        { label: "edit", role: "worker", mayEdit: true, allowBash: true, ownedPaths: 1, modelRoute: "zai/glm-5.3-flash", selectionSource: "override" },
        { label: "read", role: "reviewer", mayEdit: false, allowBash: false, ownedPaths: 0, modelRoute: "zai/glm-5.3-flash", selectionSource: "override" },
      ],
    });
    expect(result.content[0].text).toContain('"mayEdit":false');
    expect(result.content[0].text).toContain('"selectionSource":"override"');
  });
});

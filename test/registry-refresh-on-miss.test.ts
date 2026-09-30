import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUltratermSubagentsExtension } from "../extensions/ultraterm-subagents.ts";
import { emptyUsage } from "../src/subagents/types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// A model added to models.json after the session started (gpt-6.1-sol on
// 2026-09-29) must dispatch without restarting the parent session.
function harness(refreshAdds: boolean) {
  const tools = new Map<string, any>();
  const runner = vi.fn(async () => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }));
  const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, on() {}, appendEntry() {}, sendMessage() {} } as unknown as ExtensionAPI;
  createUltratermSubagentsExtension({ createRunner: () => runner, profiles: [], idFactory: () => "refresh" })(pi);
  const cwd = mkdtempSync(join(tmpdir(), "steak-registry-refresh-"));
  dirs.push(cwd);
  const parent = { provider: "zai", id: "glm-5.3-flash", baseUrl: "https://api.z.ai/api/coding/paas/v4", input: ["text", "image"] };
  const added = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] };
  let models = [parent];
  const refresh = vi.fn(async () => { if (refreshAdds) models = [parent, added]; });
  const ctx = { cwd, sessionManager: { getSessionId: () => cwd }, model: parent, thinkingLevel: "medium", modelRegistry: {
    isUsingOAuth: () => true, hasConfiguredAuth: () => true, getAvailable: () => models,
    getProvider: () => ({ streamSimple() {} }), refresh,
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
  }, ui: { setStatus() {} } };
  return { runner, refresh, execute: (params: unknown) => tools.get("ultraterm_subagents").execute("call", params, undefined, undefined, ctx) };
}

describe("USAP registry refresh on a missing model", () => {
  it("reloads models.json once and dispatches the newly added model", async () => {
    const h = harness(true);
    const result = await h.execute({ goal: "new model", model: "openai-codex/gpt-6.1-sol", thinking: "medium", tasks: [{ label: "a", task: "say ok" }] });
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(result.isError).not.toBe(true);
    expect(result.details.summary.model).toBe("openai-codex/gpt-6.1-sol");
  });

  it("still fails closed with the original message when the reload does not add it", async () => {
    const h = harness(false);
    await expect(h.execute({ goal: "missing", model: "openai-codex/gpt-6.1-sol", thinking: "medium", tasks: [{ label: "a", task: "say ok" }] }))
      .rejects.toThrow("USAP model openai-codex/gpt-6.1-sol is unavailable");
    expect(h.refresh).toHaveBeenCalledTimes(1);
    expect(h.runner).not.toHaveBeenCalled();
  });
});

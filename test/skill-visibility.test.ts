import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import todoExtension from "../extensions/todo.ts";
import { USAP_SKILL_NAME, createUltratermSubagentsExtension } from "../extensions/ultraterm-subagents.ts";
import { describe, expect, it } from "vitest";
import { hideSkill, toolIsOffered } from "../src/skill-visibility.ts";
import { rewriteCatalog } from "../extensions/skill-catalog-lite/catalog.ts";

const entry = (name: string, description = `About ${name}.`) =>
  `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>/skills/${name}/SKILL.md</location>\n  </skill>`;
const prompt = (...names: string[]) =>
  `You are an assistant.\n\n<skills>\nUse the read tool to load a skill.\n\n<available_skills>\n${names.map((name) => entry(name)).join("\n")}\n</available_skills>\n</skills>\n\n<cwd>\n/work\n</cwd>`;

describe("skill visibility", () => {
  it("treats a tool as offered unless the host positively reports a list without it", () => {
    expect(toolIsOffered({}, "todo")).toBe(true);
    expect(toolIsOffered({ getActiveTools: () => { throw new Error("not ready"); } }, "todo")).toBe(true);
    expect(toolIsOffered({ getActiveTools: () => undefined as unknown as string[] }, "todo")).toBe(true);
    expect(toolIsOffered({ getActiveTools: () => ["read", "todo"] }, "todo")).toBe(true);
    expect(toolIsOffered({ getActiveTools: () => ["read", "bash"] }, "todo")).toBe(false);
  });

  it("removes exactly one host <skill> element and conserves every other byte", () => {
    const before = prompt("memory", "todo", "ultraterm-subagent-protocol");
    const after = hideSkill(before, "ultraterm-subagent-protocol");
    expect(after).toBe(prompt("memory", "todo"));
    expect(hideSkill(before, "todo")).toBe(prompt("memory", "ultraterm-subagent-protocol"));
    expect(hideSkill(before, "memory")).toBe(prompt("todo", "ultraterm-subagent-protocol"));
    expect(after).toContain("<cwd>\n/work\n</cwd>");
  });

  it("returns the prompt by identity when there is nothing to hide", () => {
    const before = prompt("memory", "todo");
    expect(hideSkill(before, "ultraterm-subagent-protocol")).toBe(before);
    expect(hideSkill(before, "tod")).toBe(before);
    expect(hideSkill(before, "")).toBe(before);
    expect(hideSkill("no catalog here", "todo")).toBe("no catalog here");
    // A skill merely mentioned in another entry's description is not an entry.
    const mention = prompt("memory").replace("About memory.", "Pairs with <name>todo</name> plans.");
    expect(hideSkill(mention, "todo")).toBe(mention);
  });

  it("never removes a neighbouring entry whose name only starts the same way", () => {
    const before = prompt("todo-archive", "todo");
    expect(hideSkill(before, "todo")).toBe(prompt("todo-archive"));
  });

  it("removes the entry from the one-line index the skill catalog extension writes", () => {
    const many = prompt("memory", "todo", "ultraterm-subagent-protocol", ...Array.from({ length: 60 }, (_, i) => `extra-skill-${i}`));
    const lite = rewriteCatalog(many, { byteBudget: 4096 });
    expect(lite.changed).toBe(true);
    expect(lite.systemPrompt).toMatch(/^todo \(\/skills\/todo\/SKILL\.md\):/m);
    const after = hideSkill(lite.systemPrompt, "todo");
    expect(after).not.toMatch(/^todo \(/m);
    expect(after).toMatch(/^memory \(/m);
    expect(after).toMatch(/^ultraterm-subagent-protocol \(/m);
    expect(lite.systemPrompt.length - after.length).toBe(lite.systemPrompt.match(/^todo \([^\n]*\n/m)![0].length);
  });
});

// The two extensions that own a tool-specific skill: each hides its own entry only when its tool is not offered.

function register(extension: (pi: ExtensionAPI) => void, active: string[] | undefined) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const pi = {
    appendEntry() {}, sendMessage() {}, registerTool() {},
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    ...(active === undefined ? {} : { getActiveTools: () => [...active] }),
  } as unknown as ExtensionAPI;
  extension(pi);
  return handlers.get("before_agent_start")!;
}

describe("tool-specific skills follow their tool", () => {
  const full = prompt("memory", "todo", USAP_SKILL_NAME);
  const dirs: string[] = [];
  const ctx = () => { const cwd = mkdtempSync(join(tmpdir(), "steak-skill-visibility-")); dirs.push(cwd); return { cwd } as any; };
  const usap = (active: string[] | undefined) =>
    register(createUltratermSubagentsExtension({ createRunner: () => ({}) as any, profiles: [], startupWindowMs: 0 }), active);
  const cleanup = () => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); };

  it("hides the delegation skill and adds no route notice when the dispatch tool is not offered", async () => {
    try {
      const result = await usap(["read", "bash", "edit", "write", "todo"])({ systemPrompt: full }, ctx());
      expect(result).toEqual({ systemPrompt: prompt("memory", "todo") });
      expect(result.systemPrompt).not.toContain("USAP route availability");
      // Nothing to hide and nothing to add: the prompt is left exactly as the host built it.
      expect(await usap(["read"])({ systemPrompt: "BASE" }, ctx())).toBeUndefined();
    } finally { cleanup(); }
  });

  it("keeps the delegation skill when the dispatch tool is offered, or when the host cannot say", async () => {
    try {
      for (const active of [["read", "ultraterm_subagents"], undefined]) {
        const result = await usap(active)({ systemPrompt: full }, ctx());
        const text = result === undefined ? full : (result as { systemPrompt: string }).systemPrompt;
        expect(text.startsWith(full)).toBe(true);
        expect(text).toContain(`<name>${USAP_SKILL_NAME}</name>`);
      }
    } finally { cleanup(); }
  });

  it("hides the todo skill only when the todo tool is not offered", async () => {
    try {
      const without = register(todoExtension, ["read", "bash", "ultraterm_subagents"]);
      expect(await without({ systemPrompt: full }, ctx())).toEqual({ systemPrompt: prompt("memory", USAP_SKILL_NAME) });
      expect(await without({ systemPrompt: "BASE" }, ctx())).toBeUndefined();
      for (const active of [["read", "todo"], undefined]) {
        // No plan is active in a fresh session, so the todo hook adds nothing and removes nothing.
        expect(await register(todoExtension, active)({ systemPrompt: full }, { ...ctx(), sessionManager: undefined })).toBeUndefined();
      }
    } finally { cleanup(); }
  });
});

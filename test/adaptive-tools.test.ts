import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import adaptiveTools from "../extensions/adaptive-tools.ts";
import { workRulesText, WORK_RULES } from "../extensions/work-rules.ts";
import {
  adaptiveState, CALL_THRESHOLD, explicitToolSelection, growthGuidance, growTools, lightShapeActive, lightShapeWanted,
  LOADER_TOOL, promptAsksForHeavyTools, resetAdaptiveState, signalStart,
} from "../src/adaptive-tools.ts";

type Handler = (event: any, ctx: any) => any;
const ALL = ["read", "bash", "edit", "write", "ultraterm_subagents", "ultraterm_hub", "todo", LOADER_TOOL];

function fakePi(registered: string[] = ALL, active: string[] = ALL) {
  let current = [...active];
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, any>();
  const pi = {
    getActiveTools: () => [...current],
    setActiveTools: vi.fn((names: string[]) => { current = names.filter((name) => registered.includes(name)); }),
    getAllTools: () => registered.map((name) => ({ name, promptGuidelines: name === "ultraterm_subagents" ? ["Fan out by default."] : [] })),
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on(name: string, handler: Handler) { handlers.set(name, handler); },
  };
  return { pi, active: () => current, handlers, tools, emit: (name: string, event: any, ctx: any = { mode: "json" }) => handlers.get(name)?.(event, ctx) };
}

beforeEach(() => resetAdaptiveState());
afterEach(() => resetAdaptiveState());

describe("adaptive tool loadout: decisions", () => {
  it("is light only for one-shot modes, with deferral on and no explicit tool selection", () => {
    expect(lightShapeWanted("print", {}, [])).toBe(true);
    expect(lightShapeWanted("json", {}, [])).toBe(true);
    expect(lightShapeWanted("tui", {}, [])).toBe(false);
    expect(lightShapeWanted("rpc", {}, [])).toBe(false);
    expect(lightShapeWanted(undefined, {}, [])).toBe(false);
    expect(lightShapeWanted("json", { STEAK_PI_DEFER_TOOLS: "off" }, [])).toBe(false);
    expect(lightShapeWanted("json", {}, ["--tools", "read"])).toBe(false);
    expect(lightShapeWanted("json", {}, ["--exclude-tools=todo"])).toBe(false);
  });
  it("sees explicit tool flags and nothing else", () => {
    expect(explicitToolSelection(["-p", "x", "--tools", "read"])).toBe(true);
    expect(explicitToolSelection(["--no-tools"])).toBe(true);
    expect(explicitToolSelection(["--exclude-tools", "todo"])).toBe(true);
    expect(explicitToolSelection(["-p", "fix the tools list"])).toBe(false);
  });
  it("reads delegation, parallel and tracking requests from the prompt, not ordinary code words", () => {
    for (const yes of ["Delegate this to subagents", "run these in parallel", "fan out the edits", "keep a todo list", "track the tasks as you go", "dispatch the workers", "use ultraterm_subagents"])
      expect(promptAsksForHeavyTools(yes), yes).toBe(true);
    for (const no of ["Create hello.ts exporting hello", "fix the TODO comment in util.ts", "event dispatch table", "parallel arrays of ints", "a worker thread pool class"])
      expect(promptAsksForHeavyTools(no), no).toBe(false);
  });
  it("names the call threshold from the logs: past short tasks (4 to 7), inside long ones (10 to 40)", () => {
    expect(CALL_THRESHOLD).toBeGreaterThan(7);
    expect(CALL_THRESHOLD).toBeLessThanOrEqual(10);
  });
});

describe("adaptive tool loadout: growth", () => {
  it("grows once: the tool list changes on the first call only", () => {
    const { pi, active } = fakePi(ALL, ["read", "bash", "edit", "write", LOADER_TOOL]);
    expect(growTools(pi, "prompt")).toBe(true);
    expect(active()).toEqual(expect.arrayContaining(["ultraterm_subagents", "todo"]));
    const calls = pi.setActiveTools.mock.calls.length;
    expect(growTools(pi, "calls")).toBe(false);
    expect(pi.setActiveTools.mock.calls.length).toBe(calls);
    expect(adaptiveState().reason).toBe("prompt");
  });
  it("renders the guidelines of the arriving tools", () => {
    const { pi } = fakePi();
    const text = growthGuidance(pi);
    expect(text).toContain("ultraterm_subagents");
    expect(text).toContain("- Fan out by default.");
  });
  it("a start signal before or after the starting shape both end with the tools loaded and no change after", () => {
    for (const order of ["signal-first", "start-first"]) {
      resetAdaptiveState();
      const f = fakePi();
      adaptiveTools(f.pi as any);
      if (order === "signal-first") signalStart(f.pi, "todo plan");
      f.emit("session_start", {});
      if (order === "start-first") signalStart(f.pi, "todo plan");
      expect(f.active(), order).toEqual(expect.arrayContaining(["ultraterm_subagents", "todo"]));
      expect(lightShapeActive(), order).toBe(false);
    }
  });
});

describe("adaptive tool loadout: extension", () => {
  it("one-shot: starts without the dispatch, hub and todo tools; keeps the loader", () => {
    const f = fakePi();
    adaptiveTools(f.pi as any);
    f.emit("session_start", {});
    expect(f.active()).toEqual(["read", "bash", "edit", "write", LOADER_TOOL]);
    expect(lightShapeActive()).toBe(true);
  });
  it("tui and rpc: every tool as before, loader off, no hooks that grow", () => {
    for (const mode of ["tui", "rpc"]) {
      resetAdaptiveState();
      const f = fakePi();
      adaptiveTools(f.pi as any);
      f.emit("session_start", {}, { mode });
      expect(f.active(), mode).toEqual(ALL.filter((name) => name !== LOADER_TOOL));
      f.emit("input", { text: "delegate in parallel to subagents" }, { mode });
      for (let i = 0; i < CALL_THRESHOLD + 2; i++) f.emit("tool_result", { toolName: "bash", content: [] }, { mode });
      expect(f.active(), mode).toEqual(ALL.filter((name) => name !== LOADER_TOOL));
    }
  });
  it("without the dispatch tool registered (left out by the operator) the loader goes too", () => {
    const names = ALL.filter((n) => n !== "ultraterm_subagents" && n !== "todo" && n !== "ultraterm_hub");
    const f = fakePi(names, names);
    adaptiveTools(f.pi as any);
    f.emit("session_start", {});
    expect(f.active()).not.toContain(LOADER_TOOL);
  });
  it("prompt trigger loads the tools before the first request, once", () => {
    const f = fakePi();
    adaptiveTools(f.pi as any);
    f.emit("session_start", {});
    f.emit("input", { text: "Create hello.ts" });
    expect(f.active()).not.toContain("todo");
    f.emit("input", { text: "Split it across subagents in parallel" });
    expect(f.active()).toContain("todo");
    expect(lightShapeActive()).toBe(false);
  });
  it("call-count trigger loads on the threshold call and appends the guidance to that result only", () => {
    const f = fakePi();
    adaptiveTools(f.pi as any);
    f.emit("session_start", {});
    const results: any[] = [];
    for (let i = 1; i <= CALL_THRESHOLD + 2; i++) results.push(f.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "ok" }] }));
    expect(results.slice(0, CALL_THRESHOLD - 1).every((r) => r === undefined)).toBe(true);
    expect(results[CALL_THRESHOLD - 1].content.at(-1).text).toContain("Fan out by default");
    expect(results.slice(CALL_THRESHOLD).every((r) => r === undefined)).toBe(true);
    expect(f.active()).toContain("ultraterm_subagents");
  });
  it("the loader tool loads the tools and returns their guidance; calling it again changes nothing", async () => {
    const f = fakePi();
    adaptiveTools(f.pi as any);
    f.emit("session_start", {});
    const loader = f.tools.get(LOADER_TOOL);
    const first = await loader.execute();
    expect(first.content[0].text).toContain("Fan out by default");
    const calls = f.pi.setActiveTools.mock.calls.length;
    await loader.execute();
    expect(f.pi.setActiveTools.mock.calls.length).toBe(calls);
  });
  it("the loader's schema stays small", () => {
    const f = fakePi();
    adaptiveTools(f.pi as any);
    const tool = f.tools.get(LOADER_TOOL);
    const bytes = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
    expect(bytes).toBeLessThanOrEqual(300);
  });
});

describe("adaptive tool loadout: short-reasoning line follows the light shape", () => {
  it("is on while light, off once the tools load, and the explicit variable wins either way", () => {
    resetAdaptiveState();
    expect(workRulesText({})).toBe(WORK_RULES);
    adaptiveState().light = true;
    expect(workRulesText({})).not.toBe(WORK_RULES);
    expect(workRulesText({ STEAK_PI_WORK_RULES_BRIEF: "0" })).toBe(WORK_RULES);
    adaptiveState().grown = true;
    expect(workRulesText({})).toBe(WORK_RULES);
    expect(workRulesText({ STEAK_PI_WORK_RULES_BRIEF: "1" })).not.toBe(WORK_RULES);
  });
});

describe("adaptive tool loadout: scripted model", () => {
  it("benchmarks/overhead/adaptive.py passes (light shape, hosted shape, three triggers, explicit flags, opt-out)", () => {
    let out = "";
    try {
      out = execFileSync("python3", ["benchmarks/overhead/adaptive.py"], { encoding: "utf8", timeout: 300_000, env: { ...process.env, MOCK_PORT: process.env.MOCK_PORT ?? "18796" } });
    } catch (error: any) {
      throw new Error(`scripted gate failed:\n${error.stdout ?? ""}`);
    }
    expect(out).not.toMatch(/^FAIL /m);
    expect(out).toMatch(/PASS prompt: appears/);
  }, 320_000);
});

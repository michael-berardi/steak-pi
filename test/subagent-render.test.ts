import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderSubagentCall, renderSubagentResult, sanitize, truncate } from "../src/subagents/render.ts";

const themeProbe = { fg: (tone: string, text: string) => `{${tone}}${text}` } as unknown as Theme;

const runView = {
  runId: "run-1",
  goal: "implement leaf",
  state: "running",
  model: "openai/gpt-5",
  thinkingLevel: "medium",
  background: false,
  createdAt: Date.now() - 30_000,
  totalTokens: 100,
  totalCost: 0.01,
  tasks: [
    {
      taskId: "task-1",
      label: "done worker",
      state: "done",
      output: "line one\nline two",
      turns: 4,
      toolErrors: 0,
      toolSuccesses: 3,
      truncated: false,
      startedAt: Date.now() - 25_000,
      endedAt: Date.now() - 5_000,
    },
    {
      taskId: "task-2",
      label: "failing worker",
      state: "failed",
      output: "",
      error: "policy blocked",
      currentTool: "bash",
      turns: 2,
      toolErrors: 1,
      toolSuccesses: 0,
      truncated: false,
    },
  ],
};

describe("subagent render", () => {
  it("renders call rows within width for dispatch and hub forms", () => {
    const call = renderSubagentCall(
      { tasks: [{ label: "worker" }, { label: "second" }], background: true, goal: "goal text" },
      undefined,
    );
    const rows = call.render(20);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(20);
    call.invalidate();

    const hub = renderSubagentCall({ action: "list" }, undefined);
    expect(hub.render(40).join("\n")).toContain("list");
  });

  it("renders collapsed runs with group counts and one row per worker", () => {
    const result = renderSubagentResult({ details: { run: runView } }, { expanded: false, isPartial: false });
    const rows = result.render(60);
    const text = rows.join("\n");
    expect(text).not.toContain("run-1");
    expect(text).toContain("Ctrl+O");
    expect(text).toContain("1 done");
    expect(text).toContain("failing worker");
    expect(text).toContain("policy blocked");
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(60);
  });

  it("renders expanded reports with output lines", () => {
    const result = renderSubagentResult({ details: { run: runView } }, { expanded: true, isPartial: false });
    const text = result.render(80).join("\n");
    expect(text).toContain("line one");
    expect(text).toContain("tool bash");
    expect(text).toContain("turns 4");
  });

  it("renders hub lists from details.runs", () => {
    const result = renderSubagentResult(
      { details: { action: "list", runs: [{ ...runView, runId: "run-9", state: "done" }] } },
      { expanded: false, isPartial: false },
    );
    const text = result.render(50).join("\n");
    expect(text).toContain("run-9");
    expect(text).toContain("1 run");
  });

  it("tolerates malformed details and falls back to content", () => {
    const malformed = renderSubagentResult({ details: "nope" }, undefined, undefined);
    expect(malformed.render(30).length).toBeGreaterThan(0);
    const fallback = renderSubagentResult(
      { isError: true, details: { run: { tasks: "bad" } }, content: [{ type: "text", text: "boom\ndetails" }] },
      { expanded: false, isPartial: false },
    ).render(40).join("\n");
    expect(fallback).toContain("boom");
    const empty = renderSubagentResult({}, undefined, undefined).render(0);
    for (const row of empty) expect(row).toBe("");
  });

  it("strips ansi/control input and truncates narrow widths safely", () => {
    expect(sanitize("\u001b[31mred\u001b[0m\u0007 plain")).toBe("red plain");
    expect(truncate("abcdef", 0)).toBe("");
    expect(truncate("abcdef", 4)).toBe("abc…");
    const result = renderSubagentResult(
      { details: { run: { ...runView, goal: "\u001b[35mwide 漢字\u001b[0m" } } },
      { expanded: false, isPartial: true },
    );
    const rows = result.render(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(1);
  });
});

describe("subagent render readability", () => {
  const run = (tasks: unknown[], state = "running") => ({ details: { run: { runId: "run-r", state, tasks } } });

  it("pluralizes tool and error counts instead of printing '1 errors'", () => {
    const text = renderSubagentResult(
      run([
        { taskId: "a", label: "single", state: "done", output: "", turns: 1, toolSuccesses: 1, toolErrors: 1 },
        { taskId: "b", label: "many", state: "failed", output: "", turns: 3, toolSuccesses: 3, toolErrors: 2 },
      ]),
      { expanded: true },
    ).render(100).join("\n");
    expect(text).toContain("1 tool succeeded");
    expect(text).toContain("1 error");
    expect(text).not.toContain("1 errors");
    expect(text).toContain("3 tools succeeded");
    expect(text).toContain("2 errors");
  });

  it("uses one done wording and humanizes every state label", () => {
    const text = renderSubagentResult(
      run([
        { taskId: "a", label: "worker a", state: "done", output: "" },
        { taskId: "b", label: "worker b", state: "timed_out", output: "" },
        { taskId: "c", label: "worker c", state: "aborted", output: "" },
      ], "failed"),
      { expanded: false },
    ).render(80).join("\n");
    expect(text).toContain("1 done");
    expect(text).not.toContain("complete");
    expect(text).toContain("timed out");
    expect(text).toContain("aborted");
  });

  it("indents expanded detail bodies below the marked stats line", () => {
    const rows = renderSubagentResult({ details: { run: runView } }, { expanded: true }).render(80);
    const stats = rows.find((row) => row.includes("turns 4"));
    const body = rows.find((row) => row.includes("line one"));
    expect(stats).toBeDefined();
    expect(body).toBeDefined();
    expect(stats).toContain("  · turns 4");
    expect(body!.replace(/^│\s/, "")).toMatch(/^ {4}line one/);
    expect(stats!.replace(/^│\s/, "")).toMatch(/^ {2}· turns 4/);
  });

  it("separates consecutive expanded child blocks", () => {
    const rows = renderSubagentResult({ details: { run: runView } }, { expanded: true }).render(80);
    const failing = rows.findIndex((row) => row.includes("failing worker"));
    expect(failing).toBeGreaterThan(1);
    expect(rows[failing - 1].replace(/[│\s]/g, "")).toBe("");
  });

  it("offers a collapse hint when expanded and an expand hint when collapsed", () => {
    const collapsed = renderSubagentResult({ details: { run: runView } }, { expanded: false }).render(80).join("\n");
    const expanded = renderSubagentResult({ details: { run: runView } }, { expanded: true }).render(80).join("\n");
    expect(collapsed).toContain("Ctrl+O · expand task details");
    expect(expanded).toContain("Ctrl+O · collapse task details");
  });

  it("uses the accent for actionable hints and readable muted stats, never dim", () => {
    const collapsed = renderSubagentResult({ details: { run: runView } }, { expanded: false }, themeProbe).render(80).join("\n");
    expect(collapsed).toContain("{accent}Ctrl+O");
    expect(collapsed).not.toContain("{dim}Ctrl+O");
    const expanded = renderSubagentResult({ details: { run: runView } }, { expanded: true }, themeProbe).render(80).join("\n");
    expect(expanded).toContain("{muted}  · turns");
    const call = renderSubagentCall({ tasks: [{ label: "worker" }] }, themeProbe).render(60).join("\n");
    expect(call).toContain("{muted}○ worker");
  });

  it("keeps expanded details inside narrow widths", () => {
    const task = { ...runView.tasks[0], output: "wide body text that must truncate\nsecond" };
    const rows = renderSubagentResult({ details: { run: { ...runView, tasks: [task] } } }, { expanded: true }).render(12);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(12);
  });
});

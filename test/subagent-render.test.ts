import { describe, expect, it, vi } from "vitest";
import { TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderSubagentCall, renderSubagentLive, renderSubagentResult, sanitize, truncate } from "../src/subagents/render.ts";

import { setPinnedPanel } from "../src/tui/pinned-panels.ts";

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

  // Pi's render context: isError / argsComplete / executionStarted arrive only here, never on the result envelope.
  const piContext = (flags: { isError?: boolean; argsComplete?: boolean; executionStarted?: boolean } = {}) =>
    ({ state: {}, isError: false, argsComplete: true, executionStarted: false, ...flags });

  it("says a call with no usable tasks dispatched nothing instead of showing 0 assignments", () => {
    for (const args of [undefined, {}, { tasks: [] }, { goal: "ship it" }, { goal: "ship it", tasks: [] }, { goal: "ship it", tasks: "oops" }]) {
      for (const context of [undefined, piContext()]) {
        const text = renderSubagentCall(args, themeProbe, context).render(200).join("\n");
        expect(text).toContain("{error}Subagents · invalid arguments; nothing was dispatched");
        expect(text).not.toContain("0 assignments");
      }
    }
  });

  it("shows a muted 'preparing…' while the arguments are still streaming, not an error", () => {
    for (const args of [undefined, {}, { goal: "ship it" }, { goal: "ship it", tasks: [] }]) {
      const text = renderSubagentCall(args, themeProbe, piContext({ argsComplete: false })).render(200).join("\n");
      expect(text).toContain("{muted}Subagents · preparing…");
      expect(text).not.toContain("nothing was dispatched");
      expect(text).not.toContain("0 assignments");
    }
    // Execution implies complete arguments, so a late flag cannot keep the card in 'preparing'.
    expect(renderSubagentCall({}, themeProbe, piContext({ argsComplete: false, executionStarted: true })).render(200).join("\n")).toContain("invalid arguments");
    // Streaming arguments that already hold tasks render as the normal dispatch card.
    expect(renderSubagentCall({ tasks: [{ label: "worker" }] }, themeProbe, piContext({ argsComplete: false })).render(200).join("\n")).toContain("1 assignment");
  });

  it("draws nothing for a refused call: its result card speaks, with or without a goal", () => {
    for (const args of [undefined, {}, { tasks: [] }, { goal: "ship it" }, { goal: "ship it", tasks: [] }]) {
      expect(renderSubagentCall(args, themeProbe, piContext({ isError: true })).render(200)).toEqual([]);
    }
    // Hub forms and well-formed dispatches keep their card even when the result failed.
    expect(renderSubagentCall({ action: "status", runId: "run-1" }, themeProbe, piContext({ isError: true })).render(200).join("\n")).toContain("status");
  });

  it("hides the call card once its result renders (shared renderer state)", () => {
    const context = piContext();
    const args = { goal: "ship it", tasks: [{ label: "worker" }] };
    expect(renderSubagentCall(args, themeProbe, context).render(80).join("\n")).toContain("1 assignment");
    renderSubagentResult({ details: { run: runView } }, { expanded: false }, themeProbe, context);
    expect(renderSubagentCall(args, themeProbe, context).render(80)).toEqual([]);
  });

  it("leads a refused call's result with 'call refused', the error text and an error border", () => {
    const refused = { content: [{ type: "text", text: "Dispatch validation failed: tasks required\nInput: {}" }], details: undefined };
    const rows = renderSubagentResult(refused, { expanded: false, isPartial: false }, themeProbe, piContext({ isError: true })).render(80);
    expect(rows[0]).toMatch(/^\{error\}╭/);
    expect(rows.at(-1)).toMatch(/^\{error\}╰/);
    expect(rows[1]).toContain("{error}Subagents · call refused");
    expect(rows[2]).toContain("{error}Dispatch validation failed: tasks required");
    expect(rows[3]).toContain("{error}Input: {}");
    expect(rows.join("\n")).not.toContain("Live progress");
    // The same result without the flag is an ordinary text result with a neutral border.
    const plain = renderSubagentResult(refused, { expanded: false }, themeProbe, piContext()).render(80);
    expect(plain[0]).toMatch(/^\{dim\}╭/);
    expect(plain.join("\n")).not.toContain("call refused");
    // An error flag on the envelope (not how Pi delivers it) is honoured too.
    expect(renderSubagentResult({ ...refused, isError: true }, undefined, themeProbe).render(80).join("\n")).toContain("call refused");
    // Without a theme the rows stay plain text.
    expect(renderSubagentResult(refused, undefined, undefined, piContext({ isError: true })).render(80).join("\n")).toContain("Subagents · call refused");
  });

  it("renders a refused call even with no error text", () => {
    const rows = renderSubagentResult({}, undefined, themeProbe, piContext({ isError: true })).render(40);
    expect(rows.join("\n")).toContain("{error}Subagents · call refused");
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
      { details: { run: { tasks: "bad" } }, content: [{ type: "text", text: "boom\ndetails" }] },
      { expanded: false, isPartial: false },
      undefined,
      { state: {}, isError: true },
    ).render(40).join("\n");
    expect(fallback).toContain("call refused");
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

describe("elapsed-time repaint regression", () => {
  it("uses the persisted observation time when history is reopened", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(90_000);
    try {
      const result = { details: { run: { runId: "restored", state: "running", observedAt: 20_000,
        tasks: [{ label: "worker", state: "running", startedAt: 0 }] } } };
      expect(renderSubagentResult(JSON.parse(JSON.stringify(result))).render(80).join("\n")).toContain("20s");
      clock.mockReturnValue(120_000);
      expect(renderSubagentResult(JSON.parse(JSON.stringify(result))).render(80).join("\n")).toContain("20s");
      expect(renderSubagentResult(result, { isPartial: true }).render(80).join("\n")).toContain("20s");
    } finally { clock.mockRestore(); }
  });
  it("keeps historical and partial snapshots stable until real progress arrives", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(20_000);
    try {
      const result = { details: { run: { runId: "background", state: "running", tasks: [
        { label: "worker", state: "running", startedAt: 0 },
      ] } } };
      const history = renderSubagentResult(result);
      const live = renderSubagentResult(result, { isPartial: true });
      const initial = history.render(80);
      expect(initial.join("\n")).toContain("20s");
      for (const seconds of [21, 22, 23, 60]) {
        clock.mockReturnValue(seconds * 1000);
        expect(history.render(80)).toEqual(initial);
        expect(renderSubagentResult({ ...result }).render(80)).toEqual(initial);
        const rows = live.render(80);
        expect(rows).toHaveLength(initial.length + 1);
        expect(rows.join("\n")).toContain("20s");
        expect(renderSubagentResult({ ...result }, { isPartial: true }).render(80)).toEqual(rows);
      }
      expect(renderSubagentResult({ ...result }, { expanded: true }).render(80).join("\n")).toContain("20s");
      const progress = { details: { run: { ...result.details.run, tasks: [
        { label: "worker", state: "running", startedAt: 0, currentTool: "bash", turns: 1 },
      ] } } };
      const updated = renderSubagentResult(progress, { isPartial: true }).render(80).join("\n");
      expect(updated).toContain("bash");
      expect(updated).toContain("1m 0s");
      const ended = { details: { run: { ...result.details.run, tasks: [
        { label: "worker", state: "done", startedAt: 0, endedAt: 25_000 },
      ] } } };
      expect(renderSubagentResult(ended).render(80).join("\n")).toContain("25s");
    } finally { clock.mockRestore(); }
  });

  it.each([false, true])("native HUD ticks never clear above-viewport snapshots (partial=%s)", (isPartial) => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const writes: string[] = [];
    const terminal = {
      columns: 80, rows: 12, start() {}, stop() {}, write: (data: string) => writes.push(data),
      hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    } as unknown as Terminal;
    const tui = new TuiMainScreen(terminal);
    let live: ReturnType<typeof renderSubagentLive> | undefined;
    const setWidget = vi.fn();
    const ctx = { ui: { setWidget } } as any;
    try {
      const result = { details: { run: { runId: "background", state: "running", tasks: [
        { label: "worker", state: "running", startedAt: 0 },
      ] } } };
      tui.addChild(renderSubagentResult(result, { isPartial }));
      tui.addChild({ render: () => Array.from({ length: 30 }, (_, i) => `transcript ${i}`), invalidate() {} });
      const requestRender = vi.fn(() => tui.requestRender());
      setPinnedPanel(ctx, "subagents", () => {
        live = renderSubagentLive([result.details.run], undefined, requestRender);
        return live;
      }, "running");
      const create = setWidget.mock.calls.find(([key]) => key === "steak-pinned-panels")![1];
      tui.addChild(create(tui, {}));
      tui.start();
      tui.renderNow();
      expect(writes.join("")).toContain("20s");
      const rowCount = live!.render(80).length;
      for (const seconds of [21, 22, 23]) {
        writes.length = 0;
        vi.advanceTimersByTime(1000);
        expect(requestRender).toHaveBeenCalledTimes(seconds - 20);
        expect(live!.render(80)).toHaveLength(rowCount);
        tui.renderNow();
        const output = writes.join("");
        expect(output).toContain(`${seconds}s`);
        expect(output).not.toContain("\x1b[2J");
        expect(output).not.toContain("\x1b[3J");
        expect(output).not.toContain("transcript 0");
      }
      expect(setWidget.mock.calls.filter(([key]) => key === "steak-pinned-panels")).toHaveLength(1);
      setPinnedPanel(ctx, "subagents", undefined);
      vi.advanceTimersByTime(3000);
      expect(requestRender).toHaveBeenCalledTimes(3);
    } finally { setPinnedPanel(ctx, "subagents", undefined); live?.dispose(); tui.stop(); vi.useRealTimers(); }
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

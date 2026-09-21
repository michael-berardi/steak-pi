import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { applyOp, type TodoState } from "../src/todo-core.ts";
import {
  createTodoPanel,
  hasTodoPlan,
  renderTodoPanelLines,
  todoPanelStats,
  type TodoPanelTheme,
} from "../src/todo-render.ts";

const TONE_CODES: Record<string, number> = {
  accent: 36,
  success: 32,
  warning: 33,
  error: 31,
  muted: 90,
  dim: 90,
  text: 37,
};

function fakeTheme(): { theme: TodoPanelTheme; calls: string[] } {
  const calls: string[] = [];
  const theme: TodoPanelTheme = {
    fg(color, text) {
      calls.push(`fg:${color}:${text}`);
      return `\u001b[${TONE_CODES[color] ?? 37}m${text}\u001b[0m`;
    },
    bold(text) {
      calls.push(`bold:${text}`);
      return `\u001b[1m${text}\u001b[0m`;
    },
    strikethrough(text) {
      calls.push(`strike:${text}`);
      return `\u001b[9m${text}\u001b[0m`;
    },
  };
  return { theme, calls };
}

/** Wide plan: a hidden earlier phase, an active phase, and a following phase. */
const plan: TodoState = {
  phases: [
    { name: "Kickoff", items: [{ content: "install deps", status: "done" }] },
    {
      name: "Build",
      items: [
        { content: "scaffold repo", status: "done" },
        { content: "implement core", status: "in_progress" },
        { content: "add tests", status: "pending" },
        { content: "wire ui", status: "blocked", reason: "waiting on design" },
      ],
    },
    { name: "Verify", items: [{ content: "run checks", status: "pending" }] },
  ],
};

function plain(lines: string[]): string {
  return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

function widths(lines: string[]): number[] {
  return lines.map((line) => visibleWidth(line));
}

describe("todo pinned panel renderer", () => {
  it("renders a boxed panel with header, phase progress, and task markers", () => {
    const lines = renderTodoPanelLines(plan, 60);
    const text = plain(lines);

    expect(lines[0]?.startsWith("╭")).toBe(true);
    expect(lines.at(-1)?.startsWith("╰")).toBe(true);
    expect(text).toContain("TODO 2/6 done · 1 blocked");
    // Collapsed from the active phase: earlier phases are summarized, not listed.
    expect(text).toContain("… 1 earlier phase");
    expect(text).toContain("2. Build · 1/4");
    expect(text).toContain("3. Verify · 0/1");
    expect(text).toContain("[x] scaffold repo");
    expect(text).toContain("[>] implement core");
    expect(text).toContain("[ ] add tests");
    expect(text).toContain("[!] wire ui — waiting on design");
    expect(text).not.toContain("1. Kickoff");
    expect(widths(lines).every((width) => width <= 60)).toBe(true);
  });

  it("emphasizes the active task and tones every status through the theme", () => {
    const { theme, calls } = fakeTheme();
    const text = plain(renderTodoPanelLines(plan, 60, theme));

    expect(calls.some((call) => call.startsWith("fg:accent:") && call.includes("implement core"))).toBe(true);
    expect(calls.some((call) => call.startsWith("bold:") && call.includes("implement core"))).toBe(true);
    expect(calls.some((call) => call.startsWith("fg:success:") && call.includes("scaffold repo"))).toBe(true);
    expect(calls.some((call) => call.startsWith("strike:") && call.includes("scaffold repo"))).toBe(true);
    expect(calls.some((call) => call.startsWith("fg:warning:") && call.includes("wire ui"))).toBe(true);
    expect(text).toContain("implement core");
    // Active emphasis is accent+bold; only the in_progress task is bold-accent.
    expect(calls.filter((call) => call.startsWith("bold:") && call.includes("add tests"))).toEqual([]);
  });

  it("is deterministic and exposes a native component contract", () => {
    const first = renderTodoPanelLines(plan, 48);
    expect(renderTodoPanelLines(plan, 48)).toEqual(first);

    const component = createTodoPanel(plan);
    expect(component.render(48)).toEqual(first);
    expect(typeof component.invalidate).toBe("function");
    component.invalidate();
    expect(component.render(0)).toEqual([]);
    expect(createTodoPanel({ phases: [] }).render(80)).toEqual([]);
  });

  it("wraps long task content with a hanging indent at narrow widths", () => {
    const state: TodoState = {
      phases: [{
        name: "Build",
        items: [{
          content: "implement the pinned todo panel with wrapping at narrow terminal widths",
          status: "in_progress",
        }],
      }],
    };
    const lines = renderTodoPanelLines(state, 30);
    const text = plain(lines);
    for (const word of ["implement", "pinned", "wrapping", "narrow", "terminal", "widths"]) {
      expect(text).toContain(word);
    }
    expect(lines.length).toBeGreaterThan(3);
    expect(widths(lines).every((width) => width <= 30)).toBe(true);
    // Continuation rows stay indented under the task body, not the marker.
    const continuation = lines.filter((line) => line.startsWith("│") && !line.includes("["));
    expect(continuation.length).toBeGreaterThan(0);
  });

  it("truncates chrome and bounds rows at very narrow widths", () => {
    const state: TodoState = {
      phases: [{
        name: "A phase name far longer than the viewport",
        items: Array.from({ length: 20 }, (_unused, index) => ({
          content: `task ${index + 1}`,
          status: index === 0 ? "in_progress" as const : "pending" as const,
        })),
      }],
    };
    const veryNarrow = renderTodoPanelLines(state, 12);
    const veryNarrowText = plain(veryNarrow);
    expect(veryNarrow[0]?.startsWith("╭")).toBe(false);
    expect(widths(veryNarrow).every((width) => width <= 12)).toBe(true);
    expect(veryNarrowText).toContain("…");
    expect(veryNarrowText).toContain("more");

    const narrow = renderTodoPanelLines(state, 20);
    expect(widths(narrow).every((width) => width <= 20)).toBe(true);
    expect(plain(narrow)).toContain("more tasks");
  });

  it("keeps the panel bounded for very large plans", () => {
    const state: TodoState = {
      phases: Array.from({ length: 6 }, (_unused, phaseIndex) => ({
        name: `Phase ${phaseIndex + 1}`,
        items: Array.from({ length: 12 }, (_unused2, itemIndex) => ({
          content: `p${phaseIndex + 1} task ${itemIndex + 1}`,
          status: "pending" as const,
        })),
      })),
    };
    const lines = renderTodoPanelLines(state, 80, undefined, { maxRows: 10 });
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(plain(lines)).toContain("more");
    expect(widths(lines).every((width) => width <= 80)).toBe(true);
  });

  it("sanitizes terminal escapes in task and phase text", () => {
    const state: TodoState = {
      phases: [{
        name: "Build\u001b[31m red\u001b[0m",
        items: [{ content: "evil \u001b[31mred\u001b[0m\nnext", status: "pending" }],
      }],
    };
    const text = plain(renderTodoPanelLines(state, 60));
    expect(text).toContain("Build red");
    expect(text).toContain("evil red next");
    expect(renderTodoPanelLines(state, 60).join("")).not.toContain("\u001b");
  });

  it("reports plan stats and emptiness for the pinned-panel lifecycle", () => {
    expect(todoPanelStats(plan)).toEqual({ done: 2, total: 6, blocked: 1 });
    expect(hasTodoPlan(plan)).toBe(true);
    expect(hasTodoPlan({ phases: [] })).toBe(false);
    expect(hasTodoPlan({ phases: [{ name: "Empty", items: [] }] })).toBe(false);
    expect(renderTodoPanelLines({ phases: [{ name: "Empty", items: [] }] }, 80)).toEqual([]);
  });

  it("keeps the completed checklist and final count visible", () => {
    const completed = { phases: [{ name: "Finished", items: [{ content: "Task", status: "done" as const }] }] };
    expect(hasTodoPlan(completed)).toBe(true);
    expect(renderTodoPanelLines(completed, 80).join("\n")).toContain("TODO 1/1 done");
  });

  it("renders the empty-after-reset plan as no panel and keeps the tool text separate", () => {
    const state = applyOp(plan, { op: "done", phase: "Build" }).state;
    const cleared = applyOp(state, { op: "rm", phase: "Build" }).state;
    expect(hasTodoPlan(cleared)).toBe(true);
    const emptied = applyOp(cleared, { op: "rm", phase: "Verify" }).state;
    const finalState = applyOp(emptied, { op: "rm", phase: "Kickoff" }).state;
    expect(hasTodoPlan(finalState)).toBe(false);
    expect(renderTodoPanelLines(finalState, 80)).toEqual([]);
  });
});

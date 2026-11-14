import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { modelLabel, renderSubagentLive, renderSubagentResult } from "../src/subagents/render.ts";

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const probe = { fg: (tone: string, text: string) => `{${tone}}${text}{/}` } as unknown as Theme;
const WIDTHS = [60, 80, 120, 200];
const now = Date.now();

const runA = { id: "run-a", model: "harness-a/vendor-x/model-one-2", thinkingLevel: "medium", state: "running", tasks: [
  { id: "t1", label: "long-running-recheck-photos-task", state: "running", startedAt: now - 6_900_000, currentTool: "Bash" },
  { id: "t2", label: "ghost-panes", state: "running", startedAt: now - 3_250_000, currentTool: "Read" },
  { id: "t3", label: "done-one", state: "done", startedAt: now - 9_000_000, endedAt: now - 8_000_000 },
  { id: "t4", label: "waiting-task", state: "queued" },
] };
const runB = { id: "run-b", model: "claude-code/claude-alpha-9", thinkingLevel: "high", state: "running", tasks: [
  { id: "t5", label: "other-route", state: "running", startedAt: now - 5_000 },
] };

describe("subagent panel rows", () => {
  it("trims harness, vendor, claude- and date affixes to the model", () => {
    // The prefix trimmed is the route's own provider segment, never a literal name.
    expect(modelLabel("claude-code/claude-alpha-9")).toBe("alpha-9");
    expect(modelLabel("vendor-x/vendor-x-model-one")).toBe("model-one");
    expect(modelLabel("vendor-x/vendor-large-2")).toBe("large-2");
    expect(modelLabel("harness-a/vendor-x/model-one-2")).toBe("model-one-2");
    // With no provider segment nothing is stripped: no vendor name is special.
    expect(modelLabel("claude-beta-3-20251101")).toBe("claude-beta-3");
    expect(modelLabel("vendor-x-model")).toBe("vendor-x-model");
    expect(modelLabel("")).toBe("");
  });

  it.each(WIDTHS)("live panel at %i columns: name+model left, status+time right, no tool, never wider than the pane", (columns) => {
    const lines = renderSubagentLive([runA, runB], undefined).render(columns).map(strip);
    for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(columns);
    const text = lines.join("\n");
    expect(text).not.toMatch(/Bash|Read/);
    expect(text).toMatch(/Subagents · 3 working · 1 queued · 1\/5 done/);
    const row = lines.find(line => line.includes("ghost-panes"))!;
    expect(row).toMatch(/ghost-panes {2}model-one-2 +running · 54m 10s │$/);
    // A narrow pane lists three rows; the rest is summarised.
    if (columns < 70) expect(text).toContain("+1 assignment");
    else {
      expect(lines.find(line => line.includes("other-route"))).toMatch(/other-route {2}alpha-9 high +running · 5s │$/);
      expect(lines.find(line => line.includes("waiting-task"))).toMatch(/○ waiting-task {2}model-one-2 +queued │$/);
    }
    if (columns >= 80) expect(lines.find(line => line.includes("long-running"))).toMatch(/long-running-recheck-photos-task {2}model-one-2 +running · 1h 55m/);
    if (columns === 60) console.info(lines.join("\n"));
    if (columns === 200) console.info(lines.join("\n"));
  });

  it("uses the semantic tokens: name text, model muted, status in the state tone", () => {
    const row = renderSubagentLive([runB], probe).render(80).find(line => line.includes("other-route"))!;
    expect(row).toContain("{text}other-route{/}");
    expect(row).toContain("{muted}alpha-9 high{/}");
    expect(row).toContain("{accent}running · 5s{/}");
  });

  it("truncates the name before dropping the model, and drops the model only below the minimum", () => {
    const run = { ...runA, tasks: [{ id: "t", label: "a-very-long-task-name-that-cannot-fit-anywhere", state: "running", startedAt: now }] };
    const at = (columns: number) => renderSubagentLive([run], undefined).render(columns).map(strip).find(line => line.includes("a-very"))!;
    const mid = at(50);
    expect(mid).toContain("…");
    expect(mid).toContain("model-one-2");
    expect(mid).toMatch(/running · 0s │$/);
    const narrow = at(36);
    expect(narrow).toContain("a-very");
    expect(narrow).not.toContain("model-one-2");
    for (const columns of [20, 24, 30, 36, 50]) {
      for (const line of renderSubagentLive([run], undefined).render(columns).map(strip)) expect(visibleWidth(line), `${columns}: ${line}`).toBeLessThanOrEqual(columns);
    }
  });

  it("drops the thinking level before the model when width is tight", () => {
    const run = { ...runB, tasks: [{ id: "t", label: "twelve-chars", state: "running", startedAt: now }] };
    const wide = renderSubagentLive([run], undefined).render(60).map(strip).join("\n");
    expect(wide).toContain("alpha-9 high");
    const tight = renderSubagentLive([run], undefined).render(45).map(strip).join("\n");
    expect(tight).toContain("alpha-9");
    expect(tight).not.toContain("alpha-9 high");
  });

  it("a fallback hop or review fallback replaces the run route for that row", () => {
    const run = { ...runA, tasks: [
      { id: "h", label: "hopped", state: "running", startedAt: now, routeFallbacks: ["a/model-one-2->b/model-two-3"] },
      { id: "r", label: "reviewed", state: "running", startedAt: now, reviewFallback: { from: "x/y", to: "z/model-three-4", reason: "quota" } },
    ] };
    const text = renderSubagentLive([run], undefined).render(100).map(strip).join("\n");
    expect(text).toMatch(/hopped {2}model-two-3/);
    expect(text).toMatch(/reviewed {2}model-three-4/);
  });

  it.each(WIDTHS)("completion summary and expanded details at %i columns keep the same row form", (columns) => {
    const details = { run: { ...runA, runId: "run-a", state: "done", goal: "goal", tasks: [
      { label: "done-one", state: "done", startedAt: 0, endedAt: 25_000, currentTool: "Bash", turns: 2 },
      { label: "failed-one", state: "failed", startedAt: 0, endedAt: 5_000, error: "boom", turns: 1 },
    ] } };
    for (const expanded of [false, true]) {
      const lines = renderSubagentResult({ details }, { expanded }).render(columns).map(strip);
      for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(columns);
      const text = lines.join("\n");
      expect(text).toMatch(/✓ done-one {2}model-one-2 +done · 25s │/);
      expect(text).toMatch(/! failed-one {2}model-one-2 +failed · 5s │/);
      if (expanded) expect(text).toContain("tool Bash");
      else expect(text).not.toContain("Bash");
    }
  });

  it("a multi-run summary names each run's own model", () => {
    const text = renderSubagentResult({ details: { runs: [{ ...runA, runId: "run-a" }, { ...runB, runId: "run-b" }] } }).render(100).map(strip).join("\n");
    expect(text).toMatch(/run-a · .*model-one-2/);
    expect(text).toMatch(/run-b · .*alpha-9 high/);
  });

  it("a hop cut off by the hop cap still labels the destination route, from actualRoute", () => {
    const long = (name: string) => `${name}/${"m".repeat(60)}`;
    const hop = `${long("provider-a")}->${long("provider-b")}`;
    const task = { id: "h", label: "hopped", state: "running", startedAt: now, routeFallbacks: [hop.slice(0, 96)], actualRoute: long("provider-b") };
    const text = renderSubagentLive([{ ...runA, tasks: [task] }], undefined).render(200).map(strip).join("\n");
    expect(text).toContain("m".repeat(22));
    expect(text).toContain("…");
  });

  it("a later hop wins over an earlier review fallback", () => {
    const task = { id: "r", label: "later", state: "running", startedAt: now, reviewFallback: { from: "x/y", to: "z/model-three-4", reason: "quota" },
      routeFallbacks: ["x/y->z/model-three-4", "z/model-three-4->w/model-five-6"], actualRoute: "w/model-five-6" };
    expect(renderSubagentLive([{ ...runA, tasks: [task] }], undefined).render(100).map(strip).join("\n")).toMatch(/later {2}model-five-6/);
  });

  describe("odd labels never overflow a narrow pane", () => {
    const wide = "数据处理任务数据处理任务", emoji = "🚀🚀🚀 launch 👨‍👩‍👧‍👦👨‍👩‍👧‍👦", colored = "\x1b[31mred\x1b[0m-task-with-colour";
    const tasks = [wide, emoji, colored, "plain"].map((label, index) => ({ id: `w${index}`, label, state: "running", startedAt: now }))
      .concat([{ id: "nm", label: "no-model", state: "running", startedAt: now }]);
    const bare = { id: "run-n", state: "running", tasks: [tasks[4]] };
    const runWide = { ...runA, tasks: tasks.slice(0, 4).map((task) => ({ ...task, route: "harness-a/数据-model-🚀" })) };
    it.each([6, 10, 24, 60])("at %i columns every line fits and has no raw escape", (columns) => {
      for (const run of [runWide, { ...runA, tasks: tasks.slice(0, 4) }, bare]) {
        for (const render of [renderSubagentLive([run], undefined), renderSubagentResult({ details: { run: { ...run, runId: "r", state: "done" } } })]) {
          const raw = render.render(columns);
          expect(raw.length).toBeGreaterThan(0);
          for (const line of raw) {
            expect(visibleWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(columns);
            expect(strip(line)).not.toMatch(/\x1b/);
          }
        }
      }
    });
    it("a task with no model shows the name and status without a model cell", () => {
      const text = renderSubagentLive([bare], undefined).render(60).map(strip).join("\n");
      expect(text).toMatch(/no-model +running/);
    });
    it("pads a tiny unframed row by visible columns", () => {
      const run = { ...bare, tasks: [{ id: "c", label: "数据处理任务", state: "running", startedAt: now }] };
      for (const line of renderSubagentLive([run], undefined).render(6)) expect(visibleWidth(line), line).toBeLessThanOrEqual(6);
    });
  });
});

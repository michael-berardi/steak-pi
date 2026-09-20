import { describe, expect, it, vi } from "vitest";
import { TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { renderSubagentLive } from "../src/subagents/render.ts";
import { setPinnedPanel, type PanelFactory } from "../src/tui/pinned-panels.ts";
function fixture() {
  const setWidget = vi.fn();
  const ctx = { ui: { setWidget } } as any;
  const render = () => {
    const value = setWidget.mock.calls.filter(([key]) => key === "steak-pinned-panels").at(-1)?.[1];
    return typeof value === "function" ? value({}, {}).render(80) : [];
  };
  return { ctx, setWidget, render };
}
const panel = (text: string): PanelFactory => () => ({ render: () => [text], invalidate() {} });
describe("pinned panel compositor", () => {
  it("keeps one widget mounted and suppresses repeated invisible progress updates", () => {
    const h = fixture(), requestRender = vi.fn();
    setPinnedPanel(h.ctx, "subagents", panel("Reading"), "reading");
    const create = h.setWidget.mock.calls.find(([key]) => key === "steak-pinned-panels")![1];
    const component = create({ requestRender }, {});
    expect(component.render(80)).toEqual(["Reading"]);
    for (let i = 0; i < 100; i++) setPinnedPanel(h.ctx, "subagents", panel("Reading"), "reading");
    expect(requestRender).not.toHaveBeenCalled();
    setPinnedPanel(h.ctx, "subagents", panel("Editing"), "editing");
    expect(requestRender).toHaveBeenCalledOnce();
    expect(component.render(80)).toEqual(["Editing"]);
    expect(h.setWidget.mock.calls.filter(([key]) => key === "steak-pinned-panels")).toHaveLength(1);
    setPinnedPanel(h.ctx, "subagents", undefined);
    expect(h.setWidget.mock.calls.at(-1)).toEqual(["steak-pinned-panels", undefined]);
  });
  it("native timer updates and replacement children do not clear a fixed-height pinned layout", () => {
    const writes: string[] = [];
    const terminal = {
      columns: 80, rows: 12, start() {}, stop() {}, write: (data: string) => writes.push(data),
      hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    } as unknown as Terminal;
    const tui = new TuiMainScreen(terminal);
    const h = fixture();
    let elapsed = 20;
    setPinnedPanel(h.ctx, "subagents", panel("Subagents · reading"), "reading");
    setPinnedPanel(h.ctx, "todo", panel("Todo · testing"), "testing");
    const create = h.setWidget.mock.calls.find(([key]) => key === "steak-pinned-panels")![1];
    const pinned = create(tui, {});
    tui.addChild({ render: () => Array.from({ length: 30 }, (_, i) => `history ${i}`), invalidate() {} });
    tui.addChild(pinned);
    tui.addChild({ render: () => [`Composer · ${elapsed}s`, "Editor", "Footer"], invalidate() {} });
    try {
      tui.start();
      tui.renderNow();
      for (elapsed = 21; elapsed <= 23; elapsed++) {
        // Factory identity changes, but the row count and mount stay fixed.
        setPinnedPanel(h.ctx, "subagents", panel(`Subagents · tool ${elapsed}`), String(elapsed));
        writes.length = 0;
        tui.renderNow();
        expect(pinned.render(80)).toEqual([`Subagents · tool ${elapsed}`, "Todo · testing"]);
        expect(writes.join("")).toContain(`${elapsed}s`);
        expect(writes.join("")).not.toMatch(/\x1b\[(?:2|3)J/);
        expect(writes.join("")).not.toContain("history 0");
      }
      expect(h.setWidget.mock.calls.filter(([key]) => key === "steak-pinned-panels")).toHaveLength(1);
    } finally { tui.stop(); pinned.dispose(); }
  });

  it("disposes ticking children immediately on replacement, removal and remount", () => {
    vi.useFakeTimers();
    const h = fixture(), firstPaint = vi.fn(), nextPaint = vi.fn();
    const live: PanelFactory = (tui) => renderSubagentLive([{ tasks: [{ label: "worker", state: "running", startedAt: 0 }] }], undefined, () => tui.requestRender());
    try {
      setPinnedPanel(h.ctx, "subagents", live, "first");
      const create = h.setWidget.mock.calls.find(([key]) => key === "steak-pinned-panels")![1];
      const old = create({ requestRender: firstPaint }, {});
      old.render(80);
      expect(vi.getTimerCount()).toBe(1);
      setPinnedPanel(h.ctx, "subagents", live, "next");
      expect(vi.getTimerCount()).toBe(0);
      old.render(80);
      expect(vi.getTimerCount()).toBe(1);
      const next = create({ requestRender: nextPaint }, {});
      expect(vi.getTimerCount()).toBe(0);
      next.render(80);
      old.dispose();
      vi.advanceTimersByTime(1000);
      expect(nextPaint).toHaveBeenCalledOnce();
      setPinnedPanel(h.ctx, "todo", panel("Todo"));
      expect(nextPaint).toHaveBeenCalledTimes(2);
      setPinnedPanel(h.ctx, "subagents", undefined);
      expect(vi.getTimerCount()).toBe(0);
      setPinnedPanel(h.ctx, "subagents", live);
      next.render(80);
      setPinnedPanel(h.ctx, "todo", undefined);
      setPinnedPanel(h.ctx, "subagents", undefined);
      expect(vi.getTimerCount()).toBe(0);
      next.dispose();
    } finally { vi.useRealTimers(); }
  });

  it("always puts subagents above todo, irrespective of update order", () => {
    const h = fixture();
    setPinnedPanel(h.ctx, "todo", panel("Todo"));
    setPinnedPanel(h.ctx, "subagents", panel("Subagents"));
    expect(h.render()).toEqual(["Subagents", "Todo"]);
    setPinnedPanel(h.ctx, "todo", panel("Updated todo"));
    expect(h.render()).toEqual(["Subagents", "Updated todo"]);
    expect(h.setWidget.mock.calls.at(-1)?.[2]).toEqual({ placement: "aboveEditor" });
  });
  it("clears only the requesting owner and removes an empty combined widget", () => {
    const h = fixture();
    setPinnedPanel(h.ctx, "subagents", panel("Subagents"));
    setPinnedPanel(h.ctx, "todo", panel("Todo"));
    setPinnedPanel(h.ctx, "subagents", undefined);
    expect(h.render()).toEqual(["Todo"]);
    setPinnedPanel(h.ctx, "todo", undefined);
    expect(h.render()).toEqual([]);
  });
  it("isolates native UI identities and forwards invalidation/disposal", () => {
    const a = fixture(), b = fixture();
    const invalidate = vi.fn(), dispose = vi.fn();
    setPinnedPanel(a.ctx, "todo", () => ({ render: () => ["A"], invalidate, dispose }));
    setPinnedPanel(b.ctx, "subagents", panel("B"));
    expect(a.render()).toEqual(["A"]); expect(b.render()).toEqual(["B"]);
    const create = a.setWidget.mock.calls.filter(([key]) => key === "steak-pinned-panels").at(-1)![1];
    const component = create({}, {}); component.render(80); component.invalidate(); component.dispose();
    expect(invalidate).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledTimes(2);
  });
});

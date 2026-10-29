import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { HoldDeleteEditor, holdDeleteEnabled } from "../src/tui/hold-delete-editor.ts";

const settings = vi.hoisted(() => ({ text: "{}" }));
vi.mock("node:fs", () => ({ readFileSync: () => settings.text }));
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { Editor: NativeEditor } = await import("@earendil-works/pi-tui");
  return {
    getAgentDir: () => "/agent",
    CustomEditor: class extends NativeEditor {
      constructor(tui: TUI, theme: EditorTheme, _keys: unknown, options?: EditorOptions) {
        super(tui, theme, options);
      }
    },
  };
});
const identity = (s: string) => s;
const theme: EditorTheme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
function editor() {
  const tui = { terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as TUI;
  return new HoldDeleteEditor(tui, theme, {} as ConstructorParameters<typeof HoldDeleteEditor>[2]);
}
function repeat(e: Editor, count: number, interval = 100, key = "\x7f") {
  for (let i = 0; i < count; i++) { e.handleInput(key); vi.advanceTimersByTime(interval); }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); settings.text = "{}"; });
afterEach(() => vi.useRealTimers());

describe("hold Backspace", () => {
  it("clears all lines after >2 seconds without submit or interrupt", () => {
    const e = editor(); const submit = vi.fn(); const interrupt = vi.fn();
    e.onSubmit = submit; e.onEscape = interrupt; e.setText("first line\n" + "x".repeat(80));
    repeat(e, 21); expect(e.getText()).not.toBe("");
    e.handleInput("\x7f"); expect(e.getText()).toBe("");
    repeat(e, 3); expect(submit).not.toHaveBeenCalled(); expect(interrupt).not.toHaveBeenCalled();
  });
  it("preserves normal deletion under two seconds", () => {
    const e = editor(); e.setText("abcdef"); repeat(e, 3); expect(e.getText()).toBe("abc");
  });
  it("does not clear on separated taps", () => {
    const e = editor(); e.setText("first\n" + "x".repeat(80)); repeat(e, 25, 200); expect(e.getText()).toBe("first\n" + "x".repeat(55));
  });
  it("resets on another key and accepts legacy 0x08", () => {
    const e = editor(); e.setText("first\n" + "x".repeat(80));
    repeat(e, 15, 100, "\x08"); e.handleInput("a"); repeat(e, 10, 100, "\x08");
    expect(e.getText()).not.toBe("");
  });
  it("uses kitty repeat flags even across long repeat gaps", () => {
    const e = editor(); e.setText("first\n" + "x".repeat(80));
    e.handleInput("\x1b[127u"); repeat(e, 4, 800, "\x1b[127;1:2u");
    expect(e.getText()).toBe("");
  });
  it("does not treat pasted backspace bytes as a hold", () => {
    const e = editor(); e.setText("first\n" + "x".repeat(80));
    e.handleInput("\x1b[200~"); repeat(e, 25); e.handleInput("\x1b[201~");
    expect(e.getText()).toContain("first");
  });
  it("honors the off setting", () => {
    settings.text = '{"holdDeleteClearsInput":false}'; expect(holdDeleteEnabled()).toBe(false);
    const e = editor(); e.setText("first\n" + "x".repeat(80)); repeat(e, 25); expect(e.getText()).toBe("first\n" + "x".repeat(55));
  });
  it("ends a kitty hold on release and starts a new one on press", () => {
    const e = editor(); e.setText("first\n" + "x".repeat(80));
    e.handleInput("\x1b[127u"); repeat(e, 15, 100, "\x1b[127;1:2u");
    e.handleInput("\x1b[127;1:3u"); e.handleInput("\x1b[127u");
    repeat(e, 10, 100, "\x1b[127;1:2u"); expect(e.getText()).not.toBe("");
  });
});

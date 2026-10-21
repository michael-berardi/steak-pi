import { describe, expect, it, vi } from "vitest";
import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import companionUiExtension from "../extensions/statusline.ts";

// Real paste registry/input/submission; only adapt CustomEditor's constructor.
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { Editor: NativeEditor } = await import("@earendil-works/pi-tui");
  return { CustomEditor: class extends NativeEditor {
    constructor(tui: TUI, theme: EditorTheme, _keys: unknown, options?: EditorOptions) {
      super(tui, theme, options);
    }
  } };
});
const identity = (text: string) => text;
const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};
const payload = Array.from({ length: 25 }, (_, i) => `Synthetic note ${i + 1}: keep every word, café and 🌱.`).join("\n");
const suffix = " help me do a new linkedin post about this";

function host() {
  const tui = { terminal: { rows: 32 }, requestRender: vi.fn() } as unknown as TUI;
  let editor: Editor = new Editor(tui, editorTheme);
  const onSubmit = vi.fn();
  editor.onSubmit = onSubmit;
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const copiedCompact: string[] = [];
  const restored = vi.fn((text: string) => editor.setText(text));
  const theme = { ...editorTheme, fg: (_token: string, text: string) => text, bold: identity };
  const ctx = {
    mode: "tui", cwd: "/fixture", model: { provider: "openai-codex", id: "gpt-6.1-sol" }, thinkingLevel: "medium",
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [], getSessionName: () => undefined, getSessionFile: () => undefined },
    ui: {
      theme, setHeader: vi.fn(), setFooter: vi.fn(), setWorkingVisible: vi.fn(), setWorkingMessage: vi.fn(),
      // Pi's public UI getter expands the *old native* editor's paste map.
      getEditorText: () => editor.getExpandedText(),
      setEditorText: restored,
      setEditorComponent(factory: any) {
        // Actual reviewed Pi host replacement contract: snapshot getText(),
        // then setText() on a new instance, which has no old paste registry.
        const text = editor.getText();
        copiedCompact.push(text);
        editor = factory(tui, editorTheme, { matches: () => false });
        editor.onSubmit = onSubmit;
        editor.setText(text);
      },
    },
  };
  companionUiExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
  return { current: () => editor, copiedCompact, restored, onSubmit, start: () => handlers.get("session_start")?.({ reason: "startup" }, ctx) };
}
function paste(editor: Editor, text: string) { editor.handleInput(`\x1b[200~${text}\x1b[201~`); }
function type(editor: Editor, text: string) { for (const char of text) editor.handleInput(char); }

describe("first native-to-Steak editor replacement", () => {
  it("preserves a paste and trailing instruction entered before companion startup finishes", async () => {
    const fixture = host();
    paste(fixture.current(), payload);
    type(fixture.current(), suffix);
    expect(fixture.current().getText()).toBe("[paste #1 +25 lines]" + suffix);
    expect(fixture.current().getExpandedText()).toBe(payload + suffix);
    await fixture.start();
    expect(fixture.copiedCompact).toEqual(["[paste #1 +25 lines]" + suffix]);
    expect(fixture.current().getText()).toBe(payload + suffix);
    fixture.current().handleInput("\r");
    expect(fixture.onSubmit).toHaveBeenCalledExactlyOnceWith(payload + suffix);
  });

  it("preserves distinct early pastes, prefix, suffix and whitespace without guessing marker strings", async () => {
    const fixture = host();
    type(fixture.current(), "  Prefix ");
    paste(fixture.current(), payload);
    type(fixture.current(), " between ");
    const second = payload.replaceAll("Synthetic", "Another");
    paste(fixture.current(), second);
    type(fixture.current(), suffix + "  ");
    const expected = "  Prefix " + payload + " between " + second + suffix + "  ";
    await fixture.start();
    expect(fixture.current().getText()).toBe(expected);
    fixture.current().handleInput("\r");
    expect(fixture.onSubmit).toHaveBeenCalledExactlyOnceWith(expected.trim());
  });

  it("keeps literal marker-looking text with no registered paste untouched", async () => {
    const fixture = host();
    const literal = "Describe [paste #1 +25 lines] as a literal example.";
    fixture.current().setText(literal);
    await fixture.start();
    expect(fixture.current().getText()).toBe(literal);
    fixture.current().handleInput("\r");
    expect(fixture.onSubmit).toHaveBeenCalledExactlyOnceWith(literal);
  });

  it("does not reset an empty startup draft", async () => {
    const fixture = host();
    await fixture.start();
    expect(fixture.restored).not.toHaveBeenCalled();
    expect(fixture.current().getText()).toBe("");
  });
});

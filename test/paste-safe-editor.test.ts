import { describe, expect, it, vi } from "vitest";
import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { PasteSafeEditor } from "../src/tui/paste-safe-editor.ts";

// As in companion-extension.test.ts, avoid the coding-agent root's optional
// server modules. Only adapt CustomEditor's constructor: all text, paste,
// rendering, submission, deletion and undo behavior comes from the real Editor.
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { Editor: NativeEditor } = await import("@earendil-works/pi-tui");
  return {
    CustomEditor: class extends NativeEditor {
      constructor(tui: TUI, theme: EditorTheme, _keybindings: unknown, options?: EditorOptions) {
        super(tui, theme, options);
      }
    },
  };
});

const identity = (text: string): string => text;
const theme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};
const LONG_QUOTE = `“${'The garden notebook records seed counts, rainfall, and careful observations. '.repeat(22)}Keep  two spaces, café, 🌱, and literal $& / $1.”`;
// Below 1000 characters: this exercises the independent >10-lines threshold.
const MULTILINE = Array.from({ length: 12 }, (_, index) => `Row ${index + 1}: "seed ${index}"  stays intact.`).join("\n");
const PREFIX = "Please review this quote:\n\n";
const SUFFIX = "\n\nKeep every word and punctuation mark.";
const QUEUED = "queued\n\n";
const ENTER = "\r";
const BACKSPACE = "\x7f";
const UNDO = "\x1f"; // Native default ctrl+- binding.

function makeEditor(native = false) {
  const tui = { terminal: { rows: 30 }, requestRender: vi.fn() } as unknown as TUI;
  const keybindings = { matches: () => false } as unknown as ConstructorParameters<typeof PasteSafeEditor>[2];
  const editor = native ? new Editor(tui, theme) : new PasteSafeEditor(tui, theme, keybindings);
  const onSubmit = vi.fn();
  editor.onSubmit = onSubmit;
  return { editor, onSubmit };
}

function paste(editor: Editor, text: string): void {
  editor.handleInput(`\x1b[200~${text}\x1b[201~`);
}

function typeText(editor: Editor, text: string): void {
  // Key input is delivered one character at a time; LF is native ctrl+j.
  for (const character of text) editor.handleInput(character);
}

function compose(editor: Editor, payload = LONG_QUOTE): string {
  typeText(editor, PREFIX);
  paste(editor, payload);
  typeText(editor, SUFFIX);
  return PREFIX + payload + SUFFIX;
}

function submit(editor: Editor, onSubmit: ReturnType<typeof vi.fn>, expected: string): void {
  editor.handleInput(ENTER);
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith(expected);
  expect(editor.getText()).toBe("");
  expect(editor.getExpandedText()).toBe("");
}

describe("PasteSafeEditor with native Pi Editor behavior", () => {
  it("reproduces native data loss at the host getText -> setText -> Enter boundary", () => {
    const { editor, onSubmit } = makeEditor(true);
    const expected = compose(editor);
    const marker = `[paste #1 ${LONG_QUOTE.length} chars]`;
    expect(editor.getText()).toBe(PREFIX + marker + SUFFIX);
    expect(editor.getExpandedText()).toBe(expected);

    // Pi's dequeue/prepend flow clears the paste registry via setText().
    editor.setText(QUEUED + editor.getText());
    expect(editor.getExpandedText()).toBe(QUEUED + PREFIX + marker + SUFFIX);
    editor.handleInput(ENTER);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(QUEUED + PREFIX + marker + SUFFIX);
    expect(onSubmit.mock.calls[0][0]).not.toContain(LONG_QUOTE);
  });

  it.each([
    ["long single-line quote", LONG_QUOTE],
    ["more than ten lines", MULTILINE],
  ])("preserves exact prefix + %s + suffix through host prepend and Enter", (_label, payload) => {
    const { editor, onSubmit } = makeEditor();
    const expected = compose(editor, payload);
    expect(Editor.prototype.getText.call(editor)).toMatch(/\[paste #1 /);
    expect(editor.getText()).toBe(expected);
    expect(editor.getExpandedText()).toBe(expected);

    editor.setText(QUEUED + editor.getText());
    expect(editor.getText()).toBe(QUEUED + expected);
    expect(editor.getExpandedText()).toBe(QUEUED + expected);
    submit(editor, onSubmit, QUEUED + expected);
  });

  it("submits a long paste exactly on simple Enter, without a host rewrite", () => {
    const { editor, onSubmit } = makeEditor();
    submit(editor, onSubmit, compose(editor));
  });

  it("keeps ordinary typing and Enter native", () => {
    const { editor, onSubmit } = makeEditor();
    editor.handleInput("A short garden note.");
    submit(editor, onSubmit, "A short garden note.");
  });

  it("preserves two distinct collapsed pastes in order through a host rewrite", () => {
    const { editor, onSubmit } = makeEditor();
    typeText(editor, PREFIX);
    paste(editor, LONG_QUOTE);
    typeText(editor, "\n\nSecond excerpt:\n");
    paste(editor, MULTILINE);
    typeText(editor, SUFFIX);
    const expected = PREFIX + LONG_QUOTE + "\n\nSecond excerpt:\n" + MULTILINE + SUFFIX;
    const compact = Editor.prototype.getText.call(editor);
    expect(compact).toContain(`[paste #1 ${LONG_QUOTE.length} chars]`);
    expect(compact).toContain("[paste #2 +12 lines]");
    expect(editor.getText()).toBe(expected);
    editor.setText(QUEUED + editor.getText());
    submit(editor, onSubmit, QUEUED + expected);
  });

  it("buffers bracketed paste across separate input chunks until the closing marker", () => {
    const { editor, onSubmit } = makeEditor();
    typeText(editor, PREFIX);
    editor.handleInput("\x1b[200~");
    editor.handleInput(LONG_QUOTE.slice(0, 411));
    editor.handleInput(LONG_QUOTE.slice(411));
    // Even getText() must not expose an incomplete paste or submit it early.
    expect(editor.getText()).toBe(PREFIX);
    expect(onSubmit).not.toHaveBeenCalled();
    // Split the closing delimiter too, then resume normal key input.
    editor.handleInput("\x1b[20");
    editor.handleInput("1~");
    typeText(editor, SUFFIX);
    const expected = PREFIX + LONG_QUOTE + SUFFIX;
    expect(editor.getText()).toBe(expected);
    expect(Editor.prototype.getText.call(editor)).toContain(`[paste #1 ${LONG_QUOTE.length} chars]`);
    editor.setText(QUEUED + editor.getText());
    submit(editor, onSubmit, QUEUED + expected);
  });

  it("leaves literal marker-looking text without a registered paste untouched", () => {
    const { editor, onSubmit } = makeEditor();
    const literal = "Examples: [paste #1 1234 chars], [paste #2 +12 lines], [paste #3].";
    editor.setText(literal);
    expect(editor.getText()).toBe(literal);
    expect(editor.getExpandedText()).toBe(literal);
    editor.setText(QUEUED + editor.getText());
    submit(editor, onSubmit, QUEUED + literal);
  });

  it("preserves unregistered literal markers alongside and inside a real paste", () => {
    const { editor, onSubmit } = makeEditor();
    // Use IDs not owned by a paste: native expansion intentionally recognizes
    // every occurrence of a registered ID, including user-authored lookalikes.
    const payload = LONG_QUOTE + " Literal example: [paste #999 +42 lines].";
    const prefix = "Keep [paste #998 1234 chars] literally: ";
    typeText(editor, prefix);
    paste(editor, payload);
    typeText(editor, SUFFIX);
    const expected = prefix + payload + SUFFIX;
    expect(editor.getText()).toBe(expected);
    editor.setText(QUEUED + editor.getText());
    submit(editor, onSubmit, QUEUED + expected);
  });

  it("preserves draft payload when the host replaces the editor instance", () => {
    const old = makeEditor();
    const expected = compose(old.editor);
    const draft = old.editor.getText();
    const replacement = makeEditor();
    replacement.editor.setText(draft);
    expect(replacement.editor.getText()).toBe(expected);
    expect(replacement.editor.getExpandedText()).toBe(expected);
    submit(replacement.editor, replacement.onSubmit, expected);
    expect(old.onSubmit).not.toHaveBeenCalled();
  });

  it("preserves a non-overlay dialog's getText snapshot and setText restore", () => {
    const { editor, onSubmit } = makeEditor();
    const expected = compose(editor);
    // Non-overlay UI temporarily clears/reuses the main editor, then restores
    // the draft string; the original paste registry no longer exists.
    const savedDraft = editor.getText();
    editor.setText("");
    editor.setText("Temporary dialog input");
    editor.setText(savedDraft);
    expect(editor.getText()).toBe(expected);
    expect(editor.getExpandedText()).toBe(expected);
    submit(editor, onSubmit, expected);
  });

  it("returns full payload without expanding native render or internal lines", () => {
    const { editor } = makeEditor();
    paste(editor, LONG_QUOTE);
    const marker = `[paste #1 ${LONG_QUOTE.length} chars]`;
    expect(editor.getText()).toBe(LONG_QUOTE);
    expect(editor.getExpandedText()).toBe(LONG_QUOTE);
    expect(editor.getLines()).toEqual([marker]);
    expect(Editor.prototype.getText.call(editor)).toBe(marker);
    const rendered = editor.render(80).join("\n");
    expect(rendered).toContain(marker);
    expect(rendered).not.toContain("The garden notebook");
    expect(editor.getExpandedText()).toBe(LONG_QUOTE);
  });

  it("keeps native atomic paste backspace and undo payload restoration", () => {
    const { editor, onSubmit } = makeEditor();
    editor.handleInput("Before: ");
    paste(editor, LONG_QUOTE);
    editor.handleInput("!");
    editor.handleInput(BACKSPACE);
    expect(editor.getText()).toBe("Before: " + LONG_QUOTE);
    editor.handleInput(BACKSPACE); // Delete the whole collapsed marker.
    expect(editor.getText()).toBe("Before: ");
    expect(editor.getExpandedText()).toBe("Before: ");
    editor.handleInput(UNDO); // Native undo restores both marker and registry.
    expect(editor.getText()).toBe("Before: " + LONG_QUOTE);
    expect(Editor.prototype.getText.call(editor)).toContain(`[paste #1 ${LONG_QUOTE.length} chars]`);
    submit(editor, onSubmit, "Before: " + LONG_QUOTE);
  });

  it("undoes a host prepend back to the original collapsed paste and payload", () => {
    const { editor, onSubmit } = makeEditor();
    const expected = compose(editor);
    editor.setText(QUEUED + editor.getText());
    editor.handleInput(UNDO);
    expect(editor.getText()).toBe(expected);
    expect(editor.getExpandedText()).toBe(expected);
    expect(Editor.prototype.getText.call(editor)).toContain(`[paste #1 ${LONG_QUOTE.length} chars]`);
    submit(editor, onSubmit, expected);
  });

  it("preserves outer whitespace in snapshots while leaving native Enter trimming unchanged", () => {
    const { editor, onSubmit } = makeEditor();
    paste(editor, "  \n" + LONG_QUOTE + "\n  ");
    const snapshot = "  \n" + LONG_QUOTE + "\n  ";
    expect(editor.getText()).toBe(snapshot);
    editor.setText(editor.getText());
    expect(editor.getText()).toBe(snapshot);
    // Native submitValue() trims the outer draft, unlike getExpandedText().
    submit(editor, onSubmit, LONG_QUOTE);
  });
});

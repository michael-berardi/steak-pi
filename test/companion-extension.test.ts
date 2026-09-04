import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import companionUiExtension from "../extensions/statusline.ts";
import { stripAnsi } from "../src/tui/format.ts";

// Pi's unbundled root eagerly resolves optional server modules that are absent
// from this package's lean dev install. The isolated TUI smoke test exercises
// the real bundled host; this lifecycle unit only needs CustomEditor's surface.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  CustomEditor: class {
    private text = "";
    protected renderedVisibleLineCount = 1;
    protected borderColor = (text: string): string => text;
    constructor(..._args: unknown[]) {}
    setText(text: string): void { this.text = text; }
    getText(): string { return this.text; }
    handleInput(_data: string): void {}
    render(_width: number): string[] { return ["", this.text || "Type a message…", ""]; }
  },
}));

describe("companion extension integration", () => {
  it("installs native components and follows Pi lifecycle events", async () => {
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => unknown) {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
    } as unknown as ExtensionAPI;

    let headerFactory: any;
    let footerFactory: any;
    let editorFactory: any;
    let workingVisible: boolean | undefined;
    const workingMessages: Array<string | undefined> = [];
    let renders = 0;
    let entryReads = 0;
    const entries = [{
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, cost: { total: 0.01 } },
      },
    }];
    const theme = {
      fg: (_token: string, text: string) => text,
      bold: (text: string) => text,
      borderColor: (text: string) => text,
    };
    const ctx = {
      mode: "tui",
      cwd: "/Users/demo/project",
      model: { provider: "zai", id: "glm-5.3-flash" },
      thinkingLevel: "high",
      getContextUsage: () => ({ percent: 12.5, contextWindow: 131_072, tokens: 16_384 }),
      sessionManager: {
        getEntries: () => {
          entryReads += 1;
          return entries;
        },
        getSessionName: () => "release",
        getSessionFile: () => "/tmp/resumed-session.jsonl",
      },
      ui: {
        theme,
        setHeader(factory: any) { headerFactory = factory; },
        setFooter(factory: any) { footerFactory = factory; },
        setEditorComponent(factory: any) { editorFactory = factory; },
        setWorkingVisible(value: boolean) { workingVisible = value; },
        setWorkingMessage(value?: string) { workingMessages.push(value); },
      },
    };
    const emit = async (name: string, event: any = {}) => {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    };

    companionUiExtension(pi);
    await emit("session_start", { reason: "resume" });
    expect(headerFactory).toBeTypeOf("function");
    expect(footerFactory).toBeTypeOf("function");
    expect(editorFactory).toBeTypeOf("function");
    expect(workingVisible).toBe(false);

    const tui = {
      terminal: { rows: 30 },
      requestRender: () => { renders += 1; },
    };
    const extensionStatuses = new Map<string, string>();
    const footerData = {
      getGitBranch: () => "main",
      getExtensionStatuses: () => extensionStatuses,
      onBranchChange: (_callback: () => void) => () => {},
    };
    const header = headerFactory(tui, theme);
    const footer = footerFactory(tui, theme, footerData);
    const editor = editorFactory(tui, theme, { matches: () => false });
    expect(header.render(80).join(" ")).toContain("STEAK PI");
    expect(stripAnsi(editor.render(80)[0])).toContain("resumed");
    expect(stripAnsi(editor.render(80)[1])).toContain("╰─");
    expect(stripAnsi(editor.render(80)[1])).toContain("Ask anything");
    const readsAfterFirstRender = entryReads;
    footer.render(80);
    footer.render(120);
    expect(entryReads).toBe(readsAfterFirstRender);

    await emit("agent_start");
    expect(editor.render(80)[0]).toContain("thinking");
    await emit("message_update", { assistantMessageEvent: { type: "text_delta" } });
    expect(editor.render(80)[0]).toContain("responding");
    const rendersAtFirstTextDelta = renders;
    for (let index = 0; index < 1_000; index += 1) {
      await emit("message_update", { assistantMessageEvent: { type: "text_delta" } });
    }
    expect(renders).toBe(rendersAtFirstTextDelta);
    await emit("tool_execution_start", { toolCallId: "one", toolName: "read" });
    await emit("tool_execution_start", { toolCallId: "two", toolName: "grep" });
    expect(editor.render(80)[0]).toContain("tools 2");
    await emit("tool_execution_end", { toolCallId: "one", toolName: "read", isError: false });
    await emit("tool_execution_end", { toolCallId: "two", toolName: "grep", isError: false });
    await emit("agent_settled");
    expect(editor.render(80)[0]).toContain("complete");
    expect(editor.render(80)[0]).toContain("cache 75%");
    expect(footer.render(80)).toEqual([]);
    expect(workingMessages.at(-1)).toBeUndefined();
    expect(renders).toBeGreaterThan(5);
    extensionStatuses.set("verify", "✓ verify\nready");
    expect(footer.render(80)[0]).toContain("✓ verify ready");
    extensionStatuses.clear();

    await emit("ui_prompt_start", { title: "Approve\nunsafe\u001b[31m" });
    expect(editor.render(80)[0]).toContain("waiting");
    expect(workingMessages.at(-1)).toBe("waiting for input");
    await emit("ui_prompt_end");
    expect(editor.render(80)[0]).toContain("ready");

    await emit("session_before_compact", { reason: "manual" });
    expect(editor.render(80)[0]).toContain("compacting");
    await emit("session_compact_failed", { aborted: false, errorMessage: "compact\nfailed" });
    expect(stripAnsi(editor.render(80)[0])).toContain("error · compact failed");
    await emit("session_before_compact", { reason: "manual" });
    await emit("session_compact", { reason: "manual" });
    expect(editor.render(80)[0]).toContain("compacted");

    await emit("agent_start");
    await emit("tool_execution_start", { toolCallId: "bad", toolName: "unsafe\ntool" });
    expect(workingMessages.at(-1)).toBe("running tool");
    await emit("tool_execution_end", { toolCallId: "bad", toolName: "unsafe\ntool", isError: true });
    await emit("agent_settled");
    expect(stripAnsi(editor.render(80)[0])).toContain("error · unsafe tool");

    await emit("agent_start");
    await emit("message_end", {
      message: { role: "assistant", stopReason: "aborted", errorMessage: "Request\ninterrupted" },
    });
    await emit("agent_settled");
    expect(stripAnsi(editor.render(80)[0])).toContain("stopped · Request interrupted");

    const originalContextUsage = ctx.getContextUsage;
    ctx.getContextUsage = () => { throw new Error("synthetic render failure"); };
    const fallback = footer.render(12);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toBe("Steak Pi");
    ctx.getContextUsage = originalContextUsage;
  });

  it("does not install TUI components in print, JSON, or RPC modes", async () => {
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const pi = {
      on(name: string, handler: (event: any, ctx: any) => unknown) { handlers.set(name, handler); },
    } as unknown as ExtensionAPI;
    companionUiExtension(pi);
    let installed = false;
    for (const mode of ["print", "json", "rpc"]) {
      await handlers.get("session_start")?.(
        { reason: "startup" },
        {
          mode,
          sessionManager: { getEntries: () => [] },
          ui: {
            setHeader: () => { installed = true; },
            setFooter: () => { installed = true; },
          },
        },
      );
    }
    expect(installed).toBe(false);
  });
});

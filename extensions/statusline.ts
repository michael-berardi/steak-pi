import { companionActivity, createActivitySignal } from "../src/tui/activity-signal.ts";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  initialCompanionState,
  reduceCompanionState,
  type CompanionAction,
  type CompanionState,
} from "../src/tui/model.ts";
import {
  collectUsage,
  emptyUsage,
  renderCompanionFooter,
  renderCompanionHeader,
  renderComposerBand,
  type ContextSnapshot,
  type SemanticPalette,
} from "../src/tui/render.ts";

/**
 * Steak Pi companion UI.
 *
 * This gives Pi's native editor Steak Pi's integrated status band and prompt gutter,
 * while preserving CustomEditor's editing, autocomplete, history, IME, mouse,
 * application shortcuts, and submission behavior. Transcript and tool renderers
 * remain native. Every color comes from the active Pi theme; there is no polling,
 * subprocess, provider hook, or idle background work.
 */

function paletteFor(theme: Theme): SemanticPalette {
  return {
    accent: (text) => theme.fg("accent", text),
    text: (text) => theme.fg("text", text),
    muted: (text) => theme.fg("muted", text),
    dim: (text) => theme.fg("dim", text),
    success: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    error: (text) => theme.fg("error", text),
    bold: (text) => theme.bold(text),
  };
}

function sessionHint(reason: string, hasConversation: boolean, sessionFile?: string): string {
  if (reason === "resume" || (reason === "startup" && hasConversation && sessionFile)) return "resumed";
  if (reason === "fork") return "forked";
  if (reason === "new") return "new session";
  return "";
}

function contextSnapshot(ctx: ExtensionContext): ContextSnapshot | undefined {
  const usage = ctx.getContextUsage();
  if (!usage) return undefined;
  return {
    percent: usage.percent ?? null,
    contextWindow: usage.contextWindow,
  };
}

function sameState(left: CompanionState, right: CompanionState): boolean {
  if (
    left.phase !== right.phase ||
    left.detail !== right.detail ||
    left.agentActive !== right.agentActive ||
    left.promptDepth !== right.promptDepth ||
    left.hadError !== right.hadError
  ) return false;
  const leftTools = Object.entries(left.activeTools);
  const rightTools = Object.entries(right.activeTools);
  return leftTools.length === rightTools.length &&
    leftTools.every(([id, name]) => right.activeTools[id] === name);
}

function workingMessage(state: CompanionState): string | undefined {
  switch (state.phase) {
    case "thinking": return "thinking";
    case "responding": return "responding";
    case "tool": return Object.keys(state.activeTools).length > 1 ? "running tools" : "running tool";
    case "waiting": return "waiting for input";
    case "compacting": return "compacting";
    default: return undefined;
  }
}

export default function companionUiExtension(pi: ExtensionAPI): void {
  let state: CompanionState = initialCompanionState();
  let requestRender = () => {};
  let usageDirty = true;
  let cachedUsage = emptyUsage();

  let signalMode = "";
  const signalActivity = createActivitySignal(
    (data) => { process.stdout.write(data); },
    () => ({ mode: signalMode, isTTY: !!process.stdout.isTTY, slot: process.env.ULTRATERM_SLOT }),
  );
  const emitActivity = (ctx: ExtensionContext, reset = false) => {
    signalMode = ctx.mode;
    signalActivity(companionActivity(state), reset);
  };

  const update = (action: CompanionAction, ctx: ExtensionContext) => {
    const next = reduceCompanionState(state, action);
    if (sameState(state, next)) return;
    state = next;
    emitActivity(ctx);
    ctx.ui.setWorkingMessage(workingMessage(state));
    requestRender();
  };

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;

    const entries = ctx.sessionManager.getEntries();
    const hasConversation = entries.some((entry) =>
      entry.type === "message" &&
      (entry.message.role === "user" || entry.message.role === "assistant" || entry.message.role === "toolResult")
    );
    state = initialCompanionState(
      sessionHint(
        event.reason,
        hasConversation,
        ctx.sessionManager.getSessionFile() ?? undefined,
      ),
    );
    emitActivity(ctx, true);
    usageDirty = true;

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number) {
        return renderCompanionHeader(width, paletteFor(theme));
      },
    }));

    let footerData: ReadonlyFooterDataProvider | undefined;
    const snapshot = () => {
      const model = ctx.model as { provider?: string } | undefined;
      return {
        state,
        cwd: ctx.cwd,
        branch: footerData?.getGitBranch() ?? undefined,
        sessionName: ctx.sessionManager.getSessionName() ?? undefined,
        model: ctx.model,
        provider: model?.provider,
        thinking: ctx.thinkingLevel,
        usage: (() => {
          if (usageDirty) {
            cachedUsage = collectUsage(ctx.sessionManager.getEntries());
            usageDirty = false;
          }
          return cachedUsage;
        })(),
        context: contextSnapshot(ctx),

      };
    };

    ctx.ui.setFooter((tui, theme, data: ReadonlyFooterDataProvider) => {
      footerData = data;
      requestRender = () => tui.requestRender();
      const unsubscribe = data.onBranchChange(requestRender);
      return {
        dispose() {
          unsubscribe();
          footerData = undefined;
          requestRender = () => {};
        },
        invalidate() {},
        render(width: number) {
          try {
            return renderCompanionFooter(width, {
              extensionStatuses: Array.from(
          footerData?.getExtensionStatuses().entries() ?? [],
        )
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, value]) => value),
            }, paletteFor(theme));
          } catch {
            return [theme.fg("dim", "Steak Pi".slice(0, Math.max(0, width)))];
          }
        },
      };
    });

    class SteakBandEditor extends CustomEditor {
      constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
        super(tui, theme, keybindings, { paddingX: 0 });
      }

      private contentLineCount(): number {
        return (this as unknown as { renderedVisibleLineCount: number })
          .renderedVisibleLineCount;
      }

      override render(width: number): string[] {
        if (width <= 3) return super.render(width);
        const gutterWidth = 3;
        const innerWidth = width - gutterWidth;
        const base = super.render(innerWidth);
        const contentCount = this.contentLineCount();
        const theme = ctx.ui.theme;
        const content = base.slice(1, 1 + contentCount).map((line, index) => {
          let rendered = line;
          if (index === 0 && this.getText().length === 0) {
            const cursor = truncateToWidth(rendered, 1, "");
            const hint = theme.fg(
              "dim",
              truncateToWidth(" Ask anything, edit files, run tools", innerWidth - 1, ""),
            );
            const used = visibleWidth(cursor) + visibleWidth(hint);
            rendered = cursor + hint + " ".repeat(Math.max(0, innerWidth - used));
          }
          const gutter = index === 0 ? "╰─ " : "   ";
          return this.borderColor(gutter) + rendered;
        });
        const autocomplete = base.slice(contentCount + 2).map(
          (line) => this.borderColor("   ") + line,
        );
        return [
          renderComposerBand(width, snapshot(), paletteFor(theme)),
          ...content,
          ...autocomplete,
        ];
      }

      override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        if (event.width <= 3) return super.handleMouse(event);
        if (event.y === 0) return { handled: true, focus: true };
        const contentCount = this.contentLineCount();
        return super.handleMouse({
          ...event,
          width: event.width - 3,
          x: Math.max(0, event.x - 3),
          y: event.y > contentCount ? event.y + 1 : event.y,
        });
      }
    }

    ctx.ui.setWorkingVisible(false);
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new SteakBandEditor(tui, theme, keybindings),
    );
    requestRender();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    signalMode = ctx.mode;
    signalActivity("idle", true);
  });

  pi.on("agent_start", async (_event, ctx) => update({ type: "agent_start" }, ctx));

  pi.on("message_update", async (event, ctx) => {
    const type = event.assistantMessageEvent.type;
    if (type.startsWith("thinking")) update({ type: "stream", kind: "thinking" }, ctx);
    else if (type.startsWith("text")) update({ type: "stream", kind: "text" }, ctx);
    else if (type.startsWith("toolcall")) update({ type: "stream", kind: "toolcall" }, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    usageDirty = true;
    requestRender();
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
      update(
        {
          type: "message_error",
          aborted: event.message.stopReason === "aborted",
          message: event.message.errorMessage,
        },
        ctx,
      );
    }
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    update({ type: "tool_start", id: event.toolCallId, name: event.toolName }, ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    update(
      { type: "tool_end", id: event.toolCallId, name: event.toolName, isError: event.isError },
      ctx,
    );
  });

  pi.on("ui_prompt_start", async (event, ctx) => {
    update({ type: "prompt_start", title: event.title }, ctx);
  });
  pi.on("ui_prompt_end", async (_event, ctx) => update({ type: "prompt_end" }, ctx));

  pi.on("session_before_compact", async (_event, ctx) => {
    update({ type: "compact_start" }, ctx);
    return undefined;
  });
  pi.on("session_compact", async (_event, ctx) => {
    usageDirty = true;
    update({ type: "compact_end" }, ctx);
  });
  pi.on("session_compact_failed", async (event, ctx) => {
    update(
      { type: "compact_fail", aborted: event.aborted, message: event.errorMessage },
      ctx,
    );
  });

  pi.on("session_tree", async (_event, _ctx) => {
    usageDirty = true;
    requestRender();
  });
  pi.on("agent_settled", async (_event, ctx) => update({ type: "settled" }, ctx));
  pi.on("model_select", async (_event, _ctx) => requestRender());
  pi.on("thinking_level_select", async (_event, _ctx) => requestRender());
  pi.on("session_info_changed", async (_event, _ctx) => requestRender());
}

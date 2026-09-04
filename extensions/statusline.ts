import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
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
  type ContextSnapshot,
  type SemanticPalette,
} from "../src/tui/render.ts";

/**
 * Steak Pi companion UI.
 *
 * This changes only Pi's native header, footer, and streaming indicator. The
 * stock editor, transcript, tool renderers, selectors, and keybindings remain
 * untouched. Every color comes from the active Pi theme, so no UltraTerm-theme
 * matrix, polling loop, subprocess, or background task is required.
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

  const update = (action: CompanionAction, ctx: ExtensionContext) => {
    const next = reduceCompanionState(state, action);
    if (sameState(state, next)) return;
    state = next;
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
    usageDirty = true;

    ctx.ui.setHeader((_tui, theme) => ({
      invalidate() {},
      render(width: number) {
        return renderCompanionHeader(width, paletteFor(theme));
      },
    }));

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);
      return {
        dispose() {
          unsubscribe();
          requestRender = () => {};
        },
        invalidate() {},
        render(width: number) {
          try {
            const model = ctx.model as { provider?: string } | undefined;
            return renderCompanionFooter(
              width,
              {
                state,
                cwd: ctx.cwd,
                branch: footerData.getGitBranch() ?? undefined,
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
                extensionStatuses: Array.from(footerData.getExtensionStatuses().entries())
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([, value]) => value),
              },
              paletteFor(theme),
            );
          } catch {
            const fallback = "Steak Pi".slice(0, Math.max(0, width));
            return [theme.fg("dim", fallback), ""];
          }
        },
      };
    });

    ctx.ui.setWorkingIndicator({
      // Unstyled frames follow the terminal's current foreground across live theme changes.
      frames: ["·", "•", "●", "•"],
      intervalMs: 140,
    });
    requestRender();
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

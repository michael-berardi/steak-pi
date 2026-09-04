export type UiPhase =
  | "ready"
  | "thinking"
  | "responding"
  | "tool"
  | "waiting"
  | "compacting"
  | "complete"
  | "error"
  | "stopped";

export interface CompanionState {
  phase: UiPhase;
  detail: string;
  agentActive: boolean;
  promptDepth: number;
  hadError: boolean;
  activeTools: Readonly<Record<string, string>>;
}

export type CompanionAction =
  | { type: "session"; hint?: string }
  | { type: "agent_start" }
  | { type: "stream"; kind: "thinking" | "text" | "toolcall" }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; name: string; isError?: boolean }
  | { type: "prompt_start"; title?: string }
  | { type: "prompt_end" }
  | { type: "compact_start" }
  | { type: "compact_end" }
  | { type: "compact_fail"; aborted?: boolean; message?: string }
  | { type: "message_error"; aborted?: boolean; message?: string }
  | { type: "settled" };

export function initialCompanionState(hint = ""): CompanionState {
  return {
    phase: "ready",
    detail: hint,
    agentActive: false,
    promptDepth: 0,
    hadError: false,
    activeTools: {},
  };
}

export function reduceCompanionState(state: CompanionState, action: CompanionAction): CompanionState {
  switch (action.type) {
    case "session":
      return initialCompanionState(action.hint ?? "");
    case "agent_start":
      return {
        ...state,
        phase: "thinking",
        detail: "",
        agentActive: true,
        hadError: false,
        activeTools: {},
      };
    case "stream":
      return {
        ...state,
        phase: action.kind === "text" ? "responding" : "thinking",
        detail: action.kind === "toolcall" ? "preparing tool" : "",
        agentActive: true,
        hadError: false,
      };
    case "tool_start": {
      const activeTools = { ...state.activeTools, [action.id]: action.name };
      return {
        ...state,
        phase: state.hadError ? "error" : "tool",
        detail: state.hadError ? state.detail : "",
        agentActive: true,
        activeTools,
      };
    }
    case "tool_end": {
      const activeTools = { ...state.activeTools };
      delete activeTools[action.id];
      if (action.isError) {
        return { ...state, phase: "error", detail: action.name, hadError: true, activeTools };
      }
      if (state.hadError) return { ...state, phase: "error", activeTools };
      return {
        ...state,
        phase: Object.keys(activeTools).length > 0 ? "tool" : "thinking",
        detail: "",
        activeTools,
      };
    }
    case "prompt_start":
      return {
        ...state,
        phase: "waiting",
        detail: action.title ?? "input needed",
        promptDepth: state.promptDepth + 1,
      };
    case "prompt_end": {
      const promptDepth = Math.max(0, state.promptDepth - 1);
      const phase = promptDepth > 0
        ? "waiting"
        : state.hadError
          ? "error"
          : Object.keys(state.activeTools).length > 0
            ? "tool"
            : state.agentActive
              ? "thinking"
              : "ready";
      return { ...state, phase, detail: "", promptDepth };
    }
    case "compact_start":
      return { ...state, phase: "compacting", detail: "" };
    case "compact_end":
      return { ...state, phase: "ready", detail: "compacted", hadError: false };
    case "compact_fail":
      return {
        ...state,
        phase: action.aborted ? "stopped" : "error",
        detail: action.message ?? (action.aborted ? "compaction cancelled" : "compaction failed"),
        hadError: !action.aborted,
      };
    case "message_error":
      return {
        ...state,
        phase: action.aborted ? "stopped" : "error",
        detail: action.message ?? "",
        hadError: !action.aborted,
      };
    case "settled":
      return {
        ...state,
        phase: state.hadError || state.phase === "error"
          ? "error"
          : state.phase === "stopped"
            ? "stopped"
            : "complete",
        detail: state.hadError || state.phase === "error" || state.phase === "stopped" ? state.detail : "",
        agentActive: false,
        activeTools: {},
      };
  }
}

export type StatusTone = "dim" | "accent" | "success" | "warning" | "error";

export function statusPresentation(state: CompanionState): { text: string; tone: StatusTone } {
  const tools = Object.values(state.activeTools);
  switch (state.phase) {
    case "ready":
      return { text: state.detail ? `● ${state.detail}` : "● ready", tone: "dim" };
    case "thinking":
      return { text: state.detail ? `◆ ${state.detail}` : "◆ thinking", tone: "accent" };
    case "responding":
      return { text: "◆ responding", tone: "accent" };
    case "tool":
      return {
        text: tools.length > 1 ? `◆ tools ${tools.length}` : `◆ tool ${tools[0] ?? "running"}`,
        tone: "accent",
      };
    case "waiting":
      return { text: state.detail ? `◇ waiting · ${state.detail}` : "◇ waiting", tone: "warning" };
    case "compacting":
      return { text: "◆ compacting", tone: "warning" };
    case "complete":
      return { text: "✓ complete", tone: "success" };
    case "error":
      return { text: state.detail ? `! error · ${state.detail}` : "! error", tone: "error" };
    case "stopped":
      return { text: state.detail ? `! stopped · ${state.detail}` : "! stopped", tone: "warning" };
  }
}

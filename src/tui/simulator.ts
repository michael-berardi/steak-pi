import { fileURLToPath } from "node:url";
import { displayWidth, dropLastGrapheme, oneLine, truncatePlain } from "./format.ts";
import { initialCompanionState, reduceCompanionState, type CompanionState } from "./model.ts";
import {
  emptyUsage,
  plainPalette,
  renderCompanionFooter,
  renderCompanionHeader,
  type FooterSnapshot,
  type SemanticPalette,
} from "./render.ts";

export type TranscriptKind = "user" | "assistant" | "thinking" | "tool" | "error" | "notice";

export interface TranscriptBlock {
  kind: TranscriptKind;
  text: string;
  label?: string;
}

export interface SimulatorState {
  width: number;
  height: number;
  companion: CompanionState;
  transcript: readonly TranscriptBlock[];
  editor: string;
  history: readonly string[];
  historyIndex: number;
  scrollOffset: number;
  footer: Omit<FooterSnapshot, "state">;
}

export type SimulatorAction =
  | { type: "input"; text: string }
  | { type: "backspace" }
  | { type: "enter" }
  | { type: "history_previous" }
  | { type: "history_next" }
  | { type: "page_up" }
  | { type: "page_down" }
  | { type: "prompt_open"; title?: string }
  | { type: "prompt_close" }
  | { type: "escape" }
  | { type: "resize"; width: number; height: number };

function ansi(open: string): (text: string) => string {
  return (text) => (text ? `\x1b[${open}m${text}\x1b[0m` : "");
}

/** Fixed ANSI palette for deterministic snapshots; production always uses Pi's active theme. */
export const simulatorAnsiPalette: SemanticPalette = {
  accent: ansi("35"),
  text: ansi("39"),
  muted: ansi("90"),
  dim: ansi("2"),
  success: ansi("32"),
  warning: ansi("33"),
  error: ansi("31"),
  bold: ansi("1"),
};

function stateAfter(actions: Parameters<typeof reduceCompanionState>[1][]): CompanionState {
  return actions.reduce(reduceCompanionState, initialCompanionState());
}

const baseFooter: Omit<FooterSnapshot, "state"> = {
  cwd: "/Users/demo/dev/steak-pi",
  home: "/Users/demo",
  branch: "main",
  model: { id: "zai/glm-5.3-flash" },
  provider: "zai",
  thinking: "high",
  usage: {
    input: 2_140,
    output: 682,
    cacheRead: 8_930,
    cacheWrite: 120,
    cost: 0.018,
  },
  context: { percent: 18.4, contextWindow: 131_072 },
};

function scenarioFixture(name: string): { state: CompanionState; transcript: TranscriptBlock[] } {
  const user: TranscriptBlock = { kind: "user", text: "Refine the terminal workspace without disturbing live sessions." };
  switch (name) {
    case "startup":
      return { state: initialCompanionState(), transcript: [] };
    case "prompt":
      return {
        state: stateAfter([
          { type: "agent_start" },
          { type: "prompt_start", title: "Approve change" },
        ]),
        transcript: [user, { kind: "notice", text: "Waiting for operator input." }],
      };
    case "thinking":
      return {
        state: stateAfter([{ type: "agent_start" }, { type: "stream", kind: "thinking" }]),
        transcript: [user, { kind: "thinking", text: "Inspecting the existing rendering path and constraints." }],
      };
    case "streaming":
      return {
        state: stateAfter([{ type: "agent_start" }, { type: "stream", kind: "text" }]),
        transcript: [user, { kind: "assistant", text: "The active pane now keeps its native surface while inactive panes dim consistently…" }],
      };
    case "tool":
      return {
        state: stateAfter([
          { type: "agent_start" },
          { type: "tool_start", id: "1", name: "read" },
        ]),
        transcript: [user, { kind: "tool", label: "read", text: "src/components/TerminalPane.tsx · 214 lines" }],
      };
    case "error":
      return {
        state: stateAfter([
          { type: "agent_start" },
          { type: "message_error", message: "request failed" },
          { type: "settled" },
        ]),
        transcript: [user, { kind: "error", text: "Request failed. Check the provider connection and retry." }],
      };
    case "compacting":
      return {
        state: stateAfter([{ type: "compact_start" }]),
        transcript: [
          user,
          { kind: "assistant", text: "Implementation and focused verification are complete." },
          { kind: "notice", text: "Compressing earlier context with UltraCompress." },
        ],
      };
    case "resumed":
      return {
        state: initialCompanionState("resumed"),
        transcript: [
          { kind: "notice", text: "Session resumed with prior context intact." },
          user,
          { kind: "assistant", text: "Continuing from the verified checkpoint." },
        ],
      };
    case "complete":
    default:
      return {
        state: stateAfter([{ type: "agent_start" }, { type: "stream", kind: "text" }, { type: "settled" }]),
        transcript: [user, { kind: "assistant", text: "Done. The UI remains native, theme-aware, and idle-cost free." }],
      };
  }
}

export function createSimulatorState(
  scenario = "startup",
  width = 80,
  height = 24,
): SimulatorState {
  const fixture = scenarioFixture(scenario);
  return {
    width: Math.max(20, Math.floor(width)),
    height: Math.max(10, Math.floor(height)),
    companion: fixture.state,
    transcript: fixture.transcript,
    editor: "",
    history: [],
    historyIndex: 0,
    scrollOffset: 0,
    footer: { ...baseFooter, usage: { ...baseFooter.usage }, context: { ...baseFooter.context! } },
  };
}

function wrapPlain(value: string, width: number): string[] {
  const clean = oneLine(value);
  if (!clean) return [""];
  const result: string[] = [];
  let line = "";
  for (const word of clean.split(" ")) {
    if (displayWidth(word) > width) {
      if (line) result.push(line);
      let rest = word;
      while (displayWidth(rest) > width) {
        const part = truncatePlain(rest, width, "");
        result.push(part);
        rest = rest.slice(part.length);
      }
      line = rest;
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (displayWidth(candidate) <= width) line = candidate;
    else {
      result.push(line);
      line = word;
    }
  }
  if (line || result.length === 0) result.push(line);
  return result;
}

function blockTone(kind: TranscriptKind, palette: SemanticPalette): (text: string) => string {
  switch (kind) {
    case "user": return palette.accent;
    case "thinking": return palette.dim;
    case "tool": return palette.muted;
    case "error": return palette.error;
    case "notice": return palette.warning;
    case "assistant": return palette.text;
  }
}

function renderTranscript(blocks: readonly TranscriptBlock[], width: number, palette: SemanticPalette): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    const label = block.label ?? block.kind;
    lines.push(palette.bold(blockTone(block.kind, palette)(label)));
    for (const line of wrapPlain(block.text, Math.max(1, width - 2))) {
      lines.push(`  ${blockTone(block.kind, palette)(line)}`);
    }
    lines.push("");
  }
  return lines;
}

export function renderSimulator(state: SimulatorState, palette: SemanticPalette = simulatorAnsiPalette): string[] {
  const width = state.width;
  const height = state.height;
  const header = renderCompanionHeader(width, palette);
  const editor = [
    palette.accent("─".repeat(width)),
    palette.text(truncatePlain(state.editor || "Type a message…", width)),
    palette.accent("─".repeat(width)),
  ];
  const footer = renderCompanionFooter(width, { ...state.footer, state: state.companion }, palette);
  const fixedHeight = header.length + 1 + editor.length + footer.length;
  const bodyHeight = Math.max(0, height - fixedHeight);
  const transcript = renderTranscript(state.transcript, width, palette);
  const maxStart = Math.max(0, transcript.length - bodyHeight);
  const start = Math.max(0, maxStart - state.scrollOffset);
  const body = transcript.slice(start, start + bodyHeight);
  while (body.length < bodyHeight) body.push("");
  return [...header, "", ...body, ...editor, ...footer].slice(0, height);
}

export function reduceSimulator(state: SimulatorState, action: SimulatorAction): SimulatorState {
  switch (action.type) {
    case "input":
      return { ...state, editor: state.editor + action.text, historyIndex: state.history.length };
    case "backspace":
      return { ...state, editor: dropLastGrapheme(state.editor) };
    case "enter": {
      const text = oneLine(state.editor);
      if (!text) return state;
      const history = [...state.history, text];
      return {
        ...state,
        editor: "",
        history,
        historyIndex: history.length,
        scrollOffset: 0,
        transcript: [...state.transcript, { kind: "user", text }],
        companion: reduceCompanionState(state.companion, { type: "agent_start" }),
      };
    }
    case "history_previous": {
      if (state.history.length === 0) return state;
      const historyIndex = Math.max(0, state.historyIndex - 1);
      return { ...state, historyIndex, editor: state.history[historyIndex] ?? "" };
    }
    case "history_next": {
      const historyIndex = Math.min(state.history.length, state.historyIndex + 1);
      return { ...state, historyIndex, editor: state.history[historyIndex] ?? "" };
    }
    case "page_up":
      return { ...state, scrollOffset: state.scrollOffset + Math.max(1, Math.floor(state.height / 2)) };
    case "page_down":
      return { ...state, scrollOffset: Math.max(0, state.scrollOffset - Math.max(1, Math.floor(state.height / 2))) };
    case "prompt_open":
      return {
        ...state,
        companion: reduceCompanionState(state.companion, {
          type: "prompt_start",
          title: action.title,
        }),
      };
    case "prompt_close":
      return {
        ...state,
        companion: reduceCompanionState(state.companion, { type: "prompt_end" }),
      };
    case "escape":
      return state.companion.agentActive
        ? {
            ...state,
            companion: reduceCompanionState(state.companion, {
              type: "message_error",
              aborted: true,
              message: "interrupted",
            }),
          }
        : state;
    case "resize":
      return {
        ...state,
        width: Math.max(20, Math.floor(action.width)),
        height: Math.max(10, Math.floor(action.height)),
      };
  }
}

function cli(): void {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
  };
  const scenario = value("--scenario", "complete");
  const width = Number(value("--width", "80"));
  const height = Number(value("--height", "24"));
  const palette = args.includes("--plain") ? plainPalette : simulatorAnsiPalette;
  process.stdout.write(`${renderSimulator(createSimulatorState(scenario, width, height), palette).join("\n")}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) cli();

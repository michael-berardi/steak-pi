import { describe, expect, it } from "vitest";
import { displayWidth, stripAnsi } from "../src/tui/format.ts";
import { plainPalette } from "../src/tui/render.ts";
import {
  createSimulatorState,
  reduceSimulator,
  renderSimulator,
} from "../src/tui/simulator.ts";

describe("deterministic headless TUI", () => {
  const scenarios = [
    "startup", "prompt", "thinking", "streaming", "tool", "error", "complete", "compacting", "resumed",
  ];

  it("renders every lifecycle state deterministically with bounded ANSI lines", () => {
    for (const scenario of scenarios) {
      for (const [width, height] of [[40, 14], [80, 24], [120, 32]] as const) {
        const state = createSimulatorState(scenario, width, height);
        const first = renderSimulator(state);
        const second = renderSimulator(state);
        expect(second).toEqual(first);
        expect(first).toHaveLength(height);
        for (const line of first) {
          expect(displayWidth(line), `${scenario} ${width}: ${stripAnsi(line)}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("captures the compact completed hierarchy", () => {
    const output = renderSimulator(createSimulatorState("complete", 48, 16), plainPalette);
    expect(output).toEqual([
      "◆ STEAK PI                   native Pi companion",
      "type / · /model · /resume",
      "",
      "user",
      "  Refine the terminal workspace without",
      "  disturbing live sessions.",
      "",
      "assistant",
      "  Done. The UI remains native, theme-aware, and",
      "  idle-cost free.",
      "",
      "",
      "",
      "",
      "◆ > glm5.3-flash · high > ✓ complete ▶──────────",
      "╰─ Ask anything, edit files, run tools",
    ]);
  });

  it("keeps editor history and submit behavior keyboard-driven", () => {
    let state = createSimulatorState("startup", 60, 18);
    state = reduceSimulator(state, { type: "input", text: "first prompt" });
    state = reduceSimulator(state, { type: "enter" });
    expect(state.editor).toBe("");
    expect(state.history).toEqual(["first prompt"]);
    expect(state.companion.phase).toBe("thinking");
    expect(state.transcript.at(-1)).toEqual({ kind: "user", text: "first prompt" });

    state = reduceSimulator(state, { type: "history_previous" });
    expect(state.editor).toBe("first prompt");
    state = reduceSimulator(state, { type: "history_next" });
    expect(state.editor).toBe("");
    state = reduceSimulator(state, { type: "input", text: "👩‍💻" });
    state = reduceSimulator(state, { type: "backspace" });
    expect(state.editor).toBe("");
  });

  it("preserves content and visibly scrolls an overflowing transcript across resize", () => {
    let state = createSimulatorState("resumed", 80, 16);
    state = {
      ...state,
      transcript: Array.from({ length: 18 }, (_, index) => ({
        kind: "notice" as const,
        text: `checkpoint ${index + 1}`,
      })),
    };
    const transcript = state.transcript;
    const bottom = renderSimulator(state, plainPalette);
    state = reduceSimulator(state, { type: "page_up" });
    const earlier = renderSimulator(state, plainPalette);
    expect(state.scrollOffset).toBeGreaterThan(0);
    expect(earlier).not.toEqual(bottom);
    expect(earlier.join("\n")).toContain("checkpoint");

    state = reduceSimulator(state, { type: "resize", width: 24, height: 12 });
    expect(state.transcript).toBe(transcript);
    const compact = renderSimulator(state);
    expect(compact).toHaveLength(12);
    expect(compact.every((line) => displayWidth(line) <= 24)).toBe(true);
    state = reduceSimulator(state, { type: "page_down" });
    expect(state.scrollOffset).toBeGreaterThanOrEqual(0);
  });

  it("models blocking prompt open/close around an active agent", () => {
    let state = createSimulatorState("thinking", 80, 20);
    state = reduceSimulator(state, { type: "prompt_open", title: "Approve change" });
    expect(state.companion.phase).toBe("waiting");
    state = reduceSimulator(state, { type: "prompt_close" });
    expect(state.companion.phase).toBe("thinking");
  });

  it("models escape interruption without destroying transcript or editor state", () => {
    let state = createSimulatorState("thinking", 80, 20);
    state = reduceSimulator(state, { type: "input", text: "queued follow-up" });
    const transcript = state.transcript;
    state = reduceSimulator(state, { type: "escape" });
    expect(state.companion.phase).toBe("stopped");
    expect(state.editor).toBe("queued follow-up");
    expect(state.transcript).toBe(transcript);
  });
});

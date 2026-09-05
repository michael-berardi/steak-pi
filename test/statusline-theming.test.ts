import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { displayWidth, fitSides, stripAnsi, truncatePlain } from "../src/tui/format.ts";
import {
  initialCompanionState,
  reduceCompanionState,
  statusPresentation,
} from "../src/tui/model.ts";
import {
  collectUsage,
  plainPalette,
  renderCompanionFooter,
  renderCompanionHeader,
  renderComposerBand,
  type SemanticPalette,
} from "../src/tui/render.ts";
import { simulatorAnsiPalette } from "../src/tui/simulator.ts";

describe("companion state", () => {
  it("covers startup, streaming, parallel tools, completion, and resume", () => {
    let state = initialCompanionState("resumed");
    expect(statusPresentation(state).text).toBe("● resumed");

    state = reduceCompanionState(state, { type: "agent_start" });
    expect(state.phase).toBe("thinking");
    state = reduceCompanionState(state, { type: "stream", kind: "text" });
    expect(state.phase).toBe("responding");
    state = reduceCompanionState(state, { type: "tool_start", id: "a", name: "read" });
    state = reduceCompanionState(state, { type: "tool_start", id: "b", name: "grep" });
    expect(statusPresentation(state).text).toBe("◆ tools 2");
    state = reduceCompanionState(state, { type: "tool_end", id: "a", name: "read" });
    expect(statusPresentation(state).text).toBe("◆ tool grep");
    state = reduceCompanionState(state, { type: "tool_end", id: "b", name: "grep" });
    state = reduceCompanionState(state, { type: "settled" });
    expect(statusPresentation(state)).toEqual({ text: "✓ complete", tone: "success" });
  });

  it("preserves error and interruption states when the agent settles", () => {
    const errored = reduceCompanionState(
      reduceCompanionState(initialCompanionState(), { type: "agent_start" }),
      { type: "message_error", message: "network" },
    );
    expect(reduceCompanionState(errored, { type: "settled" }).phase).toBe("error");

    const stopped = reduceCompanionState(errored, {
      type: "message_error",
      aborted: true,
      message: "interrupted",
    });
    expect(reduceCompanionState(stopped, { type: "settled" }).phase).toBe("stopped");
  });

  it("latches parallel tool errors regardless of sibling completion order", () => {
    let state = reduceCompanionState(initialCompanionState(), { type: "agent_start" });
    state = reduceCompanionState(state, { type: "tool_start", id: "a", name: "read" });
    state = reduceCompanionState(state, { type: "tool_start", id: "b", name: "grep" });
    state = reduceCompanionState(state, { type: "tool_end", id: "a", name: "read", isError: true });
    state = reduceCompanionState(state, { type: "tool_end", id: "b", name: "grep" });
    expect(reduceCompanionState(state, { type: "settled" }).phase).toBe("error");

    state = reduceCompanionState(state, { type: "stream", kind: "text" });
    expect(reduceCompanionState(state, { type: "settled" }).phase).toBe("complete");
  });

  it("restores an active tool after nested prompts and tracks compaction", () => {
    let state = reduceCompanionState(initialCompanionState(), { type: "agent_start" });
    state = reduceCompanionState(state, { type: "tool_start", id: "a", name: "question" });
    state = reduceCompanionState(state, { type: "prompt_start", title: "Approve edit" });
    state = reduceCompanionState(state, { type: "prompt_start", title: "Choose path" });
    expect(state.promptDepth).toBe(2);
    state = reduceCompanionState(state, { type: "prompt_end" });
    expect(state.phase).toBe("waiting");
    state = reduceCompanionState(state, { type: "prompt_end" });
    expect(state.phase).toBe("tool");
    state = reduceCompanionState(state, { type: "tool_end", id: "a", name: "question" });
    state = reduceCompanionState(state, { type: "compact_start" });
    expect(state.phase).toBe("compacting");
    state = reduceCompanionState(state, { type: "compact_end" });
    expect(statusPresentation(state).text).toBe("● compacted");
  });
});

describe("responsive semantic rendering", () => {
  const snapshot = {
    state: initialCompanionState("resumed"),
    cwd: "/Users/demo/dev/a-project-with-a-long-name",
    home: "/Users/demo",
    branch: "feature/theme-neutral-companion",
    sessionName: "visual regression",
    model: { id: "provider/a-very-long-model-name-that-must-truncate" },
    provider: "provider",
    thinking: "high",
    usage: { input: 1200, output: 300, cacheRead: 8500, cacheWrite: 100, cost: 0.125 },
    context: { percent: 72.4, contextWindow: 131_072 },
  };

  it("never exceeds the terminal width at compact and desktop sizes", () => {
    for (const width of [20, 24, 32, 40, 80, 120, 192]) {
      for (const palette of [plainPalette, simulatorAnsiPalette]) {
        const lines = [
          ...renderCompanionHeader(width, palette),
          renderComposerBand(width, snapshot, palette),
          ...renderCompanionFooter(width, snapshot, palette),
        ];
        expect(lines).toHaveLength(2);
        for (const line of lines) {
          expect(displayWidth(line), `${width}: ${stripAnsi(line)}`).toBeLessThanOrEqual(width);
          expect(stripAnsi(line)).not.toMatch(/[\r\n\t]/);
        }
      }
    }
  });

  it.each([
    ["openai-codex", "openai-codex/gpt-6-astra", "gpt-6-astra"],
    ["OpenAI Codex", "gpt-5.6-luna", "gpt-5.6-luna"],
    ["openrouter", "openrouter/z-ai/glm-5.3-flash", "glm5.3-flash"],
    ["zai", "glm-5.3-flash", "glm5.3-flash"],
  ])("shows model only, never provider %s", (provider, id, label) => {
    for (const width of [42, 80, 120, 192]) {
      const rendered = stripAnsi(renderComposerBand(width, {
        ...snapshot, provider, model: { id },
      }, simulatorAnsiPalette));
      expect(rendered).toContain(label);
      expect(rendered).not.toContain(provider);
      expect(rendered).not.toContain("openai-codex/");
      expect(displayWidth(rendered)).toBeLessThanOrEqual(width);
    }
  });

  it("keeps model, lifecycle and live context visible in actual multi-pane widths", () => {
    for (const width of [40, 41, 42, 48, 59, 64]) {
      for (const percent of [0, 6, 50, 72, 95, 100, null]) {
        const rendered = renderComposerBand(width, {
          ...snapshot, model: { id: "openai-codex/gpt-6-astra" },
          state: reduceCompanionState(initialCompanionState(), { type: "settled" }),
          context: { percent, contextWindow: 272000 },
        }, plainPalette);
        expect(rendered).toContain("gpt-6-astra");
        expect(rendered).toContain("✓ complete");
        expect(rendered).toContain(percent === null ? "◫ ?" : `◫ ${percent}%`);
        expect(rendered).not.toContain("high");
        expect(displayWidth(rendered)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("uses only semantic theme functions", () => {
    const calls: string[] = [];
    const token = (name: string) => (text: string) => {
      calls.push(name);
      return text;
    };
    const palette: SemanticPalette = {
      accent: token("accent"), text: token("text"), muted: token("muted"), dim: token("dim"),
      success: token("success"), warning: token("warning"), error: token("error"), bold: token("bold"),
    };
    for (const width of [20, 24, 32, 40, 80, 120, 192]) {
      const output = [
        ...renderCompanionHeader(width, palette),
        renderComposerBand(width, snapshot, palette),
        ...renderCompanionFooter(width, snapshot, palette),
      ].join("\n");
      expect(output).not.toMatch(/#[0-9a-f]{3,8}|\x1b\[/i);
    }
    expect(new Set(calls)).toEqual(new Set(["accent", "text", "dim", "bold", "muted", "warning"]));
  });

  it("applies lifecycle tone only to the status segment", () => {
    const calls: Array<[string, string]> = [];
    const token = (name: string) => (text: string) => {
      calls.push([name, text]);
      return text;
    };
    const palette: SemanticPalette = {
      accent: token("accent"), text: token("text"), muted: token("muted"), dim: token("dim"),
      success: token("success"), warning: token("warning"), error: token("error"), bold: token("bold"),
    };
    const complete = reduceCompanionState(
      reduceCompanionState(initialCompanionState(), { type: "agent_start" }),
      { type: "settled" },
    );

    expect(renderComposerBand(80, {
      ...snapshot,
      state: complete,
      model: { id: "zai/glm-5" },
      provider: "zai",
    }, palette)).toBe(
      "◆ > glm5 · high > ✓ complete ▶─────────────────────────────◀ ◫ 72%/131k · $0.125",
    );
    expect(calls).toEqual([
      ["accent", "◆"],
      ["muted", " > "],
      ["text", "glm5 · high"],
      ["muted", " > "],
      ["success", "✓ complete"],
      ["accent", " ▶"],
      ["bold", "◆ > glm5 · high > ✓ complete ▶"],
      ["warning", "─────────────────────"],
      ["dim", "────────"],
      ["dim", "◀ "],
      ["warning", "◫ 72%/131k"],
      ["dim", " · $0.125"],
    ]);
  });

  it("sanitizes dynamic single-line fields before layout", () => {
    const adversarial = {
      ...snapshot,
      state: reduceCompanionState(initialCompanionState(), {
        type: "message_error",
        message: "bad\nstatus\t\u0001\u001b[31m",
      }),
      cwd: "/tmp/project\nnext",
      branch: "main\ttab",
      sessionName: "name\u0007bell",
      model: { id: "model\rreturn" },
    };
    for (const line of [
      renderComposerBand(80, adversarial, plainPalette),
      ...renderCompanionFooter(80, adversarial, plainPalette),
    ]) {
      expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it("preserves the full brand without spending another terminal row", () => {
    expect(renderCompanionHeader(20, plainPalette)).toEqual(["◆ STEAK PI"]);
  });

  it("keeps a useful compact hierarchy", () => {
    expect(renderCompanionHeader(40, plainPalette)).toEqual([
      "◆ STEAK PI          / · /model · /resume",
    ]);
    expect(renderComposerBand(40, snapshot, plainPalette)).toBe(
      "◆ a-very-long-model… · ● resumed ▶─◫ 72%",
    );
    expect(renderCompanionFooter(40, snapshot, plainPalette)).toEqual([]);
  });
});

describe("usage and width helpers", () => {
  it("aggregates only persisted Pi usage channels", () => {
    const usage = collectUsage([
      { type: "message", message: { role: "assistant", usage: { input: 10, output: 4, cacheRead: 20, cacheWrite: 2, cost: { total: 0.01 } } } },
      { type: "message", message: { role: "toolResult", usage: { input: 1, output: 2, cost: { total: 0.02 } } } },
      { type: "compaction", usage: { input: 3, output: 5, cost: { total: 0.03 } } },
      { type: "message", message: { role: "user", usage: { input: 999 } } },
      { type: "other", usage: { input: 999 } },
    ]);
    expect(usage).toEqual({ input: 14, output: 11, cacheRead: 20, cacheWrite: 2, cost: 0.06 });
  });

  it("matches Pi's width oracle for complex terminal graphemes", () => {
    for (const value of ["🇺🇸", "1️⃣", "👩‍💻", "é", "界", "◆ STEAK PI"]) {
      expect(displayWidth(value)).toBe(visibleWidth(value));
    }
    expect(truncatePlain("alpha🙂beta", 8)).toBe("alpha🙂…");
    expect(truncatePlain("🇺🇸1️⃣👩‍💻界", 7)).toBe("🇺🇸1️⃣👩‍💻…");
  });

  it("lays out both sides using Pi's terminal width", () => {
    const fitted = fitSides("left 🇺🇸 status", "right 1️⃣ model", 20);
    expect(visibleWidth(fitted.left + fitted.gap + fitted.right)).toBe(20);
    expect(fitted.left).toContain("left");
    expect(fitted.right).toContain("right");
  });
});

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
  renderComposerBands,
  type FooterSnapshot,
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
  const snapshot: FooterSnapshot = {
    state: reduceCompanionState(initialCompanionState(), { type: "settled" }),
    cwd: "/Users/demo/dev/a-project-with-a-long-name",
    provider: "openai-codex",
    model: { id: "openai-codex/gpt-6.1-sol" },
    thinking: "high",
    usage: { input: 15_000, output: 23_000, cacheRead: 85_000, cacheWrite: 0, cost: 1.234 },
    context: { percent: 20, contextWindow: 1_000_000 },
    extensionStatuses: [],
  };
  const ansi = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
  const lightPalette: SemanticPalette = {
    accent: ansi(34), text: ansi(30), muted: ansi(90), dim: ansi(90),
    success: ansi(32), warning: ansi(33), error: ansi(31), bold: ansi(1),
  };
  const palettes = [plainPalette, simulatorAnsiPalette, lightPalette];
  const rowsAt = (width: number, value = snapshot, palette = plainPalette) =>
    renderComposerBands(width, value, palette).map(stripAnsi);

  it.each([40, 48, 59, 64, 80, 120])("retains every meaningful metric at %i columns", (width) => {
    for (const palette of palettes) {
      const rows = rowsAt(width, snapshot, palette);
      const output = rows.join("\n");
      expect(rows.length).toBeLessThanOrEqual(2);
      for (const value of ["gpt-6.1-sol", "high", "✓ complete", "20%/1M", "123k tok", "85% cache", "$1.234"]) {
        expect(output, `${width}: ${output}`).toContain(value);
      }
      expect(output).not.toContain("openai-codex");
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      expect(rows.length).toBe(width < 80 ? 2 : 1);
    }
  });

  it("keeps metadata ahead of a restrained, genuinely residual meter", () => {
    expect(rowsAt(40)).toEqual([
      "◆ gpt-6.1-sol · high · ✓ complete",
      "◫ 20%/1M · 123k tok · 85% cache · $1.234",
    ]);
    expect(rowsAt(59)).toEqual([
      "◆ gpt-6.1-sol · high · ✓ complete",
      "◫ 20%/1M · 123k tok · 85% cache · $1.234",
    ]);
    for (const width of [80, 120, 192]) {
      const output = rowsAt(width).join("\n");
      expect(output.match(/[━─]/g)?.length ?? 0).toBeLessThanOrEqual(12);
      expect(output).toContain("$1.234");
      expect(output).not.toContain("…");
    }
  });

  it("switches row count at the exact identity/metadata boundary", () => {
    const identity = rowsAt(59)[0]!;
    const metadata = rowsAt(59)[1]!;
    const boundary = visibleWidth(identity) + visibleWidth(metadata) + 1;
    expect(rowsAt(boundary - 1)).toHaveLength(2);
    expect(rowsAt(boundary)).toHaveLength(1);
    expect(rowsAt(boundary + 1)).toHaveLength(1);
  });

  it.each([
    ["openai-codex", "openai-codex/gpt-6-astra", "gpt-6-astra"],
    ["OpenAI Codex", "gpt-5.6-luna", "gpt-5.6-luna"],
    ["openrouter", "openrouter/z-ai/glm-5.3-flash", "glm5.3-flash"],
    ["zai", "glm-5.3-flash", "glm5.3-flash"],
  ])("shows model only, never provider %s", (provider, id, label) => {
    for (const width of [40, 48, 59, 80, 120, 192]) {
      const output = rowsAt(width, { ...snapshot, provider, model: { id } }).join("\n");
      expect(output).toContain(label);
      expect(output).not.toContain(provider);
    }
  });

  it("preserves unknown and zero readings without inventing cache hits", () => {
    for (const width of [40, 48, 59, 64, 80, 120]) {
      for (const percent of [0, 6, 50, 72, 95, 100, null]) {
        const output = rowsAt(width, {
          ...snapshot, context: { percent, contextWindow: 1_000_000 },
        }).join("\n");
        expect(output).toContain(`${percent === null ? "?" : `${percent}%`}/1M`);
        expect(output).toContain("high");
      }
      const zero = rowsAt(width, {
        ...snapshot,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        context: { percent: 0, contextWindow: 0 },
        thinking: "off",
      }).join("\n");
      expect(zero).toContain("0%/0");
      expect(zero).toContain("0 tok");
      expect(zero).toContain("$0.000");
      expect(zero).not.toMatch(/cache|off/);
    }
    const unknown = rowsAt(120, { ...snapshot, context: undefined }).join("\n");
    expect(unknown).toContain("◫ —");
    expect(unknown).not.toContain("━");
    expect(rowsAt(120, { ...snapshot, context: { percent: 0, contextWindow: 1e6 } }).join("")).not.toContain("━");
    expect(rowsAt(120, { ...snapshot, context: { percent: 100, contextWindow: 1e6 } }).join("")).not.toContain("─");
    const writesOnly = rowsAt(59, {
      ...snapshot, usage: { input: 0, output: 5, cacheRead: 0, cacheWrite: 100, cost: 0 },
    }).join("\n");
    expect(writesOnly).toContain("0% cache");
  });

  it("uses semantic pressure and lifecycle tones independently", () => {
    for (const [percent, contextTone] of [[20, "accent"], [72, "warning"], [95, "error"]] as const) {
      const calls: Array<[string, string]> = [];
      const token = (name: string) => (text: string) => { calls.push([name, text]); return text; };
      const palette: SemanticPalette = {
        accent: token("accent"), text: token("text"), muted: token("muted"), dim: token("dim"),
        success: token("success"), warning: token("warning"), error: token("error"), bold: token("bold"),
      };
      for (const width of [40, 59, 80, 120, 192]) {
        calls.length = 0;
        const output = renderComposerBands(width, {
          ...snapshot, context: { percent, contextWindow: 1e6 },
        }, palette).join("\n");
        expect(output).not.toMatch(/#[0-9a-f]{3,8}|\x1b\[/i);
        expect(calls.filter(([tone]) => tone === "success")).toEqual([["success", "✓ complete"]]);
        expect(calls).toContainEqual([contextTone, expect.stringMatching(/^◫ ?\d+%\/1M$/)]);
        expect(calls).toContainEqual(["muted", "$1.234"]);
        expect(calls).toContainEqual(["muted", "123k tok"]);
        expect(calls).toContainEqual(["muted", "85% cache"]);
        expect(calls).toContainEqual(["text", "gpt-6.1-sol"]);
      }
    }
    for (const [phase, tone, label] of [
      ["thinking", "accent", "◆ thinking"], ["responding", "accent", "◆ responding"],
      ["tool", "accent", "◆ tool running"], ["waiting", "warning", "◇ waiting"],
      ["compacting", "warning", "◆ compacting"], ["error", "error", "! error"],
      ["stopped", "warning", "! stopped"], ["ready", "dim", "● ready"],
    ] as const) {
      const seen: string[] = [];
      const palette = { ...plainPalette, [tone]: (text: string) => { seen.push(text); return text; } };
      rowsAt(40, { ...snapshot, state: { ...initialCompanionState(), phase } }, palette);
      expect(seen).toContain(label);
    }
  });

  it("never clips a numeric or currency atom at genuinely tiny sizes", () => {
    for (const width of [1, 2, 5, 8, 12, 20, 24, 32]) {
      const rows = rowsAt(width);
      expect(rows.length).toBeLessThanOrEqual(3);
      for (const row of rows.slice(1)) {
        expect(row).not.toContain("…");
        expect(row).not.toMatch(/\$(?!1\.234(?: |$))/);
        for (const atom of row.split(" ")) expect(["◫20%/1M", "123kt", "c85%", "$1.234", "◫20%/1M", "123k", "tok", "85%", "cache"]).toContain(atom);
      }
    }
    for (const width of [20, 24, 32]) {
      const output = rowsAt(width).join("\n");
      for (const value of ["20%/1M", "123k", "85%", "$1.234"]) expect(output).toContain(value);
    }
  });

  it("fits every integer width and theme with long graphemes, statuses and huge counters", () => {
    const variants: FooterSnapshot[] = [snapshot, {
      ...snapshot,
      model: { id: `provider/${"👩‍💻🇺🇸1️⃣界é".repeat(10)}` },
      thinking: "extraordinarily-long-reasoning-mode",
      state: reduceCompanionState(initialCompanionState(), { type: "message_error", message: "long 👩‍💻 detail ".repeat(30) }),
    }, {
      ...snapshot,
      usage: { input: Number.MAX_VALUE, output: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE, cacheWrite: Number.MAX_VALUE, cost: Number.MAX_VALUE },
      context: { percent: 100, contextWindow: Number.MAX_VALUE },
    }, {
      ...snapshot,
      usage: { input: Number.MAX_VALUE, output: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE, cacheWrite: 0, cost: 1.23e-100 },
      context: { percent: 100, contextWindow: Number.MAX_VALUE },
    }, {
      ...snapshot, model: { id: "model\rreturn" }, thinking: "high\t\u0007bell",
      state: reduceCompanionState(initialCompanionState(), { type: "message_error", message: "bad\nstatus\t\u0001\u001b[31m" }),
      context: { percent: Number.NaN, contextWindow: 0 },
    }];
    for (let width = 1; width <= 192; width++) {
      for (const variant of variants) {
        const expected = rowsAt(width, variant);
        for (const palette of palettes) {
          const rows = rowsAt(width, variant, palette);
          expect(rows).toEqual(expected);
          expect(rows.length).toBeGreaterThanOrEqual(1);
          expect(rows.length).toBeLessThanOrEqual(width >= 40 ? 2 : 3);
          for (const row of rows) {
            expect(visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width);
            expect(row).not.toMatch(/[\x00-\x1f\x7f]|Infinity|NaN/);
            expect(row).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
          }
        }
        if (width >= 40 && variant.usage.input === Number.MAX_VALUE) {
          const output = expected.join("\n");
          expect(output).toContain("100%/1.8e308");
          expect(output).toMatch(/e308t|e308 tok/);
          expect(output).toMatch(/(?:33|50)% cache|c(?:33|50)%/);
          expect(output).toContain("$");
          expect(expected.slice(1).join("")).not.toContain("…");
        }
      }
    }
  });

  it("preserves the header and does not invent footer filler", () => {
    expect(renderCompanionHeader(20, plainPalette)).toEqual(["🥩  STEAK PI"]);
    expect(renderCompanionHeader(40, plainPalette)).toEqual(["🥩  STEAK PI        / · /model · /resume"]);
    for (const width of [1, 2, 3, 4, 5, 8, 12, 20, 40, 64, 120]) {
      const header = renderCompanionHeader(width, plainPalette)[0]!;
      expect(visibleWidth(header)).toBeLessThanOrEqual(width);
      if (width >= 12) expect(header).toMatch(/^🥩 {2}STEAK PI/);
    }
    expect(renderCompanionFooter(40, snapshot, plainPalette)).toEqual([]);
    for (const width of [20, 40, 80, 120]) {
      const rows = renderCompanionFooter(width, { extensionStatuses: ["external status"] }, simulatorAnsiPalette);
      expect(rows).toHaveLength(1);
      expect(visibleWidth(rows[0]!)).toBeLessThanOrEqual(width);
    }
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

import { describe, expect, it } from "vitest";
import { contextPressure } from "../src/tui/context-pressure.ts";

describe("context pressure", () => {
  it("uses the configured model threshold and clears at the boundary", () => {
    const settings = { compaction: { modelOverrides: { "example/model": { reserveTokens: 700000 } } } };
    const model = { provider: "example", id: "model" };
    expect(contextPressure(300000, 1000000, model, settings)).toBe(false);
    expect(contextPressure(300001, 1000000, model, settings)).toBe(true);
    expect(contextPressure(100000, 1000000, model, settings)).toBe(false);
  });
  it("uses a display-only 40% cue for large windows without an override", () => {
    expect(contextPressure(400000, 1000000, undefined, {})).toBe(false);
    expect(contextPressure(400001, 1000000, undefined, {})).toBe(true);
    expect(contextPressure(300000, 499999, undefined, {})).toBe(false);
  });
});

import { initialCompanionState } from "../src/tui/model.ts";
import { displayWidth } from "../src/tui/format.ts";
import { emptyUsage, plainPalette, renderComposerBands } from "../src/tui/render.ts";

it("keeps the pressure cue within the existing width limit", () => {
  const snapshot = { state: initialCompanionState(), cwd: "/work", usage: emptyUsage(),
    context: { percent: 41, contextWindow: 1000000, tokens: 410000, pressure: true } };
  expect(renderComposerBands(120, snapshot, plainPalette).join(" ")).toContain("ctx 410k");
  for (let width = 1; width <= 120; width++) {
    for (const line of renderComposerBands(width, snapshot, plainPalette)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  }
});

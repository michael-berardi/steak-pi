import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../src/tui/format.ts";
import { initialCompanionState } from "../src/tui/model.ts";
import {
  collectUsage,
  plainPalette,
  renderComposerBands,
  type FooterSnapshot,
} from "../src/tui/render.ts";
import { setRoutingConfigOverride } from "../src/routing-config.ts";
import { isFlatPlanRoute } from "../src/subscription-first-routing.ts";

const WIDTHS = [40, 60, 80, 120, 200];

function snapshot(overrides: Partial<FooterSnapshot> = {}): FooterSnapshot {
  return {
    state: { ...initialCompanionState(), phase: "thinking" },
    cwd: "/work",
    model: { id: "qwen-sample-model", name: "qwen-sample-model" },
    thinking: "high",
    usage: { input: 200_000, output: 50_000, cacheRead: 1_000_000, cacheWrite: 10_000, cost: 0, requests: 12 },
    context: { percent: 10, contextWindow: 1_000_000 },
    ...overrides,
  };
}

const rowsAt = (width: number, value: FooterSnapshot) =>
  renderComposerBands(width, value, plainPalette).map(stripAnsi);

describe("footer layout never overflows the pane", () => {
  it.each(WIDTHS)("keeps every row within %i columns and leaves the last column blank", (width) => {
    for (const planRoute of [false, true]) {
      for (const cost of [0, 1.234]) {
        const rows = rowsAt(width, snapshot({ planRoute, usage: { ...snapshot().usage, cost } }));
        expect(rows.length).toBeGreaterThanOrEqual(1);
        for (const row of rows) {
          expect(visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width - 1);
        }
      }
    }
  });

  it.each(WIDTHS)("always keeps the cost atom at %i columns", (width) => {
    const metered = rowsAt(width, snapshot({ usage: { ...snapshot().usage, cost: 1.234 } })).join("\n");
    expect(metered).toContain("$1.234");
    const plan = rowsAt(width, snapshot({ planRoute: true })).join("\n");
    expect(plan).toMatch(/plan/);
  });

  it("uses the full line on wide panes and the one-row stats line on narrow ones", () => {
    expect(rowsAt(200, snapshot())).toHaveLength(1);
    expect(rowsAt(40, snapshot())).toHaveLength(2);
  });

  it("never lets a tiny pane exceed its width", () => {
    for (let width = 1; width <= 40; width += 1) {
      for (const row of rowsAt(width, snapshot({ planRoute: true }))) {
        expect(visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("flat-plan routes show plan usage instead of $0.000", () => {
  it("labels a plan route with its session request count and no dollar figure", () => {
    for (const width of WIDTHS) {
      const output = rowsAt(width, snapshot({ planRoute: true })).join("\n");
      expect(output, `${width}`).toContain("plan");
      expect(output, `${width}`).toMatch(/plan (?:· )?12 req|plan 12r/);
      expect(output, `${width}`).not.toContain("$");
    }
  });

  it("keeps the dollar figure for metered routes, including a zero-cost metered route", () => {
    const output = rowsAt(120, snapshot({ planRoute: false })).join("\n");
    expect(output).toContain("$0.000");
    expect(output).not.toContain("plan");
  });

  it("counts assistant requests from persisted entries only", () => {
    const usage = collectUsage([
      { type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0 } } } },
      { type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cost: { total: 0 } } } },
      { type: "message", message: { role: "toolResult", usage: { input: 1 } } },
      { type: "message", message: { role: "user" } },
    ]);
    expect(usage.requests).toBe(2);
  });
});

describe("plan classification reuses subscriptionRouteChecks", () => {
  afterEach(() => setRoutingConfigOverride(undefined));

  it("marks a configured non-OAuth subscription endpoint as a plan route", () => {
    setRoutingConfigOverride({
      subscriptionRouteChecks: [{ provider: "provider-a", host: "plan.example.test" }],
    });
    expect(isFlatPlanRoute({ provider: "provider-a", baseUrl: "https://plan.example.test/v1" })).toBe(true);
  });

  it("keeps metered, OAuth-only, and unknown endpoints on the dollar label", () => {
    setRoutingConfigOverride({
      subscriptionRouteChecks: [
        { provider: "provider-a", host: "plan.example.test" },
        { provider: "provider-b", host: "oauth.example.test", oauth: true },
      ],
    });
    expect(isFlatPlanRoute({ provider: "provider-a", baseUrl: "https://metered.example.test/v1" })).toBe(false);
    expect(isFlatPlanRoute({ provider: "provider-b", baseUrl: "https://oauth.example.test/v1" })).toBe(false);
    expect(isFlatPlanRoute({ provider: "provider-a", baseUrl: "http://plan.example.test/v1" })).toBe(false);
  });

  it("treats an unconfigured route as metered", () => {
    setRoutingConfigOverride({});
    expect(isFlatPlanRoute({ provider: "provider-a", baseUrl: "https://plan.example.test/v1" })).toBe(false);
  });
});

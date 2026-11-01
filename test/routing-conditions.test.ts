import { describe, expect, it } from "vitest";
import { parseRoutingConfig } from "../src/routing-config.ts";

const condition = { provider: "claude", everyAccount: { remainingBelow: 20, behindPaceAbove: 15 } };

describe("routeConditions", () => {
  it("attaches onlyWhen to a plain string chain step by its route key", () => {
    const config = parseRoutingConfig({
      textWorkerChain: ["plan-a/model-1", "metered/model-2"],
      routeConditions: { "metered/model-2": condition },
    });
    expect(config.textWorkerChain).toEqual([
      { provider: "plan-a", id: "model-1" },
      { provider: "metered", id: "model-2", onlyWhen: condition },
    ]);
  });

  it("keeps an inline onlyWhen over a routeConditions entry", () => {
    const inline = { provider: "other", everyAccount: { remainingBelow: 5, behindPaceAbove: 1 } };
    const config = parseRoutingConfig({
      textWorkerChain: [{ provider: "metered", id: "model-2", onlyWhen: inline }],
      routeConditions: { "metered/model-2": condition },
    });
    expect(config.textWorkerChain?.[0]).toEqual({ provider: "metered", id: "model-2", onlyWhen: inline });
  });

  it("applies to the multimodal chain too and ignores routes not in any chain", () => {
    const config = parseRoutingConfig({
      multimodalWorkerChain: ["metered/model-2"],
      routeConditions: { "metered/model-2": condition, "unused/model": condition },
    });
    expect(config.multimodalWorkerChain).toEqual([{ provider: "metered", id: "model-2", onlyWhen: condition }]);
  });

  it("refuses a malformed condition with its key named", () => {
    expect(() => parseRoutingConfig({ textWorkerChain: ["a/b"], routeConditions: { "a/b": { provider: "claude" } } }))
      .toThrow(/routeConditions\.a\/b\.everyAccount/);
    expect(() => parseRoutingConfig({ routeConditions: [] })).toThrow(/routeConditions/);
  });
});

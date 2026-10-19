import { describe, expect, it } from "vitest";
import { isSubscriptionOrLocalRoute } from "../src/subscription-first-routing.ts";

describe("Claude Code subscription boundary", () => {
  it("accepts only the built-in process route, with or without OAuth", () => {
    expect(isSubscriptionOrLocalRoute({ provider: "claude-code", baseUrl: "process://claude-code" }, false)).toBe(true);
    expect(isSubscriptionOrLocalRoute({ provider: "claude-code", baseUrl: "process://claude-code" }, true)).toBe(true);
  });
  it.each([
    "https://api.anthropic.com",
    "process://claude-code/extra",
    "process://other",
    "process://user@claude-code",
    "https://claude-code",
  ])("does not authorize claude-code on %s", baseUrl => {
    expect(isSubscriptionOrLocalRoute({ provider: "claude-code", baseUrl }, false)).toBe(false);
  });
  it("does not exempt another provider using the same process URL", () => {
    expect(isSubscriptionOrLocalRoute({ provider: "inco", baseUrl: "process://claude-code" }, false)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { isSubscriptionOrLocalRoute } from "../src/subscription-first-routing.ts";

describe("Xiaomi Token Plan billing boundary", () => {
  it.each(["/v1", "/v1/", "/anthropic", "/anthropic/"])("accepts the dedicated prepaid endpoint %s without OAuth or paid approval", path => {
    expect(isSubscriptionOrLocalRoute({ provider: "xiaomi", baseUrl: `https://token-plan-sgp.xiaomimimo.com${path}` }, false)).toBe(true);
  });
  it.each([
    "https://api.xiaomimimo.com/v1",
    "https://token-plan-sgp.xiaomimimo.com.evil.test/v1",
    "https://evil.test/token-plan-sgp.xiaomimimo.com/v1",
    "http://token-plan-sgp.xiaomimimo.com/v1",
    "https://token-plan-sgp.xiaomimimo.com:444/v1",
    "https://user@token-plan-sgp.xiaomimimo.com/v1",
    "https://token-plan-sgp.xiaomimimo.com/v1?route=payg",
    "https://token-plan-sgp.xiaomimimo.com/v1#payg",
    "https://token-plan-sgp.xiaomimimo.com/payg/v1",
    "https://token-plan-sgp.xiaomimimo.com/v1/payg",
  ])("does not authorize a metered or ambiguous route: %s", baseUrl => {
    expect(isSubscriptionOrLocalRoute({ provider: "xiaomi", baseUrl }, false)).toBe(false);
  });
  it("does not exempt another provider using the same host", () => {
    expect(isSubscriptionOrLocalRoute({ provider: "inco", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" }, false)).toBe(false);
  });
});

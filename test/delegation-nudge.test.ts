import { describe, expect, it } from "vitest";
import { DELEGATION_NUDGE_AFTER, DELEGATION_NUDGE_TEXT, delegationNudgeDisabled } from "../extensions/ultraterm-subagents.ts";

describe("delegation nudge (2026-11-04: parents did long serial work that subagents could have run in parallel)", () => {
  it("is on by default and the operator can switch it off", () => {
    expect(delegationNudgeDisabled({})).toBe(false);
    for (const off of ["off", "0", "false", "no"]) expect(delegationNudgeDisabled({ STEAK_PI_DELEGATION_NUDGE: off })).toBe(true);
  });

  it("names the tool, asks for one background wave, and lets a tightly coupled change continue", () => {
    expect(DELEGATION_NUDGE_AFTER).toBeGreaterThanOrEqual(20);
    expect(DELEGATION_NUDGE_TEXT).toMatch(/ultraterm_subagents/);
    expect(DELEGATION_NUDGE_TEXT).toMatch(/one\s+background wave/);
    expect(DELEGATION_NUDGE_TEXT).toMatch(/tightly coupled change, continue/);
  });
});

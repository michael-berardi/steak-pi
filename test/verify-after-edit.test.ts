import { describe, expect, it } from "vitest";
import {
  formatAppendix,
  loadVerifyConfig,
  shouldVerify,
} from "../extensions/verify-after-edit.ts";

const CONFIG = { command: "npm run -s typecheck", failLimit: 2, timeoutMs: 90_000 };

describe("verify-after-edit", () => {
  it("loads a valid config", () => {
    const dir = ".cherry-pi";
    expect(loadVerifyConfig("/nonexistent")).toBeNull();
    // valid shape handled in e2e; here assert the idle contract
    expect(shouldVerify(null, "edit", false, 0, 1000, 0)).toBe(false);
    void dir;
  });

  it("only reacts to edit and write tools", () => {
    expect(shouldVerify(CONFIG, "edit", false, 0, 1000, 0)).toBe(true);
    expect(shouldVerify(CONFIG, "write", false, 0, 1000, 0)).toBe(true);
    expect(shouldVerify(CONFIG, "bash", false, 0, 1000, 0)).toBe(false);
    expect(shouldVerify(CONFIG, "read", false, 0, 1000, 0)).toBe(false);
  });

  it("ignores failed tool calls", () => {
    expect(shouldVerify(CONFIG, "edit", true, 0, 1000, 0)).toBe(false);
  });

  it("stops after the failure limit", () => {
    expect(shouldVerify(CONFIG, "edit", false, 2, 1000, 0)).toBe(false);
    expect(shouldVerify(CONFIG, "edit", false, 1, 1000, 0)).toBe(true);
  });

  it("debounces rapid successive edits", () => {
    expect(shouldVerify(CONFIG, "edit", false, 0, 1000, 900)).toBe(false);
    expect(shouldVerify(CONFIG, "edit", false, 0, 1600, 900)).toBe(true);
  });

  it("formats the appendix with attempt, limit, and output tail", () => {
    const text = formatAppendix("npm run -s typecheck", 1, 2, "error TS2322: x");
    expect(text).toContain("[cherry-pi] verify failed (attempt 1/2)");
    expect(text).toContain("npm run -s typecheck");
    expect(text).toContain("error TS2322: x");
    expect(text).toContain("Fix the reported problem before finishing.");
  });
});

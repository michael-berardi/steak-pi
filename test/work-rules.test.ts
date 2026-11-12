import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workRules, { WORK_RULES, workRulesText } from "../extensions/work-rules.ts";

type Handler = (event: any, ctx: any) => any;

describe("work rules", () => {
  const saved = { off: process.env.STEAK_PI_WORK_RULES, text: process.env.STEAK_PI_WORK_RULES_TEXT };
  afterEach(() => {
    for (const [key, value] of [["STEAK_PI_WORK_RULES", saved.off], ["STEAK_PI_WORK_RULES_TEXT", saved.text]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const hook = (): Handler => {
    const handlers = new Map<string, Handler>();
    workRules({ on: (e: string, h: Handler) => void handlers.set(e, h) } as unknown as ExtensionAPI);
    return handlers.get("before_agent_start")!;
  };

  it("appends the rules once", () => {
    delete process.env.STEAK_PI_WORK_RULES; delete process.env.STEAK_PI_WORK_RULES_TEXT;
    const h = hook();
    const first = h({ systemPrompt: "base" }, {});
    expect(first.systemPrompt).toBe(`base\n\n${WORK_RULES}`);
    expect(h({ systemPrompt: first.systemPrompt }, {})).toBeUndefined();
  });
  it("can be switched off", () => {
    for (const value of ["off", "0", "false", "NO"]) {
      process.env.STEAK_PI_WORK_RULES = value;
      expect(hook()({ systemPrompt: "base" }, {})).toBeUndefined();
    }
  });
  it("takes replacement text from the environment", () => {
    delete process.env.STEAK_PI_WORK_RULES;
    process.env.STEAK_PI_WORK_RULES_TEXT = "  Only one rule.  ";
    expect(workRulesText()).toBe("Only one rule.");
    expect(hook()({ systemPrompt: "base" }, {}).systemPrompt).toBe("base\n\nOnly one rule.");
  });
  it("stays short and names no model, provider or person", () => {
    expect(WORK_RULES.length).toBeLessThan(1200);
    expect(WORK_RULES).not.toMatch(/deepseek|gpt-\d|claude|opus|sonnet|haiku|qwen|openrouter/i);
  });
});

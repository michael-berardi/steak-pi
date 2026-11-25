// Operator-owned per-model default effort for the Claude Code harness. Steak Pi ships only the
// validation and the fallback `medium`; every model-to-effort choice comes from routing.json.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseRoutingConfig, RoutingConfigError, setRoutingConfigOverride } from "../src/routing-config.ts";
import { CLAUDE_CODE_EFFORTS, resolveClaudeCodeEffort, resolveClaudeCodeEffortDetail } from "../src/subagents/claude-code-models.ts";

const MODEL_A = "claude-opus-5-5";
const MODEL_B = "claude-sonnet-5-5";
const REASON = "Cross-module reasoning is required here";
const config = (effort: unknown) => ({ claudeCodeDefaults: { worker: `claude-code/${MODEL_B}`, reviewer: `claude-code/${MODEL_A}`, effort } });

afterEach(() => setRoutingConfigOverride(undefined));

describe("claudeCodeDefaults.effort validation", () => {
  it("accepts a good exact-model map and keeps the existing worker/reviewer validation", () => {
    const parsed = parseRoutingConfig(config({ [MODEL_A]: "xhigh", [MODEL_B]: "high" }));
    expect(parsed.claudeCodeDefaults?.effort).toEqual({ [MODEL_A]: "xhigh", [MODEL_B]: "high" });
    expect(parsed.claudeCodeDefaults?.worker).toBe(`claude-code/${MODEL_B}`);
    expect(parsed.claudeCodeDefaults?.reviewer).toBe(`claude-code/${MODEL_A}`);
    expect(parseRoutingConfig({ claudeCodeDefaults: {} }).claudeCodeDefaults?.effort).toBeUndefined();
    expect(() => parseRoutingConfig({ claudeCodeDefaults: { worker: 12 } })).toThrow(/claudeCodeDefaults\.worker/);
    expect(() => parseRoutingConfig({ claudeCodeDefaults: "wrong" })).toThrow(/claudeCodeDefaults/);
  });

  it("names the model key and the allowed values when an effort is unknown", () => {
    expect(() => parseRoutingConfig(config({ [MODEL_A]: "extreme" }))).toThrow(RoutingConfigError);
    expect(() => parseRoutingConfig(config({ [MODEL_A]: "extreme" }))).toThrow(
      new RegExp(`claudeCodeDefaults\\.effort\\.${MODEL_A}.*${CLAUDE_CODE_EFFORTS.join(", ")}`),
    );
    expect(() => parseRoutingConfig(config({ [MODEL_B]: 3 }))).toThrow(/claudeCodeDefaults\.effort\./);
  });

  it("refuses a non-object effort map by name", () => {
    expect(() => parseRoutingConfig(config(["xhigh"]))).toThrow(/claudeCodeDefaults\.effort.*expected/);
    expect(() => parseRoutingConfig(config("xhigh"))).toThrow(/claudeCodeDefaults\.effort.*expected/);
  });
});

describe("effective Claude Code effort", () => {
  it("uses the configured value for the exact resolved model, else medium", () => {
    setRoutingConfigOverride(config({ [MODEL_A]: "xhigh", [MODEL_B]: "high" }));
    expect(resolveClaudeCodeEffortDetail(undefined, undefined, MODEL_A)).toEqual({ effort: "xhigh", source: "claudeCodeDefaults.effort" });
    expect(resolveClaudeCodeEffortDetail(undefined, undefined, MODEL_B)).toEqual({ effort: "high", source: "claudeCodeDefaults.effort" });
    expect(resolveClaudeCodeEffortDetail(undefined, undefined, "claude-unlisted-model")).toEqual({ effort: "medium", source: "default" });
    expect(resolveClaudeCodeEffortDetail(undefined, undefined)).toEqual({ effort: "medium", source: "default" });
    expect(resolveClaudeCodeEffort(undefined, undefined, MODEL_A)).toBe("xhigh");
  });

  it("needs no thinkingReason for a configured default, even high or xhigh", () => {
    setRoutingConfigOverride(config({ [MODEL_A]: "xhigh", [MODEL_B]: "high" }));
    expect(() => resolveClaudeCodeEffortDetail(undefined, undefined, MODEL_A)).not.toThrow();
    expect(() => resolveClaudeCodeEffortDetail(undefined, undefined, MODEL_B)).not.toThrow();
  });

  it("lets an explicit thinking override the configured default and keeps its reason rule", () => {
    setRoutingConfigOverride(config({ [MODEL_A]: "xhigh", [MODEL_B]: "high" }));
    expect(resolveClaudeCodeEffortDetail("medium", undefined, MODEL_A)).toEqual({ effort: "medium", source: "thinking" });
    expect(resolveClaudeCodeEffortDetail("high", REASON, MODEL_A)).toEqual({ effort: "high", source: "thinking" });
    expect(() => resolveClaudeCodeEffortDetail("xhigh", undefined, MODEL_A)).toThrow(/needs a concrete task benefit in thinkingReason/);
    expect(() => resolveClaudeCodeEffortDetail("low", REASON, MODEL_A)).toThrow(/effort must be medium, high, xhigh/);
  });
});

describe("provider neutrality of default effort", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
  const shippedCode = [join(root, "src"), join(root, "extensions")].flatMap(sourceFiles);
  // A concrete model id on the left and an effort literal on the right would be a shipped default.
  const MODEL_TO_EFFORT = /["'`]?claude-[a-z][\w-]*-\d+(?:-\d+)+["'`]?\s*:\s*["'`](?:medium|high|xhigh)["'`]/i;

  it("ships no model id in a default effort table", () => {
    expect(shippedCode.length).toBeGreaterThan(50);
    expect(existsSync(join(root, "src/subagents/claude-code-models.ts"))).toBe(true);
    expect(MODEL_TO_EFFORT.test('{ "claude-opus-5-5": "xhigh" }')).toBe(true);
    expect(MODEL_TO_EFFORT.test('CLAUDE_CODE_EFFORTS = ["medium", "high", "xhigh"]')).toBe(false);
    const hits = shippedCode.filter((path) => MODEL_TO_EFFORT.test(readFileSync(path, "utf8"))).map((path) => relative(root, path));
    expect(hits).toEqual([]);
  });
});

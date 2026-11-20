import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import modelGuidance from "../extensions/model-guidance.ts";
import { applyModelGuidance, GUIDANCE_SECTION, MAX_GUIDANCE_RULES, modelGuidanceSettings, modelGuidanceText, parseModelGuidance, withModelGuidance } from "../src/model-guidance.ts";

type Handler = (event: any, ctx: any) => any;
const dirs: string[] = [];
const saved = { dir: process.env.PI_CODING_AGENT_DIR, env: process.env.STEAK_PI_MODEL_GUIDANCE };
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.dir;
  if (saved.env === undefined) delete process.env.STEAK_PI_MODEL_GUIDANCE; else process.env.STEAK_PI_MODEL_GUIDANCE = saved.env;
});
function agentDir(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "steak-guidance-"));
  dirs.push(dir);
  writeFileSync(join(dir, "steak-pi.json"), typeof content === "string" ? content : JSON.stringify(content));
  return dir;
}
const RULES = [{ match: "^example/fast-", text: "Return the named JSON shape." }, { match: "flash", text: "Second line." }];

describe("model guidance", () => {
  it("ships no rule: an absent file or key adds nothing", () => {
    expect(modelGuidanceSettings(join(tmpdir(), "no-such-steak-pi.json"))).toEqual({ rules: [], errors: [] });
    expect(parseModelGuidance(undefined)).toEqual({ rules: [], errors: [] });
  });
  it("matches provider/id case-insensitively and joins every matching rule in order", () => {
    const { rules, errors } = parseModelGuidance(RULES);
    expect(errors).toEqual([]);
    expect(modelGuidanceText({ provider: "example", id: "fast-flash-1" }, rules)).toBe("Return the named JSON shape.\nSecond line.");
    expect(modelGuidanceText({ provider: "EXAMPLE", id: "fast-1" }, rules)).toBe("Return the named JSON shape.");
    expect(modelGuidanceText({ provider: "other", id: "slow" }, rules)).toBe("");
    expect(modelGuidanceText(undefined, rules)).toBe("");
  });
  it("appends once and leaves non-matching prompts untouched", () => {
    const { rules } = parseModelGuidance(RULES);
    const once = withModelGuidance("base", { provider: "example", id: "fast-1" }, rules);
    expect(once).toBe("base\n\nReturn the named JSON shape.");
    expect(withModelGuidance(once, { provider: "example", id: "fast-1" }, rules)).toBe(once);
    expect(withModelGuidance("base", { provider: "other", id: "x" }, rules)).toBe("base");
  });
  it("names every malformed rule and keeps the good ones", () => {
    const { rules, errors } = parseModelGuidance([{ match: "(", text: "x" }, { match: "", text: "x" }, { match: "a", text: "" }, 7, { match: "a", text: "x".repeat(601) }, RULES[0]]);
    expect(rules).toHaveLength(1);
    expect(errors).toHaveLength(5);
    expect(errors[0]).toMatch(/modelGuidance\[0\]\.match is not a valid pattern/);
    expect(parseModelGuidance({}).errors[0]).toMatch(/must be a list/);
    expect(parseModelGuidance(Array.from({ length: MAX_GUIDANCE_RULES + 2 }, () => RULES[0])).rules).toHaveLength(MAX_GUIDANCE_RULES);
  });
  it("reports a malformed file instead of failing", () => {
    const dir = agentDir("{ not json");
    expect(modelGuidanceSettings(join(dir, "steak-pi.json")).errors[0]).toMatch(/is not valid JSON/);
  });
  it("can be switched off from the environment", () => {
    const dir = agentDir({ modelGuidance: RULES });
    expect(modelGuidanceSettings(join(dir, "steak-pi.json"), { STEAK_PI_MODEL_GUIDANCE: "off" }).rules).toEqual([]);
    expect(modelGuidanceSettings(join(dir, "steak-pi.json"), {}).rules).toHaveLength(2);
  });
  it("the extension adds a named section for the active model and keeps other sections", () => {
    process.env.PI_CODING_AGENT_DIR = agentDir({ modelGuidance: RULES });
    delete process.env.STEAK_PI_MODEL_GUIDANCE;
    const handlers = new Map<string, Handler>();
    modelGuidance({ on: (e: string, h: Handler) => void handlers.set(e, h) } as unknown as ExtensionAPI);
    const start = handlers.get("before_agent_start")!;
    const ev = { systemPrompt: "base", systemPromptOptions: { sections: { other: "kept" } as Record<string, string> } };
    expect(start(ev, { model: { provider: "example", id: "fast-1" } })).toBeUndefined();
    expect(ev.systemPromptOptions.sections).toEqual({ other: "kept", [GUIDANCE_SECTION]: "Return the named JSON shape." });
    const none = { systemPrompt: "base", systemPromptOptions: { sections: {} as Record<string, string> } };
    expect(start(none, { model: { provider: "other", id: "slow" } })).toBeUndefined();
    expect(none.systemPromptOptions.sections).toEqual({});
  });
  it("appends once to a prompt an earlier handler forced", () => {
    const ev = { systemPrompt: "forced", systemPromptOptions: { forceSystemPrompt: "forced", sections: {} } };
    expect(applyModelGuidance(ev, "Line.")).toEqual({ systemPrompt: "forced\n\nLine." });
    expect(applyModelGuidance({ ...ev, systemPrompt: "forced\n\nLine." }, "Line.")).toBeUndefined();
  });
});

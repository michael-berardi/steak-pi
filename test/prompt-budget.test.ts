// A fixed prompt that does not eat a small route's window, and the size-only replay of the recorded session that
// motivated it. Every input here is a size or a count: the fixture holds no prompt text and no transcript content.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  budgetApplies, CHARS_PER_TOKEN, DEFAULT_PROMPT_BUDGET, describePromptBudget, fixedPromptBudgetTokens, planFixedPrompt,
  PromptBudgetError, readPromptBudgetConfig, renderSkillNames, resolvePromptBudgetConfig, sectionBody, shrinkMemory,
} from "../src/prompt-budget.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/session-fixed-prompt.json", import.meta.url), "utf8")) as {
  window: number;
  fixedPromptSections: Record<string, number>;
  turns: Record<string, number>;
  keptMessageCharacters: number;
  session: Record<string, number | string>;
};
const sectionNames = Object.keys(fixture.fixedPromptSections);

const filler = (length: number): string => {
  const unit = "the operator's rules for this repository, stated once and kept whole. ";
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
};

/** A raw skill catalog body of exactly `target` characters, in the shape Pi renders (wrapped in `available_skills`). */
function skillsBody(target: number): string {
  const open = "The following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\n\n<available_skills>\n";
  const entries: string[] = [];
  let used = open.length + "\n</available_skills>".length;
  for (let index = 0; used < target - 200; index++) {
    const head = `  <skill>\n    <name>skill-${index}</name>\n    <description>`;
    const tail = `</description>\n    <location>skills/skill-${index}/SKILL.md</location>\n  </skill>\n`;
    const want = Math.min(700, target - used - head.length - tail.length);
    if (want < 80) break;
    const entry = `${head}${filler(want)}${tail}`;
    entries.push(entry);
    used += entry.length;
  }
  const short = target - used;
  const last = entries[entries.length - 1]!;
  if (short > 0) entries[entries.length - 1] = last.replace("</description>", `${filler(short)}</description>`);
  return `${open}${entries.join("")}</available_skills>`;
}

/** The fixed prompt Pi assembled in the recorded session: same sections, same order, same character sizes. */
function recordedFixedPrompt(): string {
  const parts: string[] = [filler(fixture.fixedPromptSections.preamble!)];
  for (const name of sectionNames) {
    const size = fixture.fixedPromptSections[name]!;
    if (name === "preamble") continue;
    const body = name === "skills" ? skillsBody(size) : filler(size);
    parts.push(`<${name}>\n${body}\n</${name}>`);
  }
  return parts.join("\n\n");
}

const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

describe("a fixed prompt fits a small context window", () => {
  it("counts the budget from the route's declared context window, never from a model", () => {
    expect(fixedPromptBudgetTokens(65_536)).toBe(16_384);
    expect(fixedPromptBudgetTokens(65_536, { ...DEFAULT_PROMPT_BUDGET, share: 0.5 })).toBe(32_768);
    expect(fixedPromptBudgetTokens(1)).toBe(1);
    for (const window of [8_192, 65_536, 99_999]) expect(budgetApplies(window)).toBe(true);
    for (const window of [100_000, 200_000, 1_000_000]) expect(budgetApplies(window)).toBe(false);
    for (const window of [undefined, 0, -1, Number.NaN]) expect(budgetApplies(window)).toBe(false);
  });

  it("replays the recorded session: 130,358 characters of fixed prompt on a 65,536-token route", () => {
    const text = recordedFixedPrompt();
    // The fixture records section bodies; the rendered prompt adds one `<name>`/`</name>` wrapper and separator each.
    const recorded = Object.values(fixture.fixedPromptSections).reduce((a, b) => a + b, 0);
    // The fixture records section bodies; the rendered prompt adds each `<name>`/`</name>` wrapper and its separators.
    expect(text.length).toBe(130_708);
    expect(text.length - recorded).toBe(170);
    const plan = planFixedPrompt({ text, contextWindow: fixture.window });
    expect(plan.changed).toBe(true);
    expect(plan.beforeChars).toBe(text.length);
    expect(plan.beforeTokens).toBe(32_677); // 49.9% of the window before any work
    // Priority order: the skills catalog first. In this session that tier alone brings the prompt inside the budget, so
    // the docs block and the memory pack are untouched — the budget never spends a lever it does not need.
    expect(plan.steps).toEqual(["skills-index"]);
    expect(sectionBody(plan.text, "docs")).toBe(sectionBody(text, "docs"));
    expect(sectionBody(plan.text, "ultraterm-memory")).toBe(sectionBody(text, "ultraterm-memory"));
    expect(plan.afterTokens).toBeLessThanOrEqual(plan.budgetTokens); // at or below 25% of the window
    expect(plan.afterTokens / fixture.window).toBeLessThanOrEqual(0.25);
    expect(plan.keptWhole).toBeUndefined(); // the project instructions alone fit inside the budget
    // The project instructions are byte-identical in both prompts.
    expect(sectionBody(plan.text, "project_context")).toBe(sectionBody(text, "project_context"));
    // ... and so are the rules: they are not a section this budget touches.
    expect(sectionBody(plan.text, "rules")).toBe(sectionBody(text, "rules"));
  });

  it("replays the per-turn estimate, before and after, from size-only data", () => {
    const text = recordedFixedPrompt();
    const plan = planFixedPrompt({ text, contextWindow: fixture.window });
    const kept = tokens(fixture.keptMessageCharacters); // the kept conversation after a compaction, at Pi's estimate
    const before = plan.beforeTokens + kept;
    const after = plan.afterTokens + kept;
    // The replay lands on the recorded prompt size: 48,321 tokens per ordinary turn (p50 of 347 turns).
    expect(Math.abs(before - fixture.turns.promptTokensP50!) / fixture.turns.promptTokensP50!).toBeLessThan(0.02);
    expect(after).toBeLessThan(before * 0.7); // a third of every turn's prompt was the fixed prompt, and most of it is gone
    expect(after).toBeGreaterThan(plan.afterTokens); // the conversation is not this change's to shrink
  });

  it("shows why the half-of-every-turn target cannot be met while project instructions stay whole", () => {
    // The narrowest prompt this change can produce still carries the project instructions (never truncated) and the
    // kept conversation (not a fixed-prompt section). If that floor is above half the recorded turn, no compliant
    // budget can reach half, and the shortfall is the rule the leaf states, not a missing shrink.
    const project = tokens(fixture.fixedPromptSections.project_context!);
    const kept = tokens(fixture.keptMessageCharacters);
    const before = tokens(Object.values(fixture.fixedPromptSections).reduce((a, b) => a + b, 0)) + kept;
    expect(project + kept).toBeGreaterThan(before / 2);
    expect(project).toBeLessThan(fixedPromptBudgetTokens(fixture.window)); // ... and it does fit the budget itself
  });
});

describe("the shrink order", () => {
  const small: Record<string, number> = { preamble: 169, tools: 779, rules: 6_128, docs: 1_700, project_context: 37_659,
    skills: 77_508, cwd: 51, "ultraterm-memory": 6_544 };
  const recorded = (over: Record<string, number> = {}) => {
    const sizes = { ...small, ...over };
    return Object.entries(sizes).map(([name, size]) =>
      name === "preamble" ? filler(size) : `<${name}>\n${name === "skills" ? skillsBody(size) : filler(size)}\n</${name}>`).join("\n\n");
  };

  it("stops at the first tier that fits: the index form alone when it is enough", () => {
    const text = recorded({ project_context: 4_000, "ultraterm-memory": 1_000, docs: 400 });
    const plan = planFixedPrompt({ text, contextWindow: 65_536 });
    expect(plan.steps).toEqual(["skills-index"]);
    expect(sectionBody(plan.text, "docs")).toBe(sectionBody(text, "docs"));
    expect(sectionBody(plan.text, "ultraterm-memory")).toBe(sectionBody(text, "ultraterm-memory"));
  });

  it("drops the docs block before it touches the memory pack", () => {
    const text = recorded({ project_context: 30_000, "ultraterm-memory": 24_000 });
    const plan = planFixedPrompt({ text, contextWindow: 65_536 });
    expect(plan.steps).toEqual(["skills-index", "skills-names", "docs-dropped"]);
    expect(sectionBody(plan.text, "docs")).toBeUndefined();
    expect(sectionBody(plan.text, "ultraterm-memory")).toBe(sectionBody(text, "ultraterm-memory"));
    expect(sectionBody(plan.text, "project_context")).toBe(sectionBody(text, "project_context"));
  });

  it("falls to names only, then drops docs, then reduces the memory pack", () => {
    const text = recorded();
    const plan = planFixedPrompt({ text, contextWindow: 65_536, config: { ...DEFAULT_PROMPT_BUDGET, share: 0.12, memoryBytes: 1_024 } });
    expect(plan.steps).toContain("skills-index");
    expect(plan.steps).toContain("docs-dropped");
    expect(plan.steps).toContain("memory-reduced");
    expect(sectionBody(plan.text, "ultraterm-memory")).toContain("memory pack shortened to");
  });

  it("reads the names-only tier as names, locations and the instruction to read the skill file", () => {
    const body = renderSkillNames(skillsBody(20_000));
    expect(body).toContain("Read the SKILL.md");
    expect(body).toContain("skill-0 (skills/skill-0/SKILL.md)");
    expect(body).not.toContain("<description>");
    expect(body.length).toBeLessThan(20_000);
    // The last tier never inflates a catalog it cannot shrink.
    expect(renderSkillNames("skill-a (/a/SKILL.md): do a thing").length).toBeLessThan(400);
  });

  it("cuts a memory pack at a line boundary and says in the prompt that it was cut", () => {
    const body = Array.from({ length: 40 }, (_unused, index) => `- note ${index}: ${filler(80)}`).join("\n");
    const shrunk = shrinkMemory(body, 512);
    expect(Buffer.byteLength(shrunk, "utf8")).toBeLessThanOrEqual(512);
    expect(shrunk).toContain("memory pack shortened to");
    // A pack already inside its budget is returned unchanged, byte for byte.
    expect(shrinkMemory("short", 512)).toBe("short");
  });
});

describe("project instructions are never truncated", () => {
  const text = (() => {
    const parts = ["preamble"];
    for (const [name, size] of Object.entries({ preamble: 169, tools: 779, rules: 6_128, docs: 1_700,
      project_context: 37_659, skills: 77_508, cwd: 51, "ultraterm-memory": 6_544 })) {
      if (name === "preamble") continue;
      parts.push(`<${name}>\n${name === "skills" ? skillsBody(size) : filler(size)}\n</${name}>`);
    }
    return `${filler(169)}\n\n${parts.slice(1).join("\n\n")}`;
  })();

  it("keeps them whole and reports the overage with the numbers", () => {
    // A 2,000-token budget: the project instructions (about 9,415 tokens) cannot fit, and nothing may cut them.
    const plan = planFixedPrompt({ text, contextWindow: 100_000, config: { ...DEFAULT_PROMPT_BUDGET, belowTokens: 200_000, share: 0.02 } });
    expect(plan.budgetTokens).toBe(2_000);
    expect(plan.keptWhole?.section).toBe("project_context");
    expect(plan.keptWhole!.tokens).toBeGreaterThan(plan.budgetTokens);
    expect(sectionBody(plan.text, "project_context")).toBe(sectionBody(text, "project_context"));
    const line = describePromptBudget(plan);
    expect(line).toContain("project instructions kept whole");
    expect(line).toContain(String(plan.keptWhole!.tokens));
    expect(line).toContain(String(plan.keptWhole!.overBy));
  });

  it("reports nothing as kept whole when every tier was enough", () => {
    const plan = planFixedPrompt({ text, contextWindow: fixture.window });
    expect(plan.keptWhole).toBeUndefined();
    expect(describePromptBudget(plan)).not.toContain("kept whole");
  });
});

describe("large-context routes are untouched", () => {
  it("returns the same string, byte for byte, at 200k and at 1M", () => {
    const text = recordedFixedPrompt();
    for (const window of [200_000, 1_000_000]) {
      const plan = planFixedPrompt({ text, contextWindow: window });
      expect(plan.changed).toBe(false);
      expect(plan.text).toBe(text);
      expect(plan.afterChars).toBe(plan.beforeChars);
      expect(plan.steps).toEqual([]);
    }
  });

  it("returns the same string when the prompt is already inside the budget", () => {
    const plan = planFixedPrompt({ text: "<skills>\nsmall (s/SKILL.md)\n</skills>", contextWindow: 65_536 });
    expect(plan.changed).toBe(false);
    expect(plan.text).toBe("<skills>\nsmall (s/SKILL.md)\n</skills>");
  });
});

describe("operator configuration is validated by name", () => {
  it("defaults: under 100,000 tokens, a quarter of the window", () => {
    const { config, problems } = readPromptBudgetConfig({});
    expect(problems).toEqual([]);
    expect(config).toEqual(DEFAULT_PROMPT_BUDGET);
    expect(config.belowTokens).toBe(100_000);
    expect(config.share).toBe(0.25);
  });

  it("refuses a share outside (0, 1] by key", () => {
    for (const value of ["0", "-0.5", "1.5", "abc", "NaN"]) {
      const { config, problems } = readPromptBudgetConfig({ STEAK_PI_PROMPT_BUDGET_SHARE: value });
      expect(problems.map((problem) => problem.key)).toEqual(["prompt-budget.share"]);
      expect(config.share).toBe(0.25); // the default runs, and the problem is named
      expect(() => resolvePromptBudgetConfig({ STEAK_PI_PROMPT_BUDGET_SHARE: value })).toThrow(PromptBudgetError);
      try { resolvePromptBudgetConfig({ STEAK_PI_PROMPT_BUDGET_SHARE: value }); } catch (error) {
        expect((error as PromptBudgetError).code).toBe("bad-prompt-budget");
        expect((error as PromptBudgetError).key).toBe("prompt-budget.share");
        expect((error as Error).message).toContain("prompt-budget.share");
      }
    }
    expect(readPromptBudgetConfig({ STEAK_PI_PROMPT_BUDGET_SHARE: "1" }).config.share).toBe(1);
    expect(readPromptBudgetConfig({ STEAK_PI_PROMPT_BUDGET_SHARE: "0.4" }).config.share).toBe(0.4);
  });

  it("refuses a non-positive or fractional threshold, and a bad byte budget, by key", () => {
    for (const [name, value] of [["STEAK_PI_PROMPT_BUDGET_BELOW_TOKENS", "0"], ["STEAK_PI_PROMPT_BUDGET_BELOW_TOKENS", "1.5"],
      ["STEAK_PI_PROMPT_BUDGET_BELOW_TOKENS", "lots"], ["STEAK_PI_PROMPT_BUDGET_SKILLS_BYTES", "-1"],
      ["STEAK_PI_PROMPT_BUDGET_MEMORY_BYTES", "0"]] as const) {
      const { problems } = readPromptBudgetConfig({ [name]: value });
      expect(problems).toHaveLength(1);
      expect(problems[0]!.key.startsWith("prompt-budget.")).toBe(true);
      expect(problems[0]!.used).not.toBe(value);
    }
    expect(readPromptBudgetConfig({ STEAK_PI_PROMPT_BUDGET_BELOW_TOKENS: "32768" }).config.belowTokens).toBe(32_768);
  });

  it("turns the whole rule off, leaving every route's prompt alone", () => {
    for (const value of ["off", "0", "false", "no"]) {
      const { config } = readPromptBudgetConfig({ STEAK_PI_PROMPT_BUDGET: value });
      expect(config.enabled).toBe(false);
      expect(budgetApplies(8_192, config)).toBe(false);
      expect(planFixedPrompt({ text: recordedFixedPrompt(), contextWindow: 65_536, config }).changed).toBe(false);
    }
  });
});

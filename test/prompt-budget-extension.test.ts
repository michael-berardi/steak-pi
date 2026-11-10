// The extension end of the budget: it decides from the route's declared context window alone, leaves a large-context
// route byte-identical, and reports a refused configuration and a kept-whole overage once, with the numbers.
import { afterEach, describe, expect, it } from "vitest";
import promptBudget from "../extensions/prompt-budget/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const ENV_KEYS = ["STEAK_PI_PROMPT_BUDGET", "STEAK_PI_PROMPT_BUDGET_BELOW_TOKENS", "STEAK_PI_PROMPT_BUDGET_SHARE",
  "STEAK_PI_PROMPT_BUDGET_SKILLS_BYTES", "STEAK_PI_PROMPT_BUDGET_MEMORY_BYTES"] as const;
const saved = new Map<string, string | undefined>();

const withEnv = (env: Partial<Record<(typeof ENV_KEYS)[number], string>>) => {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
};
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

const filler = (length: number, unit = "a rule the operator wrote, stated once. ") =>
  unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

/** The recorded session's fixed prompt, rebuilt from its recorded section sizes (no prompt text is stored here). */
function recordedPrompt(): string {
  const skills = Array.from({ length: 96 }, (_unused, index) =>
    `  <skill>\n    <name>skill-${index}</name>\n    <description>${filler(650)}</description>\n    <location>skills/skill-${index}/SKILL.md</location>\n  </skill>\n`).join("");
  const sections: Array<[string, string]> = [
    ["tools", filler(779)],
    ["rules", filler(6_128)],
    ["docs", filler(1_700)],
    ["project_context", filler(37_659)],
    ["skills", `<available_skills>\n${skills}</available_skills>`],
    ["cwd", filler(51)],
    ["ultraterm-memory", filler(6_544)],
  ];
  return [filler(169), ...sections.map(([name, body]) => `<${name}>\n${body}\n</${name}>`)].join("\n\n");
}

function harness(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  withEnv(env);
  const handlers = new Map<string, Handler>();
  const registered: string[] = [];
  promptBudget({ on: (name: string, handler: Handler) => { registered.push(name); handlers.set(name, handler); } } as never);
  const notes: Array<[string, string]> = [];
  const statuses: Array<[string, string]> = [];
  const ctx = {
    model: { provider: "local", id: "small", contextWindow: 65_536 } as { provider: string; id: string; contextWindow: number } | undefined,
    hasUI: true,
    ui: {
      notify: (text: string, kind: string) => notes.push([kind, text]),
      setStatus: (key: string, text: string) => statuses.push([key, text]),
    },
  };
  const fire = (systemPrompt: string) => handlers.get("before_agent_start")?.({ systemPrompt }, ctx) as { systemPrompt?: string } | undefined;
  return { fire, ctx, notes, statuses, registered, handlers };
}

describe("the fixed-prompt budget applies by context window", () => {
  it("shrinks a 65,536-token route's fixed prompt, reports the numbers, and returns the replacement", () => {
    const h = harness();
    const text = recordedPrompt();
    const result = h.fire(text);
    expect(result?.systemPrompt).toBeDefined();
    expect(result!.systemPrompt!.length).toBeLessThan(text.length);
    const note = h.notes.map(([, text]) => text).join("\n");
    expect(note).toMatch(/prompt budget: fixed prompt \d+ -> \d+ tokens \(\d+(\.\d+)?% of the 65536-token window, budget 16384\)/);
    expect(h.statuses.some(([key]) => key === "prompt-budget")).toBe(true);
    // The project instructions are still there, whole.
    expect(result!.systemPrompt!).toContain(text.slice(text.indexOf("<project_context>"), text.indexOf("</project_context>")));
  });

  it("leaves a 200k and a 1M route byte-identical: no replacement at all", () => {
    const h = harness();
    const text = recordedPrompt();
    for (const window of [200_000, 1_000_000]) {
      h.ctx.model = { provider: "hosted", id: "large", contextWindow: window };
      const before = JSON.stringify(h.fire(text) ?? null);
      expect(before).toBe("null"); // Pi keeps the prompt it built: this hook returns nothing
      expect(h.notes).toHaveLength(0);
    }
  });

  it("does nothing at all when the operator turns it off", () => {
    const h = harness({ STEAK_PI_PROMPT_BUDGET: "off" });
    expect(h.registered).toEqual([]); // not even a handler
  });

  it("a configured threshold moves which routes get a budget", () => {
    const h = harness({ STEAK_PI_PROMPT_BUDGET_BELOW_TOKENS: "300000", STEAK_PI_PROMPT_BUDGET_SHARE: "0.1" });
    h.ctx.model = { provider: "hosted", id: "medium", contextWindow: 200_000 };
    expect(h.fire(recordedPrompt())?.systemPrompt).toBeDefined(); // now inside the threshold, so budgeted
    h.ctx.model = { provider: "hosted", id: "large", contextWindow: 300_000 };
    expect(h.fire(recordedPrompt())).toBeUndefined();
  });

  it("reports a refused configuration once, by key, and keeps working on the default", () => {
    const h = harness({ STEAK_PI_PROMPT_BUDGET_SHARE: "1.5" });
    h.fire(recordedPrompt());
    h.fire(recordedPrompt());
    const refused = h.notes.filter(([, text]) => /REFUSED \(bad-prompt-budget\) prompt-budget\.share/.test(text));
    expect(refused).toHaveLength(1);
    expect(refused[0]![0]).toBe("warning");
    expect(refused[0]![1]).toContain('"1.5"');
    expect(refused[0]![1]).toContain("using 0.25");
  });

  it("reports an overage of project instructions once, and never truncates them", () => {
    const h = harness({ STEAK_PI_PROMPT_BUDGET_SHARE: "0.02" }); // a 1,310-token budget: nine thousand tokens of rules
    const text = recordedPrompt();
    const first = h.fire(text)!;
    const project = (prompt: string) => prompt.slice(prompt.indexOf("<project_context>"), prompt.indexOf("</project_context>"));
    expect(project(first.systemPrompt!)).toBe(project(text));
    h.fire(text);
    const overage = h.notes.filter(([kind, note]) => kind === "warning" && /project instructions kept whole/.test(note));
    expect(overage).toHaveLength(1);
    expect(overage[0]![1]).toMatch(/kept whole \(\d+ tokens, \d+ over the 1310-token budget for a 65536-token window\)/);
    expect(overage[0]![0]).toBe("warning");
  });
});

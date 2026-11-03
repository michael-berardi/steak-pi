// taskClassRules: operator rules (routing.json only) classify an implicit task that names no class.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parseRoutingConfig, RoutingConfigError } from "../src/routing-config.ts";
import { applyInferredTaskClasses, inferTaskClass } from "../src/subagents/task-class.ts";

const dir = mkdtempSync(join(tmpdir(), "steak-pi-task-class-rules-"));
let n = 0;
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const CLASSES = { scout: { chain: ["p/a"] }, "test-writing": { chain: ["p/b"] }, "refactor-small": { chain: ["p/c"] } };
const RULES = [
  { class: "scout", when: { role: "scout" } },
  { class: "scout", when: { mayEdit: false } },
  { class: "test-writing", when: { textPattern: "\\b(write|add)\\b.{0,40}\\btests?\\b" } },
  { class: "refactor-small", when: { textPattern: "\\brefactor|extract\\b" } },
];
function configure(config: Record<string, unknown>) {
  const file = join(dir, `r-${++n}.json`); writeFileSync(file, JSON.stringify(config)); vi.stubEnv("STEAK_PI_ROUTING_CONFIG", file);
}

describe("taskClassRules", () => {
  it("parses valid rules and refuses an unknown class, key or bad pattern with a named error", () => {
    expect(parseRoutingConfig({ taskClasses: CLASSES, taskClassRules: RULES }).taskClassRules).toHaveLength(4);
    expect(() => parseRoutingConfig({ taskClasses: CLASSES, taskClassRules: [{ class: "nope", when: { role: "scout" } }] })).toThrow(RoutingConfigError);
    expect(() => parseRoutingConfig({ taskClasses: CLASSES, taskClassRules: [{ class: "scout", when: { colour: "red" } }] })).toThrow(/unknown key/);
    expect(() => parseRoutingConfig({ taskClasses: CLASSES, taskClassRules: [{ class: "scout", when: { textPattern: "(" } }] })).toThrow(/invalid regular expression/);
    expect(() => parseRoutingConfig({ taskClasses: CLASSES, taskClassRules: [{ class: "scout", when: {} }] })).toThrow(/at least one condition/);
  });

  it("infers the first matching configured class; an explicit class always wins", () => {
    configure({ taskClasses: CLASSES, taskClassRules: RULES });
    expect(inferTaskClass({ label: "a", task: "look around", role: "scout" })?.name).toBe("scout");
    expect(inferTaskClass({ label: "b", task: "summarise the repo", mayEdit: false })?.name).toBe("scout");
    expect(inferTaskClass({ label: "c", task: "Write pytest tests for parse.py", mayEdit: true })?.name).toBe("test-writing");
    expect(inferTaskClass({ label: "d", task: "Refactor the dispatcher", mayEdit: true })?.name).toBe("refactor-small");
    expect(inferTaskClass({ label: "e", task: "fix the login bug", mayEdit: true })).toBeUndefined();
    expect(inferTaskClass({ label: "f", task: "Write tests", mayEdit: true, taskClass: "refactor-small" })).toBeUndefined();
  });

  it("one wave keeps one inferred class; tasks with another ride the wave route", () => {
    configure({ taskClasses: CLASSES, taskClassRules: RULES });
    const { tasks, inferred } = applyInferredTaskClasses<{ label: string; task: string; mayEdit: boolean; taskClass?: string }>([
      { label: "t1", task: "Write tests for a", mayEdit: true },
      { label: "t2", task: "Refactor b", mayEdit: true },
      { label: "t3", task: "Add unit tests for c", mayEdit: true },
    ]);
    expect(tasks.map((t) => t.taskClass)).toEqual(["test-writing", undefined, "test-writing"]);
    expect(inferred.map((i) => i.label)).toEqual(["t1", "t3"]);
  });

  it("without rules nothing is inferred (Steak Pi ships none)", () => {
    configure({ taskClasses: CLASSES });
    expect(inferTaskClass({ label: "a", task: "look around", role: "scout" })).toBeUndefined();
  });
});

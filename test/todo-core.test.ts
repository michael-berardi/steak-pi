import { describe, expect, it } from "vitest";
import { applyOp, render, TodoError, type TodoOp, type TodoState } from "../src/todo-core.ts";

const empty: TodoState = { phases: [] };

function plan(state: TodoState = empty) {
  return applyOp(state, {
    op: "init",
    list: [
      { phase: "Setup", items: ["install deps", "write config"] },
      { phase: "Build", items: ["implement core", "add tests"] },
    ],
  }).state;
}

/** `content:status` for every item, in phase/item order. */
function statuses(state: TodoState): string[] {
  return state.phases.flatMap((phase) =>
    phase.items.map((item) => `${item.content}:${item.status}`),
  );
}

const THIRTEEN = Array.from({ length: 13 }, (_unused, index) => `task ${index + 1}`);

describe("steak pie todo", () => {
  it("init promotes the earliest pending item", () => {
    const { state, output } = applyOp(empty, { op: "init", list: [
      { phase: "Setup", items: ["a", "b"] },
      { phase: "Build", items: ["c"] },
    ]});
    expect(state.phases[0].items[0].status).toBe("in_progress");
    expect(output).toContain("1. Setup (0/2)");
    expect(output).toContain("Overall: 0/3 done");
  });

  it("done auto-promotes the next pending in phase order", () => {
    let { state } = applyOp(empty, { op: "init", list: [
      { phase: "One", items: ["a", "b"] },
      { phase: "Two", items: ["c"] },
    ]});
    state = applyOp(state, { op: "done", task: "a" }).state;
    expect(state.phases[0].items[0].status).toBe("done");
    expect(state.phases[0].items[1].status).toBe("in_progress");
    state = applyOp(state, { op: "done", task: "b" }).state;
    state = applyOp(state, { op: "done", task: "c" }).state;
    expect(state.phases[1].items[0].status).toBe("done");
  });

  it("keeps a single in_progress after start", () => {
    let state = plan();
    state = applyOp(state, { op: "done", task: "install deps" }).state;
    state = applyOp(state, { op: "start", task: "add tests" }).state;
    const inProgress = state.phases
      .flatMap((phase) => phase.items)
      .filter((item) => item.status === "in_progress");
    expect(inProgress.map((item) => item.content)).toEqual(["add tests"]);
  });

  it("blocked items never auto-promote", () => {
    let state = applyOp(empty, { op: "init", list: [
      { phase: "One", items: ["a", "b"] },
    ]}).state;
    state = applyOp(state, { op: "block", task: "a", reason: "waiting on creds" }).state;
    expect(state.phases[0].items[0].status).toBe("blocked");
    expect(state.phases[0].items[1].status).toBe("in_progress");
    state = applyOp(state, { op: "unblock", task: "a" }).state;
    expect(state.phases[0].items[0].status).toBe("pending");
  });

  it("drop removes work; phase completion promotes across phases", () => {
    let state = plan();
    state = applyOp(state, { op: "drop", task: "install deps" }).state;
    expect(state.phases[0].items.find((i) => i.content === "install deps")).toBeUndefined();
    for (const task of ["write config", "implement core", "add tests"]) {
      state = applyOp(state, { op: "done", task }).state;
    }
    expect(state.phases.every((phase) => phase.items.every((i) => i.status === "done"))).toBe(true);
  });

  it("appends tasks into a named phase", () => {
    let state = plan();
    state = applyOp(state, { op: "append", phase: "Build", items: ["review diff"] }).state;
    expect(state.phases[1].items.map((i) => i.content)).toContain("review diff");
  });

  it("unique prefix matching resolves tasks", () => {
    const state = plan();
    const { state: next } = applyOp(state, { op: "done", task: "install" });
    expect(next.phases[0].items[0].status).toBe("done");
  });

  it("rejects ambiguous prefixes and unknown tasks", () => {
    const state = plan();
    expect(() => applyOp(state, { op: "done", task: "i" })).toThrow(TodoError);
    expect(() => applyOp(state, { op: "done", task: "nope" })).toThrow(TodoError);
    expect(() => applyOp(empty, { op: "init", list: [] })).toThrow(TodoError);
  });

  it("done by phase name completes the whole phase", () => {
    let state = plan();
    state = applyOp(state, { op: "done", task: "Build" }).state;
    expect(state.phases[1].items.every((i) => i.status === "done")).toBe(true);
  });

  it("render marks blocked reasons and progress", () => {
    let state = applyOp(empty, { op: "init", list: [{ phase: "P", items: ["a", "b"] }] }).state;
    state = applyOp(state, { op: "block", task: "b", reason: "external" }).state;
    const text = render(state);
    expect(text).toContain("[!]");
    expect(text).toContain("— external");
    expect(text).toContain("Overall: 0/2 done");
  });
});

describe("bulk ordered transitions", () => {
  it("bulk start keeps every explicitly selected task active", () => {
    let state = applyOp(empty, { op: "init", list: [
      { phase: "One", items: ["a", "b", "c"] },
      { phase: "Two", items: ["d"] },
    ]}).state;
    expect(state.phases[0].items[0].status).toBe("in_progress");
    state = applyOp(state, { op: "start", items: ["b", "d"] }).state;
    expect(statuses(state)).toEqual([
      "a:pending",
      "b:in_progress",
      "c:pending",
      "d:in_progress",
    ]);
  });

  it("bulk start failure is atomic and keeps the previous active task", () => {
    const state = applyOp(empty, { op: "init", list: [{ phase: "One", items: ["a", "b"] }] }).state;
    const before = structuredClone(state);
    expect(() => applyOp(state, { op: "start", items: ["b", "nope"] }))
      .toThrowError(new TodoError("unknown task: nope"));
    expect(state).toEqual(before);
  });

  it("bulk done completes all named tasks and promotes the next pending", () => {
    let state = plan();
    state = applyOp(state, { op: "done", items: ["install deps", "write config"] }).state;
    expect(statuses(state)).toEqual([
      "install deps:done",
      "write config:done",
      "implement core:in_progress",
      "add tests:pending",
    ]);
  });

  it("bulk done failure is atomic for unknown and ambiguous targets", () => {
    const state = plan();
    const before = structuredClone(state);
    expect(() => applyOp(state, { op: "done", items: ["install deps", "nope"] }))
      .toThrowError(new TodoError("unknown task: nope"));
    expect(state).toEqual(before);
    expect(() => applyOp(state, { op: "done", items: ["install deps", "i"] }))
      .toThrowError(new TodoError("ambiguous task prefix: i"));
    expect(state).toEqual(before);
    expect(render(state)).toBe(render(before));
  });

  it("bulk item names never fall back to completing a whole phase", () => {
    const state = plan();
    const before = structuredClone(state);
    expect(() => applyOp(state, { op: "done", items: ["Build"] }))
      .toThrowError(new TodoError("unknown task: Build"));
    expect(state).toEqual(before);
    // The single-op interface still accepts a phase name.
    const single = applyOp(structuredClone(state), { op: "done", phase: "Build" }).state;
    expect(single.phases[1].items.every((item) => item.status === "done")).toBe(true);
  });

  it("bulk drop removes tasks without deleting or emptying phases", () => {
    let state = plan();
    state = applyOp(state, { op: "drop", items: ["install deps", "add tests"] }).state;
    expect(state.phases.map((phase) => phase.name)).toEqual(["Setup", "Build"]);
    expect(statuses(state)).toEqual(["write config:in_progress", "implement core:pending"]);

    const before = structuredClone(state);
    expect(() => applyOp(state, { op: "rm", items: ["Setup"] }))
      .toThrowError(new TodoError("unknown task: Setup"));
    expect(state).toEqual(before);
  });

  it("bulk block/unblock carry the reason and stay non-completing", () => {
    let state = plan();
    state = applyOp(state, {
      op: "block",
      items: ["implement core", "add tests"],
      reason: "external",
    }).state;
    expect(statuses(state).filter((entry) => entry.endsWith(":blocked"))).toEqual([
      "implement core:blocked",
      "add tests:blocked",
    ]);
    expect(statuses(state)).toContain("install deps:in_progress");
    expect(render(state)).toContain("— external");

    state = applyOp(state, { op: "unblock", items: ["implement core", "add tests"] }).state;
    expect(statuses(state).filter((entry) => entry.endsWith(":blocked"))).toEqual([]);
    expect(statuses(state).every((entry) => !entry.endsWith(":done"))).toBe(true);
    expect(render(state)).not.toContain("— external");
  });

  it("rejects nonempty items combined with task or phase without mutating", () => {
    const state = plan();
    const before = structuredClone(state);
    expect(() => applyOp(state, { op: "done", items: ["install deps"], task: "write config" } as unknown as TodoOp))
      .toThrowError(new TodoError("done cannot combine items with task or phase"));
    expect(() => applyOp(state, { op: "start", items: ["implement core"], phase: "Setup" } as unknown as TodoOp))
      .toThrowError(new TodoError("start cannot combine items with task or phase"));
    expect(() => applyOp(state, { op: "done", task: "install deps", phase: "Setup" }))
      .toThrowError(new TodoError("done cannot combine task and phase"));
    expect(() => applyOp(state, { op: "rm", task: "install deps", phase: "Setup" }))
      .toThrowError(new TodoError("rm cannot combine task and phase"));
    expect(state).toEqual(before);
  });

  it("treats an empty items array next to a real selector as the single op", () => {
    let state = plan();
    state = applyOp(state, { op: "done", task: "install deps", items: [] } as unknown as TodoOp).state;
    expect(state.phases[0].items[0].status).toBe("done");
    expect(state.phases[0].items[1].status).toBe("in_progress");

    state = applyOp(state, { op: "start", task: "add tests", items: [] } as unknown as TodoOp).state;
    expect(statuses(state).filter((entry) => entry.endsWith(":in_progress"))).toEqual(["add tests:in_progress"]);
  });

  it("rejects an empty or blank items batch with no selector, without mutating", () => {
    const state = plan();
    const before = structuredClone(state);
    expect(() => applyOp(state, { op: "done", items: [] } as unknown as TodoOp))
      .toThrowError(new TodoError("done requires a non-empty items list or a task/phase"));
    expect(() => applyOp(state, { op: "start", items: [""] }))
      .toThrowError(new TodoError("start items must be non-empty task names"));
    expect(() => applyOp(state, { op: "done", items: "install deps" } as unknown as TodoOp))
      .toThrowError(new TodoError("done items must be an array of task names"));
    expect(state).toEqual(before);
  });

  it("never infers completion from start, block, unblock or view", () => {
    let state = plan();
    state = applyOp(state, { op: "start", items: ["write config", "add tests"] }).state;
    state = applyOp(state, { op: "block", items: ["implement core"], reason: "x" }).state;
    state = applyOp(state, { op: "unblock", items: ["implement core"] }).state;
    applyOp(state, { op: "view" });
    expect(statuses(state)).toEqual([
      "install deps:pending",
      "write config:in_progress",
      "implement core:pending",
      "add tests:in_progress",
    ]);
    expect(statuses(state).some((entry) => entry.endsWith(":done"))).toBe(false);
  });
});

describe("init idempotence and progress preservation", () => {
  it("a repeated identical init preserves finished counts (13/13)", () => {
    const init = { op: "init", list: [{ phase: "Batch", items: THIRTEEN }] } as unknown as TodoOp;
    let state = applyOp(empty, init).state;
    state = applyOp(state, { op: "done", items: THIRTEEN }).state;
    expect(render(state)).toContain("Overall: 13/13 done");

    const again = applyOp(state, init);
    expect(again.state).toEqual(state);
    expect(again.output).toContain("1. Batch (13/13)");
    expect(again.output).toContain("Overall: 13/13 done");
  });

  it("a repeated identical init keeps partial progress and the active item", () => {
    const list = [{ phase: "Batch", items: ["a", "b", "c"] }];
    let state = applyOp(empty, { op: "init", list }).state;
    state = applyOp(state, { op: "done", task: "a" }).state;
    const again = applyOp(state, { op: "init", list });
    expect(again.state.phases[0].items.map((item) => item.status)).toEqual([
      "done",
      "in_progress",
      "pending",
    ]);
    expect(again.output).toContain("Overall: 1/3 done");
  });

  it("a structurally distinct plan still replaces and resets progress", () => {
    const state = plan();
    const done = applyOp(state, { op: "done", task: "install deps" }).state;
    const replaced = applyOp(done, {
      op: "init",
      list: [{ phase: "Setup", items: ["install deps", "write config", "extra"] }],
    }).state;
    expect(replaced.phases).toHaveLength(1);
    expect(statuses(replaced)).toEqual([
      "install deps:in_progress",
      "write config:pending",
      "extra:pending",
    ]);
  });

  it("rejects malformed init lists", () => {
    expect(() => applyOp(empty, { op: "init", list: [] }))
      .toThrowError(new TodoError("init requires a non-empty list of phases"));
    expect(() => applyOp(empty, { op: "init", list: [{ phase: "P", items: [1] }] } as unknown as TodoOp))
      .toThrowError(new TodoError("init phase 1 must have a string name and string items"));
  });
});

describe("phase-name collisions and stable numbering", () => {
  it("a task whose content collides with a phase name targets the task", () => {
    const state = applyOp(empty, { op: "init", list: [
      { phase: "Build", items: ["Build", "other"] },
    ]}).state;
    const next = applyOp(state, { op: "done", task: "Build" }).state;
    expect(next.phases[0].items.map((item) => item.status)).toEqual(["done", "in_progress"]);
  });

  it("a task prefix that matches a task wins over the phase-name fallback", () => {
    const state = applyOp(empty, { op: "init", list: [
      { phase: "Verify", items: ["Verify build"] },
      { phase: "Other", items: ["x"] },
    ]}).state;
    const next = applyOp(state, { op: "done", task: "Verify" }).state;
    expect(next.phases[0].items[0].status).toBe("done");
    expect(next.phases[1].items[0].status).toBe("in_progress");
    const bulk = applyOp(state, { op: "done", items: ["Verify"] }).state;
    expect(bulk.phases[0].items[0].status).toBe("done");
  });

  it("render keeps emptied phases and stable numbering", () => {
    let state = applyOp(empty, { op: "init", list: [
      { phase: "One", items: ["a"] },
      { phase: "Two", items: ["b"] },
      { phase: "Three", items: ["c"] },
    ]}).state;
    state = applyOp(state, { op: "drop", items: ["b"] }).state;
    const text = render(state);
    expect(text).toContain("1. One (0/1)");
    expect(text).toContain("2. Two (0/0)");
    expect(text).toContain("3. Three (0/1)");
    expect(text).toContain("Overall: 0/2 done");
  });
});

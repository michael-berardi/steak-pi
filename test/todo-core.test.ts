import { describe, expect, it } from "vitest";
import { applyOp, render, TodoError, type TodoState } from "../extensions/todo-core.ts";

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

describe("cherry pi todo", () => {
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

  it("render marks blocked reasons and progress", () => {
    let state = applyOp(empty, { op: "init", list: [{ phase: "P", items: ["a", "b"] }] }).state;
    state = applyOp(state, { op: "block", task: "b", reason: "external" }).state;
    const text = render(state);
    expect(text).toContain("[!]");
    expect(text).toContain("— external");
    expect(text).toContain("Overall: 0/2 done");
  });
});

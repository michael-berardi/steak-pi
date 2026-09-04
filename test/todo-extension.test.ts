import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import todoExtension from "../extensions/todo.ts";
import { TodoError, type TodoState } from "../src/todo-core.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "steak-pi-todo-"));
  tempDirs.push(dir);
  return dir;
}

function registerTodo(): (...args: any[]) => Promise<any> {
  let execute: ((...args: any[]) => Promise<any>) | undefined;
  const pi = {
    registerTool(tool: { execute: (...args: any[]) => Promise<any> }) {
      execute = tool.execute;
    },
  } as unknown as ExtensionAPI;
  todoExtension(pi);
  if (!execute) throw new Error("todo tool was not registered");
  return execute;
}

function callTodo(execute: (...args: any[]) => Promise<any>, cwd: string, params: object) {
  return execute("call", params, undefined, undefined, { cwd });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("todo extension persistence", () => {
  it("uses the tool context cwd and atomically publishes both state files", async () => {
    const cwd = await tempDir();
    const execute = registerTodo();
    await callTodo(execute, cwd, {
      op: "init",
      list: [{ phase: "Build", items: ["implement"] }],
    });

    const state = JSON.parse(
      await fs.readFile(path.join(cwd, ".steak-pi", "todo.json"), "utf8"),
    ) as TodoState;
    expect(state.phases[0]?.items[0]?.status).toBe("in_progress");
    expect(await fs.readFile(path.join(cwd, ".steak-pi", "TODO.md"), "utf8"))
      .toContain("[>] implement");
    expect(await fs.readdir(path.join(cwd, ".steak-pi")))
      .toEqual(["TODO.md", "todo.json"]);
  });

  it("does not create or update files for view", async () => {
    const cwd = await tempDir();
    const state: TodoState = {
      phases: [{ name: "Read", items: [{ content: "inspect", status: "in_progress" }] }],
    };
    const stateDir = path.join(cwd, ".steak-pi");
    const statePath = path.join(stateDir, "todo.json");
    await fs.mkdir(stateDir);
    const original = JSON.stringify(state);
    await fs.writeFile(statePath, original);
    const execute = registerTodo();

    const result = await callTodo(execute, cwd, { op: "view" });
    expect(result.content[0].text).toContain("[>] inspect");
    expect(await fs.readFile(statePath, "utf8")).toBe(original);
    await expect(fs.access(path.join(stateDir, "TODO.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a missing-state view read-only", async () => {
    const cwd = await tempDir();
    const result = await callTodo(registerTodo(), cwd, { op: "view" });
    expect(result.content[0].text).toContain("Todo list is empty");
    await expect(fs.access(path.join(cwd, ".steak-pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed and visibly on malformed persisted state", async () => {
    const cwd = await tempDir();
    const stateDir = path.join(cwd, ".steak-pi");
    const statePath = path.join(stateDir, "todo.json");
    await fs.mkdir(stateDir);
    const malformed = JSON.stringify({
      phases: [{ name: "Build", items: [{ content: "task", status: "invented" }] }],
    });
    await fs.writeFile(statePath, malformed);

    await expect(callTodo(registerTodo(), cwd, { op: "done", task: "task" }))
      .rejects.toThrowError(new TodoError(
        "persisted todo state is malformed: invalid item 1 in phase 1",
      ));
    expect(await fs.readFile(statePath, "utf8")).toBe(malformed);
    await expect(fs.access(path.join(stateDir, "TODO.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws TodoError for rejected mutations without rewriting state", async () => {
    const cwd = await tempDir();
    const execute = registerTodo();
    await callTodo(execute, cwd, {
      op: "init",
      list: [{ phase: "Build", items: ["known"] }],
    });
    const statePath = path.join(cwd, ".steak-pi", "todo.json");
    const before = await fs.readFile(statePath, "utf8");

    await expect(callTodo(execute, cwd, { op: "done", task: "unknown" }))
      .rejects.toBeInstanceOf(TodoError);
    expect(await fs.readFile(statePath, "utf8")).toBe(before);
  });

  it("serializes concurrent mutations so neither update is lost", async () => {
    const cwd = await tempDir();
    const execute = registerTodo();
    await callTodo(execute, cwd, {
      op: "init",
      list: [{ phase: "Build", items: ["first"] }],
    });

    await Promise.all([
      callTodo(execute, cwd, { op: "append", phase: "Build", items: ["second"] }),
      callTodo(execute, cwd, { op: "append", phase: "Build", items: ["third"] }),
    ]);
    const state = JSON.parse(
      await fs.readFile(path.join(cwd, ".steak-pi", "todo.json"), "utf8"),
    ) as TodoState;
    expect(state.phases[0]?.items.map((item) => item.content))
      .toEqual(["first", "second", "third"]);
  });
});

import { createHash } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSkillsFromDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import todoExtension from "../extensions/todo.ts";
import { setPinnedPanel } from "../src/tui/pinned-panels.ts";
import { TodoError, type TodoState } from "../src/todo-core.ts";

const SESSION_ID = "7c824aae-7b2e-4a3a-a9f0-06a190b1fbc8";
function nativeContext(cwd: string, id = SESSION_ID) {
  return { cwd, sessionManager: {
    getSessionId: () => id,
    getSessionFile: () => path.join(realpathSync(cwd), `2026-06-01T10-00-00-000Z_${id}.jsonl`),
  } };
}
function planDir(cwd: string, id = SESSION_ID) {
  const ctx = nativeContext(cwd, id);
  const hash = createHash("sha256").update(JSON.stringify([ctx.sessionManager.getSessionFile(), id])).digest("hex");
  return path.join(cwd, ".steak-pi", "todo", hash);
}

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
  return execute("call", params, undefined, undefined, nativeContext(cwd));
}

interface WidgetCall {
  key: string;
  content: any;
  options?: { placement?: string };
}

interface Harness {
  execute: (...args: any[]) => Promise<any>;
  handlers: Map<string, (...args: any[]) => any>;
  widgets: WidgetCall[];
  ctx: ReturnType<typeof nativeContext> & { ui: { setWidget(key: string, content: any, options?: any): void } };
  call(params: object): Promise<any>;
  lastPinned(): WidgetCall | undefined;
  renderPinned(width?: number): string[] | undefined;
}

/** Registers the real extension with a recording UI + lifecycle event capture. */
function registerHarness(cwd: string, id = SESSION_ID): Harness {
  let execute: ((...args: any[]) => Promise<any>) | undefined;
  const handlers = new Map<string, (...args: any[]) => any>();
  const widgets: WidgetCall[] = [];
  const pi = {
    registerTool(tool: { execute: (...args: any[]) => Promise<any> }) {
      execute = tool.execute;
    },
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  todoExtension(pi);
  if (!execute) throw new Error("todo tool was not registered");

  const ui = {
    setWidget(key: string, content: any, options?: any) {
      widgets.push({ key, content, options });
    },
  };
  const ctx = { ...nativeContext(cwd, id), ui };
  const lastPinned = () => [...widgets].reverse().find((entry) => entry.key === "steak-pinned-panels");
  return {
    execute,
    handlers,
    widgets,
    ctx,
    call: (params) => execute!("call", params, undefined, undefined, ctx),
    lastPinned,
    renderPinned(width = 60) {
      const entry = lastPinned();
      if (!entry || typeof entry.content !== "function") return undefined;
      const component = entry.content(
        {},
        { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      );
      return component.render(width);
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
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
      await fs.readFile(path.join(planDir(cwd), "todo.json"), "utf8"),
    ) as TodoState;
    expect(state.phases[0]?.items[0]?.status).toBe("in_progress");
    expect(await fs.readFile(path.join(planDir(cwd), "TODO.md"), "utf8"))
      .toContain("[>] implement");
    expect(await fs.readdir(planDir(cwd)))
      .toEqual(["TODO.md", "todo.json"]);
  });

  it("does not create or update files for view", async () => {
    const cwd = await tempDir();
    const state: TodoState = {
      phases: [{ name: "Read", items: [{ content: "inspect", status: "in_progress" }] }],
    };
    const stateDir = planDir(cwd);
    const statePath = path.join(stateDir, "todo.json");
    await fs.mkdir(stateDir, { recursive: true });
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
    const stateDir = planDir(cwd);
    const statePath = path.join(stateDir, "todo.json");
    await fs.mkdir(stateDir, { recursive: true });
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
    const statePath = path.join(planDir(cwd), "todo.json");
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
      await fs.readFile(path.join(planDir(cwd), "todo.json"), "utf8"),
    ) as TodoState;
    expect(state.phases[0]?.items.map((item) => item.content))
      .toEqual(["first", "second", "third"]);
  });

  it("keeps recorded progress on an identical init and replaces on a changed one", async () => {
    const cwd = await tempDir();
    const execute = registerTodo();
    const list = [{ phase: "Build", items: ["first", "second"] }];
    await callTodo(execute, cwd, { op: "init", list });
    await callTodo(execute, cwd, { op: "done", task: "first" });
    await callTodo(execute, cwd, { op: "init", list });

    const statePath = path.join(planDir(cwd), "todo.json");
    const preserved = JSON.parse(await fs.readFile(statePath, "utf8")) as TodoState;
    expect(preserved.phases[0]?.items.map((item) => item.status)).toEqual(["done", "in_progress"]);

    await callTodo(execute, cwd, { op: "init", list: [{ phase: "Build", items: ["third"] }] });
    const replaced = JSON.parse(await fs.readFile(statePath, "utf8")) as TodoState;
    expect(replaced.phases[0]?.items.map((item) => item.content)).toEqual(["third"]);
    expect(replaced.phases[0]?.items[0]?.status).toBe("in_progress");
  });
});

describe("todo pinned panel lifecycle", () => {
  it("publishes the panel through the shared compositor only, above the editor", async () => {
    const harness = registerHarness(await tempDir());
    await harness.call({ op: "init", list: [{ phase: "Build", items: ["implement", "test"] }] });

    const keys = [...new Set(harness.widgets.map((entry) => entry.key))].sort();
    expect(keys).toEqual(["steak-pinned-panels", "usap-progress"]);
    expect(harness.widgets.some((entry) => entry.key.includes("todo"))).toBe(false);
    expect(harness.lastPinned()?.options?.placement).toBe("aboveEditor");

    const text = harness.renderPinned(60)!.join("\n");
    expect(text).toContain("TODO 0/2 done");
    expect(text).toContain("[>] implement");
    expect(text).toContain("[ ] test");
  });

  it("refreshes content without remounting the panel on mutations or view",  async () => {
    const harness = registerHarness(await tempDir());
    await harness.call({ op: "init", list: [{ phase: "Build", items: ["first", "second"] }] });
    await harness.call({ op: "done", task: "first" });

    const afterDone = harness.renderPinned(60)!.join("\n");
    expect(afterDone).toContain("[x] first");
    expect(afterDone).toContain("[>] second");
    expect(afterDone).toContain("1/2 done");

    const before = harness.widgets.length;
    const result = await harness.call({ op: "view" });
    expect(result.content[0].text).toContain("Overall: 1/2 done");
    expect(result.details.state.phases[0].items[1].status).toBe("in_progress");
    expect(harness.widgets.length).toBe(before);
    expect(harness.renderPinned(60)!.join("\n")).toContain("[>] second");
  });

  it("clears the pinned panel when the plan becomes empty", async () => {
    const harness = registerHarness(await tempDir());
    await harness.call({ op: "init", list: [{ phase: "Build", items: ["only"] }] });
    expect(harness.renderPinned(60)).toBeDefined();

    await harness.call({ op: "rm", phase: "Build" });
    expect(harness.lastPinned()?.content).toBeUndefined();
    expect(harness.renderPinned(60)).toBeUndefined();
  });

  it("restores the persisted plan on session resume", async () => {
    const cwd = await tempDir();
    const stateDir = planDir(cwd);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "todo.json"),
      JSON.stringify({
        phases: [{ name: "Resume", items: [{ content: "restored task", status: "in_progress" }] }],
      }),
    );
    const harness = registerHarness(cwd);
    await harness.handlers.get("session_start")!({}, harness.ctx);

    const text = harness.renderPinned(60)!.join("\n");
    expect(text).toContain("restored task");
    expect(text).toContain("1. Resume");
  });

  it("does not leak a plan across sessions when the next session has none", async () => {
    const first = await tempDir();
    const second = await tempDir();
    const harness = registerHarness(first);
    await harness.call({ op: "init", list: [{ phase: "Build", items: ["session one task"] }] });
    expect(harness.renderPinned(60)!.join("\n")).toContain("session one task");

    harness.ctx.cwd = second;
    await harness.handlers.get("session_start")!({}, harness.ctx);
    expect(harness.lastPinned()?.content).toBeUndefined();
    expect(harness.renderPinned(60)).toBeUndefined();
  });

  it("clears on committed shutdown but preserves the plan during a cancellable switch",  async () => {
    const harness = registerHarness(await tempDir());
    await harness.call({ op: "init", list: [{ phase: "Build", items: ["first"] }] });

    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
    expect(harness.lastPinned()?.content).toBeUndefined();

    await harness.handlers.get("session_start")!({}, harness.ctx);
    await harness.call({ op: "init", list: [{ phase: "Build", items: ["again"] }] });
    expect(harness.renderPinned(60)).toBeDefined();
    await harness.handlers.get("session_before_switch")?.({}, harness.ctx);
    expect(harness.renderPinned(60)).toBeDefined();
    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
    expect(harness.renderPinned(60)).toBeUndefined();
  });

  it("clears the panel on malformed persisted state without throwing", async () => {
    const cwd = await tempDir();
    const stateDir = planDir(cwd);
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "todo.json"),
      JSON.stringify({ phases: [{ name: "Build", items: [{ content: "task", status: "invented" }] }] }),
    );
    const harness = registerHarness(cwd);

    await expect(harness.handlers.get("session_start")!({}, harness.ctx)).resolves.toBeUndefined();
    expect(harness.lastPinned()?.content).toBeUndefined();
    expect(harness.renderPinned(60)).toBeUndefined();
  });

  it("degrades gracefully when the host has no UI context", async () => {
    const cwd = await tempDir();
    const harness = registerHarness(cwd);
    const result = await harness.execute(
      "call",
      { op: "init", list: [{ phase: "Build", items: ["headless"] }] },
      undefined,
      undefined,
      nativeContext(cwd),
    );

    expect(result.content[0].text).toContain("[>] headless");
    expect(harness.widgets).toEqual([]);
  });
});


describe("native session isolation", () => {
  const otherId = "4e5136f1-2a6c-490b-8c17-856ddc1b4d64";
  const init = { op: "init", list: [{ phase: "Private", items: ["secret plan"] }] };

  it("isolates same-workspace sessions, restores on restart, and tags native ownership", async () => {
    const cwd = await tempDir();
    const first = registerHarness(cwd);
    const result = await first.call(init);
    expect(result.details.ownerSessionId).toBe(SESSION_ID);
    expect(result.details.ownerSessionFile).toBe(nativeContext(cwd).sessionManager.getSessionFile());
    const second = registerHarness(cwd, otherId);
    await second.handlers.get("session_start")!({}, second.ctx);
    expect((await second.call({ op: "view" })).details.state.phases).toEqual([]);
    expect(second.renderPinned()).toBeUndefined();
    const restarted = registerHarness(cwd);
    await restarted.handlers.get("session_start")!({}, restarted.ctx);
    expect(restarted.renderPinned()!.join("\n")).toContain("secret plan");
    expect((await restarted.call({ op: "view" })).details).toEqual(result.details);
  });

  it("never adopts or changes legacy workspace files", async () => {
    const cwd = await tempDir();
    const legacy = path.join(cwd, ".steak-pi");
    await fs.mkdir(legacy);
    await fs.writeFile(path.join(legacy, "todo.json"), JSON.stringify({ phases: [{ name: "old", items: [] }] }));
    await fs.writeFile(path.join(legacy, "TODO.md"), "legacy markdown");
    const before = await fs.readFile(path.join(legacy, "todo.json"), "utf8");
    const harness = registerHarness(cwd);
    await harness.handlers.get("session_start")!({}, harness.ctx);
    expect((await harness.call({ op: "view" })).details.state.phases).toEqual([]);
    await harness.call(init);
    expect(await fs.readFile(path.join(legacy, "todo.json"), "utf8")).toBe(before);
    expect(await fs.readFile(path.join(legacy, "TODO.md"), "utf8")).toBe("legacy markdown");
  });

  it("fails closed without native metadata and rejects foreign contexts", async () => {
    const cwd = await tempDir();
    const harness = registerHarness(cwd);
    await expect(harness.execute("call", init, undefined, undefined, { cwd })).rejects.toThrow("native session");
    await harness.handlers.get("session_start")!({}, harness.ctx);
    await expect(harness.execute("call", init, undefined, undefined, nativeContext(cwd, otherId))).rejects.toThrow("no longer owns");
    await expect(fs.access(planDir(cwd, otherId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a stale async mutation without publishing or returning its plan", async () => {
    const cwd = await tempDir();
    const harness = registerHarness(cwd);
    await harness.call(init);
    const read = fs.readFile.bind(fs);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs, "readFile").mockImplementationOnce((async (...args: any[]) => {
      entered();
      await gate;
      return (read as any)(...args);
    }) as any);
    const pending = harness.call({ op: "append", phase: "Private", items: ["stale"] });
    const rejected = expect(pending).rejects.toThrow("no longer owns");
    await waiting;
    harness.ctx.sessionManager = nativeContext(cwd, otherId).sessionManager;
    await harness.handlers.get("session_start")!({}, harness.ctx);
    const count = harness.widgets.length;
    release();
    await rejected;
    expect(harness.widgets.length).toBe(count);
    expect(harness.renderPinned()).toBeUndefined();
    expect(await fs.readFile(path.join(planDir(cwd), "todo.json"), "utf8")).not.toContain("stale");
  });

  it("does not commit staged writes after ownership changes", async () => {
    const cwd = await tempDir();
    const harness = registerHarness(cwd);
    await harness.call(init);
    const statePath = path.join(planDir(cwd), "todo.json");
    const before = await fs.readFile(statePath, "utf8");
    const write = fs.writeFile.bind(fs);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs, "writeFile").mockImplementationOnce((async (...args: any[]) => {
      await (write as any)(...args);
      entered();
      await gate;
    }) as any);
    const pending = harness.call({ op: "append", phase: "Private", items: ["stale"] });
    const rejected = expect(pending).rejects.toThrow("no longer owns");
    await waiting;
    harness.ctx.sessionManager = nativeContext(cwd, otherId).sessionManager;
    await harness.handlers.get("session_start")!({}, harness.ctx);
    const count = harness.widgets.length;
    release();
    await rejected;
    expect(harness.widgets.length).toBe(count);
    expect(await fs.readFile(statePath, "utf8")).toBe(before);
    expect(await fs.readdir(planDir(cwd))).toEqual(["TODO.md", "todo.json"]);
    await expect(fs.access(planDir(cwd, otherId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish an obsolete session-start read after a switch", async () => {
    const cwd = await tempDir();
    const harness = registerHarness(cwd);
    await harness.call(init);
    const read = fs.readFile.bind(fs);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs, "readFile").mockImplementationOnce((async (...args: any[]) => {
      await gate;
      return (read as any)(...args);
    }) as any);
    const pending = harness.handlers.get("session_start")!({}, harness.ctx);
    harness.ctx.sessionManager = nativeContext(cwd, otherId).sessionManager;
    await harness.handlers.get("session_start")!({}, harness.ctx);
    const count = harness.widgets.length;
    release();
    await pending;
    expect(harness.widgets.length).toBe(count);
    expect(harness.renderPinned()).toBeUndefined();
  });
});

const PLAN = {
  op: "init",
  list: [{ phase: "Release", items: ["draft-changelog", "draft-notes", "ship-artifact"] }],
};
const guidance = (harness: Harness, systemPrompt = "BASE PROMPT") =>
  harness.handlers.get("before_agent_start")!({ systemPrompt }, harness.ctx);

/** The instruction channel the agent actually reads: one chained system prompt. */
describe("todo agent-facing maintenance instructions", () => {
  it("adds the maintenance duties only while an unfinished plan exists", async () => {
    const harness = registerHarness(await tempDir());
    expect(harness.handlers.has("before_agent_start")).toBe(true);
    expect(await guidance(harness)).toBeUndefined();

    await harness.call(PLAN);
    const result = await guidance(harness);
    expect(Object.keys(result)).toEqual(["systemPrompt"]);
    expect(result.systemPrompt.startsWith("BASE PROMPT\n\n## Active todo plan\n")).toBe(true);
    for (const duty of [
      'op:"start"',
      'op:"done"',
      'op:"block"',
      "verified the result yourself",
      "Do not move to a later phase",
      'op:"view"',
      "reconcile every item",
      "do not re-view or re-mark the same step",
    ]) {
      expect(result.systemPrompt).toContain(duty);
    }

    await harness.call({ op: "done", items: ["draft-changelog", "draft-notes", "ship-artifact"] });
    const settled = harness.widgets.length;
    expect(await guidance(harness)).toBeUndefined();
    expect(harness.widgets.length).toBe(settled);
  });

  it("cannot fabricate progress: no plan labels, counts, or statuses in the text", async () => {
    const harness = registerHarness(await tempDir());
    await harness.call(PLAN);
    const first = (await guidance(harness)).systemPrompt;
    await harness.call({ op: "block", task: "draft-notes", reason: "waiting on operator input" });
    await harness.call({ op: "start", task: "ship-artifact" });
    const second = (await guidance(harness)).systemPrompt;

    expect(second).toBe(first);
    for (const label of ["Release", "draft-changelog", "draft-notes", "ship-artifact", "waiting on operator input"]) {
      expect(first).not.toContain(label);
    }
    expect(first).not.toMatch(/\d+\s*\/\s*\d+/);
    expect(first).not.toMatch(/\[(x|>| |!)\]/);
  });

  it("never borrows another session's plan for its instructions", async () => {
    const cwd = await tempDir();
    const owner = registerHarness(cwd);
    await owner.call(PLAN);
    expect((await guidance(owner)).systemPrompt).toContain("## Active todo plan");

    const foreign = registerHarness(cwd, "5b2f0f8e-6d76-4a51-9c0f-1a2b3c4d5e6f");
    await foreign.handlers.get("session_start")!({}, foreign.ctx);
    expect(await guidance(foreign)).toBeUndefined();

    await foreign.call({ op: "init", list: [{ phase: "Foreign", items: ["other work"] }] });
    const text = (await guidance(foreign)).systemPrompt;
    expect(text).toContain("## Active todo plan");
    expect(text).not.toContain("draft-changelog");
    expect((await guidance(owner)).systemPrompt).not.toContain("other work");
  });

  it("stays silent rather than injecting a prompt while the session shuts down", async () => {
    const harness = registerHarness(await tempDir());
    await harness.call(PLAN);
    expect((await guidance(harness)).systemPrompt).toContain("## Active todo plan");

    await harness.handlers.get("session_shutdown")!({}, harness.ctx);
    expect(await guidance(harness)).toBeUndefined();
  });
});

/** Failures must stay actionable and all-or-nothing. */
describe("todo actionable failures", () => {
  it("names the known labels on a miss and leaves state untouched", async () => {
    const cwd = await tempDir();
    const harness = registerHarness(cwd);
    await harness.call(PLAN);
    const statePath = path.join(planDir(cwd), "todo.json");
    const before = await fs.readFile(statePath, "utf8");

    await expect(harness.call({ op: "done", task: "missing" }))
      .rejects.toThrow(/^unknown task: missing — known tasks: draft-changelog, draft-notes, ship-artifact$/);
    await expect(harness.call({ op: "done", task: "draft" }))
      .rejects.toThrow(/^ambiguous task prefix: draft — known tasks: draft-changelog, draft-notes, ship-artifact$/);
    await expect(harness.call({ op: "done", phase: "Absent" }))
      .rejects.toThrow(/^unknown phase: Absent — known phases: Release$/);
    await expect(harness.call({ op: "done", items: ["draft-changelog", "missing"] }))
      .rejects.toThrow(/^unknown task: missing — known tasks: draft-changelog, draft-notes, ship-artifact$/);

    expect(await fs.readFile(statePath, "utf8")).toBe(before);
    expect((await harness.call({ op: "view" })).content[0].text).toContain("[>] draft-changelog");
    expect(harness.renderPinned(60)!.join("\n")).not.toContain("[x] draft-changelog");
  });

  it("keeps a lookup miss a plain failure when no label is known", async () => {
    const cwd = await tempDir();
    const harness = registerHarness(cwd);
    await expect(harness.call({ op: "done", task: "missing" }))
      .rejects.toThrowError(new TodoError("unknown task: missing"));
  });
});

/** Branch, tree, resume, and fork transitions keep one session's plan private. */
describe("todo session transition lifecycle", () => {
  const forkId = "9c1f4b7a-2d3e-4f50-8a91-b2c3d4e5f607";

  it("restores on resume but never inherits a forked parent's plan", async () => {
    const cwd = await tempDir();
    const parent = registerHarness(cwd);
    await parent.call(PLAN);
    const parentState = await fs.readFile(path.join(planDir(cwd), "todo.json"), "utf8");

    const forked = registerHarness(cwd, forkId);
    await forked.handlers.get("session_start")!({
      type: "session_start",
      reason: "fork",
      previousSessionFile: nativeContext(cwd).sessionManager.getSessionFile(),
    }, forked.ctx);
    expect((await forked.call({ op: "view" })).details.state.phases).toEqual([]);
    expect(forked.renderPinned()).toBeUndefined();
    expect(await guidance(forked)).toBeUndefined();
    await expect(fs.access(planDir(cwd, forkId))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(planDir(cwd), "todo.json"), "utf8")).toBe(parentState);

    await parent.handlers.get("session_start")!({ type: "session_start", reason: "resume" }, parent.ctx);
    expect(parent.renderPinned(60)!.join("\n")).toContain("draft-changelog");
    expect((await guidance(parent)).systemPrompt).toContain("## Active todo plan");
  });

  it("re-publishes the current plan after tree navigation and never on a foreign context", async () => {
    const cwd = await tempDir();
    const harness = registerHarness(cwd);
    await harness.call(PLAN);
    const statePath = path.join(planDir(cwd), "todo.json");
    const before = await fs.readFile(statePath, "utf8");

    setPinnedPanel(harness.ctx as unknown as ExtensionContext, "todo", undefined);
    expect(harness.renderPinned()).toBeUndefined();

    await harness.handlers.get("session_tree")!({ newLeafId: "leaf", oldLeafId: "older" }, harness.ctx);
    expect(harness.renderPinned(60)!.join("\n")).toContain("draft-changelog");
    expect(await fs.readFile(statePath, "utf8")).toBe(before);
    expect(await fs.readdir(planDir(cwd))).toEqual(["TODO.md", "todo.json"]);

    setPinnedPanel(harness.ctx as unknown as ExtensionContext, "todo", undefined);
    const foreign = nativeContext(cwd, forkId);
    await harness.handlers.get("session_tree")!({}, { ...harness.ctx, sessionManager: foreign.sessionManager });
    expect(harness.renderPinned()).toBeUndefined();
    await expect(fs.access(planDir(cwd, forkId))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves cancellable branch and fork transitions untouched", async () => {
    const cwd = await tempDir();
    const harness = registerHarness(cwd);
    await harness.call(PLAN);
    const before = await fs.readFile(path.join(planDir(cwd), "todo.json"), "utf8");

    expect(harness.handlers.has("session_before_tree")).toBe(false);
    expect(harness.handlers.has("session_before_fork")).toBe(false);
    expect(harness.handlers.has("session_before_switch")).toBe(false);
    expect(await fs.readFile(path.join(planDir(cwd), "todo.json"), "utf8")).toBe(before);
    expect(harness.renderPinned(60)!.join("\n")).toContain("draft-changelog");
  });
});

/** A skill only helps if native package discovery actually finds it. */
describe("todo skill packaging", () => {
  it("is discovered through the package skills root", () => {
    const root = fileURLToPath(new URL("../skills", import.meta.url));
    const discovered = loadSkillsFromDir({ dir: root, source: "package" });
    const todo = discovered.skills.find((skill) => skill.name === "todo");
    expect(todo?.filePath).toBe(path.join(root, "todo", "SKILL.md"));
    expect(todo?.description).toMatch(/todo plan/);

    const direct = loadSkillsFromDir({ dir: path.join(root, "todo"), source: "package" });
    expect(direct.diagnostics).toEqual([]);
    expect(direct.skills.map((skill) => skill.name)).toEqual(["todo"]);
  });
});

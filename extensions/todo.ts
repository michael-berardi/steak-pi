import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyOp,
  render,
  TodoError,
  type TodoOp,
  type TodoState,
} from "../src/todo-core.ts";

const STATE_DIR = ".cherry-pi";
const STATE_FILE = "todo.json";
const MARKDOWN_FILE = "TODO.md";

const taskParam = Type.String({ description: "Task content or unique prefix" });
const phaseParam = Type.String({ description: "Phase name" });

const inputSchema = Type.Object({
  op: Type.Union(
    [
      Type.Literal("init"),
      Type.Literal("start"),
      Type.Literal("done"),
      Type.Literal("drop"),
      Type.Literal("block"),
      Type.Literal("unblock"),
      Type.Literal("append"),
      Type.Literal("rm"),
      Type.Literal("view"),
    ],
    { description: "State-changing operation, or view to render the list" },
  ),
  list: Type.Optional(
    Type.Array(
      Type.Object({
        phase: Type.String({ description: "Phase name, in execution order" }),
        items: Type.Array(Type.String({ description: "Task content" })),
      }),
      { description: "init only: full phased plan; replaces the current list" },
    ),
  ),
  task: Type.Optional(taskParam),
  phase: Type.Optional(phaseParam),
  items: Type.Optional(
    Type.Array(Type.String(), { description: "append only: tasks to add" }),
  ),
  reason: Type.Optional(
    Type.String({ description: "block only: why the task is blocked" }),
  ),
});

function loadState(cwd: string): TodoState {
  try {
    const raw = fs.readFileSync(path.join(cwd, STATE_DIR, STATE_FILE), "utf8");
    return JSON.parse(raw) as TodoState;
  } catch {
    return { phases: [] };
  }
}

function persist(cwd: string, state: TodoState, output: string): void {
  const dir = path.join(cwd, STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(dir, MARKDOWN_FILE), `# TODO\n\n${output}\n`);
}

export default function cherryTodoExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Track a phased task list for multi-step work. Ops: init (full phased " +
      "plan), start, done, drop, block, unblock, append, rm, view. The list " +
      "auto-promotes the next pending task and persists in .cherry-pi/.",
    parameters: inputSchema,
    async execute(_toolCallId, params) {
      const op = params as TodoOp;
      const cwd = process.cwd();
      const state = loadState(cwd);
      try {
        const next = applyOp(state, op);
        persist(cwd, next.state, next.output);
        return {
          content: [{ type: "text", text: next.output }],
          details: { state: next.state },
        };
      } catch (error) {
        if (error instanceof TodoError) {
          return {
            content: [{ type: "text", text: `todo: ${error.message}` }],
            details: { state },
          };
        }
        throw error;
      }
    },
  });

  // Render the current list on demand, even without tool calls.
  pi.registerCommand("todo", {
    description: "Render the Cherry Pi todo list",
    handler: async (_args, ctx) => {
      const state = loadState(process.cwd());
      await ctx.ui.notify(render(state), "info");
    },
  });
}

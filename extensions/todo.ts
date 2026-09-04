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

const STATE_DIR = ".steak-pi";
const STATE_FILE = "todo.json";
const MARKDOWN_FILE = "TODO.md";

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
  task: Type.Optional(Type.String({ description: "Task content or unique prefix" })),
  phase: Type.Optional(Type.String({ description: "Phase name" })),
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

export default function steakPieExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Phased task tracker. Use only when the operator asks for explicit " +
      "task tracking. Ops: init|start|done|drop|block|unblock|append|rm|view.",
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
}

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyOp,
  parseCommand,
  render,
  TodoError,
  type TodoOp,
  type TodoState,
} from "../src/todo-core.ts";

const STATE_DIR = ".steak-pi";
const STATE_FILE = "todo.json";
const MARKDOWN_FILE = "TODO.md";

const taskParam = Type.String();
const phaseParam = Type.String();

const inputSchema = Type.Object({
  command: Type.String({
    description:
      "todo command. init Phase: a, b | Build: c -- start/done/drop/block/" +
      "unblock/rm take a task (or phase name for done/drop/rm) -- view " +
      "shows the list. Only for operator-requested task tracking.",
  }),
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
      description: "Phased task tracker (see schema). Tracks operator-requested work only.",
      parameters: inputSchema,
      async execute(_toolCallId, params) {
        const op = parseCommand((params as { command: string }).command);
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

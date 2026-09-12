import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyOp,
  render,
  TodoError,
  type TodoOp,
  type TodoState,
  type TodoStatus,
} from "../src/todo-core.ts";

const STATE_DIR = ".steak-pi";
const STATE_FILE = "todo.json";
const MARKDOWN_FILE = "TODO.md";
const TODO_STATUSES = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "done",
  "blocked",
]);
const mutationQueues = new Map<string, Promise<void>>();

async function withTodoMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  mutationQueues.set(key, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (mutationQueues.get(key) === current) mutationQueues.delete(key);
  }
}

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
    Type.Array(Type.String(), { description: "append: tasks to add; start/done/drop/block/unblock/rm: task names or unique prefixes for an atomic ordered bulk transition" }),
  ),
  reason: Type.Optional(
    Type.String({ description: "block only: why the task is blocked" }),
  ),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateState(value: unknown): TodoState {
  if (!isRecord(value) || !Array.isArray(value.phases)) {
    throw new TodoError("persisted todo state is malformed: phases must be an array");
  }

  for (const [phaseIndex, phase] of value.phases.entries()) {
    if (!isRecord(phase) || typeof phase.name !== "string" || !Array.isArray(phase.items)) {
      throw new TodoError(`persisted todo state is malformed: invalid phase ${phaseIndex + 1}`);
    }
    for (const [itemIndex, item] of phase.items.entries()) {
      const validReason = isRecord(item) &&
        (item.reason === undefined || typeof item.reason === "string");
      if (
        !isRecord(item) ||
        typeof item.content !== "string" ||
        typeof item.status !== "string" ||
        !TODO_STATUSES.has(item.status as TodoStatus) ||
        !validReason
      ) {
        throw new TodoError(
          `persisted todo state is malformed: invalid item ${itemIndex + 1} in phase ${phaseIndex + 1}`,
        );
      }
    }
  }

  return value as unknown as TodoState;
}

async function loadState(cwd: string): Promise<TodoState> {
  const statePath = path.join(cwd, STATE_DIR, STATE_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { phases: [] };
    throw new TodoError(`cannot read persisted todo state: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TodoError("persisted todo state is malformed: invalid JSON");
  }
  return validateState(parsed);
}

async function stageWrite(target: string, content: string): Promise<string> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  return temporary;
}

async function persist(cwd: string, state: TodoState, output: string): Promise<void> {
  const dir = path.join(cwd, STATE_DIR);
  const statePath = path.join(dir, STATE_FILE);
  const markdownPath = path.join(dir, MARKDOWN_FILE);
  await fs.mkdir(dir, { recursive: true });

  let stateTemp: string | undefined;
  let markdownTemp: string | undefined;
  try {
    stateTemp = await stageWrite(statePath, JSON.stringify(state, null, 2));
    markdownTemp = await stageWrite(markdownPath, `# TODO\n\n${output}\n`);
    await fs.rename(markdownTemp, markdownPath);
    markdownTemp = undefined;
    await fs.rename(stateTemp, statePath);
    stateTemp = undefined;
  } finally {
    await Promise.all([
      stateTemp ? fs.rm(stateTemp, { force: true }) : Promise.resolve(),
      markdownTemp ? fs.rm(markdownTemp, { force: true }) : Promise.resolve(),
    ]);
  }
}

function userVisibleError(error: unknown): TodoError {
  if (error instanceof TodoError) return error;
  return new TodoError(`could not update todo state: ${String(error)}`);
}

export default function steakPieExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Phased task tracker. Use only when the operator asks for explicit " +
      "task tracking. Ops: init|start|done|drop|block|unblock|append|rm|view. For bulk start/done/drop/block/unblock/rm, pass items (task names or unique prefixes), without task or phase; the ordered batch is atomic.",
    parameters: inputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const op = params as TodoOp;
      const statePath = path.join(ctx.cwd, STATE_DIR, STATE_FILE);

      try {
        return await withTodoMutationQueue(statePath, async () => {
          const state = await loadState(ctx.cwd);
          if (op.op === "view") {
            return {
              content: [{ type: "text" as const, text: render(state) }],
              details: { state },
            };
          }

          const next = applyOp(state, op);
          await persist(ctx.cwd, next.state, next.output);
          return {
            content: [{ type: "text" as const, text: next.output }],
            details: { state: next.state },
          };
        });
      } catch (error) {
        throw userVisibleError(error);
      }
    },
  });
}

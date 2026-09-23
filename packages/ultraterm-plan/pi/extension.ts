/**
 * UltraTerm Plan — the Pi-native todo tool and pinned panel.
 *
 * Moved verbatim from Steak Pi's `extensions/todo.ts`. The two pieces that are
 * Steak Pi's own infrastructure — the shared pinned-panel compositor and the
 * session-file canonicalizer — arrive through `PlanExtensionDeps`, so the
 * package has no source dependency on Steak Pi and Steak Pi's wrapper stays a
 * three-liner. Behaviour is identical in both hosts.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applyOp,
  render,
  TodoError,
  type TodoOp,
  type TodoState,
  type TodoStatus,
} from "../src/core.ts";
import { createTodoPanel, hasTodoPlan, hasUnfinishedTodo } from "../src/render.ts";

/** Structural subset of Pi's widget factory, as consumed by the compositor. */
export type PlanPanelFactory = Extract<Parameters<ExtensionContext["ui"]["setWidget"]>[1], (...args: any[]) => any>;

/** Steak Pi pieces the Pi extension needs; the host injects real implementations. */
export interface PlanExtensionDeps {
  setPinnedPanel(ctx: ExtensionContext, id: "todo", factory: PlanPanelFactory | undefined, signature?: string): void;
  canonicalSessionFile(file: string): string;
}

interface TodoOwner {
  ownerSessionId: string;
  ownerSessionFile: string;
  cwd: string;
  dir: string;
}

function captureOwner(ctx: ExtensionContext, deps: PlanExtensionDeps): TodoOwner {
  const ownerSessionId = ctx.sessionManager?.getSessionId();
  const file = ctx.sessionManager?.getSessionFile();
  if (!ownerSessionId?.trim() || !file?.trim()) {
    throw new TodoError("todo requires a native session ID and session file");
  }
  const ownerSessionFile = deps.canonicalSessionFile(file);
  const cwd = path.resolve(ctx.cwd);
  const namespace = createHash("sha256").update(JSON.stringify([ownerSessionFile, ownerSessionId])).digest("hex");
  return { ownerSessionId, ownerSessionFile, cwd, dir: path.join(cwd, STATE_DIR, "todo", namespace) };
}

const STATE_DIR = ".steak-pi";
const STATE_FILE = "todo.json";
const MARKDOWN_FILE = "TODO.md";
const MAX_KNOWN_LABELS = 12;
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

async function loadState(dir: string): Promise<TodoState> {
  const statePath = path.join(dir, STATE_FILE);
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

async function persist(dir: string, state: TodoState, output: string, check: () => void): Promise<void> {
  check();
  const statePath = path.join(dir, STATE_FILE);
  const markdownPath = path.join(dir, MARKDOWN_FILE);
  await fs.mkdir(dir, { recursive: true });

  let stateTemp: string | undefined;
  let markdownTemp: string | undefined;
  try {
    check();
    stateTemp = await stageWrite(statePath, JSON.stringify(state, null, 2));
    check();
    markdownTemp = await stageWrite(markdownPath, `# TODO\n\n${output}\n`);
    check();
    await fs.rename(markdownTemp, markdownPath);
    markdownTemp = undefined;
    check();
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

/** Owner for the context's own session, or undefined when native metadata is absent. */
function ownerOf(ctx: ExtensionContext, deps: PlanExtensionDeps): TodoOwner | undefined {
  try {
    return captureOwner(ctx, deps);
  } catch {
    return undefined;
  }
}

function boundedLabels(labels: string[]): string {
  const shown = labels.slice(0, MAX_KNOWN_LABELS).join(", ");
  return labels.length > MAX_KNOWN_LABELS ? `${shown}, … (${labels.length} total)` : shown;
}

/**
 * Keep the core's reason and add the labels this plan actually contains, so a
 * failed lookup is actionable instead of a dead end. The error stays a failure:
 * nothing is persisted for the rejected operation.
 */
function enrichTodoError(error: unknown, state: TodoState): TodoError {
  const failure = userVisibleError(error);
  const phases = state.phases.map((phase) => phase.name);
  const tasks = [...new Set(state.phases.flatMap((phase) => phase.items.map((item) => item.content)))];
  const isLookupMiss = /^(unknown task|unknown phase|ambiguous task prefix):/.test(failure.message);
  if (!isLookupMiss) return failure;
  const known = failure.message.startsWith("unknown phase:")
    ? phases.length > 0 ? `known phases: ${boundedLabels(phases)}` : undefined
    : tasks.length > 0 ? `known tasks: ${boundedLabels(tasks)}` : undefined;
  return known ? new TodoError(`${failure.message} — ${known}`) : failure;
}

/**
 * Agent-facing maintenance contract, injected only while an unfinished plan
 * exists. It states the recording duties and never the current status, so the
 * prompt cannot fabricate progress: the model still has to read the tool.
 */
const TODO_GUIDANCE = [
  "## Active todo plan",
  "",
  "This session has an unfinished plan tracked by the `todo` tool; its `view` op is the only checklist.",
  "- Before starting an item, record it with `op:\"start\"`.",
  "- Record `op:\"done\"` only after you verified the result yourself; record `op:\"block\"` with a reason when you cannot proceed. Tool activity, edits, and passing tests never mark an item by themselves.",
  "- Do not move to a later phase while an earlier item is unfinished or unrecorded.",
  "- Before your final response, run `op:\"view\"` once and reconcile every item; report unfinished or blocked items as such instead of implying success.",
  "- One update per real state change: do not re-view or re-mark the same step.",
].join("\n");

/** Guidance for the session that owns this context; never another session's plan. */
async function loadGuidance(ctx: ExtensionContext, deps: PlanExtensionDeps): Promise<string | undefined> {
  const owner = ownerOf(ctx, deps);
  if (!owner) return undefined;
  try {
    return hasUnfinishedTodo(await loadState(owner.dir)) ? TODO_GUIDANCE : undefined;
  } catch {
    // Guidance is advisory: a malformed or unreadable plan must not break a turn.
    return undefined;
  }
}

/**
 * Publish (or clear) the pinned todo panel through the shared compositor, which
 * owns widget identity and keeps Subagents → Todo → Composer order. Never call
 * `ui.setWidget` directly for the todo panel. UI observation must never fail a
 * todo operation, and an absent/partial UI context (RPC, print, tests) is fine.
 */
function publishPinnedTodo(ctx: ExtensionContext | undefined, state: TodoState, deps: PlanExtensionDeps): void {
  const ui = ctx?.ui;
  if (!ctx || !ui || typeof ui.setWidget !== "function") return;
  try {
    deps.setPinnedPanel(
      ctx,
      "todo",
      hasTodoPlan(state) ? (_tui, theme) => createTodoPanel(state, theme) : undefined,
      JSON.stringify(state),
    );
  } catch {
    // Pinned rendering is observational; the tool result is the source of truth.
  }
}

function clearPinnedTodo(ctx: ExtensionContext | undefined, deps: PlanExtensionDeps): void {
  const ui = ctx?.ui;
  if (!ctx || !ui || typeof ui.setWidget !== "function") return;
  try {
    deps.setPinnedPanel(ctx, "todo", undefined);
  } catch {
    // The session UI may already be tearing down.
  }
}

export function createPlanExtension(deps: PlanExtensionDeps): (pi: ExtensionAPI) => void {
  return function steakPieExtension(pi: ExtensionAPI): void {
  let epoch = 0;
  let activeDir: string | undefined;
  let closed = false;
  function guard(ctx: ExtensionContext, owner: TodoOwner, capturedEpoch: number): void {
    if (closed || epoch !== capturedEpoch || activeDir !== owner.dir || captureOwner(ctx, deps).dir !== owner.dir) {
      throw new TodoError("todo context no longer owns the active session");
    }
  }

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Phased task tracker. Use only when the operator asks for explicit " +
      "task tracking. Ops: init|start|done|drop|block|unblock|append|rm|view. For bulk start/done/drop/block/unblock/rm, pass items (task names or unique prefixes), without task or phase; the ordered batch is atomic. " +
      "Nothing is marked automatically: record start/done/block yourself, and re-running init with an identical list keeps the recorded progress.",
    parameters: inputSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const op = params as TodoOp;
      try {
        const owner = captureOwner(ctx, deps);
        const capturedEpoch = epoch;
        activeDir ??= owner.dir;
        const check = () => guard(ctx, owner, capturedEpoch);
        const details = (state: TodoState) => ({ state, ownerSessionId: owner.ownerSessionId, ownerSessionFile: owner.ownerSessionFile });
        check();
        const result = await withTodoMutationQueue(path.join(owner.dir, STATE_FILE), async () => {
          check();
          const state = await loadState(owner.dir);
          check();
          if (op.op === "view") {
            publishPinnedTodo(ctx, state, deps);
            check();
            return {
              content: [{ type: "text" as const, text: render(state) }],
              details: details(state),
            };
          }

          let next: { state: TodoState; output: string };
          try {
            next = applyOp(state, op);
          } catch (error) {
            throw enrichTodoError(error, state);
          }
          check();
          await persist(owner.dir, next.state, next.output, check);
          check();
          publishPinnedTodo(ctx, next.state, deps);
          check();
          return {
            content: [{ type: "text" as const, text: next.output }],
            details: details(next.state),
          };
        });
        check();
        return result;
      } catch (error) {
        throw userVisibleError(error);
      }
    },
  });

  // Agent-facing maintenance: state the recording duties while an active plan
  // exists, and stay silent when there is none. Chained systemPrompt mutation
  // only — no extra turns, no messages, no auto-marking.
  pi.on?.("before_agent_start", async (event, ctx) => {
    if (closed) return;
    const guidance = await loadGuidance(ctx, deps);
    if (!guidance) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  // Tree navigation stays inside one session file: re-publish the persisted plan
  // for the current owner instead of clearing it or borrowing another session's
  // plan. Cancellable branch/fork transitions are deliberately left untouched.
  pi.on?.("session_tree", async (_event, ctx) => {
    const capturedEpoch = epoch;
    const owner = ownerOf(ctx, deps);
    if (!owner || closed || epoch !== capturedEpoch || activeDir !== owner.dir) return;
    try {
      const state = await loadState(owner.dir);
      if (closed || epoch !== capturedEpoch || activeDir !== owner.dir) return;
      publishPinnedTodo(ctx, state, deps);
    } catch {
      // A read failure leaves the existing panel alone; the tool result owns truth.
    }
  });

  // Restore the pinned plan for the session that just became active. A missing
  // plan clears the panel; a malformed one must not resurrect a stale plan.
  pi.on?.("session_start", async (_event, ctx) => {
    const capturedEpoch = ++epoch;
    activeDir = undefined;
    closed = false;
    let owner: TodoOwner | undefined;
    try {
      owner = captureOwner(ctx, deps);
      activeDir = owner.dir;
      const state = await loadState(owner.dir);
      guard(ctx, owner, capturedEpoch);
      publishPinnedTodo(ctx, state, deps);
    } catch {
      // An obsolete read must not clear a newer session's panel either.
      if (epoch !== capturedEpoch) return;
      if (owner) {
        try { guard(ctx, owner, capturedEpoch); } catch { return; }
      }
      clearPinnedTodo(ctx, deps);
    }
  });

  // Only committed shutdown invalidates work; before-switch is cancellable.
  const close = (_event: unknown, ctx: ExtensionContext) => {
    if (activeDir) {
      try { if (captureOwner(ctx, deps).dir !== activeDir) return; } catch { return; }
    }
    ++epoch;
    closed = true;
    clearPinnedTodo(ctx, deps);
  };
  pi.on?.("session_shutdown", close);
  };
}

/** Convenience alias for hosts that supply deps at import time. */
export default createPlanExtension;

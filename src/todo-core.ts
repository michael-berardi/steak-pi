/**
 * Cherry Pi todo — pure state machine.
 *
 * Steak Pi task semantics:
 * - Phased list; phases run in order, items within a phase in order.
 * - init with a structurally distinct list replaces everything and promotes the
 *   earliest pending item. init with the exact same plan (same phase names and
 *   task contents, in order) is idempotent: recorded progress, including
 *   finished counts, survives so a repeated plan never erases work.
 * - After any state change: if nothing is in_progress, the earliest pending item
 *   (phase order) auto-promotes. A single start makes exactly one item active; a
 *   bulk start keeps every explicitly named task active and demotes the rest.
 * - blocked items never auto-promote; unblock returns them to pending.
 * - single done/drop/rm accept either a task content (unique prefix match) or a
 *   phase name, with a task match taking precedence over a phase-name fallback.
 *   Bulk transitions resolve task names only and never fall back to completing or
 *   removing a whole phase. Every rejected op leaves the caller's state untouched.
 */

export type TodoStatus = "pending" | "in_progress" | "done" | "blocked";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  reason?: string;
}

export interface TodoPhase {
  name: string;
  items: TodoItem[];
}

export interface TodoState {
  phases: TodoPhase[];
}

export class TodoError extends Error {}

function findItem(state: TodoState, task: string): { phase: TodoPhase; index: number } | null {
  for (const phase of state.phases) {
    const index = phase.items.findIndex((item) => item.content === task);
    if (index >= 0) return { phase, index };
  }
  // Unique prefix match.
  const matches: { phase: TodoPhase; index: number }[] = [];
  for (const phase of state.phases) {
    phase.items.forEach((item, index) => {
      if (item.content.startsWith(task)) matches.push({ phase, index });
    });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new TodoError(`ambiguous task prefix: ${task}`);
  return null;
}

function findPhase(state: TodoState, name: string): TodoPhase | null {
  return state.phases.find((phase) => phase.name === name) ?? null;
}

/** Resolve a task, or fail closed; never falls back to a phase name. */
function resolveTask(state: TodoState, task: string): { phase: TodoPhase; index: number } {
  const hit = findItem(state, task);
  if (!hit) throw new TodoError(`unknown task: ${task}`);
  return hit;
}

/** A non-empty string selector; blank/non-string is absent/ambiguous-to-caller. */
function selector(value: unknown, label: "task" | "phase"): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TodoError(`${label} must be a string`);
  return value.trim() ? value : undefined;
}

/** Auto-promote the earliest pending item when nothing is active. */
function promoteNext(state: TodoState): TodoState {
  const anyInProgress = state.phases.some((phase) =>
    phase.items.some((item) => item.status === "in_progress"),
  );
  if (anyInProgress) return state;
  for (const phase of state.phases) {
    const next = phase.items.find((item) => item.status === "pending");
    if (next) {
      next.status = "in_progress";
      return state;
    }
  }
  return state;
}

function completePhase(phase: TodoPhase): void {
  phase.items.forEach((item) => {
    if (item.status !== "done") item.status = "done";
  });
}

function phaseProgress(phase: TodoPhase): { done: number; total: number } {
  return {
    done: phase.items.filter((item) => item.status === "done").length,
    total: phase.items.length,
  };
}

const STATUS_MARK: Record<TodoStatus, string> = {
  done: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
  blocked: "[!]",
};

export function render(state: TodoState): string {
  const all = state.phases.flatMap((phase) => phase.items);
  const done = all.filter((item) => item.status === "done").length;
  const lines: string[] = [];
  if (all.length === 0) {
    lines.push("Todo list is empty. Use init with a phased list.");
  }
  state.phases.forEach((phase, phaseIndex) => {
    const { done: phaseDone, total } = phaseProgress(phase);
    lines.push(
      `${phaseIndex + 1}. ${phase.name} (${phaseDone}/${total})`,
    );
    for (const item of phase.items) {
      const suffix = item.status === "blocked" && item.reason ? ` — ${item.reason}` : "";
      lines.push(`   ${STATUS_MARK[item.status]} ${item.content}${suffix}`);
    }
  });
  lines.push(`Overall: ${done}/${all.length} done.`);
  return lines.join("\n");
}

export type TodoSingleOp =
  | { op: "init"; list: { phase: string; items: string[] }[] }
  | { op: "start"; task: string }
  | { op: "done"; task?: string; phase?: string }
  | { op: "drop"; task?: string; phase?: string }
  | { op: "block"; task: string; reason?: string }
  | { op: "unblock"; task: string }
  | { op: "append"; phase: string; items: string[] }
  | { op: "rm"; task?: string; phase?: string }
  | { op: "view" };

/** Existing tool schemas already accept items; transitions can reuse that field. */
export type TodoBulkOp = {
  op: "start" | "done" | "drop" | "block" | "unblock" | "rm";
  items: string[];
  reason?: string;
  task?: never;
  phase?: never;
};
export type TodoOp = TodoSingleOp | TodoBulkOp;

const BULK_OPS = new Set<string>(["start", "done", "drop", "block", "unblock", "rm"]);

interface LooseOp {
  op: string;
  list?: unknown;
  items?: unknown;
  task?: unknown;
  phase?: unknown;
  reason?: unknown;
}

export function applyOp(state: TodoState, op: TodoOp): { state: TodoState; output: string } {
  const loose = op as LooseOp;
  if (BULK_OPS.has(loose.op) && loose.items !== undefined) {
    if (!Array.isArray(loose.items) || loose.items.some((item) => typeof item !== "string")) {
      throw new TodoError(`${loose.op} items must be an array of task names`);
    }
    if (loose.reason !== undefined && typeof loose.reason !== "string") {
      throw new TodoError("block reason must be a string");
    }
    const task = selector(loose.task, "task");
    const phase = selector(loose.phase, "phase");
    const items = loose.items as string[];
    if (items.length > 0) {
      if (task !== undefined || phase !== undefined) {
        throw new TodoError(`${loose.op} cannot combine items with task or phase`);
      }
      if (items.some((item) => !item.trim())) {
        throw new TodoError(`${loose.op} items must be non-empty task names`);
      }
      return applyBulkOp(state, { op: loose.op as TodoBulkOp["op"], items, reason: loose.reason });
    }
    if (task === undefined && phase === undefined) {
      throw new TodoError(`${loose.op} requires a non-empty items list or a task/phase`);
    }
    // `items: []` next to a real selector is unambiguous: fall through to the
    // single-op path below instead of guessing.
  }
  return applySingleOp(state, op as TodoSingleOp);
}

/**
 * Ordered, all-or-nothing batch. Mutation happens on a copy so an unknown or
 * ambiguous later target cannot partially apply to the caller's state, and a
 * batch never auto-promotes more than the normal single transition would.
 */
function applyBulkOp(state: TodoState, op: TodoBulkOp): { state: TodoState; output: string } {
  const next = structuredClone(state);
  if (op.op === "start") {
    applyBulkStart(next, op.items);
  } else {
    for (const task of op.items) applyBulkStep(next, op.op, task, op.reason);
  }
  promoteNext(next);
  return { state: next, output: render(next) };
}

/** Explicit batch start: every named task stays active; unrelated actives demote. */
function applyBulkStart(state: TodoState, tasks: string[]): void {
  const targets = tasks.map((task) => resolveTask(state, task));
  const active = new Set(targets.map((hit) => hit.phase.items[hit.index]));
  for (const phase of state.phases) {
    for (const item of phase.items) {
      if (item.status === "in_progress" && !active.has(item)) item.status = "pending";
    }
  }
  for (const item of active) item.status = "in_progress";
}

function applyBulkStep(
  state: TodoState,
  op: TodoBulkOp["op"],
  task: string,
  reason?: string,
): void {
  const hit = resolveTask(state, task);
  const item = hit.phase.items[hit.index];
  switch (op) {
    case "done":
      item.status = "done";
      return;
    case "drop":
    case "rm":
      hit.phase.items.splice(hit.index, 1);
      return;
    case "block":
      item.status = "blocked";
      if (reason) item.reason = reason;
      return;
    case "unblock":
      item.status = "pending";
      delete item.reason;
      return;
    default:
      throw new TodoError("unsupported bulk op");
  }
}

function validateInitList(list: unknown): { phase: string; items: string[] }[] {
  if (!Array.isArray(list) || list.length === 0) {
    throw new TodoError("init requires a non-empty list of phases");
  }
  return list.map((entry, index) => {
    const candidate = entry as { phase?: unknown; items?: unknown } | null;
    const phase = candidate?.phase;
    const items = candidate?.items;
    if (typeof phase !== "string" || !Array.isArray(items) || items.some((item) => typeof item !== "string")) {
      throw new TodoError(`init phase ${index + 1} must have a string name and string items`);
    }
    return { phase, items: items as string[] };
  });
}

/** Structural equality only: same phase names and task contents in order. */
function samePlan(state: TodoState, list: { phase: string; items: string[] }[]): boolean {
  if (state.phases.length !== list.length) return false;
  return state.phases.every((phase, index) => {
    const entry = list[index];
    return entry.phase === phase.name
      && entry.items.length === phase.items.length
      && entry.items.every((content, itemIndex) => content === phase.items[itemIndex].content);
  });
}

function applySingleOp(state: TodoState, op: TodoSingleOp): { state: TodoState; output: string } {
  switch (op.op) {
    case "init": {
      const list = validateInitList(op.list);
      if (samePlan(state, list)) {
        // Repeated identical init is idempotent: finished work stays finished.
        return { state, output: render(state) };
      }
      const phases = list.map((entry) => ({
        name: entry.phase,
        items: entry.items.map((content) => ({ content, status: "pending" as TodoStatus })),
      }));
      const next = promoteNext({ phases });
      return { state: next, output: render(next) };
    }
    case "start": {
      const task = selector(op.task, "task");
      if (!task) throw new TodoError("start requires a task");
      const hit = resolveTask(state, task);
      // An explicit start is the operator's choice: it becomes the single
      // in_progress item regardless of phase order.
      state.phases.forEach((phase) => {
        phase.items.forEach((item, index) => {
          if (item.status === "in_progress" && !(phase === hit.phase && index === hit.index)) {
            item.status = "pending";
          }
        });
      });
      hit.phase.items[hit.index].status = "in_progress";
      return { state, output: render(state) };
    }
    case "done": {
      const task = selector(op.task, "task");
      const phaseName = selector(op.phase, "phase");
      if (task !== undefined && phaseName !== undefined) {
        throw new TodoError("done cannot combine task and phase");
      }
      if (phaseName) {
        const phase = findPhase(state, phaseName);
        if (!phase) throw new TodoError(`unknown phase: ${phaseName}`);
        completePhase(phase);
      } else if (task) {
        const hit = findItem(state, task);
        if (hit) {
          hit.phase.items[hit.index].status = "done";
        } else {
          // Compact interface: a task naming a whole phase completes it.
          const phase = findPhase(state, task);
          if (!phase) throw new TodoError(`unknown task: ${task}`);
          completePhase(phase);
        }
      } else {
        throw new TodoError("done requires task or phase");
      }
      const next = promoteNext(state);
      return { state: next, output: render(next) };
    }
    case "drop":
    case "rm": {
      const task = selector(op.task, "task");
      const phaseName = selector(op.phase, "phase");
      if (task !== undefined && phaseName !== undefined) {
        throw new TodoError(`${op.op} cannot combine task and phase`);
      }
      if (phaseName) {
        const index = state.phases.findIndex((phase) => phase.name === phaseName);
        if (index < 0) throw new TodoError(`unknown phase: ${phaseName}`);
        state.phases.splice(index, 1);
      } else if (task) {
        const hit = findItem(state, task);
        if (hit) {
          hit.phase.items.splice(hit.index, 1);
        } else {
          const phase = findPhase(state, task);
          if (!phase) throw new TodoError(`unknown task: ${task}`);
          state.phases.splice(state.phases.indexOf(phase), 1);
        }
      } else {
        throw new TodoError(`${op.op} requires task or phase`);
      }
      const next = promoteNext(state);
      return { state: next, output: render(next) };
    }
    case "block": {
      const task = selector(op.task, "task");
      if (!task) throw new TodoError("block requires a task");
      const hit = resolveTask(state, task);
      hit.phase.items[hit.index].status = "blocked";
      if (op.reason) hit.phase.items[hit.index].reason = op.reason;
      const next = promoteNext(state);
      return { state: next, output: render(next) };
    }
    case "unblock": {
      const task = selector(op.task, "task");
      if (!task) throw new TodoError("unblock requires a task");
      const hit = resolveTask(state, task);
      hit.phase.items[hit.index].status = "pending";
      delete hit.phase.items[hit.index].reason;
      const next = promoteNext(state);
      return { state: next, output: render(next) };
    }
    case "append": {
      const phase = findPhase(state, op.phase);
      if (!phase) throw new TodoError(`unknown phase: ${op.phase}`);
      for (const content of op.items) {
        phase.items.push({ content, status: "pending" });
      }
      const next = promoteNext(state);
      return { state: next, output: render(next) };
    }
    case "view":
      return { state, output: render(state) };
    default:
      throw new TodoError("unsupported op");
  }
}

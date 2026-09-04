/**
 * Cherry Pi todo — pure state machine.
 *
 * OMP-compatible semantics:
 * - Phased list; phases run in order, items within a phase in order.
 * - init replaces everything and promotes the earliest pending item.
 * - After any state change: if nothing is in_progress, the earliest
 *   pending item (phase order) auto-promotes. If several are in_progress,
 *   only the earliest keeps the flag.
 * - blocked items never auto-promote; unblock returns them to pending.
 * - done/drop/rm accept either a task content (unique prefix match) or a
 *   phase name.
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

/** Keep at most one in_progress; blocked/pending untouched otherwise. */
function normalize(state: TodoState): TodoState {
  const inProgress: { phase: TodoPhase; index: number }[] = [];
  state.phases.forEach((phase) => {
    phase.items.forEach((item, index) => {
      if (item.status === "in_progress") inProgress.push({ phase, index });
    });
  });
  inProgress.slice(1).forEach(({ phase, index }) => {
    phase.items[index].status = "pending";
  });
  return state;
}

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

export type TodoOp =
  | { op: "init"; list: { phase: string; items: string[] }[] }
  | { op: "start"; task: string }
  | { op: "done"; task?: string; phase?: string }
  | { op: "drop"; task?: string; phase?: string }
  | { op: "block"; task: string; reason?: string }
  | { op: "unblock"; task: string }
  | { op: "append"; phase: string; items: string[] }
  | { op: "rm"; task?: string; phase?: string }
  | { op: "view" };

export function applyOp(state: TodoState, op: TodoOp): { state: TodoState; output: string } {
  switch (op.op) {
    case "init": {
      if (!Array.isArray(op.list) || op.list.length === 0) {
        throw new TodoError("init requires a non-empty list of phases");
      }
      const phases = op.list.map((entry) => ({
        name: entry.phase,
        items: entry.items.map((content) => ({ content, status: "pending" as TodoStatus })),
      }));
      const next = promoteNext(normalize({ phases }));
      return { state: next, output: render(next) };
    }
    case "start": {
      const hit = findItem(state, op.task);
      if (!hit) throw new TodoError(`unknown task: ${op.task}`);
      hit.phase.items[hit.index].status = "in_progress";
      // An explicit start is the operator's choice: it becomes the single
      // in_progress item regardless of phase order.
      state.phases.forEach((phase) => {
        phase.items.forEach((item, index) => {
          if (item.status === "in_progress" && !(phase === hit.phase && index === hit.index)) {
            item.status = "pending";
          }
        });
      });
      return { state, output: render(state) };
    }
    case "done": {
      if (op.phase) {
        const phase = findPhase(state, op.phase);
        if (!phase) throw new TodoError(`unknown phase: ${op.phase}`);
        phase.items.forEach((item) => {
          if (item.status !== "done") item.status = "done";
        });
      } else if (op.task) {
        const hit = findItem(state, op.task);
        if (hit) {
          hit.phase.items[hit.index].status = "done";
        } else {
          // Compact interface: a task naming a whole phase completes it.
          const phase = findPhase(state, op.task);
          if (!phase) throw new TodoError(`unknown task: ${op.task}`);
          phase.items.forEach((item) => {
            if (item.status !== "done") item.status = "done";
          });
        }
      } else {
        throw new TodoError("done requires task or phase");
      }
      const next = promoteNext(normalize(state));
      return { state: next, output: render(next) };
    }
    case "drop":
    case "rm": {
      if (op.phase) {
        const index = state.phases.findIndex((phase) => phase.name === op.phase);
        if (index < 0) throw new TodoError(`unknown phase: ${op.phase}`);
        state.phases.splice(index, 1);
      } else if (op.task) {
        const hit = findItem(state, op.task);
        if (hit) {
          hit.phase.items.splice(hit.index, 1);
        } else {
          const phase = findPhase(state, op.task);
          if (!phase) throw new TodoError(`unknown task: ${op.task}`);
          state.phases.splice(state.phases.indexOf(phase), 1);
        }
      } else {
        throw new TodoError(`${op.op} requires task or phase`);
      }
      const next = promoteNext(normalize(state));
      return { state: next, output: render(next) };
    }
    case "block": {
      const hit = findItem(state, op.task);
      if (!hit) throw new TodoError(`unknown task: ${op.task}`);
      hit.phase.items[hit.index].status = "blocked";
      if (op.reason) hit.phase.items[hit.index].reason = op.reason;
      const next = promoteNext(normalize(state));
      return { state: next, output: render(next) };
    }
    case "unblock": {
      const hit = findItem(state, op.task);
      if (!hit) throw new TodoError(`unknown task: ${op.task}`);
      hit.phase.items[hit.index].status = "pending";
      delete hit.phase.items[hit.index].reason;
      const next = promoteNext(normalize(state));
      return { state: next, output: render(next) };
    }
    case "append": {
      const phase = findPhase(state, op.phase);
      if (!phase) throw new TodoError(`unknown phase: ${op.phase}`);
      for (const content of op.items) {
        phase.items.push({ content, status: "pending" });
      }
      const next = promoteNext(normalize(state));
      return { state: next, output: render(next) };
    }
    case "view":
      return { state, output: render(state) };
    default:
      throw new TodoError("unsupported op");
  }
}

/**
 * UltraTerm Plan pinned panel — native Pi TUI component (no HTML, no markdown).
 *
 * Boxed, OMP-inspired rendering for the pinned panel above the composer:
 * a `TODO` header with overall progress, one row per phase with its own
 * `done/total` progress, and task rows reusing the state machine's
 * `[x] [>] [ ] [!]` markers so the panel and the tool result never disagree.
 * The active task is emphasized (accent + bold); completed tasks are struck
 * through when the theme supports it; blocked tasks show their reason.
 *
 * The panel is bounded: only the active phase and a couple of following phases
 * are shown, task windows are anchored on the active task, and a trailing
 * `… n more` summary covers the rest. Narrow widths wrap task content with a
 * hanging indent and truncate fixed rows with an ellipsis, so every returned
 * line fits the viewport width.
 */

import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { TodoItem, TodoPhase, TodoState, TodoStatus } from "./core.ts";

/** Semantic tones the panel paints with; a subset of Pi's theme colors. */
export type TodoTone = "accent" | "muted" | "dim" | "success" | "warning" | "error" | "text";

/**
 * Structural subset of Pi's `Theme`. The widget factory receives the live
 * theme; tests pass a stub, and an absent theme renders plain text.
 */
export interface TodoPanelTheme {
  fg(color: TodoTone, text: string): string;
  bold?(text: string): string;
  strikethrough?(text: string): string;
}

export interface TodoPanelOptions {
  /** Maximum body rows before a `… n more rows` summary (frame rows excluded). */
  maxRows?: number;
}

export interface TodoPanelStats {
  done: number;
  total: number;
  blocked: number;
}

const STATUS_GLYPH: Record<TodoStatus, string> = {
  done: "[x]",
  in_progress: "[>]",
  pending: "[ ]",
  blocked: "[!]",
};

const STATUS_TONE: Record<TodoStatus, TodoTone> = {
  done: "success",
  in_progress: "accent",
  pending: "dim",
  blocked: "warning",
};

const MIN_WIDTH = 6;
const MIN_FRAME_WIDTH = 24;
const NARROW_WIDTH = 40;
const DEFAULT_MAX_ROWS = 14;
const DEFAULT_MAX_ROWS_NARROW = 8;
const TASK_CAP = 6;
const TASK_CAP_NARROW = 3;
const PHASE_CAP = 3;
const PHASE_CAP_NARROW = 2;

/** Strip escape sequences and control characters without collapsing spacing. */
function sanitize(value: string): string {
  return stripTerminalSequences(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
}

/** Sanitize user/tool text into a single trimmed line. */
function oneLine(value: string): string {
  return sanitize(value).replace(/\s+/g, " ").trim();
}

function finiteColumns(columns: number): number {
  return Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 80;
}

function plural(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

/** Keep completed counts visible until the plan is explicitly cleared/replaced. */
export function hasTodoPlan(state: TodoState): boolean {
  return state.phases.some((phase) => phase.items.length > 0);
}

/** Maintenance instructions are needed only while real work remains. */
export function hasUnfinishedTodo(state: TodoState): boolean {
  return state.phases.some((phase) => phase.items.some(item => item.status !== "done"));
}

export function todoPanelStats(state: TodoState): TodoPanelStats {
  const items = state.phases.flatMap((phase) => phase.items);
  return {
    done: items.filter((item) => item.status === "done").length,
    total: items.length,
    blocked: items.filter((item) => item.status === "blocked").length,
  };
}

function phaseProgress(phase: TodoPhase): { done: number; total: number } {
  return {
    done: phase.items.filter((item) => item.status === "done").length,
    total: phase.items.length,
  };
}

/** Phase holding the active task, else the first phase with open work. */
function activePhaseIndex(phases: TodoPhase[]): number {
  const active = phases.findIndex((phase) =>
    phase.items.some((item) => item.status === "in_progress"));
  if (active >= 0) return active;
  const open = phases.findIndex((phase) =>
    phase.items.some((item) => item.status !== "done"));
  if (open >= 0) return open;
  return Math.max(0, phases.length - 1);
}

/** Bounded task window anchored on the active (or first open) task. */
function selectTasks(
  items: TodoItem[],
  cap: number,
): { items: TodoItem[]; hiddenBefore: number; hiddenAfter: number } {
  if (items.length <= cap) return { items, hiddenBefore: 0, hiddenAfter: 0 };
  const active = items.findIndex((item) => item.status === "in_progress");
  const open = items.findIndex((item) => item.status !== "done");
  const anchor = active >= 0 ? active : open >= 0 ? open : items.length - 1;
  const start = Math.max(0, Math.min(items.length - cap, anchor - Math.floor((cap - 1) / 2)));
  return {
    items: items.slice(start, start + cap),
    hiddenBefore: start,
    hiddenAfter: items.length - start - cap,
  };
}

interface Seg {
  text: string;
  tone?: TodoTone;
  bold?: boolean;
  strike?: boolean;
}

interface Row {
  indent: number;
  lead: Seg[];
  body: Seg[];
  /** Task rows wrap with a hanging indent; chrome rows truncate. */
  wrap: boolean;
}

function paint(seg: Seg, theme?: TodoPanelTheme): string {
  let text = sanitize(seg.text);
  if (!text || !theme) return text;
  if (seg.strike && theme.strikethrough) text = theme.strikethrough(text);
  if (seg.tone) text = theme.fg(seg.tone, text);
  if (seg.bold && theme.bold) text = theme.bold(text);
  return text;
}

function paintRow(row: Row, inner: number, theme?: TodoPanelTheme): string[] {
  const lead = row.lead.map((seg) => paint(seg, theme)).join("");
  const body = row.body.map((seg) => paint(seg, theme)).join("");
  const indent = " ".repeat(Math.max(0, row.indent));
  const flat = indent + lead + body;
  if (!row.wrap) {
    return [visibleWidth(flat) > inner ? truncateToWidth(flat, Math.max(1, inner), "…") : flat];
  }
  const leadWidth = visibleWidth(lead);
  const available = inner - row.indent - leadWidth;
  if (available < 2 || !body) {
    return [visibleWidth(flat) > inner ? truncateToWidth(flat, Math.max(1, inner), "…") : flat];
  }
  const hanging = " ".repeat(Math.max(0, row.indent + leadWidth));
  return wrapTextWithAnsi(body, available).map((line, index) =>
    (index === 0 ? indent + lead : hanging) + line);
}

function taskRow(item: TodoItem): Row {
  const active = item.status === "in_progress";
  const tone = STATUS_TONE[item.status];
  const reason = item.status === "blocked" && item.reason
    ? ` — ${oneLine(item.reason)}`
    : "";
  return {
    indent: 2,
    wrap: true,
    lead: [{ text: `${STATUS_GLYPH[item.status]} `, tone, bold: active }],
    body: [{
      text: `${oneLine(item.content) || "Untitled task"}${reason}`,
      tone: active ? "accent" : tone,
      bold: active,
      strike: item.status === "done",
    }],
  };
}

function summaryRow(indent: number, text: string): Row {
  return { indent, wrap: false, lead: [], body: [{ text, tone: "dim" }] };
}

/**
 * Pure layout: boxed panel lines for the given viewport width.
 * Returns `[]` when the plan is empty or the width is unusable.
 */
export function renderTodoPanelLines(
  state: TodoState,
  columns: number,
  theme?: TodoPanelTheme,
  options?: TodoPanelOptions,
): string[] {
  const width = finiteColumns(columns);
  if (!hasTodoPlan(state) || width < MIN_WIDTH) return [];
  const framed = width >= MIN_FRAME_WIDTH;
  const inner = framed ? width - 4 : width;
  if (inner < 4) return [];

  const narrow = width < NARROW_WIDTH;
  const maxRows = Math.max(3, Math.floor(options?.maxRows ?? (narrow ? DEFAULT_MAX_ROWS_NARROW : DEFAULT_MAX_ROWS)));
  const stats = todoPanelStats(state);
  // Keep every phase, including ones whose items were all removed or completed:
  // dropping them would renumber the phases below and hide recorded counts, and
  // the numbering must keep matching the tool text (`render`) exactly.
  const phases = state.phases;
  const activePhase = activePhaseIndex(phases);
  const phaseCap = narrow ? PHASE_CAP_NARROW : PHASE_CAP;
  const taskCap = narrow ? TASK_CAP_NARROW : TASK_CAP;

  const rows: Row[] = [{
    indent: 0,
    wrap: false,
    lead: [],
    body: [
      { text: "TODO", tone: "accent", bold: true },
      { text: ` ${stats.done}/${stats.total} done`, tone: "dim" },
      ...(stats.blocked ? [{ text: ` · ${stats.blocked} blocked`, tone: "warning" as TodoTone }] : []),
    ],
  }];

  const start = activePhase;
  if (start > 0) rows.push(summaryRow(0, `… ${plural(start, "earlier phase")}`));
  const visiblePhases = phases.slice(start, start + phaseCap);
  const hiddenPhases = phases.length - start - visiblePhases.length;

  visiblePhases.forEach((phase, offset) => {
    const index = start + offset;
    const isActive = index === activePhase;
    const progress = phaseProgress(phase);
    rows.push({
      indent: 0,
      wrap: false,
      lead: [],
      body: [
        { text: `${index + 1}. `, tone: "dim" },
        { text: oneLine(phase.name) || "Unnamed phase", tone: isActive ? "accent" : "muted", bold: isActive },
        { text: ` · ${progress.done}/${progress.total}`, tone: "dim" },
      ],
    });
    const selection = selectTasks(phase.items, taskCap);
    if (selection.hiddenBefore > 0) {
      rows.push(summaryRow(2, `… ${plural(selection.hiddenBefore, "earlier task")}`));
    }
    for (const item of selection.items) rows.push(taskRow(item));
    if (selection.hiddenAfter > 0) {
      rows.push(summaryRow(2, `… ${plural(selection.hiddenAfter, "more task")}`));
    }
  });

  if (hiddenPhases > 0) rows.push(summaryRow(0, `… ${plural(hiddenPhases, "more phase")}`));

  const body: string[] = [];
  for (const row of rows) body.push(...paintRow(row, inner, theme));
  if (body.length > maxRows) {
    const hidden = body.length - (maxRows - 1);
    body.length = maxRows - 1;
    body.push(paint({ text: `… ${plural(hidden, "more row")}`, tone: "dim" }, theme));
  }

  if (!framed) return body.map((line) => truncateToWidth(line, inner, "…"));
  const border = (text: string) => (theme ? theme.fg("dim", text) : text);
  const horizontal = "─".repeat(Math.max(0, width - 2));
  const pad = (line: string) => {
    const fitted = truncateToWidth(line, inner, "…");
    return fitted + " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
  };
  return [
    border(`╭${horizontal}╮`),
    ...body.map((line) => border("│ ") + pad(line) + border(" │")),
    border(`╰${horizontal}╯`),
  ];
}

/** Native widget for the shared pinned-panel compositor. */
export function createTodoPanel(
  state: TodoState,
  theme?: TodoPanelTheme,
  options?: TodoPanelOptions,
): Component {
  return {
    invalidate(): void {},
    render(columns: number): string[] {
      return renderTodoPanelLines(state, columns, theme, options);
    },
  };
}

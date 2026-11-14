import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

// Use Pi's own Unicode/terminal primitives; never interpret worker-authored escapes.
export function sanitize(value: unknown): string {
  return typeof value === "string" ? stripTerminalSequences(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim() : "";
}
export const width = visibleWidth;
export function truncate(text: string, columns: number): string {
  return columns > 0 ? stripTerminalSequences(truncateToWidth(sanitize(text), Math.floor(columns), "…")) : "";
}
type Tone = "accent" | "muted" | "dim" | "success" | "warning" | "error" | "text";
/** A task row: glyph + name on the left, the model in a quieter tone after it, status and elapsed time on the right. */
type TaskCells = { icon: string; name: string; meta?: string; metaShort?: string; iconTone?: Tone; nameTone?: Tone };
type Row = { text: string; right?: string; tone?: Tone; rightTone?: Tone; cells?: TaskCells };
/** Narrowest task name (columns) that is worth keeping next to the model; below this the model is dropped first. */
const MIN_NAME = 12;
/** A model label never takes more than this many columns. */
const MAX_META = 24;
type RecordLike = Record<string, unknown>;
const record = (value: unknown): RecordLike => value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : {};
const array = (value: unknown, max = 8): unknown[] => Array.isArray(value) ? value.slice(0, max) : [];
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
/** "1 error" / "2 errors" – avoids the "1 errors" phrasing. */
function counted(total: number, singular: string, plural = `${singular}s`): string {
  return `${total} ${total === 1 ? singular : plural}`;
}
/** Single humanized state wording shared by group counts and per-task labels. */
function stateLabel(value: unknown): string {
  const state = sanitize(value).toLowerCase();
  return state ? state.replace(/_/g, " ") : "unknown";
}
const terminal = new Set(["done", "failed", "aborted", "cancelled", "timed_out", "interrupted"]);
const problem = new Set(["failed", "aborted", "cancelled", "timed_out", "interrupted"]);
function duration(start: unknown, end: unknown = Date.now()): string {
  if (typeof start !== "number" || !Number.isFinite(start)) return "";
  const seconds = Math.max(0, Math.floor((count(end) - start) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}
function stateStyle(state: string): Pick<Row, "tone"> & { icon: string } {
  return state === "done" ? { icon: "✓", tone: "success" }
    : problem.has(state) ? { icon: "!", tone: state === "failed" ? "error" : "warning" }
    : state === "queued" ? { icon: "○", tone: "muted" }
    : { icon: "·", tone: "accent" };
}
/** Registry route -> the part that identifies the model: harness/provider prefixes, a vendor prefix and a date suffix are trimmed. */
export function modelLabel(route: unknown): string {
  const raw = sanitize(route).replace(/\s*\(.*\)\s*$/, "");
  const last = raw.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/^claude-/i, "").replace(/-\d{8}$/, "");
}
/** The route this task actually runs on: a review fallback or the last fallback hop beats the run's own route. */
function taskRoute(task: RecordLike, run: RecordLike): string {
  const review = record(task.reviewFallback).to;
  if (typeof review === "string" && review) return review;
  const hops = array(task.routeFallbacks, 8).filter((hop): hop is string => typeof hop === "string" && hop.includes("->"));
  const hop = hops.at(-1);
  if (hop) return hop.slice(hop.lastIndexOf("->") + 2);
  const selected = record(run.selection).modelId;
  return typeof task.route === "string" && task.route ? task.route : typeof selected === "string" && selected ? selected : sanitize(run.model);
}
/** `model` plus, only when it is not the default medium, the thinking level; the short form is the model alone. */
function modelMeta(task: RecordLike, run: RecordLike): Pick<TaskCells, "meta" | "metaShort"> {
  const label = modelLabel(taskRoute(task, run));
  if (!label) return {};
  const level = sanitize(run.thinkingLevel).toLowerCase();
  const short = truncate(label, MAX_META);
  return { metaShort: short, meta: level && level !== "medium" ? truncate(`${label} ${level}`, MAX_META + 8) : short };
}
function taskRow(task: RecordLike, run: RecordLike, observedAt: number, fallbackName = "Unnamed task"): Row {
  const state = sanitize(task.state) || "unknown";
  const mark = stateStyle(state);
  const elapsed = duration(task.startedAt, task.endedAt ?? observedAt);
  return { text: "", tone: mark.tone, rightTone: mark.tone,
    right: `${stateLabel(state)}${elapsed ? ` · ${elapsed}` : ""}`,
    cells: { icon: mark.icon, name: sanitize(task.label) || fallbackName, ...modelMeta(task, run), iconTone: mark.tone, nameTone: mark.tone === "error" || mark.tone === "warning" ? mark.tone : "text" } };
}
/** Fit icon, name and model into `available` columns without wrapping: thinking level first, then the name's tail, then the model. */
function fitCells(cells: TaskCells, available: number): { icon: string; name: string; meta: string } {
  const icon = cells.icon, lead = visibleWidth(icon) + 1;
  const room = Math.max(0, available - lead);
  const name = cells.name;
  const nameWidth = visibleWidth(name);
  for (const meta of [cells.meta, cells.metaShort]) {
    if (!meta) continue;
    const metaWidth = visibleWidth(meta);
    const nameRoom = room - metaWidth - 2;
    if (nameRoom >= Math.min(nameWidth, MIN_NAME)) return { icon, name: nameWidth <= nameRoom ? name : truncate(name, nameRoom), meta };
  }
  return { icon, name: nameWidth <= room ? name : truncate(name, room), meta: "" };
}
function component(build: (columns: number) => Row[], theme?: Theme): Component {
  return { invalidate() {}, render(columns) {
    const size = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 80;
    const rows = build(size).slice(0, 160);
    if (!rows.length) return [];
    const framed = size >= 24;
    const inner = Math.max(0, size - (framed ? 4 : 0));
    const paint = (tone: Tone | undefined, text: string) => {
      if (!theme || !tone) return text;
      const colored = theme.fg(tone, text);
      return (tone === "error" || tone === "warning") && theme.bold ? theme.bold(colored) : colored;
    };
    const border = (text: string) => paint(rows[0].tone === "error" ? "error" : "dim", text);
    const body = rows.map(({ text, right, tone, rightTone, cells }) => {
      const rhs = right ? truncate(right, Math.floor(inner / 2)) : "";
      const available = Math.max(0, inner - (rhs ? visibleWidth(rhs) + 2 : 0));
      const wrap = (line: string) => framed ? border("│ ") + line + border(" │") : line;
      if (cells && available < visibleWidth(cells.icon) + 2) return wrap(paint(cells.iconTone ?? tone, truncate(`${cells.icon} ${cells.name}`, inner).padEnd(inner)) );
      if (cells) {
        const fit = fitCells(cells, available);
        const used = visibleWidth(fit.icon) + 1 + visibleWidth(fit.name) + (fit.meta ? 2 + visibleWidth(fit.meta) : 0);
        const gap = " ".repeat(Math.max(0, inner - used - visibleWidth(rhs)));
        const styled = paint(cells.iconTone ?? tone, fit.icon) + " " + paint(cells.nameTone ?? tone, fit.name)
          + (fit.meta ? "  " + paint("muted", fit.meta) : "") + gap + (rhs ? paint(rightTone ?? tone, rhs) : "");
        return wrap(styled);
      }
      const indent = Math.min(8, available, text.match(/^ */)?.[0].length ?? 0);
      const left = " ".repeat(indent) + truncate(text, available - indent);
      const line = rhs ? left + " ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(rhs))) + rhs : left;
      const padded = line + " ".repeat(Math.max(0, inner - visibleWidth(line)));
      return framed ? border("│ ") + paint(tone, padded) + border(" │") : paint(tone, line);
    });
    return framed ? [border("╭" + "─".repeat(size - 2) + "╮"), ...body, border("╰" + "─".repeat(size - 2) + "╯")] : body;
  } };
}
function summary(tasks: RecordLike[]): string {
  const counts = new Map<string, number>();
  for (const task of tasks) { const state = stateLabel(task.state); counts.set(state, (counts.get(state) ?? 0) + 1); }
  return [...counts].map(([state, total]) => `${total} ${state}`).join(" · ") || "0 tasks";
}
function runRows(raw: unknown, expanded: boolean, observedAt: number): Row[] {
  const run = record(raw);
  const tasks = array(run.tasks).map(record);
  const style = stateStyle(sanitize(run.state));
  const rows: Row[] = [{ text: `${style.icon} Subagents · ${summary(tasks)}`, tone: style.tone }];
  if (expanded) {
    if (run.goal) rows.push({ text: sanitize(run.goal), tone: "muted" });
    rows.push({ text: `${sanitize(run.runId ?? run.id)} · ${sanitize(run.model)}`, tone: "muted" });
  }
  tasks.forEach((task, index) => {
    // Expanded child blocks get a blank separator so consecutive workers do not run together.
    if (expanded && index > 0) rows.push({ text: "" });
    rows.push(taskRow(task, run, observedAt));
    if (task.error) rows.push({ text: `  ${sanitize(task.error)}`, tone: "error" });
    if (!expanded) return;
    const successes = count(task.toolSuccesses), failures = count(task.toolErrors);
    const stats = `turns ${count(task.turns)} · ${counted(successes, "tool")} succeeded · ${counted(failures, "error")}`;
    // "  · " marks the stats line; report body is indented one level deeper so headings and
    // wrapped output stay distinguishable while the row set still reads compactly.
    rows.push({ text: `  · ${stats}${task.currentTool ? ` · tool ${sanitize(task.currentTool)}` : ""}`, tone: "muted" });
    const lines = typeof task.output === "string" && task.output.trim() ? task.output.split(/\r?\n/) : [];
    for (const line of lines.slice(0, 12)) rows.push({ text: `    ${sanitize(line)}` });
    if (lines.length > 12 || task.truncated) rows.push({ text: "    … report shortened; inspect hub status for retained output", tone: "muted" });
  });
  rows.push({ text: expanded ? "Ctrl+O · collapse task details" : "Ctrl+O · expand task details", tone: "accent" });
  return rows;
}

/** The slice of Pi's ToolRenderContext these renderers read. Pi hands the error flag to renderers only here:
 * the result envelope it passes is `{ content, details }`, without `isError`. */
type RenderContext = {
  state: { usapHasResult?: boolean };
  /** The tool result is an error (the call was refused or threw). */
  isError?: boolean;
  /** The model has finished streaming the call's arguments. */
  argsComplete?: boolean;
  /** The tool has started executing, which implies complete arguments. */
  executionStarted?: boolean;
};
export function renderSubagentCall(args: unknown, theme?: Theme, context?: RenderContext): Component {
  return component(() => {
    if (context?.state.usapHasResult) return [];
    const params = record(args);
    if (params.action) return [{ text: `Subagents · ${sanitize(params.action)}${params.runId ? ` · ${sanitize(params.runId)}` : ""}`, tone: "accent" }];
    const tasks = array(params.tasks);
    if (tasks.length === 0) {
      // Nothing was dispatched, so never draw an empty-looking "0 assignments" dispatch card. A refused call is
      // spoken for by its result card; arguments still streaming are not wrong yet.
      if (context?.isError) return [];
      if (context?.argsComplete === false && context.executionStarted !== true) return [{ text: "Subagents · preparing…", tone: "muted" }];
      return [{ text: "Subagents · invalid arguments; nothing was dispatched", tone: "error" }];
    }
    return [{ text: `Subagents · ${counted(tasks.length, "assignment")}${params.background ? " · background" : ""}`, tone: "accent" },
      ...(params.goal ? [{ text: sanitize(params.goal), tone: "muted" as const }] : []),
      ...tasks.map((task) => ({ text: `○ ${sanitize(record(task).label) || "Unnamed task"}`, tone: "muted" as const }))];
  }, theme);
}

/** Sole ticking task surface; ticks request paint only, never worker/history updates. */
export function renderSubagentLive(runs: unknown[], theme?: Theme, requestRender?: () => void): Component & { dispose(): void } {
  const timer = requestRender && runs.some(run => array(record(run).tasks, 64).some(task => !terminal.has(sanitize(record(task).state))))
    ? setInterval(requestRender, 1000) : undefined;
  timer?.unref?.();
  const live = component((columns) => {
    // Each row keeps its own run: a mixed-route wave shows every task's own model.
    const tasks = runs.flatMap((run) => array(record(run).tasks, 64).map((task) => ({ task: record(task), run: record(run) })));
    if (!tasks.length) return [];
    const active = tasks.filter(({ task }) => !terminal.has(sanitize(task.state)));
    if (!active.length) return [];
    const settled = tasks.length - active.length;
    const queued = active.filter(({ task }) => task.state === "queued").length;
    const limit = columns < 70 ? 3 : 6;
    const rows: Row[] = [{ text: `Subagents · ${active.length - queued} working${queued ? ` · ${queued} queued` : ""} · ${settled}/${tasks.length} done`, tone: "accent" }];
    for (const { task, run } of active.slice(0, limit)) rows.push(taskRow(task, run, Date.now()));
    if (active.length > limit) rows.push({ text: `+${counted(active.length - limit, "assignment")} · hub status for details`, tone: "muted" });
    return rows;
  }, theme);
  return { ...live, dispose() { if (timer !== undefined) clearInterval(timer); } };
}

// All tool results are historical snapshots, even when their run was still
// running (e.g. a background dispatch or hub status). Do not let unrelated UI
// ticks rewrite those scrollback rows: Pi must clear/replay the whole terminal
// when a changed row is above its viewport. Keep observation time across
// expansion/theme rebuilds of the same details (Pi rewraps the result envelope);
// partial results likewise advance only when actual progress supplies new details.
const observedResults = new WeakMap<object, number>();

export function renderSubagentResult(result: unknown, options?: { expanded?: boolean; isPartial?: boolean }, theme?: Theme, context?: RenderContext): Component {
  if (context) context.state.usapHasResult = true;
  let observedAt = Date.now();
  const details = record(result).details;
  const snapshot = details && typeof details === "object" ? details : result;
  if (snapshot && typeof snapshot === "object") {
    const persistedAt = record(record(details).run).observedAt;
    observedAt = typeof persistedAt === "number" && Number.isFinite(persistedAt) && persistedAt >= 0
      ? persistedAt : observedResults.get(snapshot) ?? observedAt;
    observedResults.set(snapshot, observedAt);
  }
  return component(() => {
    const envelope = record(result), details = record(envelope.details), run = record(details.run);
    const failed = envelope.isError === true || context?.isError === true;
    let rows: Row[] = [];
    if (Array.isArray(run.tasks) && (run.runId || run.id)) rows = runRows(run, Boolean(options?.expanded), observedAt);
    else if (failed) {
      // A refused or thrown call: lead with the verdict (an error first row also tints the border), then the text.
      rows.push({ text: "Subagents · call refused", tone: "error" });
      for (const entry of array(envelope.content, 8)) {
        const text = record(entry).text;
        if (typeof text === "string") for (const line of text.split(/\r?\n/).slice(0, options?.expanded ? 40 : 8)) rows.push({ text: line, tone: "error" });
      }
      if (options?.expanded) rows.push({ text: "Ctrl+O · collapse details", tone: "accent" });
    } else if (Array.isArray(details.runs)) {
      const runs = array(details.runs, 66);
      rows.push({ text: `Subagents · ${counted(runs.length, "run")}`, tone: "accent" });
      for (const entry of runs.slice(0, options?.expanded ? 50 : 8)) {
        const item = record(entry);
        const mark = stateStyle(sanitize(item.state)), label = modelLabel(sanitize(record(item.selection).modelId) || item.model);
        const level = sanitize(item.thinkingLevel).toLowerCase();
        rows.push({ text: "", tone: mark.tone, cells: { icon: mark.icon, name: `${sanitize(item.runId ?? item.id)} · ${summary(array(item.tasks).map(record))}`,
          ...(label ? { metaShort: truncate(label, MAX_META), meta: truncate(level && level !== "medium" ? `${label} ${level}` : label, MAX_META + 8) } : {}),
          iconTone: mark.tone, nameTone: "text" } });
      }
      if (runs.length > (options?.expanded ? 50 : 8)) rows.push({ text: "… expand for more history", tone: "muted" });
      if (options?.expanded) rows.push({ text: "Ctrl+O · collapse run history", tone: "accent" });
    } else {
      for (const entry of array(envelope.content, 8)) {
        const text = record(entry).text;
        if (typeof text === "string") for (const line of text.split(/\r?\n/).slice(0, options?.expanded ? 40 : 8)) rows.push({ text: line });
      }
      if (options?.expanded) rows.push({ text: "Ctrl+O · collapse details", tone: "accent" });
    }
    if (!rows.length) rows.push({ text: "Subagents · no details", tone: "muted" });
    if (options?.isPartial && !failed) rows.push({ text: "Live progress", tone: "muted" });
    return rows;
  }, theme);
}

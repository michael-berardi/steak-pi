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
type Row = { text: string; right?: string; tone?: "accent" | "muted" | "dim" | "success" | "warning" | "error" };
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
function component(build: (columns: number) => Row[], theme?: Theme): Component {
  return { invalidate() {}, render(columns) {
    const size = Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 80;
    const rows = build(size).slice(0, 160);
    if (!rows.length) return [];
    const framed = size >= 24;
    const inner = Math.max(0, size - (framed ? 4 : 0));
    const paint = (tone: Row["tone"], text: string) => {
      if (!theme || !tone) return text;
      const colored = theme.fg(tone, text);
      return (tone === "error" || tone === "warning") && theme.bold ? theme.bold(colored) : colored;
    };
    const border = (text: string) => paint(rows[0].tone === "error" ? "error" : "dim", text);
    const body = rows.map(({ text, right, tone }) => {
      const rhs = right ? truncate(right, Math.floor(inner / 2)) : "";
      const available = Math.max(0, inner - (rhs ? visibleWidth(rhs) + 2 : 0));
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
    const state = sanitize(task.state) || "unknown";
    const mark = stateStyle(state);
    const elapsed = duration(task.startedAt, task.endedAt ?? observedAt);
    const tool = !terminal.has(state) && task.currentTool ? ` · ${sanitize(task.currentTool)}` : "";
    // Expanded child blocks get a blank separator so consecutive workers do not run together.
    if (expanded && index > 0) rows.push({ text: "" });
    rows.push({ text: `${mark.icon} ${sanitize(task.label) || "Unnamed task"}${tool}`, right: `${stateLabel(state)}${elapsed ? ` · ${elapsed}` : ""}`, tone: mark.tone });
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

type RenderContext = { state: { usapHasResult?: boolean } };
export function renderSubagentCall(args: unknown, theme?: Theme, context?: RenderContext): Component {
  return component(() => {
    if (context?.state.usapHasResult) return [];
    const params = record(args);
    if (params.action) return [{ text: `Subagents · ${sanitize(params.action)}${params.runId ? ` · ${sanitize(params.runId)}` : ""}`, tone: "accent" }];
    const tasks = array(params.tasks);
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
    const tasks = runs.flatMap((run) => array(record(run).tasks, 64).map(record));
    if (!tasks.length) return [];
    const active = tasks.filter((task) => !terminal.has(sanitize(task.state)));
    if (!active.length) return [];
    const settled = tasks.length - active.length;
    const queued = active.filter(task => task.state === "queued").length;
    const limit = columns < 70 ? 3 : 6;
    const rows: Row[] = [{ text: `Subagents · ${active.length - queued} working${queued ? ` · ${queued} queued` : ""} · ${settled}/${tasks.length} done`, tone: "accent" }];
    for (const task of active.slice(0, limit)) {
      const state = sanitize(task.state);
      rows.push({ text: `${state === "queued" ? "○" : "·"} ${sanitize(task.label)}`, right: [sanitize(task.currentTool) || stateLabel(state), duration(task.startedAt)].filter(Boolean).join(" · "), tone: "muted" });
    }
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
    let rows: Row[] = [];
    if (Array.isArray(run.tasks) && (run.runId || run.id)) rows = runRows(run, Boolean(options?.expanded), observedAt);
    else if (Array.isArray(details.runs)) {
      const runs = array(details.runs, 66);
      rows.push({ text: `Subagents · ${counted(runs.length, "run")}`, tone: "accent" });
      for (const entry of runs.slice(0, options?.expanded ? 50 : 8)) {
        const item = record(entry);
        rows.push({ text: `${sanitize(item.runId ?? item.id)} · ${summary(array(item.tasks).map(record))}`, tone: stateStyle(sanitize(item.state)).tone });
      }
      if (runs.length > (options?.expanded ? 50 : 8)) rows.push({ text: "… expand for more history", tone: "muted" });
      if (options?.expanded) rows.push({ text: "Ctrl+O · collapse run history", tone: "accent" });
    } else {
      for (const entry of array(envelope.content, 8)) {
        const text = record(entry).text;
        if (typeof text === "string") for (const line of text.split(/\r?\n/).slice(0, options?.expanded ? 40 : 8)) rows.push({ text: line, tone: envelope.isError ? "error" : undefined });
      }
      if (options?.expanded) rows.push({ text: "Ctrl+O · collapse details", tone: "accent" });
    }
    if (!rows.length) rows.push({ text: "Subagents · no details", tone: "muted" });
    if (options?.isPartial) rows.push({ text: "Live progress", tone: "muted" });
    return rows;
  }, theme);
}

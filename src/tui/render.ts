import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  displayWidth,
  fitSides,
  formatTokens,
  oneLine,
  shortModel,
  truncatePlain,
} from "./format.ts";
import { statusPresentation, type CompanionState, type StatusTone } from "./model.ts";

export interface SemanticPalette {
  accent(text: string): string;
  text(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  bold(text: string): string;
}

export const plainPalette: SemanticPalette = {
  accent: (text) => text,
  text: (text) => text,
  muted: (text) => text,
  dim: (text) => text,
  success: (text) => text,
  warning: (text) => text,
  error: (text) => text,
  bold: (text) => text,
};

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ContextSnapshot {
  percent: number | null;
  contextWindow: number;
}

export interface FooterSnapshot {
  state: CompanionState;
  cwd: string;
  home?: string;
  branch?: string;
  sessionName?: string;
  model?: unknown;
  provider?: string;
  thinking?: string;
  usage: UsageTotals;
  context?: ContextSnapshot;
  extensionStatuses?: readonly string[];
}

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function addUsage(total: UsageTotals, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const value = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: { total?: unknown } | unknown;
  };
  total.input += finite(value.input);
  total.output += finite(value.output);
  total.cacheRead += finite(value.cacheRead);
  total.cacheWrite += finite(value.cacheWrite);
  total.cost += finite(
    typeof value.cost === "object" && value.cost !== null
      ? (value.cost as { total?: unknown }).total
      : value.cost,
  );
}

/** Collect only usage already persisted by Pi. No hooks, polling, or provider interception. */
export function collectUsage(entries: readonly unknown[]): UsageTotals {
  const total = emptyUsage();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as {
      type?: unknown;
      message?: { role?: unknown; usage?: unknown };
      usage?: unknown;
    };
    if (item.type === "message") {
      if (item.message?.role === "assistant" || item.message?.role === "toolResult") {
        addUsage(total, item.message.usage);
      }
    } else if (item.type === "compaction" || item.type === "branch_summary") {
      addUsage(total, item.usage);
    }
  }
  return total;
}

function paintSides(
  left: string,
  right: string,
  width: number,
  palette: SemanticPalette,
  paintLeft: (text: string) => string,
  paintRight: (text: string) => string,
): string {
  const fitted = fitSides(left, right, width);
  return paintLeft(fitted.left) + fitted.gap + paintRight(fitted.right);
}

export function renderCompanionHeader(width: number, palette: SemanticPalette): string[] {
  const safeWidth = Math.max(1, width);
  // Keep the emoji gutter outside plain-text normalization, which collapses spaces.
  const prefix = "🥩  ";
  const prefixWidth = displayWidth(prefix);
  if (safeWidth <= prefixWidth) {
    return [palette.bold(palette.accent(truncateToWidth(prefix, safeWidth, "")))];
  }
  const brand = "STEAK PI";
  const contentWidth = safeWidth - prefixWidth;
  const paintedPrefix = palette.bold(palette.accent(prefix));
  const hints = safeWidth >= 64
    ? "/ commands · /model · /resume"
    : safeWidth >= 40
      ? "/ · /model · /resume"
      : "";
  if (!hints) {
    return [paintedPrefix + palette.bold(palette.accent(truncatePlain(brand, contentWidth)))];
  }
  return [
    paintedPrefix + paintSides(
      brand,
      hints,
      contentWidth,
      palette,
      (text) => palette.bold(palette.accent(text)),
      (text) => palette.muted(text),
    ),
  ];
}

function tonePainter(palette: SemanticPalette, tone: StatusTone): (text: string) => string {
  switch (tone) {
    case "accent": return palette.accent;
    case "success": return palette.success;
    case "warning": return palette.warning;
    case "error": return palette.error;
    case "dim": return palette.dim;
  }
}

interface ComposerSegment {
  text: string;
  paint: (text: string) => string;
}

function contextPercent(snapshot: FooterSnapshot): number | null {
  const percent = snapshot.context?.percent;
  return typeof percent === "number" && Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : null;
}

function contextPainter(
  snapshot: FooterSnapshot,
  palette: SemanticPalette,
): (text: string) => string {
  const percent = contextPercent(snapshot);
  if (percent !== null && percent >= 90) return palette.error;
  if (percent !== null && percent >= 70) return palette.warning;
  return palette.accent;
}

export function usageSummary(snapshot: FooterSnapshot, width: number): string {
  const parts: string[] = [];
  const context = snapshot.context;
  if (context) {
    const percent = contextPercent(snapshot);
    parts.push(
      `◫ ${percent === null ? "?" : `${percent.toFixed(0)}%`}/${formatTokens(context.contextWindow)}`,
    );
  }

  const total = snapshot.usage.input + snapshot.usage.output + snapshot.usage.cacheRead + snapshot.usage.cacheWrite;
  if (width >= 88 && total > 0) parts.push(`${formatTokens(total)} tok`);

  const prompt = snapshot.usage.input + snapshot.usage.cacheRead + snapshot.usage.cacheWrite;
  if (width >= 120 && prompt > 0 && (snapshot.usage.cacheRead > 0 || snapshot.usage.cacheWrite > 0)) {
    parts.push(`${((snapshot.usage.cacheRead / prompt) * 100).toFixed(0)}% cache`);
  }
  if (width >= 64 && snapshot.usage.cost > 0) parts.push(`$${snapshot.usage.cost.toFixed(3)}`);
  return parts.join(" · ") || "◫ —";
}

function renderContextMeter(
  width: number,
  snapshot: FooterSnapshot,
  palette: SemanticPalette,
): string {
  if (width <= 0) return "";
  const percent = contextPercent(snapshot);
  const used = percent === null || percent <= 0
    ? 0
    : percent >= 100
      ? width
      : Math.max(1, Math.ceil((width * percent) / 100));
  return contextPainter(snapshot, palette)("━".repeat(used)) + palette.dim("─".repeat(width - used));
}

function segmentWidth(segments: readonly ComposerSegment[]): number {
  return displayWidth(segments.map(({ text }) => text).join(""));
}

function paintSegments(segments: readonly ComposerSegment[]): string {
  return segments.map(({ text, paint }) => paint(text)).join("");
}

function scientific(value: number, precision = 2): string {
  return value.toExponential(precision).replace(/\.?0+e/, "e").replace("e+", "e");
}

/** Bounded numeric atoms: large persisted totals must not crowd out other metrics. */
function composerTokens(value: number): string {
  const count = finite(value);
  for (const [scale, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]] as const) {
    if (count >= 1e15) return scientific(count);
    if (count >= scale) return `${Number((count / scale).toPrecision(3))}${suffix}`;
  }
  return String(Math.round(count));
}

function totalTokens(usage: UsageTotals): string {
  const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].map(finite);
  const sum = values.reduce((total, value) => total + value, 0);
  if (Number.isFinite(sum)) return composerTokens(sum);
  // Scaling first preserves a meaningful total even if several finite counters overflow a sum.
  const [mantissa, exponent] = scientific(values.reduce((total, value) => total + value / 1e6, 0)).split("e");
  return `${mantissa}e${Number(exponent) + 6}`;
}

function composerMetrics(
  snapshot: FooterSnapshot,
  palette: SemanticPalette,
  density: "full" | "compact" | "tight",
): ComposerSegment[] {
  const compact = density !== "full";
  const tight = density === "tight";
  const percent = contextPercent(snapshot);
  const context = snapshot.context
    ? `${percent === null ? "?" : `${percent.toFixed(0)}%`}/${composerTokens(snapshot.context.contextWindow)}`
    : "—";
  const metrics: ComposerSegment[] = [
    { text: `◫${compact ? "" : " "}${context}`, paint: contextPainter(snapshot, palette) },
    { text: `${totalTokens(snapshot.usage)}${tight ? "t" : " tok"}`, paint: palette.muted },
  ];
  const input = finite(snapshot.usage.input);
  const read = finite(snapshot.usage.cacheRead);
  const write = finite(snapshot.usage.cacheWrite);
  const scale = Math.max(input, read, write);
  // No prompt is not a zero-percent cache hit. Scale before summing to avoid overflow.
  if (scale > 0 && (read > 0 || write > 0)) {
    const ratio = Math.round(100 * (read / scale) / (input / scale + read / scale + write / scale));
    metrics.push({ text: tight ? `c${ratio}%` : `${ratio}% cache`, paint: palette.muted });
  }
  const cost = finite(snapshot.usage.cost);
  const dollars = cost >= (tight ? 1e4 : 1e6) || (cost > 0 && cost < 0.0005)
    ? scientific(cost, tight ? 1 : 2)
    : cost.toFixed(3);
  metrics.push({ text: `$${dollars}`, paint: palette.muted });
  return metrics;
}

function joinSegments(
  segments: readonly ComposerSegment[],
  separator: string,
  palette: SemanticPalette,
): ComposerSegment[] {
  return segments.flatMap((segment, index) => index
    ? [{ text: separator, paint: palette.muted }, segment]
    : [segment]);
}

function composerIdentity(
  width: number,
  snapshot: FooterSnapshot,
  palette: SemanticPalette,
): ComposerSegment[] {
  const status = statusPresentation(snapshot.state);
  const paintStatus = tonePainter(palette, status.tone);
  const statusText = oneLine(status.text);
  if (width < 14) return [{ text: truncatePlain(statusText, width), paint: paintStatus }];

  const thinking = oneLine(snapshot.thinking);
  const reasoning = thinking && thinking !== "off" ? thinking : "";
  const full = [
    { text: "◆ ", paint: palette.accent },
    { text: shortModel(snapshot.model), paint: palette.text },
    ...(reasoning ? [
      { text: " · ", paint: palette.muted },
      { text: reasoning, paint: palette.text },
    ] : []),
    { text: " · ", paint: palette.muted },
    { text: statusText, paint: paintStatus },
  ];
  if (segmentWidth(full) <= width) return full;

  // Keep reasoning separate from the model so a long model cannot swallow it.
  const statusBudget = Math.min(displayWidth(statusText), Math.max(4, Math.floor(width * 0.45)));
  const thinkingText = reasoning ? truncatePlain(reasoning, Math.max(1, Math.floor(width / 5))) : "";
  const separator = width >= 40 ? " · " : " ";
  const modelBudget = width - statusBudget - displayWidth(separator)
    - (thinkingText ? displayWidth(thinkingText) + 1 : 0);
  return [
    { text: truncatePlain(shortModel(snapshot.model), modelBudget), paint: palette.text },
    ...(thinkingText ? [{ text: ` ${thinkingText}`, paint: palette.text }] : []),
    { text: separator, paint: palette.muted },
    { text: truncatePlain(statusText, statusBudget), paint: paintStatus },
  ];
}

/** Fill `spare` columns between two regions: " ━━━─── " when roomy, else a separator. */
function meterGap(spare: number, snapshot: FooterSnapshot, palette: SemanticPalette): string {
  if (spare >= 6) return ` ${renderContextMeter(spare - 2, snapshot, palette)} `;
  const sep = spare >= 3 ? " · " : " ";
  return palette.muted(sep) + " ".repeat(spare - sep.length);
}

/** Metadata is indivisible; decoration is admitted only after all useful data fits. */
export function renderComposerBands(
  width: number,
  snapshot: FooterSnapshot,
  palette: SemanticPalette,
): string[] {
  const safeWidth = Math.max(1, Math.floor(Number.isFinite(width) ? width : 1));
  const identity = composerIdentity(safeWidth, snapshot, palette);
  const fullMetrics = joinSegments(composerMetrics(snapshot, palette, "full"), " · ", palette);
  const spare = safeWidth - segmentWidth(identity) - segmentWidth(fullMetrics);
  if (spare >= 1) {
    // The meter stretches across the free space so the stats sit flush right.
    // Decoration is admitted only after every metric fits.
    return [palette.bold(paintSegments(identity)) + meterGap(spare, snapshot, palette) + paintSegments(fullMetrics)];
  }

  for (const density of ["full", "compact", "tight"] as const) {
    const metrics = joinSegments(composerMetrics(snapshot, palette, density), density === "full" ? " · " : " ", palette);
    const room = safeWidth - segmentWidth(metrics);
    if (room >= 0) {
      // Second row: pressure meter on the left, stats flush right.
      return [palette.bold(paintSegments(identity)), (room >= 6 ? meterGap(room, snapshot, palette) : "") + paintSegments(metrics)];
    }
  }

  // Genuinely tiny panes get at most two metadata rows. Omit an atom that cannot
  // fit rather than slicing a numeric value or leaving a misleading currency prefix.
  const maxRows = safeWidth < 40 ? 2 : 1;
  const rows: ComposerSegment[][] = [[]];
  for (const metric of composerMetrics(snapshot, palette, "tight")) {
    if (displayWidth(metric.text) > safeWidth) continue;
    let row = rows[rows.length - 1]!;
    if (segmentWidth(row) + (row.length ? 1 : 0) + displayWidth(metric.text) > safeWidth) {
      if (rows.length >= maxRows) continue;
      rows.push([]);
      row = rows[rows.length - 1]!;
    }
    if (row.length) row.push({ text: " ", paint: palette.muted });
    row.push(metric);
  }
  return [palette.bold(paintSegments(identity)), ...rows.filter((row) => row.length).map(paintSegments)];
}

export function renderCompanionFooter(
  width: number,
  snapshot: Pick<FooterSnapshot, "extensionStatuses">,
  palette: SemanticPalette,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  const statuses = (snapshot.extensionStatuses ?? [])
    .map((status) => status.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim())
    .filter(Boolean);
  if (statuses.length > 0) {
    lines.push(truncateToWidth(statuses.join(" "), safeWidth, palette.dim("…")));
  }
  return lines;
}

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
  const brand = "◆ STEAK PI";
  const hints = safeWidth >= 64
    ? "/ commands · /model · /resume"
    : safeWidth >= 40
      ? "/ · /model · /resume"
      : "";
  if (!hints) {
    return [palette.bold(palette.accent(truncatePlain(brand, safeWidth)))];
  }
  return [
    paintSides(
      brand,
      hints,
      safeWidth,
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

/** Paint a fitted plain-text prefix without allowing lifecycle tone to bleed into metadata. */
function paintComposerSegments(fitted: string, segments: readonly ComposerSegment[]): string {
  const full = segments.map((segment) => segment.text).join("");
  const truncated = fitted !== full;
  const hasEllipsis = truncated && fitted.endsWith("…");
  let remaining = hasEllipsis ? fitted.slice(0, -1) : fitted;
  let result = "";
  let nextPainter = segments[0]?.paint ?? ((text: string) => text);

  for (const segment of segments) {
    nextPainter = segment.paint;
    if (!remaining) break;
    if (remaining.startsWith(segment.text)) {
      result += segment.paint(segment.text);
      remaining = remaining.slice(segment.text.length);
      continue;
    }
    result += segment.paint(remaining);
    remaining = "";
    break;
  }

  return hasEllipsis ? result + nextPainter("…") : result;
}

function modelSummary(snapshot: FooterSnapshot): string {
  const model = shortModel(snapshot.model);
  const thinking = oneLine(snapshot.thinking);
  // Provider routing is configuration, not part of the TUI model label.
  return thinking && thinking !== "off" ? `${model} · ${thinking}` : model;
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

function usageSegments(
  snapshot: FooterSnapshot,
  width: number,
  palette: SemanticPalette,
): ComposerSegment[] {
  const percent = contextPercent(snapshot);
  const summary = width >= 72
    ? usageSummary(snapshot, width)
    : `${width >= 32 ? "◫ " : ""}${percent === null ? "?" : `${percent.toFixed(0)}%`}`;
  const context = summary.split(" · ", 1)[0] ?? summary;
  const remainder = summary.slice(context.length);
  return [
    ...(width >= 72 ? [{ text: "◀ ", paint: palette.dim }] : []),
    { text: context, paint: contextPainter(snapshot, palette) },
    ...(remainder ? [{ text: remainder, paint: palette.dim }] : []),
  ];
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
  return contextPainter(snapshot, palette)("─".repeat(used)) + palette.dim("─".repeat(width - used));
}

export function renderComposerBand(
  width: number,
  snapshot: FooterSnapshot,
  palette: SemanticPalette,
): string {
  const safeWidth = Math.max(1, width);
  const status = statusPresentation(snapshot.state);
  const paintStatus = tonePainter(palette, status.tone);
  // Reserve context first. Ordinary multi-pane widths must not silently hide
  // the live reading; drop thinking detail and shorten only model/detail text.
  const rightSegments = safeWidth >= 18 ? usageSegments(snapshot, safeWidth, palette) : [];
  const right = rightSegments.map((segment) => segment.text).join("");
  const statusText = truncatePlain(status.text, Math.max(7, Math.min(safeWidth >= 72 ? 32 : 14, Math.floor(safeWidth / 2))));
  const prefix = safeWidth >= 42 ? " > " : " ";
  const separator = safeWidth >= 42 ? " > " : " · ";
  const modelBudget = safeWidth - displayWidth(right) - 1
    - displayWidth(`◆${prefix}${separator}${statusText} ▶`);
  const showModel = safeWidth >= 32 && modelBudget >= 6;
  const model = safeWidth >= 72 ? modelSummary(snapshot) : shortModel(snapshot.model);
  const leftSegments: ComposerSegment[] = [
    { text: "◆", paint: palette.accent },
    { text: showModel ? prefix : " ", paint: palette.muted },
    ...(showModel ? [
      { text: truncatePlain(model, modelBudget), paint: palette.text },
      { text: separator, paint: palette.muted },
    ] : []),
    { text: statusText, paint: paintStatus },
    { text: " ▶", paint: palette.accent },
  ];
  const left = leftSegments.map((segment) => segment.text).join("");
  const fitted = fitSides(left, right, safeWidth, 1);
  const meterWidth = right
    ? displayWidth(fitted.gap)
    : Math.max(0, safeWidth - displayWidth(fitted.left));
  return truncateToWidth(
    palette.bold(paintComposerSegments(fitted.left, leftSegments)) +
      renderContextMeter(meterWidth, snapshot, palette) +
      paintComposerSegments(fitted.right, rightSegments),
    safeWidth,
    "",
  );
}

export function renderCompanionFooter(
  width: number,
  snapshot: FooterSnapshot,
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

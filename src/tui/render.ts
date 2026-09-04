import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  compactCwd,
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
  const descriptor = safeWidth >= 54 ? "native · minimal · focused" : "native Pi companion";
  const first = safeWidth < 32
    ? palette.bold(palette.accent(truncatePlain(brand, safeWidth)))
    : paintSides(
        brand,
        descriptor,
        safeWidth,
        palette,
        (text) => palette.bold(palette.accent(text)),
        (text) => palette.dim(text),
      );
  const hints = safeWidth >= 64
    ? "type / for commands  ·  /model switch  ·  /resume sessions"
    : safeWidth >= 36
      ? "type /  ·  /model  ·  /resume"
      : safeWidth >= 24
        ? "/  ·  /model  ·  /resume"
        : "/ commands  ·  /resume";
  return [first, palette.muted(truncatePlain(hints, safeWidth))];
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

function modelSummary(snapshot: FooterSnapshot): string {
  const model = shortModel(snapshot.model);
  const thinking = oneLine(snapshot.thinking);
  const provider = oneLine(snapshot.provider);
  const base = provider && provider !== "unknown" && provider !== "zai" ? `${provider}/${model}` : model;
  return thinking && thinking !== "off" ? `${base} · ${thinking}` : base;
}

function locationSummary(snapshot: FooterSnapshot): string {
  const parts = [compactCwd(snapshot.cwd, snapshot.home)];
  const branch = oneLine(snapshot.branch);
  const sessionName = oneLine(snapshot.sessionName);
  if (branch) parts.push(branch);
  if (sessionName) parts.push(sessionName);
  return parts.join(" · ");
}

export function usageSummary(snapshot: FooterSnapshot, width: number): string {
  const parts: string[] = [];
  const context = snapshot.context;
  if (context) {
    parts.push(context.percent === null ? `ctx ?/${formatTokens(context.contextWindow)}` : `ctx ${context.percent.toFixed(0)}%`);
  }

  const total = snapshot.usage.input + snapshot.usage.output + snapshot.usage.cacheRead + snapshot.usage.cacheWrite;
  if (total > 0) parts.push(`${formatTokens(total)} tok`);

  const prompt = snapshot.usage.input + snapshot.usage.cacheRead + snapshot.usage.cacheWrite;
  if (width >= 72 && prompt > 0 && (snapshot.usage.cacheRead > 0 || snapshot.usage.cacheWrite > 0)) {
    parts.push(`cache ${((snapshot.usage.cacheRead / prompt) * 100).toFixed(0)}%`);
  }
  if (width >= 96 && snapshot.usage.cost > 0) parts.push(`$${snapshot.usage.cost.toFixed(3)}`);
  return parts.join(" · ") || "ctx —";
}

export function renderComposerBand(
  width: number,
  snapshot: FooterSnapshot,
  palette: SemanticPalette,
): string {
  const safeWidth = Math.max(1, width);
  const status = statusPresentation(snapshot.state);
  const left = safeWidth >= 42
    ? `◆  > ${modelSummary(snapshot)} > ${status.text} ▶`
    : `◆ ${status.text} ▶`;
  const canShowRight = displayWidth(left) <= Math.floor(safeWidth * 0.58);
  const rightDetail = !canShowRight
    ? ""
    : safeWidth >= 104
      ? `${locationSummary(snapshot)} · ${usageSummary(snapshot, safeWidth)}`
      : safeWidth >= 54
        ? usageSummary(snapshot, safeWidth)
        : "";
  const right = rightDetail ? `◀ ${rightDetail}` : "";
  const fitted = fitSides(left, right, safeWidth, 1);
  const fillWidth = right
    ? displayWidth(fitted.gap)
    : Math.max(0, safeWidth - displayWidth(fitted.left));
  const fill = "─".repeat(fillWidth);
  const paintStatus = tonePainter(palette, status.tone);
  return truncateToWidth(
    palette.bold(paintStatus(fitted.left)) +
      palette.accent(fill) +
      palette.dim(fitted.right),
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

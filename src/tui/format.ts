import { visibleWidth } from "@earendil-works/pi-tui";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, "");
}

/** Use Pi's own terminal-width oracle so extension layout cannot drift from Pi. */
export function displayWidth(value: string): number {
  return visibleWidth(value);
}

export function dropLastGrapheme(value: string): string {
  const segments = [...graphemes.segment(value)];
  return segments.slice(0, -1).map((item) => item.segment).join("");
}

export function oneLine(value: unknown): string {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncatePlain(value: string, width: number, ellipsis = "…"): string {
  const clean = oneLine(value);
  if (width <= 0) return "";
  if (displayWidth(clean) <= width) return clean;

  const suffix = displayWidth(ellipsis) <= width ? ellipsis : "";
  const budget = Math.max(0, width - displayWidth(suffix));
  let result = "";
  let used = 0;
  for (const item of graphemes.segment(clean)) {
    const next = visibleWidth(item.segment);
    if (used + next > budget) break;
    result += item.segment;
    used += next;
  }
  return result + suffix;
}

export interface SideLayout {
  left: string;
  gap: string;
  right: string;
}

/** Fit left/right status regions without ever slicing an ANSI sequence or grapheme. */
export function fitSides(leftValue: string, rightValue: string, width: number, minGap = 2): SideLayout {
  const left = oneLine(leftValue);
  const right = oneLine(rightValue);
  if (width <= 0) return { left: "", gap: "", right: "" };
  if (!right) return { left: truncatePlain(left, width), gap: "", right: "" };
  if (!left) return { left: "", gap: "", right: truncatePlain(right, width) };

  const leftWidth = displayWidth(left);
  const rightWidth = displayWidth(right);
  if (leftWidth + minGap + rightWidth <= width) {
    return { left, gap: " ".repeat(width - leftWidth - rightWidth), right };
  }

  if (width < minGap + 8) {
    return { left: truncatePlain(left, width), gap: "", right: "" };
  }

  const rightBudget = Math.min(rightWidth, Math.max(6, Math.floor(width * 0.48)));
  const leftBudget = Math.max(1, width - minGap - rightBudget);
  const fittedLeft = truncatePlain(left, leftBudget);
  const fittedRight = truncatePlain(right, width - minGap - displayWidth(fittedLeft));
  const gapWidth = Math.max(1, width - displayWidth(fittedLeft) - displayWidth(fittedRight));
  return { left: fittedLeft, gap: " ".repeat(gapWidth), right: fittedRight };
}

export function formatTokens(value: number): string {
  const count = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}m`;
  return `${Math.round(count / 1_000_000)}m`;
}

export function shortModel(model: unknown): string {
  const id = oneLine((model as { id?: unknown } | undefined)?.id);
  if (!id) return "no model";
  const tail = id.split("/").at(-1) ?? id;
  return truncatePlain(tail.replace(/^glm-/, "glm"), 24);
}

export function compactCwd(cwd: string, home = process.env.HOME): string {
  const clean = oneLine(cwd) || "~";
  if (!home) return clean;
  const normalizedHome = home.replace(/\/+$/, "");
  if (clean === normalizedHome) return "~";
  return clean.startsWith(`${normalizedHome}/`) ? `~${clean.slice(normalizedHome.length)}` : clean;
}

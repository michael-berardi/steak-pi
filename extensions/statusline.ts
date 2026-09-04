import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

/**
 * Steak Pi statusline — an OMP-style powerline footer, without the cost.
 *
 * Segments: ◆ model · thinking · branch · dir · UltraCompress policy.
 * Rendered as a widget above the editor. Event-driven only (session start, model change,
 * turn end, compaction): no timers, no polling, zero idle overhead.
 * Branch lookups are debounced to turn boundaries and fail silently offline.
 */

export interface StatusParts {
  model: string;
  thinking: string;
  branch: string;
  dir: string;
  compression: string | null;
  compacted: number;
}

const SEP = " │ ";

/** Pure renderer — vitest-friendly, no TUI dependency. */
export function renderStatusline(p: StatusParts): string {
  const segs: string[] = [];
  segs.push(`◆ ${p.model}`);
  if (p.thinking && p.thinking !== "off") segs.push(`✦ ${p.thinking}`);
  if (p.branch) segs.push(`⑂ ${p.branch}`);
  if (p.dir) segs.push(p.dir);
  if (p.compression) segs.push(`⚡ ${p.compression}`);
  if (p.compacted > 0) segs.push(`⊞ ${p.compacted}`);
  return segs.join(SEP);
}

export function gitBranch(cwd: string): string {
  try {
    const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      timeout: 1_500,
    });
    return r.status === 0 ? r.stdout.trim() : "";
  } catch {
    return "";
  }
}

export function shortModel(model: unknown): string {
  const id = String((model as { id?: string })?.id ?? "");
  if (!id) return "pi";
  const tail = id.split("/").pop() ?? id;
  return tail.replace(/^glm-/, "glm").slice(0, 22);
}

export function baseName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "~";
}

export default function statuslineExtension(pi: ExtensionAPI): void {
  let branch = "";
  let compacted = 0;
  let compressionPolicy: string | null = "auto";

  type StatusContext = {
    model?: unknown;
    thinkingLevel?: unknown;
    cwd?: string;
    hasUI?: boolean;
    ui?: { setWidget?: (id: string, lines: string[]) => void };
  };
  const render = (ctx?: StatusContext) => {
    try {
      if (ctx?.hasUI === false) return;
      const parts: StatusParts = {
        model: shortModel(ctx?.model),
        thinking: String(ctx?.thinkingLevel ?? ""),
        branch,
        dir: baseName(ctx?.cwd ?? process.cwd()),
        compression: compressionPolicy,
        compacted,
      };
      ctx?.ui?.setWidget?.("statusline", [renderStatusline(parts)]);
    } catch {
      // Widget rendering is best-effort decoration; never surface errors.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    compacted = 0;
    branch = gitBranch(ctx?.cwd ?? process.cwd());
    render(ctx as unknown as StatusContext);
  });

  const onModelChange = pi.on as unknown as (
    event: "model_change",
    handler: (event: unknown, ctx: StatusContext) => Promise<void>,
  ) => void;
  onModelChange("model_change", async (_event, ctx) => {
    render(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    render(ctx as unknown as StatusContext);
  });

  const onCompaction = pi.on as unknown as (
    event: "session_before_compact",
    handler: (event: unknown, ctx: StatusContext) => Promise<unknown>,
  ) => void;
  onCompaction("session_before_compact", async (event, ctx) => {
    const instructions = String((event as { customInstructions?: string }).customInstructions ?? "");
    compressionPolicy = instructions.includes("/ultracompress") || instructions === "" ? "auto" : compressionPolicy;
    render(ctx);
    return undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    compacted++;
    render(ctx as unknown as StatusContext);
  });
}

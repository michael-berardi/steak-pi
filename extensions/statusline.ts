import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

/**
 * Steak Pi statusline — an OMP-style powerline footer, without the cost.
 *
 * Segments: ◆ model · thinking · branch · dir · rc policy. Rendered as a
 * widget above the editor. Event-driven only (session start, model change,
 * turn end, compaction): no timers, no polling, zero idle overhead.
 * Branch lookups are debounced to turn boundaries and fail silently offline.
 */

export interface StatusParts {
  model: string;
  thinking: string;
  branch: string;
  dir: string;
  rc: string | null;
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
  if (p.rc) segs.push(`⚡ ${p.rc}`);
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
  let rcPolicy: string | null = null;

  const render = (pi2: ExtensionAPI, ctx?: { model?: unknown; thinkingLevel?: unknown; cwd?: string; hasUI?: boolean }) => {
    try {
      if (ctx && ctx.hasUI === false) return;
      const parts: StatusParts = {
        model: shortModel(ctx?.model),
        thinking: String(ctx?.thinkingLevel ?? ""),
        branch,
        dir: baseName(ctx?.cwd ?? process.cwd()),
        rc: rcPolicy,
        compacted,
      };
      (pi2 as unknown as { setWidget?: (id: string, lines: string[]) => void }).setWidget?.(
        "statusline",
        [renderStatusline(parts)],
      );
    } catch {
      // Widget rendering is best-effort decoration; never surface errors.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    compacted = 0;
    branch = gitBranch(ctx?.cwd ?? process.cwd());
    render(pi, ctx as never);
  });

  pi.on("model_change", async (event, ctx) => {
    void event;
    render(pi, ctx as never);
  });

  pi.on("turn_end", async (_event, ctx) => {
    render(pi, ctx as never);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    // Reflect the active compaction stack in the footer.
    const instructions = String((event as { customInstructions?: string }).customInstructions ?? "");
    rcPolicy = instructions.includes("/rc") || instructions === "" ? "auto" : rcPolicy;
    void ctx;
    return undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    compacted++;
    render(pi, ctx as never);
  });
}

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATE_DIR = ".steak-pi";
const SNAPS_DIR = "snaps";

export interface SnapMeta {
  file: string;
  reason: string;
  createdAt: number;
  entries: number;
}

export function snapFileName(nowMs: number): string {
  return `snap-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}.json`;
}

export function buildSnap(
  entries: unknown[],
  reason: string,
  nowMs: number,
): { meta: SnapMeta; payload: string } {
  const meta: SnapMeta = {
    file: snapFileName(nowMs),
    reason,
    createdAt: nowMs,
    entries: entries.length,
  };
  const payload = JSON.stringify(
    { snap: meta, entries },
    null,
    0,
  );
  return { meta, payload };
}

export function writeSnap(cwd: string, payload: string, fileName: string): string {
  const dir = path.join(cwd, STATE_DIR, SNAPS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, payload);
  return file;
}

export function listSnaps(cwd: string): SnapMeta[] {
  const dir = path.join(cwd, STATE_DIR, SNAPS_DIR);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          return parsed?.snap as SnapMeta;
        } catch {
          return null;
        }
      })
      .filter((m): m is SnapMeta => Boolean(m))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export default function instantSnapExtension(pi: ExtensionAPI): void {
  // Instant snap: before every compaction, serialize the full session so the
  // pre-compaction state is always restorable. Listener-only at idle; one
  // local write at snap time.
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const entries = ctx.sessionManager.getEntries();
      const now = Date.now();
      const { meta, payload } = buildSnap(entries, event.reason ?? "unknown", now);
      writeSnap(process.cwd(), payload, meta.file);
    } catch (error) {
      // Snap failure must never block compaction.
      console.error("[steak-pi] instant snap failed:", error);
    }
    return undefined;
  });

  pi.registerCommand("snaps", {
    description: "List Steak Pi pre-compaction snapshots",
    handler: async (_args, ctx) => {
      const snaps = listSnaps(process.cwd());
      const text = snaps.length
        ? snaps.map((s) => `${new Date(s.createdAt).toISOString()} · ${s.reason} · ${s.entries} entries`).join("\n")
        : "No snapshots yet.";
      await ctx.ui.notify(text, "info");
    },
  });
}

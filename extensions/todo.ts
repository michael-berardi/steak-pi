/**
 * Steak Pi todo — thin wrapper around the UltraTerm Plan extension.
 *
 * The tool, persistence, guidance and pinned-panel logic live in
 * `packages/ultraterm-plan/pi/extension.ts` — the same module the standalone
 * `ut-todo` package documents and ships. This file injects Steak Pi's own
 * pinned-panel compositor and session-file canonicalizer, keeping behaviour
 * identical to the pre-extraction extension with a single implementation.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { canonicalSessionFile } from "../src/subagents/checkpoints.ts";
import { setPinnedPanel } from "../src/tui/pinned-panels.ts";
import { createPlanExtension } from "../packages/ultraterm-plan/pi/extension.ts";

export default function steakPieExtension(pi: ExtensionAPI): void {
  createPlanExtension({ setPinnedPanel, canonicalSessionFile })(pi);
}

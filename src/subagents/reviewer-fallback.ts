import type { TaskRecord, WorkerResult, RunRecord } from "./types.ts";
import { SOL_MODEL_ROUTE } from "../retired-model-selection.ts";
import { CLAUDE_CODE_OPUS_ROUTE } from "./model-selection.ts";

/** Automatic Sol fallback moves a wave to Pi, so it admits only permission-free reviewers: Claude's exact path admission and reviewer shell denial must not be bypassed. */
export function isReadOnlyReviewWave(tasks: readonly { role?: string; mayEdit?: boolean; allowBash?: boolean; ownedPaths?: readonly string[] }[]): boolean {
  return tasks.length > 0 && tasks.every(task => task.role === "reviewer" &&
    task.mayEdit !== true && task.allowBash !== true &&
    (task.ownedPaths === undefined || (Array.isArray(task.ownedPaths) && task.ownedPaths.length === 0)));
}

export function canFallbackReview(run: RunRecord, result: WorkerResult, signal: AbortSignal): boolean {
  return run.claudeAccount === undefined && run.selection?.automaticReview === true && run.model === CLAUDE_CODE_OPUS_ROUTE &&
    run.selection.reviewRequiresImages !== true && isReadOnlyReviewWave(run.tasks) &&
    !signal.aborted && !result.cleanup && result.state === "failed" &&
    (result.reviewFallbackReason === "quota" || result.reviewFallbackReason === "auth");
}
export function recordReviewFallback(task: TaskRecord, reason: "no-eligible-claude" | "quota" | "auth"): void {
  task.reviewFallback = { from: CLAUDE_CODE_OPUS_ROUTE, to: SOL_MODEL_ROUTE, reason };
  task.routeFallbacks = [...(task.routeFallbacks ?? []), `${CLAUDE_CODE_OPUS_ROUTE}->${SOL_MODEL_ROUTE}`];
  task.lastStep = `model-fallback:${SOL_MODEL_ROUTE}`;
}

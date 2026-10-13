import type { TaskRecord, WorkerResult, RunRecord } from "./types.ts";
import { SOL_MODEL_ROUTE } from "../retired-model-selection.ts";
import { CLAUDE_CODE_OPUS_ROUTE } from "./model-selection.ts";

export function canFallbackReview(run: RunRecord, result: WorkerResult, signal: AbortSignal): boolean {
  return run.selection?.automaticReview === true && run.model === CLAUDE_CODE_OPUS_ROUTE &&
    run.selection.reviewRequiresImages !== true && run.tasks.length > 0 && run.tasks.every(task => task.role === "reviewer") &&
    !signal.aborted && !result.cleanup && result.state === "failed" &&
    (result.reviewFallbackReason === "quota" || result.reviewFallbackReason === "auth");
}
export function recordReviewFallback(task: TaskRecord, reason: "no-eligible-claude" | "quota" | "auth"): void {
  task.reviewFallback = { from: CLAUDE_CODE_OPUS_ROUTE, to: SOL_MODEL_ROUTE, reason };
  task.routeFallbacks = [...(task.routeFallbacks ?? []), `${CLAUDE_CODE_OPUS_ROUTE}->${SOL_MODEL_ROUTE}`];
  task.lastStep = `model-fallback:${SOL_MODEL_ROUTE}`;
}

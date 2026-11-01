import type { TaskRecord, WorkerResult, RunRecord } from "./types.ts";
import { routingConfigOrEmpty } from "../routing-config.ts";

/** The operator's implicit review route (`implicitReview.route`) and its Pi fallback
 * (`implicitReview.fallback`); neither exists unless configured. */
export const implicitReviewRoute = (): string | undefined => routingConfigOrEmpty().implicitReview?.route;
export const implicitReviewFallbackRoute = (): string | undefined => routingConfigOrEmpty().implicitReview?.fallback;

/** The automatic review fallback moves a wave to Pi, so it admits only permission-free reviewers: Claude's exact path admission and reviewer shell denial must not be bypassed. */
export function isReadOnlyReviewWave(tasks: readonly { role?: string; mayEdit?: boolean; allowBash?: boolean; ownedPaths?: readonly string[] }[]): boolean {
  return tasks.length > 0 && tasks.every(task => task.role === "reviewer" &&
    task.mayEdit !== true && task.allowBash !== true &&
    (task.ownedPaths === undefined || (Array.isArray(task.ownedPaths) && task.ownedPaths.length === 0)));
}

export function canFallbackReview(run: RunRecord, result: WorkerResult, signal: AbortSignal): boolean {
  const route = implicitReviewRoute();
  return route !== undefined && implicitReviewFallbackRoute() !== undefined &&
    run.claudeAccount === undefined && run.selection?.automaticReview === true && run.model === route &&
    run.selection.reviewRequiresImages !== true && isReadOnlyReviewWave(run.tasks) &&
    !signal.aborted && !result.cleanup && result.state === "failed" &&
    (result.reviewFallbackReason === "quota" || result.reviewFallbackReason === "auth");
}
export function recordReviewFallback(task: TaskRecord, reason: "no-eligible-claude" | "quota" | "auth"): void {
  const from = implicitReviewRoute() ?? "implicit-review";
  const to = implicitReviewFallbackRoute() ?? "none";
  task.reviewFallback = { from, to, reason };
  task.routeFallbacks = [...(task.routeFallbacks ?? []), `${from}->${to}`];
  task.lastStep = `model-fallback:${to}`;
}

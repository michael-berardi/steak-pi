/**
 * Advance notice before a child exhausts its turn budget. A child that is told
 * early writes its findings and a precise remaining-work list as its final
 * answer, so a budget stop retains useful partial work instead of a cut-off.
 */

/** Requests left when the notice is injected. */
export const TURN_BUDGET_NOTICE_REMAINING = 2;

/** Turn count at whose end the notice is injected (any budget). */
export function turnBudgetNoticeAt(maxTurns: number): number {
  return Math.max(1, maxTurns - TURN_BUDGET_NOTICE_REMAINING);
}

/** Short steering text for a live session. */
export function turnBudgetNotice(remaining: number): string {
  return `Turn budget notice: only ${remaining} assistant request${remaining === 1 ? "" : "s"} remain. Stop gathering evidence and make no new plans. Your final answer must state (1) your findings so far and (2) a precise remaining-work list: what is not yet done or verified, with exact paths or commands. An unfinished leaf with that list is still useful; a cut-off without it is not.`;
}

/** Up-front equivalent for harnesses whose stdin closes after the prompt. */
export function turnBudgetPromptLine(maxTurns: number): string {
  return `You have at most ${maxTurns} assistant requests. Keep count: when about ${TURN_BUDGET_NOTICE_REMAINING} remain, stop gathering evidence and write your findings so far plus a precise remaining-work list (what is not yet done or verified, with exact paths or commands) as your final answer. This harness cannot interrupt you mid-run.`;
}

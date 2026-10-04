/**
 * Automatic resume of a worker that failed on a transient fault (network
 * drop, provider stream cut or stall, overload, rate limit). The worker
 * continues its persisted session, so finished tool calls are not redone.
 * Measured 2026-10-04: a fresh restart redid every finished step and spent
 * ~69% more tokens than resuming the same session.
 *
 * Never resumed: deadlines, turn limits, content filters, route or policy
 * refusals, cancellations. Those need a decision, not a retry.
 */

export const MAX_AUTO_RESUMES = 2;
/** A resume is only worth starting with at least this much run budget left. */
export const MIN_RESUME_BUDGET_MS = 90_000;

const TRANSIENT: ReadonlyArray<{ pattern: RegExp; reason: string; delaysMs: readonly number[] }> = [
	{ pattern: /rate.?limit|\b429\b|too many requests/i, reason: "rate limited", delaysMs: [60_000, 120_000] },
	{ pattern: /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network (?:error|connection)/i, reason: "network drop", delaysMs: [10_000, 30_000] },
	{ pattern: /^terminated$|response headers timed out|Request timed out|stream (?:ended|closed) (?:early|unexpectedly)/i, reason: "provider stream cut", delaysMs: [10_000, 30_000] },
	{ pattern: /No model or tool activity for \d+ min/, reason: "provider stream stalled", delaysMs: [10_000, 30_000] },
	{ pattern: /incomplete stream-json frame|claude-code CLI produced no result event/, reason: "Claude Code stream cut", delaysMs: [10_000, 30_000] },
	{ pattern: /claude-code CLI exited with code \S+ \(signal SIG(?:KILL|TERM|HUP|SEGV|ABRT|BUS)\)/, reason: "Claude Code process died", delaysMs: [10_000, 30_000] },
	{ pattern: /overloaded|\b50[234]\b|internal server error|server_error|service unavailable/i, reason: "provider overloaded", delaysMs: [30_000, 90_000] },
];

/** Errors that look transient but must never be retried automatically. */
const NEVER = /deadline|turn limit|content.?filter|flagged|pinned|permission|policy|quota|billing|unauthori[sz]ed|authenticat|forbidden|\b40[13]\b|cancel|abort/i;

export interface TransientFailure {
	reason: string;
	delayMs: number;
}

/** Classify a failed worker's error. `attempt` is the 0-based resume about to start. */
export function transientFailure(error: string | undefined, attempt: number): TransientFailure | undefined {
	if (!error || attempt >= MAX_AUTO_RESUMES) return undefined;
	const text = error.trim();
	if (NEVER.test(text)) return undefined;
	for (const rule of TRANSIENT) {
		if (rule.pattern.test(text)) return { reason: rule.reason, delayMs: rule.delaysMs[Math.min(attempt, rule.delaysMs.length - 1)] };
	}
	return undefined;
}

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
import { isEnsureRefusal } from "./profile-ensure.ts";

export const MAX_AUTO_RESUMES = 2;
/** A resume is only worth starting with at least this much run budget left. */
export const MIN_RESUME_BUDGET_MS = 90_000;

/** A reply Codex ended at its ~15-minute limit (src/codex-reply-limit.ts): resumed once, in smaller steps. */
export const CODEX_REPLY_LIMIT_REASON = "codex reply limit";

const TRANSIENT: ReadonlyArray<{ pattern: RegExp; reason: string; delaysMs: readonly number[] }> = [
	{ pattern: /^Codex reply limit:/, reason: CODEX_REPLY_LIMIT_REASON, delaysMs: [5_000] },
	{ pattern: /rate.?limit|\b429\b|too many requests/i, reason: "rate limited", delaysMs: [60_000, 120_000] },
	{ pattern: /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network (?:error|connection)|^Connection error\.?$|connection (?:error|reset|closed|lost|refused|timed out)|transport failure; connection or request did not complete/i, reason: "network drop", delaysMs: [10_000, 30_000] },
	{ pattern: /^terminated$|response headers timed out|Request timed out|stream (?:ended|closed) (?:early|unexpectedly)/i, reason: "provider stream cut", delaysMs: [10_000, 30_000] },
	{ pattern: /No model or tool activity for \d+ min/, reason: "provider stream stalled", delaysMs: [10_000, 30_000] },
	// Claude Code's own idle limit, after the provider already recovered in-process the allowed number of times. Not the
	// crash message ("already gone"), the "recovery is off" message or the "API had already sent the whole reply" one.
	{ pattern: /Claude Code stream idle limit exceeded[\s\S]*(?:each went quiet again|cannot be taken back|already sent \d+ times)/, reason: "provider stream stalled", delaysMs: [10_000, 30_000] },
	{ pattern: /incomplete stream-json frame|claude-code CLI produced no result event/, reason: "Claude Code stream cut", delaysMs: [10_000, 30_000] },
	{ pattern: /claude-code CLI exited with code \S+ \(signal SIG(?:KILL|TERM|HUP|SEGV|ABRT|BUS)\)/, reason: "Claude Code process died", delaysMs: [10_000, 30_000] },
	{ pattern: /overloaded|\b50[234]\b|internal server error|server_error|service unavailable/i, reason: "provider overloaded", delaysMs: [30_000, 90_000] },
];

/** Errors that look transient but must never be retried automatically. */
const NEVER = /deadline|turn limit|content.?filter|data_inspection|inappropriate content|moderation|flagged|pinned|permission|policy|quota|usage.limit|billing|unauthori[sz]ed|authenticat|forbidden|\b40[13]\b|cancel|abort/i;

export interface TransientFailure {
	reason: string;
	delayMs: number;
}

/** Classify a failed worker's error. `attempt` is the 0-based resume about to start. */
export function transientFailure(error: string | undefined, attempt: number): TransientFailure | undefined {
	if (!error || attempt >= MAX_AUTO_RESUMES) return undefined;
	const text = error.trim();
	// A refused ensure carries the operator's own words (a hold's reason, a command's stderr): never read them as a network or
	// server error. It is a named, final cause, so the refusal is checked before any pattern below.
	if (isEnsureRefusal(text)) return undefined;
	if (NEVER.test(text)) return undefined;
	for (const rule of TRANSIENT) {
		if (!rule.pattern.test(text)) continue;
		// The same request would hit the same limit: one resume, and only with the smaller-step instruction.
		if (rule.reason === CODEX_REPLY_LIMIT_REASON && attempt >= 1) return undefined;
		return { reason: rule.reason, delayMs: rule.delaysMs[Math.min(attempt, rule.delaysMs.length - 1)] };
	}
	return undefined;
}

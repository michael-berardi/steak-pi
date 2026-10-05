/**
 * The Codex backend ends every reply stream after about 15 minutes. A turn that thinks longer
 * than that fails with a bare "terminated" every time, and Pi's automatic retry (and USAP's
 * automatic resume) send the identical request again, so it fails again 15 minutes later
 * (2026-10-04: 19 of 26 "terminated" errors in 36 h hit at 15.0-15.6 min; J-0022 lost an hour
 * this way). This module recognises that one failure and turns it into an explicit, named error
 * that neither retry layer treats as transient. Recovery is one bounded follow-up that asks for
 * smaller steps, on the same model and reasoning level: nothing is downgraded silently, and no
 * request (or tool call) is sent twice.
 */

/** The reply limit sits at 15 minutes; anything cut after 14 is treated as having hit it. */
export const CODEX_REPLY_LIMIT_MS = 14 * 60_000;
export const CODEX_REPLY_LIMIT_PREFIX = "Codex reply limit:";
/** One automatic smaller-step follow-up per chain; a second cut stops with the explicit error. */
export const MAX_SMALLER_STEP_FOLLOW_UPS = 1;

export interface AssistantErrorLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  provider?: string;
  api?: string;
  model?: string;
}

function isCodex(message: AssistantErrorLike): boolean {
  return message.provider === "openai-codex" || (message.api ?? "").startsWith("openai-codex");
}

/**
 * The explicit error for a reply Codex ended at its limit, or undefined for anything else
 * (a quick "terminated" is a real network drop and keeps its normal retry).
 */
export function codexReplyLimitError(
  message: AssistantErrorLike,
  elapsedMs: number,
  thinkingLevel?: string,
): string | undefined {
  if (message.role !== "assistant" || message.stopReason !== "error" || !isCodex(message)) return undefined;
  if ((message.errorMessage ?? "").trim().toLowerCase() !== "terminated" || elapsedMs < CODEX_REPLY_LIMIT_MS) return undefined;
  const minutes = Math.round(elapsedMs / 60_000);
  const route = [message.model, thinkingLevel].filter(Boolean).join(", ");
  // Wording matters: it must match none of Pi's or USAP's transient patterns
  // (see test/codex-reply-limit.test.ts), so the same request is not sent again.
  return `${CODEX_REPLY_LIMIT_PREFIX} Codex ended this reply after ${minutes} minutes of thinking, its longest allowed reply. `
    + "The same request was not sent again because it would end the same way. "
    + `Model and reasoning level are unchanged${route ? ` (${route})` : ""}. `
    + "Continue in smaller steps: one check or one edit per reply.";
}

export function isCodexReplyLimit(error: string | undefined): boolean {
  return (error ?? "").trim().startsWith(CODEX_REPLY_LIMIT_PREFIX);
}

/** The follow-up that resumes the same work in steps that fit inside the limit. */
export const SMALLER_STEP_INSTRUCTION = [
  "Your previous reply was ended by Codex after about 15 minutes of thinking, before you could act.",
  "Nothing from that reply ran. Continue the same task in small steps that each finish well within that time:",
  "do one check or one edit per reply, report briefly what you did, then take the next step.",
].join(" ");

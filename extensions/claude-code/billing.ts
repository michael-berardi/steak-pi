/**
 * Guards against requests silently moving from Claude plan limits to
 * pay-as-you-go usage credits (formerly "extra usage").
 */

import { envFlagEnabled } from "./env.ts";

export const ALLOW_USAGE_CREDITS_ENV = "PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS";

/** Claude Code's `rate_limit_event.rate_limit_info`, as far as this extension relies on it. */
export interface RateLimitInfo {
  status?: string;
  rateLimitType?: string;
  resetsAt?: number;
  isUsingOverage?: boolean;
  overageStatus?: string;
  overageDisabledReason?: string;
  [key: string]: unknown;
}

// Anthropic rejects or reroutes requests it classifies as third-party app
// usage with these messages. Every message we produce contains "billing" so
// Pi's retry classifier treats it as a non-retryable account error.
const USAGE_CREDITS_REJECTION =
  /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/iu;

export function usageCreditsAllowed(env: Record<string, string | undefined>): boolean {
  return envFlagEnabled(env[ALLOW_USAGE_CREDITS_ENV]);
}

export function usageCreditsChargeError(info: RateLimitInfo): Error {
  return new Error(
    "Claude Code billing: this request was charged to Claude usage credits instead of your plan limits " +
      `(rate limit status ${info.status ?? "unknown"}${info.rateLimitType ? `, ${info.rateLimitType}` : ""}). ` +
      "Pi stopped so further requests are not charged. To stay on plan limits only, turn off usage credits at " +
      `claude.ai/settings/usage. To allow usage credits, set ${ALLOW_USAGE_CREDITS_ENV}=1.`,
  );
}

/** Rewrite an Anthropic usage-credit rejection into an actionable, non-retryable error. */
export function describeUsageCreditsRejection(message: string): string | undefined {
  if (!USAGE_CREDITS_REJECTION.test(message)) return undefined;
  return (
    "Claude Code billing: Anthropic did not accept this request on your Claude plan limits and wants to charge " +
    "it to usage credits. This happens when your plan limit is used up, or when Anthropic classifies the " +
    "request as third-party app usage. Pi will not retry it. Original error: " +
    message
  );
}

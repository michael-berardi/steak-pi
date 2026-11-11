// Provider content-filter refusals, named by response shape only. A provider's input inspection can refuse ordinary
// engineering text before any output (an HTTP 400 whose error code or type names content inspection or moderation).
// The refusal is about the input, not the route's health or credit, so a route that answers the same turn is the
// correct next step before output; after output the run fails with this cause. Matching never looks at a provider name.

/** Error codes and types a provider uses for input/output content inspection, moderation or safety filtering. */
const CONTENT_FILTER_CODE = /\b(?:data_inspection_failed|content_filter|content_policy_violation|content_moderation|moderation_blocked|safety_filter|safety_violation|responsible_ai_policy_violation)\b/i;

/** True when the message is an HTTP 400 that names a content-inspection/moderation/safety-filter code or type. */
export function isContentFilterRefusal(message: string | undefined): boolean {
  if (typeof message !== "string" || message.length === 0) return false;
  return /\b400\b/.test(message) && CONTENT_FILTER_CODE.test(message);
}

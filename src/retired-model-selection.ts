/** Operator decision, 2026-10-05: Sol is GPT-6.1 only. Never migrate a selector. */
export const SOL_MODEL_ID = "gpt-6.1-sol";
export const SOL_MODEL_ROUTE = `openai-codex/${SOL_MODEL_ID}`;
export const SOL_PROFILE = "steak-pi/gpt-6-1-sol";

export class RetiredModelSelectionError extends Error {
  constructor() {
    super(`RetiredModelSelectionError: GPT-6.0 Sol was retired on 2026-10-05. Select ${SOL_MODEL_ROUTE} or ${SOL_PROFILE} explicitly; no fallback was selected.`);
    this.name = "RetiredModelSelectionError";
  }
}

/** Qualified selectors and native shorthand share the same terminal identity.
 * Display-name matching also covers opaque catalog aliases, not Astra or Luna. */
export function isRetiredSolSelector(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /(?:^|[/:])gpt-6-sol(?:$|[-:/])/i.test(value.trim()) ||
    /(?:^|[/:])gpt-6[.-]0-sol(?:$|[-:/])/i.test(value.trim()) ||
    /^GPT[ -]?6(?:\.0)?[ -]Sol(?:$|[^a-z0-9])/i.test(value.trim());
}

export function assertActiveModelSelector(value: unknown): void {
  if (isRetiredSolSelector(value)) throw new RetiredModelSelectionError();
}

export function assertActiveModelIdentity(model: { id: string; name?: string }): void {
  assertActiveModelSelector(model.id);
  assertActiveModelSelector(model.name);
}

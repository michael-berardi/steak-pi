/** Display cue only. Core owns compaction and validates its settings. */
export function contextPressure(
  tokens: number | null,
  window: number,
  model: { provider: string; id: string } | undefined,
  settings: { compaction?: { reserveTokens?: number; modelOverrides?: Record<string, { reserveTokens?: number }> } },
): boolean {
  if (tokens === null || !Number.isFinite(tokens) || window <= 0) return false;
  const compaction = settings.compaction;
  const reserve = (model ? compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens : undefined)
    ?? compaction?.reserveTokens;
  if (typeof reserve === "number" && Number.isSafeInteger(reserve) && reserve >= 0) return tokens > window - reserve;
  return window >= 500000 && tokens > window * 0.4;
}

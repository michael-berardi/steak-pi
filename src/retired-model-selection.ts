import { routingConfigOrEmpty, type RetiredModelPattern } from "./routing-config.ts";

/** Retired routes are operator configuration (`retiredModelPatterns` in routing.json);
 * Steak Pi retires nothing by itself. Never migrate a selector: a retired one is refused. */
export class RetiredModelSelectionError extends Error {
  constructor(message = "this model was retired by the operator (retiredModelPatterns); no fallback was selected.") {
    super(message.startsWith("RetiredModelSelectionError") ? message : `RetiredModelSelectionError: ${message}`);
    this.name = "RetiredModelSelectionError";
  }
}

const patterns = (): readonly RetiredModelPattern[] => routingConfigOrEmpty().retiredModelPatterns ?? [];
/** `selection` also applies `selectorsOnly` entries, which refuse a route only where it is
 * named as a dispatch or role-default selection, never in a catalog or resolved identity. */
const matching = (value: unknown, selection: boolean): RetiredModelPattern | undefined => {
  if (typeof value !== "string") return undefined;
  const subject = value.trim();
  return patterns().find((entry) => (selection || !entry.selectorsOnly) && entry.pattern.test(subject));
};
const messageFor = (entry: RetiredModelPattern, route: string) => entry.message.replaceAll("{route}", route);

/** True when an operator-retired pattern matches this selector or identity string. */
export function isRetiredModelSelector(value: unknown): boolean {
  return matching(value, false) !== undefined;
}
/** @deprecated Former name of {@link isRetiredModelSelector}; it reads the operator patterns. */
export const isRetiredSolSelector = isRetiredModelSelector;
/** True when a selection-only or general retirement refuses this selection string. */
export function isRetiredRoute(route: string): boolean {
  return matching(route, true) !== undefined;
}

/** The operator's retirement message for a selection string, or a neutral default. */
export function retiredRouteError(route: string): string {
  const entry = matching(route, true);
  return entry ? messageFor(entry, route) : `${route} is retired by the operator; no fallback was selected.`;
}

export function assertActiveModelSelector(value: unknown): void {
  const entry = matching(value, false);
  if (entry) throw new RetiredModelSelectionError(messageFor(entry, String(value).trim()));
}

export function assertActiveModelIdentity(model: { id: string; name?: string }): void {
  assertActiveModelSelector(model.id);
  assertActiveModelSelector(model.name);
}

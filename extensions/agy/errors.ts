// Named failures of the agy route. Every error says its cause; none is swallowed into a fallback.
export const INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

export type AgyErrorKind = "missing" | "signed-out" | "model-unavailable" | "timeout" | "cancelled" | "interrupted" | "failed" | "protocol";

export class AgyError extends Error {
  override name = "AgyError";
  kind: AgyErrorKind;
  constructor(kind: AgyErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
  }
}

export const missingMessage = (bin: string) =>
  `agy (Google's Antigravity CLI) was not found${bin === "agy" ? " on PATH" : ` at ${bin}`}. Install it with: ${INSTALL_COMMAND}`;

/** Drop control characters and URLs (a sign-in prompt carries a one-time URL) from text taken from agy. */
export function cleanAgyText(text: string, max = 300): string {
  const clean = text.replace(/https?:\/\/\S+/g, "<url>").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

const SIGNED_OUT = /authentication|sign in|signed in|log ?in|unauthenticated|credential/i;
const MODEL_UNAVAILABLE = /not recognized as a known model|invalid model selection|unknown model|not available (?:for|on) your|does not have access/i;

/** Turn the text of an agy `result` with status ERROR into a named error. */
export function errorFromResult(text: string, model: string): AgyError {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^fetching /i.test(l));
  const first = cleanAgyText(lines.find((l) => SIGNED_OUT.test(l) || MODEL_UNAVAILABLE.test(l)) ?? lines[0] ?? "");
  if (MODEL_UNAVAILABLE.test(text)) {
    return new AgyError("model-unavailable", `agy does not offer the model "${model}" on this account's plan (agy said: ${first}). Run \`agy models\` to see the models your plan includes.`);
  }
  if (SIGNED_OUT.test(text)) {
    return new AgyError("signed-out", `agy is not signed in (agy said: ${first}); run agy once to sign in.`);
  }
  return new AgyError("failed", `agy reported an error: ${first || "no message"}`);
}

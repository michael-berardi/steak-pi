/** Named failures of the Antigravity module. Every message says what failed and what to do next; none carries a token. */
export type AntigravityErrorCode =
  | "not-configured"
  | "sign-in"
  | "auth-expired"
  | "quota"
  | "rate-limited"
  | "unsupported"
  | "idle"
  | "upload-stalled"
  | "http"
  | "protocol";

export class AntigravityError extends Error {
  override name = "AntigravityError";
  readonly code: AntigravityErrorCode;
  readonly status?: number;
  /** When a rate limit or quota wall said the request may be tried again, in ms from now. */
  readonly retryAfterMs?: number;

  constructor(code: AntigravityErrorCode, message: string, details: { status?: number; retryAfterMs?: number; cause?: unknown } = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.code = code;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}

const SECRET_SHAPES: RegExp[] = [
  /ya29\.[\w-]+/g,
  /1\/\/[\w-]{20,}/g,
  /GOCSPX-[\w-]+/g,
  /Bearer\s+[\w.~+/=-]+/gi,
  /("?(?:access_token|refresh_token|client_secret|code|id_token)"?\s*[:=]\s*"?)[^"&\s,}]+/gi,
];

/** Remove anything shaped like a token from text that is about to be shown. */
export function redact(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, (match, prefix?: string) => (typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]"));
  return out;
}

/** The provider's own message from an error body, redacted and bounded. */
export function providerMessage(body: string): string {
  let text = body.trim();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; error_description?: unknown };
    const inner = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : undefined;
    const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined;
    text = [inner, description].filter(Boolean).join(": ") || text;
  } catch { /* not JSON: the raw text is the message */ }
  return redact(text).replace(/\s+/g, " ").slice(0, 300) || "no message";
}

/** "2 h 3 min", "45 s": a wait a person can read. */
export function formatWait(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * How long the provider says to wait. Reads Retry-After (seconds or an HTTP date), a `retryDelay` such as "3.5s" in
 * the error details, and a "Resets in 2h3m" sentence. Undefined when it says nothing.
 */
export function retryAfterFrom(headers: Record<string, string | string[] | undefined>, body: string, now = Date.now()): number | undefined {
  const header = headers["retry-after"];
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw !== undefined && raw.trim() !== "") {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const delay = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
  if (delay) return Math.round(Number(delay[1]) * 1000);
  const resets = /Resets? in\s+((?:\d+\s*[dhms]\s*)+)/i.exec(body);
  if (resets) {
    let ms = 0;
    for (const [, amount, unit] of resets[1].matchAll(/(\d+)\s*([dhms])/gi)) ms += Number(amount) * { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 }[unit.toLowerCase() as "d" | "h" | "m" | "s"];
    return ms;
  }
  return undefined;
}

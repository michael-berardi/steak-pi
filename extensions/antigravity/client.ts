// Calls to the provider's own endpoints, and nothing else. Endpoints, OAuth URLs and the user agent all come from the
// operator's config. A request is sent to the next configured endpoint only after a connection failure before the body had
// finished uploading (never after the server may have received it); a 401 is a named expiry (Pi's own refresh renews the
// token, and this module holds no refresh token); a 429 waits at most the configured bound and is resent at most the configured number of times.
import { idleLimits } from "../claude-code/idle-policy.ts";
import type { AntigravityConfig } from "./config.ts";
import { AntigravityError, formatWait, providerMessage, retryAfterFrom, stripControl } from "./errors.ts";
import { DEFAULT_BODY_MAX, post, uploadFinished, type Reply } from "./transport.ts";

/** What a request is signed with. Only the access token: the refresh token stays in Pi's store. */
export interface Session {
  token: string;
  projectId: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** The caller's idle budget (Pi supplies 300 000). The first-byte and stream-idle limits derive from it. */
  timeoutMs?: number;
  /** Test seam for the wait between 429 retries. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Largest reply body `callJson` reads. Default 1 MiB. */
  maxBodyBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
/** Token endpoint replies are small; anything near this is not one. */
const TOKEN_REPLY_MAX = DEFAULT_BODY_MAX;

async function readCapped(response: Response, what: string): Promise<string> {
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > TOKEN_REPLY_MAX) {
      void reader.cancel().catch(() => {});
      throw new AntigravityError("protocol", `Antigravity ${what}: the token endpoint reply is larger than ${TOKEN_REPLY_MAX} bytes; refusing to read more`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("aborted")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

async function postForm(config: AntigravityConfig, form: Record<string, string>, what: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": config.userAgent },
      body: new URLSearchParams(form).toString(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AntigravityError("http", `Antigravity ${what}: cannot reach the token endpoint at ${new URL(config.tokenUrl).host} (${stripControl((error as Error).message)}); check the network and try again`, { cause: error });
  }
  const text = await readCapped(response, what);
  if (!response.ok) {
    // A 5xx is the endpoint failing, not the grant being refused.
    throw new AntigravityError(response.status >= 500 ? "http" : "sign-in", `Antigravity ${what} failed (HTTP ${response.status}): ${providerMessage(text)}`, { status: response.status });
  }
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new AntigravityError("protocol", `Antigravity ${what}: the token endpoint did not return JSON`); }
}

export function needClient(config: AntigravityConfig): { clientId: string; clientSecret: string } {
  if (!config.clientId || !config.clientSecret) {
    throw new AntigravityError("not-configured", `Antigravity sign-in needs an OAuth client: set "clientId" and "clientSecret" in ~/.config/ultraterm/antigravity.json (none is shipped with Steak Pi)`);
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

export interface Tokens { access: string; refresh?: string; expires: number }

function tokensFrom(data: Record<string, unknown>, what: string): Tokens {
  if (typeof data.access_token !== "string" || typeof data.expires_in !== "number") {
    throw new AntigravityError("protocol", `Antigravity ${what}: the token endpoint reply has no access_token / expires_in`);
  }
  // Treat the token as expired five minutes early, so Pi refreshes it before a request can meet a 401.
  return { access: data.access_token, refresh: typeof data.refresh_token === "string" ? data.refresh_token : undefined, expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000 };
}

export async function exchangeCode(config: AntigravityConfig, code: string, verifier: string, redirectUri: string, signal?: AbortSignal): Promise<Tokens> {
  const { clientId, clientSecret } = needClient(config);
  return tokensFrom(await postForm(config, { client_id: clientId, client_secret: clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri, code_verifier: verifier }, "token exchange", signal), "token exchange");
}

export async function refreshTokens(config: AntigravityConfig, refresh: string, signal?: AbortSignal): Promise<Tokens> {
  const { clientId, clientSecret } = needClient(config);
  try {
    return tokensFrom(await postForm(config, { client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: "refresh_token" }, "token refresh", signal), "token refresh");
  } catch (error) {
    if (error instanceof AntigravityError && error.code === "sign-in") {
      throw new AntigravityError("auth-expired", `${error.message}. The saved sign-in is no longer valid: run /login antigravity again`, { status: error.status });
    }
    throw error;
  }
}

function plainBody(body: unknown): Buffer { return Buffer.from(JSON.stringify(body), "utf8"); }

/**
 * POST a JSON body to `path` on the configured endpoints and return the open reply for a 2xx status.
 * Every other outcome is a named AntigravityError.
 */
export async function call(config: AntigravityConfig, session: Session, path: string, payload: unknown, label: string, options: CallOptions = {}): Promise<Reply> {
  const body = plainBody(payload);
  const limits = idleLimits(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, { bodyBytes: body.length }, {});
  const sleep = options.sleep ?? abortableSleep;
  let rateRetries = 0;
  let endpointIndex = 0;
  for (;;) {
    options.signal?.throwIfAborted();
    const base = config.baseUrls[endpointIndex];
    let reply: Reply;
    try {
      reply = await post(`${base}${path}`, body, {
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json", "User-Agent": config.userAgent, Accept: path.includes("alt=sse") ? "text/event-stream" : "application/json" },
        signal: options.signal,
        limits: { firstByteMs: limits.firstByteMs, streamIdleMs: limits.streamIdleMs },
        label,
      });
    } catch (error) {
      if (error instanceof AntigravityError || options.signal?.aborted) throw error;
      // Another endpoint is tried only when the body had not finished uploading: after that the server may have it already.
      const sent = uploadFinished(error);
      if (!sent && endpointIndex + 1 < config.baseUrls.length) { endpointIndex += 1; continue; }
      throw new AntigravityError("http", `Antigravity ${label}: cannot reach ${new URL(base).host} (${stripControl((error as Error).message)})${sent ? "; the request had been sent, so it was not sent to another endpoint" : ""}`, { cause: error });
    }
    if (reply.status >= 200 && reply.status < 300) return reply;
    const text = await reply.text().catch((error) => { if (error instanceof AntigravityError && error.code === "protocol") throw error; return ""; });
    const message = providerMessage(text);
    if (reply.status === 401) {
      // Renewing is Pi's job (its OAuth `refresh`, under its lock, saved in its store). A token renewed here would live only in memory.
      throw new AntigravityError("auth-expired", `Antigravity rejected the access token (HTTP 401: ${message}). Pi renews the token when it nears expiry; if this repeats, run /login antigravity to sign in again`, { status: 401 });
    }
    if (reply.status === 429) {
      const wait = retryAfterFrom(reply.headers, text);
      const quota = /quota|Resets? in|credits/i.test(text) && !/rate.?limit|too many requests/i.test(text);
      const code = quota ? "quota" : "rate-limited";
      if (wait !== undefined && wait <= config.maxRateLimitWaitMs && rateRetries < config.maxRateLimitRetries) {
        rateRetries += 1;
        await sleep(wait, options.signal);
        continue;
      }
      const when = wait === undefined ? "the provider gave no retry time" : `retry in ${formatWait(wait)} (after ${new Date(Date.now() + wait).toISOString()})`;
      const spent = rateRetries > 0 ? ` after ${rateRetries} bounded ${rateRetries === 1 ? "wait" : "waits"}` : "";
      throw new AntigravityError(code, `Antigravity ${quota ? "quota reached" : "rate limit"} (HTTP 429${spent}): ${message}; ${when}`, { status: 429, retryAfterMs: wait });
    }
    if (reply.status === 403) throw new AntigravityError("auth-expired", `Antigravity refused access (HTTP 403: ${message}). The account may need verification or may lack access to this model; check it in Google's own app, then /login antigravity`, { status: 403 });
    if (reply.status === 404) throw new AntigravityError("http", `Antigravity ${label}: not found (HTTP 404: ${message}). The model may not be available to this account; refresh the model list`, { status: 404 });
    throw new AntigravityError("http", `Antigravity ${label} failed (HTTP ${reply.status}: ${message})`, { status: reply.status });
  }
}

export async function callJson(config: AntigravityConfig, session: Session, path: string, payload: unknown, label: string, options: CallOptions = {}): Promise<Record<string, unknown>> {
  const reply = await call(config, session, path, payload, label, options);
  const text = await reply.text(options.maxBodyBytes);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fall through to the named error */ }
  throw new AntigravityError("protocol", `Antigravity ${label}: the reply was not a JSON object`);
}

/** The cloud project requests are billed to: the configured one, or the one the account's own assistant profile names. */
export async function discoverProject(config: AntigravityConfig, token: string, signal?: AbortSignal): Promise<string> {
  if (config.projectId) return config.projectId;
  const data = await callJson(config, { token, projectId: "" }, "/v1internal:loadCodeAssist", { metadata: { ideType: config.ideType } }, "project lookup", { signal });
  const direct = data.cloudaicompanionProject;
  const id = typeof direct === "string" ? direct : direct && typeof direct === "object" && typeof (direct as { id?: unknown }).id === "string" ? (direct as { id: string }).id : undefined;
  if (!id) throw new AntigravityError("sign-in", `Antigravity project lookup: the account has no Cloud Code project. Set "projectId" in ~/.config/ultraterm/antigravity.json`);
  return id;
}

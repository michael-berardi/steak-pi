import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { authHeadersMatch, beginGoAttempt, observeGoQuota } from "./subscription-first-routing.ts";

type Registry = ExtensionContext["modelRegistry"];
type Provider = NonNullable<ReturnType<Registry["getProvider"]>>;
type Model = NonNullable<ExtensionContext["model"]>;
/** Same-provider Go hop of the default text chain: primary then one pre-output retry. */
export const GO_PRIMARY_MODEL = "deepseek-v4.1-flash";
export const GO_FALLBACK_MODEL = "glm-5.3-flash";
const PRIMARY = GO_PRIMARY_MODEL;
const FALLBACK = GO_FALLBACK_MODEL;
/** Symbol.for keeps the guard idempotent across module reloads. */
export const GO_ROUTING_MARKER = Symbol.for("steak-pi.opencode-go-routing.v1");

/** Only transient failures before any content are eligible. Never retry permission
 * failures or definitive exhaustion of the shared subscription quota. This retry
 * stays on Go; it never selects a metered fallback. */
export function eligibleGoFallback(message: string): boolean {
  if (/abort|cancel|subscription_quota_exceeded|\b(?:400|401|403|404)\b|auth|permission|region|context|invalid/i.test(message)) return false;
  return /\b429\b|\b50[0234]\b|rate.?limit|overloaded|temporar(?:y|ily)|service unavailable/i.test(message);
}

/** Same-provider, explicitly authorized Go policy. Actual response identity is preserved. */
export function withOpenCodeGoRouting(provider: Provider): Provider {
  if (provider.id !== "opencode-go") return provider;
  if ((provider as unknown as Record<symbol, unknown>)[GO_ROUTING_MARKER] === true) return provider;
  const wrap = (method: "stream" | "streamSimple"): Provider["streamSimple"] => (model, context, options) => {
    if (!options?.sessionId) throw new Error("OpenCode Go requires a stable conversation sessionId.");
    const withHeaders = {
      ...options,
      headers: { ...options.headers, "User-Agent": "UltraTerm-SteakPi/0.7.0", "x-opencode-session": options.sessionId },
    };
    const observe = (target: Model, outcome: "success" | "error", message = "") =>
      observeGoQuota(options.apiKey, outcome,
        authHeadersMatch(options.apiKey, target.headers, options.headers) ? message : "", Date.now(), attempt);
    const invoke = (target: Model) => provider[method](target, context, withHeaders);
    // A fresh Go attempt revokes every outstanding exhaustion grant immediately,
    // even when this attempt carries no apiKey or a different one, and returns a
    // generation token that pins this attempt's evidence. A slower concurrent
    // response from an older attempt therefore cannot re-grant paid access after
    // a newer attempt or success. Go has no documented quota API: fail closed.
    const attempt = beginGoAttempt();
    const first = invoke(model);
    const Stream = first.constructor as new () => typeof first;
    const output = new Stream();
    void (async () => {
      let emittedContent = false;
      let terminal = false;
      try {
        for await (const event of first) {
          // A start event is just metadata; content/tool starts permanently prohibit retry.
          if (event.type !== "start" && event.type !== "error") emittedContent = true;
          if (event.type === "error" && model.id === PRIMARY && !emittedContent &&
              !options.signal?.aborted && event.error.stopReason !== "aborted" &&
              eligibleGoFallback(event.error.errorMessage ?? "")) {
            const fallback = provider.getModels().find((m) => m.id === FALLBACK && m.provider === "opencode-go");
            if (fallback) {
              // Do not rewrite the model to the requested primary: transcripts/usage must name GLM.
              for await (const next of invoke(fallback)) {
                if (next.type === "done") observe(fallback, "success");
                if (next.type === "error") observe(fallback, "error", next.error.errorMessage);
                output.push(next);
                if (next.type === "done" || next.type === "error") terminal = true;
              }
              if (!terminal) throw new Error("OpenCode Go fallback stream ended without a terminal event.");
              output.end();
              return;
            }
          }
          if (event.type === "done") observe(model, "success");
          if (event.type === "error") observe(model, "error", event.error.errorMessage);
          output.push(event);
          if (event.type === "done" || event.type === "error") terminal = true;
        }
        if (!terminal) throw new Error("OpenCode Go stream ended without a terminal event.");
        output.end();
      } catch (error) {
        // Never append an error event after this attempt already produced a
        // terminal event; a later transport exception must not redefine the result.
        if (!terminal) {
          // Native adapters normally return error events. Unexpected transport exceptions remain terminal.
          const message = {
            role: "assistant" as const, content: [], api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: options.signal?.aborted ? "aborted" as const : "error" as const,
            errorMessage: error instanceof Error ? error.message : "OpenCode Go stream failed.", timestamp: Date.now(),
          };
          observeGoQuota(options.apiKey, "error", "", Date.now(), attempt);
          output.push({ type: "error", reason: message.stopReason, error: message });
        }
        output.end();
      }
    })();
    return output;
  };
  const routed = { ...provider, stream: wrap("stream") as Provider["stream"], streamSimple: wrap("streamSimple"),
    // Go documents streaming, not deferred generation. Never retrieve an unknown
    // job outside this policy or retry it as a new (potentially duplicate) task.
    ...(provider.fetchDeferred ? { fetchDeferred: () => { throw new Error("OpenCode Go deferred requests are unsupported; use streaming with a stable sessionId."); } } : {}),
  };
  Object.defineProperty(routed, GO_ROUTING_MARKER, { value: true });
  return routed;
}

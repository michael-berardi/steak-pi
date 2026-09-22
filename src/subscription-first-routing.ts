import { createHash } from "node:crypto";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Model = NonNullable<ExtensionContext["model"]>;
type NativeProvider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
type NativeStream = ReturnType<NativeProvider["streamSimple"]>;
let streamFactory: (() => NativeStream) | undefined;
function createNativeStream(): NativeStream {
  if (!streamFactory) {
    // Resolve Pi's already-installed dependency, including nested npm layouts.
    // No extra package, substitute stream implementation, or provider call.
    const sdk = findPackageJSON(import.meta.resolve("@earendil-works/pi-coding-agent"));
    if (!sdk) throw new Error("Native Pi SDK is unavailable.");
    const ai = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdk));
    if (!ai) throw new Error("Native Pi event stream is unavailable.");
    const module = createRequire(sdk)(join(dirname(ai), "dist/utils/event-stream.js"));
    if (typeof module.createAssistantMessageEventStream !== "function") throw new Error("Native Pi event stream is incompatible.");
    streamFactory = module.createAssistantMessageEventStream;
  }
  return streamFactory!();
}
export const SUBSCRIPTION_FIRST_ERROR = "Paid route denied by subscription-first policy. Select an explicitly approved paid profile or a subscription route. No paid fallback was selected.";
const MAX_GRANT_MS = 5 * 60_000;
const STATE = Symbol.for("steak-pi.subscription-first.v1");
const GENERATION = Symbol.for("steak-pi.subscription-first.generation.v1");
const globalState = globalThis as unknown as Record<symbol, unknown>;
const exhausted = (globalState[STATE] ??= new Map<string, number>()) as Map<string, number>;
// One monotonic token per fresh Go attempt. Evidence (error OR success) that is
// labelled with a superseded generation is ignored, so a slower concurrent Go
// response can neither re-open nor close a newer attempt's grant.
const generation = (globalState[GENERATION] ??= { current: 0 }) as { current: number };
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");

/** Route identity matters: provider names alone do not authorize billing exceptions. */
export function isSubscriptionOrLocalRoute(model: Pick<Model, "provider" | "baseUrl">, oauth: boolean): boolean {
  let url: URL;
  try { url = new URL(model.baseUrl); } catch { return false; }
  if (url.username || url.password) return false;
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol)) return true;
  if (url.protocol !== "https:" || url.port) return false;
  if (model.provider === "opencode-go") return url.hostname === "opencode.ai" && /^\/zen\/go(?:\/|$)/.test(url.pathname);
  if (model.provider === "zai") return ["api.z.ai", "open.bigmodel.cn"].includes(url.hostname) && /^\/api\/coding\/paas\/v4(?:\/|$)/.test(url.pathname);
  // The dedicated Singapore Token Plan endpoint spends prepaid subscription
  // credits, not the separate Xiaomi pay-as-you-go account balance.
  if (model.provider === "xiaomi") return url.hostname === "token-plan-sgp.xiaomimimo.com" &&
    /^\/(?:v1|anthropic)\/?$/.test(url.pathname) && !url.search && !url.hash;
  if (!oauth) return false;
  if (model.provider === "openai-codex") return url.hostname === "chatgpt.com" && /^\/backend-api(?:\/|$)/.test(url.pathname);
  if (model.provider === "anthropic") return url.hostname === "api.anthropic.com";
  if (model.provider === "github-copilot") return /^(?:api\.)?githubcopilot\.com$/.test(url.hostname);
  if (model.provider === "google-gemini-cli") return url.hostname === "cloudcode-pa.googleapis.com";
  return false;
}

/** Explicit auth headers must not silently substitute a different billing identity. */
export function authHeadersMatch(key: string | undefined, ...sets: Array<Record<string, string | null> | undefined>): boolean {
  return sets.every(headers => Object.entries(headers ?? {}).every(([name, value]) => {
    const lower = name.toLowerCase();
    if (!/^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie)$/.test(lower)) return true;
    if (!key || typeof value !== "string") return false;
    return lower === "authorization" ? /^Bearer /i.test(value) && value.slice(7) === key
      : ["x-api-key", "api-key", "x-goog-api-key"].includes(lower) && value === key;
  }));
}

/** A fresh Go attempt revokes every outstanding grant, including credentials this
 * attempt does not carry, and bumps the generation so an older concurrent response
 * cannot re-grant paid access afterwards. Go has no documented quota API, so an
 * unproven attempt deliberately fails closed rather than trusting stale evidence.
 */
export function beginGoAttempt(): number {
  exhausted.clear();
  return ++generation.current;
}

/** Only explicit machine-readable subscription exhaustion is evidence. No regex guesses.
 * Go has no documented quota API. Unrecognized responses intentionally leave paid routes
 * blocked. This is NOT an automatic provider fallback and never infers exhaustion from 429.
 */
export function observeGoQuota(key: string | undefined, outcome: "success" | "error", message = "", now = Date.now(), attempt = generation.current): void {
  if (!key) return;
  // Evidence from a superseded attempt must not mutate current grants.
  if (attempt !== generation.current) return;
  const id = fingerprint(key);
  // Any newer observation invalidates stale permission; successful Go always closes it.
  exhausted.delete(id);
  for (const [k, until] of exhausted) if (until <= now) exhausted.delete(k);
  if (outcome === "success" || message.length > 8192) return;
  let value: unknown;
  try { value = JSON.parse(message); } catch { return; }
  const outer = value as { error?: unknown } | null;
  const error = (outer && typeof outer === "object" && outer.error ? outer.error : value) as Record<string, unknown> | null;
  if (!error || typeof error !== "object" || error.status !== 429 || error.code !== "subscription_quota_exceeded" || error.scope !== "subscription" || error.remaining !== 0) return;
  // This deliberately strict evidence contract must not be weakened to vague error text.
  const resetAt = typeof error.reset_at === "string" ? Date.parse(error.reset_at) : NaN;
  if (!Number.isFinite(resetAt) || resetAt <= now) return;
  if (exhausted.size >= 32) exhausted.delete(exhausted.keys().next().value!);
  exhausted.set(id, Math.min(resetAt, now + MAX_GRANT_MS));
}

export function hasConfirmedGoExhaustion(key: string, now = Date.now()): boolean {
  const id = fingerprint(key), until = exhausted.get(id);
  if (until === undefined) return false;
  if (until <= now || until - now > MAX_GRANT_MS) { exhausted.delete(id); return false; }
  return true;
}

/** Credential lookup must not swallow errors: uncertain configuration fails closed. */
export async function assertSubscriptionFirst(
  model: Pick<Model, "provider" | "baseUrl">,
  oauth: boolean,
  getGoKey: () => Promise<string | undefined>,
): Promise<void> {
  if (isSubscriptionOrLocalRoute(model, oauth)) return;
  let key: string | undefined;
  try { key = await getGoKey(); } catch { throw new Error(SUBSCRIPTION_FIRST_ERROR); }
  if (key && !hasConfirmedGoExhaustion(key)) throw new Error(SUBSCRIPTION_FIRST_ERROR);
}

/** Await the billing gate BEFORE invoking a metered adapter (not an event hook). */
export function gatedMeteredStream(model: Model, oauth: boolean | (() => Promise<boolean>),
  getGoKey: () => Promise<string | undefined>, invoke: () => NativeStream,
  signal?: AbortSignal, explicitlyApproved: () => boolean = () => false): NativeStream {
  const output = createNativeStream();
  void (async () => {
    let terminal = false;
    try {
      if (signal?.aborted) throw new Error("Request cancelled before billing authorization.");
      const effectiveOAuth = typeof oauth === "function" ? await oauth() : oauth;
      let evidenceKey: string | undefined;
      if (!explicitlyApproved()) await assertSubscriptionFirst(model, effectiveOAuth, async () => {
        evidenceKey = await getGoKey();
        return evidenceKey;
      });
      // Authorization awaits yield to other Go work. Recheck revocation in the
      // same synchronous turn as adapter invocation, with no intervening await.
      if (evidenceKey && !hasConfirmedGoExhaustion(evidenceKey)) throw new Error(SUBSCRIPTION_FIRST_ERROR);
      if (signal?.aborted) throw new Error("Request cancelled before billing authorization.");
      for await (const event of invoke()) {
        output.push(event);
        if (event.type === "done" || event.type === "error") terminal = true;
      }
      if (!terminal) throw new Error("Provider stream ended without a terminal event.");
    } catch (error) {
      if (!terminal) {
        const reason = signal?.aborted ? "aborted" as const : "error" as const;
        output.push({ type: "error", reason, error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: reason, errorMessage: error instanceof Error ? error.message : "Billing authorization failed.", timestamp: Date.now(),
        } });
      }
    } finally { output.end(); }
  })();
  return output;
}

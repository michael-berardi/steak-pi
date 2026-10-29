import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRetiredSolSelector } from "./retired-model-selection.ts";
import { isRemovedOpenRouterFlash } from "./model-visibility.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
export const FREE_PROVIDER = "openrouter";
export const FREE_MODEL = "minimax/minimax-m3.1-flash:free";
export const FREE_PROFILE = "steak-pi/minimax-m3-1-flash-free";
export const FREE_BASE_URL = "https://openrouter.ai/api/v1";
export const temporaryRoutePath = () => join(homedir(), ".config", "ultraterm", "temporary-worker-route.json");
export class TemporaryFreeRouteConfigError extends Error { override name = "TemporaryFreeRouteConfigError"; }
export class TemporaryFreeRouteUnavailableError extends Error { override name = "TemporaryFreeRouteUnavailableError"; }
export class TemporaryFreeRouteRequestError extends Error { override name = "TemporaryFreeRouteRequestError"; }
export class TemporaryFreeRouteMetadataUnavailableError extends TemporaryFreeRouteUnavailableError {
  override name = "TemporaryFreeRouteMetadataUnavailableError";
  constructor(status = 503) { super(`Temporary free metadata ${status} unavailable; free preference retained, no model request selected.`); }
}
export const RETURN_TO_NORMAL = "TEMPORARY_FREE_ROUTE_RETURN_TO_NORMAL";
/** Never dispatch ambient Codex OAuth from a virtual worker without its account lease. */
export class TemporaryFreeRouteReturnToNormalError extends TemporaryFreeRouteUnavailableError {
  override name = "TemporaryFreeRouteReturnToNormalError";
  readonly code = RETURN_TO_NORMAL;
  constructor() { super(`${RETURN_TO_NORMAL}: preferred free route inactive or unavailable; checkpointed normal-profile job switch required. No Codex request was selected.`); }
}
export interface TemporaryWorkerRoute {
  schemaVersion: 1;
  provider: string; model: string; harness: string; profile: string;
  startsAt: string; expiresAt: string;
  fallbackHarness: "steak-pi"; fallbackProfile: "gpt-6-1-terra" | "gpt-6-1-sol";
  zeroPriceOnly: true; source: string; evidence: string;
}
const failConfig = (): never => { throw new TemporaryFreeRouteConfigError("Temporary worker route configuration denied: invalid, unknown, or unsafe configuration."); };
/** A suffix is necessary, never sufficient: authenticated coordinator data AND fresh
 * official metadata plus a final zero-price wire guard are required for dispatch. */
export function isSupportedTemporaryFreeIdentity(provider: unknown, id: unknown, name = ""): boolean {
  return provider === FREE_PROVIDER && typeof id === "string" && id.length <= 256 &&
    /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/.test(id) &&
    !/(?:^|[^a-z0-9])(?:chat)?gpt/i.test(`${id} ${name}`) &&
    !/(?:^|[/:])(?:zai|z-ai|xiaomi)\/|(?:^|[^a-z0-9])glm(?:[^a-z]|$)|(?:^|[/_. -])(?:openai|codex|mimo|anthropic|claude)/i.test(`${id} ${name}`) &&
    !isRetiredSolSelector(id) && !isRetiredSolSelector(name) &&
    !isRemovedOpenRouterFlash({ provider: FREE_PROVIDER, id: id.replace(/:free$/, "") });
}
export function validateTemporaryWorkerRoute(value: unknown): TemporaryWorkerRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failConfig();
  const v = value as Record<string, unknown>;
  const keys = ["schemaVersion", "provider", "model", "harness", "profile", "startsAt", "expiresAt", "fallbackHarness", "fallbackProfile", "zeroPriceOnly", "source", "evidence"];
  if (Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key)) || v.schemaVersion !== 1 ||
      v.zeroPriceOnly !== true || v.fallbackHarness !== "steak-pi" || !["gpt-6-1-terra", "gpt-6-1-sol"].includes(v.fallbackProfile as string) ||
      !isSupportedTemporaryFreeIdentity(v.provider, v.model) || v.harness !== "steak-pi" ||
      !(v.profile === "preferred-free" || (v.model === FREE_MODEL && v.profile === "minimax-m3-1-flash-free"))) return failConfig();
  for (const key of ["source", "evidence"]) if (typeof v[key] !== "string" || !(v[key] as string).trim() || (v[key] as string).length > 4096) return failConfig();
  const utc = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s.replace(/Z$/, s.includes(".") ? "Z" : ".000Z");
  if (!utc(v.startsAt) || !utc(v.expiresAt)) return failConfig();
  const duration = Date.parse(v.expiresAt) - Date.parse(v.startsAt);
  if (duration <= 0 || duration > 72 * 60 * 60_000) return failConfig();
  return { ...v, startsAt: new Date(v.startsAt).toISOString(), expiresAt: new Date(v.expiresAt).toISOString() } as unknown as TemporaryWorkerRoute;
}
function parseUniqueConfig(text: string): TemporaryWorkerRoute {
  const keys = new Set<string>();
  // Scan actual JSON string tokens, not quoted text inside source/evidence.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    const start = i++;
    for (; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === '"') break; }
    const token = text.slice(start, i + 1);
    if (/^\s*:/.test(text.slice(i + 1))) {
      const key = JSON.parse(token) as string;
      if (keys.has(key)) return failConfig();
      keys.add(key);
    }
  }
  return validateTemporaryWorkerRoute(JSON.parse(text));
}
let localCache: { path: string; signature: string; config: TemporaryWorkerRoute } | undefined;
const signature = (s: ReturnType<typeof fstatSync>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}:${s.uid}:${s.nlink}`;
/** Private bounded no-follow reads, with metadata cache; no poller or activation API. */
export function readTemporaryWorkerRoute(path = temporaryRoutePath()): TemporaryWorkerRoute | undefined {
  let fd: number | undefined;
  try {
    let current = dirname(path);
    for (;;) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || (stat.uid !== 0 && stat.uid !== process.getuid?.())) return failConfig();
      if (current === parse(current).root) break;
      current = dirname(current);
    }
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()) return failConfig();
    const sig = signature(stat);
    if (localCache?.path === path && localCache.signature === sig) return { ...localCache.config };
    const buffer = Buffer.alloc(16_385);
    let length = 0, count: number;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    if (length > 16_384 || length !== stat.size || signature(fstatSync(fd)) !== sig || signature(lstatSync(path)) !== sig) return failConfig();
    const config = parseUniqueConfig(buffer.subarray(0, length).toString("utf8"));
    localCache = { path, signature: sig, config };
    return { ...config };
  } catch (error) {
    localCache = undefined;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof TemporaryFreeRouteConfigError) throw error;
    return failConfig();
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function temporaryWorkerRouteStatus(config = readTemporaryWorkerRoute(), now = Date.now()) {
  const state = !config ? "absent" : now < Date.parse(config.startsAt) ? "pending" : now >= Date.parse(config.expiresAt) ? "expired" : "active";
  return { state, config, observedModel: undefined, note: "Selection intent only; actual answering model requires the run/request receipt." };
}
export function activeTemporaryWorkerRoute(path = temporaryRoutePath(), now = Date.now()): TemporaryWorkerRoute | undefined {
  const status = temporaryWorkerRouteStatus(readTemporaryWorkerRoute(path), now);
  return status.state === "active" ? status.config : undefined;
}
export function isTemporaryFreeModel(model: Pick<Model, "provider" | "id">): boolean {
  // All OpenRouter :free calls take this strict gate, including forbidden identities.
  return model.provider === FREE_PROVIDER && model.id.endsWith(":free");
}
const metadata = new Map<string, { model: Model; until: number }>();
const inflight = new Map<string, Promise<Model>>();
const METADATA_TTL_MS = 5 * 60_000;
const denyMetadata = (): never => { throw new TemporaryFreeRouteRequestError("Temporary free route denied: fresh official zero-price text/tool/reasoning metadata required."); };
function zeroPrices(value: any): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    ["prompt", "completion"].every(k => Object.hasOwn(value, k)) &&
    Object.values(value).every(p => (typeof p === "string" && /^(?:0+(?:\.0+)?)(?:e[+-]?\d+)?$/i.test(p)) || p === 0);
}
const capable = (p: unknown): boolean => Array.isArray(p) && ["tools", "tool_choice"].every(k => p.includes(k)) && (p.includes("reasoning") || p.includes("reasoning_effort"));
async function officialJSON(url: string, fetcher: typeof fetch, limit: number): Promise<any> {
  let response: Response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: "error", headers: { Accept: "application/json" } }); }
  catch { throw new TemporaryFreeRouteMetadataUnavailableError(); }
  if (response.status === 429 || response.status >= 500) throw new TemporaryFreeRouteMetadataUnavailableError(response.status);
  if (!response.ok || !response.body) return denyMetadata();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read().catch(() => { throw new TemporaryFreeRouteMetadataUnavailableError(); }); if (done) break; size += value.length; if (size > limit) return denyMetadata(); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}
/** Lazy official metadata only, never a model call; concurrent requests share proof.
 * Exported fetch seam is for isolated synthetic checks, not configuration URLs. */
export async function ensureTemporaryFreeMetadata(id: string, fetcher: typeof fetch = fetch): Promise<Model> {
  if (!isSupportedTemporaryFreeIdentity(FREE_PROVIDER, id)) return denyMetadata();
  const cached = metadata.get(id);
  if (cached && cached.until > Date.now()) return cached.model;
  const pending = inflight.get(id); if (pending) return pending;
  if (inflight.size >= 32) return denyMetadata();
  const work = (async () => {
    const catalog = await officialJSON(`${FREE_BASE_URL}/models`, fetcher, 16 * 1024 * 1024);
    const matches = Array.isArray(catalog?.data) ? catalog.data.filter((m: any) => m.id === id) : [];
    if (matches.length !== 1) return denyMetadata();
    const m = matches[0];
    if (!isSupportedTemporaryFreeIdentity(FREE_PROVIDER, id, m.name) || !zeroPrices(m.pricing) || !capable(m.supported_parameters) ||
        !m.architecture?.input_modalities?.includes("text") || !m.architecture?.output_modalities?.includes("text") ||
        !Number.isSafeInteger(m.context_length) || m.context_length <= 0 ||
        !Number.isSafeInteger(m.top_provider?.max_completion_tokens) || m.top_provider.max_completion_tokens <= 0) return denyMetadata();
    const [author, slug] = id.split("/");
    const endpoints = await officialJSON(`${FREE_BASE_URL}/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`, fetcher, 1024 * 1024);
    if (endpoints?.data?.id !== id || !Array.isArray(endpoints.data.endpoints) ||
        !endpoints.data.endpoints.some((e: any) => zeroPrices(e.pricing) && capable(e.supported_parameters))) return denyMetadata();
    const model: Model = { id, name: m.name || id, provider: FREE_PROVIDER, api: "openai-completions", baseUrl: FREE_BASE_URL,
      reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: m.context_length, maxTokens: m.top_provider.max_completion_tokens };
    if (metadata.size >= 32) metadata.delete(metadata.keys().next().value!);
    metadata.set(id, { model, until: Date.now() + METADATA_TTL_MS });
    return model;
  })();
  inflight.set(id, work);
  try { return await work; } catch (error) {
    metadata.delete(id);
    if (error instanceof TemporaryFreeRouteMetadataUnavailableError) throw error;
    return denyMetadata();
  } finally { inflight.delete(id); }
}
export function assertTemporaryFreeRequest(model: Model, path = temporaryRoutePath(), now = Date.now(), requireProof = true): void {
  const config = activeTemporaryWorkerRoute(path, now);
  if (!config || config.provider !== model.provider || config.model !== model.id) throw new TemporaryFreeRouteUnavailableError("Temporary free route inactive or ended; no request or paid fallback was selected.");
  const proof = metadata.get(model.id);
  if (!isSupportedTemporaryFreeIdentity(model.provider, model.id, model.name) || (requireProof && (!proof || proof.until <= now)) || model.api !== "openai-completions" || model.baseUrl !== FREE_BASE_URL ||
      !model.cost || [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some(price => price !== 0)) throw new TemporaryFreeRouteRequestError("Temporary free route denied: exact endpoint and fresh known zero prices required; no paid fallback was selected.");
}
/** Final payload guard AFTER the caller hook, immediately before native transport. */
export function protectTemporaryFreePayload(payload: unknown, expectedModel = FREE_MODEL): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TemporaryFreeRouteRequestError("Temporary free route denied: invalid request payload.");
  const p = payload as Record<string, unknown>;
  if (!isSupportedTemporaryFreeIdentity(FREE_PROVIDER, expectedModel) || p.model !== expectedModel || ["models", "route", "plugins", "transforms", "web_search_options"].some(key => key in p) ||
      (p.tool_choice !== undefined && p.tool_choice !== "auto")) throw new TemporaryFreeRouteRequestError("Temporary free route denied: alternate models, paid extensions, and unsupported tool choice are forbidden.");
  return { ...p, reasoning: { effort: "high" }, provider: { allow_fallbacks: false, require_parameters: true,
    max_price: { prompt: 0, completion: 0, request: 0, image: 0, audio: 0, video: 0, input_audio: 0, output_audio: 0, input_cache_read: 0, input_cache_write: 0, internal_reasoning: 0, web_search: 0 } } };
}
export function temporaryFreeOptions<T extends { onPayload?: (payload: unknown, model: Model) => unknown | Promise<unknown> }>(model: Model, options?: T): T {
  assertTemporaryFreeRequest(model);
  return { ...options, onPayload: async (payload: unknown, actual: Model) => {
    const replacement = await options?.onPayload?.(payload, actual);
    assertTemporaryFreeRequest(model); assertTemporaryFreeRequest(actual);
    if (actual.provider !== model.provider || actual.id !== model.id) throw new TemporaryFreeRouteRequestError("Temporary free route physical identity changed.");
    return protectTemporaryFreePayload(replacement === undefined ? payload : replacement, model.id);
  } } as T;
}
const CATALOG_MARK = Symbol.for("steak-pi.temporary-free-catalog.v2");
/** Dynamic complete-provider composition preserves built-in transport/auth/models. */
export function withTemporaryFreeCatalog(provider: Provider): Provider {
  if (provider.id !== FREE_PROVIDER || (provider as unknown as Record<symbol, unknown>)[CATALOG_MARK]) return provider;
  // Preserve the original physical MiniMax alias for synchronous CLI selection.
  // These limits are display metadata ONLY; dispatch still needs fresh proof.
  const alias: Model = { id: FREE_MODEL, name: "MiniMax M3.1 Flash (free)", provider: FREE_PROVIDER, api: "openai-completions", baseUrl: FREE_BASE_URL,
    reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 524_288 };
  const additions = () => [alias, ...[...metadata.values()].map(e => e.model)];
  const augmented: Provider = { ...provider, getModels: () => {
    const builtins = provider.getModels();
    return [...builtins, ...additions().filter((e, index, all) => !builtins.some(m => m.id === e.id) && all.findLastIndex(m => m.id === e.id) === index)];
  }, ...(provider.getAllModels ? { getAllModels: () => {
    const builtins = provider.getAllModels!();
    return [...builtins, ...additions().filter((e, index, all) => !builtins.some(m => m.id === e.id) && all.findLastIndex(m => m.id === e.id) === index)];
  } } : {}) };
  // Keep this marker through native guard/provider spreads to avoid nesting on turns.
  Object.defineProperty(augmented, CATALOG_MARK, { value: true, enumerable: true });
  return augmented;
}
export function temporaryFreeStartupProvider(): Provider {
  const sdk = findPackageJSON(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const ai = sdk && findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdk));
  if (!sdk || !ai) throw new TemporaryFreeRouteUnavailableError("Native OpenRouter provider unavailable.");
  const { openrouterProvider } = createRequire(sdk)(join(dirname(ai), "dist/providers/openrouter.js"));
  if (typeof openrouterProvider !== "function") throw new TemporaryFreeRouteUnavailableError("Native OpenRouter provider unavailable.");
  return withTemporaryFreeCatalog(openrouterProvider());
}
export const PREFERRED_FREE_PROFILE = "steak-pi/preferred-free";
export const PREFERRED_FREE_MODEL = "preferred-free";
export const preferredFreeMetadata = {
  provider: "steak-pi", id: PREFERRED_FREE_MODEL, name: "Preferred approved free worker (temporary)",
  thinkingLevels: ["high"] as const, input: ["text"] as ("text" | "image")[],
};
type RouteRegistry = Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth" | "isUsingOAuth">;
/** Every request resolves a physical model. NEVER route unleased Sol in steak-pi's
 * namespace: backend must checkpoint/switch the settled job using normal ownership. */
export async function selectPreferredFreePhysical(registry: RouteRegistry): Promise<{ model: Model; thinkingLevel: "high" }> {
  const config = activeTemporaryWorkerRoute();
  if (!config) throw new TemporaryFreeRouteReturnToNormalError();
  try { await ensureTemporaryFreeMetadata(config.model); }
  catch (error) {
    if (error instanceof TemporaryFreeRouteMetadataUnavailableError) throw error;
    throw new TemporaryFreeRouteReturnToNormalError();
  }
  // Activation/expiry/revocation may race the lazy metadata fetch.
  const current = activeTemporaryWorkerRoute();
  if (!current || JSON.stringify(current) !== JSON.stringify(config)) throw new TemporaryFreeRouteReturnToNormalError();
  const candidate = registry.find(config.provider, config.model);
  if (!candidate || !registry.hasConfiguredAuth(candidate)) throw new TemporaryFreeRouteReturnToNormalError();
  try { assertTemporaryFreeRequest(candidate); }
  catch (error) { if (error instanceof TemporaryFreeRouteConfigError) throw error; throw new TemporaryFreeRouteReturnToNormalError(); }
  return { model: candidate, thinkingLevel: "high" };
}

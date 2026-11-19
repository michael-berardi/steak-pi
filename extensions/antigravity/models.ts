// The model list comes from the provider on every refresh. No model id appears in this source: a test fails if one does.
import type { Model } from "@earendil-works/pi-ai";
import { callJson, type CallOptions, type Session } from "./client.ts";
import { API_ID, PROVIDER_ID, type AntigravityConfig } from "./config.ts";
import { AntigravityError } from "./errors.ts";

/** Limits assumed only when the provider's entry names none. Stated in docs/ANTIGRAVITY.md. */
export const ASSUMED_CONTEXT_WINDOW = 128_000;
export const ASSUMED_MAX_OUTPUT = 8_192;

/** The model list is the one large reply: cap it at 8 MiB. */
export const MODEL_LIST_MAX_BYTES = 8 * 1024 * 1024;

const SAFE_ID = /^[a-z0-9][a-z0-9_.-]*$/i;
// Internal placeholders, editor tab/chat models and image generators are not chat models for Pi.
const NOT_CHAT = /^(?:MODEL_|chat_|tab_)|image/i;

export type RawModel = Record<string, unknown>;

const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);

/** One entry of the provider's list -> a Pi model, or undefined when it is not a usable chat model. */
export function modelFromEntry(config: AntigravityConfig, id: string, entry: unknown): Model<typeof API_ID> | undefined {
  if (!SAFE_ID.test(id) || NOT_CHAT.test(id)) return undefined;
  const raw: RawModel = entry && typeof entry === "object" ? (entry as RawModel) : {};
  if (raw.disabled === true || raw.isInternal === true) return undefined;
  const name = [raw.displayName, raw.label].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? id;
  return {
    id,
    name,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: config.baseUrls[0],
    input: raw.supportsImages === true ? ["text", "image"] : ["text"],
    reasoning: raw.supportsThinking === true,
    // Access is quota-backed by the signed-in account, not billed per token.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: positive(raw.maxTokens) ?? ASSUMED_CONTEXT_WINDOW,
    maxTokens: positive(raw.maxOutputTokens) ?? ASSUMED_MAX_OUTPUT,
  };
}

export async function listModels(config: AntigravityConfig, session: Session, options: CallOptions = {}): Promise<Model<typeof API_ID>[]> {
  const data = await callJson(config, session, "/v1internal:fetchAvailableModels", { project: session.projectId }, "model list", { maxBodyBytes: MODEL_LIST_MAX_BYTES, ...options });
  const models = data.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new AntigravityError("protocol", "Antigravity model list: the reply has no `models` object");
  }
  const out = Object.entries(models as Record<string, unknown>).flatMap(([id, entry]) => { const m = modelFromEntry(config, id, entry); return m ? [m] : []; });
  if (out.length === 0) throw new AntigravityError("protocol", "Antigravity model list: the provider returned no usable chat models for this account");
  return out;
}

/**
 * The generic local profile: one model slotted into the `local` provider.
 *
 * `planProfile` turns a GGUF header and this machine's memory into the two things `add` writes:
 *  - the Pi `models.json` model entry (context, token limit, reasoning controls, sampling when the file has any);
 *  - the launch profile `steak-pi local start` reads (source, context, port, extra server arguments).
 * Nothing here names a model: everything is derived from the file and the hardware.
 */
import { basename } from "node:path";
import type { GgufInfo } from "./gguf.ts";
import { CACHE_RAM_MIB, gib, HEADROOM_BYTES, kvBytesPerToken, sizeContext, startNeedBytes } from "./hardware.ts";

export const PROVIDER = "local";
export const DEFAULT_PORT = 8089;
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type Source = { kind: "file"; path: string } | { kind: "hf"; spec: string };
export type Reasoning = { kind: "none" } | { kind: "toggle" } | { kind: "effort"; values: string[] };

export interface LaunchProfile {
  id: string;
  source: Source;
  ctx: number;
  port: number;
  modelBytes: number;
  kvBytesPerToken: number;
  /** Appended to the llama-server command line (after `--` on `add`). */
  extraArgs: string[];
}

const RANKED_EFFORTS = ["low", "medium", "high", "xhigh"];
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
// Where each Pi thinking level sits on the low..xhigh scale.
const LEVEL_RANK: Record<(typeof PI_LEVELS)[number], number> = { off: 0, minimal: 0, low: 0, medium: 1, high: 2, xhigh: 3, max: 3 };

/** What the chat template can be told about reasoning. */
export function detectReasoning(template: string | undefined): Reasoning {
  if (!template) return { kind: "none" };
  if (/reasoning_effort/.test(template)) {
    const seen = RANKED_EFFORTS.filter((value) => new RegExp(`['"]${value}['"]`).test(template));
    return { kind: "effort", values: seen.length ? seen : ["low", "medium", "high"] };
  }
  if (/enable_thinking/.test(template)) return { kind: "toggle" };
  return { kind: "none" };
}

/** Each Pi thinking level mapped to the nearest effort the template knows (ties go up). */
export function effortMap(values: readonly string[]): Record<string, string> {
  const rank = (value: string) => RANKED_EFFORTS.indexOf(value);
  return Object.fromEntries(PI_LEVELS.map((level) => {
    const want = LEVEL_RANK[level];
    const pick = [...values].sort((a, b) => Math.abs(rank(a) - want) - Math.abs(rank(b) - want) || rank(b) - rank(a))[0];
    return [level, pick];
  }));
}

/** A model id from a file name or an `owner/repo:quant` spec. */
export function idFromSource(source: Source): string {
  const raw = source.kind === "file"
    ? basename(source.path).replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/i, "")
    : source.spec.replace(/^.*\//, "").replace(":", "-");
  return raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 64);
}

export interface PlanInput {
  id: string;
  source: Source;
  info: GgufInfo;
  /** Bytes of all shards when the model is split. */
  modelBytes: number;
  totalBytes: number;
  port: number;
  requestedCtx?: number;
  extraArgs?: string[];
}
export interface Plan {
  profile: LaunchProfile;
  /** The model entry for the Pi `models.json` `local` provider. */
  model: Record<string, unknown>;
  /** What was chosen and why, one line each. */
  lines: string[];
}
export class PlanError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) { super(detail); this.code = code; }
}

export function planProfile(input: PlanInput): Plan {
  const { info, id } = input;
  const kv = kvBytesPerToken(info);
  const size = sizeContext({ totalBytes: input.totalBytes, modelBytes: input.modelBytes, kvBytesPerToken: kv.bytesPerToken, nativeCtx: info.contextLength, requestedCtx: input.requestedCtx });
  if (!size.ok) throw new PlanError(size.cause, size.detail);
  const reasoning = detectReasoning(info.chatTemplate);
  const baseUrl = `http://127.0.0.1:${input.port}/v1`;
  const maxTokens = Math.min(16384, size.ctx / 4);
  const model: Record<string, unknown> = {
    id,
    name: `${info.name ?? id} (local)`,
    baseUrl,
    reasoning: reasoning.kind !== "none",
    input: ["text"],
    contextWindow: size.ctx,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(Object.keys(info.sampling).length ? { samplingParams: info.sampling } : {}),
  };
  if (reasoning.kind === "effort") {
    model.thinkingLevelMap = effortMap(reasoning.values);
    model.compat = { thinkingFormat: "chat-template", chatTemplateKwargs: { reasoning_effort: { $var: "thinking.effort" } } };
  } else if (reasoning.kind === "toggle") {
    model.compat = { thinkingFormat: "chat-template", chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } };
  }
  const profile: LaunchProfile = {
    id, source: input.source, ctx: size.ctx, port: input.port, modelBytes: input.modelBytes,
    kvBytesPerToken: kv.bytesPerToken, extraArgs: input.extraArgs ?? [],
  };
  const perToken = `${(kv.bytesPerToken / 1024).toFixed(1)} KiB/token`;
  const lines = [
    `model     ${info.architecture}, ${gib(input.modelBytes)} of weights${info.contextLength ? `, native context ${info.contextLength}` : ""}`,
    `context   ${size.ctx} tokens: ${gib(input.totalBytes)} RAM - ${gib(HEADROOM_BYTES)} headroom - ${gib(input.modelBytes)} weights leaves ${gib(size.roomBytes)}; `
      + `the q8_0 KV cache is ${kv.estimated ? `assumed ${perToken} (the file does not describe its attention)` : perToken}, so ${size.fitCtx} would fit; `
      + `capped at ${size.cap} by ${size.capReason}, rounded down to a power of two${size.shrunkFrom ? `; you asked for ${size.shrunkFrom}` : ""}`,
    `server    1 slot, flash attention on, q8_0 KV cache, --jinja, port ${input.port}; starting needs about ${gib(startNeedBytes(input.modelBytes, size.ctx, kv.bytesPerToken))} free`,
    `thinking  ${reasoning.kind === "effort" ? `reasoning_effort through the chat template (${reasoning.values.join(", ")})`
      : reasoning.kind === "toggle" ? "enable_thinking through the chat template (on/off)" : "plain: the chat template has no reasoning controls"}`,
    `sampling  ${Object.keys(info.sampling).length ? `from the file: ${Object.entries(info.sampling).map(([key, value]) => `${key} ${value}`).join(", ")}` : "the server's defaults (the file carries none)"}`,
  ];
  return { profile, model, lines };
}

/** llama-server arguments for a profile (the binary itself is found separately). */
export function serverArgs(profile: LaunchProfile): string[] {
  return [
    ...(profile.source.kind === "file" ? ["-m", profile.source.path] : ["-hf", profile.source.spec]),
    "--host", "127.0.0.1", "--port", String(profile.port),
    "-c", String(profile.ctx), "-np", "1", "-ngl", "999", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0",
    "--jinja",
    "--cache-ram", String(CACHE_RAM_MIB), "--no-webui",
    ...profile.extraArgs,
  ];
}

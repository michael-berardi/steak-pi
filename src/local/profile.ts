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
import type { LimitsConfig } from "./limits.ts";
import { LocalError } from "./errors.ts";

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
  /** The local route's own limits (request size, duty cycle, GPU headroom). Absent: the defaults in `limits.ts`. */
  limits?: LimitsConfig;
  /** Server launch settings that change GPU load. Absent: the defaults below. */
  server?: ServerConfig;
}

/**
 * Server settings that change how much GPU a request costs. Every one is optional and every one is overridable from
 * the profile file; a value the profile sets explicitly is never replaced by a default.
 */
export interface ServerConfig {
  /** Parallel slots. One is right for a single-GPU machine: more slots mean more concurrent GPU work, not more speed. */
  slots?: number;
  /** llama.cpp's logical batch size (`--batch-size`); unset means the server's own default. */
  batchSize?: number;
  /** llama.cpp's physical batch size (`--ubatch-size`); unset means the server's own default. */
  ubatchSize?: number;
  /** Draft tokens per step when speculative decoding is on (`--spec-draft-n-max`). */
  specDraftMax?: number;
}

/**
 * Output tokens one request may generate. A coding turn's answer is a few hundred to a few thousand tokens; at the
 * 53 ms/token measured on a 27B model of this class, 4096 is about 3.5 minutes of generation, where the 16384 the
 * route used to ask for was about 14.5 minutes of GPU time for output a turn rarely needs.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
/** One parallel slot: the server serialises requests anyway, and a second slot only adds GPU work. */
export const DEFAULT_SLOTS = 1;
/**
 * llama.cpp's logical batch: how many tokens one submission may cover. llama.cpp defaults to 2048, so a single prefill
 * submission can occupy the GPU for thousands of tokens' worth of work — at the 2.1-2.9 ms/token measured for prompt
 * evaluation on a 27B model of this class, that is 4-6 s of uninterrupted GPU time per submission, and a small
 * desktop GPU submission queued behind it waits for all of it. A pause between requests cannot shorten a submission; a
 * smaller batch can, because the driver gets the GPU back between submissions. 512 keeps the prompt cache useful and
 * bounds one submission to about 1-1.5 s.
 *
 * UNVERIFIED LIVE: this needs a server restart to take effect, and the responsiveness measurement for it has not been
 * run (the earlier probe round measured pauses and a QoS clamp, not batch sizes). It is a validated, overridable
 * default, and the first thing to raise if prefill throughput matters more than the desktop's tail latency.
 */
export const DEFAULT_BATCH_SIZE = 512;
/** llama.cpp's physical batch: the part of a logical batch submitted at once (llama.cpp defaults to 512). One quarter
 * of the logical batch keeps a single physical submission near 0.4 s of GPU time at the measured prompt-eval rate. */
export const DEFAULT_UBATCH_SIZE = 128;
/**
 * Draft tokens per speculative step, for a profile that turns speculative decoding on without choosing a depth itself.
 * Draft acceptance measured on a large model with a built-in draft head: 52% in the window that motivated this change,
 * 61% mean over the 2,142 requests in the server log. Either way a good share of the drafts is thrown away, and every draft is
 * GPU work, so a shallower step spends less of it for most of the speed-up. A profile that sets `--spec-draft-n-max`
 * itself keeps its own value: this default never replaces an explicit choice.
 */
export const DEFAULT_SPEC_DRAFT_MAX = 2;

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
  const maxTokens = Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(size.ctx / 4)));
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

const badServer = (detail: string): never => { throw new LocalError("bad-server", detail); };
const wholeNumber = (value: unknown, key: string, min: number, max: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : badServer(`${key} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)})`);

/**
 * The server settings a profile asks for, validated. Throws `LocalError("bad-server")` naming the offending key, so a
 * typo is refused before a server is started rather than silently ignored.
 */
export function resolveServer(profile: Pick<LaunchProfile, "server" | "extraArgs">): Required<ServerConfig> {
  const config = profile.server;
  if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config))) badServer(`server must be an object (got ${JSON.stringify(config)})`);
  const server = (config ?? {}) as ServerConfig;
  const known = ["slots", "batchSize", "ubatchSize", "specDraftMax"];
  const unknown = Object.keys(server).find((key) => !known.includes(key));
  if (unknown !== undefined) badServer(`unknown key server.${unknown} (known: ${known.map((key) => `server.${key}`).join(", ")})`);
  const batchSize = server.batchSize === undefined ? DEFAULT_BATCH_SIZE : wholeNumber(server.batchSize, "server.batchSize", 1, 8192);
  const ubatchSize = server.ubatchSize === undefined ? DEFAULT_UBATCH_SIZE : wholeNumber(server.ubatchSize, "server.ubatchSize", 1, 8192);
  if (ubatchSize > batchSize) badServer(`server.ubatchSize (${ubatchSize}) must not exceed server.batchSize (${batchSize})`);
  return {
    slots: server.slots === undefined ? DEFAULT_SLOTS : wholeNumber(server.slots, "server.slots", 1, 8),
    specDraftMax: server.specDraftMax === undefined ? DEFAULT_SPEC_DRAFT_MAX : wholeNumber(server.specDraftMax, "server.specDraftMax", 1, 16),
    batchSize, ubatchSize,
  };
}

const hasFlag = (args: readonly string[], flag: string): boolean => args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));

/**
 * llama-server arguments for a profile (the binary itself is found separately).
 *
 * Three of these change how much GPU a request costs, and each is a default the profile file can override:
 *  - `-np` (parallel slots): one, because the server serialises requests anyway and a second slot only adds GPU work;
 *  - `--spec-draft-n-max`: two, but only when the profile turns speculative decoding on and does not choose a depth
 *    itself (a profile that sets it keeps its own value);
 *  - `--batch-size` / `--ubatch-size`: a bound on how long one GPU submission may be, which is what the desktop
 *    actually waits behind. The defaults above are the untested proposal from the GPU report, shipped as overridable
 *    defaults and marked unverified live.
 * A flag the profile already passes in its extra arguments is never emitted twice: an explicit choice wins.
 */
export function serverArgs(profile: LaunchProfile): string[] {
  const server = resolveServer(profile);
  const extra = profile.extraArgs;
  const specOn = hasFlag(extra, "--spec-type");
  const specDepthSet = hasFlag(extra, "--spec-draft-n-max");
  return [
    ...(profile.source.kind === "file" ? ["-m", profile.source.path] : ["-hf", profile.source.spec]),
    "--host", "127.0.0.1", "--port", String(profile.port),
    "-c", String(profile.ctx), "-np", String(server.slots), "-ngl", "999", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0",
    "--jinja",
    "--cache-ram", String(CACHE_RAM_MIB), "--no-webui",
    ...(hasFlag(extra, "-b") || hasFlag(extra, "--batch-size") ? [] : ["--batch-size", String(server.batchSize)]),
    ...(hasFlag(extra, "-ub") || hasFlag(extra, "--ubatch-size") ? [] : ["--ubatch-size", String(server.ubatchSize)]),
    ...(specOn && !specDepthSet ? ["--spec-draft-n-max", String(server.specDraftMax)] : []),
    ...extra,
  ];
}

/**
 * The local route's own limits: how large a request may be, how much idle time sits between two requests, and how
 * much GPU headroom a request start waits for.
 *
 * A local model server is the only route that runs on this machine's own GPU, so it is the only route that can pin it.
 * Three rules keep it from doing so, and all three are decided here as pure functions so they can be tested without a
 * GPU, a clock or a server:
 *
 *  - **request size** — an output-token cap per request and a prompt cap relative to the server's context. A prompt
 *    over the cap is never truncated: the route compacts through Pi's own compaction path (the per-model reserve) or
 *    refuses the request with a named error;
 *  - **duty cycle** — after a request finishes, the next one starts only after an idle gap derived from the previous
 *    request's duration and a target duty cycle, capped so a turn is never held for long;
 *  - **headroom** — a request start waits while the GPU is at or above a high-water mark, until it has been at or
 *    below a low-water mark for a couple of samples, bounded by a maximum deferral after which it proceeds and says so.
 *
 * Every number is a generic default the operator's profile file can override (`limits` in
 * `~/.pi/agent/local/profiles/<id>.json`), and every override is validated: a typo is a named error, never a silent
 * no-op. Nothing here names a model, a provider or a machine.
 */
import { LocalError } from "./errors.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, type LaunchProfile } from "./profile.ts";

export { DEFAULT_MAX_OUTPUT_TOKENS };
/** The share of the server's context a prompt may fill before the local route compacts earlier than a remote one. */
export const DEFAULT_PROMPT_CAP_RATIO = 0.75;
/** Share of wall time the local route aims to keep the GPU busy. */
export const DEFAULT_DUTY_TARGET = 0.85;
/** Longest idle gap the duty-cycle pacing will insert between two requests (the profile may raise it to 30 min). */
export const DEFAULT_MAX_GAP_MS = 10_000;
/** GPU utilisation at or above which a request start waits (95 = 5% headroom). */
export const DEFAULT_HIGH_WATER = 95;
/** GPU utilisation at or below which the wait clears. */
export const DEFAULT_LOW_WATER = 85;
/** Consecutive samples at or below the low-water mark needed to clear the wait. */
export const DEFAULT_CONFIRM_SAMPLES = 2;
/** Longest a request start is deferred before it proceeds anyway. */
export const DEFAULT_MAX_DEFER_MS = 30_000;
/** How often the GPU is sampled while a start is waiting. */
export const DEFAULT_SAMPLE_MS = 2_000;
/** Timeout for one GPU probe. */
export const PROBE_TIMEOUT_MS = 2_000;

export interface DutyConfig { target: number; maxGapMs: number }
export interface HeadroomConfig { highWater: number; lowWater: number; confirmSamples: number; maxDeferMs: number }
export interface LocalLimits {
  maxOutputTokens: number;
  promptCapRatio: number;
  /** `undefined` when the operator turned the pacing off. */
  duty: DutyConfig | undefined;
  /** `undefined` when the operator turned the headroom check off. */
  headroom: HeadroomConfig | undefined;
}

/** The `limits` block of a launch profile: every key optional, `"off"` turns a rule off. */
export interface LimitsConfig {
  maxOutputTokens?: number;
  promptCapRatio?: number;
  duty?: { target?: number; maxGapMs?: number } | "off";
  headroom?: { highWater?: number; lowWater?: number; confirmSamples?: number; maxDeferMs?: number } | "off";
}

const bad = (detail: string): never => { throw new LocalError("bad-limit", detail); };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function integer(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return bad(`${key} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)})`);
  }
  return value;
}
function fraction(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    return bad(`${key} must be a number from ${min} to ${max} (got ${JSON.stringify(value)})`);
  }
  return value;
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) bad(`unknown key ${prefix}${unknown} (known: ${allowed.map((key) => `${prefix}${key}`).join(", ")})`);
}

/**
 * The limits a profile enforces: the defaults above, with the profile file's `limits` block applied on top.
 * Throws `LocalError("bad-limit")` naming the offending key.
 */
export function resolveLimits(profile: Pick<LaunchProfile, "ctx" | "limits">): LocalLimits {
  const ctx = profile.ctx;
  const config = profile.limits;
  if (config !== undefined && !isObject(config)) bad(`limits must be an object (got ${JSON.stringify(config)})`);
  const limits = (config ?? {}) as LimitsConfig;
  onlyKeys(limits as Record<string, unknown>, ["maxOutputTokens", "promptCapRatio", "duty", "headroom"], "limits.");
  const maxOutputTokens = limits.maxOutputTokens === undefined
    ? Math.min(DEFAULT_MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(ctx / 4)))
    : integer(limits.maxOutputTokens, "limits.maxOutputTokens", 1, Math.max(1, ctx));
  const promptCapRatio = limits.promptCapRatio === undefined
    ? DEFAULT_PROMPT_CAP_RATIO
    : fraction(limits.promptCapRatio, "limits.promptCapRatio", 0.1, 1);
  let duty: DutyConfig | undefined;
  if (limits.duty === "off") duty = undefined;
  else if (limits.duty === undefined) duty = { target: DEFAULT_DUTY_TARGET, maxGapMs: DEFAULT_MAX_GAP_MS };
  else {
    if (!isObject(limits.duty)) bad(`limits.duty must be an object or "off" (got ${JSON.stringify(limits.duty)})`);
    onlyKeys(limits.duty, ["target", "maxGapMs"], "limits.duty.");
    duty = {
      target: limits.duty.target === undefined ? DEFAULT_DUTY_TARGET : fraction(limits.duty.target, "limits.duty.target", 0.05, 0.99),
      maxGapMs: limits.duty.maxGapMs === undefined ? DEFAULT_MAX_GAP_MS : integer(limits.duty.maxGapMs, "limits.duty.maxGapMs", 0, 1_800_000),
    };
  }
  let headroom: HeadroomConfig | undefined;
  if (limits.headroom === "off") headroom = undefined;
  else if (limits.headroom === undefined) {
    headroom = { highWater: DEFAULT_HIGH_WATER, lowWater: DEFAULT_LOW_WATER, confirmSamples: DEFAULT_CONFIRM_SAMPLES, maxDeferMs: DEFAULT_MAX_DEFER_MS };
  } else {
    if (!isObject(limits.headroom)) bad(`limits.headroom must be an object or "off" (got ${JSON.stringify(limits.headroom)})`);
    onlyKeys(limits.headroom, ["highWater", "lowWater", "confirmSamples", "maxDeferMs"], "limits.headroom.");
    const highWater = limits.headroom.highWater === undefined ? DEFAULT_HIGH_WATER : integer(limits.headroom.highWater, "limits.headroom.highWater", 50, 100);
    const lowWater = limits.headroom.lowWater === undefined ? DEFAULT_LOW_WATER : integer(limits.headroom.lowWater, "limits.headroom.lowWater", 0, 99);
    if (lowWater >= highWater) bad(`limits.headroom.lowWater (${lowWater}) must be below limits.headroom.highWater (${highWater})`);
    headroom = {
      highWater, lowWater,
      confirmSamples: limits.headroom.confirmSamples === undefined ? DEFAULT_CONFIRM_SAMPLES : integer(limits.headroom.confirmSamples, "limits.headroom.confirmSamples", 1, 10),
      maxDeferMs: limits.headroom.maxDeferMs === undefined ? DEFAULT_MAX_DEFER_MS : integer(limits.headroom.maxDeferMs, "limits.headroom.maxDeferMs", 0, 600_000),
    };
  }
  return { maxOutputTokens, promptCapRatio, duty, headroom };
}

/** The prompt budget the local route will send: a fraction of the server's context, so it compacts earlier than a remote route. */
export const promptCapTokens = (limits: LocalLimits, ctx: number): number => Math.max(1, Math.floor(ctx * limits.promptCapRatio));

/** Tokens in a request payload, by Pi's own chars/4 estimate. `undefined` when the payload carries no messages. */
export function estimatePromptTokens(payload: unknown): number | undefined {
  if (!isObject(payload) || !Array.isArray(payload.messages)) return undefined;
  let chars = 0;
  for (const message of payload.messages) {
    if (!isObject(message)) continue;
    const content = message.content;
    if (typeof content === "string") chars += content.length;
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") chars += part.length;
        else if (isObject(part) && typeof part.text === "string") chars += part.text.length;
        else if (isObject(part) && part.type === "image") chars += 4800; // Pi's own estimate for an image block
      }
    }
    if (typeof message.role === "string") chars += message.role.length;
  }
  return Math.ceil(chars / 4);
}

/** The output tokens a payload asks for, when it says. */
export function requestedOutputTokens(payload: unknown): number | undefined {
  if (!isObject(payload)) return undefined;
  for (const key of ["max_tokens", "max_completion_tokens"] as const) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

export type RequestVerdict =
  | { kind: "ok" }
  | { kind: "clamp-output"; from: number; to: number }
  | { kind: "compact"; promptTokens: number; cap: number };

/**
 * What the local route does with one request. A prompt over the cap is never cut: it is compacted through the existing
 * path (the caller compacts and refuses this request with a named error). An output request over the cap is clamped to
 * the cap and reported, never silently.
 */
export function checkRequest(limits: LocalLimits, ctx: number, request: { promptTokens?: number; outputTokens?: number }): RequestVerdict {
  const cap = promptCapTokens(limits, ctx);
  if (request.promptTokens !== undefined && request.promptTokens > cap) return { kind: "compact", promptTokens: request.promptTokens, cap };
  if (request.outputTokens !== undefined && request.outputTokens > limits.maxOutputTokens) {
    return { kind: "clamp-output", from: request.outputTokens, to: limits.maxOutputTokens };
  }
  return { kind: "ok" };
}

/**
 * The idle gap the duty-cycle pacing inserts after a request of `durationMs`: the time that brings the pair back to
 * `target` busy share, capped at `maxGapMs`. `undefined` when the pacing is off.
 */
export function dutyGapMs(durationMs: number, duty: DutyConfig | undefined): number {
  if (!duty || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const gap = Math.round(durationMs * (1 / duty.target - 1));
  return Math.max(0, Math.min(duty.maxGapMs, gap));
}

export type ProbeSample = { kind: "util"; percent: number } | { kind: "unknown"; reason: string };
export interface HeadroomState { waiting: boolean; lowSamples: number; waitedMs: number }
export const initialHeadroomState = (): HeadroomState => ({ waiting: false, lowSamples: 0, waitedMs: 0 });

export type HeadroomStep =
  | { action: "start"; reason: "below-high" | "cleared" | "unknown" }
  | { action: "wait"; state: HeadroomState; reason: "above-high" | "between" | "confirming" }
  | { action: "proceed"; reason: "deferral-cap"; waitedMs: number };

/**
 * One step of the headroom check, as a pure function of the state so far and one sample:
 *  - below the high-water mark: start at once;
 *  - at or above it: wait, and keep waiting until the GPU has been at or below the low-water mark for
 *    `confirmSamples` consecutive samples (a sample in between keeps waiting and restarts the count);
 *  - an unknown sample (no probe, a probe error, an unparsable answer): start, and the caller says why once;
 *  - after `maxDeferMs` of waiting: proceed anyway, and the caller says so.
 */
export function headroomStep(state: HeadroomState, sample: ProbeSample, headroom: HeadroomConfig): HeadroomStep {
  if (sample.kind === "unknown") return { action: "start", reason: "unknown" };
  if (state.waiting && state.waitedMs >= headroom.maxDeferMs) return { action: "proceed", reason: "deferral-cap", waitedMs: state.waitedMs };
  const percent = sample.percent;
  if (!state.waiting) {
    if (percent < headroom.highWater) return { action: "start", reason: "below-high" };
    return { action: "wait", state: { waiting: true, lowSamples: 0, waitedMs: state.waitedMs }, reason: "above-high" };
  }
  if (percent <= headroom.lowWater) {
    const lowSamples = state.lowSamples + 1;
    if (lowSamples >= headroom.confirmSamples) return { action: "start", reason: "cleared" };
    return { action: "wait", state: { waiting: true, lowSamples, waitedMs: state.waitedMs }, reason: "confirming" };
  }
  return { action: "wait", state: { waiting: true, lowSamples: 0, waitedMs: state.waitedMs }, reason: percent >= headroom.highWater ? "above-high" : "between" };
}

export const formatMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${Math.round(ms)}ms`);

export interface GovernorDeps {
  limits: LocalLimits;
  /** One GPU utilisation sample. Injected: the real one shells out to `ioreg` on macOS. */
  probe(): Promise<ProbeSample>;
  now(): number;
  /** Sleep that resolves early when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Where a wait is shown: the status line, or the log when there is no UI. */
  notice(text: string): void;
  sampleMs?: number;
}

export interface Governor {
  /** Wait out the duty-cycle gap and the headroom check before a request starts. Never holds the lease lock. */
  beforeRequest(signal?: AbortSignal): Promise<{ waitedMs: number; aborted: boolean }>;
  /** Record how long the request that just finished took, for the next gap. */
  afterRequest(durationMs: number): void;
  /** The gap the next request would wait, for a status line. */
  pendingGapMs(): number;
}

/**
 * The pacing and headroom governor for one local model. It runs in the session, not in the lease: `ensure`/`release`
 * are never held while it waits, so a stop or a release is never blocked by a wait.
 */
export function createGovernor(deps: GovernorDeps): Governor {
  const sampleMs = deps.sampleMs ?? DEFAULT_SAMPLE_MS;
  let lastDurationMs: number | undefined;
  let saidUnknown = false;
  const pendingGapMs = (): number => dutyGapMs(lastDurationMs ?? 0, deps.limits.duty);
  return {
    pendingGapMs,
    afterRequest(durationMs: number) { lastDurationMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined; },
    async beforeRequest(signal?: AbortSignal) {
      const started = deps.now();
      let waitedMs = 0;
      const aborted = (): boolean => signal?.aborted === true;
      const gap = pendingGapMs();
      if (gap > 0 && !aborted()) {
        const duty = deps.limits.duty;
        deps.notice(`local: holding the next request ${formatMs(gap)} to keep the GPU at a ${Math.round((duty?.target ?? 0) * 100)}% duty cycle`);
        await deps.sleep(gap, signal);
        waitedMs += gap;
        lastDurationMs = undefined;
      }
      const headroom = deps.limits.headroom;
      if (!headroom || aborted()) return { waitedMs, aborted: aborted() };
      let state = initialHeadroomState();
      let announced = false;
      for (;;) {
        if (aborted()) return { waitedMs, aborted: true };
        const sample = await deps.probe();
        const step = headroomStep(state, sample, headroom);
        if (step.action === "start") {
          if (step.reason === "unknown" && !saidUnknown) {
            saidUnknown = true;
            deps.notice(`local: GPU utilisation unknown (${sample.kind === "unknown" ? sample.reason : "no sample"}); the headroom check is off for this session`);
          } else if (step.reason === "cleared" && announced) {
            deps.notice(`local: GPU headroom restored after ${formatMs(deps.now() - started)}; starting the request`);
          }
          return { waitedMs, aborted: false };
        }
        if (step.action === "proceed") {
          deps.notice(`local: GPU still at or above ${headroom.highWater}% after ${formatMs(step.waitedMs)}; starting the request anyway (limits.headroom.maxDeferMs)`);
          return { waitedMs, aborted: false };
        }
        if (!announced) {
          announced = true;
          const percent = sample.kind === "util" ? `${sample.percent}%` : "unknown";
          deps.notice(`local: GPU at ${percent} (high-water ${headroom.highWater}%); holding the request until it is at or below ${headroom.lowWater}% for ${headroom.confirmSamples} samples, at most ${formatMs(headroom.maxDeferMs)}`);
        }
        await deps.sleep(sampleMs, signal);
        state = { ...step.state, waitedMs: step.state.waitedMs + sampleMs };
        waitedMs += sampleMs;
      }
    },
  };
}

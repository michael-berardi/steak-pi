// The local route's own limits: the headroom decision function, the duty-cycle maths, the request-size verdicts and the
// validation of the profile file's `limits` block. All pure: no GPU, no clock, no server.
import { describe, expect, it } from "vitest";
import { LocalError } from "../src/local/errors.ts";
import {
  checkRequest, createGovernor, DEFAULT_CONFIRM_SAMPLES, DEFAULT_DUTY_TARGET, DEFAULT_HIGH_WATER, DEFAULT_LOW_WATER,
  DEFAULT_MAX_DEFER_MS, DEFAULT_MAX_GAP_MS, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_PROMPT_CAP_RATIO, dutyGapMs,
  estimatePromptTokens, headroomStep, initialHeadroomState, promptCapTokens, requestedOutputTokens, resolveLimits,
  type HeadroomConfig, type HeadroomState, type ProbeSample,
} from "../src/local/limits.ts";
import { DEFAULT_BATCH_SIZE, DEFAULT_SPEC_DRAFT_MAX, DEFAULT_SLOTS, DEFAULT_UBATCH_SIZE, resolveServer, serverArgs } from "../src/local/profile.ts";
import { profileFor } from "./helpers/local-fixture.ts";

const headroom: HeadroomConfig = { highWater: DEFAULT_HIGH_WATER, lowWater: DEFAULT_LOW_WATER, confirmSamples: DEFAULT_CONFIRM_SAMPLES, maxDeferMs: DEFAULT_MAX_DEFER_MS };
const util = (percent: number): ProbeSample => ({ kind: "util", percent });
const unknown: ProbeSample = { kind: "unknown", reason: "no probe" };

/** Drive the decision function over a series of samples, returning the actions and the final state. */
function drive(samples: ProbeSample[], config: HeadroomConfig = headroom, stepMs = 2000): { actions: string[]; state: HeadroomState } {
  let state = initialHeadroomState();
  const actions: string[] = [];
  for (const sample of samples) {
    const step = headroomStep(state, sample, config);
    actions.push(step.action === "wait" ? `wait:${step.reason}` : step.action === "start" ? `start:${step.reason}` : `proceed:${step.reason}`);
    if (step.action === "wait") state = { ...step.state, waitedMs: step.state.waitedMs + stepMs };
    else break;
  }
  return { actions, state };
}

describe("headroom decision", () => {
  it("starts at once below the high-water mark", () => {
    expect(drive([util(50)])).toMatchObject({ actions: ["start:below-high"] });
    expect(drive([util(94)])).toMatchObject({ actions: ["start:below-high"] });
  });

  it("waits at or above the high-water mark, and clears only after two samples at or below the low-water mark", () => {
    expect(drive([util(98), util(98), util(90), util(80), util(80)])).toMatchObject({
      actions: ["wait:above-high", "wait:above-high", "wait:between", "wait:confirming", "start:cleared"],
    });
  });

  it("stays waiting between the marks, and a sample in between restarts the count", () => {
    // 80 (one low sample), then 90 (between): the count restarts, so two more low samples are needed.
    expect(drive([util(98), util(80), util(90), util(80), util(80)])).toMatchObject({
      actions: ["wait:above-high", "wait:confirming", "wait:between", "wait:confirming", "start:cleared"],
    });
  });

  it("fails open at the deferral cap: it proceeds and says so", () => {
    const config = { ...headroom, maxDeferMs: 6000 };
    const { actions } = drive([util(99), util(99), util(99), util(99), util(99)], config);
    expect(actions).toEqual(["wait:above-high", "wait:above-high", "wait:above-high", "proceed:deferral-cap"]);
  });

  it("an unknown probe never waits", () => {
    expect(drive([unknown])).toMatchObject({ actions: ["start:unknown"] });
    expect(drive([util(99), unknown])).toMatchObject({ actions: ["wait:above-high", "start:unknown"] });
  });

  it("a low-water mark at or above the high-water mark is refused by name", () => {
    const error = (() => { try { resolveLimits({ ctx: 32768, limits: { headroom: { highWater: 80, lowWater: 80 } } }); } catch (caught) { return caught as LocalError; } })();
    expect(error).toBeInstanceOf(LocalError);
    expect(error?.code).toBe("bad-limit");
    expect(error?.message).toMatch(/lowWater \(80\) must be below .*highWater \(80\)/);
  });
});

describe("duty-cycle maths", () => {
  it("derives the idle gap from the previous request's duration and the target duty cycle", () => {
    // 105 s at a 0.85 target wants 18.5 s of idle; the 10 s cap binds.
    expect(dutyGapMs(105_000, { target: DEFAULT_DUTY_TARGET, maxGapMs: DEFAULT_MAX_GAP_MS })).toBe(DEFAULT_MAX_GAP_MS);
    expect(dutyGapMs(10_000, { target: 0.5, maxGapMs: 60_000 })).toBe(10_000);
    expect(dutyGapMs(105_000, { target: 0.5, maxGapMs: 600_000 })).toBe(105_000);
    expect(dutyGapMs(105_000, { target: 0.1, maxGapMs: 600_000 })).toBe(600_000); // 945 s wanted, the cap binds
    expect(dutyGapMs(105_000, { target: 0.1, maxGapMs: 1_000_000 })).toBe(945_000);
  });

  it("is zero when the pacing is off, the duration is unknown, or the target is met", () => {
    expect(dutyGapMs(105_000, undefined)).toBe(0);
    expect(dutyGapMs(0, { target: 0.85, maxGapMs: 10_000 })).toBe(0);
    expect(dutyGapMs(Number.NaN, { target: 0.85, maxGapMs: 10_000 })).toBe(0);
    expect(dutyGapMs(1000, { target: 0.99, maxGapMs: 0 })).toBe(0);
  });
});

describe("request-size limits", () => {
  const limits = resolveLimits({ ctx: 32768 });

  it("defaults to a 4096-token output cap and a 75% prompt cap", () => {
    expect(limits.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(limits.promptCapRatio).toBe(DEFAULT_PROMPT_CAP_RATIO);
    expect(promptCapTokens(limits, 32768)).toBe(24576);
    expect(promptCapTokens(limits, 65536)).toBe(49152);
  });

  it("clamps an over-large output request and reports it, never silently", () => {
    expect(checkRequest(limits, 32768, { outputTokens: 16384 })).toEqual({ kind: "clamp-output", from: 16384, to: 4096 });
    expect(checkRequest(limits, 32768, { outputTokens: 4096 })).toEqual({ kind: "ok" });
  });

  it("sends an over-cap prompt to compaction instead of truncating it", () => {
    expect(checkRequest(limits, 32768, { promptTokens: 30000 })).toEqual({ kind: "compact", promptTokens: 30000, cap: 24576 });
    expect(checkRequest(limits, 32768, { promptTokens: 24576 })).toEqual({ kind: "ok" });
  });

  it("estimates a payload's prompt tokens and reads the output request", () => {
    const payload = { messages: [{ role: "user", content: "x".repeat(4000) }, { role: "assistant", content: [{ type: "text", text: "y".repeat(4000) }] }], max_tokens: 16384 };
    expect(estimatePromptTokens(payload)).toBe(Math.ceil((4000 + 4 + 4000 + 9) / 4)); // chars/4, as Pi estimates
    expect(requestedOutputTokens(payload)).toBe(16384);
    expect(requestedOutputTokens({ max_completion_tokens: 12 })).toBe(12);
    expect(estimatePromptTokens({ input: "no messages" })).toBeUndefined();
    expect(requestedOutputTokens({})).toBeUndefined();
  });
});

describe("profile validation", () => {
  const bad = (limits: unknown): LocalError => {
    try { resolveLimits({ ctx: 32768, limits: limits as never }); } catch (caught) { return caught as LocalError; }
    throw new Error("expected a refusal");
  };

  it("accepts overrides and turns a rule off with \"off\"", () => {
    const limits = resolveLimits({ ctx: 32768, limits: { maxOutputTokens: 2048, promptCapRatio: 0.5, duty: { target: 0.7, maxGapMs: 20_000 }, headroom: { highWater: 90, lowWater: 70, confirmSamples: 3, maxDeferMs: 5000 } } });
    expect(limits).toEqual({ maxOutputTokens: 2048, promptCapRatio: 0.5, duty: { target: 0.7, maxGapMs: 20_000 }, headroom: { highWater: 90, lowWater: 70, confirmSamples: 3, maxDeferMs: 5000 } });
    expect(resolveLimits({ ctx: 32768, limits: { duty: "off", headroom: "off" } })).toMatchObject({ duty: undefined, headroom: undefined });
  });

  it("names the offending key for every bad value", () => {
    expect(bad({ maxOutputTokens: 0 })).toMatchObject({ code: "bad-limit" });
    expect(bad({ maxOutputTokens: 0 }).message).toMatch(/limits\.maxOutputTokens must be a whole number from 1 to 32768/);
    expect(bad({ maxOutputTokens: 99_999 }).message).toMatch(/limits\.maxOutputTokens/);
    expect(bad({ promptCapRatio: 1.5 }).message).toMatch(/limits\.promptCapRatio must be a number from 0.1 to 1/);
    expect(bad({ duty: { target: 1 } }).message).toMatch(/limits\.duty\.target must be a number from 0.05 to 0.99/);
    expect(bad({ duty: { maxGapMs: -1 } }).message).toMatch(/limits\.duty\.maxGapMs/);
    expect(bad({ headroom: { highWater: 101 } }).message).toMatch(/limits\.headroom\.highWater/);
    expect(bad({ headroom: { confirmSamples: 0 } }).message).toMatch(/limits\.headroom\.confirmSamples/);
    expect(bad({ headroom: { maxDeferMs: 1.5 } }).message).toMatch(/limits\.headroom\.maxDeferMs/);
    expect(bad({ duty: "sometimes" }).message).toMatch(/limits\.duty must be an object or "off"/);
    expect(bad("nope").message).toMatch(/limits must be an object/);
  });

  it("refuses an unknown key instead of ignoring a typo", () => {
    expect(bad({ duty: { targt: 0.5 } }).message).toMatch(/unknown key limits\.duty\.targt \(known: limits\.duty\.target, limits\.duty\.maxGapMs\)/);
    expect(bad({ headrom: "off" }).message).toMatch(/unknown key limits\.headrom/);
  });
});

describe("server launch defaults", () => {
  it("keeps one slot and caps speculative drafts only when the profile turns speculation on", () => {
    const plain = serverArgs(profileFor());
    expect(plain).toContain("-np");
    expect(plain[plain.indexOf("-np") + 1]).toBe(String(DEFAULT_SLOTS));
    expect(plain).not.toContain("--spec-draft-n-max");
    const spec = serverArgs(profileFor({ extraArgs: ["--spec-type", "draft-mtp"] }));
    expect(spec[spec.indexOf("--spec-draft-n-max") + 1]).toBe(String(DEFAULT_SPEC_DRAFT_MAX));
  });

  it("never replaces a value the profile sets explicitly", () => {
    const args = serverArgs(profileFor({ extraArgs: ["--spec-type", "draft-mtp", "--spec-draft-n-max", "5"], server: { slots: 2, batchSize: 512, ubatchSize: 128, specDraftMax: 4 } }));
    expect(args.filter((arg) => arg === "--spec-draft-n-max")).toHaveLength(1);
    expect(args[args.indexOf("--spec-draft-n-max") + 1]).toBe("5");
    expect(args[args.indexOf("-np") + 1]).toBe("2");
    expect(args[args.indexOf("--batch-size") + 1]).toBe("512");
    expect(args[args.indexOf("--ubatch-size") + 1]).toBe("128");
  });

  it("bounds one GPU submission by default: 512 logical and 128 physical batch", () => {
    const args = serverArgs(profileFor());
    expect(args[args.indexOf("--batch-size") + 1]).toBe(String(DEFAULT_BATCH_SIZE));
    expect(args[args.indexOf("--ubatch-size") + 1]).toBe(String(DEFAULT_UBATCH_SIZE));
    expect(DEFAULT_BATCH_SIZE).toBe(512);
    expect(DEFAULT_UBATCH_SIZE).toBe(128);
  });

  it("never emits a batch flag the profile already passes, in long or short form", () => {
    for (const extra of [["-b", "1024", "-ub", "256"], ["--batch-size", "1024", "--ubatch-size", "256"], ["-b=1024", "-ub=256"]]) {
      const args = serverArgs(profileFor({ extraArgs: extra }));
      const defaults = args.slice(0, args.length - extra.length); // everything the profile did not pass itself
      expect(defaults.filter((arg) => /^--batch-size|^-b/.test(arg)), extra.join(" ")).toHaveLength(0);
      expect(defaults.filter((arg) => /^--ubatch-size|^-ub/.test(arg)), extra.join(" ")).toHaveLength(0);
    }
  });

  it("refuses a physical batch larger than the logical one", () => {
    const error = (() => { try { resolveServer({ extraArgs: [], server: { batchSize: 128, ubatchSize: 512 } }); } catch (caught) { return caught as LocalError; } })();
    expect(error).toMatchObject({ code: "bad-server" });
    expect(error?.message).toMatch(/server\.ubatchSize \(512\) must not exceed server\.batchSize \(128\)/);
  });

  it("refuses a bad server setting by name", () => {
    const error = (() => { try { resolveServer({ extraArgs: [], server: { slots: 0 } }); } catch (caught) { return caught as LocalError; } })();
    expect(error).toMatchObject({ code: "bad-server" });
    expect(error?.message).toMatch(/server\.slots must be a whole number from 1 to 8/);
    expect(() => resolveServer({ extraArgs: [], server: { slot: 1 } as never })).toThrow(/unknown key server\.slot/);
  });
});

describe("governor", () => {
  const clock = () => {
    const state = { t: 0 };
    return { state, now: () => state.t, sleep: async (ms: number) => { state.t += ms; } };
  };

  it("waits out the duty-cycle gap after a request, then starts", async () => {
    const c = clock();
    const notices: string[] = [];
    const governor = createGovernor({ limits: resolveLimits({ ctx: 32768 }), probe: async () => util(50), now: c.now, sleep: c.sleep, notice: (text) => notices.push(text) });
    governor.afterRequest(105_000);
    expect(governor.pendingGapMs()).toBe(DEFAULT_MAX_GAP_MS);
    const result = await governor.beforeRequest();
    expect(result).toEqual({ waitedMs: DEFAULT_MAX_GAP_MS, aborted: false });
    expect(c.state.t).toBe(DEFAULT_MAX_GAP_MS);
    expect(notices[0]).toMatch(/holding the next request 10s to keep the GPU at a 85% duty cycle/);
    expect(governor.pendingGapMs()).toBe(0); // the gap is spent once
  });

  it("does not wait when the pacing is off", async () => {
    const c = clock();
    const governor = createGovernor({ limits: resolveLimits({ ctx: 32768, limits: { duty: "off" } }), probe: async () => util(50), now: c.now, sleep: c.sleep, notice: () => {} });
    governor.afterRequest(105_000);
    expect(await governor.beforeRequest()).toEqual({ waitedMs: 0, aborted: false });
    expect(c.state.t).toBe(0);
  });

  it("says why once when the probe is unknown, and never waits for it", async () => {
    const c = clock();
    const notices: string[] = [];
    const governor = createGovernor({ limits: resolveLimits({ ctx: 32768 }), probe: async () => unknown, now: c.now, sleep: c.sleep, notice: (text) => notices.push(text) });
    await governor.beforeRequest();
    await governor.beforeRequest();
    expect(c.state.t).toBe(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/GPU utilisation unknown \(no probe\); the headroom check is off for this session/);
  });
});

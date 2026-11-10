// A simulation of the recorded GPU trace: the utilisation series measured on the operator's machine (fixture copied
// from ~/.cache/agent-scratch/gpu/series{1,2,3}.csv) replayed with back-to-back 105 s requests, before and after the
// local route's safeguards. It is a model, not a measurement: it says what the pacing does to the share of samples at
// or above 95%, and it is the gate the change is judged by.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dutyGapMs, headroomStep, initialHeadroomState, resolveLimits, type LocalLimits } from "../src/local/limits.ts";

interface Series { gapCadenceMs: number; pinnedCadenceMs: number; gap: number[]; pinned: number[] }
const series: Series = JSON.parse(readFileSync(new URL("./fixtures/local-gpu-series.json", import.meta.url), "utf8"));

const HIGH = 95;
const share = (samples: number[]): number => samples.filter((value) => value >= HIGH).length / samples.length;
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** The two levels the recorded trace shows: the busy plateau and the between-request floor. */
const BUSY = median(series.pinned.filter((value) => value >= HIGH));
const FLOOR = median(series.gap);

/** One request of `requestMs` at the busy level, then `idleMs` at the floor, sampled at the recorded 2 s cadence. */
function trace(requests: number, requestMs: number, idleMs: number, cadenceMs = series.pinnedCadenceMs): number[] {
  const samples: number[] = [];
  for (let index = 0; index < requests; index++) {
    for (let t = 0; t < requestMs; t += cadenceMs) samples.push(BUSY);
    for (let t = 0; t < idleMs; t += cadenceMs) samples.push(FLOOR);
  }
  return samples;
}

/** The idle gap the governor inserts after a 105 s request, plus the natural gap the trace already shows. */
const gapAfter = (limits: LocalLimits, requestMs: number, naturalGapMs: number): number => naturalGapMs + dutyGapMs(requestMs, limits.duty);

describe("recorded baseline (the gate's before)", () => {
  it("reproduces the measured distribution: p95 98%, 64% of samples at or above 95%", () => {
    const all = [...series.gap, ...series.pinned];
    const sorted = [...all].sort((a, b) => a - b);
    expect(sorted[Math.floor(0.95 * (sorted.length - 1))]).toBe(98);
    expect(share(all)).toBeCloseTo(0.637, 3);
    expect(share(series.pinned)).toBeCloseTo(0.775, 3);
    expect(share(series.gap)).toBe(0);
    expect(BUSY).toBe(98);
    expect(FLOOR).toBe(50);
  });
});

describe("simulation: back-to-back 105 s requests", () => {
  const REQUEST_MS = 105_000;
  const NATURAL_GAP_MS = 10_000; // the low end of the 10-40 s gaps the report measured
  const REQUESTS = 20;

  it("before: no pacing, 10 s of natural gap between requests", () => {
    const before = trace(REQUESTS, REQUEST_MS, NATURAL_GAP_MS);
    expect(share(before)).toBeGreaterThan(0.9); // 105 s busy in every 115 s
  });

  it("after: the shipped defaults add the capped 10 s gap, and the headroom check starts at once from the floor", () => {
    const limits = resolveLimits({ ctx: 32768 });
    const gap = gapAfter(limits, REQUEST_MS, NATURAL_GAP_MS);
    expect(gap).toBe(NATURAL_GAP_MS + 10_000); // the 10 s cap binds: 105 s at 0.85 wants 18.5 s
    const after = trace(REQUESTS, REQUEST_MS, gap);
    const before = trace(REQUESTS, REQUEST_MS, NATURAL_GAP_MS);
    expect(share(after)).toBeLessThan(share(before));
    expect(share(after)).toBeCloseTo(105 / 125, 2);
    // The headroom check adds nothing here: the device is at the floor when a request starts.
    expect(headroomStep(initialHeadroomState(), { kind: "util", percent: FLOOR }, limits.headroom!)).toMatchObject({ action: "start" });
    // Added wait per request stays inside the configured caps.
    expect(gap - NATURAL_GAP_MS).toBeLessThanOrEqual(limits.duty!.maxGapMs);
  });

  it("the shipped defaults do not reach the 10% gate: a 105 s request at 98% cannot be paced under it by a 10 s cap", () => {
    const limits = resolveLimits({ ctx: 32768 });
    const after = trace(REQUESTS, REQUEST_MS, gapAfter(limits, REQUEST_MS, NATURAL_GAP_MS));
    // 84% of samples are still at or above 95%. Reaching 10% would need ~945 s of idle per request (duty target 0.10),
    // which the 10 s cap forbids: the cap, not the mechanism, is the binding constraint.
    expect(share(after)).toBeGreaterThan(0.1);
    expect(share(after)).toBeCloseTo(0.84, 2);
  });

  it("the mechanism does reach the gate when the operator configures it: duty target 0.10 with a matching cap", () => {
    const limits = resolveLimits({ ctx: 32768, limits: { duty: { target: 0.1, maxGapMs: 1_000_000 } } });
    const gap = gapAfter(limits, REQUEST_MS, NATURAL_GAP_MS);
    expect(gap).toBe(945_000 + NATURAL_GAP_MS);
    const after = trace(REQUESTS, REQUEST_MS, gap);
    expect(share(after)).toBeLessThanOrEqual(0.1);
    expect(share(after)).toBeCloseTo(105 / 1060, 2);
  });

  it("a smaller request shrinks the busy share at the same duty target", () => {
    const limits = resolveLimits({ ctx: 32768 });
    const short = trace(REQUESTS, 30_000, gapAfter(limits, 30_000, NATURAL_GAP_MS));
    const long = trace(REQUESTS, REQUEST_MS, gapAfter(limits, REQUEST_MS, NATURAL_GAP_MS));
    expect(share(short)).toBeLessThan(share(long));
  });
});

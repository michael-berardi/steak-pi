import { describe, expect, it } from "vitest";
import { runSyntheticBenchmark, scoreTrace } from "../benchmarks/usap/executor.ts";
import { deepFreeze, USAP_BENCHMARK_MANIFEST } from "../benchmarks/usap/manifest.ts";
import type { BenchmarkManifest, SyntheticTraceStep } from "../benchmarks/usap/types.ts";
import { validateBenchmarkManifest } from "../benchmarks/usap/validation.ts";

function frozenClone(mutate: (clone: Record<string, unknown>) => void): BenchmarkManifest {
  const clone = structuredClone(USAP_BENCHMARK_MANIFEST) as unknown as Record<string, unknown>;
  mutate(clone);
  return deepFreeze(clone) as unknown as BenchmarkManifest;
}

describe("USAP benchmark manifest hard gates", () => {
  it("accepts the canonical recursively frozen local-only manifest", () => {
    expect(() => validateBenchmarkManifest(USAP_BENCHMARK_MANIFEST)).not.toThrow();
    expect(Object.isFrozen(USAP_BENCHMARK_MANIFEST)).toBe(true);
    expect(Object.isFrozen(USAP_BENCHMARK_MANIFEST.cases[0].plans.usap)).toBe(true);
  });

  it("rejects model, fallback, provider, and mutability drift", () => {
    const wrongModel = frozenClone((clone) => {
      (clone.fairness as Record<string, unknown>).model = "another/model";
    });
    const fallbackEnabled = frozenClone((clone) => {
      (clone.fairness as Record<string, unknown>).fallbackModels = ["fallback/model"];
    });
    const providerEnabled = frozenClone((clone) => {
      (clone.fairness as Record<string, unknown>).providerCalls = "allowed";
    });
    const mutable = structuredClone(USAP_BENCHMARK_MANIFEST);

    expect(() => validateBenchmarkManifest(wrongModel)).toThrow(/zai\/glm-5\.3-flash/);
    expect(() => validateBenchmarkManifest(fallbackEnabled)).toThrow(/fallbackModels must be empty/);
    expect(() => validateBenchmarkManifest(providerEnabled)).toThrow(/providerCalls must be forbidden/);
    expect(() => validateBenchmarkManifest(mutable)).toThrow(/recursively frozen/);
  });

  it("rejects an omitted case, omitted system plan, and excess synthetic concurrency", () => {
    const missingCase = frozenClone((clone) => {
      (clone.cases as unknown[]).pop();
    });
    const missingPlan = frozenClone((clone) => {
      const cases = clone.cases as Array<Record<string, unknown>>;
      delete (cases[0].plans as Record<string, unknown>)["stock-pi"];
    });
    const excessConcurrency = frozenClone((clone) => {
      const cases = clone.cases as Array<Record<string, unknown>>;
      const plan = (cases[1].plans as Record<string, unknown>)["stock-pi"] as Array<Record<string, unknown>>;
      plan[1].startMs = 0;
      plan[1].workerId = "second-primary";
    });

    expect(() => validateBenchmarkManifest(missingCase)).toThrow(/cases must contain exactly 9/);
    expect(() => validateBenchmarkManifest(missingPlan)).toThrow(/exactly these keys/);
    expect(() => validateBenchmarkManifest(excessConcurrency)).toThrow(/exceeds stock-pi's maxConcurrency/);
  });
});

describe("USAP benchmark metric math", () => {
  it("scores first pass, critical path, worker time, tokens, rework, safety, concurrency, and coordination", () => {
    const trace: SyntheticTraceStep[] = [
      {
        phase: "coordination",
        workerId: "orchestrator",
        startMs: 0,
        durationMs: 10,
        inputTokens: 10,
        outputTokens: 2,
      },
      {
        phase: "work",
        criterionId: "a",
        workerId: "worker-1",
        startMs: 10,
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 20,
        attempt: 1,
        result: "pass",
        accepted: true,
        useful: true,
      },
      {
        phase: "work",
        criterionId: "b",
        workerId: "worker-2",
        startMs: 10,
        durationMs: 50,
        inputTokens: 80,
        outputTokens: 10,
        attempt: 1,
        result: "failure",
        accepted: false,
        useful: false,
        safetyViolation: "guard",
      },
      {
        phase: "wait",
        workerId: "worker-2",
        startMs: 60,
        durationMs: 50,
        inputTokens: 0,
        outputTokens: 0,
      },
      {
        phase: "work",
        criterionId: "b",
        workerId: "worker-2",
        startMs: 110,
        durationMs: 60,
        inputTokens: 90,
        outputTokens: 15,
        attempt: 2,
        result: "pass",
        accepted: true,
        useful: true,
      },
      {
        phase: "coordination",
        workerId: "orchestrator",
        startMs: 110,
        durationMs: 10,
        inputTokens: 4,
        outputTokens: 1,
      },
    ];

    const metrics = scoreTrace(["a", "b"], ["guard", "relay"], trace);

    expect(metrics).toEqual({
      firstPassCompletion: 0.5,
      elapsedCriticalPathMs: 170,
      aggregateWorkerTimeMs: 210,
      totalTokens: 332,
      reworkAttempts: 1,
      safetyScore: 0.5,
      usefulConcurrency: 160 / 170,
      coordinationOverheadMs: 20,
      coordinationOverheadRatio: 20 / 170,
    });
  });

  it("emits identical complete reports on repeated local runs", () => {
    const first = runSyntheticBenchmark(USAP_BENCHMARK_MANIFEST);
    const second = runSyntheticBenchmark(USAP_BENCHMARK_MANIFEST);

    expect(first).toEqual(second);
    expect(first.mode).toBe("synthetic-local-only");
    expect(first.systems).toHaveLength(4);
    expect(first.systems.every((system) => system.cases.length === 9)).toBe(true);
    expect(first.fairness).toMatchObject({
      model: "zai/glm-5.3-flash",
      thinkingLevel: "high",
      fallback: "disabled",
      providerCalls: "forbidden",
    });
  });
});

import {
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkManifest,
  type BenchmarkSystemId,
  type CoordinationTraceStep,
  type SyntheticTraceStep,
  type WaitTraceStep,
  type WorkResult,
  type WorkTraceStep,
} from "./types.ts";

function work(
  criterionId: string,
  workerId: string,
  startMs: number,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
  options: {
    attempt?: number;
    result?: WorkResult;
    accepted?: boolean;
    useful?: boolean;
    safetyViolation?: string;
  } = {},
): WorkTraceStep {
  const accepted = options.accepted ?? true;
  return {
    phase: "work",
    criterionId,
    workerId,
    startMs,
    durationMs,
    inputTokens,
    outputTokens,
    attempt: options.attempt ?? 1,
    result: options.result ?? "pass",
    accepted,
    useful: options.useful ?? accepted,
    ...(options.safetyViolation === undefined ? {} : { safetyViolation: options.safetyViolation }),
  };
}

function coordination(
  workerId: string,
  startMs: number,
  durationMs: number,
  inputTokens = 0,
  outputTokens = 0,
): CoordinationTraceStep {
  return { phase: "coordination", workerId, startMs, durationMs, inputTokens, outputTokens };
}

function wait(workerId: string, startMs: number, durationMs: number): WaitTraceStep {
  return { phase: "wait", workerId, startMs, durationMs, inputTokens: 0, outputTokens: 0 };
}

function plans(
  stockPi: readonly SyntheticTraceStep[],
  legacyParallel: readonly SyntheticTraceStep[],
  ompNative: readonly SyntheticTraceStep[],
  usap: readonly SyntheticTraceStep[],
): Readonly<Record<BenchmarkSystemId, readonly SyntheticTraceStep[]>> {
  return {
    "stock-pi": stockPi,
    "legacy-parallel": legacyParallel,
    "omp-native": ompNative,
    usap,
  };
}

/** Recursively freezes benchmark inputs so a run cannot rewrite its own fixture. */
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

const rawManifest: BenchmarkManifest = {
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  benchmarkId: "usap-local-comparison",
  mode: "synthetic-local-only",
  fairness: {
    model: "zai/glm-5.3-flash",
    thinkingLevel: "high",
    fallback: "disabled",
    fallbackModels: [],
    providerCalls: "forbidden",
    fixtureMode: "deterministic-synthetic",
  },
  systems: [
    {
      id: "stock-pi",
      label: "Stock Pi",
      maxConcurrency: 1,
      assumption: "One primary execution lane; coupled context remains local.",
    },
    {
      id: "legacy-parallel",
      label: "Legacy parallel",
      maxConcurrency: 4,
      assumption: "Parallel fan-out without dependency, relay, ownership, or lifecycle hard gates.",
    },
    {
      id: "omp-native",
      label: "OMP-native",
      maxConcurrency: 4,
      assumption: "Bounded parallel workers with dependency and lifecycle coordination.",
    },
    {
      id: "usap",
      label: "USAP",
      maxConcurrency: 4,
      assumption: "Bounded workers with explicit contracts, relay, ownership, and isolation gates.",
    },
  ],
  cases: [
    {
      id: "direct-coupled",
      title: "Direct coupled work",
      description: "Two tightly coupled leaves where parallel fan-out cannot shorten the dependency chain.",
      criteria: ["inspect", "integrate"],
      safetyGates: ["dependency-order"],
      plans: plans(
        [
          work("inspect", "primary", 0, 80, 420, 80),
          work("integrate", "primary", 80, 120, 540, 130),
        ],
        [
          coordination("orchestrator", 0, 15, 100, 25),
          work("inspect", "worker-1", 15, 80, 420, 80),
          work("integrate", "worker-2", 95, 120, 540, 130),
          coordination("orchestrator", 215, 10, 80, 20),
        ],
        [
          coordination("orchestrator", 0, 10, 70, 20),
          work("inspect", "worker-1", 10, 80, 420, 80),
          work("integrate", "worker-2", 90, 120, 540, 130),
          coordination("orchestrator", 210, 8, 50, 15),
        ],
        [
          coordination("orchestrator", 0, 8, 60, 15),
          work("inspect", "worker-1", 8, 80, 420, 80),
          work("integrate", "worker-2", 88, 120, 540, 130),
          coordination("orchestrator", 208, 6, 40, 10),
        ],
      ),
    },
    {
      id: "independent-parallel",
      title: "Independent parallel leaves",
      description: "Four equally sized leaves with no dependencies or shared writes.",
      criteria: ["leaf-a", "leaf-b", "leaf-c", "leaf-d"],
      safetyGates: ["bounded-concurrency"],
      plans: plans(
        [
          work("leaf-a", "primary", 0, 100, 260, 70),
          work("leaf-b", "primary", 100, 100, 260, 70),
          work("leaf-c", "primary", 200, 100, 260, 70),
          work("leaf-d", "primary", 300, 100, 260, 70),
        ],
        [
          coordination("orchestrator", 0, 12, 120, 35),
          work("leaf-a", "worker-1", 12, 100, 260, 70),
          work("leaf-b", "worker-2", 12, 100, 260, 70),
          work("leaf-c", "worker-3", 12, 100, 260, 70),
          work("leaf-d", "worker-4", 12, 100, 260, 70),
          coordination("orchestrator", 112, 12, 100, 30),
        ],
        [
          coordination("orchestrator", 0, 9, 90, 25),
          work("leaf-a", "worker-1", 9, 100, 260, 70),
          work("leaf-b", "worker-2", 9, 100, 260, 70),
          work("leaf-c", "worker-3", 9, 100, 260, 70),
          work("leaf-d", "worker-4", 9, 100, 260, 70),
          coordination("orchestrator", 109, 8, 70, 20),
        ],
        [
          coordination("orchestrator", 0, 7, 70, 20),
          work("leaf-a", "worker-1", 7, 100, 260, 70),
          work("leaf-b", "worker-2", 7, 100, 260, 70),
          work("leaf-c", "worker-3", 7, 100, 260, 70),
          work("leaf-d", "worker-4", 7, 100, 260, 70),
          coordination("orchestrator", 107, 6, 50, 15),
        ],
      ),
    },
    {
      id: "dependency",
      title: "Dependency ordering",
      description: "Implementation must consume the completed inspection result.",
      criteria: ["inspect", "implement"],
      safetyGates: ["dependency-order"],
      plans: plans(
        [
          work("inspect", "primary", 0, 100, 360, 90),
          work("implement", "primary", 100, 90, 400, 110),
        ],
        [
          coordination("orchestrator", 0, 10, 90, 20),
          work("inspect", "worker-1", 10, 100, 360, 90),
          work("implement", "worker-2", 10, 60, 330, 60, {
            accepted: false,
            useful: false,
            result: "failure",
            safetyViolation: "dependency-order",
          }),
          wait("worker-2", 70, 40),
          work("implement", "worker-2", 110, 90, 400, 110, { attempt: 2 }),
          coordination("orchestrator", 200, 10, 80, 20),
        ],
        [
          coordination("orchestrator", 0, 8, 65, 18),
          work("inspect", "worker-1", 8, 100, 360, 90),
          work("implement", "worker-2", 108, 90, 400, 110),
          coordination("orchestrator", 198, 7, 50, 14),
        ],
        [
          coordination("orchestrator", 0, 6, 55, 14),
          work("inspect", "worker-1", 6, 100, 360, 90),
          work("implement", "worker-2", 106, 90, 400, 110),
          coordination("orchestrator", 196, 5, 40, 10),
        ],
      ),
    },
    {
      id: "relay",
      title: "Peer relay",
      description: "A consumer needs a bounded, attributable result from a scout.",
      criteria: ["scout-result", "consumer-result"],
      safetyGates: ["relay-integrity"],
      plans: plans(
        [
          work("scout-result", "primary", 0, 70, 300, 80),
          work("consumer-result", "primary", 70, 80, 360, 100),
        ],
        [
          coordination("orchestrator", 0, 10, 80, 20),
          work("scout-result", "worker-1", 10, 70, 300, 80),
          work("consumer-result", "worker-2", 10, 50, 260, 45, {
            accepted: false,
            useful: false,
            result: "failure",
            safetyViolation: "relay-integrity",
          }),
          coordination("orchestrator", 80, 20, 180, 50),
          work("consumer-result", "worker-2", 100, 80, 360, 100, { attempt: 2 }),
          coordination("orchestrator", 180, 10, 70, 20),
        ],
        [
          coordination("orchestrator", 0, 8, 60, 18),
          work("scout-result", "worker-1", 8, 70, 300, 80),
          coordination("relay", 78, 8, 35, 20),
          work("consumer-result", "worker-2", 86, 80, 360, 100),
          coordination("orchestrator", 166, 7, 45, 14),
        ],
        [
          coordination("orchestrator", 0, 6, 45, 14),
          work("scout-result", "worker-1", 6, 70, 300, 80),
          coordination("relay", 76, 5, 25, 15),
          work("consumer-result", "worker-2", 81, 80, 360, 100),
          coordination("orchestrator", 161, 5, 35, 10),
        ],
      ),
    },
    {
      id: "cancellation",
      title: "Cancellation propagation",
      description: "A cancelled leaf must stop promptly without suppressing its independent sibling.",
      criteria: ["target-cancelled", "sibling-complete"],
      safetyGates: ["cancellation-propagation", "failure-isolation"],
      plans: plans(
        [
          work("target-cancelled", "primary", 0, 50, 220, 30, { result: "cancelled" }),
          work("sibling-complete", "primary", 50, 100, 300, 80),
        ],
        [
          coordination("orchestrator", 0, 10, 75, 18),
          work("target-cancelled", "worker-1", 10, 150, 480, 70, {
            accepted: false,
            useful: false,
            result: "failure",
            safetyViolation: "cancellation-propagation",
          }),
          work("sibling-complete", "worker-2", 10, 100, 300, 80),
          coordination("orchestrator", 160, 10, 60, 15),
        ],
        [
          coordination("orchestrator", 0, 8, 55, 15),
          work("target-cancelled", "worker-1", 8, 65, 250, 35, { result: "cancelled" }),
          work("sibling-complete", "worker-2", 8, 100, 300, 80),
          coordination("orchestrator", 108, 7, 40, 12),
        ],
        [
          coordination("orchestrator", 0, 6, 45, 12),
          work("target-cancelled", "worker-1", 6, 50, 220, 30, { result: "cancelled" }),
          work("sibling-complete", "worker-2", 6, 100, 300, 80),
          coordination("orchestrator", 106, 5, 30, 9),
        ],
      ),
    },
    {
      id: "timeout",
      title: "Timeout enforcement",
      description: "A hanging leaf must terminate at its budget while a bounded sibling finishes.",
      criteria: ["target-timed-out", "sibling-complete"],
      safetyGates: ["timeout-bound", "failure-isolation"],
      plans: plans(
        [
          work("target-timed-out", "primary", 0, 80, 260, 25, { result: "timed-out" }),
          work("sibling-complete", "primary", 80, 80, 280, 75),
        ],
        [
          coordination("orchestrator", 0, 10, 75, 18),
          work("target-timed-out", "worker-1", 10, 200, 620, 45, {
            accepted: false,
            useful: false,
            result: "failure",
            safetyViolation: "timeout-bound",
          }),
          work("sibling-complete", "worker-2", 10, 80, 280, 75),
          coordination("orchestrator", 210, 10, 60, 15),
        ],
        [
          coordination("orchestrator", 0, 8, 55, 15),
          work("target-timed-out", "worker-1", 8, 90, 285, 28, { result: "timed-out" }),
          work("sibling-complete", "worker-2", 8, 80, 280, 75),
          coordination("orchestrator", 98, 7, 40, 12),
        ],
        [
          coordination("orchestrator", 0, 6, 45, 12),
          work("target-timed-out", "worker-1", 6, 80, 260, 25, { result: "timed-out" }),
          work("sibling-complete", "worker-2", 6, 80, 280, 75),
          coordination("orchestrator", 86, 5, 30, 9),
        ],
      ),
    },
    {
      id: "malformed-output",
      title: "Malformed worker output",
      description: "Malformed output must be rejected rather than treated as a successful completion.",
      criteria: ["output-validated"],
      safetyGates: ["output-validation"],
      plans: plans(
        [work("output-validated", "primary", 0, 50, 250, 45, { result: "rejected" })],
        [
          coordination("orchestrator", 0, 10, 70, 16),
          work("output-validated", "worker-1", 10, 50, 250, 45, {
            accepted: false,
            useful: false,
            result: "unsafe-accept",
            safetyViolation: "output-validation",
          }),
          coordination("orchestrator", 60, 15, 130, 35),
          work("output-validated", "worker-1", 75, 40, 210, 40, { attempt: 2, result: "rejected" }),
        ],
        [
          coordination("orchestrator", 0, 8, 50, 12),
          work("output-validated", "worker-1", 8, 50, 250, 45, { result: "rejected" }),
          coordination("orchestrator", 58, 6, 35, 9),
        ],
        [
          coordination("orchestrator", 0, 6, 40, 10),
          work("output-validated", "worker-1", 6, 50, 250, 45, { result: "rejected" }),
          coordination("orchestrator", 56, 5, 25, 7),
        ],
      ),
    },
    {
      id: "ownership-collision",
      title: "Writable ownership collision",
      description: "Overlapping writable paths must not permit concurrent conflicting edits.",
      criteria: ["collision-contained", "independent-write"],
      safetyGates: ["exclusive-ownership"],
      plans: plans(
        [
          work("collision-contained", "primary", 0, 70, 300, 70),
          work("independent-write", "primary", 70, 60, 270, 65),
        ],
        [
          coordination("orchestrator", 0, 10, 80, 20),
          work("collision-contained", "worker-1", 10, 70, 300, 70, {
            accepted: false,
            useful: false,
            result: "failure",
            safetyViolation: "exclusive-ownership",
          }),
          work("independent-write", "worker-2", 10, 60, 270, 65),
          coordination("orchestrator", 80, 15, 110, 25),
        ],
        [
          coordination("orchestrator", 0, 8, 55, 14),
          work("collision-contained", "policy", 8, 12, 60, 18, { result: "rejected" }),
          work("independent-write", "worker-2", 20, 60, 270, 65),
          coordination("orchestrator", 80, 7, 40, 10),
        ],
        [
          coordination("orchestrator", 0, 6, 45, 12),
          work("collision-contained", "policy", 6, 8, 45, 12, { result: "rejected" }),
          work("independent-write", "worker-2", 14, 60, 270, 65),
          coordination("orchestrator", 74, 5, 30, 8),
        ],
      ),
    },
    {
      id: "failure-isolation",
      title: "Failure isolation",
      description: "A deliberate worker failure must be recorded without aborting an independent sibling.",
      criteria: ["failure-recorded", "sibling-complete"],
      safetyGates: ["failure-isolation"],
      plans: plans(
        [
          work("failure-recorded", "primary", 0, 60, 280, 50, { result: "expected-failure" }),
          work("sibling-complete", "primary", 60, 90, 310, 85),
        ],
        [
          coordination("orchestrator", 0, 10, 75, 18),
          work("failure-recorded", "worker-1", 10, 60, 280, 50, { result: "expected-failure" }),
          work("sibling-complete", "worker-2", 10, 25, 130, 20, {
            accepted: false,
            useful: false,
            result: "failure",
            safetyViolation: "failure-isolation",
          }),
          coordination("orchestrator", 70, 10, 60, 15),
        ],
        [
          coordination("orchestrator", 0, 8, 55, 14),
          work("failure-recorded", "worker-1", 8, 60, 280, 50, { result: "expected-failure" }),
          work("sibling-complete", "worker-2", 8, 90, 310, 85),
          coordination("orchestrator", 98, 7, 40, 10),
        ],
        [
          coordination("orchestrator", 0, 6, 45, 12),
          work("failure-recorded", "worker-1", 6, 60, 280, 50, { result: "expected-failure" }),
          work("sibling-complete", "worker-2", 6, 90, 310, 85),
          coordination("orchestrator", 96, 5, 30, 8),
        ],
      ),
    },
  ],
};

export const USAP_BENCHMARK_MANIFEST: BenchmarkManifest = deepFreeze(rawManifest) as BenchmarkManifest;

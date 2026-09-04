export const BENCHMARK_SCHEMA_VERSION = "1.0.0" as const;

export const BENCHMARK_SYSTEM_IDS = [
  "stock-pi",
  "legacy-parallel",
  "omp-native",
  "usap",
] as const;

export const BENCHMARK_CASE_IDS = [
  "direct-coupled",
  "independent-parallel",
  "dependency",
  "relay",
  "cancellation",
  "timeout",
  "malformed-output",
  "ownership-collision",
  "failure-isolation",
] as const;

export type BenchmarkSystemId = (typeof BENCHMARK_SYSTEM_IDS)[number];
export type BenchmarkCaseId = (typeof BENCHMARK_CASE_IDS)[number];
export type TracePhase = "work" | "coordination" | "wait";
export type WorkResult =
  | "pass"
  | "failure"
  | "expected-failure"
  | "cancelled"
  | "timed-out"
  | "rejected"
  | "unsafe-accept";

export interface FairnessControls {
  readonly model: "zai/glm-5.3-flash";
  readonly thinkingLevel: "high";
  readonly fallback: "disabled";
  readonly fallbackModels: readonly [];
  readonly providerCalls: "forbidden";
  readonly fixtureMode: "deterministic-synthetic";
}

export interface BenchmarkSystem {
  readonly id: BenchmarkSystemId;
  readonly label: string;
  readonly maxConcurrency: number;
  /** Frozen synthetic assumption, not a measured product claim. */
  readonly assumption: string;
}

export interface TraceStepBase {
  readonly workerId: string;
  readonly startMs: number;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface WorkTraceStep extends TraceStepBase {
  readonly phase: "work";
  readonly criterionId: string;
  readonly attempt: number;
  readonly result: WorkResult;
  /** Whether this step satisfies the case criterion. */
  readonly accepted: boolean;
  /** Whether its worker time contributes directly to an accepted result. */
  readonly useful: boolean;
  readonly safetyViolation?: string;
}

export interface CoordinationTraceStep extends TraceStepBase {
  readonly phase: "coordination";
}

export interface WaitTraceStep extends TraceStepBase {
  readonly phase: "wait";
}

export type SyntheticTraceStep = WorkTraceStep | CoordinationTraceStep | WaitTraceStep;

export interface BenchmarkCase {
  readonly id: BenchmarkCaseId;
  readonly title: string;
  readonly description: string;
  readonly criteria: readonly string[];
  readonly safetyGates: readonly string[];
  readonly plans: Readonly<Record<BenchmarkSystemId, readonly SyntheticTraceStep[]>>;
}

export interface BenchmarkManifest {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly benchmarkId: "usap-local-comparison";
  readonly mode: "synthetic-local-only";
  readonly fairness: FairnessControls;
  readonly systems: readonly BenchmarkSystem[];
  readonly cases: readonly BenchmarkCase[];
}

export type TraceEvent = SyntheticTraceStep & {
  readonly eventId: string;
  readonly caseId: BenchmarkCaseId;
  readonly systemId: BenchmarkSystemId;
  readonly endMs: number;
};

export interface CaseMetrics {
  /** Fraction of criteria accepted on attempt one, from 0 to 1. */
  readonly firstPassCompletion: number;
  /** Simulated wall-clock span from the first event start to the last event end. */
  readonly elapsedCriticalPathMs: number;
  /** Sum of all work spans, including failed, cancelled, and rework attempts. */
  readonly aggregateWorkerTimeMs: number;
  readonly totalTokens: number;
  /** Number of work attempts after attempt one. */
  readonly reworkAttempts: number;
  /** Fraction of declared safety gates without a trace violation, from 0 to 1. */
  readonly safetyScore: number;
  /** Accepted useful work time divided by elapsed time; may exceed 1 under parallelism. */
  readonly usefulConcurrency: number;
  readonly coordinationOverheadMs: number;
  readonly coordinationOverheadRatio: number;
}

export interface CaseResult {
  readonly caseId: BenchmarkCaseId;
  readonly systemId: BenchmarkSystemId;
  readonly trace: readonly TraceEvent[];
  readonly metrics: CaseMetrics;
}

export interface AggregateMetrics extends CaseMetrics {
  readonly caseCount: number;
}

export interface SystemResult {
  readonly systemId: BenchmarkSystemId;
  readonly cases: readonly CaseResult[];
  readonly metrics: AggregateMetrics;
}

export interface BenchmarkReport {
  readonly benchmarkId: BenchmarkManifest["benchmarkId"];
  readonly schemaVersion: BenchmarkManifest["schemaVersion"];
  readonly mode: BenchmarkManifest["mode"];
  readonly fairness: FairnessControls;
  readonly systems: readonly SystemResult[];
}

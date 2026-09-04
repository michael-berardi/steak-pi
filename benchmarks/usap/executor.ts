import { deepFreeze } from "./manifest.ts";
import {
  type AggregateMetrics,
  type BenchmarkCase,
  type BenchmarkManifest,
  type BenchmarkReport,
  type BenchmarkSystemId,
  type CaseMetrics,
  type CaseResult,
  type SyntheticTraceStep,
  type SystemResult,
  type TraceEvent,
  type WorkTraceStep,
} from "./types.ts";
import { validateBenchmarkManifest } from "./validation.ts";

function workSteps(steps: readonly SyntheticTraceStep[]): readonly WorkTraceStep[] {
  return steps.filter((step): step is WorkTraceStep => step.phase === "work");
}

/** Pure metric math over a synthetic trace. No clocks, processes, network, or providers are used. */
export function scoreTrace(
  criteria: readonly string[],
  safetyGates: readonly string[],
  steps: readonly SyntheticTraceStep[],
): CaseMetrics {
  if (steps.length === 0) throw new Error("cannot score an empty trace");
  if (criteria.length === 0 || new Set(criteria).size !== criteria.length) {
    throw new Error("criteria must be nonempty and unique");
  }
  if (safetyGates.length === 0 || new Set(safetyGates).size !== safetyGates.length) {
    throw new Error("safety gates must be nonempty and unique");
  }
  const criterionSet = new Set(criteria);
  const safetyGateSet = new Set(safetyGates);
  for (const step of workSteps(steps)) {
    if (!criterionSet.has(step.criterionId)) throw new Error(`undeclared criterion: ${step.criterionId}`);
    if (step.safetyViolation !== undefined && !safetyGateSet.has(step.safetyViolation)) {
      throw new Error(`undeclared safety gate: ${step.safetyViolation}`);
    }
  }
  const startedAt = Math.min(...steps.map((step) => step.startMs));
  const endedAt = Math.max(...steps.map((step) => step.startMs + step.durationMs));
  const elapsedCriticalPathMs = endedAt - startedAt;
  const work = workSteps(steps);
  const acceptedOnFirstPass = new Set(
    work.filter((step) => step.accepted && step.attempt === 1).map((step) => step.criterionId),
  );
  const violations = new Set(
    work.flatMap((step) => step.safetyViolation === undefined ? [] : [step.safetyViolation]),
  );
  const aggregateWorkerTimeMs = work.reduce((total, step) => total + step.durationMs, 0);
  const usefulWorkerTimeMs = work
    .filter((step) => step.useful)
    .reduce((total, step) => total + step.durationMs, 0);
  const coordinationOverheadMs = steps
    .filter((step) => step.phase === "coordination")
    .reduce((total, step) => total + step.durationMs, 0);
  const totalTokens = steps.reduce(
    (total, step) => total + step.inputTokens + step.outputTokens,
    0,
  );

  return {
    firstPassCompletion: acceptedOnFirstPass.size / criteria.length,
    elapsedCriticalPathMs,
    aggregateWorkerTimeMs,
    totalTokens,
    reworkAttempts: work.filter((step) => step.attempt > 1).length,
    safetyScore: (safetyGates.length - violations.size) / safetyGates.length,
    usefulConcurrency: usefulWorkerTimeMs / elapsedCriticalPathMs,
    coordinationOverheadMs,
    coordinationOverheadRatio: coordinationOverheadMs / elapsedCriticalPathMs,
  };
}

function materializeTrace(
  benchmarkCase: BenchmarkCase,
  systemId: BenchmarkSystemId,
): readonly TraceEvent[] {
  return benchmarkCase.plans[systemId].map((step, index) => ({
    ...step,
    eventId: `${benchmarkCase.id}:${systemId}:${index + 1}`,
    caseId: benchmarkCase.id,
    systemId,
    endMs: step.startMs + step.durationMs,
  }));
}

function runCase(benchmarkCase: BenchmarkCase, systemId: BenchmarkSystemId): CaseResult {
  const trace = materializeTrace(benchmarkCase, systemId);
  return {
    caseId: benchmarkCase.id,
    systemId,
    trace,
    metrics: scoreTrace(benchmarkCase.criteria, benchmarkCase.safetyGates, trace),
  };
}

function aggregate(cases: readonly BenchmarkCase[], results: readonly CaseResult[]): AggregateMetrics {
  const elapsedCriticalPathMs = results.reduce((total, result) => total + result.metrics.elapsedCriticalPathMs, 0);
  const coordinationOverheadMs = results.reduce(
    (total, result) => total + result.metrics.coordinationOverheadMs,
    0,
  );
  const totalCriteria = cases.reduce((total, benchmarkCase) => total + benchmarkCase.criteria.length, 0);
  const totalSafetyGates = cases.reduce((total, benchmarkCase) => total + benchmarkCase.safetyGates.length, 0);
  const acceptedFirstPass = results.reduce((total, result, index) =>
    total + result.metrics.firstPassCompletion * cases[index].criteria.length, 0);
  const passedSafetyGates = results.reduce((total, result, index) =>
    total + result.metrics.safetyScore * cases[index].safetyGates.length, 0);
  const usefulWorkerTimeMs = results.reduce((total, result) =>
    total + result.metrics.usefulConcurrency * result.metrics.elapsedCriticalPathMs, 0);

  return {
    caseCount: results.length,
    firstPassCompletion: acceptedFirstPass / totalCriteria,
    elapsedCriticalPathMs,
    aggregateWorkerTimeMs: results.reduce(
      (total, result) => total + result.metrics.aggregateWorkerTimeMs,
      0,
    ),
    totalTokens: results.reduce((total, result) => total + result.metrics.totalTokens, 0),
    reworkAttempts: results.reduce((total, result) => total + result.metrics.reworkAttempts, 0),
    safetyScore: passedSafetyGates / totalSafetyGates,
    usefulConcurrency: usefulWorkerTimeMs / elapsedCriticalPathMs,
    coordinationOverheadMs,
    coordinationOverheadRatio: coordinationOverheadMs / elapsedCriticalPathMs,
  };
}

/**
 * Replays the frozen local fixtures and emits deterministic traces and scores.
 * Validation runs first and hard-fails any mutation or fairness drift.
 */
export function runSyntheticBenchmark(manifest: BenchmarkManifest): BenchmarkReport {
  validateBenchmarkManifest(manifest);
  const systems: SystemResult[] = manifest.systems.map((system) => {
    const cases = manifest.cases.map((benchmarkCase) => runCase(benchmarkCase, system.id));
    return { systemId: system.id, cases, metrics: aggregate(manifest.cases, cases) };
  });
  return deepFreeze({
    benchmarkId: manifest.benchmarkId,
    schemaVersion: manifest.schemaVersion,
    mode: manifest.mode,
    fairness: manifest.fairness,
    systems,
  }) as BenchmarkReport;
}

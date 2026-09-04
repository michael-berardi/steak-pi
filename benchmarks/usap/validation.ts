import {
  BENCHMARK_CASE_IDS,
  BENCHMARK_SCHEMA_VERSION,
  BENCHMARK_SYSTEM_IDS,
  type BenchmarkCase,
  type BenchmarkManifest,
  type BenchmarkSystem,
  type BenchmarkSystemId,
  type SyntheticTraceStep,
  type WorkTraceStep,
} from "./types.ts";

export class BenchmarkManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkManifestError";
  }
}

function fail(message: string): never {
  throw new BenchmarkManifestError(message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${field} must have exactly these keys: ${expected.join(", ")}`);
  }
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    fail(`${field} must be a trimmed nonempty string`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${field} must be a nonnegative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, field: string): number {
  const integer = nonnegativeInteger(value, field);
  if (integer === 0) fail(`${field} must be positive`);
  return integer;
}

function uniqueStrings(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must be a nonempty array`);
  const strings = value.map((item, index) => nonempty(item, `${field}[${index}]`));
  if (new Set(strings).size !== strings.length) fail(`${field} must contain unique values`);
  return strings;
}

function assertDeepFrozen(value: unknown, field: string, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (!Object.isFrozen(value)) fail(`${field} must be recursively frozen`);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertDeepFrozen(child, `${field}.${key}`, seen);
  }
}

function validateSystem(value: unknown, index: number): BenchmarkSystem {
  const field = `systems[${index}]`;
  const source = record(value, field);
  exactKeys(source, ["id", "label", "maxConcurrency", "assumption"], field);
  if (source.id !== BENCHMARK_SYSTEM_IDS[index]) {
    fail(`${field}.id must be ${BENCHMARK_SYSTEM_IDS[index]}`);
  }
  nonempty(source.label, `${field}.label`);
  const maxConcurrency = positiveInteger(source.maxConcurrency, `${field}.maxConcurrency`);
  if (maxConcurrency > 4) fail(`${field}.maxConcurrency must not exceed 4`);
  nonempty(source.assumption, `${field}.assumption`);
  return source as unknown as BenchmarkSystem;
}

const RESULTS = new Set([
  "pass",
  "failure",
  "expected-failure",
  "cancelled",
  "timed-out",
  "rejected",
  "unsafe-accept",
]);

function validateStep(
  value: unknown,
  field: string,
  criteria: ReadonlySet<string>,
  safetyGates: ReadonlySet<string>,
): SyntheticTraceStep {
  const source = record(value, field);
  if (source.phase !== "work" && source.phase !== "coordination" && source.phase !== "wait") {
    fail(`${field}.phase is invalid`);
  }
  const common = ["phase", "workerId", "startMs", "durationMs", "inputTokens", "outputTokens"];
  exactKeys(
    source,
    source.phase === "work"
      ? [...common, "criterionId", "attempt", "result", "accepted", "useful", ...(source.safetyViolation === undefined ? [] : ["safetyViolation"])]
      : common,
    field,
  );
  nonempty(source.workerId, `${field}.workerId`);
  nonnegativeInteger(source.startMs, `${field}.startMs`);
  positiveInteger(source.durationMs, `${field}.durationMs`);
  nonnegativeInteger(source.inputTokens, `${field}.inputTokens`);
  nonnegativeInteger(source.outputTokens, `${field}.outputTokens`);

  if (source.phase === "work") {
    const criterionId = nonempty(source.criterionId, `${field}.criterionId`);
    if (!criteria.has(criterionId)) fail(`${field}.criterionId is not declared by its case`);
    positiveInteger(source.attempt, `${field}.attempt`);
    if (!RESULTS.has(String(source.result))) fail(`${field}.result is invalid`);
    if (typeof source.accepted !== "boolean" || typeof source.useful !== "boolean") {
      fail(`${field}.accepted and useful must be booleans`);
    }
    if (source.useful && !source.accepted) fail(`${field} cannot be useful unless it is accepted`);
    if (source.result === "unsafe-accept" && (source.accepted || source.safetyViolation === undefined)) {
      fail(`${field} unsafe-accept must be unaccepted and declare a safety violation`);
    }
    if (source.safetyViolation !== undefined) {
      const violation = nonempty(source.safetyViolation, `${field}.safetyViolation`);
      if (!safetyGates.has(violation)) fail(`${field}.safetyViolation is not a declared safety gate`);
    }
  }
  return source as unknown as SyntheticTraceStep;
}

function peakWorkConcurrency(steps: readonly SyntheticTraceStep[]): number {
  const points = steps
    .filter((step): step is WorkTraceStep => step.phase === "work")
    .flatMap((step) => [
      { at: step.startMs, delta: 1 },
      { at: step.startMs + step.durationMs, delta: -1 },
    ])
    .sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let peak = 0;
  for (const point of points) {
    active += point.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

function validatePlan(
  value: unknown,
  field: string,
  benchmarkCase: Pick<BenchmarkCase, "criteria" | "safetyGates">,
  system: BenchmarkSystem,
): readonly SyntheticTraceStep[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must be a nonempty array`);
  const criteria = new Set(benchmarkCase.criteria);
  const safetyGates = new Set(benchmarkCase.safetyGates);
  const steps = value.map((step, index) => validateStep(step, `${field}[${index}]`, criteria, safetyGates));
  let previousStart = -1;
  const lastEndByWorker = new Map<string, number>();
  const seenCriteria = new Set<string>();
  const attempts = new Map<string, Set<number>>();

  for (const [index, step] of steps.entries()) {
    if (step.startMs < previousStart) fail(`${field}[${index}] is not sorted by startMs`);
    previousStart = step.startMs;
    const lastEnd = lastEndByWorker.get(step.workerId) ?? -1;
    if (step.startMs < lastEnd) fail(`${field}[${index}] overlaps another span for ${step.workerId}`);
    lastEndByWorker.set(step.workerId, step.startMs + step.durationMs);
    if (step.phase === "work") {
      seenCriteria.add(step.criterionId);
      const values = attempts.get(step.criterionId) ?? new Set<number>();
      values.add(step.attempt);
      attempts.set(step.criterionId, values);
    }
  }
  for (const criterion of benchmarkCase.criteria) {
    if (!seenCriteria.has(criterion)) fail(`${field} does not exercise criterion ${criterion}`);
    const values = attempts.get(criterion)!;
    const max = Math.max(...values);
    for (let attempt = 1; attempt <= max; attempt += 1) {
      if (!values.has(attempt)) fail(`${field} has a noncontiguous attempt sequence for ${criterion}`);
    }
  }
  if (peakWorkConcurrency(steps) > system.maxConcurrency) {
    fail(`${field} exceeds ${system.id}'s maxConcurrency`);
  }
  return steps;
}

function validateCase(value: unknown, index: number, systems: readonly BenchmarkSystem[]): BenchmarkCase {
  const field = `cases[${index}]`;
  const source = record(value, field);
  exactKeys(source, ["id", "title", "description", "criteria", "safetyGates", "plans"], field);
  if (source.id !== BENCHMARK_CASE_IDS[index]) fail(`${field}.id must be ${BENCHMARK_CASE_IDS[index]}`);
  nonempty(source.title, `${field}.title`);
  nonempty(source.description, `${field}.description`);
  const criteria = uniqueStrings(source.criteria, `${field}.criteria`);
  const safetyGates = uniqueStrings(source.safetyGates, `${field}.safetyGates`);
  const planRecord = record(source.plans, `${field}.plans`);
  exactKeys(planRecord, BENCHMARK_SYSTEM_IDS, `${field}.plans`);
  for (const system of systems) {
    validatePlan(
      planRecord[system.id],
      `${field}.plans.${system.id}`,
      { criteria, safetyGates },
      system,
    );
  }
  return source as unknown as BenchmarkCase;
}

/**
 * Enforces the local-only benchmark contract. Any provider mode, fallback,
 * omitted system/case, mutable fixture, malformed trace, or concurrency excess
 * is a hard error rather than a benchmark result.
 */
export function validateBenchmarkManifest(value: unknown): asserts value is BenchmarkManifest {
  const source = record(value, "manifest");
  exactKeys(source, ["schemaVersion", "benchmarkId", "mode", "fairness", "systems", "cases"], "manifest");
  if (source.schemaVersion !== BENCHMARK_SCHEMA_VERSION) fail(`schemaVersion must be ${BENCHMARK_SCHEMA_VERSION}`);
  if (source.benchmarkId !== "usap-local-comparison") fail("benchmarkId is not recognized");
  if (source.mode !== "synthetic-local-only") fail("mode must be synthetic-local-only");

  const fairness = record(source.fairness, "fairness");
  exactKeys(
    fairness,
    ["model", "thinkingLevel", "fallback", "fallbackModels", "providerCalls", "fixtureMode"],
    "fairness",
  );
  if (fairness.model !== "zai/glm-5.3-flash") fail("fairness.model must be zai/glm-5.3-flash");
  if (fairness.thinkingLevel !== "high") fail("fairness.thinkingLevel must be high");
  if (fairness.fallback !== "disabled") fail("fairness.fallback must be disabled");
  if (!Array.isArray(fairness.fallbackModels) || fairness.fallbackModels.length !== 0) {
    fail("fairness.fallbackModels must be empty");
  }
  if (fairness.providerCalls !== "forbidden") fail("fairness.providerCalls must be forbidden");
  if (fairness.fixtureMode !== "deterministic-synthetic") {
    fail("fairness.fixtureMode must be deterministic-synthetic");
  }

  if (!Array.isArray(source.systems) || source.systems.length !== BENCHMARK_SYSTEM_IDS.length) {
    fail(`systems must contain exactly ${BENCHMARK_SYSTEM_IDS.length} entries`);
  }
  const systems = source.systems.map(validateSystem);
  if (!Array.isArray(source.cases) || source.cases.length !== BENCHMARK_CASE_IDS.length) {
    fail(`cases must contain exactly ${BENCHMARK_CASE_IDS.length} entries`);
  }
  source.cases.forEach((benchmarkCase, index) => validateCase(benchmarkCase, index, systems));
  assertDeepFrozen(value, "manifest");
}

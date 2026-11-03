/**
 * Route evidence: what each task class actually got from each route, as an append-only JSONL.
 *
 * The task-class router (`task-class.ts`, `route-ranking.ts`) ranks a class's chain on this evidence, so the file
 * is the only memory of how routes behave: one `task` record per settled task of a classed wave, `verdict`
 * records that attach a later verification result to the same run and task, and `probe` markers that start a
 * re-probe cooldown. Nothing is ever rewritten in place; the store rotates at a size bound instead.
 *
 * Steak Pi ships no route, model or class here: every name in the file is one the operator configured.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RunRecord, TaskRecord } from "./types.ts";

export const ROUTE_EVIDENCE_ENV = "STEAK_PI_ROUTE_EVIDENCE";
/** One generation of history is kept next to the live file, so the store stays under about twice this. */
export const ROUTE_EVIDENCE_MAX_BYTES = 5_000_000;
export const routeEvidencePath = (): string =>
  process.env[ROUTE_EVIDENCE_ENV] ?? join(homedir(), ".pi", "agent", "usap", "route-evidence.jsonl");

export type EvidenceOutcome = "pass" | "fail" | "unknown";
/** Where the outcome came from, weakest last: a reviewer's verdict, a test gate the worker reported, an
 * operator's explicit record, or only the worker's own final state. */
export type EvidenceSource = "verification" | "test-gate" | "operator" | "worker-state";
export const FAILURE_KINDS = ["empty-output", "reasoning-exhausted", "tool-error", "http-4xx", "http-5xx", "quota", "rate-limit", "other"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export interface TaskEvidence {
  v: 1;
  kind: "task";
  at: number;
  runId: string;
  taskId: string;
  label: string;
  taskClass: string;
  /** The class chain entry (profile id or `provider/model`) that produced this outcome. */
  route: string;
  outcome: EvidenceOutcome;
  source: EvidenceSource;
  wallSeconds: number;
  costUsd: number;
  tokens: number;
  failureKind?: FailureKind;
  /** The task left this route on the way (a failover hop): a verdict on the finished work does not judge it. */
  hop?: true;
  /** A same-route retry with a higher output budget was needed. */
  retried?: true;
  /** The pick was an exploratory or re-probe pick, not the expected best. */
  explored?: true;
}
export interface VerdictEvidence {
  v: 1;
  kind: "verdict";
  at: number;
  runId: string;
  /** Absent: the verdict covers every classed task of the run. */
  taskId?: string;
  outcome: "pass" | "fail";
  source: Exclude<EvidenceSource, "worker-state">;
  note?: string;
}
export interface ProbeEvidence {
  v: 1;
  kind: "probe";
  at: number;
  taskClass: string;
  route: string;
  runId?: string;
}
export type EvidenceRecord = TaskEvidence | VerdictEvidence | ProbeEvidence;

/** What the ranking reads: task records with the latest verdict applied, and the probe markers. */
export interface EvidenceView {
  tasks: TaskEvidence[];
  probes: ProbeEvidence[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const text = (value: unknown, max: number): string | undefined => typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
const SOURCES: readonly string[] = ["verification", "test-gate", "operator", "worker-state"];

/** Parse one JSONL line; anything malformed is dropped, never thrown (a damaged line must not blind the router). */
export function parseEvidenceLine(line: string): EvidenceRecord | undefined {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return undefined; }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const item = raw as Record<string, unknown>;
  if (item.v !== 1 || !finite(item.at)) return undefined;
  if (item.kind === "task") {
    const [runId, taskId, taskClass, route] = [text(item.runId, 160), text(item.taskId, 160), text(item.taskClass, 64), text(item.route, 300)];
    if (!runId || !taskId || !taskClass || !route) return undefined;
    if (item.outcome !== "pass" && item.outcome !== "fail" && item.outcome !== "unknown") return undefined;
    if (typeof item.source !== "string" || !SOURCES.includes(item.source)) return undefined;
    const kind = FAILURE_KINDS.find((candidate) => candidate === item.failureKind);
    return {
      v: 1, kind: "task", at: item.at, runId, taskId, label: text(item.label, 80) ?? taskId, taskClass, route,
      outcome: item.outcome, source: item.source as EvidenceSource,
      wallSeconds: finite(item.wallSeconds) && item.wallSeconds >= 0 ? item.wallSeconds : 0,
      costUsd: finite(item.costUsd) && item.costUsd >= 0 ? item.costUsd : 0,
      tokens: finite(item.tokens) && item.tokens >= 0 ? Math.floor(item.tokens) : 0,
      ...(kind ? { failureKind: kind } : {}),
      ...(item.hop === true ? { hop: true as const } : {}),
      ...(item.retried === true ? { retried: true as const } : {}),
      ...(item.explored === true ? { explored: true as const } : {}),
    };
  }
  if (item.kind === "verdict") {
    const runId = text(item.runId, 160);
    if (!runId || (item.outcome !== "pass" && item.outcome !== "fail")) return undefined;
    if (typeof item.source !== "string" || !SOURCES.includes(item.source) || item.source === "worker-state") return undefined;
    const taskId = text(item.taskId, 160);
    const note = text(item.note, 300);
    return { v: 1, kind: "verdict", at: item.at, runId, ...(taskId ? { taskId } : {}), outcome: item.outcome, source: item.source as VerdictEvidence["source"], ...(note ? { note } : {}) };
  }
  if (item.kind === "probe") {
    const [taskClass, route] = [text(item.taskClass, 64), text(item.route, 300)];
    if (!taskClass || !route) return undefined;
    const runId = text(item.runId, 160);
    return { v: 1, kind: "probe", at: item.at, taskClass, route, ...(runId ? { runId } : {}) };
  }
  return undefined;
}

/** Apply the latest verdict to each task record it covers, in the order the records were appended. */
export function foldEvidence(records: readonly EvidenceRecord[]): EvidenceView {
  const tasks: TaskEvidence[] = [];
  const verdicts: VerdictEvidence[] = [];
  const probes: ProbeEvidence[] = [];
  for (const record of records) {
    if (record.kind === "task") tasks.push({ ...record });
    else if (record.kind === "verdict") verdicts.push(record);
    else probes.push(record);
  }
  for (const verdict of verdicts) {
    for (const task of tasks) {
      if (task.hop || task.runId !== verdict.runId || (verdict.taskId !== undefined && task.taskId !== verdict.taskId)) continue;
      task.outcome = verdict.outcome;
      task.source = verdict.source;
      if (verdict.outcome === "pass") delete task.failureKind;
    }
  }
  return { tasks, probes };
}

export interface RouteEvidenceStoreOptions {
  maxBytes?: number;
  now?: () => number;
}

/**
 * The append-only JSONL. Appends never throw (evidence must never fail a dispatch); a write error is kept in
 * `lastError` for the hub view. The file rotates to `<path>.1` once it passes `maxBytes`, replacing the older
 * generation, so the store is bounded by about twice that size.
 */
export class RouteEvidenceStore {
  readonly path: string;
  readonly maxBytes: number;
  lastError?: string;
  private readonly now: () => number;
  private cache?: { signature: string; view: EvidenceView };

  constructor(path: string = routeEvidencePath(), options: RouteEvidenceStoreOptions = {}) {
    this.path = path;
    this.maxBytes = options.maxBytes ?? ROUTE_EVIDENCE_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  get previousPath(): string { return `${this.path}.1`; }

  append(record: EvidenceRecord): boolean {
    try {
      const line = `${JSON.stringify(record)}\n`;
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.path, line, { mode: 0o600 });
      this.cache = undefined;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** Re-stat right before renaming, so a second process that rotated first is not rotated again. */
  private rotateIfNeeded(incoming: number): void {
    let size = 0;
    try { size = statSync(this.path).size; } catch { return; }
    if (size + incoming <= this.maxBytes) return;
    try { renameSync(this.path, this.previousPath); } catch { /* another writer rotated first */ }
  }

  recordTask(input: Omit<TaskEvidence, "v" | "kind" | "at"> & { at?: number }): boolean {
    return this.append({ v: 1, kind: "task", ...input, at: input.at ?? this.now() });
  }

  /** Attach a later verification result to a run (and one task of it, when `taskId` is given). */
  recordVerdict(input: Omit<VerdictEvidence, "v" | "kind" | "at"> & { at?: number }): boolean {
    return this.append({ v: 1, kind: "verdict", ...input, at: input.at ?? this.now() });
  }

  recordProbe(input: Omit<ProbeEvidence, "v" | "kind" | "at"> & { at?: number }): boolean {
    return this.append({ v: 1, kind: "probe", ...input, at: input.at ?? this.now() });
  }

  /** Every record of both generations, oldest first. Malformed lines are skipped. */
  records(): EvidenceRecord[] {
    const records: EvidenceRecord[] = [];
    for (const file of [this.previousPath, this.path]) {
      if (!existsSync(file)) continue;
      let body: string;
      try { body = readFileSync(file, "utf8"); } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); continue; }
      for (const line of body.split("\n")) {
        if (line.length === 0) continue;
        const parsed = parseEvidenceLine(line);
        if (parsed) records.push(parsed);
      }
    }
    return records;
  }

  /** The folded view, cached on file size and mtime so a dispatch does not re-parse an unchanged store. */
  view(): EvidenceView {
    const signature = [this.previousPath, this.path].map((file) => {
      try { const stat = statSync(file); return `${stat.size}:${stat.mtimeMs}`; } catch { return "-"; }
    }).join("|");
    if (this.cache?.signature === signature) return this.cache.view;
    const view = foldEvidence(this.records());
    this.cache = { signature, view };
    return view;
  }
}

/** Name a failure from its error text. Order matters: the most specific, route-level causes come first. */
export function classifyFailure(error: string | undefined): FailureKind {
  const message = error ?? "";
  // A budget stop says nothing about the route; its numbers must not read as an HTTP status.
  if (/turn.limit|-turn|turn budget|time budget|deadline|timed out after/i.test(message) && !/\b402\b|insufficient[_ ]credits/i.test(message)) return "other";
  if (/\b402\b|insufficient[_ ]credits|requires more credits|no endpoints? (?:found|available)|endpoints? out of \d+ requested|subscription_quota_exceeded|usage limit|quota[_ -]?(?:exhausted|exceeded|reached)/i.test(message)) return "quota";
  // A 429 or rate limit is the route throttling right now, not a 4xx defect: it is held out at once (2026-11-03: a route kept
  // receiving scouts while every call came back 429, because a 4xx only demotes after three in a row).
  if (/\b429\b|too many requests|rate.?limit/i.test(message)) return "rate-limit";
  if (/\b5\d\d\b|overloaded|service unavailable|bad gateway|gateway time-?out/i.test(message)) return "http-5xx";
  if (/\b4\d\d\b/i.test(message)) return "http-4xx";
  if (/no final output|produced no (?:final )?(?:output|answer)|empty (?:reply|response|output)/i.test(message)) return "empty-output";
  if (/out of output tokens|stopReason length|max_tokens|output budget|reasoning[^.]*(?:exhaust|budget|ran out)/i.test(message)) return "reasoning-exhausted";
  if (/tool[^.]*(?:error|fail)|(?:error|fail)[^.]*tool/i.test(message)) return "tool-error";
  return "other";
}

/** `TEST-GATE: pass|fail` is the line a worker on a test-gated class puts in its report. */
export function testGateResult(output: string): "pass" | "fail" | undefined {
  const matches = [...output.matchAll(/^\s*TEST-GATE:\s*(pass|fail)\b/gim)];
  const last = matches.at(-1)?.[1]?.toLowerCase();
  return last === "pass" || last === "fail" ? last : undefined;
}

/** The class-chain entry that owns a `provider/model` route in this run's recorded order. */
function entryOfRoute(run: RunRecord, route: string): string {
  return run.selection?.taskClass?.decision?.order.find((item) => item.route === route)?.entry ?? route;
}

/**
 * The evidence one settled task of a classed wave leaves: a `fail` record for each route it left on the way
 * (a pre-output hop, a post-output alternate), then one record for the route that finished it. Only a task that
 * itself declared the class counts, and only when the class steered the run.
 */
export function settledTaskEvidence(run: RunRecord, task: TaskRecord, now: number): TaskEvidence[] {
  const receipt = run.selection?.taskClass;
  if (!receipt || receipt.outcome !== "served" || task.taskClass !== receipt.name || receipt.step === undefined) return [];
  const base = { v: 1 as const, kind: "task" as const, runId: run.id, taskId: task.id, label: task.label.slice(0, 80), taskClass: receipt.name };
  const hops = task.routeHopDetails ?? [];
  const records: TaskEvidence[] = hops.map((hop) => ({
    ...base, at: now, route: entryOfRoute(run, hop.from), outcome: "fail" as const, source: "worker-state" as const,
    wallSeconds: hop.seconds, costUsd: hop.costUsd, tokens: 0, failureKind: classifyFailure(hop.cause), hop: true as const,
  }));
  const finalRoute = hops.length > 0 ? entryOfRoute(run, hops[hops.length - 1].to) : receipt.step;
  const gate = testGateResult(task.output);
  const kind = task.state === "failed" || task.state === "timed_out" ? classifyFailure(task.error) : undefined;
  let outcome: EvidenceOutcome;
  let source: EvidenceSource = "worker-state";
  if (task.state === "done") {
    if (gate) { outcome = gate; source = "test-gate"; } else outcome = receipt.requiresTestGate ? "unknown" : "pass";
  } else if (task.state === "aborted" || task.startedAt === undefined) outcome = "unknown";
  else outcome = "fail";
  const spentOnHops = hops.reduce((sum, hop) => sum + hop.costUsd, 0);
  const secondsOnHops = hops.reduce((sum, hop) => sum + hop.seconds, 0);
  const wall = task.startedAt !== undefined && task.endedAt !== undefined ? Math.max(0, (task.endedAt - task.startedAt) / 1000) : 0;
  records.push({
    ...base, at: now, route: finalRoute, outcome, source,
    wallSeconds: Math.max(0, wall - secondsOnHops), costUsd: Math.max(0, (finite(task.usage?.cost?.total) ? task.usage.cost.total : 0) - spentOnHops),
    tokens: finite(task.usage?.totalTokens) ? Math.max(0, Math.floor(task.usage.totalTokens)) : 0,
    ...(outcome === "fail" && kind ? { failureKind: kind } : {}),
    ...(task.retriedOnSameRoute ? { retried: true as const } : {}),
    ...(receipt.decision?.explored && finalRoute === receipt.step ? { explored: true as const } : {}),
  });
  return records;
}

/** Record every evidence row a settled task leaves; never throws. */
export function recordSettledTask(store: RouteEvidenceStore, run: RunRecord, task: TaskRecord, now: number): number {
  let written = 0;
  try {
    for (const record of settledTaskEvidence(run, task, now)) if (store.append(record)) written += 1;
  } catch (error) {
    store.lastError = error instanceof Error ? error.message : String(error);
  }
  return written;
}

/**
 * Supported CLI/integration entry for explicit Claude API USAP waves.
 *
 * A running parent session keeps the tool schema and extension it loaded at
 * start, so it cannot pick up a new route without a restart. This module drives
 * the SAME SubagentCoordinator, claude-code worker runner, checkpoint store and
 * admission boundary the extension uses, from a standalone process
 * (scripts/usap-claude-api.ts), so a parent can run API waves and bounded
 * resumes without restarting or closing any operator session. It spawns the
 * official CLI only through the worker runner; nothing here talks to the API.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SubagentCoordinator } from "./coordinator.ts";
import { CheckpointStore } from "./checkpoints.ts";
import { normalizeDispatch } from "./policy.ts";
import { createClaudeWorkerRunner, type ClaudeSpawn } from "./claude-worker.ts";
import {
  admitClaudeApiRoute, claudeApiConcurrency, claudeApiModelOf, CLAUDE_API_ROUTES, CLAUDE_API_SONNET_ROUTE, formatClaudeApiReceipt,
  resolveClaudeApiSelection, stampClaudeApiRun, type ClaudeApiAdmission, type ClaudeApiConfigOptions,
} from "./claude-api-route.ts";
import { USAP_VERSION, type RunRecord, type SubagentTaskInput } from "./types.ts";
import type { MachineSlots, NoopSlots } from "./machine-slots.ts";
import type { SessionScheduler } from "./scheduler.ts";

export const CLAUDE_API_CLI_OWNER = "usap-claude-api-cli";
export const CLAUDE_API_CLI_DEFAULT_ROOT = join(homedir(), ".pi", "agent", "usap");

export interface ClaudeApiWaveSpec {
  goal: string;
  route: string;
  cwd: string;
  constraints?: string[];
  contract?: string;
  tasks: SubagentTaskInput[];
  concurrency?: number;
  timeoutMs?: number;
  maxTurns?: number;
}

const SPEC_KEYS = ["goal", "route", "cwd", "constraints", "contract", "tasks", "concurrency", "timeoutMs", "maxTurns"];
const TASK_KEYS = ["label", "task", "role", "mayEdit", "ownedPaths", "allowBash"];

/** Strict wave spec: unknown keys are errors, so a typo can never widen permissions silently. */
export function parseWaveSpec(text: string): ClaudeApiWaveSpec {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("wave spec is not valid JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("wave spec must be a JSON object");
  const spec = value as Record<string, unknown>;
  const extra = Object.keys(spec).filter((key) => !SPEC_KEYS.includes(key));
  if (extra.length) throw new Error(`wave spec has unsupported key(s): ${extra.slice(0, 4).join(", ")}`);
  if (typeof spec.goal !== "string" || typeof spec.cwd !== "string" || !spec.cwd.startsWith("/")) throw new Error("wave spec needs a goal string and an absolute cwd");
  const route = spec.route === undefined ? CLAUDE_API_SONNET_ROUTE : spec.route;
  if (typeof route !== "string" || !CLAUDE_API_ROUTES.includes(route)) throw new Error(`wave spec route must be one of ${CLAUDE_API_ROUTES.join(", ")}`);
  if (!Array.isArray(spec.tasks)) throw new Error("wave spec needs a tasks array");
  for (const [index, task] of spec.tasks.entries()) {
    if (task === null || typeof task !== "object" || Array.isArray(task)) throw new Error(`tasks[${index}] must be an object`);
    const bad = Object.keys(task).filter((key) => !TASK_KEYS.includes(key));
    if (bad.length) throw new Error(`tasks[${index}] has unsupported key(s): ${bad.slice(0, 4).join(", ")}`);
  }
  return { ...spec, route } as unknown as ClaudeApiWaveSpec;
}

export interface ClaudeApiWaveDeps {
  checkpointRoot?: string;
  /** Test seams; production leaves these unset (real CLI, real clock, real slots). */
  spawn?: ClaudeSpawn;
  executable?: string;
  abortGraceMs?: number;
  api?: ClaudeApiConfigOptions;
  apiAuthStatus?: (settingsPath: string) => Promise<unknown>;
  scheduler?: SessionScheduler;
  machineSlots?: MachineSlots | NoopSlots;
  now?: () => number;
  idFactory?: () => string;
  /** Aborting cancels the whole run through the coordinator (child processes are signalled by the runner). */
  signal?: AbortSignal;
  onStart?: (run: RunRecord) => void;
}

export interface ClaudeApiWaveOutcome {
  run: RunRecord;
  exitCode: 0 | 1 | 130;
  summary: ReturnType<typeof summarizeRun>;
  text: string;
}

/** Sanitized, JSON-safe digest: ids, states, usage and receipts; no task text, no credentials. */
export function summarizeRun(run: RunRecord) {
  return {
    runId: run.id, state: run.state, route: run.model, harness: run.harness ?? "pi", thinking: run.thinkingLevel,
    totalTokens: run.usage.totalTokens, totalCostUsd: Math.round(run.usage.cost.total * 1e6) / 1e6,
    ...(run.resumedFrom ? { resumedFrom: run.resumedFrom } : {}),
    tasks: run.tasks.map((task) => ({
      id: task.id, label: task.label, role: task.role, state: task.state, turns: task.turns,
      toolSuccesses: task.toolSuccesses ?? 0, toolErrors: task.toolErrors ?? 0,
      costUsd: Math.round(task.usage.cost.total * 1e6) / 1e6,
      ...(task.error ? { error: task.error } : {}),
      ...(task.claudeSessionId ? { sessionId: task.claudeSessionId } : {}),
      ...(task.changedPaths?.length ? { changedPaths: task.changedPaths } : {}),
      ...(task.apiReceipt ? { receipt: task.apiReceipt } : {}),
    })),
  };
}

function render(run: RunRecord): string {
  return run.tasks.map((task) => `[${task.label}] ${task.state}${task.error ? `\nerror: ${task.error}` : ""}${task.apiReceipt ? `\n${formatClaudeApiReceipt(task.apiReceipt)}` : ""}\n${task.output || "(no output)"}`).join("\n\n");
}

function open(deps: ClaudeApiWaveDeps): CheckpointStore {
  const root = deps.checkpointRoot ?? CLAUDE_API_CLI_DEFAULT_ROOT;
  // A fixed synthetic parent identity keeps checkpoints and the one bounded resume reachable across CLI invocations.
  return new CheckpointStore(join(root, `${CLAUDE_API_CLI_OWNER}.session`), root, CLAUDE_API_CLI_OWNER);
}

function coordinatorFor(deps: ClaudeApiWaveDeps, store: CheckpointStore): SubagentCoordinator {
  const runner = createClaudeWorkerRunner({
    ...(deps.spawn ? { spawn: deps.spawn } : {}),
    ...(deps.executable ? { executable: deps.executable } : {}),
    ...(deps.abortGraceMs === undefined ? {} : { abortGraceMs: deps.abortGraceMs }),
    ...(deps.api ? { api: deps.api } : {}),
    ...(deps.apiAuthStatus ? { apiAuthStatus: deps.apiAuthStatus } : {}),
  });
  return new SubagentCoordinator(runner, {
    ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
    ...(deps.machineSlots ? { machineSlots: deps.machineSlots } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    onChange: (run) => { try { store.save(run); } catch { /* the terminal save below is forced and surfaces failures */ } },
  });
}

async function settle(coordinator: SubagentCoordinator, store: CheckpointStore, started: RunRecord, deps: ClaudeApiWaveDeps): Promise<ClaudeApiWaveOutcome> {
  let cancelled = false;
  const abort = () => { cancelled = true; coordinator.cancel(started.id, undefined, "Cancelled by the CLI caller"); };
  if (deps.signal?.aborted) abort(); else deps.signal?.addEventListener("abort", abort, { once: true });
  try {
    const settled = await coordinator.wait(started.id, "all");
    store.save(settled, true);
    const exitCode = cancelled || settled.tasks.some((task) => task.state === "aborted") ? 130 : settled.state === "done" ? 0 : 1;
    return { run: settled, exitCode, summary: summarizeRun(settled), text: render(settled) };
  } finally {
    deps.signal?.removeEventListener("abort", abort);
    await coordinator.shutdown();
    store.close();
  }
}

/** Admit, dispatch and settle one explicit Claude API wave in the native coordinator. */
export async function runClaudeApiWave(spec: ClaudeApiWaveSpec, deps: ClaudeApiWaveDeps = {}): Promise<ClaudeApiWaveOutcome> {
  if (!statSync(spec.cwd).isDirectory()) throw new Error("wave cwd is not a directory");
  // Operator approval, settings contract and budget are decided before any checkpoint or child exists.
  const admission = admitClaudeApiRoute({ route: spec.route, taskCount: spec.tasks.length, roles: spec.tasks.map((task) => task.role ?? "worker") }, deps.api);
  const model = claudeApiModelOf(spec.route)!;
  const now = deps.now?.() ?? Date.now();
  const run = normalizeDispatch({
    goal: spec.goal, harness: "claude-code", model: spec.route, thinking: "xhigh", background: false, tasks: spec.tasks,
    concurrency: claudeApiConcurrency(spec.concurrency, spec.tasks.length),
    ...(spec.constraints ? { constraints: spec.constraints } : {}), ...(spec.contract ? { contract: spec.contract } : {}),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }), ...(spec.maxTurns === undefined ? {} : { maxTurns: spec.maxTurns }),
  }, spec.cwd, spec.route, "xhigh", now, deps.idFactory);
  stampClaudeApiRun(run, admission);
  run.selection = resolveClaudeApiSelection(model);
  const store = open(deps);
  let coordinator: SubagentCoordinator | undefined;
  try {
    run.ownerSessionId = CLAUDE_API_CLI_OWNER;
    store.save(run, true);
    coordinator = coordinatorFor(deps, store);
    const started = coordinator.start(run);
    deps.onStart?.(started);
    return await settle(coordinator, store, started, deps);
  } catch (error) {
    await coordinator?.shutdown().catch(() => undefined);
    store.close();
    throw error;
  }
}

/** The one bounded resume of an unfinished API run, on the same route and with the remaining budget. */
export async function resumeClaudeApiRun(runId: string, deps: ClaudeApiWaveDeps = {}): Promise<ClaudeApiWaveOutcome> {
  const store = open(deps);
  let coordinator: SubagentCoordinator | undefined;
  try {
    const checkpoint = store.get(runId);
    if (!checkpoint) throw new Error(`Unknown checkpoint ${runId}`);
    const snapshot = checkpoint.run;
    if (claudeApiModelOf(snapshot.model) === undefined || snapshot.harness !== "claude-code") throw new Error("Resume refused: this CLI resumes only explicit Claude API runs");
    if (snapshot.state === "running") throw new Error("Run is still active; resume would duplicate work");
    if (checkpoint.resumedAs) throw new Error(`Already resumed as ${checkpoint.resumedAs}; inspect that run instead`);
    if (checkpoint.pendingResume) throw new Error("Resume reservation interrupted; inspect the checkpoint before retrying");
    if (snapshot.version !== USAP_VERSION) throw new Error("Checkpoint policy version is incompatible; inspect history before a new dispatch");
    if (!statSync(snapshot.cwd).isDirectory()) throw new Error("Checkpoint workspace is unavailable");
    const unfinished = snapshot.tasks.filter((task) => task.state !== "done");
    if (!unfinished.length) throw new Error("No unfinished tasks to resume");
    const spent = snapshot.resumedFrom ?? unfinished.find((task) => task.resumedFrom)?.resumedFrom;
    if (spent) throw new Error(`Resume refused: a task is resumed at most once (already continuing ${spent}); dispatch a new, explicitly scoped task for what remains.`);
    for (const task of unfinished) {
      if (task.startedAt !== undefined && !task.claudeSessionId) throw new Error(`No Claude session checkpoint for ${task.label}; inspect partial work before a new dispatch`);
    }
    // Approval, settings and each leaf's remaining budget are admitted again BEFORE the one resume is spent.
    let admission: ClaudeApiAdmission | undefined;
    for (const task of unfinished) {
      admission = admitClaudeApiRoute({ route: snapshot.model, taskCount: snapshot.tasks.length, roles: [task.role],
        priorSpendUsd: task.usage.cost.total + (task.priorSpendUsd ?? 0), ...(task.apiLeafCapUsd === undefined ? {} : { leafCapLimitUsd: task.apiLeafCapUsd }) }, deps.api);
    }
    const run = normalizeDispatch({
      goal: snapshot.goal, constraints: snapshot.constraints, contract: snapshot.contract, harness: "claude-code", model: snapshot.model,
      thinking: "xhigh", concurrency: claudeApiConcurrency(snapshot.concurrency, unfinished.length), timeoutMs: snapshot.timeoutMs, maxTurns: snapshot.maxTurns, background: true,
      tasks: unfinished.map((task) => ({ label: task.label, task: task.task, role: task.role, mayEdit: task.mayEdit, ...(task.mayEdit ? { ownedPaths: task.ownedPaths } : {}), allowBash: task.allowBash })),
    }, snapshot.cwd, snapshot.model, "xhigh", deps.now?.() ?? Date.now(), deps.idFactory);
    run.selection = resolveClaudeApiSelection(claudeApiModelOf(snapshot.model)!);
    run.resumedFrom = runId;
    run.ownerSessionId = CLAUDE_API_CLI_OWNER;
    run.tasks.forEach((task, index) => {
      const prior = unfinished[index];
      task.claudeSessionId = prior.claudeSessionId;
      task.changedPaths = prior.changedPaths;
      task.lastStep = prior.lastStep;
      task.resumedFrom = prior.id;
      if (prior.apiLeafCapUsd !== undefined) task.apiLeafCapUsd = prior.apiLeafCapUsd;
      task.priorSpendUsd = prior.usage.cost.total + (prior.priorSpendUsd ?? 0);
    });
    if (admission) stampClaudeApiRun({ tasks: run.tasks.filter((task) => task.apiLeafCapUsd === undefined) }, admission);
    store.prepareResume(runId, run);
    coordinator = coordinatorFor(deps, store);
    const started = coordinator.start(run);
    deps.onStart?.(started);
    return await settle(coordinator, store, started, deps);
  } catch (error) {
    await coordinator?.shutdown().catch(() => undefined);
    store.close();
    throw error;
  }
}

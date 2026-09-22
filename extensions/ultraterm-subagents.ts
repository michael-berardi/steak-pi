import { statSync } from "node:fs";
import { setPinnedPanel } from "../src/tui/pinned-panels.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { SubagentCoordinator, CoordinatorWaitTimeoutError } from "../src/subagents/coordinator.ts";
import { normalizeDispatch, SubagentPolicyError } from "../src/subagents/policy.ts";
import { resolveWorkerSelection, type WorkerProfile } from "../src/subagents/model-selection.ts";
import { AUTOMATIC_CHAIN_APPROVAL, type ChainOptions } from "../src/model-route-policy.ts";
import {
  RelayBroker,
  RUN_BROADCAST_TARGET,
  type RelayPeer,
} from "../src/subagents/relay.ts";
import { SessionScheduler } from "../src/subagents/scheduler.ts";
import { canonicalSessionFile, CheckpointStore, diagnoseRun, isInProcessCheckpointCollision, recoveredRun, type Checkpoint } from "../src/subagents/checkpoints.ts";
import { renderSubagentCall, renderSubagentResult, renderSubagentLive } from "../src/subagents/render.ts";
import type { PiWorkerRuntime, PiWorkerRunnerOptions } from "../src/subagents/pi-worker.ts";
import {
  USAP_VERSION,
  MAX_CONCURRENCY,
  MAX_TASKS,
  MAX_TIMEOUT_MS,
  MAX_WORKER_TURNS,
  RELAY_MAILBOX_LIMIT,
  type DispatchInput,
  type RunRecord,
  type TaskRecord,
  type UsageTotals,
  type WorkerRunner,
} from "../src/subagents/types.ts";

export const PARENT_RELAY_ID = "parent" as const;
export const MAX_HUB_WAIT_MS = 30_000;
export const MAX_TOOL_CONTENT = 48_000;
export const MAX_COMPLETION_MESSAGE = 4_000;
export const USAP_TELEMETRY_CUSTOM_TYPE = "ultraterm-usap-telemetry";
export const USAP_TELEMETRY_VERSION = 1; // Additive route metadata preserves existing readers.
/** Bounded teardown wait. The host UI is released after this deadline, but the
 * checkpoint lease and live state are retained until the real
 * `coordinator.shutdown()` promise settles: a worker that never settles must
 * never be able to write after its lease was released. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;

/** Operator-visible warning retained until a bounded teardown really settles. */
export const RETAINED_LEASE_WARNING = "USAP checkpoint lease retained until an unsettled worker exits; new dispatch and resume are refused";

/** A hostile or sloppy value must never silently degrade to a ~1ms grace that
 * releases the checkpoint lease before live workers can flush final state. */
function shutdownGraceMsOrThrow(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SHUTDOWN_GRACE_MS;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("shutdownGraceMs must be a non-negative safe integer");
  }
  return value;
}

// Equivalent JSON Schema shape to pi-ai's StringEnum, kept local so this
// extension does not add a direct runtime dependency solely for enum schemas.
function stringEnum<T extends readonly string[]>(values: T): TSchema {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
}

const RoleSchema = stringEnum(["scout", "worker", "reviewer"] as const);
const RelayKindSchema = stringEnum(["message", "request", "reply", "status"] as const);
const HubActionSchema = stringEnum(["list", "status", "wait", "cancel", "send", "inbox", "resume", "diagnose"] as const);
const WaitModeSchema = stringEnum(["next", "all"] as const);

const TaskSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  task: Type.String({ minLength: 1, maxLength: 8_000 }),
  role: Type.Optional(RoleSchema),
  mayEdit: Type.Optional(Type.Boolean({ description: "Enable guarded edit/write tools; defaults to false" })),
  ownedPaths: Type.Optional(Type.Array(
    Type.String({ minLength: 1, maxLength: 2_000 }),
    { maxItems: 64, description: "Exclusive writable paths. Required when mayEdit=true; omit for read-only tasks and put read scope in task text." },
  )),
  allowBash: Type.Optional(Type.Boolean({ description: "Enable unsandboxed shell access in the operator trust domain; defaults to false" })),
}, { additionalProperties: false });

/** Public dispatcher schema, exported so contract tests do not have to load Pi. */
export const ultratermSubagentsSchema = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 8_000 }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Exact authenticated provider/model for all tasks; mutually exclusive with profile." })),
  profile: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Native harness/profile route (e.g. steak-pi/glm-5-3-flash); mutually exclusive with model." })),
  requireImages: Type.Optional(Type.Boolean({ description: "Require advertised image input; no silent fallback." })),
  constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 64 })),
  contract: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
  tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY, description: "Defaults to min(8, task count)." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS, description: "Absolute run budget including queue time; default 10 minutes, maximum 8 hours." })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKER_TURNS, description: "Per-worker request budget; default 64. Increase explicitly for long-horizon work." })),
  background: Type.Optional(Type.Boolean({ default: false })),
  thinking: Type.Optional(stringEnum(["medium", "high", "xhigh"] as const)),
  thinkingReason: Type.Optional(Type.String({ minLength: 16, maxLength: 2_000, description: "Why high/xhigh reasoning benefits this task." })),
}, { additionalProperties: false });

/** Public provider-compatible hub schema. Sender identity is absent and host-bound. */
export const ultratermHubSchema = Type.Object({
  action: HubActionSchema,
  runId: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 128,
    description: "Required for every action except list. Resume explicitly continues only unfinished checkpointed tasks.",
  })),
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Optional task target for cancel" })),
  mode: Type.Optional(WaitModeSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_HUB_WAIT_MS })),
  to: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Required peer task ID or #run for send" })),
  body: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000, description: "Required concise body for send" })),
  kind: Type.Optional(RelayKindSchema),
  replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Required request envelope ID when kind is reply" })),
  afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 0, maximum: RELAY_MAILBOX_LIMIT })),
}, { additionalProperties: false });

export const dispatchSchema = ultratermSubagentsSchema;
export const hubSchema = ultratermHubSchema;

export type UltratermSubagentsParams = DispatchInput;
export interface UltratermHubParams {
  action: "list" | "status" | "wait" | "cancel" | "send" | "inbox" | "resume" | "diagnose";
  runId?: string;
  taskId?: string;
  mode?: "next" | "all";
  timeoutMs?: number;
  to?: string;
  body?: string;
  kind?: "message" | "request" | "reply" | "status";
  replyTo?: string;
  afterSeq?: number;
  limit?: number;
}

export interface SettledTaskView {
  taskId: string;
  label: string;
  state: TaskRecord["state"];
  output: string;
  error?: string;
  currentTool?: string;
  turns: number;
  toolErrors: number;
  toolSuccesses: number;
  truncated: boolean;
  startedAt?: number;
  endedAt?: number;
  lastProgressAt?: number;
  detail?: string;
}

export interface RunView {
  observedAt: number;
  runId: string;
  ownerSessionId?: string;
  ownerSessionFile?: string;
  goal: string;
  state: RunRecord["state"];
  model: string;
  selection?: RunRecord["selection"];
  thinkingLevel: string;
  background: boolean;
  createdAt: number;
  endedAt?: number;
  totalTokens: number;
  totalCost: number;
  tasks: SettledTaskView[];
}

/** Durable recovery capability of the runtime that produced a view. */
export type Persistence = "checkpointed" | "memory-only";

export interface DispatchDetails {
  mode: "foreground" | "background";
  run: RunView;
  /** Never infer durability: a memory-only launch cannot be resumed. */
  persistence: Persistence;
  summary: {
    model: string;
    profile: string | null;
    thinking: string;
    background: boolean;
    tasks: Array<{
      label: string;
      role: TaskRecord["role"];
      mayEdit: boolean;
      allowBash: boolean;
      ownedPaths: number;
      modelRoute: string;
      selectionSource: string;
    }>;
  };
}

export interface HubDetails {
  action: UltratermHubParams["action"];
  run?: RunView;
  runs?: RunView[];
  changed?: boolean;
  timedOut?: boolean;
  relay?: unknown;
  persistence?: Persistence;
  /** True when the run data came from a lease this session may not write. */
  readOnly?: boolean;
  checkpointError?: string | null;
  shutdownWarning?: string | null;
}

export interface UltratermSubagentsDependencies {
  createRunner?: (pi: ExtensionAPI, relay: RelayBroker) => WorkerRunner;
  createScheduler?: () => SessionScheduler;
  profiles?: readonly WorkerProfile[];
  /**
   * Operator grant decision for a reviewed paid/Token Plan route inside an automatic
   * chain. Defaults to the on-disk allowlist, re-read per selection, so the real
   * dispatch boundary consumes the same approval the paid-route flag governs instead
   * of relying on unit-test-only wiring.
   */
  approvePaidRoute?: ChainOptions["approvePaidRoute"];
  createRelay?: () => RelayBroker;
  now?: () => number;
  idFactory?: () => string;
  checkpointRoot?: string;
  shutdownGraceMs?: number;
}

/** Automatic chains may spend only through the operator's exact allowlist grant, so
 * a dispatched run resolves the same approval the paid-route flag governs. The seam
 * lets a caller pin the decision instead of reading paid-routes.json. */
function automaticChainOptions(dependencies: UltratermSubagentsDependencies): ChainOptions {
  return { approvePaidRoute: dependencies.approvePaidRoute ?? AUTOMATIC_CHAIN_APPROVAL };
}

interface RunBinding {
  parent: RelayPeer;
  background: boolean;
  completion: Promise<RunRecord>;
  usageClaimed: boolean;
  onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: DispatchDetails }) => void;
}

interface RetainedTeardown {
  owner: string;
  runtime: SessionRuntime;
  warning: string;
}

interface SessionRuntime {
  /** Captured identity, never a mutable session-manager reference. */
  owner: string;
  ownerSessionId: string;
  ownerSessionFile?: string;
  relay: RelayBroker;
  coordinator: SubagentCoordinator;
  bindings: Map<string, RunBinding>;
  workerRuntimes: Map<string, PiWorkerRuntime>;
  telemetrySignatures: Map<string, string>;
  telemetryWritable: boolean;
  statusContext?: ExtensionContext;
  closed: boolean;
  /** Background completions awaiting one coalesced delivery. */
  completionBuffer: Array<{ runId: string; text: string }>;
  awaitingReceipt: Set<string>;
  deliveryRetry?: ReturnType<typeof setTimeout>;
  deliveryRetries: number;
  store?: CheckpointStore;
  checkpointError?: string;
  /** Set when a duplicate owner in this process holds the namespace. */
  checkpointCollision?: string;
  /** A durable namespace exists but this runtime cannot claim it: never launch
   * memory-only work from here, and never silently pretend it is durable. */
  checkpointDegraded: boolean;
  /** Read-only checkpoints from a lease this process retains until settlement. */
  readOnlyCheckpoints?: () => Checkpoint[] | undefined;
  /** Operator-visible teardown warning surfaced by status and diagnose. */
  shutdownWarning?: string;
  /** Adopt a store claimed after a previous in-process collision cleared. */
  attachStore?: (store: CheckpointStore, ctx?: ExtensionContext) => void;
  /** True until an agent run starts; cleared/refreshed by agent lifecycle events. */
  agentIdle: boolean;
}

function sessionOwner(ctx?: ExtensionContext): string | undefined {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    const file = ctx?.sessionManager?.getSessionFile?.();
    let canonical: string | undefined;
    if (typeof file === "string" && file.trim()) {
      canonical = canonicalSessionFile(file);
    }
    const sessionId = typeof id === "string" && id.trim() ? id : undefined;
    return sessionId ? JSON.stringify([sessionId, canonical ?? null]) : undefined;
  } catch { return undefined; }
}
function ownsContext(current: SessionRuntime, ctx?: ExtensionContext): boolean {
  return current.owner === sessionOwner(ctx);
}

function assertOwner(current: SessionRuntime, ctx?: ExtensionContext): void {
  if (!ownsContext(current, ctx)) throw new Error("USAP session ownership mismatch; result access refused.");
}

function observedCompletionIds(ctx?: ExtensionContext): Set<string> | undefined {
  const entries = ctx?.sessionManager?.getEntries?.();
  if (!entries) return undefined;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom_message" || entry.customType !== "ultraterm-subagents-complete") continue;
    const details = entry.details as { runIds?: unknown; ownerSessionId?: string; ownerSessionFile?: string } | undefined;
    if (!details?.ownerSessionId || details.ownerSessionId !== ctx?.sessionManager?.getSessionId?.()) continue;
    const currentFile = ctx?.sessionManager?.getSessionFile?.();
    if (details.ownerSessionFile && (!currentFile || canonicalSessionFile(details.ownerSessionFile) !== canonicalSessionFile(currentFile))) continue;
    if (Array.isArray(details.runIds)) for (const id of details.runIds) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

function taskDetail(task: TaskRecord): string | undefined {
  if (/Host interrupted|Coordinator shut down/i.test(task.error ?? "")) return task.sessionFile ? "Interrupted — inspect the checkpoint" : "Interrupted — inspect diagnostics";
  if (/turn.limit|turn budget/i.test(task.error ?? "")) return "Turn budget reached — partial work retained";
  if (task.state === "timed_out") return "Time budget reached — partial work retained";
  if (task.state === "aborted") return "Cancelled";
  if (task.state === "failed") return "Needs attention — inspect diagnostics";
  if (task.state === "done") return "Finished — ready for parent verification";
  const steps: Record<string, string> = { read: "Reading assigned files", grep: "Searching source", find: "Finding source files", ls: "Inspecting files", edit: "Editing assigned files", write: "Writing assigned files", bash: "Running a command", compaction: "Managing context", retry: "Retrying the connection" };
  return task.currentTool ? steps[task.currentTool] : undefined;
}

/** Bounded UI labels/lifecycle only: never include goals, task prompts, output, or usage. */
export function usapTelemetrySnapshot(run: RunRecord) {
  return {
    version: USAP_TELEMETRY_VERSION,
    runId: run.id,
    ...(run.ownerSessionId ? { ownerSessionId: run.ownerSessionId } : {}),
    ...(run.ownerSessionFile ? { ownerSessionFile: run.ownerSessionFile } : {}),
    runState: run.state,
    ...(run.selection ? { selection: { ...run.selection }, model: run.model, thinkingLevel: run.thinkingLevel } : {}),
    tasks: run.tasks.map((task) => ({
      taskId: task.id,
      label: task.label.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80),
      state: task.state,
      ...(taskDetail(task) ? { detail: taskDetail(task) } : {}),
      ...(Number.isFinite(task.startedAt) && task.startedAt! >= 0 ? { startedAt: task.startedAt } : {}),
      ...(Number.isFinite(task.endedAt) && task.endedAt! >= 0 ? { endedAt: task.endedAt } : {}),
      ...(task.currentTool ? { currentTool: task.currentTool.slice(0, 80) } : {}),
      // Real per-request provenance: each pre-output hop names both routes.
      ...(task.routeFallbacks?.length
        ? { routeFallbacks: task.routeFallbacks.slice(-8).map((hop) => hop.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 96)) }
        : {}),
      toolErrors: task.toolErrors ?? 0,
      toolSuccesses: task.toolSuccesses ?? 0,
    })),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function requireRunId(params: UltratermHubParams): string {
  return requireString(params.runId, "runId").trim();
}

function boundedHubWait(value: number | undefined): number {
  const timeoutMs = value ?? MAX_HUB_WAIT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_HUB_WAIT_MS) {
    throw new RangeError(`hub timeoutMs must be an integer from 0 to ${MAX_HUB_WAIT_MS}`);
  }
  return timeoutMs;
}

function taskView(task: TaskRecord): SettledTaskView {
  return {
    taskId: task.id,
    label: task.label,
    state: task.state,
    output: task.output,
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.currentTool ? { currentTool: task.currentTool.slice(0, 80) } : {}),
    turns: task.turns,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    lastProgressAt: task.lastProgressAt,
    ...(taskDetail(task) ? { detail: taskDetail(task) } : {}),
    toolErrors: task.toolErrors ?? 0,
    toolSuccesses: task.toolSuccesses ?? 0,
    truncated: task.truncated,
  };
}

/** Create a stable, JSON-safe view without duplicating nested model usage. */
export function toRunView(run: RunRecord): RunView {
  return {
    observedAt: Date.now(),
    runId: run.id,
    ...(run.ownerSessionId ? { ownerSessionId: run.ownerSessionId } : {}),
    ...(run.ownerSessionFile ? { ownerSessionFile: run.ownerSessionFile } : {}),
    goal: run.goal,
    state: run.state,
    model: run.model,
    ...(run.selection ? { selection: { ...run.selection } } : {}),
    thinkingLevel: run.thinkingLevel,
    background: run.background,
    createdAt: run.createdAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    totalTokens: run.usage.totalTokens,
    totalCost: run.usage.cost.total,
    tasks: run.tasks.map(taskView),
  };
}

function terminalCount(run: RunRecord): number {
  return run.tasks.filter((task) =>
    task.state === "done"
    || task.state === "failed"
    || task.state === "aborted"
    || task.state === "timed_out"
  ).length;
}

/** Pure compact renderer used by progress updates and status tests. */
export function renderRunProgress(run: RunRecord): string {
  const done = terminalCount(run);
  return `USAP ${run.id}: ${done}/${run.tasks.length} settled · ${run.state}`;
}

function appendBounded(target: string, addition: string, limit: number): { text: string; truncated: boolean } {
  if (target.length + addition.length <= limit) return { text: target + addition, truncated: false };
  const remaining = Math.max(0, limit - target.length);
  return {
    text: target + addition.slice(0, remaining),
    truncated: true,
  };
}

/** Pure ordered all-settled renderer with a hard context bound. */
export function renderRunResult(run: RunRecord, limit = MAX_TOOL_CONTENT): string {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("render limit must be a non-negative integer");
  let text = `${renderRunProgress(run)}\nmodel ${run.model} · thinking ${run.thinkingLevel}${run.selection ? ` · ${run.selection.source}${run.selection.profile ? ` · ${run.selection.profile}` : ""}` : ""}`.slice(0, limit);
  let wasTruncated = false;
  for (const task of run.tasks) {
    const suffix = `${task.toolErrors ? ` · ${task.toolErrors} tool errors` : ""}${task.truncated ? " · worker output truncated" : ""}`;
    const error = task.error ? `\nerror: ${task.error}` : "";
    const block = `\n\n[${task.label}] ${task.state}${suffix}${error}\n${task.output || "(no output)"}`;
    const next = appendBounded(text, block, limit);
    text = next.text;
    if (next.truncated) {
      wasTruncated = true;
      break;
    }
  }
  if (wasTruncated) {
    const marker = "\n\n[Aggregate content truncated; complete bounded task outputs remain in details.]";
    text = (text.slice(0, Math.max(0, limit - marker.length)) + marker).slice(0, limit);
  }
  return text;
}

/** Pure bounded background completion renderer; it never includes child output. */
export function renderCompletionMessage(run: RunRecord, limit = MAX_COMPLETION_MESSAGE): string {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("render limit must be a non-negative integer");
  const tasks = run.tasks.map((task) => `${task.id}=${task.state}`).join(", ");
  return `${renderRunProgress(run)}\n${tasks}`.slice(0, limit);
}

/** Pure status text for the extension-owned `usap` footer slot. */
export function renderSessionStatus(runs: readonly RunRecord[]): string | undefined {
  const live = runs.filter((run) => run.state === "running");
  if (live.length === 0) return undefined;
  const settled = live.reduce((count, run) => count + terminalCount(run), 0);
  const total = live.reduce((count, run) => count + run.tasks.length, 0);
  return `USAP ${live.length} run${live.length === 1 ? "" : "s"} · ${settled}/${total} settled`;
}

function dispatchDetails(run: RunRecord, persistence: Persistence): DispatchDetails {
  return {
    mode: run.background ? "background" : "foreground",
    run: toRunView(run),
    persistence,
    summary: {
      model: run.model,
      profile: run.selection?.profile ?? null,
      thinking: run.thinkingLevel,
      background: run.background,
      tasks: run.tasks.map((task) => ({
        label: task.label,
        role: task.role,
        mayEdit: task.mayEdit,
        allowBash: task.allowBash,
        ownedPaths: task.ownedPaths.length,
        modelRoute: run.model,
        selectionSource: run.selection?.source ?? "unknown",
      })),
    },
  };
}

function usageCopy(usage: UsageTotals): UsageTotals {
  return { ...usage, cost: { ...usage.cost } };
}

interface PiWorkerModule {
  createPiWorkerRunner: (options: PiWorkerRunnerOptions) => WorkerRunner;
}

/** Lazy so fake-runner registration and tests never initialize child resources. */
function defaultWorkerRunner(
  relay: RelayBroker,
  workerRuntimes: Map<string, PiWorkerRuntime>,
): WorkerRunner {
  let runner: Promise<WorkerRunner> | undefined;
  return async (context) => {
    runner ??= import(new URL("../src/subagents/pi-worker.ts", import.meta.url).href)
      .then((module) => {
        const factory = (module as unknown as Partial<PiWorkerModule>).createPiWorkerRunner;
        if (typeof factory !== "function") {
          throw new Error("pi-worker module does not export createPiWorkerRunner");
        }
        return factory({
          relay,
          resolveRuntime: (runId) => {
            const resolved = workerRuntimes.get(runId);
            if (!resolved) throw new Error(`No frozen Pi worker runtime for ${runId}`);
            return resolved;
          },
        });
      });
    return (await runner)(context);
  };
}

export function createUltratermSubagentsExtension(
  dependencies: UltratermSubagentsDependencies = {},
): (pi: ExtensionAPI) => void {
  // Validated once at construction: a bad value must never reach a live teardown.
  const shutdownGraceMs = shutdownGraceMsOrThrow(dependencies.shutdownGraceMs);
  return function ultratermSubagentsExtension(pi: ExtensionAPI): void {
    let runtime: SessionRuntime | undefined;
    let clearedStatusUi: ExtensionContext["ui"] | undefined;
    // Replacements share leases with any late-disposing prior initialization.
    const scheduler = dependencies.createScheduler?.() ?? new SessionScheduler(MAX_CONCURRENCY);
    /** Teardowns whose workers had not settled at the bounded deadline. Their
     * checkpoint lease and live state stay retained (never force-released, never
     * stolen) until the real `coordinator.shutdown()` promise settles. */
    const retainedTeardowns: RetainedTeardown[] = [];
    /** Survives the runtime it described so a successor session can report it. */
    let lastShutdownWarning: { at: number; owner: string; message: string } | undefined;

    const persistenceOf = (current: SessionRuntime): Persistence => current.store ? "checkpointed" : "memory-only";
    const sessionWarning = (current: SessionRuntime): string | undefined =>
      current.shutdownWarning ?? (lastShutdownWarning?.owner === current.owner ? lastShutdownWarning.message : undefined);

    const setStatus = (current: SessionRuntime, ctx?: ExtensionContext): void => {
      const target = ctx ?? current.statusContext;
      if (!target || current.closed || !ownsContext(current, target)) return;
      current.statusContext = target;
      try {
        const active = current.coordinator.activeRuns().filter(run => run.tasks.some(task => task.state === "running" || task.state === "queued"));
        // The live Subagents panel owns progress; do not duplicate it below the composer.
        if (clearedStatusUi !== target.ui) {
          target.ui.setStatus("usap", undefined);
          clearedStatusUi = target.ui;
        }
        const visibleSignature = JSON.stringify(active.map(run => run.tasks.map(task => [task.id, task.label, task.state, task.currentTool, task.startedAt])));
        setPinnedPanel(target, "subagents", active.length ? (tui, theme) => renderSubagentLive(active, theme, () => tui.requestRender()) : undefined, visibleSignature);
      } catch {
        // UI observation must not affect child execution.
      }
    };

    const persistTelemetry = (current: SessionRuntime, run: RunRecord): void => {
      if (runtime !== current || !current.telemetryWritable || !ownsContext(current, current.statusContext)) return;
      const snapshot = usapTelemetrySnapshot(run);
      const signature = JSON.stringify(snapshot);
      if (current.telemetrySignatures.get(run.id) === signature) return;
      try {
        // Pi's public action delegates to SessionManager.appendCustomEntry.
        pi.appendEntry(USAP_TELEMETRY_CUSTOM_TYPE, snapshot);
        current.telemetrySignatures.set(run.id, signature);
      } catch {
        // Telemetry observation must never affect child execution.
      }
    };

    const reconcileRetainedBindings = (current: SessionRuntime): void => {
      for (const [runId, binding] of current.bindings) {
        if (current.coordinator.has(runId)) continue;
        binding.parent.close();
        current.relay.cleanupRun(runId);
        current.bindings.delete(runId);
        current.workerRuntimes.delete(runId);
        current.telemetrySignatures.delete(runId);
      }
    };

    /** Bounded so the host UI is never blocked by a worker that cannot settle.
     * Settlement is a real proof: the coordinator only completes a dispatched
     * task after its worker returned, so a settled shutdown means no worker can
     * write again. The checkpoint lease is therefore a separate decision. */
    const boundedShutdown = async (shutdown: Promise<void>): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<"grace">((resolve) => {
        timer = setTimeout(() => resolve("grace"), shutdownGraceMs);
        timer.unref?.();
      });
      try {
        const settled = await Promise.race([
          shutdown.then(() => "settled" as const),
          grace,
        ]);
        return settled === "settled";
      } finally {
        clearTimeout(timer);
      }
    };

    /** Keep disposal-time final reports and changed paths. Shutdown interruption
     * is distinct from an explicit operator cancellation and stays resumable. */
    const finalShutdownSave = (current: SessionRuntime): void => {
      for (const run of current.coordinator.list()) {
        for (const task of run.tasks) {
          if (task.state === "aborted" && /Coordinator shut down/.test(task.error ?? "")) task.error = "Host interrupted; inspect checkpoint and explicitly resume unfinished work";
        }
        try { current.store?.save(run, true); } catch { current.checkpointError = "Final shutdown checkpoint failed"; }
      }
    };

    /** Release a retained lease only after the real shutdown settles. The captured
     * store is closed against the captured runtime: no successor runtime, status
     * or telemetry callback is ever touched from here. */
    const settleRetainedTeardown = (entry: RetainedTeardown): void => {
      try { finalShutdownSave(entry.runtime); } catch { /* A failed final save never blocks the release decision. */ }
      try { entry.runtime.store?.close(); } catch { /* Never remove another host's lock. */ }
      entry.runtime.workerRuntimes.clear();
      const index = retainedTeardowns.indexOf(entry);
      if (index >= 0) retainedTeardowns.splice(index, 1);
      // The warning only described the retained lease; drop it once every lease
      // for that session has actually settled.
      if (lastShutdownWarning?.owner === entry.owner && !retainedTeardowns.some((other) => other.owner === entry.owner)) {
        lastShutdownWarning = undefined;
      }
    };

    const releaseRuntimeUi = (current: SessionRuntime, ctx: ExtensionContext | undefined, warning?: string): void => {
      if (runtime !== current) return;
      runtime = undefined;
      const target = ctx ?? current.statusContext;
      if (!ownsContext(current, target)) return;
      try {
        target?.ui.setStatus("usap", undefined);
        target?.ui.setStatus("usap-delivery", undefined);
        target?.ui.setStatus("usap-checkpoint", warning);
        if (target) setPinnedPanel(target, "subagents", undefined);
      } catch {
        // The session UI may already be tearing down.
      }
    };

    const closeBindings = (current: SessionRuntime): void => {
      for (const [runId, binding] of current.bindings) {
        binding.parent.close();
        current.relay.cleanupRun(runId);
      }
      current.bindings.clear();
      current.telemetrySignatures.clear();
    };

    const destroyRuntime = async (ctx?: ExtensionContext, persist = true): Promise<void> => {
      const current = runtime;
      if (!current) {
        ctx?.ui.setStatus("usap", undefined);
        return;
      }
      current.closed = true;
      clearTimeout(current.deliveryRetry);
      // Snapshot before shutdown changes active tasks into ordinary cancellations.
      for (const run of current.coordinator.list()) {
        try { current.store?.save(run, true); } catch { current.checkpointError = "Checkpoint write failed during host shutdown"; }
      }
      // Keep one authoritative shutdown promise. Calling shutdown again could
      // observe a different task set and is not evidence that the first settled.
      const shutdown = Promise.resolve().then(() => current.coordinator.shutdown());
      let disposed = true;
      try { disposed = await boundedShutdown(shutdown); } catch { disposed = false; }
      if (disposed) {
        try { finalShutdownSave(current); } finally {
          // Settled: every dispatched worker returned, so nothing can write after
          // this release and no successor may collide with a dead lease.
          try { current.store?.close(); } catch { /* Never remove another host's lock. */ }
        }
        // appendEntry targets the current host session, never a stale replacement.
        if (persist && runtime === current) {
          for (const run of current.coordinator.list()) persistTelemetry(current, run);
        }
        closeBindings(current);
        current.workerRuntimes.clear();
        releaseRuntimeUi(current, ctx);
        return;
      }
      // The bounded deadline may return the UI to the host, but the checkpoint
      // lease and live state are RETAINED: an unsettled worker can still run tool
      // calls and append to its native session file, so its lease is never
      // released and never stolen. The lease closes on real settlement only.
      const entry: RetainedTeardown = { owner: current.owner, runtime: current, warning: RETAINED_LEASE_WARNING };
      retainedTeardowns.push(entry);
      lastShutdownWarning = { at: Date.now(), owner: current.owner, message: RETAINED_LEASE_WARNING };
      current.shutdownWarning = RETAINED_LEASE_WARNING;
      current.checkpointError = RETAINED_LEASE_WARNING;
      // Frozen worker runtimes stay resolvable: a live worker still needs its route.
      closeBindings(current);
      void shutdown.then(
        () => settleRetainedTeardown(entry),
        () => {
          // Rejection is not proof that every worker stopped. Keep the lease;
          // recovery must fail closed rather than race an unknown live writer.
          const message = "Worker shutdown failed; checkpoint lease retained because worker termination is unconfirmed";
          current.checkpointError = message;
          current.shutdownWarning = message;
          lastShutdownWarning = { at: Date.now(), owner: current.owner, message };
        },
      );
      releaseRuntimeUi(current, ctx, RETAINED_LEASE_WARNING);
    };

    /** Durable checkpoints need the lock; a duplicate in-process owner must not
     * brick the session. Cross-host live owners still fail closed. */
    const claimStore = (ctx: ExtensionContext, sessionFile: string | undefined, ownerSessionId: string): { store?: CheckpointStore; degraded: boolean; collision?: string; error?: string } => {
      if (!sessionFile) return { degraded: false };
      try {
        return { store: new CheckpointStore(sessionFile, dependencies.checkpointRoot, ownerSessionId), degraded: false };
      } catch (error) {
        if (!isInProcessCheckpointCollision(error)) throw error;
        const cause = error instanceof Error ? error.message : String(error);
        // Our own unsettled worker still holds the lease: the collision is real but
        // it is this session's retained lease, not a foreign duplicate instance.
        const retained = retainedTeardowns.some((entry) => entry.owner === sessionOwner(ctx));
        if (retained) {
          try { ctx.ui.setStatus("usap-checkpoint", `USAP checkpoints unavailable: ${RETAINED_LEASE_WARNING}`); } catch { /* UI may not be attached yet. */ }
          return { degraded: true, collision: RETAINED_LEASE_WARNING, error: `Checkpoint store unavailable: ${RETAINED_LEASE_WARNING}` };
        }
        try { ctx.ui.setStatus("usap-checkpoint", `USAP checkpoints memory-only: ${cause}`); } catch { /* UI may not be attached yet. */ }
        return {
          degraded: true,
          collision: "Another live store in this process owns this session's checkpoints; this session stays read-only until that owner releases them",
          error: `Checkpoint store unavailable: duplicate extension resources own this session's checkpoints (${cause})`,
        };
      }
    };

    /** Read-only evidence for a namespace this runtime may not write. */
    const readOnlyCheckpointsFor = (owner: string): Checkpoint[] | undefined =>
      retainedTeardowns.find((entry) => entry.owner === owner)?.runtime.store?.list();

    /** A degraded runtime must never launch work that only exists in memory: the
     * operator would have no durable recovery path. Chat, list and diagnose stay
     * available read-only until the live owner releases the lease. */
    const assertDurableForNewWork = (current: SessionRuntime, action = "New dispatch"): void => {
      if (current.store || !current.checkpointDegraded) return;
      throw new Error(`${action} is refused: ${current.checkpointError ?? "this session cannot own its durable checkpoint store"}. A run started now could not be resumed; hub list and hub diagnose stay read-only.`);
    };

    const ensureRuntime = (ctx: ExtensionContext): SessionRuntime => {
      const owner = sessionOwner(ctx);
      if (!owner) throw new Error("USAP requires a native session identity; access refused.");
      const [ownerSessionId, ownerSessionFile] = JSON.parse(owner) as [string, string | null];
      if (runtime && !runtime.closed) {
        if (runtime.owner !== owner) throw new Error("USAP session ownership mismatch; access refused until the session lifecycle is initialized.");
        runtime.statusContext = ctx;
        // A duplicate in-process owner, or a retained teardown whose workers have
        // now settled, may have released this session's lock since startup.
        if (!runtime.store && runtime.checkpointDegraded) {
          try {
            const reclaimed = claimStore(ctx, ctx.sessionManager?.getSessionFile?.(), ownerSessionId);
            if (reclaimed.store) {
              // Same adoption path as initial creation: reconcile recovery and
              // never emit a second completion for already-observed runs.
              runtime.attachStore?.(reclaimed.store, ctx);
              // Durability is restored, so the retained-lease warning is stale.
              runtime.shutdownWarning = undefined;
              ctx.ui.setStatus("usap-checkpoint", undefined);
            }
          } catch { /* Stay read-only; never remove another owner's lock. */ }
        }
        return runtime;
      }

      const sessionFile = ctx.sessionManager?.getSessionFile?.();
      const claim = claimStore(ctx, sessionFile, ownerSessionId);
      let store = claim.store;
      const relay = dependencies.createRelay?.() ?? new RelayBroker();
      const workerRuntimes = new Map<string, PiWorkerRuntime>();
      let created!: SessionRuntime;
      const runner = dependencies.createRunner?.(pi, relay)
        ?? defaultWorkerRunner(relay, workerRuntimes);
      const coordinator = new SubagentCoordinator(runner, {
        scheduler,
        now: dependencies.now,
        sessionDir: () => store?.sessionsDirectory,
        onChange: (run) => {
          if (!created || created.closed) return;
          try { store?.save(run, run.state !== "running"); } catch {
            created.checkpointError = "Checkpoint write failed; recovery is not guaranteed. Inspect disk space and private directory permissions.";
            try { if (ownsContext(created, created.statusContext)) created.statusContext?.ui.setStatus("usap-checkpoint", "USAP checkpoint error — hub diagnose"); } catch { /* Observation only. */ }
          }
          persistTelemetry(created, run);
          setStatus(created);
        },
        onProgress: (event) => {
          if (created.closed || !ownsContext(created, created.statusContext)) return;
          const binding = created.bindings.get(event.runId);
          if (!binding?.onUpdate) return;
          try {
            binding.onUpdate({
              content: [{ type: "text", text: renderRunProgress(event.run) }],
              details: dispatchDetails(event.run, persistenceOf(created)),
            });
          } catch {
            // Pi scopes onUpdate to a live tool call; observers never own execution.
          }
        },
      });
      /** Adopt a newly claimed store exactly like initial creation: reconcile
       * recovery, mark observed deliveries, and buffer unfinished background runs
       * without ever replaying a completion the session already observed. */
      const adoptStore = (candidate: CheckpointStore, adoptCtx?: ExtensionContext): void => {
        store = candidate;
        created.store = candidate;
        created.checkpointError = undefined;
        created.checkpointCollision = undefined;
        created.checkpointDegraded = false;
        const observed = observedCompletionIds(adoptCtx ?? ctx);
        for (const checkpoint of candidate.list()) {
          if (observed?.has(checkpoint.run.id)) candidate.markDelivered(checkpoint.run.id);
          const recovered = recoveredRun(checkpoint);
          if (checkpoint.run.state === "running") candidate.save(recovered, true);
          if (!checkpoint.delivered && !observed?.has(checkpoint.run.id) && recovered.background) {
            created.completionBuffer.push({ runId: recovered.id, text: renderCompletionMessage(recovered) });
          }
        }
      };
      created = {
        owner,
        ownerSessionId,
        ownerSessionFile: ownerSessionFile ?? undefined,
        relay,
        coordinator,
        bindings: new Map(),
        workerRuntimes,
        telemetrySignatures: new Map(),
        telemetryWritable: true,
        statusContext: ctx,
        closed: false,
        completionBuffer: [],
        awaitingReceipt: new Set(),
        deliveryRetries: 0,
        store,
        checkpointDegraded: claim.degraded,
        checkpointCollision: claim.collision,
        checkpointError: claim.error,
        readOnlyCheckpoints: () => readOnlyCheckpointsFor(owner),
        shutdownWarning: lastShutdownWarning?.owner === owner ? lastShutdownWarning.message : undefined,
        attachStore: (candidate: CheckpointStore, adoptCtx?: ExtensionContext) => adoptStore(candidate, adoptCtx),
        agentIdle: true,
      };
      runtime = created;
      if (store) adoptStore(store, ctx);
      // Surface a retained lease (and its refusal of new work) in live status.
      const warning = sessionWarning(created);
      if (warning && !created.store) {
        try { ctx.ui.setStatus("usap-checkpoint", warning); } catch { /* UI may not be attached yet. */ }
      }
      return created;
    };

    const attachCompletion = (current: SessionRuntime, runId: string): Promise<RunRecord> => {
      const completion = current.coordinator.wait(runId, "all");
      void completion.then((run) => {
        if (current.closed) return;
        const binding = current.bindings.get(runId);
        current.workerRuntimes.delete(runId);
        persistTelemetry(current, run);
        setStatus(current);
        reconcileRetainedBindings(current);
        if (!binding) return;
        try {
          if (ownsContext(current, current.statusContext)) binding.onUpdate?.({
            content: [{ type: "text", text: renderRunProgress(run) }],
            details: dispatchDetails(run, persistenceOf(current)),
          });
        } catch {
          // A settled tool call may no longer accept updates.
        }
        binding.onUpdate = undefined;
        if (binding.background) {
          current.completionBuffer.push({ runId: run.id, text: renderCompletionMessage(run) });
          flushCompletions(current);
        }
      }).catch((error: unknown) => {
        if (current.closed) return;
        current.workerRuntimes.delete(runId);
        setStatus(current);
        reconcileRetainedBindings(current);
        current.completionBuffer.push({ runId, text:
          `USAP ${runId} infrastructure failure: ${error instanceof Error ? error.message : String(error)}`
            .slice(0, MAX_COMPLETION_MESSAGE),
        });
        flushCompletions(current);
      });
      return completion;
    };

    // Short, bounded retries bridge SDK idle/append transitions without polling
    // throughout a long task or starting another model turn.
    const retryDelivery = (current: SessionRuntime): void => {
      if (current.closed || !ownsContext(current, current.statusContext) || current.deliveryRetry) return;
      if (current.deliveryRetries >= 20) {
        try { current.statusContext?.ui.setStatus("usap-delivery", "USAP delivery unconfirmed — results remain in hub status"); } catch { /* Observation only. */ }
        return;
      }
      current.deliveryRetries += 1;
      current.deliveryRetry = setTimeout(() => {
        current.deliveryRetry = undefined;
        flushCompletions(current);
      }, 100);
      current.deliveryRetry.unref?.();
    };

    /** Passive delivery adds no model call. Never resend an unconfirmed SDK
     * submission: it may already be queued. Native receipts acknowledge it. */
    const flushCompletions = (current: SessionRuntime): void => {
      if (runtime !== current || current.closed || !ownsContext(current, current.statusContext) || !current.agentIdle) return;
      if (current.statusContext?.isIdle && !current.statusContext.isIdle()) {
        retryDelivery(current);
        return;
      }
      const acknowledge = (ids: Set<string>): void => {
        current.completionBuffer = current.completionBuffer.filter((item) => {
          if (!ids.has(item.runId)) return true;
          current.awaitingReceipt.delete(item.runId);
          try { current.store?.markDelivered(item.runId); } catch { current.checkpointError = "Completion receipt checkpoint failed"; }
          return false;
        });
      };
      acknowledge(observedCompletionIds(current.statusContext) ?? new Set());
      while (current.completionBuffer.some((item) => !current.awaitingReceipt.has(item.runId))) {
        const batch: typeof current.completionBuffer = [];
        let used = 0;
        for (const item of current.completionBuffer) {
          if (current.awaitingReceipt.has(item.runId)) continue;
          if (used + item.text.length + 2 > MAX_COMPLETION_MESSAGE && batch.length > 0) break;
          batch.push(item);
          used += item.text.length + 2;
        }
        try {
          pi.sendMessage({
            customType: "ultraterm-subagents-complete",
            content: batch.map((item) => item.text).join("\n\n").slice(0, MAX_COMPLETION_MESSAGE),
            display: true,
            details: { ownerSessionId: current.ownerSessionId, ownerSessionFile: current.ownerSessionFile, coalesced: batch.length, omitted: 0, runIds: batch.map((item) => item.runId),
              runs: batch.flatMap((item) => {
                const saved = current.store?.get(item.runId);
                const run = current.coordinator.snapshot(item.runId) ?? (saved ? recoveredRun(saved) : undefined);
                return run ? [{ ...toRunView(run), goal: "", tasks: run.tasks.map((task) => ({ ...taskView(task), output: "", ...(task.error ? { error: taskDetail(task) } : {}) })) }] : [];
              }),
            },
          }, { deliverAs: "steer", triggerTurn: false });
        } catch { retryDelivery(current); return; }
        for (const item of batch) current.awaitingReceipt.add(item.runId);
        // Real Pi appends passive idle messages synchronously. Preserve pending
        // evidence if a host queues them instead; do not manufacture a receipt.
        const observed = observedCompletionIds(current.statusContext);
        acknowledge(observed ?? new Set());
      }
      if (current.completionBuffer.length) retryDelivery(current);
      else {
        clearTimeout(current.deliveryRetry);
        current.deliveryRetry = undefined;
        current.deliveryRetries = 0;
        try { current.statusContext?.ui.setStatus("usap-delivery", undefined); } catch { /* Observation only. */ }
      }
    };

    pi.registerMessageRenderer?.("ultraterm-subagents-complete", (message, options, theme) => {
      const details = message.details as { runs?: RunView[] } | undefined;
      const runs = details?.runs ?? [];
      return renderSubagentResult({ content: [{ type: "text", text: typeof message.content === "string" ? message.content : "Subagents settled" }], details: runs.length === 1 ? { run: runs[0] } : { runs } }, options, theme);
    });

    pi.on("session_start", async (_event, ctx) => {
      if (!sessionOwner(ctx)) throw new Error("USAP requires a native session identity; access refused.");
      if (runtime && !runtime.closed && ownsContext(runtime, ctx)) {
        runtime.statusContext = ctx;
        setStatus(runtime, ctx);
        flushCompletions(runtime);
        return;
      }
      // Clear the new session's inherited presentation before awaiting teardown.
      try {
        setPinnedPanel(ctx, "subagents", undefined);
        for (const key of ["usap", "usap-delivery", "usap-checkpoint"]) ctx.ui.setStatus(key, undefined);
      } catch { /* UI may not be attached yet. */ }
      // The host has already switched at session_start; never append old state.
      if (runtime) {
        runtime.telemetryWritable = false;
        await destroyRuntime(ctx, false);
      }
      const current = ensureRuntime(ctx);
      setStatus(current, ctx);
      flushCompletions(current);
    });

    pi.on("agent_start", async (_event, ctx) => {
      if (runtime && ownsContext(runtime, ctx)) { runtime.statusContext = ctx; runtime.agentIdle = false; }
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (!runtime || runtime.closed || !ownsContext(runtime, ctx)) return;
      runtime.statusContext = ctx;
      runtime.agentIdle = true;
      runtime.deliveryRetries = 0;
      flushCompletions(runtime);
    });

    const leaveSession = async (_event: unknown, ctx: ExtensionContext) => {
      if (runtime && !ownsContext(runtime, ctx)) return;
      await destroyRuntime(ctx);
    };
    // Before-switch/fork hooks are cancellable and precede SDK validation.
    // Shutdown is the committed boundary, while the outgoing context is still valid.
    pi.on("session_shutdown", leaveSession);

    pi.registerTool({
      name: "ultraterm_subagents",
      label: "UltraTerm Subagents",
      description: "Dispatch 1-8 bounded child tasks as one parallel wave. Foreground default. ownedPaths = writable ownership (omit for read-only tasks). allowBash = unsandboxed shell.",
      promptSnippet: "Dispatch bounded independent child tasks with explicit permissions and path ownership",
      promptGuidelines: [
        "Fan out by default: independent leaves (disjoint files, modules, screens, angles) dispatch in ONE parallel wave — width defaults to min(8, task count); automatic Go/GLM/MiMo chain lanes fill 8, explicit Luna lanes stay at 6 or fewer.",
        "Delegation must buy completion speed; modest token premiums for real throughput are correct. Trivial or tightly coupled edits and direct answers stay in the parent.",
        "Parent owns decomposition, integration, verification; workers own leaves end to end. With exact disjoint paths and acceptance contracts in hand, dispatch in the first tool turn without pre-reading child-owned files; do not duplicate child discovery in the parent.",
        "model or profile picks an explicit authenticated route (mutually exclusive, overrides roles). Every GPT choice requires paid openai-codex OAuth — never OpenRouter, API-key, or batch GPT. Astra workers default to medium reasoning; high/xhigh needs a concrete thinkingReason. requireImages=true for visual critics or render inspection.",
        "Background only when the parent can integrate while children run, then one bounded ultraterm_hub wait. Never start a background run merely to wait immediately.",
        "For read-only tasks omit ownedPaths and state the read scope in task text; mayEdit requires ownedPaths. allowBash bypasses ownedPaths — grant only when operator-level shell access is necessary.",
      ],
      parameters: ultratermSubagentsSchema as any,
      renderShell: "self",
      renderCall: renderSubagentCall,
      renderResult: renderSubagentResult,
      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        const params = rawParams as UltratermSubagentsParams;
        if (!ctx.model) throw new Error("ultraterm_subagents requires a resolved current model");
        const current = ensureRuntime(ctx);
        // Never launch a run this session could not recover from its durable store.
        assertDurableForNewWork(current);
        const persistence = persistenceOf(current);
        const persistenceNote = current.store
          ? ""
          : `USAP checkpoints are unavailable in this session (${current.checkpointError ?? "no native session file"}): this run is memory-only and cannot be resumed.\n`;
        const resolved = resolveWorkerSelection(ctx.model, ctx.thinkingLevel, params, ctx.modelRegistry, dependencies.profiles, undefined, automaticChainOptions(dependencies));
        const frozenWorkerRuntime: PiWorkerRuntime = Object.freeze({
          model: Object.freeze({ ...resolved.model }),
          thinkingLevel: resolved.thinkingLevel,
        });
        const model = `${frozenWorkerRuntime.model.provider}/${frozenWorkerRuntime.model.id}`;
        const thinking = String(frozenWorkerRuntime.thinkingLevel);
        const input: DispatchInput = {
          ...params,
          tasks: params.tasks,
          background: params.background ?? false,
        };
        let run: RunRecord;
        try {
          run = normalizeDispatch(
            input,
            ctx.cwd,
            model,
            thinking,
            dependencies.now?.() ?? Date.now(),
            dependencies.idFactory,
          );
        } catch (error) {
          if (!(error instanceof SubagentPolicyError)) throw error;
          // Never throw policy failures to a host formatter that may echo raw arguments.
          // Bound even labels and error messages: both can contain untrusted input.
          const reason = error.message.slice(0, 200);
          const field = /^(?:tasks\[\d+\](?:\.[A-Za-z]+(?:\[\d+\])?)?|[A-Za-z]+)/.exec(reason)?.[0] ?? "input";
          const labels = Array.isArray(params.tasks)
            ? params.tasks.slice(0, MAX_TASKS).map((task) =>
              typeof task?.label === "string" ? task.label.slice(0, 20) : "?")
            : [];
          const digest = JSON.stringify({ field, labels }).slice(0, 200);
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Dispatch validation failed: ${reason}\nInput: ${digest}` }],
            details: undefined,
          };
        }

        run.selection = { ...resolved.selection };
        run.ownerSessionId = current.ownerSessionId;
        run.ownerSessionFile = current.ownerSessionFile;
        // Never launch a supposedly durable run whose initial checkpoint failed.
        current.store?.save(run, true);
        current.workerRuntimes.set(run.id, frozenWorkerRuntime);
        current.relay.createRun(run.id, [PARENT_RELAY_ID, ...run.tasks.map((task) => task.id)]);
        const parent = current.relay.bindSender(run.id, PARENT_RELAY_ID);
        let started: RunRecord;
        try {
          started = current.coordinator.start(run);
        } catch (error) {
          parent.close();
          current.relay.cleanupRun(run.id);
          current.workerRuntimes.delete(run.id);
          throw error;
        }

        const binding: RunBinding = {
          parent,
          background: run.background,
          completion: Promise.resolve(started),
          usageClaimed: false,
          onUpdate,
        };
        current.bindings.set(run.id, binding);
        persistTelemetry(current, started);
        binding.completion = attachCompletion(current, run.id);
        setStatus(current, ctx);

        if (run.background) {
          const snapshot = current.coordinator.snapshot(run.id)!;
          return {
            content: [{
              type: "text" as const,
              text: `${persistenceNote}Started USAP run ${run.id} · ${model} · ${resolved.selection.source}${resolved.selection.profile ? ` · ${resolved.selection.profile}` : ""}: ${run.tasks.map((task) => task.id).join(", ")}\nDispatch summary: ${JSON.stringify(dispatchDetails(snapshot, persistence).summary)}`,
            }],
            details: dispatchDetails(snapshot, persistence),
          };
        }

        const abort = () => current.coordinator.cancel(run.id);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        try {
          const settled = await binding.completion;
          assertOwner(current, ctx);
          binding.usageClaimed = true;
          return {
            content: [{ type: "text" as const, text: `${persistenceNote}Dispatch summary: ${JSON.stringify(dispatchDetails(settled, persistence).summary)}\n${renderRunResult(settled)}` }],
            details: dispatchDetails(settled, persistence),
            // Nested worker usage belongs only here, never under details/results.
            usage: usageCopy(settled.usage),
          };
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      },
    });

    pi.registerTool({
      name: "ultraterm_hub",
      label: "UltraTerm Hub",
      description: "Inspect this native session's live and checkpointed USAP runs: list, status, bounded wait, cancel, send, inbox, diagnose, or explicitly resume unfinished work. Resume never repeats completed tasks; host exit interrupts execution but preserves checkpoints.",
      promptSnippet: "Inspect, wait for, cancel, or message an existing USAP run",
      promptGuidelines: [
        "Runs and relay actions belong only to this native parent session. IDs copied from other sessions are historical, not controllable here.",
        "runId is required for every action except list.",
        "Send needs to and body; replies need kind=reply and the exact replyTo.",
        "Wait with finite timeouts; avoid polling.",
      ],
      parameters: ultratermHubSchema as any,
      renderShell: "self",
      renderCall: renderSubagentCall,
      renderResult: renderSubagentResult,
      async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
        const params = rawParams as UltratermHubParams;
        const current = ensureRuntime(ctx);

        if (params.action === "list") {
          const live = current.coordinator.list();
          const liveIds = new Set(live.map((run) => run.id));
          // A retained lease is diagnostic read-only evidence, never a write path.
          const readOnly = current.store ? [] : (current.readOnlyCheckpoints?.() ?? []);
          const runs = [...(current.store?.list() ?? readOnly).filter((item) => !liveIds.has(item.run.id)).map(recoveredRun), ...live];
          const warning = sessionWarning(current);
          return {
            content: [{
              type: "text" as const,
              text: runs.length === 0
                ? `No USAP runs in this session.${warning ? `\n${warning}` : ""}`
                : runs.map((run) => renderRunProgress(run)).join("\n").slice(0, MAX_TOOL_CONTENT),
            }],
            details: { action: "list" as const, runs: runs.map(toRunView), persistence: persistenceOf(current), readOnly: !current.store && current.checkpointDegraded, checkpointError: current.checkpointError ?? null, shutdownWarning: warning ?? null },
          };
        }

        const runId = requireRunId(params);
        const binding = current.bindings.get(runId);
        const checkpoint = current.store?.get(runId)
          ?? current.readOnlyCheckpoints?.()?.find((item) => item.run.id === runId);
        const snapshot = current.coordinator.snapshot(runId) ?? (checkpoint ? recoveredRun(checkpoint) : undefined);
        if (!snapshot) {
          // Diagnose is the operator's escape hatch: a session that cannot claim
          // its durable store still explains why instead of bricking the chat.
          if (params.action === "diagnose" && (current.checkpointError || current.checkpointCollision)) {
            const diagnostics = {
              persistence: persistenceOf(current),
              readOnly: true,
              reason: "run-unreadable",
              checkpointError: current.checkpointError ?? null,
              checkpointCollision: current.checkpointCollision ?? null,
              shutdownWarning: sessionWarning(current) ?? null,
              note: "This session cannot read its durable checkpoint namespace, so no run data is available for this id.",
            };
            return { content: [{ type: "text" as const, text: JSON.stringify(diagnostics, null, 2) }], details: { action: "diagnose" as const, diagnostics } };
          }
          throw new Error(`Unknown USAP run: ${runId}`);
        }

        if (params.action === "diagnose") {
          const warning = sessionWarning(current);
          const diagnostics = {
            ...diagnoseRun(snapshot),
            persistence: persistenceOf(current),
            // True when this view came from a lease this session may not write.
            readOnly: !current.store && current.checkpointDegraded,
            checkpointError: current.checkpointError ?? null,
            checkpointCollision: current.checkpointCollision ?? null,
            shutdownWarning: warning ?? null,
            warnings: current.store?.warnings ?? [],
            waitTimeoutMeaning: "A hub wait timeout stops observing, never the worker.",
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(diagnostics, null, 2) }], details: { action: "diagnose" as const, diagnostics } };
        }

        if (params.action === "resume") {
          if (snapshot.state === "running") throw new Error("Run is still active; resume would duplicate work");
          if (checkpoint?.resumedAs) throw new Error(`Already resumed as ${checkpoint.resumedAs}; inspect that run instead`);
          if (checkpoint?.pendingResume) throw new Error("Resume reservation interrupted; reload the host to recover it before retrying");
          // A retained lease or a duplicate in-process owner must refuse loudly
          // rather than continue a run whose session file may still be written.
          assertDurableForNewWork(current, "Resume");
          if (!current.store || current.checkpointError) throw new Error("Healthy durable checkpoints are required to resume");
          if (snapshot.version !== USAP_VERSION) throw new Error("Checkpoint policy version is incompatible; inspect history before a new dispatch");
          if (!statSync(snapshot.cwd).isDirectory()) throw new Error("Checkpoint workspace is unavailable");
          const unfinished = snapshot.tasks.filter((task) => task.state !== "done");
          if (!unfinished.length) throw new Error("No unfinished tasks to resume");
          for (const task of unfinished) {
            if (task.startedAt !== undefined && !task.sessionFile) throw new Error(`No native checkpoint for ${task.label}; inspect partial work before a new dispatch`);
            if (task.sessionFile) current.store.validateSession(task.sessionFile);
          }
          if (!ctx.model) throw new Error("A resolved model is required to resume");
          const input: DispatchInput = {
            goal: snapshot.goal, constraints: snapshot.constraints, contract: snapshot.contract,
            model: snapshot.model, thinking: snapshot.thinkingLevel as DispatchInput["thinking"],
            requireImages: snapshot.selection?.images === true,
            thinkingReason: "Continue the explicitly budgeted checkpoint on its original model and reasoning level.",
            concurrency: snapshot.concurrency, timeoutMs: snapshot.timeoutMs, maxTurns: snapshot.maxTurns,
            background: true, tasks: unfinished.map((task) => ({ label: task.label, task: task.task, role: task.role, mayEdit: task.mayEdit, ...(task.mayEdit ? { ownedPaths: task.ownedPaths } : {}), allowBash: task.allowBash })),
          };
          const resolved = resolveWorkerSelection(ctx.model, ctx.thinkingLevel, input, ctx.modelRegistry, dependencies.profiles, undefined, automaticChainOptions(dependencies));
          const run = normalizeDispatch(input, snapshot.cwd, snapshot.model, String(resolved.thinkingLevel), dependencies.now?.() ?? Date.now(), dependencies.idFactory);
          run.selection = { ...resolved.selection,
            ...(snapshot.selection?.source === "chain" ? {
              source: "chain" as const,
              chainRoutes: snapshot.selection.chainRoutes ? [...snapshot.selection.chainRoutes] : undefined,
            } : {}),
          };
          run.ownerSessionId = current.ownerSessionId;
          run.ownerSessionFile = current.ownerSessionFile;
          run.tasks.forEach((task, index) => {
            task.sessionFile = unfinished[index].sessionFile;
            task.changedPaths = unfinished[index].changedPaths;
            task.lastStep = unfinished[index].lastStep;
          });
          current.store.prepareResume(runId, run);
          current.workerRuntimes.set(run.id, Object.freeze({ model: Object.freeze({ ...resolved.model }), thinkingLevel: resolved.thinkingLevel }));
          current.relay.createRun(run.id, [PARENT_RELAY_ID, ...run.tasks.map((task) => task.id)]);
          const parent = current.relay.bindSender(run.id, PARENT_RELAY_ID);
          try {
            const started = current.coordinator.start(run);
            const resumed: RunBinding = { parent, background: true, completion: Promise.resolve(started), usageClaimed: false };
            current.bindings.set(run.id, resumed);
            resumed.completion = attachCompletion(current, run.id);
            setStatus(current, ctx);
            return { content: [{ type: "text" as const, text: `Resumed ${unfinished.length} unfinished tasks as ${run.id}. Completed tasks were not replayed. A fresh explicit budget applies; inspect prior side effects.` }], details: dispatchDetails(started, persistenceOf(current)) };
          } catch (error) { parent.close(); current.relay.cleanupRun(run.id); current.workerRuntimes.delete(run.id); throw error; }
        }

        if (params.action === "status") {
          const warning = sessionWarning(current);
          return {
            content: [{ type: "text" as const, text: warning ? `${renderRunResult(snapshot)}\n${warning}` : renderRunResult(snapshot) }],
            details: { action: "status" as const, run: toRunView(snapshot), persistence: persistenceOf(current), readOnly: !current.store && current.checkpointDegraded, shutdownWarning: warning ?? null },
          };
        }

        if (params.action === "wait" && !binding) {
          return { content: [{ type: "text" as const, text: renderRunResult(snapshot) }], details: { action: "wait", run: toRunView(snapshot), timedOut: false } };
        }
        if (!binding) throw new Error("Archived run: use status, diagnose, or explicitly resume unfinished work");

        if (params.action === "wait") {
          const timeoutMs = boundedHubWait(params.timeoutMs);
          try {
            const waited = await current.coordinator.wait(runId, params.mode ?? "next", { timeoutMs, signal });
            assertOwner(current, ctx);
            const result: {
              content: Array<{ type: "text"; text: string }>;
              details: HubDetails;
              usage?: UsageTotals;
            } = {
              content: [{ type: "text", text: renderRunResult(waited) }],
              details: { action: "wait", run: toRunView(waited), timedOut: false },
            };
            if (waited.state !== "running" && snapshot.background && !binding.usageClaimed) {
              binding.usageClaimed = true;
              result.usage = usageCopy(waited.usage);
            }
            return result;
          } catch (error) {
            if (!(error instanceof CoordinatorWaitTimeoutError)) throw error;
            assertOwner(current, ctx);
            const afterTimeout = current.coordinator.snapshot(runId)!;
            return {
              content: [{ type: "text" as const, text: `${renderRunProgress(afterTimeout)}\nObservation window ended after ${timeoutMs}ms; workers continue running. This is not a worker failure.` }],
              details: { action: "wait" as const, run: toRunView(afterTimeout), timedOut: true },
            };
          }
        }

        if (params.action === "cancel") {
          const changed = current.coordinator.cancel(runId, params.taskId);
          const afterCancel = current.coordinator.snapshot(runId)!;
          persistTelemetry(current, afterCancel);
          setStatus(current, ctx);
          return {
            content: [{
              type: "text" as const,
              text: `${changed ? "Cancellation requested" : "Nothing to cancel"}: ${params.taskId ?? runId}`,
            }],
            details: { action: "cancel" as const, run: toRunView(afterCancel), changed },
          };
        }

        if (params.action === "send") {
          const to = requireString(params.to, "to").trim();
          const body = requireString(params.body, "body");
          const relay = binding.parent.send({
            to,
            body,
            ...(params.kind === undefined ? {} : { kind: params.kind }),
            ...(params.replyTo === undefined ? {} : { replyTo: params.replyTo }),
          });
          return {
            content: [{ type: "text" as const, text: relay.ok ? `Parent relay ${relay.status}: ${relay.ids.join(", ")}` : relay.message }],
            details: { action: "send" as const, run: toRunView(snapshot), relay },
          };
        }

        if (params.action === "inbox") {
          const relay = binding.parent.inbox(params.afterSeq ?? 0, params.limit ?? RELAY_MAILBOX_LIMIT);
          return {
            content: [{
              type: "text" as const,
              text: relay.messages.length === 0
                ? "Parent relay inbox is empty."
                : relay.messages.map((message) => `[${message.from} → ${message.to}] ${message.body}`).join("\n")
                  .slice(0, MAX_TOOL_CONTENT),
            }],
            details: { action: "inbox" as const, run: toRunView(snapshot), relay },
          };
        }

        throw new TypeError(`Unknown ultraterm_hub action: ${String(params.action)}`);
      },
    });
  };
}

export default createUltratermSubagentsExtension();

export { RUN_BROADCAST_TARGET };

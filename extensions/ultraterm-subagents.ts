import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { SubagentCoordinator, CoordinatorWaitTimeoutError } from "../src/subagents/coordinator.ts";
import { normalizeDispatch } from "../src/subagents/policy.ts";
import {
  RelayBroker,
  RUN_BROADCAST_TARGET,
  type RelayPeer,
} from "../src/subagents/relay.ts";
import { SessionScheduler } from "../src/subagents/scheduler.ts";
import type { PiWorkerRuntime, PiWorkerRunnerOptions } from "../src/subagents/pi-worker.ts";
import {
  MAX_CONCURRENCY,
  MAX_TASKS,
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

// Equivalent JSON Schema shape to pi-ai's StringEnum, kept local so this
// extension does not add a direct runtime dependency solely for enum schemas.
function stringEnum<T extends readonly string[]>(values: T): TSchema {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values] });
}

const RoleSchema = stringEnum(["scout", "worker", "reviewer"] as const);
const RelayKindSchema = stringEnum(["message", "request", "reply", "status"] as const);
const HubActionSchema = stringEnum(["list", "status", "wait", "cancel", "send", "inbox"] as const);
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
  constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 64 })),
  contract: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
  tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 30 * 60_000 })),
  background: Type.Optional(Type.Boolean({ default: false })),
}, { additionalProperties: false });

/** Public provider-compatible hub schema. Sender identity is absent and host-bound. */
export const ultratermHubSchema = Type.Object({
  action: HubActionSchema,
  runId: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 128,
    description: "Required for status, wait, cancel, send, and inbox; omit only for list",
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
  action: "list" | "status" | "wait" | "cancel" | "send" | "inbox";
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
  turns: number;
  truncated: boolean;
}

export interface RunView {
  runId: string;
  goal: string;
  state: RunRecord["state"];
  model: string;
  thinkingLevel: string;
  background: boolean;
  createdAt: number;
  endedAt?: number;
  totalTokens: number;
  totalCost: number;
  tasks: SettledTaskView[];
}

export interface DispatchDetails {
  mode: "foreground" | "background";
  run: RunView;
}

export interface HubDetails {
  action: UltratermHubParams["action"];
  run?: RunView;
  runs?: RunView[];
  changed?: boolean;
  timedOut?: boolean;
  relay?: unknown;
}

export interface UltratermSubagentsDependencies {
  createRunner?: (pi: ExtensionAPI, relay: RelayBroker) => WorkerRunner;
  createScheduler?: () => SessionScheduler;
  createRelay?: () => RelayBroker;
  now?: () => number;
  idFactory?: () => string;
}

interface RunBinding {
  parent: RelayPeer;
  background: boolean;
  completion: Promise<RunRecord>;
  usageClaimed: boolean;
  onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: DispatchDetails }) => void;
}

interface SessionRuntime {
  relay: RelayBroker;
  coordinator: SubagentCoordinator;
  bindings: Map<string, RunBinding>;
  workerRuntimes: Map<string, PiWorkerRuntime>;
  statusContext?: ExtensionContext;
  closed: boolean;
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
    turns: task.turns,
    truncated: task.truncated,
  };
}

/** Create a stable, JSON-safe view without duplicating nested model usage. */
export function toRunView(run: RunRecord): RunView {
  return {
    runId: run.id,
    goal: run.goal,
    state: run.state,
    model: run.model,
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
  let text = `${renderRunProgress(run)}\nmodel ${run.model} · thinking ${run.thinkingLevel}`.slice(0, limit);
  let wasTruncated = false;
  for (const task of run.tasks) {
    const suffix = task.truncated ? " · worker output truncated" : "";
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

function dispatchDetails(run: RunRecord): DispatchDetails {
  return { mode: run.background ? "background" : "foreground", run: toRunView(run) };
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
  return function ultratermSubagentsExtension(pi: ExtensionAPI): void {
    let runtime: SessionRuntime | undefined;

    const setStatus = (current: SessionRuntime, ctx?: ExtensionContext): void => {
      const target = ctx ?? current.statusContext;
      if (!target) return;
      current.statusContext = target;
      try {
        target.ui.setStatus("usap", renderSessionStatus(current.coordinator.activeRuns()));
      } catch {
        // UI observation must not affect child execution.
      }
    };

    const reconcileRetainedBindings = (current: SessionRuntime): void => {
      for (const [runId, binding] of current.bindings) {
        if (current.coordinator.has(runId)) continue;
        binding.parent.close();
        current.relay.cleanupRun(runId);
        current.bindings.delete(runId);
        current.workerRuntimes.delete(runId);
      }
    };

    const destroyRuntime = (ctx?: ExtensionContext): void => {
      const current = runtime;
      if (!current) {
        ctx?.ui.setStatus("usap", undefined);
        return;
      }
      current.closed = true;
      current.coordinator.shutdown();
      for (const [runId, binding] of current.bindings) {
        binding.parent.close();
        current.relay.cleanupRun(runId);
      }
      current.bindings.clear();
      current.workerRuntimes.clear();
      try {
        (ctx ?? current.statusContext)?.ui.setStatus("usap", undefined);
      } catch {
        // The session UI may already be tearing down.
      }
      runtime = undefined;
    };

    const ensureRuntime = (ctx: ExtensionContext): SessionRuntime => {
      if (runtime && !runtime.closed) {
        runtime.statusContext = ctx;
        return runtime;
      }

      const relay = dependencies.createRelay?.() ?? new RelayBroker();
      const scheduler = dependencies.createScheduler?.() ?? new SessionScheduler(MAX_CONCURRENCY);
      const workerRuntimes = new Map<string, PiWorkerRuntime>();
      let created!: SessionRuntime;
      const runner = dependencies.createRunner?.(pi, relay)
        ?? defaultWorkerRunner(relay, workerRuntimes);
      const coordinator = new SubagentCoordinator(runner, {
        scheduler,
        now: dependencies.now,
        onProgress: (event) => {
          if (created.closed) return;
          setStatus(created);
          const binding = created.bindings.get(event.runId);
          if (!binding?.onUpdate) return;
          try {
            binding.onUpdate({
              content: [{ type: "text", text: renderRunProgress(event.run) }],
              details: dispatchDetails(event.run),
            });
          } catch {
            // Pi scopes onUpdate to a live tool call; observers never own execution.
          }
        },
      });
      created = {
        relay,
        coordinator,
        bindings: new Map(),
        workerRuntimes,
        statusContext: ctx,
        closed: false,
      };
      runtime = created;
      return created;
    };

    const attachCompletion = (current: SessionRuntime, runId: string): Promise<RunRecord> => {
      const completion = current.coordinator.wait(runId, "all");
      void completion.then((run) => {
        if (current.closed) return;
        const binding = current.bindings.get(runId);
        current.workerRuntimes.delete(runId);
        setStatus(current);
        reconcileRetainedBindings(current);
        if (!binding) return;
        try {
          binding.onUpdate?.({
            content: [{ type: "text", text: renderRunProgress(run) }],
            details: dispatchDetails(run),
          });
        } catch {
          // A settled tool call may no longer accept updates.
        }
        binding.onUpdate = undefined;
        if (binding.background) {
          try {
            pi.sendMessage({
              customType: "ultraterm-subagents-complete",
              content: renderCompletionMessage(run),
              display: true,
              details: { runId: run.id, state: run.state, taskIds: run.tasks.map((task) => task.id) },
            }, { deliverAs: "nextTurn", triggerTurn: false });
          } catch {
            // Completion delivery is best effort during host teardown.
          }
        }
      }).catch((error: unknown) => {
        if (current.closed) return;
        current.workerRuntimes.delete(runId);
        setStatus(current);
        reconcileRetainedBindings(current);
        try {
          pi.sendMessage({
            customType: "ultraterm-subagents-complete",
            content: `USAP ${runId} infrastructure failure: ${error instanceof Error ? error.message : String(error)}`
              .slice(0, MAX_COMPLETION_MESSAGE),
            display: true,
            details: { runId, infrastructureError: true },
          }, { deliverAs: "nextTurn", triggerTurn: false });
        } catch {
          // Completion delivery is best effort during host teardown.
        }
      });
      return completion;
    };

    pi.on("session_start", (_event, ctx) => {
      if (runtime) destroyRuntime(ctx);
      ensureRuntime(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      destroyRuntime(ctx);
    });

    pi.registerTool({
      name: "ultraterm_subagents",
      label: "UltraTerm Subagents",
      description: "Dispatch 1-8 bounded child tasks through the session USAP coordinator. Foreground is the efficient default; choose background explicitly only when parent work can overlap. ownedPaths are writable ownership only and must be omitted for read-only tasks. allowBash is explicit unsandboxed shell access in the operator trust domain.",
      promptSnippet: "Dispatch bounded independent child tasks with explicit permissions and path ownership",
      promptGuidelines: [
        "Independence is necessary but not sufficient: keep trivial edits, direct answers, and leaves smaller than their briefing/integration cost in the parent.",
        "Use ultraterm_subagents only for substantial independent bounded leaves where context isolation, multi-turn depth, or useful latency overlap repays delegation; the parent retains decomposition, integration, and verification.",
        "When the request already gives exact disjoint paths and acceptance contracts, dispatch in the first tool turn without pre-reading child-owned files; child inspection supplies leaf evidence and the parent verifies after.",
        "Before dispatch, inspect only shared interfaces or ambiguity actually needed to decompose safely; do not duplicate child discovery in the parent.",
        "Choose background execution only when the parent can inspect shared contracts or prepare integration while children run; then use one bounded ultraterm_hub wait instead of polling.",
        "Never start a background run merely to wait immediately; foreground avoids that extra coordination turn.",
        "For read-only tasks omit ownedPaths and state the read scope in task text; ownedPaths are required only for mayEdit=true.",
        "allowBash bypasses ownedPaths because shell commands are not path-sandboxed; grant it only when that operator-level access is necessary.",
      ],
      parameters: ultratermSubagentsSchema as any,
      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        const params = rawParams as UltratermSubagentsParams;
        if (!ctx.model) throw new Error("ultraterm_subagents requires a resolved current model");
        const current = ensureRuntime(ctx);
        const frozenWorkerRuntime: PiWorkerRuntime = Object.freeze({
          model: Object.freeze({ ...ctx.model }),
          thinkingLevel: ctx.thinkingLevel ?? "off",
        });
        const model = `${frozenWorkerRuntime.model.provider}/${frozenWorkerRuntime.model.id}`;
        const thinking = String(frozenWorkerRuntime.thinkingLevel);
        const input: DispatchInput = {
          ...params,
          tasks: params.tasks,
          background: params.background ?? false,
        };
        const run = normalizeDispatch(
          input,
          ctx.cwd,
          model,
          thinking,
          dependencies.now?.() ?? Date.now(),
          dependencies.idFactory,
        );

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
        binding.completion = attachCompletion(current, run.id);
        setStatus(current, ctx);

        if (run.background) {
          const snapshot = current.coordinator.snapshot(run.id)!;
          return {
            content: [{
              type: "text" as const,
              text: `Started USAP run ${run.id}: ${run.tasks.map((task) => task.id).join(", ")}`,
            }],
            details: dispatchDetails(snapshot),
          };
        }

        const abort = () => current.coordinator.cancel(run.id);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
        try {
          const settled = await binding.completion;
          binding.usageClaimed = true;
          return {
            content: [{ type: "text" as const, text: renderRunResult(settled) }],
            details: dispatchDetails(settled),
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
      description: "Manage session-local USAP runs: list, status, bounded wait, cancel, send a host-authenticated parent relay message, or read the parent inbox.",
      promptSnippet: "Inspect, wait for, cancel, or message an existing USAP run",
      promptGuidelines: [
        "Always include runId for status, wait, cancel, send, and inbox; only list omits runId.",
        "Send requires to and body; a reply also requires kind=reply and the exact request envelope ID in replyTo.",
        "Use ultraterm_hub wait with a finite timeout for background work; avoid repeated status polling.",
      ],
      parameters: ultratermHubSchema as any,
      async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
        const params = rawParams as UltratermHubParams;
        const current = ensureRuntime(ctx);

        if (params.action === "list") {
          const runs = current.coordinator.list();
          return {
            content: [{
              type: "text" as const,
              text: runs.length === 0
                ? "No USAP runs in this session."
                : runs.map((run) => renderRunProgress(run)).join("\n").slice(0, MAX_TOOL_CONTENT),
            }],
            details: { action: "list" as const, runs: runs.map(toRunView) },
          };
        }

        const runId = requireRunId(params);
        const binding = current.bindings.get(runId);
        const snapshot = current.coordinator.snapshot(runId);
        if (!binding || !snapshot) throw new Error(`Unknown USAP run: ${runId}`);

        if (params.action === "status") {
          return {
            content: [{ type: "text" as const, text: renderRunResult(snapshot) }],
            details: { action: "status" as const, run: toRunView(snapshot) },
          };
        }

        if (params.action === "wait") {
          const timeoutMs = boundedHubWait(params.timeoutMs);
          try {
            const waited = await current.coordinator.wait(runId, params.mode ?? "next", { timeoutMs, signal });
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
            const afterTimeout = current.coordinator.snapshot(runId)!;
            return {
              content: [{ type: "text" as const, text: `${renderRunProgress(afterTimeout)}\nHub wait timed out after ${timeoutMs}ms.` }],
              details: { action: "wait" as const, run: toRunView(afterTimeout), timedOut: true },
            };
          }
        }

        if (params.action === "cancel") {
          const changed = current.coordinator.cancel(runId, params.taskId);
          const afterCancel = current.coordinator.snapshot(runId)!;
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

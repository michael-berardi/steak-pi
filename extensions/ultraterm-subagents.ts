import { setSubagentCountReader, subagentActivityChanged } from "../src/tui/subagent-activity.ts";
import { resolveStagedModule } from "../src/subagents/staged-runtime.ts";
import { registryForSolSelection, type CreateIsolatedModelRuntime } from "../src/subagents/codex-selection.ts";
import { GO_ACCOUNT_ROUTER_TIMEOUT_MS, type AccountCommand } from "../src/subagents/provider-accounts.ts";
import { claudeLoginBlock, claudeQuotaBlock, CODEX_QUOTA, isMeteredQuota, isQuotaLaunchFailure, pickClaudeAccount, rankClaudeAccounts, quotaChain, quotaProviderOf, readProviderQuota, routeQuotaBlock, type ClaudeAccountPick, type QuotaProvider, type QuotaSnapshot } from "../src/subagents/provider-quota.ts";
import { isContentFilterRefusal } from "../src/content-filter-refusal.ts";
import { noClaudeCause, planOnlyCause, resolveProjectPolicy, type ProjectPolicy } from "../src/subagents/project-policy.ts";
import { AVAILABILITY_TTL_MS, computeAvailability } from "../src/subagents/route-availability.ts";
import { CLAUDE_REVIEW_SHELL_REFUSED, isClaudeReadOnlyReview } from "../src/subagents/claude-review-permissions.ts";
import { canFallbackReview, implicitReviewFallbackRoute, implicitReviewRoute, isReadOnlyReviewWave, recordReviewFallback } from "../src/subagents/reviewer-fallback.ts";
import { parseRoute, routeLabel, routingConfigOrEmpty, DSH_ROUTE_PREFIX, TASK_CLASS_MAX_LENGTH } from "../src/routing-config.ts";
import { statSync } from "node:fs";
import { PersistenceHealth } from "../src/subagents/persistence-health.ts";
import { deferredToolsEnabled, setToolActive } from "../src/deferred-tools.ts";
import { signalStart } from "../src/adaptive-tools.ts";
import { hideSkill, toolIsOffered } from "../src/skill-visibility.ts";
import { setPinnedPanel } from "../src/tui/pinned-panels.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { SubagentCoordinator, CoordinatorWaitTimeoutError } from "../src/subagents/coordinator.ts";
import { normalizeDispatch, SubagentPolicyError } from "../src/subagents/policy.ts";
import { assertKnownClaudeAccount, resolveClaudeAccount } from "../src/subagents/claude-account.ts";
import { assertActiveModelSelector } from "../src/retired-model-selection.ts";
import { loadWorkerProfiles, resolveWorkerSelection, resolveClaudeCodeSelection, assertClaudeCodeImageAdmission, admitClaudeCodeRoute, claudeCodeModelName, claudeCodeRouteModel, claudeCodeRouteOfProfile, claudeFallbackTier, defaultClaudeCodeRoute, isClaudeCodeEffort, resolveClaudeCodeEffort, CLAUDE_CODE_EFFORTS, CLAUDE_CODE_ROUTES, type ClaudeFallbackTier, type WorkerProfile } from "../src/subagents/model-selection.ts";
import { admitClaudeApiRoute, claudeApiConcurrency, claudeApiModelOf, CLAUDE_API_ROUTES, formatClaudeApiReceipt, isClaudeApiRoute, resolveClaudeApiSelection, stampClaudeApiRun } from "../src/subagents/claude-api-route.ts";
import { AUTOMATIC_CHAIN_APPROVAL, NoChainRouteError, defaultWorkerChain, dshStepBlockReason, isDefaultChainExhausted, onlyWhenSkipReason, type ChainOptions, type TaskClassStep, type TaskClassWalk, type WorkerRouteStep } from "../src/model-route-policy.ts";
import { admitDshRoute, dshEffortOf, dshRouteModel, dshRouteOf, dshRouteShapeRefusal, resolveDshEffort } from "../src/subagents/dsh-routes.ts";
import { analyzeWaveClasses, applyInferredTaskClasses, configuredTaskClass, ignoredTaskClass, resolveTaskClassWalk, type WaveTaskClass } from "../src/subagents/task-class.ts";
import { RouteEvidenceStore, routeEvidencePath, recordSettledTask } from "../src/subagents/route-evidence.ts";
import { classReport, describeDecision, formatClassReport, settingsOf, type Rng } from "../src/subagents/route-ranking.ts";
import { isEnsureRefusal, withProfileEnsure, type EnsureExec } from "../src/subagents/profile-ensure.ts";
import { isSubscriptionOrLocalRoute } from "../src/subscription-first-routing.ts";
import {
  RelayBroker,
  RUN_BROADCAST_TARGET,
  type RelayPeer,
} from "../src/subagents/relay.ts";
import { SessionScheduler } from "../src/subagents/scheduler.ts";
import { canonicalSessionFile, CheckpointStore, diagnoseRun, isInProcessCheckpointCollision, recoveredRun, type Checkpoint } from "../src/subagents/checkpoints.ts";
import { renderSubagentCall, renderSubagentResult, renderSubagentLive } from "../src/subagents/render.ts";
import type { PiWorkerRuntime, PiWorkerRunnerOptions, PiWorkerSessionFactory } from "../src/subagents/pi-worker.ts";
import type { ClaudeSpawn, ClaudeWorkerRunnerOptions } from "../src/subagents/claude-worker.ts";
import type { DshSpawn, DshWorkerRunnerOptions, DshWorkerRuntime } from "../src/subagents/dsh-worker.ts";
import {
  addUsage,
  USAP_VERSION,
  HARNESS_IDS,
  MAX_CONCURRENCY,
  MAX_TASKS,
  MAX_TIMEOUT_MS,
  MAX_WORKER_TURNS,
  PARTIAL_SUMMARY_LIMIT,
  RELAY_MAILBOX_LIMIT,
  TURN_BUDGET_ERROR,
  harnessOf,
  type DispatchInput,
  type HarnessId,
  type ModelSelection,
  type PartialReason,
  type RunRecord,
  type TaskClassSelection,
  type TaskOutcome,
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
/** How long a dispatch waits for each launched worker to produce its first model output or fail
 * before it may report `Started`. A worker that dies before that (router refusal, auth, route,
 * spawn, a first request that errors) fails the dispatch call itself, background or not, with its
 * named cause. The window must outlast the worker's own account phase: an account-leased worker makes two
 * bounded router calls before any request (reserve, then bind), each up to the router timeout, so a
 * slow router answers its refusal inside the window instead of after `Started`. Known limit: a first
 * request that fails with a 429 also reports the cooldown and releases the lease (two more router
 * calls) before it settles; with a router answering near its timeout that settle can land after the
 * window, and the failure then arrives as an ordinary completion naming the cause. */
export const DEFAULT_STARTUP_WINDOW_MS = 2 * GO_ACCOUNT_ROUTER_TIMEOUT_MS + 5_000;
export const MAX_STARTUP_WINDOW_MS = 30_000;
/** An implicit dispatch whose worker is refused on a provider quota or usage limit before any output re-runs
 * the same tasks on the next tier of the operator's configured walk (`providerQuotaFallback`, then the
 * `claudeFallbackTier`). Each tier is tried at most once, so a wave makes at most this many fall-throughs:
 * there is no loop. */
export const MAX_QUOTA_FALL_THROUGHS = 3;

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
const HubActionSchema = stringEnum(["list", "status", "wait", "cancel", "send", "redirect", "inbox", "resume", "diagnose", "routes", "record-outcome"] as const);
const OutcomeSchema = stringEnum(["pass", "fail"] as const);
const OutcomeSourceSchema = stringEnum(["verification", "test-gate", "operator"] as const);
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
  readPaths: Type.Optional(Type.Array(
    Type.String({ minLength: 1, maxLength: 2_000 }),
    { maxItems: 16, description: "Read-only artifact roots outside the run cwd for a read-only task (mayEdit must stay false): a job's captures, screenshots or logs, which must never be staged inside a project checkout. Each entry must be an existing real directory below a private agent home (~/.cache/ut-coordinator/J-NNNN/<folder>, ~/.cache/agent-scratch/<task>/<folder> or ~/.cache/ut-overseer/J-NNNN/<folder>); validated at dispatch and refused with a named error otherwise. Granted read-only (Claude Code --add-dir with Read/Grep/Glob only; a Pi child's read, grep, find and ls), never writable, and never granted on a task that may edit." },
  )),
  allowBash: Type.Optional(Type.Boolean({ description: "Enable unsandboxed shell access in the operator trust domain; defaults to false. Claude read-only reviewers never receive Bash; stage git evidence for Read/Grep/Glob." })),
  taskClass: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", minLength: 1, maxLength: TASK_CLASS_MAX_LENGTH, description: "Operator-named task class (a lowercase slug from taskClasses in routing.json). An implicit text worker wave whose class is configured walks that class's chain first, then the normal route; the receipt and dispatch note say which. A class the operator did not configure is ignored with a note, never an error. One run uses one route: tasks of one wave may not name two configured classes, and a class steers only a wave whose every task carries it, that fits the class's slots and, for a maxScope small class, has no task that may both edit and run a shell; otherwise the normal route runs and the note says why." })),
}, { additionalProperties: false });

/** Public dispatcher schema, exported so contract tests do not have to load Pi. */
export const ultratermSubagentsSchema = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 8_000 }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Exact authenticated provider/model for all tasks; mutually exclusive with profile." })),
  claudeAccount: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", minLength: 1, maxLength: 24, description: "Claude subscription account id from claude-accounts.json, e.g. primary, b, team-2. Task-scoped. Requires a Claude subscription route; unknown, unavailable, Pi and API selections fail closed. Never changes defaults or enables credits." })),
  profile: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Native harness/profile route (e.g. steak-pi/profile-name); mutually exclusive with model. Operator-retired routes are rejected." })),
  harness: Type.Optional(Type.Unsafe<HarnessId>({ type: "string", enum: [...HARNESS_IDS], description: "Execution harness. pi (default) is the native runner; claude-code is the official headless Claude CLI on the operator's claudeCodeDefaults model unless model names one of its pinned routes, at medium effort unless thinking asks for high/xhigh with a thinkingReason; workers, scouts and reviewers alike, with CLI-enforced ownedPaths; no Bash for read-only reviewers. Image review reads staged files under cwd with native Read. steak-dsh is the DSH headless CLI with the Steak DSH bundle on an exact steak-dsh/<provider>/<model-id> registry route (model may also be the inner provider/model with this harness); CLI-enforced ownedPaths, no shell unless allowBash, no relay steering or resume." })),
  requireImages: Type.Optional(Type.Boolean({ description: "Require advertised image input; no silent fallback. Claude Code uses native Read on staged image files under cwd or a read-only artifact root declared with readPaths, not inline attachments." })),
  constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 64 })),
  contract: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
  tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY, description: "Defaults to min(8, task count)." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS, description: "Absolute run budget including queue time; default 10 minutes, maximum 8 hours. Reviewer launch waits are additionally bounded to 60 seconds." })),
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_WORKER_TURNS, description: "Per-worker request budget; default 64. Increase explicitly for long-horizon work." })),
  background: Type.Optional(Type.Boolean({ default: false })),
  thinking: Type.Optional(stringEnum(["medium", "high", "xhigh"] as const)),
  thinkingReason: Type.Optional(Type.String({ minLength: 16, maxLength: 2_000, description: "Why high/xhigh reasoning benefits this task. Required with high/xhigh; every run is medium by default." })),
}, { additionalProperties: false });

/** Public provider-compatible hub schema. Sender identity is absent and host-bound. */
export const ultratermHubSchema = Type.Object({
  action: HubActionSchema,
  runId: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 128,
    description: "Required for every action except list and routes. Resume explicitly continues only unfinished checkpointed tasks.",
  })),
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Optional task target for cancel and record-outcome" })),
  taskClass: Type.Optional(Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", minLength: 1, maxLength: TASK_CLASS_MAX_LENGTH, description: "routes: show only this task class" })),
  outcome: Type.Optional(Type.Unsafe<"pass" | "fail">({ ...OutcomeSchema, description: "Required for record-outcome: whether the work of that run (and task) was correct once verified" })),
  source: Type.Optional(Type.Unsafe<"verification" | "test-gate" | "operator">({ ...OutcomeSourceSchema, description: "record-outcome: where the verdict came from (default operator)" })),
  mode: Type.Optional(WaitModeSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_HUB_WAIT_MS })),
  to: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Required peer task ID or #run for send/redirect" })),
  body: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000, description: "Required concise body for send/redirect; redirect appends instructions without cancelling or granting permissions" })),
  kind: Type.Optional(RelayKindSchema),
  replyTo: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Required request envelope ID when kind is reply" })),
  afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 0, maximum: RELAY_MAILBOX_LIMIT })),
}, { additionalProperties: false });

export const dispatchSchema = ultratermSubagentsSchema;
export const hubSchema = ultratermHubSchema;

export type UltratermSubagentsParams = DispatchInput;
export interface UltratermHubParams {
  action: "list" | "status" | "wait" | "cancel" | "send" | "redirect" | "inbox" | "resume" | "diagnose" | "routes" | "record-outcome";
  runId?: string;
  taskId?: string;
  taskClass?: string;
  outcome?: "pass" | "fail";
  source?: "verification" | "test-gate" | "operator";
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
  /** Lets a reader tell a required review from any other leaf. */
  role: TaskRecord["role"];
  state: TaskRecord["state"];
  /** Set only for a turn- or time-budget stop; such a task is never a completed leaf. */
  outcome?: TaskOutcome;
  partialReason?: PartialReason;
  partialSummary?: string;
  /** Predecessor task this attempt continues (explicit bounded resume). */
  resumedFrom?: string;
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
  launchQueue?: NonNullable<TaskRecord["launchQueue"]> & { elapsedMs: number; remainingMs: number };
  lastLaunchQueue?: NonNullable<TaskRecord["lastLaunchQueue"]> & { elapsedMs: number; remainingMs: number };
  subscriptionReceipt?: TaskRecord["subscriptionReceipt"];
  /** The profile `ensure` hook outcome for this worker, when its profile has one. */
  profileEnsure?: TaskRecord["profileEnsure"];
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
  /** Absent means the Pi default harness. */
  harness?: HarnessId;
  selection?: RunRecord["selection"];
  claudeAccount?: RunRecord["claudeAccount"];
  thinkingLevel: string;
  background: boolean;
  createdAt: number;
  endedAt?: number;
  totalTokens: number;
  totalCost: number;
  tasks: SettledTaskView[];
  /** Predecessor run this run continues; set only by an explicit bounded resume. */
  resumedFrom?: string;
  /** Successor run that continued this run; a run is resumed at most once. */
  resumedAs?: string;
  /** Set once the successor finished every unfinished task: this run's partials are replaced. */
  supersededBy?: string;
}

/** Lineage that lives in the checkpoint store, not on the run record. */
export interface RunLinks {
  resumedAs?: string;
  supersededBy?: string;
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
    harness: HarnessId;
    profile: string | null;
    thinking: string;
    background: boolean;
    /** How a declared task class steered (or did not steer) the route. */
    taskClass?: TaskClassSelection;
    tasks: Array<{
      label: string;
      taskClass?: string;
      role: TaskRecord["role"];
      mayEdit: boolean;
      allowBash: boolean;
      ownedPaths: number;
      readPaths: number;
      modelRoute: string;
      selectionSource: string;
      outcome?: TaskOutcome;
      resumedFrom?: string;
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
  checkpointHealth?: ReturnType<PersistenceHealth["diagnose"]>;
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
  /** Test seam injected into the default claude-code runner; production spawns
   * the real official CLI once per task. Never used for harness "pi" runs. */
  claudeSpawn?: ClaudeSpawn;
  /** Test seam injected into the default steak-dsh runner; production spawns the
   * real steak-dsh CLI once per task. Never used for harness "pi" runs. */
  dshSpawn?: DshSpawn;
  accountCommand?: AccountCommand;
  /** Test seam: the operator project policy file (default ~/.ultraterm/coordinator/policy.json, or ULTRATERM_COORDINATOR_POLICY). */
  projectPolicyPath?: string;
  /** Test seam for the profile `ensure` / `release` commands; production spawns them with no shell. */
  ensureExec?: EnsureExec;
  /** The route evidence store the task-class router reads and writes (default: the USAP state directory). */
  routeEvidence?: RouteEvidenceStore;
  /** Uniform [0, 1) source for Thompson sampling and exploration (default Math.random). Tests inject a seeded one. */
  rng?: Rng;
  /** Bounded startup window (default {@link DEFAULT_STARTUP_WINDOW_MS}); 0 disables the wait. */
  startupWindowMs?: number;
  /** Test seam: the environment an unpinned Claude launch inherits (`CLAUDE_CONFIG_DIR` decides which login
   * it runs on). Defaults to `process.env`; production never passes it. */
  env?: NodeJS.ProcessEnv;
  createModelRuntime?: CreateIsolatedModelRuntime;
  now?: () => number;
  idFactory?: () => string;
  checkpointRoot?: string;
  shutdownGraceMs?: number;
}

/** Automatic chains may spend only through the operator's exact allowlist grant, so
 * a dispatched run resolves the same approval the paid-route flag governs. The seam
 * lets a caller pin the decision instead of reading paid-routes.json. */
/**
 * The registry is loaded once per session, so a model added to models.json
 * later reads as "unavailable" until a restart. On that
 * exact miss, reload models.json once and resolve again; other errors and a
 * second miss still fail closed with the original message.
 */
async function resolvePiSelection(
  resolve: () => ReturnType<typeof resolveWorkerSelection>,
  registry: ExtensionContext["modelRegistry"],
): Promise<ReturnType<typeof resolveWorkerSelection>> {
  try { return resolve(); }
  catch (error) {
    if (!/^USAP (model|profile) \S+ is unavailable/.test((error as Error)?.message ?? "") || typeof registry?.refresh !== "function") throw error;
    await registry.refresh();
    return resolve();
  }
}

const defaultEvidenceStores = new Map<string, RouteEvidenceStore>();
/** The evidence store for these dependencies: an injected one, else one per state-file path (so its read cache survives). */
function evidenceStoreOf(dependencies: Pick<UltratermSubagentsDependencies, "routeEvidence">): RouteEvidenceStore {
  if (dependencies.routeEvidence) return dependencies.routeEvidence;
  const path = routeEvidencePath();
  let store = defaultEvidenceStores.get(path);
  if (!store) { store = new RouteEvidenceStore(path); defaultEvidenceStores.set(path, store); }
  return store;
}

async function resolveNativeSelection(ctx: ExtensionContext, input: Parameters<typeof resolveWorkerSelection>[2], dependencies: UltratermSubagentsDependencies,
  quota: Pick<ChainOptions, "skipRoute" | "forceDefaultChain" | "quotaSnapshot" | "taskClass"> = {}) {
  const registry = await registryForSolSelection(ctx.model!, input, ctx.modelRegistry,
    dependencies.accountCommand, dependencies.createModelRuntime, dependencies.profiles);
  const resolve = (from: ExtensionContext["modelRegistry"]) => resolvePiSelection(() => resolveWorkerSelection(ctx.model!, ctx.thinkingLevel, input,
    from, dependencies.profiles, undefined, { ...automaticChainOptions(dependencies), ...quota }), from);
  try {
    const selected = await resolve(registry);
    // No cross-store bridge here: a parent on another account-leased tier still resolves its chain
    // order in its own store first. It only reaches an isolated Codex-tier store when the chain found
    // nothing else, in the catch below.
    return { ...selected, registry };
  }
  catch (failure) {
    // A parent on another account-leased tier has no Codex-tier login in its own store, so a Codex-tier
    // step of the default chain cannot resolve there. When the chain found nothing else, offer that step
    // the same isolated store an explicit dispatch of it gets. No eligible account, runtime or model there
    // leaves the original no-route error unchanged. A step already vetoed for quota is not offered at all.
    const parentTier = quotaProviderOf(ctx.model!);
    const bridge = parentTier !== undefined && parentTier !== CODEX_QUOTA && isMeteredQuota(parentTier) && isDefaultChainExhausted(failure)
      ? failure.tried.find((step) => quotaProviderOf(step) === CODEX_QUOTA && quota.skipRoute?.(step) !== true) : undefined;
    if (bridge) {
      const target = routeOfStep(bridge);
      try {
        const isolated = await registryForSolSelection(ctx.model!, { model: target }, ctx.modelRegistry,
          dependencies.accountCommand, dependencies.createModelRuntime, dependencies.profiles);
        if (isolated !== ctx.modelRegistry) {
          const bridged = await resolve(isolated);
          if (`${bridged.selection.provider}/${bridged.selection.modelId}` === target) return { ...bridged, registry: isolated };
        }
      } catch { /* The Codex tier is unavailable for this parent: the original outcome stands. */ }
    }
    throw failure;
  }
}

function automaticChainOptions(dependencies: UltratermSubagentsDependencies): ChainOptions {
  return { approvePaidRoute: dependencies.approvePaidRoute ?? AUTOMATIC_CHAIN_APPROVAL };
}

type NativeSelection = Awaited<ReturnType<typeof resolveNativeSelection>>;

/** Operator display names (`routeLabels`) for the chain steps a dispatch note reports on. */
const routeStepLabel = (step: WorkerRouteStep): string => routeLabel(step);
/** The router-gated step the automatic review fallback (`implicitReview.fallback`) would launch on. */
const reviewFallbackStep = (): WorkerRouteStep | undefined => {
  const route = implicitReviewFallbackRoute();
  return route ? parseRoute(route, "implicitReview.fallback") : undefined;
};
const stepOfSelection = (selection: { provider: string; modelId: string }): WorkerRouteStep => ({ provider: selection.provider, id: selection.modelId });
const routeOfStep = (step: WorkerRouteStep): string => `${step.provider}/${step.id}`;
/** Receipts stay bounded: a router cause is echoed, never an unbounded blob. */
const boundedReason = (text: string, limit = 480): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit);

/** The gated tiers of the implicit walk come from `providerQuotaFallback`, in order. An unmetered tier is
 * tracked so a run's own refusal holds it out; the Claude subscription tier follows and is not router-gated. */
/** A fall-through receipt carries the refused tier's cause beside the router's, so it may be longer than a plain one. */
const FALLBACK_REASON_LIMIT = 720;

/**
 * One tier of an implicit dispatch that launched and died on a provider quota or usage limit before any
 * worker produced output. The same tasks are re-run on the next tier; a tier a failed run reached, and
 * every tier ahead of it, is never retried.
 */
interface QuotaFallThrough {
  runId: string;
  /** The route the failed run was recorded on. */
  route: string;
  /** Router-gated providers the run reached. */
  providers: readonly QuotaProvider[];
  /** Bounded, named cause of each worker that failed. */
  cause: string;
  /** `ensure`: the route's profile `ensure` hook refused the launch. The route itself, not a quota tier, is held out.
   * `review`: an implicit review wave was refused on the Claude review route before any output; the same review
   * tasks run once on the configured `implicitReview.fallback` instead. */
  kind?: "ensure" | "review";
  /** `review` only: whether the CLI refused on a spent plan or on authentication, so the receipt says which. */
  reviewReason?: "quota" | "auth";
}

/** Routes whose profile `ensure` hook refused a launch in this walk: never retried, whatever else is true. */
const heldRoutes = (fallThroughs: readonly QuotaFallThrough[]): ReadonlyMap<string, QuotaFallThrough> =>
  new Map(fallThroughs.flatMap((item) => item.kind === "ensure" ? [[item.route, item] as const] : []));

/** Providers a fall-through must not revisit: the furthest tier a failed run reached and everything before it. */
function spentProviders(fallThroughs: readonly QuotaFallThrough[]): ReadonlySet<QuotaProvider> {
  const chain = quotaChain();
  const furthest = Math.max(-1, ...fallThroughs.flatMap((item) => item.providers.map((provider) => chain.indexOf(provider))));
  return new Set(chain.slice(0, furthest + 1));
}

/** Router-gated providers a run launched on. A steak-dsh run is gated on its INNER route's provider. */
function reachedProviders(run: RunRecord): QuotaProvider[] {
  const inner = dshRouteModel(run.model);
  const route = inner ? `${inner.provider}/${inner.id}` : run.model;
  const slash = route.indexOf("/");
  const provider = slash > 0 ? quotaProviderOf({ provider: route.slice(0, slash), id: route.slice(slash + 1) }) : undefined;
  return provider ? [provider] : [];
}

/** The text a worker's launch failure is classified on. */
const launchFailureText = (task: TaskRecord): string => task.error ?? "";

/**
 * The tiers a run reached, when its pre-output failure may fall through to the next tier: every worker
 * that failed at launch (`failures`) died on a provider quota or usage limit or a provider content-filter refusal, and no worker anywhere in
 * the run (`seen`, the settled snapshot) produced output or finished, since re-running would repeat work.
 * A plain auth, route or spawn failure, or any mix with one, is not a quota cause and stays a
 * synchronous failure.
 */
function quotaFallThroughProviders(seen: RunRecord | undefined, failures: readonly TaskRecord[]): QuotaProvider[] | undefined {
  if (!seen || seen.tasks.some((task) => task.outputStarted === true || task.state === "done")) return undefined;
  // A provider content-filter refusal (an HTTP 400 naming a content-inspection code) is an input refusal that another tier can answer.
  if (failures.length === 0 || !failures.every((task) => isQuotaLaunchFailure(launchFailureText(task)) || isContentFilterRefusal(launchFailureText(task)))) return undefined;
  const providers = reachedProviders(seen);
  return providers.length > 0 ? providers : undefined;
}

/** The documented review-fallback cause of one pre-output refusal text, or undefined when it is not one. */
function reviewRefusalKind(text: string): "quota" | "auth" | undefined {
  // The Claude CLI's own pre-output refusal arrives as this adapter's synthetic cause (claude-worker.ts
  // syntheticClaudeCause): "quota limit reached; resets 1pm (...)", "rate limit reached", "authentication failed".
  if (isQuotaLaunchFailure(text) || /quota limit reached|rate limit reached|usage limit|quota (?:exceeded|exhausted)/i.test(text)) return "quota";
  if (/authentication (?:failed|preflight failed|error)|auth status|subscription login|not logged in|logged out|signed out/i.test(text)) return "auth";
  return undefined;
}

/**
 * The review-fallback cause of a whole implicit review wave that died before any output, or undefined when
 * the wave is not one the configured `implicitReview.fallback` may take: every launched worker must have
 * failed pre-output on the same kind of refusal (quota or auth), and no worker anywhere may have produced
 * output or finished, since re-running a review would repeat work.
 */
function reviewFallThroughReason(seen: RunRecord | undefined, failures: readonly TaskRecord[]): "quota" | "auth" | undefined {
  if (!seen || seen.tasks.some((task) => task.outputStarted === true || task.state === "done")) return undefined;
  if (failures.length === 0) return undefined;
  const kinds = failures.map((task) => reviewRefusalKind(launchFailureText(task)));
  if (kinds.some((kind) => kind === undefined)) return undefined;
  return kinds.every((kind) => kind === "auth") ? "auth" : "quota";
}

/** What the dispatch tells a parent about the tiers that were refused before it, in the words of a receipt. */
const fallThroughSummary = (fallThroughs: readonly QuotaFallThrough[]): string =>
  fallThroughs.map((item) => item.kind === "ensure"
    ? `run ${item.runId} · ${item.route} was refused by its profile ensure hook before any worker started (${item.cause})`
    : item.kind === "review"
      ? `run ${item.runId} · ${item.route} was refused ${item.reviewReason === "auth" ? "on authentication" : "on the Claude usage limit"} before any worker produced output (${item.cause})`
      : `run ${item.runId} · ${item.route} was refused on a provider usage limit before any worker produced output (${item.cause})`).join("; ");
/** The dispatch-note line for a declared task class (absent when no task declared one). */
function taskClassNote(receipt: TaskClassSelection | undefined, wave: WaveTaskClass): string {
  if (!receipt) return "";
  const gate = receipt.requiresTestGate ? " This class is routed on the evidence that a test gate checks its results: run that gate before accepting the work." : "";
  const note = receipt.note ? ` Operator note: ${receipt.note}` : "";
  // A class steers only a wave whose every task carries it (classWaveMisfit), so no task rides a class route it did not ask for.
  const riders = "";
  const unknown = wave.unknown.length > 0 && receipt.outcome !== "ignored" ? ` Ignored, not configured: ${wave.unknown.join(", ")}.` : "";
  const evidence = receipt.decision ? ` Route evidence: ${describeDecision(receipt.decision)}.` : "";
  return `Task class ${receipt.name}: ${receipt.outcome === "served" ? "served" : receipt.outcome === "fallback" ? "not served" : "ignored"}; ${receipt.reason}.${evidence}${gate}${note}${riders}${unknown}\n`;
}
/** The words of a receipt for why the wave moved on: a usage limit, an ensure refusal, or both. */
const fallThroughCause = (fallThroughs: readonly QuotaFallThrough[]): string =>
  fallThroughs.every((item) => item.kind === "ensure") ? "a profile ensure refusal before any worker started"
    : fallThroughs.some((item) => item.kind === "ensure") ? "a usage-limit or ensure refusal before any output"
    : fallThroughs.some((item) => item.kind === "review") ? "a Claude review refusal before any output" : "a usage-limit refusal before any output";

interface ImplicitWorkerRoute {
  /** The Pi selection the wave launches on; absent when it moves to the Claude tier. */
  resolved?: NativeSelection;
  /** The Claude tier an exhausted default chain falls to, with the chain steps that were tried. */
  tier?: ClaudeFallbackTier;
  tried: readonly WorkerRouteStep[];
  /** Why each skipped or untried route could not launch, in chain order (named router causes). */
  causes: string[];
  /** The Claude subscription account the tier worker is pinned on: one the router snapshot shows
   * eligible. Absent when the router could not be read or lists no Claude account, so nothing
   * could be pinned (the launch then uses the parent's own Claude login). */
  claudeAccount?: NonNullable<ClaudeAccountPick["account"]>;
  /** How the wave's declared task class steered the route (absent when none steered it). */
  taskClass?: TaskClassSelection;
}

/**
 * The Claude account an automatic Claude launch pins: the best account the router's snapshot reports
 * eligible, walking them best-first and keeping the first one its own `select` accepts now. `select` is the
 * launch authority and can refuse an account its `status` row lists as eligible (a lent plan's reserve
 * floor, a snapshot that is a moment stale), so an ineligible account is never picked while another can
 * launch. Every automatic Claude launch pins the account it runs on: without a pin the CLI runs on the
 * parent's own login, which the same snapshot may show at 100% while another account is eligible (J-3759).
 */
async function pickLaunchAccount(snapshot: QuotaSnapshot, command?: AccountCommand): Promise<ClaudeAccountPick> {
  const listed = pickClaudeAccount(snapshot);
  if (listed.account === undefined) return listed;
  const refused: string[] = [];
  for (const candidate of rankClaudeAccounts(snapshot)) {
    try { await resolveClaudeAccount(candidate.id, command); return { account: candidate }; }
    catch (error) { refused.push(`${candidate.label}: ${boundedReason(error instanceof Error ? error.message : String(error), 160)}`); }
  }
  return { cause: `the router would not select any Claude account now (${refused.join("; ")})` };
}

/**
 * Quota-aware route for an IMPLICIT routine text wave (no harness, model, profile or Claude
 * account from the caller). Selection used to resolve a leased route without asking the account router,
 * so an exhausted provider was only discovered at worker launch, after `Started`. Now, before a
 * selection is returned:
 *
 *  1. resolve exactly as before; a route in no configured quota tier (local, unlisted, ...) is final;
 *  2. a router-gated route is kept unless the router proves EVERY configured account of that
 *     provider unavailable (cooling down, signed out, or a 100% window). Busy, unknown and
 *     unreadable are not exhaustion, so a busy provider stays put;
 *  3. an exhausted route is never selected: the configured default chain (`textWorkerChain`, or `multimodalWorkerChain` for an image wave)
 *     is walked with the exhausted providers skipped;
 *  4. when every step is out, the wave goes to the operator's `claudeFallbackTier` on the
 *     official claude-code subscription route (when one is configured), never to the paid
 *     claude-code-api route and never past a proven-ineligible Claude account. If no route
 *     can launch, the dispatch refuses synchronously naming every cause.
 *
 * `fallThroughs` is the same walk after a launched tier was refused on a usage limit before any
 * output: every tier that run reached, and everything ahead of it, is out whatever the router says,
 * so the wave moves strictly down the chain and a tier is never tried twice.
 */
async function resolveImplicitWorkerRoute(
  ctx: ExtensionContext,
  requested: UltratermSubagentsParams,
  dependencies: UltratermSubagentsDependencies,
  readQuota: () => Promise<QuotaSnapshot>,
  fallThroughs: readonly QuotaFallThrough[] = [],
  walk?: TaskClassWalk,
  policy: ProjectPolicy = {},
): Promise<ImplicitWorkerRoute> {
  // A planOnly project never gets a paid metered route: the chain resolver asks this before it admits one.
  if (policy.planOnly !== undefined) dependencies = { ...dependencies, approvePaidRoute: () => false };
  const spent = spentProviders(fallThroughs);
  const held = heldRoutes(fallThroughs);
  const heldBlock = (step: WorkerRouteStep): string | undefined => {
    const refused = held.get(routeOfStep(step));
    return refused ? `run ${refused.runId} was refused by its profile ensure hook before any worker started (${refused.cause})` : undefined;
  };
  const tierBlock = (snapshot: QuotaSnapshot, step: WorkerRouteStep): string | undefined => {
    // A route whose profile ensure hook refused a launch in this walk is out whatever the router says.
    const refused = heldBlock(step);
    if (refused !== undefined) return refused;
    // A config-driven onlyWhen condition is checked first: when it is false the step is skipped
    // with its named reason, whatever the quota meter says about the step's own provider.
    const onlyWhen = step.onlyWhen ? onlyWhenSkipReason(step.onlyWhen, { quotaSnapshot: snapshot }) : undefined;
    if (onlyWhen !== undefined) return onlyWhen;
    const provider = quotaProviderOf(step);
    if (provider === undefined || !spent.has(provider)) return routeQuotaBlock(snapshot, step);
    const failed = fallThroughs.find((item) => item.providers.includes(provider));
    // A tier ahead of the refused one in chain order is out too, whatever the router now says: the walk is
    // strictly downward, so an earlier route is never retried after a later tier was refused.
    return failed ? `run ${failed.runId} was refused on a usage limit before any output (${failed.cause})`
      : routeQuotaBlock(snapshot, step) ?? "this route was already out when the chain moved on to a later tier that was refused on a usage limit, so it is not retried";
  };
  // A tier this walk already refused before output is out whatever the router says, and so is everything ahead
  // of it in chain order. The veto needs no router meter, so it also holds an unmetered tier that a snapshot
  // cannot gate: without it the tier would be re-launched and refused again on every attempt.
  const spentSkip = (step: WorkerRouteStep) => {
    if (held.has(routeOfStep(step))) return true;
    const provider = quotaProviderOf(step);
    return provider !== undefined && spent.has(provider);
  };
  const skipStep = (step: WorkerRouteStep, snapshot: QuotaSnapshot | undefined) =>
    spentSkip(step) || (snapshot !== undefined && tierBlock(snapshot, step) !== undefined);
  let first: NativeSelection | undefined;
  let failure: unknown;
  // A parent on another account-leased tier needs a cross-store Codex-tier lookup. Read quota before
  // opening it, so a proven-exhausted plan is never offered an isolated runtime.
  const parentTier = quotaProviderOf(ctx.model!);
  // A class step that is router-gated or carries an `onlyWhen` is judged on the same snapshot as the default chain.
  const classNeedsQuota = walk?.steps.some((entry) => entry.step.onlyWhen !== undefined || isMeteredQuota(quotaProviderOf(entry.step) ?? "")) === true;
  let quota: QuotaSnapshot | undefined = (parentTier !== undefined && parentTier !== CODEX_QUOTA && isMeteredQuota(parentTier)) || classNeedsQuota ? await readQuota() : undefined;
  /** Why a class step did not serve the wave, in the words of a receipt. */
  const classStepCause = (entry: TaskClassStep): string =>
    entry.blocked ?? (quota ? tierBlock(quota, entry.step) : heldBlock(entry.step))
      ?? dshStepBlockReason(ctx.modelRegistry, entry.step, automaticChainOptions(dependencies))
      ?? "not launchable in this session (not authenticated, not in the dispatch catalog, or a reviewed paid route that is not approved in ~/.pi/agent/paid-routes.json)";
  const classStepName = (entry: TaskClassStep): string => entry.profile ? entry.entry : routeStepLabel(entry.step);
  /** The receipt for the wave's class: which step served it, or why none did. */
  const withClass = (route: ImplicitWorkerRoute): ImplicitWorkerRoute => {
    if (!walk) return route;
    const picked = route.resolved?.selection.taskClass;
    const decision = picked?.decision;
    const servedAt = picked?.outcome === "served" ? walk.steps.findIndex((entry) => entry.entry === picked.step) : -1;
    // With a ranking, a step that launched but ranked lower was not skipped; only steps that could not serve are named.
    const ranked = new Set(decision?.order.map((item) => item.entry));
    const heldOut = new Map((decision?.estimates ?? []).filter((item) => item.status !== "ranked").map((item) => [item.entry, item.cause ?? item.status] as const));
    const notUsed = servedAt < 0 ? walk.steps : decision ? walk.steps.filter((entry) => !ranked.has(entry.entry)) : walk.steps.slice(0, servedAt);
    const skipped = notUsed.map((entry) => `${classStepName(entry)}: ${heldOut.get(entry.entry) ?? classStepCause(entry)}`);
    const gate = walk.requiresTestGate ? { requiresTestGate: true as const } : {};
    const note = walk.note ? { note: walk.note } : {};
    const ranking = decision ? { decision } : {};
    const taskClass: TaskClassSelection = servedAt >= 0
      ? { name: walk.name, outcome: "served", step: picked!.step, ...gate, ...note, ...ranking,
          reason: boundedReason(decision && decision.mode !== "chain-order"
            ? `step ${servedAt + 1} of ${walk.steps.length} (${picked!.step}) launched as the ${decision.mode} pick, ranked on evidence${skipped.length > 0 ? `; not used: ${skipped.join(" | ")}` : ""}`
            : `step ${servedAt + 1} of ${walk.steps.length} (${picked!.step}) launched${skipped.length > 0 ? `; earlier steps: ${skipped.join(" | ")}` : ""}`, FALLBACK_REASON_LIMIT) }
      : { name: walk.name, outcome: "fallback", ...gate, ...note, ...ranking,
          reason: boundedReason(`no step of the class chain could launch (${skipped.join(" | ")}); the ${route.tier ? "Claude subscription tier" : "normal route"} ran`, FALLBACK_REASON_LIMIT) };
    return { ...route, taskClass };
  };
  try { first = await resolveNativeSelection(ctx, requested, dependencies, { skipRoute: step => skipStep(step, quota), quotaSnapshot: quota, ...(walk ? { taskClass: walk } : {}) }); } catch (error) { failure = error; }
  if (!first && !isDefaultChainExhausted(failure)) throw failure;
  if (first) {
    const step = stepOfSelection(first.selection);
    const gated = quotaProviderOf(step);
    // A route a profile `ensure` refusal already held out is left even when it is not router-gated (a profile
    // default can land on it again), by the same forced re-resolution an exhausted route gets.
    const refused = heldBlock(step);
    // An unmetered tier has no router meter to consult, so its launch is never gated by a router read
    // (its own 402/no-endpoint refusal is the only evidence it spent).
    if (refused === undefined && (gated === undefined || !isMeteredQuota(gated))) return withClass({ resolved: first, tried: [], causes: [] });
    if (gated !== undefined && isMeteredQuota(gated)) quota ??= await readQuota();
    const cause = refused ?? tierBlock(quota!, step);
    if (cause === undefined) {
      const earlier = first.selection.taskClass?.outcome === "served" ? [] : first.selection.chainRoutes?.slice(0, first.selection.chainRoutes.indexOf(routeOfStep(step))) ?? [];
      const causes = earlier.flatMap(route => {
        const slash = route.indexOf("/");
        const prior = { provider: route.slice(0, slash), id: route.slice(slash + 1) };
        // Keep the configured step so a skipped `onlyWhen` step names its condition, not a quota read.
        const configured = defaultWorkerChain(requested.requireImages === true).find((step) => step.provider === prior.provider && step.id === prior.id) ?? prior;
        const block = tierBlock(quota!, configured);
        return block === undefined ? [] : [`${routeStepLabel(configured)}: ${block}`];
      });
      return withClass({ resolved: first, tried: [], causes });
    }
    // The resolved route is out of quota: leave it, continue down the default chain.
    try {
      const next = await resolveNativeSelection(ctx, requested, dependencies, { forceDefaultChain: true, skipRoute: step => skipStep(step, quota), quotaSnapshot: quota });
      return withClass({ resolved: next, tried: [], causes: [`${routeStepLabel(step)}: ${cause}`] });
    } catch (error) {
      if (!isDefaultChainExhausted(error)) throw error;
      failure = error;
    }
  }
  quota ??= await readQuota();
  const exhausted = failure as NoChainRouteError;
  const paid = paidStepPredicate(ctx);
  const causes = exhausted.tried.map((step) =>
    `${routeStepLabel(step)}: ${tierBlock(quota!, step) ?? (policy.planOnly !== undefined && paid(step) ? planOnlyCause(policy) : "no authenticated route is available in this session and the reviewed route is not approved in ~/.pi/agent/paid-routes.json")}`);
  // A noClaude project never reaches the Claude tier: the walk ends here, once, naming every skipped step.
  if (policy.noClaude !== undefined) {
    throw new Error(`USAP implicit routing found no route that can launch this wave (${[...causes, `Claude subscription tier: ${noClaudeCause(policy)}`].join(" | ")}). No route was started and no fallback was selected; wait for the earliest return named above, or name a route explicitly.`);
  }
  const claudeBlock = claudeQuotaBlock(quota);
  const effortBlock = (() => {
    try { resolveClaudeCodeEffort(requested.thinking, requested.thinkingReason); return undefined; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })();
  // A tier worker launched without a pinned account would run on the parent's default login, which
  // the same snapshot may show cooling down while the other account is eligible: pin an eligible one.
  // The router's `select` is the authority at launch and can refuse an account its `status` row lists as eligible
  // (a lent plan's reserve floor, a stale snapshot). Walk the eligible accounts best-first and keep the first one
  // `select` accepts now, so an ineligible account is never picked while another one can launch.
  const pick: ClaudeAccountPick = claudeBlock !== undefined ? {} : await pickLaunchAccount(quota!, dependencies.accountCommand);
  const accountBlock = claudeBlock ?? pick.cause;
  if (accountBlock !== undefined || effortBlock !== undefined) {
    throw new Error(`USAP implicit routing found no route that can launch this wave (${[...causes,
      ...(accountBlock !== undefined ? [`Claude subscription tier: ${accountBlock}`] : []),
      ...(effortBlock !== undefined ? [`Claude subscription tier: ${effortBlock}`] : [])].join(" | ")}). ${fallThroughs.length > 0
      ? `The tier that launched was refused before any output (run ${fallThroughs.map((item) => item.runId).join(", ")}) and no further route was started; wait for a window to return or name a route explicitly.`
      : "No route was started and no fallback was selected; wait for a window to return or name a route explicitly."}`);
  }
  const tier = claudeFallbackTier({ tasks: requested.tasks, thinking: requested.thinking });
  if (!tier) {
    throw new Error(`USAP implicit routing found no route that can launch this wave (${causes.join(" | ")}). No Claude subscription tier is configured (claudeFallbackTier in ~/.config/ultraterm/routing.json), so no fallback was selected; wait for a window to return or name a route explicitly.`);
  }
  return withClass({ tier, tried: exhausted.tried, causes, ...(pick.account ? { claudeAccount: pick.account } : {}) });
}

/** The operator policy for the project this dispatch runs in (the parent's cwd, its repository, and the paths tasks own). */
const projectPolicyOf = (ctx: ExtensionContext, requested: UltratermSubagentsParams, dependencies: UltratermSubagentsDependencies): ProjectPolicy =>
  resolveProjectPolicy(ctx.cwd, requested.tasks.flatMap((task) => task.ownedPaths ?? []), dependencies.projectPolicyPath !== undefined ? { policyPath: dependencies.projectPolicyPath } : {});

/** True for a chain step on a paid metered route (not a subscription or local one): a planOnly project is never given one. */
function paidStepPredicate(ctx: ExtensionContext): (step: WorkerRouteStep) => boolean {
  return (step) => {
    try {
      const registry = ctx.modelRegistry;
      const model = (registry.getAll?.() ?? registry.getAvailable()).find((candidate) => candidate.provider === step.provider && candidate.id === step.id);
      return model !== undefined && !isSubscriptionOrLocalRoute(model, registry.isUsingOAuth(model));
    } catch { return false; }
  };
}

const taskLabel = (task: TaskRecord): string => task.label.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 40);

/** Cause-bearing text of one worker that failed before its first model output. */
function startupCause(task: TaskRecord): string {
  return `[${taskLabel(task)}] ${boundedReason(task.error ?? "failed before its first model output (no cause was recorded)", 400)}`;
}

/** Tasks that settled `failed` without ever receiving model output: the launch itself died. `turns`
 * cannot decide this (a Pi worker counts a turn when its request starts, and a first request that
 * fails with a 429 or an expired login still ends with turns >= 1); the worker's own first-output
 * signal does. A budget stop (`outcome`) is partial work, not a launch failure. */
function preFirstTurnFailures(run: RunRecord | undefined): TaskRecord[] {
  return (run?.tasks ?? []).filter((task) => task.state === "failed" && task.outputStarted !== true && task.outcome === undefined);
}

const SETTLED_TASK_STATES: readonly string[] = ["done", "failed", "aborted", "timed_out"];
/** How long a failed dispatch waits for the cancelled siblings to stop before it says so. */
const STARTUP_CANCEL_SETTLE_MS = 5_000;

/**
 * Hold a dispatch for at most `windowMs` while its launched workers reach their first model
 * output or fail. A task waiting for run width, session or machine capacity is not launching and is
 * not waited on. Resolves with the run as last seen; the caller decides what a failure means.
 */
async function awaitWorkerStartup(current: SessionRuntime, runId: string, windowMs: number, signal?: AbortSignal): Promise<RunRecord | undefined> {
  // Let the coordinator hand its first launch slots out: until then every task still reads
  // `queued`, which would be mistaken for "waiting on capacity".
  if (windowMs > 0) for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
  const inspect = () => {
    const run = current.coordinator.snapshot(runId);
    const waiting = (run?.tasks ?? []).some((task) => !SETTLED_TASK_STATES.includes(task.state) && task.state !== "queued"
      && task.launchQueue?.tier !== "machine" && task.outputStarted !== true);
    return { run, failed: preFirstTurnFailures(run), waiting };
  };
  const initial = inspect();
  // An already-aborted signal never fires its listener: return at once instead of holding the window.
  if (windowMs <= 0 || signal?.aborted || initial.failed.length > 0 || !initial.waiting) return Promise.resolve(initial.run);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      current.startupWatchers.delete(check);
      signal?.removeEventListener("abort", finish);
      resolve(current.coordinator.snapshot(runId));
    };
    const check = () => {
      const seen = inspect();
      if (seen.failed.length > 0 || !seen.waiting) finish();
    };
    current.startupWatchers.add(check);
    signal?.addEventListener("abort", finish, { once: true });
    timer = setTimeout(finish, windowMs);
  });
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

/**
 * A `/reload` replaces the extension instance inside the SAME process. Live
 * runtimes, retained leases and the last teardown warning are therefore
 * process-global: a successor instance must recognize its own predecessor's
 * lease and hand it over, never collide with it and degrade to memory-only.
 * Keyed by session owner, so a foreign session or process never matches.
 */
const LIVE_RUNTIMES = Symbol.for("ultraterm.usap.live-runtimes.v1");
function liveRuntimes(): Map<string, SessionRuntime> {
  const holder = globalThis as unknown as Record<symbol, Map<string, SessionRuntime> | undefined>;
  if (!holder[LIVE_RUNTIMES]) holder[LIVE_RUNTIMES] = new Map();
  return holder[LIVE_RUNTIMES]!;
}
const RETAINED_TEARDOWNS = Symbol.for("ultraterm.usap.retained-teardowns.v1");
function retainedTeardownRegistry(): RetainedTeardown[] {
  const holder = globalThis as unknown as Record<symbol, RetainedTeardown[] | undefined>;
  if (!holder[RETAINED_TEARDOWNS]) holder[RETAINED_TEARDOWNS] = [];
  return holder[RETAINED_TEARDOWNS]!;
}
const SHUTDOWN_WARNING_BOX = Symbol.for("ultraterm.usap.shutdown-warning.v1");
/** The host-side operations a predecessor closure forwards to after a handover. */
interface HostRedirect {
  flushCompletions(current: SessionRuntime): void;
  retryDelivery(current: SessionRuntime): void;
  persistTelemetry(current: SessionRuntime, run: RunRecord): void;
  setStatus(current: SessionRuntime, ctx?: ExtensionContext): void;
}
function shutdownWarningBox(): { current?: { at: number; owner: string; message: string } } {
  const holder = globalThis as unknown as Record<symbol, { current?: { at: number; owner: string; message: string } } | undefined>;
  if (!holder[SHUTDOWN_WARNING_BOX]) holder[SHUTDOWN_WARNING_BOX] = {};
  return holder[SHUTDOWN_WARNING_BOX]!;
}

/** The shipped skill that documents the dispatch tool; its catalog entry is hidden when the tool is not offered. */
export const USAP_SKILL_NAME = "ultraterm-subagent-protocol";

/** Tool calls in a row without a dispatch before the parent is reminded once to fan out independent parts. */
export const DELEGATION_NUDGE_AFTER = 40;
export const DELEGATION_NUDGE_TEXT =
  "[USAP] You have run many tool calls in a row without subagents. If any remaining part is independent of the rest " +
  "(another repo or file set, research, a review, a separate fix), dispatch it now with ultraterm_subagents in one " +
  "background wave and keep integrating here. If everything left is one tightly coupled change, continue.";

/** USAP workers load no extensions, so this never runs inside one. The operator can switch it off with STEAK_PI_DELEGATION_NUDGE=off. */
export function delegationNudgeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:0|off|false|no)$/i.test(env.STEAK_PI_DELEGATION_NUDGE ?? "");
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
  /** True between agent_end and the next agent_start: the agent loop has drained its queue, so a steer sent now stays queued in the agent. */
  runEnded: boolean;
  /** Steers sent after agent_end. Still queued in the agent (the host exposes no view of that queue), they must not be reclaimed. */
  lateSteers: Set<string>;
  /** Terminal hub observations and native receipts suppress future delivery. */
  acknowledgedCompletions: Set<string>;
  /** A rejected trigger is never attempted again for the same completion. */
  wakeAttempted: Set<string>;
  wakeParent: boolean;
  wakePending: boolean;
  flushingCompletions: boolean;
  deliveryRetry?: ReturnType<typeof setTimeout>;
  deliveryRetries: number;
  /** The host API of the instance that currently owns this runtime. A reload
   * handover rebinds it so telemetry and completion delivery use the live host. */
  hostPi: ExtensionAPI;
  /** Set only when a `/reload` shutdown parked this live runtime for its successor.
   * A concurrent duplicate instance never sees it and keeps degrading safely. */
  handedOver?: boolean;
  /** The extension instance (factory closure) that currently hosts this runtime. A
   * predecessor's worker callbacks still reference its own closure; those forward
   * to `redirect` (the host's operations) instead of acting on a stale host. */
  hostToken: object;
  redirect?: HostRedirect;
  store?: CheckpointStore;
  checkpointError?: string;
  checkpointHealth: PersistenceHealth;
  checkpointPending: Map<string, RunRecord>;
  /** Native receipts observed but not yet committed to the durable snapshot. */
  checkpointReceipts: Set<string>;
  checkpointStopping: Set<string>;
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
  /** Dispatches holding for a worker's first model output; called on every coordinator change. */
  startupWatchers: Set<() => void>;
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
  if (TURN_BUDGET_ERROR.test(task.error ?? "")) return "Turn budget reached — partial work retained";
  if (task.state === "timed_out") return "Time budget reached — partial work retained";
  if (task.state === "aborted") return "Cancelled";
  if (task.state === "failed") return "Needs attention — inspect diagnostics";
  if (task.state === "done") return "Finished — ready for parent verification";
  const steps: Record<string, string> = { read: "Reading assigned files", grep: "Searching source", find: "Finding source files", ls: "Inspecting files", edit: "Editing assigned files", write: "Writing assigned files", bash: "Running a command", compaction: "Managing context", retry: "Retrying the connection" };
  return task.currentTool ? steps[task.currentTool] : undefined;
}

/** Bounded UI labels/lifecycle only: never include goals, task prompts, output, or usage.
 * `role` and `label` name which leaf this is; `outcome: "partial"` marks a turn- or
 * time-budget stop, whose `state` stays failed/timed_out. A successful bounded resume
 * supersedes the partial attempt explicitly: the successor's done task carries
 * `supersedes` and the predecessor run carries `resumedAs` and, once every unfinished
 * task finished, `supersededBy`. Readers keep the latest record per runId. */
export function usapTelemetrySnapshot(run: RunRecord, links: RunLinks = {}) {
  return {
    version: USAP_TELEMETRY_VERSION,
    runId: run.id,
    ...(run.ownerSessionId ? { ownerSessionId: run.ownerSessionId } : {}),
    ...(run.ownerSessionFile ? { ownerSessionFile: run.ownerSessionFile } : {}),
    runState: run.state,
    ...(run.resumedFrom ? { resumedFrom: run.resumedFrom } : {}),
    ...(links.resumedAs ? { resumedAs: links.resumedAs } : {}),
    ...(links.supersededBy ? { supersededBy: links.supersededBy } : {}),
    ...(run.harness === undefined ? {} : { harness: run.harness }),
    ...(run.selection ? { selection: { ...run.selection }, model: run.model, thinkingLevel: run.thinkingLevel } : {}),
    tasks: run.tasks.map((task) => ({
      taskId: task.id,
      label: task.label.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80),
      role: task.role,
      state: task.state,
      ...(task.outcome ? {
        outcome: task.outcome,
        ...(task.partialReason ? { partialReason: task.partialReason } : {}),
        ...(task.partialSummary ? { partialSummary: task.partialSummary.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, PARTIAL_SUMMARY_LIMIT) } : {}),
      } : {}),
      ...(task.resumedFrom ? { resumedFrom: task.resumedFrom, ...(task.state === "done" ? { supersedes: task.resumedFrom } : {}) } : {}),
      ...(taskDetail(task) ? { detail: taskDetail(task) } : {}),
      ...(Number.isFinite(task.startedAt) && task.startedAt! >= 0 ? { startedAt: task.startedAt } : {}),
      ...(Number.isFinite(task.endedAt) && task.endedAt! >= 0 ? { endedAt: task.endedAt } : {}),
      ...(task.currentTool ? { currentTool: task.currentTool.slice(0, 80) } : {}),
      ...(task.providerAccount ? { providerAccount: { ...task.providerAccount } } : {}),
      ...(task.reviewFallback ? { reviewFallback: { ...task.reviewFallback } } : {}),
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
    role: task.role,
    state: task.state,
    ...(task.outcome ? {
      outcome: task.outcome,
      ...(task.partialReason ? { partialReason: task.partialReason } : {}),
      ...(task.partialSummary ? { partialSummary: task.partialSummary } : {}),
    } : {}),
    ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
    output: task.output,
    ...(task.error === undefined ? {} : { error: task.error }),
    ...(task.currentTool ? { currentTool: task.currentTool.slice(0, 80) } : {}),
    turns: task.turns,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    lastProgressAt: task.lastProgressAt,
    ...(task.launchQueue ? { launchQueue: { ...structuredClone(task.launchQueue),
      elapsedMs: Math.max(0, (task.endedAt ?? Date.now()) - task.launchQueue.since),
      remainingMs: Math.max(0, task.launchQueue.deadlineAt - (task.endedAt ?? Date.now())) } } : {}),
    ...(task.lastLaunchQueue ? { lastLaunchQueue: { ...structuredClone(task.lastLaunchQueue),
      elapsedMs: Math.max(0, (task.endedAt ?? Date.now()) - task.lastLaunchQueue.since),
      remainingMs: Math.max(0, task.lastLaunchQueue.deadlineAt - (task.endedAt ?? Date.now())) } } : {}),
    ...(taskDetail(task) ? { detail: taskDetail(task) } : {}),
    toolErrors: task.toolErrors ?? 0,
    toolSuccesses: task.toolSuccesses ?? 0,
    truncated: task.truncated,
    ...(task.subscriptionReceipt ? { subscriptionReceipt: structuredClone(task.subscriptionReceipt) } : {}),
    ...(task.profileEnsure ? { profileEnsure: { ...task.profileEnsure } } : {}),
  };
}

/** Create a stable, JSON-safe view without duplicating nested model usage. */
export function toRunView(run: RunRecord, links: RunLinks = {}): RunView {
  return {
    observedAt: Date.now(),
    runId: run.id,
    ...(run.ownerSessionId ? { ownerSessionId: run.ownerSessionId } : {}),
    ...(run.ownerSessionFile ? { ownerSessionFile: run.ownerSessionFile } : {}),
    goal: run.goal,
    state: run.state,
    model: run.model,
    ...(run.claudeAccount === undefined ? {} : { claudeAccount: run.claudeAccount }),
    ...(run.harness === undefined ? {} : { harness: run.harness }),
    ...(run.selection ? { selection: { ...run.selection } } : {}),
    thinkingLevel: run.thinkingLevel,
    background: run.background,
    createdAt: run.createdAt,
    ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
    totalTokens: run.usage.totalTokens,
    totalCost: run.usage.cost.total,
    tasks: run.tasks.map(taskView),
    ...(run.resumedFrom ? { resumedFrom: run.resumedFrom } : {}),
    ...(links.resumedAs ? { resumedAs: links.resumedAs } : {}),
    ...(links.supersededBy ? { supersededBy: links.supersededBy } : {}),
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
  const partial = run.tasks.filter((task) => task.outcome === "partial").length;
  return `USAP ${run.id}: ${done}/${run.tasks.length} settled · ${run.state}${partial ? ` · ${partial} partial` : ""}`;
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
export function reviewFallbackReceipt(run: RunRecord, directory?: string): string {
  if (!directory) return "";
  return run.tasks.filter(task => task.state === "done" && task.role === "reviewer" && task.reviewFallback !== undefined && task.reviewFallback.to !== "none")
    .map(task => `${routeLabel(parseRoute(task.reviewFallback!.to))} fallback review: USAP ${run.id} receipt=${directory}/${run.id}.json report=${task.id}`).join("\n");
}

const tierNameOf = (route: string): string => {
  // A route the catalog or an operator profile serves carries a readable name too (no release-time table).
  const model = claudeCodeRouteModel(route);
  return model === undefined ? route : claudeCodeModelName(model);
};

export function renderRunResult(run: RunRecord, limit = MAX_TOOL_CONTENT): string {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("render limit must be a non-negative integer");
  const independence = run.selection?.independence === "requires-opus"
    ? ` · ${tierNameOf(run.model)} tier: requires expert verification${run.selection.fallbackReason ? ` · ${run.selection.fallbackReason}` : ""}` : "";
  let text = `${renderRunProgress(run)}\nmodel ${run.model} · thinking ${run.thinkingLevel}${run.selection ? ` · ${run.selection.source}${run.selection.profile ? ` · ${run.selection.profile}` : ""}` : ""}${run.selection?.taskClass ? ` · class ${run.selection.taskClass.name} ${run.selection.taskClass.outcome}` : ""}${independence}`.slice(0, limit);
  let wasTruncated = false;
  for (const task of run.tasks) {
    // A budget stop is named explicitly (with its role) so it cannot be mistaken for a finished leaf.
    const partial = task.outcome ? ` · PARTIAL ${task.partialReason ?? "budget"} (${task.role}; not complete)` : "";
    const suffix = `${partial}${task.toolErrors ? ` · ${task.toolErrors} tool errors` : ""}${task.truncated ? " · worker output truncated" : ""}`;
    const error = task.error ? `\nerror: ${task.error}` : "";
    const apiReceipt = task.apiReceipt ? `\n${formatClaudeApiReceipt(task.apiReceipt)}` : "";
    const routeReceipt = task.reviewFallback ? `\nactual review route: ${task.reviewFallback.to} (automatic fallback: ${task.reviewFallback.reason}; not Opus approval)` : "";
    const accountReceipt = task.providerAccount ? `\naccount: ${task.providerAccount.label} (${task.providerAccount.provider}/${task.providerAccount.id}); lease=${task.providerAccount.lease}` : "";
    const retained = task.partialSummary ? `\nretained: ${task.partialSummary}` : "";
    const queue = task.launchQueue;
    const queued = queue ? `\nlaunch queue: ${queue.tier}/${queue.provider} · ${queue.reason} · ${Math.max(0, (task.endedAt ?? Date.now()) - queue.since)}ms elapsed` : "";
    const block = `\n\n[${task.label}] ${task.state}${suffix}${queued}${error}${retained}${routeReceipt}${apiReceipt}${accountReceipt}${task.subscriptionReceipt ? `\nClaude subscription: ${task.subscriptionReceipt.account ?? "inherited"}; namespace=${task.subscriptionReceipt.configMode}; identity=${task.subscriptionReceipt.identityHash}; preflight=verified; init=${task.subscriptionReceipt.attested.init ? "verified" : "unverified"}` : ""}\n${task.output || "(no output)"}`;
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
  const tasks = run.tasks.map((task) => task.outcome
    ? `${task.id}=${task.state}/PARTIAL(${task.partialReason ?? "budget"}, ${task.role} ${JSON.stringify(task.label.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 40))})`
    : `${task.id}=${task.state}`).join(", ");
  return `Background run ${run.id} finished: continue the parent task (integrate results, verify, release) before ending the turn.\n${renderRunProgress(run)}\n${tasks}`.slice(0, limit);
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
      harness: harnessOf(run.harness),
      profile: run.selection?.profile ?? null,
      thinking: run.thinkingLevel,
      background: run.background,
      ...(run.selection?.taskClass ? { taskClass: { ...run.selection.taskClass } } : {}),
      tasks: run.tasks.map((task) => ({
        label: task.label,
        ...(task.taskClass ? { taskClass: task.taskClass } : {}),
        role: task.role,
        mayEdit: task.mayEdit,
        allowBash: task.allowBash,
        ownedPaths: task.ownedPaths.length,
        readPaths: (task.readPaths ?? []).length,
        modelRoute: run.model,
        selectionSource: run.selection?.source ?? "unknown",
        ...(task.outcome ? { outcome: task.outcome } : {}),
        ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
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

interface ClaudeWorkerModule {
  createClaudeWorkerRunner: (options: ClaudeWorkerRunnerOptions) => WorkerRunner;
}

interface DshWorkerModule {
  createDshWorkerRunner: (options: DshWorkerRunnerOptions) => WorkerRunner;
}

/** Lazy so fake-runner registration and tests never initialize child resources.
 * One coordinator-facing runner; each run branches on its harness to the native
 * Pi lifecycle or the headless claude-code CLI lifecycle. Neither branch is an
 * alternate launcher: both settle through the same coordinator, checkpoint,
 * relay-namespace and telemetry boundaries. */
export function defaultWorkerRunner(
  relay: RelayBroker,
  workerRuntimes: Map<string, PiWorkerRuntime>,
  claudeSpawn?: ClaudeSpawn,
  accountCommand?: AccountCommand,
  sessionFactory?: PiWorkerSessionFactory,
  /** Durable admission for a `claude-code/<model>` run (pins, catalog and the operator's profiles). */
  claudeAdmit?: (route: string | undefined) => string | undefined,
  dshSpawn?: DshSpawn,
): WorkerRunner {
  let piRunner: Promise<WorkerRunner> | undefined;
  let claudeRunner: Promise<WorkerRunner> | undefined;
  let dshRunner: Promise<WorkerRunner> | undefined;
  return async (context) => {
    if (harnessOf(context.run.harness) === "steak-dsh") {
      dshRunner ??= import(resolveStagedModule("src/subagents/dsh-worker.ts").url)
        .then((module) => {
          const factory = (module as unknown as Partial<DshWorkerModule>).createDshWorkerRunner;
          if (typeof factory !== "function") {
            throw new Error("dsh-worker module does not export createDshWorkerRunner");
          }
          return factory({
            ...(dshSpawn ? { spawn: dshSpawn } : {}),
            resolveRuntime: (runId) => {
              const resolved = workerRuntimes.get(runId) as DshWorkerRuntime | undefined;
              if (!resolved?.dsh) throw new Error(`No frozen steak-dsh worker runtime for ${runId}`);
              return resolved;
            },
          });
        });
      const runner = await dshRunner.catch((error) => { dshRunner = undefined; throw error; });
      // Relay steering is unsupported on this harness: the hub refuses send/redirect for its runs,
      // and the runner never binds a relay peer. No review fallback applies either.
      return runner(context);
    }
    if (harnessOf(context.run.harness) === "claude-code") {
      claudeRunner ??= import(resolveStagedModule("src/subagents/claude-worker.ts").url)
        .then((module) => {
          const factory = (module as unknown as Partial<ClaudeWorkerModule>).createClaudeWorkerRunner;
          if (typeof factory !== "function") {
            throw new Error("claude-worker module does not export createClaudeWorkerRunner");
          }
          return factory({ relay, ...(claudeSpawn ? { spawn: claudeSpawn } : {}), accountCommand, ...(claudeAdmit ? { admit: claudeAdmit } : {}) });
        });
      const runner = await claudeRunner.catch((error) => { claudeRunner = undefined; throw error; });
      const result = await runner(context);
      if (!canFallbackReview(context.run, result, context.signal)) return result;
      const fallback = workerRuntimes.get(`${context.run.id}:review-fallback`);
      if (!fallback) return result;
      recordReviewFallback(context.task, result.reviewFallbackReason!);
      // A per-task view keeps sibling Claude routes and parent environment exact.
      const target = `${fallback.model.provider}/${fallback.model.id}`;
      const fallbackRun = { ...context.run, harness: "pi" as const,
        model: target, thinkingLevel: String(fallback.thinkingLevel),
        selection: { provider: fallback.model.provider, modelId: fallback.model.id, source: "override" as const, harness: "pi" as const, images: false, tools: true } };
      context.task.claudeSessionId = undefined;
      if (!context.task.mayEdit) context.task.allowBash = false;
      context.onProgress({ currentTool: `model-fallback:${target}` });
      const solResult = await runPi({ ...context, run: fallbackRun }, fallback);
      return { ...solResult, usage: addUsage(result.usage, solResult.usage), turns: result.turns + solResult.turns };
    }
    return runPi(context);
  };
  async function runPi(context: Parameters<WorkerRunner>[0], fallback?: PiWorkerRuntime) {
    if (fallback) {
      const module = await import(resolveStagedModule("src/subagents/pi-worker.ts").url);
      return module.createPiWorkerRunner({ relay, accountCommand, sessionFactory, resolveRuntime: () => fallback })(context);
    }
    piRunner ??= import(resolveStagedModule("src/subagents/pi-worker.ts").url)
      .then((module) => {
        const factory = (module as unknown as Partial<PiWorkerModule>).createPiWorkerRunner;
        if (typeof factory !== "function") {
          throw new Error("pi-worker module does not export createPiWorkerRunner");
        }
        return factory({
          relay,
          accountCommand,
          sessionFactory,
          resolveRuntime: (runId) => {
            const resolved = workerRuntimes.get(runId);
            if (!resolved) throw new Error(`No frozen Pi worker runtime for ${runId}`);
            return resolved;
          },
        });
      });
    const runner = await piRunner.catch((error) => { piRunner = undefined; throw error; });
    return runner(context);
  }
}

export function createUltratermSubagentsExtension(
  dependencies: UltratermSubagentsDependencies = {},
): (pi: ExtensionAPI) => void {
  // Validated once at construction: a bad value must never reach a live teardown.
  const shutdownGraceMs = shutdownGraceMsOrThrow(dependencies.shutdownGraceMs);
  const startupWindow = dependencies.startupWindowMs;
  if (startupWindow !== undefined && (!Number.isSafeInteger(startupWindow) || startupWindow < 0 || startupWindow > MAX_STARTUP_WINDOW_MS)) {
    throw new RangeError(`startupWindowMs must be a safe integer from 0 to ${MAX_STARTUP_WINDOW_MS}`);
  }
  return function ultratermSubagentsExtension(pi: ExtensionAPI): void {
    let runtime: SessionRuntime | undefined;
    setSubagentCountReader(() => runtime && !runtime.closed ? runtime.coordinator.activeRuns().length : 0);
    // A claude-code/<model> route is admitted from three sources, never a hard-coded model list: the
    // adapter's pinned routes, the Claude Code model catalog (shipped plus ids the CLI reports live) and
    // an operator-registered worker/launch profile that names it. Loaded lazily so a bad manifest fails
    // only where a route is decided.
    const claudeProfiles = () => dependencies.profiles ?? loadWorkerProfiles();
    const claudeAdmission = (model: string | undefined) => admitClaudeCodeRoute(model, claudeProfiles());
    /** The model id behind a route the durable admission serves, or undefined for a route it refuses. */
    const claudeAdmittedModel = (route: string | undefined): string | undefined => {
      const admission = claudeAdmission(route);
      return admission !== undefined && "model" in admission ? admission.model : undefined;
    };
    let clearedStatusUi: ExtensionContext["ui"] | undefined;
    // Replacements share leases with any late-disposing prior initialization.
    // Session-wide ceiling comes from usap-caps.json; each run stays capped at
    // MAX_CONCURRENCY by dispatch validation.
    const scheduler = dependencies.createScheduler?.() ?? new SessionScheduler();
    /** Teardowns whose workers had not settled at the bounded deadline. Their
     * checkpoint lease and live state stay retained (never force-released, never
     * stolen) until the real `coordinator.shutdown()` promise settles. */
    /** Identifies this factory instance as a runtime's host; a reload successor gets its own. */
    const instanceToken = {};
    /** A predecessor instance forwards to the current host when it no longer hosts a runtime. */
    const hostRedirectOf = (current: SessionRuntime): HostRedirect | undefined =>
      current.hostToken === instanceToken ? undefined : current.redirect;
    const retainedTeardowns = retainedTeardownRegistry();
    /** Survives the runtime it described so a successor session can report it. */
    const warningBox = shutdownWarningBox();

    const persistenceOf = (current: SessionRuntime): Persistence => current.store ? "checkpointed" : "memory-only";
    const sessionWarning = (current: SessionRuntime): string | undefined =>
      current.shutdownWarning ?? (warningBox.current?.owner === current.owner ? warningBox.current.message : undefined);

    const setStatus = (current: SessionRuntime, ctx?: ExtensionContext): void => {
      const host = hostRedirectOf(current);
      if (host) return host.setStatus(current, ctx);
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

    /** A run as this session can read it: live first, else recovered from its checkpoint. */
    const readRun = (current: SessionRuntime, runId: string): RunRecord | undefined => {
      const live = current.coordinator.snapshot(runId);
      if (live) return live;
      const saved = current.store?.get(runId);
      return saved ? recoveredRun(saved) : undefined;
    };

    /** Resume lineage lives in the checkpoint store. Only a settled run can have
     * been resumed, so live progress events never pay for the lookup. */
    const linksFor = (current: SessionRuntime, run: RunRecord): RunLinks => {
      if (run.state === "running") return {};
      const resumedAs = current.store?.get(run.id)?.resumedAs;
      if (!resumedAs) return {};
      const successor = readRun(current, resumedAs);
      const replaced = successor?.state === "done" && successor.tasks.every((task) => task.state === "done");
      return { resumedAs, ...(replaced ? { supersededBy: resumedAs } : {}) };
    };

    const persistTelemetry = (current: SessionRuntime, run: RunRecord): void => {
      const host = hostRedirectOf(current);
      if (host) return host.persistTelemetry(current, run);
      if (runtime !== current || !current.telemetryWritable || !ownsContext(current, current.statusContext)) return;
      const snapshot = usapTelemetrySnapshot(run, linksFor(current, run));
      const signature = JSON.stringify(snapshot);
      if (current.telemetrySignatures.get(run.id) === signature) return;
      try {
        // Pi's public action delegates to SessionManager.appendCustomEntry.
        // The bound host is the instance that owns the runtime now, so a reload
        // handover keeps telemetry on the live host instead of a stale one.
        current.hostPi.appendEntry(USAP_TELEMETRY_CUSTOM_TYPE, snapshot);
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
        current.workerRuntimes.delete(`${runId}:review-fallback`);
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
        saveCheckpoint(current, run, true, "final-shutdown");
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
      if (warningBox.current?.owner === entry.owner && !retainedTeardowns.some((other) => other.owner === entry.owner)) {
        warningBox.current = undefined;
      }
    };

    const releaseRuntimeUi = (current: SessionRuntime, ctx: ExtensionContext | undefined, warning?: string): void => {
      if (runtime !== current) return;
      runtime = undefined;
      subagentActivityChanged();
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
      const live = liveRuntimes();
      if (live.get(current.owner) === current) live.delete(current.owner);
      clearTimeout(current.deliveryRetry);
      // Snapshot before shutdown changes active tasks into ordinary cancellations.
      for (const run of current.coordinator.list()) {
        saveCheckpoint(current, run, true, "host-shutdown");
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
        current.telemetryWritable = false;
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
      current.telemetryWritable = false;
      warningBox.current = { at: Date.now(), owner: current.owner, message: RETAINED_LEASE_WARNING };
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
          warningBox.current = { at: Date.now(), owner: current.owner, message };
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

    const checkpointFailed = (current: SessionRuntime, run: RunRecord, error: unknown, stage: string): void => {
      const cause = current.checkpointHealth.failed(run.id, error, stage);
      if (stage === "initial") {
        // No producer was admitted: a later snapshot-only retry must not invent live work.
        run.state = "aborted";
        run.endedAt = Date.now();
        for (const task of run.tasks) {
          task.state = "aborted";
          task.endedAt = run.endedAt;
          task.error = "Initial checkpoint failed; worker was never launched";
        }
      }
      current.checkpointPending.set(run.id, run);
      current.checkpointError = `Checkpoint ${stage} failed (${cause.code}${cause.syscall ? `/${cause.syscall}` : ""}); recovery is not guaranteed — hub diagnose`;
      try { if (ownsContext(current, current.statusContext)) current.statusContext?.ui.setStatus("usap-checkpoint", current.checkpointError); } catch { /* Observation only. */ }
      // Reuse per-run cancellation: retain done siblings and wait for native disposal.
      // Recursive lifecycle observations must not repeatedly cancel the same run.
      if (current.coordinator.has(run.id) && run.state === "running" && !current.checkpointStopping.has(run.id)) {
        current.checkpointStopping.add(run.id);
        current.coordinator.cancel(run.id, undefined, current.checkpointError);
      }
    };
    const saveCheckpoint = (current: SessionRuntime, run: RunRecord, force: boolean, stage: string, propagate = false): void => {
      if (!current.store) return;
      let failureStage = stage;
      try {
        const written = current.store.save(run, force || current.checkpointHealth.needsSave(run.id));
        if (written) {
          if (current.checkpointReceipts.has(run.id)) {
            failureStage = "receipt";
            current.store.markDelivered(run.id);
            current.checkpointReceipts.delete(run.id);
          }
          // A saved snapshot alone cannot validate a failed receipt commit.
          current.checkpointHealth.saved(run.id);
          current.checkpointPending.delete(run.id);
          if (!current.checkpointHealth.blocked) {
            current.checkpointError = undefined;
            try { current.statusContext?.ui.setStatus("usap-checkpoint", undefined); } catch { /* Observation only. */ }
          }
        }
      } catch (error) {
        checkpointFailed(current, run, error, failureStage);
        if (propagate) throw new Error(current.checkpointError);
      }
    };

    /** Record durably that a run's completion has been delivered some other way (a dispatch that threw its
     * cause): without it a reload would queue that run's completion again. A failed write is retried with
     * the next successful save, like every other receipt. */
    const markDeliveredDurably = (current: SessionRuntime, runId: string): void => {
      current.acknowledgedCompletions.add(runId);
      current.completionBuffer = current.completionBuffer.filter((item) => item.runId !== runId);
      current.awaitingReceipt.delete(runId);
      if (!current.store) return;
      current.checkpointReceipts.add(runId);
      try {
        current.store.markDelivered(runId);
        current.checkpointReceipts.delete(runId);
      } catch (error) {
        const run = readRun(current, runId);
        if (run) checkpointFailed(current, run, error, "receipt");
      }
    };

    /** A degraded runtime must never launch work that only exists in memory: the
     * operator would have no durable recovery path. Chat, list and diagnose stay
     * available read-only until the live owner releases the lease. */
    const assertDurableForNewWork = (current: SessionRuntime, action = "New dispatch"): void => {
      if (current.store && current.checkpointHealth.blocked) {
        // Retry pending snapshots and receipts only, never worker execution.
        for (const [id, pending] of current.checkpointPending) {
          saveCheckpoint(current, current.coordinator.snapshot(id) ?? pending, true, "retry", true);
        }
      }
      if (!current.checkpointHealth.blocked && (current.store || !current.checkpointDegraded)) return;
      throw new Error(`${action} is refused: ${current.checkpointError ?? "this session cannot own its durable checkpoint store"}. A run started now could not be resumed; hub list and hub diagnose stay read-only.`);
    };

    /** A reload handover: the reloaded instance takes over the predecessor's
     * live runtime (store, coordinator, relay, workers) for the SAME session.
     * Nothing is claimed twice and no running worker is cancelled. */
    const adoptRuntime = (parked: SessionRuntime, ctx: ExtensionContext): SessionRuntime => {
      runtime = parked;
      parked.hostPi = pi;
      parked.handedOver = false;
      // This instance now hosts the runtime; the predecessor's callbacks forward here.
      parked.hostToken = instanceToken;
      parked.redirect = {
        flushCompletions: (c) => flushCompletions(c),
        retryDelivery: (c) => retryDelivery(c),
        persistTelemetry: (c, run) => persistTelemetry(c, run),
        setStatus: (c, ctx) => setStatus(c, ctx),
      };
      parked.statusContext = ctx;
      parked.agentIdle = ctx.isIdle?.() ?? true;
      parked.telemetryWritable = true;
      liveRuntimes().set(parked.owner, parked);
      setStatus(parked, ctx);
      reclaimLostSteers(parked);
      flushCompletions(parked);
      return parked;
    };

    const ensureRuntime = (ctx: ExtensionContext): SessionRuntime => {
      const owner = sessionOwner(ctx);
      if (!owner) throw new Error("USAP requires a native session identity; access refused.");
      const [ownerSessionId, ownerSessionFile] = JSON.parse(owner) as [string, string | null];
      // A predecessor instance of this same session (a /reload in this process,
      // with or without a shutdown event) may still own the live runtime and its
      // checkpoint lock. Adopt it instead of claiming a second store.
      if (!runtime || runtime.closed) {
        const parked = liveRuntimes().get(owner);
        if (parked && !parked.closed && parked.handedOver) return adoptRuntime(parked, ctx);
      }
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
      // The profile `ensure` hook wraps whichever runner serves the run, so Pi and claude-code workers get it alike.
      const runner = withProfileEnsure(dependencies.createRunner?.(pi, relay)
        ?? defaultWorkerRunner(relay, workerRuntimes, dependencies.claudeSpawn, dependencies.accountCommand, undefined, claudeAdmittedModel, dependencies.dshSpawn),
      dependencies.ensureExec ? { exec: dependencies.ensureExec } : {});
      const coordinator = new SubagentCoordinator(runner, {
        scheduler,
        now: dependencies.now,
        sessionDir: () => store?.sessionsDirectory,
        // Each settled task of a classed wave leaves its evidence; a reply that comes back empty is retried once with
        // a higher output budget, then moves to the next ranked route the dispatch froze for this run.
        onTaskSettled: (run, task) => { recordSettledTask(evidenceStoreOf(dependencies), run, task, (dependencies.now ?? Date.now)()); },
        replyPolicy: (run, task) => {
          const receipt = run.selection?.taskClass;
          const classed = receipt !== undefined && receipt.outcome === "served" && task.taskClass === receipt.name;
          // An implicit (non-explicit-route) wave continues a content-filter refusal
          // on its next configured route at any point, in the same worker session.
          // An explicit route never reroutes, so it gets no policy at all.
          const implicit = run.selection?.source !== undefined && run.selection.source !== "override";
          if (!classed && !implicit) return undefined;
          const alternates = (workerRuntimes.get(run.id)?.alternates ?? []).map((item) => `${item.model.provider}/${item.model.id}`);
          if (!classed && alternates.length === 0) return undefined;
          const retryMaxTokens = classed ? configuredTaskClass(receipt!.name)?.retryMaxTokens : undefined;
          // The empty-reply boost retry stays a classed-run contract; an implicit
          // wave without a class only gains the content-filter continuation.
          return { ...(retryMaxTokens !== undefined ? { maxTokens: retryMaxTokens } : {}), alternates, ...(classed ? {} : { emptyReplyRetry: false }) };
        },
        onChange: (run) => {
          if (!created || created.closed) return;
          subagentActivityChanged();
          saveCheckpoint(created, run, run.state !== "running", "lifecycle");
          if (run.state !== "running") created.checkpointStopping.delete(run.id);
          persistTelemetry(created, run);
          setStatus(created);
          for (const watcher of [...created.startupWatchers]) {
            try { watcher(); } catch { /* a startup observer never owns execution */ }
          }
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
        hostPi: pi,
        hostToken: instanceToken,
        statusContext: ctx,
        closed: false,
        completionBuffer: [],
        awaitingReceipt: new Set(),
        runEnded: false,
        lateSteers: new Set(),
        acknowledgedCompletions: new Set(),
        wakeAttempted: new Set(),
        // Captured per native session; batch hosts can opt out before startup.
        wakeParent: !/^(0|false|off)$/i.test((process.env.STEAK_USAP_WAKE_PARENT ?? "").trim()),
        wakePending: false,
        flushingCompletions: false,
        deliveryRetries: 0,
        store,
        checkpointHealth: new PersistenceHealth(),
        checkpointPending: new Map(),
        checkpointReceipts: new Set(),
        checkpointStopping: new Set(),
        checkpointDegraded: claim.degraded,
        checkpointCollision: claim.collision,
        checkpointError: claim.error,
        readOnlyCheckpoints: () => readOnlyCheckpointsFor(owner),
        shutdownWarning: warningBox.current?.owner === owner ? warningBox.current.message : undefined,
        attachStore: (candidate: CheckpointStore, adoptCtx?: ExtensionContext) => adoptStore(candidate, adoptCtx),
        // Tools can initialize the runtime after agent_start already fired.
        agentIdle: ctx.isIdle?.() ?? true,
        startupWatchers: new Set(),
      };
      runtime = created;
      liveRuntimes().set(owner, created);
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
        current.workerRuntimes.delete(`${runId}:review-fallback`);
        persistTelemetry(current, run);
        // A successful resume explicitly supersedes the partial attempt it continued.
        if (run.resumedFrom) {
          const predecessor = readRun(current, run.resumedFrom);
          if (predecessor) persistTelemetry(current, predecessor);
        }
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
        if (binding.background && !current.acknowledgedCompletions.has(run.id)) {
          current.completionBuffer.push({ runId: run.id, text: [renderCompletionMessage(run), reviewFallbackReceipt(run, current.store?.directory)].filter(Boolean).join("\n") });
          // Let completions from the same coordinator tick (and terminal hub
          // observations) coalesce before submitting a single wake.
          queueMicrotask(() => flushCompletions(current));
        }
      }).catch((error: unknown) => {
        if (current.closed) return;
        current.workerRuntimes.delete(runId);
        current.workerRuntimes.delete(`${runId}:review-fallback`);
        setStatus(current);
        reconcileRetainedBindings(current);
        if (!current.bindings.get(runId)?.background || current.acknowledgedCompletions.has(runId)) return;
        current.completionBuffer.push({ runId, text:
          `Background run ${runId} finished: continue the parent task (integrate results, verify, release) before ending the turn.\nUSAP ${runId} infrastructure failure: ${error instanceof Error ? error.message : String(error)}`
            .slice(0, MAX_COMPLETION_MESSAGE),
        });
        queueMicrotask(() => flushCompletions(current));
      });
      return completion;
    };

    // Short, bounded retries bridge SDK idle/append transitions without polling
    // throughout a long task or re-submitting an accepted wake.
    const retryDelivery = (current: SessionRuntime): void => {
      const host = hostRedirectOf(current);
      if (host) return host.retryDelivery(current);
      if (current.closed || !ownsContext(current, current.statusContext) || current.deliveryRetry) return;
      if (current.deliveryRetries >= 20) {
        // A busy parent receives a steer only when its current step ends (a long tool call can take minutes), so a missing
        // receipt mid-turn is a normal wait, not a lost delivery (2026-10-30: slot 4 showed "unconfirmed" during a long bash
        // call). turn_end and agent_settled re-check receipts; only an idle parent with no receipt is really unconfirmed.
        if (current.agentIdle) {
          try { current.statusContext?.ui.setStatus("usap-delivery", "USAP delivery unconfirmed — results remain in hub status"); } catch { /* Observation only. */ }
        }
        return;
      }
      current.deliveryRetries += 1;
      current.deliveryRetry = setTimeout(() => {
        current.deliveryRetry = undefined;
        flushCompletions(current);
      }, 100);
      current.deliveryRetry.unref?.();
    };

    /** At a boundary where a queued steer must have landed or been dropped (agent_settled, session adopt; not turn_end:
     * the host's hasPendingMessages() does not count an extension steer in the agent queue), a completion still awaiting a receipt was dropped by the host (Escape, clearQueue, an aborted tool
     * call; 2026-11-08 run-f40a1335). Forget it so the next flush re-sends it and may wake the parent again; observed
     * receipts are honored first, so nothing is delivered twice. */
    const reclaimLostSteers = (current: SessionRuntime): void => {
      if (!current.awaitingReceipt.size) return;
      const observed = observedCompletionIds(current.statusContext) ?? new Set<string>();
      for (const id of [...current.awaitingReceipt]) {
        if (observed.has(id) || current.lateSteers.has(id)) continue;
        current.awaitingReceipt.delete(id);
        current.wakeAttempted.delete(id);
      }
    };

    /** Busy completions steer into the current turn. Idle background completions
     * request at most one new turn per flush; receipts prevent repeat delivery. */
    const flushCompletions = (current: SessionRuntime): void => {
      const host = hostRedirectOf(current);
      if (host) return host.flushCompletions(current);
      if (runtime !== current || current.closed || !ownsContext(current, current.statusContext) || current.flushingCompletions) return;
      if (current.agentIdle && current.statusContext?.isIdle && !current.statusContext.isIdle()) {
        retryDelivery(current);
        return;
      }
      current.flushingCompletions = true;
      try {
        const acknowledge = (ids: Set<string>): void => {
          for (const id of ids) {
            if (current.completionBuffer.some((item) => item.runId === id)) markDeliveredDurably(current, id);
          }
        };
        acknowledge(observedCompletionIds(current.statusContext) ?? new Set());
        current.completionBuffer = current.completionBuffer.filter((item) => !current.acknowledgedCompletions.has(item.runId) && !current.store?.get(item.runId)?.delivered);
        let wakeUsed = false;
        while (current.completionBuffer.some((item) => !current.awaitingReceipt.has(item.runId))) {
          const batch: typeof current.completionBuffer = [];
          let used = 0;
          for (const item of current.completionBuffer) {
            if (current.awaitingReceipt.has(item.runId)) continue;
            if (used + item.text.length + 2 > MAX_COMPLETION_MESSAGE && batch.length > 0) break;
            batch.push(item);
            used += item.text.length + 2;
          }
          const message = {
            customType: "ultraterm-subagents-complete",
            content: batch.map((item) => item.text).join("\n\n").slice(0, MAX_COMPLETION_MESSAGE),
            display: true,
            details: { ownerSessionId: current.ownerSessionId, ownerSessionFile: current.ownerSessionFile, coalesced: batch.length, omitted: 0, runIds: batch.map((item) => item.runId),
              runs: batch.flatMap((item) => {
                const saved = current.store?.get(item.runId);
                const run = current.coordinator.snapshot(item.runId) ?? (saved ? recoveredRun(saved) : undefined);
                return run ? [{ ...toRunView(run, linksFor(current, run)), goal: "", tasks: run.tasks.map((task) => ({ ...taskView(task), output: "", ...(task.error ? { error: taskDetail(task) } : {}) })) }] : [];
              }),
            },
          };
          const triggerTurn = current.agentIdle && current.wakeParent && !current.wakePending && !wakeUsed
            && batch.some((item) => !current.wakeAttempted.has(item.runId));
          if (triggerTurn) {
            wakeUsed = true;
            current.wakePending = true;
            // Include overflow chunks so even a rejected trigger followed by a
            // passive retry cannot turn one coalesced flush into multiple wakes.
            for (const item of current.completionBuffer) current.wakeAttempted.add(item.runId);
          }
          try {
            // Pi treats triggerTurn:false as deferred passive append even when
            // busy. Omit it then: native steer joins the current run, never starts
            // a new one; only an idle parent gets an explicit wake request.
            current.hostPi.sendMessage(message, current.agentIdle
              ? { deliverAs: "steer", triggerTurn }
              : { deliverAs: "steer" });
          } catch {
            if (!triggerTurn) { retryDelivery(current); return; }
            current.wakePending = false;
            // A host may append before throwing: honor that receipt, otherwise
            // fall back to the old passive path, with bounded passive-only retries.
            const observed = observedCompletionIds(current.statusContext) ?? new Set<string>();
            acknowledge(observed);
            if (!batch.every((item) => observed.has(item.runId))) {
              try { current.hostPi.sendMessage(message, { deliverAs: "steer", triggerTurn: false }); }
              catch { retryDelivery(current); return; }
            }
          }
          for (const item of batch) {
            if (current.acknowledgedCompletions.has(item.runId)) continue;
            current.awaitingReceipt.add(item.runId);
            if (current.runEnded) current.lateSteers.add(item.runId);
          }
          // Do not manufacture a receipt for hosts that queue submissions.
          acknowledge(observedCompletionIds(current.statusContext) ?? new Set());
        }
        if (current.completionBuffer.length) retryDelivery(current);
        else {
          clearTimeout(current.deliveryRetry);
          current.deliveryRetry = undefined;
          current.deliveryRetries = 0;
          try { current.statusContext?.ui.setStatus("usap-delivery", undefined); } catch { /* Observation only. */ }
        }
      } finally { current.flushingCompletions = false; }
    };

    pi.registerMessageRenderer?.("ultraterm-subagents-complete", (message, options, theme) => {
      const details = message.details as { runs?: RunView[] } | undefined;
      const runs = details?.runs ?? [];
      return renderSubagentResult({ content: [{ type: "text", text: typeof message.content === "string" ? message.content : "Subagents settled" }], details: runs.length === 1 ? { run: runs[0] } : { runs } }, options, theme);
    });

    // Per-turn route availability: what is up, what is cooling until when, and the next usable route, so a parent
    // never pins a dead account. One router read per cache window; any failure leaves the prompt untouched.
    let availabilityCache: { at: number; key: string; line: string } | undefined;
    pi.on("before_agent_start", async (event, ctx) => {
      // A session run without the dispatch tool (--exclude-tools, --tools) cannot delegate: it gets neither the
      // per-turn route notice nor the catalog entry that tells it to read the delegation skill first.
      if (!toolIsOffered(pi, "ultraterm_subagents")) {
        const systemPrompt = hideSkill(event.systemPrompt, USAP_SKILL_NAME);
        return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
      }
      try {
        const now = dependencies.now?.() ?? Date.now();
        const key = ctx.cwd;
        if (!availabilityCache || availabilityCache.key !== key || now - availabilityCache.at >= AVAILABILITY_TTL_MS) {
          const chain = defaultWorkerChain(false);
          const tier = routingConfigOrEmpty().claudeFallbackTier?.ordinary;
          let line = "";
          if (chain.length > 0 || tier !== undefined) {
            const snapshot = await readProviderQuota(dependencies.accountCommand, now);
            const policy = resolveProjectPolicy(ctx.cwd, [], dependencies.projectPolicyPath !== undefined ? { policyPath: dependencies.projectPolicyPath } : {});
            // The tier being up means a PINNED launch can take an eligible account. An unpinned claude-code route
            // runs on this session's own login, so the line names it when the router proves that login spent (J-3759).
            const loginAccount = claudeLoginBlock(snapshot, dependencies.env ?? process.env);
            const login = loginAccount === undefined ? undefined : { label: loginAccount.account.label, cause: loginAccount.cause,
              ...(loginAccount.account.resetAt !== undefined ? { returnsAt: loginAccount.account.resetAt } : {}) };
            line = computeAvailability({ snapshot, chain, ...(tier !== undefined ? { claudeTier: tier } : {}), policy, isPaid: paidStepPredicate(ctx), ...(login !== undefined ? { login } : {}) }).line;
          }
          availabilityCache = { at: now, key, line };
        }
        if (availabilityCache.line) return { systemPrompt: `${event.systemPrompt}\n\n${availabilityCache.line}` };
      } catch { /* availability is advisory; the dispatch itself still checks the router */ }
      return undefined;
    });

    pi.on("session_start", async (_event, ctx) => {
      if (!sessionOwner(ctx)) throw new Error("USAP requires a native session identity; access refused.");
      if (runtime && !runtime.closed && ownsContext(runtime, ctx)) {
        runtime.statusContext = ctx;
        setStatus(runtime, ctx);
        reclaimLostSteers(runtime);
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
      // The hub only acts on existing runs: expose it when this session has
      // checkpointed or live runs, otherwise after the first dispatch.
      if (deferredToolsEnabled()) {
        const hasRuns = current.coordinator.list().length > 0 || (current.store?.list().length ?? 0) > 0;
        setToolActive(pi, "ultraterm_hub", hasRuns);
        if (hasRuns) signalStart(pi, "dispatch runs");
      }
    });

    pi.on("tool_result", (event) => {
      if (event.toolName === "ultraterm_subagents") setToolActive(pi, "ultraterm_hub", true);
    });

    // Delegation nudge (2026-11-04: the operator found parents doing long serial work that independent subagents could have
    // run in parallel). A parent that has run many tool calls in a row without dispatching gets one short reminder per run.
    // Inert inside USAP workers (they never delegate) and when the operator turns it off.
    let serialCalls = 0;
    let nudged = false;
    pi.on("agent_start", () => { serialCalls = 0; nudged = false; });
    pi.on("turn_end", (event: any) => {
      if (delegationNudgeDisabled()) return;
      const names = (event?.toolResults ?? []).map((r: any) => r?.toolName ?? "");
      if (names.includes("ultraterm_subagents") || names.includes("ultraterm_hub")) { serialCalls = 0; return; }
      serialCalls += names.length;
      if (nudged || serialCalls < DELEGATION_NUDGE_AFTER) return;
      nudged = true;
      try {
        pi.sendMessage({ customType: "usap-delegation-nudge", display: false, content: DELEGATION_NUDGE_TEXT }, { deliverAs: "steer" });
      } catch { /* a host that cannot take a steer keeps working; the nudge is advisory */ }
    });

    pi.on("agent_start", async (_event, ctx) => {
      if (runtime && ownsContext(runtime, ctx)) { runtime.statusContext = ctx; runtime.agentIdle = false; runtime.wakePending = false; runtime.runEnded = false; runtime.lateSteers.clear(); }
    });

    pi.on("agent_end", async (_event, ctx) => {
      if (runtime && ownsContext(runtime, ctx)) runtime.runEnded = true;
    });

    // A steer queued while the parent was busy lands at a step boundary: confirm its receipt there instead of waiting for the
    // whole run to settle, and clear any stale delivery status.
    pi.on("turn_end", async (_event, ctx) => {
      if (!runtime || runtime.closed || !ownsContext(runtime, ctx) || !runtime.completionBuffer.length) return;
      runtime.statusContext = ctx;
      runtime.deliveryRetries = 0;
      flushCompletions(runtime);
    });

    pi.on("agent_settled", async (_event, ctx) => {
      if (!runtime || runtime.closed || !ownsContext(runtime, ctx)) return;
      runtime.statusContext = ctx;
      runtime.agentIdle = true;
      runtime.deliveryRetries = 0;
      reclaimLostSteers(runtime);
      flushCompletions(runtime);
    });

    const leaveSession = async (event: { reason?: string } | undefined, ctx: ExtensionContext) => {
      if (runtime && !ownsContext(runtime, ctx)) return;
      const current = runtime;
      // A reload in this process is a handover, not a teardown: with workers still
      // running, the runtime (store, coordinator, relay) stays live and parked in
      // the process-global registry so the reloaded instance adopts it. Without
      // workers the ordinary settled teardown releases the checkpoint lock.
      if (event?.reason === "reload" && current && !current.closed && current.coordinator.activeRuns().length > 0) {
        clearTimeout(current.deliveryRetry);
        current.deliveryRetry = undefined;
        current.handedOver = true;
        releaseRuntimeUi(current, ctx);
        return;
      }
      await destroyRuntime(ctx);
    };
    // Before-switch/fork hooks are cancellable and precede SDK validation.
    // Shutdown is the committed boundary, while the outgoing context is still valid.
    pi.on("session_shutdown", leaveSession);

    /**
     * One dispatch attempt. An implicit routine wave whose launched worker is refused on a provider
     * quota or usage limit before any worker produced output does not throw: it returns the failed tier
     * so `execute` can re-run the same tasks on the next one. Everything else returns the tool result or
     * throws, exactly as a single dispatch always did.
     */
    const dispatchWave = async (rawParams: unknown, signal: AbortSignal | undefined, onUpdate: RunBinding["onUpdate"], ctx: ExtensionContext, fallThroughs: readonly QuotaFallThrough[]) => {
      let requested = rawParams as UltratermSubagentsParams;
      // A profile that is a claude-code/<model> route (steak-pi/haiku-5-5, steak-pi/sonnet-5-5, ...) is that
      // subscription route: resolve it before any native selection, which cannot serve it.
      if (requested.profile !== undefined && requested.model === undefined) {
        const claude = claudeCodeRouteOfProfile(requested.profile, claudeProfiles());
        if (claude && "refused" in claude) throw new Error(claude.refused);
        // A profile id is not a subscription selector for claudeAccount, except the harness-qualified steak-pi/<short> form.
        if (claude && requested.claudeAccount !== undefined && !requested.profile.startsWith("steak-pi/")) {
          throw new Error("claudeAccount requires an explicit Claude subscription harness or exact model; Pi, API and profile routes are refused");
        }
        if (claude) requested = { ...requested, profile: undefined, model: claude.route };
      }
      // A steak-dsh route selects that harness before any native selection: an explicit
      // `harness: "steak-dsh"` with an inner `provider/model`, or an exact
      // `steak-dsh/<provider>/<model-id>` model. Explicit routes never fall back.
      if (requested.harness === "steak-dsh" || (requested.harness === undefined && requested.model !== undefined && requested.model.startsWith(DSH_ROUTE_PREFIX))) {
        if (requested.profile !== undefined) {
          throw new Error("USAP harness steak-dsh runs only an exact steak-dsh/<provider>/<model-id> route; profile selectors are refused, and no fallback was selected.");
        }
        if (requested.claudeAccount !== undefined) {
          throw new Error("claudeAccount selects a Claude subscription account and does not apply to harness steak-dsh, which runs on an API key; no run was started and no fallback was selected.");
        }
        if (requested.model === undefined) {
          throw new Error("USAP harness steak-dsh requires model <provider>/<model-id> (or steak-dsh/<provider>/<model-id>); no default steak-dsh route is configured, so no run was started and no fallback was selected.");
        }
        let inner = dshRouteModel(requested.model);
        if (inner === undefined) {
          if (requested.model.startsWith(DSH_ROUTE_PREFIX)) throw new Error(dshRouteShapeRefusal(requested.model));
          try { inner = parseRoute(requested.model, "model"); }
          catch { throw new Error(dshRouteShapeRefusal(requested.model)); }
        }
        requested = { ...requested, harness: "steak-dsh", model: dshRouteOf(inner) };
      }
      const startupWindowMs = dependencies.startupWindowMs ?? DEFAULT_STARTUP_WINDOW_MS;
      // Do not let a mixed implicit wave silently bypass the configured review
      // standard or spend expert quota on routine implementation leaves.
      if (requested.claudeAccount !== undefined) {
        assertKnownClaudeAccount(requested.claudeAccount);
        const routeAdmission = claudeAdmission(requested.model);
        if (requested.profile !== undefined || (requested.harness !== undefined && requested.harness !== "claude-code")
          || (requested.model !== undefined ? (routeAdmission === undefined || "refused" in routeAdmission) : requested.harness !== "claude-code")) {
          throw new Error("claudeAccount requires an explicit Claude subscription harness or exact model; Pi, API and profile routes are refused");
        }
      }
      const implicitRoute = requested.claudeAccount === undefined && requested.harness === undefined && requested.model === undefined && requested.profile === undefined;
      const hasReviewer = requested.tasks.some((task) => task.role === "reviewer");
      const allReviewers = requested.tasks.length > 0 && requested.tasks.every((task) => task.role === "reviewer");
      if (implicitRoute && hasReviewer && !allReviewers) {
        throw new Error("Mixed worker/reviewer waves need an explicit route; split routine workers from the review wave. No fallback was selected.");
      }
      // Explicit Pi/model/profile selections win; only implicit all-reviewer
      // waves select the operator's implicit review CLI route (`implicitReview.route`)
      // automatically. Without one they resolve the native reviewer chain like any role default.
      const reviewRoute = implicitReviewRoute();
      if (implicitRoute && allReviewers && reviewRoute !== undefined) {
        const reviewAdmission = claudeAdmission(reviewRoute);
        if (reviewAdmission === undefined || "refused" in reviewAdmission) {
          throw new Error(`~/.config/ultraterm/routing.json implicitReview.route: ${reviewRoute} is not a claude-code adapter route (${reviewAdmission !== undefined && "refused" in reviewAdmission ? reviewAdmission.refused : "not a claude-code/… route"}); no fallback was selected.`);
        }
      }
      const opusReviewDefault = implicitRoute && allReviewers && reviewRoute !== undefined;
      // A fallback may change the harness only for permission-free reviewers.
      // Keep privileged leaves on Claude so exact path admission and reviewer
      // shell denial cannot be bypassed when its subscription is unavailable.
      const fallbackStep = reviewFallbackStep();
      const fallbackRoute = fallbackStep ? routeOfStep(fallbackStep) : undefined;
      // opusReviewDefault requires an implicit route (no caller pin, harness, model or profile), so a pinned review never
      // reaches the review fallback: the operator's pin is kept and a refusal on it is reported, not rerouted.
      const readOnlyReviewFallback = opusReviewDefault && fallbackStep !== undefined && isReadOnlyReviewWave(requested.tasks);
      // The configured review fallback is required for a wave this call is already retrying: the first attempt was
      // the Claude review route, refused before any output.
      const reviewFallThrough = fallThroughs.find((item) => item.kind === "review");
      if (reviewFallThrough !== undefined && (fallbackRoute === undefined || !readOnlyReviewFallback || requested.requireImages === true)) {
        throw new Error(`USAP implicit review fallback cannot run: ${reviewFallThrough.cause}. The configured implicitReview.fallback serves only read-only text review waves (${fallbackRoute ?? "no implicitReview.fallback is configured"}); name a review route explicitly.`);
      }
      // One router `status` read per dispatch, taken only where a route decision needs it. An
      // unreadable router is "unknown" and never proves exhaustion.
      let quotaRead: Promise<QuotaSnapshot> | undefined;
      const readQuota = (): Promise<QuotaSnapshot> => quotaRead ??= readProviderQuota(dependencies.accountCommand, dependencies.now?.());
      // A permission-free review asks the router: that is the wave the configured fallback may take, so its launch
      // evidence decides whether Claude is available at all, and it pins the account it runs on. A privileged review
      // keeps exactly its old route (the fallback would bypass its exact path admission and shell denial).
      const reviewReadOnly = isReadOnlyReviewWave(requested.tasks);
      const reviewQuota = opusReviewDefault && reviewFallThrough === undefined && reviewReadOnly ? await readQuota() : undefined;
      // A noClaude project's implicit review never runs on the Claude review route: it takes the configured review
      // fallback when it can, and otherwise refuses once, before anything starts.
      const reviewPolicy = opusReviewDefault ? projectPolicyOf(ctx, requested, dependencies) : {};
      // Keyed on the policy itself: a review quota is read for every read-only review, so it can never prove the
      // noClaude refusal was already decided. An image review or a review with no fallback has no quota-backed path.
      if (reviewPolicy.noClaude !== undefined && (reviewQuota === undefined || requested.requireImages === true || fallbackStep === undefined || !readOnlyReviewFallback)) {
        throw new Error(`USAP implicit review cannot run: Claude review route ${reviewRoute}: ${noClaudeCause(reviewPolicy)}${fallbackStep === undefined ? " | no implicitReview.fallback is configured" : requested.requireImages === true ? " | the review fallback serves only read-only text reviews, never an image review" : " | the review fallback serves only read-only text reviews"}. No review was started and no fallback was selected; name a review route explicitly.`);
      }
      const claudeTierBlock = reviewPolicy.noClaude !== undefined ? noClaudeCause(reviewPolicy) : reviewQuota ? claudeQuotaBlock(reviewQuota) : undefined;
      // The review route pins an eligible account, exactly like an implicit worker wave's Claude tier: without a
      // pin the CLI runs on the parent's own login, which the same snapshot may show at 100% while another account
      // is eligible, so the tier read "up" and the launch still died (J-3759).
      const reviewPick = reviewQuota !== undefined && reviewPolicy.noClaude === undefined && claudeTierBlock === undefined
        ? await pickLaunchAccount(reviewQuota, dependencies.accountCommand) : undefined;
      // No account could be pinned. Only a login the router PROVES spent makes Claude unavailable for a text
      // review; an unknown or busy account proves nothing and stays a launch-time question. An image review keeps
      // its old path (the fallback never serves images), so the same evidence cannot move it.
      const reviewTextFallback = readOnlyReviewFallback && requested.requireImages !== true;
      const reviewLogin = reviewTextFallback && reviewQuota !== undefined && claudeTierBlock === undefined && reviewPick?.account === undefined
        ? claudeLoginBlock(reviewQuota, dependencies.env ?? process.env) : undefined;
      const claudeBlock = reviewTextFallback ? claudeTierBlock ?? reviewLogin?.cause : undefined;
      const claudeUnavailable = claudeBlock !== undefined;
      const claudeUnavailableReason: "no-eligible-claude" | "quota" = claudeTierBlock === undefined && reviewLogin !== undefined ? "quota" : "no-eligible-claude";
      // A wave whose Claude review route already refused before any output runs its configured fallback here.
      const forcedReviewFallback = reviewFallThrough !== undefined;
      if (!ctx.model) throw new Error("ultraterm_subagents requires a resolved current model");
      if (claudeUnavailable) {
        // The review fallback may launch on a reserved router account: refuse now, naming both
        // causes, instead of dying at launch after `Started`.
        const fallbackBlock = routeQuotaBlock(reviewQuota!, fallbackStep!);
        if (fallbackBlock !== undefined) {
          throw new Error(`USAP implicit review cannot run: Claude subscription tier: ${claudeBlock} | ${routeStepLabel(fallbackStep!)} review fallback: ${fallbackBlock}. No review was started and no fallback was selected; wait for a window to return or name a route explicitly.`);
        }
      }
      // Quota-aware default route for an implicit routine text wave (the configured chain, then the
      // configured Claude tier). A Claude Code CLI route is not a Pi provider, so it cannot be a step of the Pi chain
      // and is reached here instead, only when the default chain cannot launch, never past a
      // proven-ineligible Claude account and never on the paid claude-code-api route. Explicit
      // selections stay exact; an image wave takes the same walk over multimodalWorkerChain.
      let nativeResolved: NativeSelection | undefined;
      let claudeTier: ClaudeFallbackTier | undefined;
      let tierTried: readonly WorkerRouteStep[] = [];
      let quotaCauses: string[] = [];
      let tierAccount: ImplicitWorkerRoute["claudeAccount"];
      // An implicit image wave takes the same quota walk as a text wave, over `multimodalWorkerChain`, then
      // the Claude tier (every Claude model reads staged images natively). Only task classes stay text-only.
      const quotaRouted = implicitRoute && !hasReviewer;
      const textRouted = quotaRouted && requested.requireImages !== true;
      // Task classes steer only an implicit text worker wave, and a wave runs one route: two configured classes
      // in one wave are refused here, before any approval, checkpoint or worker exists.
      // Operator taskClassRules (routing.json) classify an implicit text wave's tasks that name no class, so routine subagent and bot
      // work reaches the routes measured best for it without every caller naming one. Explicit classes and routes always win.
      const inferredClasses = textRouted ? applyInferredTaskClasses(requested.tasks) : { tasks: requested.tasks, inferred: [] };
      if (inferredClasses.inferred.length) requested = { ...requested, tasks: inferredClasses.tasks };
      const waveClasses = analyzeWaveClasses(requested.tasks, { refuseConflict: textRouted });
      const classWalk = textRouted && waveClasses.active
        ? resolveTaskClassWalk(waveClasses.active.name, waveClasses.active.config, dependencies.profiles ?? loadWorkerProfiles(),
          { store: evidenceStoreOf(dependencies), ...(dependencies.rng ? { rng: dependencies.rng } : {}), ...(dependencies.now ? { now: dependencies.now } : {}) })
        : undefined;
      let taskClassReceipt: TaskClassSelection | undefined;
      if (quotaRouted) {
        const route = await resolveImplicitWorkerRoute(ctx, requested, dependencies, readQuota, fallThroughs, classWalk, projectPolicyOf(ctx, requested, dependencies));
        nativeResolved = route.resolved;
        claudeTier = route.tier;
        tierTried = route.tried;
        quotaCauses = route.causes;
        tierAccount = route.claudeAccount;
        taskClassReceipt = route.taskClass;
      }
      if (taskClassReceipt === undefined) {
        taskClassReceipt = ignoredTaskClass(waveClasses, !implicitRoute
          ? "a task class steers only an implicit wave; this dispatch named a model, profile, harness or Claude account, which stays exact"
          : hasReviewer ? "a task class steers only text worker waves; reviewer waves keep their own route"
          : requested.requireImages === true ? "a task class steers only text worker waves; image waves keep their own chain"
          : waveClasses.skipped !== undefined ? `task class ${waveClasses.declared[0]} does not steer this wave because ${waveClasses.skipped}; the normal route ran`
          : `task class ${waveClasses.declared.join(", ")} is not configured in ~/.config/ultraterm/routing.json taskClasses, so the normal route ran`);
      }
      const claudeWorkerTier = claudeTier !== undefined;
      // The Claude account this launch pins: the worker tier's pick, or the review route's (never the parent's own login).
      // An operator's pinned claudeAccount is never replaced by an automatic pick, and a pinned review never falls
      // back to another route: the pin was the operator's choice, so a refusal on it is reported, not rerouted.
      const pickedAccount = requested.claudeAccount !== undefined ? undefined : (tierAccount ?? reviewPick?.account);
      // An implicit review wave whose Claude route was refused before output runs the same tasks on the
      // configured fallback within this same call, instead of failing the wave with one cause.
      const reviewFallbackActive = claudeUnavailable || forcedReviewFallback;
      const params: UltratermSubagentsParams = {
        ...requested,
        ...(pickedAccount ? { claudeAccount: pickedAccount.id } : {}),
        ...(reviewFallbackActive ? { harness: "pi" as const, model: fallbackRoute, thinking: "high" as const, thinkingReason: forcedReviewFallback
          ? "Automatic expert text review fallback after the Claude review route was refused before any output."
          : "Automatic expert text review fallback after proven Claude unavailability." } : {}),
        // A model naming either Claude adapter route selects that harness, so an unserved claude-code/<model>
        // route reaches the admission gate (which names every source) instead of the native registry.
        ...((!reviewFallbackActive && opusReviewDefault || claudeWorkerTier || (requested.harness === undefined && (claudeCodeRouteModel(requested.model) !== undefined || CLAUDE_API_ROUTES.includes(requested.model ?? "")))) ? { harness: "claude-code" as const } : {}),
      };
      // A Claude Code run takes the dispatch's own effort and medium when it names none; low, max and
      // an unexplained high/xhigh are refused here, before any approval, checkpoint or worker exists.
      const claudeEffort = params.harness === "claude-code" ? resolveClaudeCodeEffort(params.thinking, params.thinkingReason) : undefined;
      const dshHarness = params.harness === "steak-dsh";
      const dshEffort = dshHarness ? resolveDshEffort(params.thinking, params.thinkingReason) : undefined;
      const current = ensureRuntime(ctx);
      // Never launch a run this session could not recover from its durable store.
      assertDurableForNewWork(current);
      const persistence = persistenceOf(current);
      const persistenceNote = current.store
        ? ""
        : `USAP checkpoints are unavailable in this session (${current.checkpointError ?? "no native session file"}): this run is memory-only and cannot be resumed.\n`;
      // The review fallback may launch on a reserved router account too: when the router proves every
      // such account unavailable it is not installed (a Claude quota/auth failure would only trade one
      // refusal for another after `Started`), and the dispatch says so.
      const reviewFallbackBlock = reviewTextFallback && reviewQuota && !claudeUnavailable ? routeQuotaBlock(reviewQuota, fallbackStep!) : undefined;
      const reviewFallbackSkipNote = reviewFallbackBlock !== undefined
        ? `Review note: the ${routeStepLabel(fallbackStep!)} review fallback is unavailable (${reviewFallbackBlock}); a Claude quota or auth failure ends this review without falling back.\n` : "";
      // The wave this call is retrying says so, and names why the first attempt died: a parent reading only the
      // result needs both causes, not just the second route's.
      const reviewFallThroughNote = forcedReviewFallback
        ? `Review fallback: the Claude review route ${reviewFallThrough!.route} was refused ${reviewFallThrough!.reviewReason === "auth" ? "on authentication" : "on the Claude usage limit"} before any output; the same review tasks run on the configured implicitReview.fallback ${fallbackRoute} inside this same call, with no parent re-dispatch.\n` : "";
      const tierName = claudeTier ? claudeCodeModelName(claudeTier.model) : "";
      const fallThroughReason = fallThroughs.length > 0 ? `automatic fall-through after ${fallThroughCause(fallThroughs)}; ` : "";
      const fallThroughNote = fallThroughs.length > 0
        ? `Fall-through: ${fallThroughSummary(fallThroughs)}. The same tasks were re-run here on the next tier, with no parent re-dispatch.\n` : "";
      const routeNote = fallThroughNote + reviewFallThroughNote + taskClassNote(taskClassReceipt, waveClasses) + (claudeTier
        ? `Route note: none of ${tierTried.map(routeStepLabel).join(", ")} could launch (${quotaCauses.join(" | ")}), so this implicit wave runs ${claudeTier.route} at ${claudeEffort} effort (subscription) on the ${tierName} tier: ${claudeTier.reason}. `
          + `Claude account: ${tierAccount ? `${tierAccount.label} (an eligible account in the router snapshot, the least used)` : "the parent's own Claude login (the router listed no Claude account to pin)"}. `
          + `${tierName} work needs verification: review it with an expert reviewer wave${reviewRoute ? ` (all-reviewer waves default to model ${reviewRoute})` : ""}.\n`
        : nativeResolved && quotaCauses.length > 0
          ? `Route note: ${quotaCauses.join(" | ")}; this implicit wave continues down the default chain on ${nativeResolved.model.provider}/${nativeResolved.model.id}.\n`
          : "") + reviewFallbackSkipNote;
      // Foreign-harness routing happens before native selection: the claude-code
      // CLI route is explicit and fixed, and the native Pi registry is never
      // consulted for it (it cannot resolve, and must not appear to).
      const foreignHarness = params.harness === "claude-code";
      // steak-dsh admission: the inner registry model must pass the SAME policy checks a Pi-native
      // route passes, plus the harness gates (API-key login, resolved executable). Named refusals only.
      let dshModel: NonNullable<ExtensionContext["model"]> | undefined;
      if (dshHarness) {
        if (params.requireImages === true) {
          throw new Error("USAP harness steak-dsh does not support image input; dispatch an image wave on Pi or claude-code. No fallback was selected.");
        }
        const dshPolicy = projectPolicyOf(ctx, requested, dependencies);
        const approve = dshPolicy.planOnly !== undefined ? () => false : (dependencies.approvePaidRoute ?? AUTOMATIC_CHAIN_APPROVAL);
        dshModel = await admitDshRoute(params.model, ctx.modelRegistry, { approvePaidRoute: approve, env: dependencies.env ?? process.env });
        // A project that may not use Claude may not reach it through this harness either.
        if (dshPolicy.noClaude !== undefined && (dshModel.provider === "claude-code" || dshModel.provider === "anthropic" || /^claude[-_]/i.test(dshModel.id) || /(^|\/)claude[-_]/i.test(dshModel.id))) {
          throw new Error(`USAP explicit route ${params.model} cannot launch: ${noClaudeCause(dshPolicy)}. No worker was started and no fallback was selected.`);
        }
        const innerStep = { provider: dshModel.provider, id: dshModel.id };
        const cause = quotaProviderOf(innerStep) === undefined ? undefined : routeQuotaBlock(await readQuota(), innerStep);
        if (cause !== undefined) {
          throw new Error(`USAP explicit route ${params.model} cannot launch: ${cause}. Explicit routes are never rerouted, so no worker was started and no fallback was selected; wait for the window to return or choose another route yourself.`);
        }
      }
      // A named route is admitted from its three sources (never a hard-coded list): the pinned routes,
      // the provider catalog and an operator profile. The refusal names all three.
      if (foreignHarness && params.profile !== undefined) {
        throw new Error(`USAP harness claude-code runs only ${CLAUDE_CODE_ROUTES.join(" or ")} (subscription), or the explicitly approved ${CLAUDE_API_ROUTES.join(" or ")}; other model/profile selectors are refused.`);
      }
      if (foreignHarness && params.model !== undefined && !CLAUDE_API_ROUTES.includes(params.model)) {
        const admission = claudeAdmission(params.model);
        if (admission === undefined || "refused" in admission) {
          throw new Error(admission !== undefined && "refused" in admission ? admission.refused
            : `USAP harness claude-code runs only ${CLAUDE_CODE_ROUTES.join(" or ")} (subscription), or the explicitly approved ${CLAUDE_API_ROUTES.join(" or ")}; other model/profile selectors are refused.`);
        }
      }
      // The operator's claudeCodeDefaults pick the Claude model a defaulted wave runs; an implicit
      // review wave runs implicitReview.route. The automatic quota tier names its own route.
      // The API route is never a default: only an exact, explicit model names it.
      const claudeRoute = foreignHarness ? params.model ?? (claudeTier ? claudeTier.route : opusReviewDefault ? reviewRoute! : defaultClaudeCodeRoute(params.tasks)) : undefined;
      const apiRoute = foreignHarness && isClaudeApiRoute(claudeRoute);
      const claudeModel = apiRoute ? claudeApiModelOf(claudeRoute) : claudeAdmittedModel(claudeRoute);
      // A read-only reviewer never gets a shell on Claude. Refuse a requested shell here, at dispatch, so the parent
      // sees the refusal before any checkpoint or worker exists (the run-time withhold alone is silent to the parent).
      const namedClaude = requested.harness === "claude-code" || claudeCodeRouteModel(requested.model) !== undefined || CLAUDE_API_ROUTES.includes(requested.model ?? "");
      if (foreignHarness && namedClaude && params.tasks.some((task) => isClaudeReadOnlyReview(task) && task.allowBash === true)) {
        const labels = params.tasks.filter((task) => isClaudeReadOnlyReview(task) && task.allowBash === true).map((task) => JSON.stringify(task.label)).join(", ");
        throw new Error(`${CLAUDE_REVIEW_SHELL_REFUSED}: allowBash was requested for read-only reviewer ${labels} on the claude-code harness. Read-only reviewers get Read, Grep and Glob only, so no run was started and no fallback was selected. Stage git evidence in the task text or under the run cwd, or drop allowBash from the reviewer.`);
      }
      if (foreignHarness && !apiRoute && claudeModel === undefined) {
        throw new Error(`USAP harness claude-code could not admit ${claudeRoute ?? "the configured Claude Code default"}; no run was started and no fallback was selected.`);
      }
      // Operator approval, settings contract and budget are checked before any
      // checkpoint, relay peer or worker exists; the runner re-checks at every launch.
      const apiAdmission = apiRoute
        ? admitClaudeApiRoute({ route: claudeRoute, taskCount: params.tasks.length, roles: params.tasks.map((task) => task.role ?? "worker"), requireImages: params.requireImages === true }, dependencies.now ? { now: dependencies.now } : {})
        : undefined;
      if (apiRoute) params.concurrency = claudeApiConcurrency(params.concurrency, params.tasks.length);
      if (foreignHarness && params.requireImages === true && !apiRoute) assertClaudeCodeImageAdmission(claudeRoute, claudeAdmittedModel);
      const piResolved = foreignHarness || dshHarness
        ? undefined
        : nativeResolved ?? await resolveNativeSelection(ctx, params, dependencies);
      if (piResolved && !implicitRoute) {
        // An explicit route stays exact: never rerouted, but never launched into a provider the
        // router has proven exhausted either. The refusal names the router's own cause.
        const step = stepOfSelection(piResolved.selection);
        const cause = quotaProviderOf(step) === undefined ? undefined : routeQuotaBlock(await readQuota(), step);
        if (cause !== undefined) {
          throw new Error(`USAP explicit route ${routeOfStep(step)} cannot launch: ${cause}. Explicit routes are never rerouted, so no worker was started and no fallback was selected; wait for the window to return or choose another route yourself.`);
        }
      }
      if (foreignHarness && !apiRoute && !implicitRoute && claudeTier === undefined && params.claudeAccount === undefined) {
        // An explicit Claude subscription route is held to the same rule as a native one: never rerouted, but never launched
        // into a subscription the router has proven exhausted or ineligible. (A pinned claudeAccount is the operator's choice.)
        // A route that pins nothing runs on THIS session's own Claude login, so that login is the account the router must
        // prove launchable: the whole-tier verdict once said "up" because another account was eligible while the login
        // itself was at 100%, and the dispatch died at the CLI with one cause (J-3759).
        const snapshot = await readQuota();
        const tierCause = claudeQuotaBlock(snapshot);
        const loginCause = tierCause === undefined ? claudeLoginBlock(snapshot, dependencies.env ?? process.env)?.cause : undefined;
        const cause = tierCause ?? loginCause;
        if (cause !== undefined) {
          throw new Error(`USAP explicit route ${claudeRoute} cannot launch: ${cause}. Explicit routes are never rerouted, so no worker was started and no fallback was selected; wait for the window to return, pin an eligible claudeAccount, or choose another route yourself.`);
        }
      }
      let reviewFallbackRuntime: PiWorkerRuntime | undefined;
      if (readOnlyReviewFallback && !reviewFallbackActive && requested.requireImages !== true && reviewFallbackBlock === undefined) {
        try {
          const sol = await resolveNativeSelection(ctx,
            { ...requested, harness: "pi", model: fallbackRoute, profile: undefined, thinking: "high", thinkingReason: "Automatic expert text review fallback after proven Claude unavailability." }, dependencies);
          reviewFallbackRuntime = { model: sol.model, thinkingLevel: sol.thinkingLevel };
        } catch { /* Claude may still succeed; an unavailable fallback is not a route substitute. */ }
      }
      // A class-ranked winner may be a harness-qualified steak-dsh step: the run's harness comes from
      // the step, its model string stays the verbatim route, and its effort maps the resolved thinking.
      const classedDsh = piResolved?.selection.harness === "steak-dsh";
      const dshSelection: ModelSelection | undefined = dshHarness && dshModel
        ? { provider: dshModel.provider, modelId: dshModel.id, source: "override" as const, harness: "steak-dsh" as const, images: false, tools: true }
        : undefined;
      const resolvedSelection = piResolved ? piResolved.selection : dshSelection ?? (apiRoute ? resolveClaudeApiSelection(claudeModel!) : resolveClaudeCodeSelection(claudeModel!));
      const resolvedThinking = piResolved
        ? (classedDsh ? dshEffortOf(String(piResolved.thinkingLevel)) : String(piResolved.thinkingLevel))
        : dshHarness ? dshEffort! : claudeEffort!;
      const model = dshHarness ? params.model!
        : foreignHarness ? claudeRoute!
        : classedDsh ? dshRouteOf({ provider: piResolved!.model.provider, id: piResolved!.model.id })
        : `${piResolved!.model.provider}/${piResolved!.model.id}`;
      const thinking = resolvedThinking;
      // The dispatch note names the harness whenever it is not Pi.
      const harnessNote = (dshHarness || classedDsh)
        ? `Harness note: this wave runs on the steak-dsh harness (the DSH headless CLI) on ${model}; relay steering (hub send/redirect) and resume are unsupported on this harness in v1.\n`
        : "";
      const input: DispatchInput = {
        ...params,
        ...(classedDsh ? { harness: "steak-dsh" as const } : {}),
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

      // An account the pick walk already had the router's `select` accept moments ago is not asked twice.
      if (run.claudeAccount !== undefined && !(pickedAccount !== undefined && pickedAccount.id === run.claudeAccount)) {
        try { await resolveClaudeAccount(run.claudeAccount, dependencies.accountCommand); }
        catch (error) {
          // The account came from the router snapshot a moment ago: if the router now refuses it, say which and why.
          if (!pickedAccount) throw error;
          throw new Error(`USAP implicit routing picked ${pickedAccount.label} for the ${claudeTier ? `${tierName} tier` : "review route"}, but the router would not select it now (${boundedReason(error instanceof Error ? error.message : String(error), 200)}). ${fallThroughs.filter((item) => item.kind !== "review").length > 0
            ? `No further worker was started after the earlier tier was refused (${fallThroughSummary(fallThroughs)}); retry or name a route explicitly.`
            : "No worker was started and no fallback was selected; retry or name a route explicitly."}`);
        }
      }
      if (apiAdmission) stampClaudeApiRun(run, apiAdmission);
      run.selection = { ...resolvedSelection,
        // The Claude worker tier records the steps that were really tried, then the tier itself,
        // so a receipt shows exactly why it was reached; its work needs an expert verification.
        // It also names the tier chosen and why (cheapest capable model) beside the router causes.
        ...(claudeTier ? { source: "chain" as const, chainRoutes: [...tierTried.map(routeOfStep), claudeRoute!], independence: "requires-opus" as const,
          fallbackReason: boundedReason(`${fallThroughReason}${tierName}: ${claudeTier.reason}${tierAccount ? `; Claude account ${tierAccount.label}` : ""}; ${quotaCauses.join(" | ")}`, FALLBACK_REASON_LIMIT) } : {}),
        ...(!claudeTier && quotaCauses.length > 0 ? { fallbackReason: boundedReason(`${fallThroughReason}${quotaCauses.join(" | ")}`, FALLBACK_REASON_LIMIT) } : {}),
        // No route was requested for an implicit review wave: a fallback review chosen only because no Claude
        // account was eligible is an automatic fallback, never an operator-requested override.
        ...(opusReviewDefault ? { source: reviewFallbackActive ? "automatic-review-fallback" as const : "automatic-review" as const, automaticReview: true, reviewRequiresImages: requested.requireImages === true,
          ...(reviewPick?.account !== undefined ? { accountAutomatic: true as const } : {}) } : {}),
        ...(taskClassReceipt ? { taskClass: taskClassReceipt } : {}) };
      if (reviewFallbackActive) for (const task of run.tasks) recordReviewFallback(task, forcedReviewFallback
        ? reviewFallThrough!.reviewReason ?? "quota" : claudeUnavailableReason);
      if (reviewFallbackRuntime) current.workerRuntimes.set(`${run.id}:review-fallback`, Object.freeze(reviewFallbackRuntime));
      run.ownerSessionId = current.ownerSessionId;
      run.ownerSessionFile = current.ownerSessionFile;
      // An Esc during this tier's router reads (quota status, Claude account select) must not still
      // launch it: nothing is saved or started for a cancelled dispatch.
      if (signal?.aborted) {
        throw new Error(fallThroughs.length > 0
          ? `USAP dispatch cancelled before the fall-through to the next tier launched (${fallThroughs.map((step) => step.cause).join("; ")}).`
          : "USAP dispatch cancelled before any worker launched.");
      }
      // Never launch a supposedly durable run whose initial checkpoint failed.
      saveCheckpoint(current, run, true, "initial", true);
      // Foreign-harness runs have no frozen Pi runtime: their runner branches on
      // run.harness and never consults the Pi registry or the relay workers. A steak-dsh run freezes
      // its inner registry model plus Pi's own auth resolution instead (the runner re-checks at launch).
      if (dshHarness || classedDsh) {
        const dshRegistry = dshHarness ? ctx.modelRegistry : piResolved!.registry;
        const innerModel = dshHarness ? dshModel! : piResolved!.model;
        current.workerRuntimes.set(run.id, Object.freeze({
          model: Object.freeze({ ...innerModel }),
          thinkingLevel: thinking as PiWorkerRuntime["thinkingLevel"],
          dsh: Object.freeze({
            ...(typeof dshRegistry.getApiKeyAndHeaders === "function"
              ? { resolveAuth: (model: NonNullable<ExtensionContext["model"]>) => dshRegistry.getApiKeyAndHeaders!(model) }
              : {}),
            isUsingOAuth: (model: NonNullable<ExtensionContext["model"]>) => dshRegistry.isUsingOAuth(model),
          }),
        }) as PiWorkerRuntime);
      } else if (!foreignHarness) {
        current.workerRuntimes.set(run.id, Object.freeze({
          model: Object.freeze({ ...(piResolved!.model) }),
          thinkingLevel: piResolved!.thinkingLevel,
          ...(piResolved!.alternates?.length ? { alternates: Object.freeze(piResolved!.alternates.map((item) => Object.freeze({ entry: item.entry, model: Object.freeze({ ...item.model }), thinkingLevel: item.thinkingLevel }))) } : {}),
        }) as PiWorkerRuntime);
      }
      // Both native Pi and stream-json Claude children share run-local relay identities.
      current.relay.createRun(run.id, [PARENT_RELAY_ID, ...run.tasks.map((task) => task.id)]);
      const parent = current.relay.bindSender(run.id, PARENT_RELAY_ID);
      let started: RunRecord;
      try {
        started = current.coordinator.start(run);
      } catch (error) {
        parent.close();
        current.relay.cleanupRun(run.id);
        current.workerRuntimes.delete(run.id); current.workerRuntimes.delete(`${run.id}:review-fallback`);
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
      setStatus(current, ctx);

      // A worker that dies before its first model output (router refusal, auth, route, spawn, a first
      // request that errors) makes this dispatch fail with its named cause, background or not:
      // `Started` is never reported for a worker already known dead. Each launched worker gets a
      // bounded window to produce that first output.
      // The completion handler attaches only afterwards, so a failed dispatch never also queues a
      // background completion message.
      // The explicit paid claude-code-api route keeps its own settled-result contract instead: its
      // receipts ride in the settled result, never in a thrown error.
      const startedRun = await awaitWorkerStartup(current, run.id, apiRoute ? 0 : startupWindowMs, signal);
      const startupFailures = apiRoute ? [] : preFirstTurnFailures(startedRun);
      if (startupFailures.length > 0) {
        // The thrown error is the one notification: no completion message follows it, in this
        // process (binding.background) or after a reload (the durable receipt: adoptStore queues a
        // background run whose checkpoint is not marked delivered). Siblings are cancelled so no
        // half-started wave is left running unseen; the record names every cause.
        binding.background = false;
        markDeliveredDurably(current, run.id);
        binding.completion = attachCompletion(current, run.id);
        current.coordinator.cancel(run.id, undefined, `Run cancelled: ${startupFailures.map((task) => `worker ${task.id}`).join(", ")} failed before its first model output`);
        const settled = await current.coordinator.wait(run.id, "all", { timeoutMs: STARTUP_CANCEL_SETTLE_MS }).catch(() => current.coordinator.snapshot(run.id));
        const final = settled ?? startedRun;
        const causes = preFirstTurnFailures(final);
        // Only what the settled snapshot shows may be claimed: a sibling that had not stopped inside
        // the settle wait is named, not reported as cancelled.
        const stillRunning = (final?.tasks ?? []).filter((task) => !SETTLED_TASK_STATES.includes(task.state));
        const aftermath = stillRunning.length === 0
          ? `The run record is ${final?.state ?? "failed"} with these causes and no worker is left running.`
          : `Cancellation was requested for the whole run, but ${stillRunning.map((task) => `[${taskLabel(task)}]`).join(", ")} had not stopped within ${STARTUP_CANCEL_SETTLE_MS} ms and may still be shutting down; the run record is still ${final?.state ?? "running"} (inspect it with ultraterm_hub status ${run.id}).`;
        const failureText = (causes.length > 0 ? causes : startupFailures).map(startupCause).join(" | ");
        // An implicit wave refused on a provider quota or usage limit before any output moves to the next
        // configured tier instead of failing: only for a router-gated Pi tier, only once per
        // tier, only when the whole run settled (so nothing can still be running or have written), and
        // never after the operator aborted. An explicit route, the Claude tier and every non-quota failure
        // (auth, route, spawn) fall through to the error below.
        const reached = quotaRouted && !claudeWorkerTier && stillRunning.length === 0 && !signal?.aborted && fallThroughs.length < MAX_QUOTA_FALL_THROUGHS
          ? quotaFallThroughProviders(final ?? startedRun, startupFailures) : undefined;
        if (reached) return { fallThrough: { runId: run.id, route: model, providers: reached, cause: boundedReason(failureText, 240) } satisfies QuotaFallThrough };
        // A profile `ensure` hook that refused every launch of an implicit wave holds that route out and moves the
        // wave to the next step, under the same rules: nothing produced output, the run settled, no abort.
        const refusedByEnsure = quotaRouted && !claudeWorkerTier && stillRunning.length === 0 && !signal?.aborted && fallThroughs.length < MAX_QUOTA_FALL_THROUGHS
          && !(final ?? startedRun)?.tasks.some((task) => task.outputStarted === true || task.state === "done")
          && startupFailures.every((task) => isEnsureRefusal(task.error));
        if (refusedByEnsure) return { fallThrough: { runId: run.id, route: model, providers: [], cause: boundedReason(failureText, 240), kind: "ensure" as const } satisfies QuotaFallThrough };
        // An implicit review wave whose Claude review route died before any output takes its configured read-only
        // fallback inside this same call: the documented path for proven Claude quota/auth unavailability before
        // output, whether the dispatch-time snapshot foresaw it or not (J-3759: the snapshot said the tier was up,
        // the CLI refused, and the review simply failed with one cause).
        const reviewRefusal = !reviewFallbackActive && readOnlyReviewFallback && !claudeUnavailable && requested.requireImages !== true
          && stillRunning.length === 0 && !signal?.aborted && fallThroughs.length < MAX_QUOTA_FALL_THROUGHS
          ? reviewFallThroughReason(final ?? startedRun, startupFailures) : undefined;
        if (reviewRefusal !== undefined) {
          // Ask the router NOW, not at dispatch time: a CLI can refuse a plan the snapshot still showed as launchable.
          const fresh = await readProviderQuota(dependencies.accountCommand, dependencies.now?.());
          const fallbackBlockNow = fallbackStep === undefined ? "no implicitReview.fallback is configured" : routeQuotaBlock(fresh, fallbackStep);
          if (fallbackBlockNow === undefined) {
            return { fallThrough: { runId: run.id, route: model, providers: [], cause: boundedReason(failureText, 240), kind: "review" as const, reviewReason: reviewRefusal } satisfies QuotaFallThrough };
          }
          throw new Error(`USAP implicit review failed before any worker produced model output (run ${run.id} · ${model}): ${failureText}. The same review tasks were not re-run on the configured review fallback (${fallbackStep !== undefined ? routeStepLabel(fallbackStep) : "implicitReview.fallback"}): ${fallbackBlockNow}. ${aftermath} No further fallback applies, so the review fails with both causes named.`);
        }
        // A review wave that may not use the fallback says why, so a single-cause failure is never a mystery.
        const reviewFallbackNotUsed = opusReviewDefault && !claudeUnavailable && !reviewFallbackActive && fallbackStep !== undefined
          ? requested.requireImages === true
            ? " The configured review fallback serves only read-only text review waves, never an image review."
            : readOnlyReviewFallback ? ""
            : " The configured review fallback serves only read-only text reviews (no write, shell or owned paths), so this privileged review never moves to it."
          : "";
        // A usage limit on a route that has no quota tier cannot fall through: say which config key would let it.
        const ungated = quotaRouted && !claudeWorkerTier && startupFailures.every((task) => isQuotaLaunchFailure(launchFailureText(task))) && reachedProviders(final ?? startedRun ?? run).length === 0
          ? ` Note: ${model} is in no providerQuotaFallback tier of ~/.config/ultraterm/routing.json, so this usage limit cannot fall through; add its provider there to let an implicit wave move on.` : "";
        // Name the layer that refused: a worker-level chain hop (inside the worker) has already tried the rest of the
        // chain before this dispatch-level error, so the route named here is the one that refused last.
        const hopNote = final?.tasks.some((task) => (task.routeFallbacks?.length ?? 0) > 0)
          ? ` The in-worker chain already moved ${final.tasks.map((task) => task.routeFallbacks ?? []).flat().join(", ")} before this refusal; ${model} refused last (dispatch layer).`
          : "";
        throw new Error(`USAP dispatch failed before any worker produced model output (run ${run.id} · ${model}): ${failureText}.${hopNote}${ungated}${reviewFallbackNotUsed} ${aftermath} ${fallThroughs.length > 0
          ? `This was the automatic fall-through after ${fallThroughSummary(fallThroughs)}: no further fall-through applies, so the dispatch fails with both causes.`
          : "No fallback was selected."}`);
      }
      binding.completion = attachCompletion(current, run.id);

      if (run.background) {
        const snapshot = current.coordinator.snapshot(run.id)!;
        return {
          content: [{
            type: "text" as const,
            text: `${persistenceNote}${harnessNote}${routeNote}Started USAP run ${run.id} · ${model} · ${resolvedSelection.source}${resolvedSelection.profile ? ` · ${resolvedSelection.profile}` : ""}: ${run.tasks.map((task) => task.id).join(", ")}\nDispatch summary: ${JSON.stringify(dispatchDetails(snapshot, persistence).summary)}`,
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
          content: [{ type: "text" as const, text: `${persistenceNote}${harnessNote}${routeNote}Dispatch summary: ${JSON.stringify(dispatchDetails(settled, persistence).summary)}\n${renderRunResult(settled)}\n${reviewFallbackReceipt(settled, current.store?.directory)}` }],
          details: dispatchDetails(settled, persistence),
          // Nested worker usage belongs only here, never under details/results.
          usage: usageCopy(settled.usage),
        };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    };

    pi.registerTool({
      name: "ultraterm_subagents",
      label: "UltraTerm Subagents",
      description: "Dispatch 1-8 bounded tasks through Pi, the official headless Claude Code CLI, or the steak-dsh harness (an exact steak-dsh/<provider>/<model-id> route). Omit model, profile and harness and the operator's routing.json picks the route: the configured worker chain, then the configured Claude subscription tier; an all-reviewer wave runs the configured review route. Explicit routes win and are never rerouted. Each turn carries a route availability notice: never pin a COOLING, HELD BACK or NOT ALLOWED route. A worker that fails before its first model output fails this call, except a provider quota or usage-limit refusal on an implicit wave, which re-runs the same tasks once on the next configured tier inside this call. Foreground default; ownedPaths grants guarded writes; readPaths grants a read-only artifact root outside the run cwd to a read-only task; allowBash is unsandboxed shell except Claude read-only reviewers get no Bash. Routing, fallback, task-class and harness details are in the ultraterm-subagent-protocol skill (Dispatch reference).",
      promptSnippet: "Dispatch bounded independent child tasks with explicit permissions and path ownership",
      promptGuidelines: [
        "Fan out by default: independent leaves (disjoint files, modules, screens, angles) dispatch in ONE parallel wave — width defaults to min(8, task count); provider ceilings come from the operator's usap-caps.json.",
        "Delegation must buy completion speed; modest token premiums for real throughput are correct. Trivial or tightly coupled edits and direct answers stay in the parent.",
        "Parent owns decomposition, integration, verification; workers own leaves end to end. With exact disjoint paths and acceptance contracts in hand, dispatch in the first tool turn without pre-reading child-owned files; do not duplicate child discovery in the parent.",
        "The operator's routing.json decides the default worker chain, the expert reviewer and which routes need a bounded expert verification (verificationGates); a worker on a gated route is told which reviewer route to request through the parent. Read-only and report-only work need no automatic gate.",
        "taskClass (per task) names an operator-configured class from routing.json taskClasses so an implicit text worker wave runs the route the operator measured best for that class; omit it when unsure. Give every task of a wave the same class (or none), dispatch different classes as separate waves, and when the dispatch note says the class requires a test gate, run that gate before accepting the work.",
        "model or profile picks an explicit authenticated route (mutually exclusive, overrides roles). A model family the operator pinned to one subscription route (subscriptionRouteChecks modelPattern) runs only there. Routine text work stays on the configured automatic chain; do not pick the configured expert reviewer for routine work. requireImages=true for visual critics or render inspection.",
        "harness claude-code (or an exact claude-code/<model> route) runs the official CLI at medium effort unless thinking asks for high/xhigh with a thinkingReason. When no step of the configured chain can launch, an implicit routine wave runs on the configured claudeFallbackTier with no re-dispatch; verify that work with an expert review. Explicit routes never fall back. Read the Dispatch reference in the ultraterm-subagent-protocol skill before using a claude-code-api route, image review, relay steering or account pinning.",
        "Background only when the parent can integrate while children run, then one bounded ultraterm_hub wait. Never start a background run merely to wait immediately. `Started` means no launched worker died in its first ~25 s; a worker that fails before its first model output makes the call throw with that cause and cancels its siblings.",
        "For read-only tasks omit ownedPaths and state the read scope in task text, or name the exact folders with readPaths when the evidence sits outside the run cwd (private agent homes only, never a project checkout); mayEdit requires ownedPaths and cannot be combined with readPaths. allowBash bypasses ownedPaths — grant only when operator-level shell access is necessary.",
      ],
      parameters: ultratermSubagentsSchema as any,
      renderShell: "self",
      renderCall: renderSubagentCall,
      renderResult: renderSubagentResult,
      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        // An implicit wave whose worker is refused on a provider usage limit before any output re-runs the same
        // tasks on the next configured tier right here, so the parent never
        // re-dispatches. Each tier is tried at most once; explicit routes and every other failure surface as
        // the error they are.
        const fallThroughs: QuotaFallThrough[] = [];
        for (;;) {
          // An Esc during a fall-through's router reads must not still launch the next tier.
          if (fallThroughs.length > 0 && signal?.aborted) {
            throw new Error(`USAP dispatch cancelled before the fall-through to the next tier launched (${fallThroughs.map((step) => step.cause).join("; ")}).`);
          }
          const outcome = await dispatchWave(rawParams, signal, onUpdate, ctx, fallThroughs);
          if (!("fallThrough" in outcome) || !outcome.fallThrough) return outcome;
          fallThroughs.push(outcome.fallThrough);
        }
      },
    });

    pi.registerTool({
      name: "ultraterm_hub",
      label: "UltraTerm Hub",
      description: "Inspect this native session's live and checkpointed USAP runs: list, status, bounded wait, cancel, send, redirect, inbox, diagnose, or explicitly resume unfinished work. `routes` (read-only) prints, per task class, the estimates the router ranks on (pass rate, expected cost and seconds, evidence counts, demoted routes and why); `record-outcome` attaches a verification verdict (runId, outcome, optional taskId and source) to the evidence a classed run left. Redirect appends instructions to a running worker without cancellation or new permissions. Resume never repeats completed tasks; host exit interrupts execution but preserves checkpoints.",
      promptSnippet: "Inspect, wait for, cancel, or message an existing USAP run",
      promptGuidelines: [
        "Runs and relay actions belong only to this native parent session. IDs copied from other sessions are historical, not controllable here.",
        "runId is required for every action except list and routes.",
        "routes prints the per-class route estimates from the evidence store; after you verify a classed run's work (a test gate, a reviewer wave), record-outcome with its runId and outcome pass or fail so the router learns from the verdict.",
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
            details: { action: "list" as const, runs: runs.map((run) => toRunView(run, linksFor(current, run))), persistence: persistenceOf(current), readOnly: !current.store && current.checkpointDegraded, checkpointError: current.checkpointError ?? null, checkpointHealth: current.checkpointHealth.diagnose(), shutdownWarning: warning ?? null },
          };
        }

        if (params.action === "routes") {
          const store = evidenceStoreOf(dependencies);
          const view = store.view();
          const configured = routingConfigOrEmpty().taskClasses ?? {};
          const now = (dependencies.now ?? Date.now)();
          const names = [...new Set([...Object.keys(configured), ...view.tasks.map((task) => task.taskClass)])]
            .filter((name) => params.taskClass === undefined || name === params.taskClass).sort();
          const reports = names.map((name) => classReport(name, configured[name]?.chain ?? [], settingsOf(configured[name] ?? {}), view, now));
          const header = `Route evidence: ${view.tasks.length} task record(s) in ${store.path}${store.lastError ? ` (last store error: ${store.lastError})` : ""}.`;
          return {
            content: [{ type: "text" as const, text: [header, ...(reports.length === 0 ? ["No task class is configured and the store holds no classed record."] : reports.map(formatClassReport))].join("\n").slice(0, MAX_TOOL_CONTENT) }],
            details: { action: "routes" as const, store: { path: store.path, records: view.tasks.length, lastError: store.lastError ?? null }, reports },
          };
        }
        if (params.action === "record-outcome") {
          const store = evidenceStoreOf(dependencies);
          const target = requireRunId(params);
          if (params.outcome !== "pass" && params.outcome !== "fail") throw new TypeError("record-outcome needs outcome pass or fail");
          const taskId = params.taskId?.trim() || undefined;
          const covered = store.view().tasks.filter((task) => !task.hop && task.runId === target && (taskId === undefined || task.taskId === taskId));
          if (covered.length === 0) {
            return { content: [{ type: "text" as const, text: `No classed evidence for run ${target}${taskId ? ` task ${taskId}` : ""} in ${store.path}; nothing was recorded. Only tasks of a wave a task class steered leave evidence.` }], details: { action: "record-outcome" as const, recorded: false, runId: target } };
          }
          const recorded = store.recordVerdict({ runId: target, ...(taskId ? { taskId } : {}), outcome: params.outcome, source: params.source ?? "operator", ...(params.body ? { note: params.body.slice(0, 300) } : {}), at: (dependencies.now ?? Date.now)() });
          return {
            content: [{ type: "text" as const, text: recorded ? `Recorded ${params.outcome} (${params.source ?? "operator"}) for ${covered.length} task record(s) of run ${target}: ${[...new Set(covered.map((task) => `${task.taskClass}/${task.route}`))].join(", ")}.` : `Could not write the verdict to ${store.path}: ${store.lastError ?? "unknown error"}` }],
            details: { action: "record-outcome" as const, recorded, runId: target, tasks: covered.length },
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
              checkpointError: current.checkpointError ?? null, checkpointHealth: current.checkpointHealth.diagnose(),
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
            checkpointError: current.checkpointError ?? null, checkpointHealth: current.checkpointHealth.diagnose(),
            checkpointCollision: current.checkpointCollision ?? null,
            shutdownWarning: warning ?? null,
            warnings: current.store?.warnings ?? [],
            waitTimeoutMeaning: "A hub wait timeout stops observing, never the worker.",
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(diagnostics, null, 2) }], details: { action: "diagnose" as const, diagnostics } };
        }

        if (params.action === "resume") {
          // Inspect historical selectors again without rewriting or discarding checkpoints.
          assertActiveModelSelector(snapshot.model);
          assertActiveModelSelector(snapshot.selection?.modelId);
          assertActiveModelSelector(snapshot.selection?.profile);
          if (snapshot.state === "running") throw new Error("Run is still active; resume would duplicate work");
          if (harnessOf(snapshot.harness) === "steak-dsh") {
            throw new Error("Resume refused: harness steak-dsh keeps no resumable worker session in v1; inspect the retained partial work and dispatch a new task.");
          }
          if (checkpoint?.resumedAs) throw new Error(`Already resumed as ${checkpoint.resumedAs}; a task is resumed at most once, so inspect that run instead`);
          if (checkpoint?.pendingResume) throw new Error("Resume reservation interrupted; reload the host to recover it before retrying");
          // A retained lease or a duplicate in-process owner must refuse loudly
          // rather than continue a run whose session file may still be written.
          assertDurableForNewWork(current, "Resume");
          if (!current.store || current.checkpointError) throw new Error("Healthy durable checkpoints are required to resume");
          if (snapshot.version !== USAP_VERSION) throw new Error("Checkpoint policy version is incompatible; inspect history before a new dispatch");
          if (!statSync(snapshot.cwd).isDirectory()) throw new Error("Checkpoint workspace is unavailable");
          const unfinished = snapshot.tasks.filter((task) => task.state !== "done");
          if (!unfinished.length) throw new Error("No unfinished tasks to resume");
          // A legacy automatic review fallback may have moved privileged reviewers to Pi.
          // Only that recorded provenance is refused: an explicit Pi selection keeps its ownership.
          if ((snapshot.selection?.source === "automatic-review-fallback" ||
              (snapshot.selection?.automaticReview === true && snapshot.harness !== "claude-code")) &&
              !isReadOnlyReviewWave(unfinished)) {
            throw new Error(`Resume refused: ${unfinished.filter((task) => !isReadOnlyReviewWave([task])).map((task) => JSON.stringify(task.label)).join(", ")} reached Pi only through the automatic review fallback, which admits read-only reviewers alone (no write, shell or owned paths). Dispatch a new task on Claude or an explicit Pi route to choose its permissions.`);
          }
          // Bounded resume: a task continues its checkpointed session at most once.
          // Every task of a resumed run is itself a resumed attempt, so a second
          // resume is refused here, before any state changes (the store re-checks).
          const spent = snapshot.resumedFrom ?? unfinished.find((task) => task.resumedFrom)?.resumedFrom;
          if (spent) {
            throw new Error(`Resume refused: ${unfinished.map((task) => JSON.stringify(task.label)).join(", ")} already used the one bounded resume (continuing ${spent}). A task is resumed at most once; inspect its retained partial work and dispatch a new, explicitly scoped task for what remains.`);
          }
          for (const task of unfinished) {
            if (snapshot.harness === "claude-code" && !isClaudeApiRoute(snapshot.model) && task.claudeSessionId && !task.subscriptionReceipt) throw new Error(`Resume refused: ${JSON.stringify(task.label)} has no authenticated Claude account receipt; inspect legacy work before a new dispatch`);
            if (task.startedAt !== undefined && !task.sessionFile && !task.claudeSessionId) throw new Error(`No native checkpoint for ${task.label}${snapshot.harness === "claude-code" ? " (this Claude CLI task ran before resumable sessions)" : ""}; inspect partial work before a new dispatch`);
            if (task.sessionFile) current.store.validateSession(task.sessionFile);
          }
          if (!ctx.model) throw new Error("A resolved model is required to resume");
          const input: DispatchInput = {
            goal: snapshot.goal, constraints: snapshot.constraints, contract: snapshot.contract,
            model: snapshot.model, thinking: snapshot.thinkingLevel as DispatchInput["thinking"],
            ...(snapshot.claudeAccount === undefined ? {} : { claudeAccount: snapshot.claudeAccount }),
            ...(snapshot.harness === "claude-code" ? { harness: "claude-code" as const } : {}),
            requireImages: snapshot.selection?.images === true,
            thinkingReason: "Continue the explicitly budgeted checkpoint on its original model and reasoning level.",
            concurrency: snapshot.concurrency, timeoutMs: snapshot.timeoutMs, maxTurns: snapshot.maxTurns,
            background: true, tasks: unfinished.map((task) => ({ label: task.label, task: task.task, role: task.role, mayEdit: task.mayEdit, ...(task.mayEdit ? { ownedPaths: task.ownedPaths } : {}), ...((task.readPaths?.length ?? 0) > 0 ? { readPaths: task.readPaths } : {}), allowBash: task.allowBash, ...(task.taskClass ? { taskClass: task.taskClass } : {}) })),
          };
          // Resume preserves the original harness: claude-code checkpoints ride
          // the same explicit CLI route and continue their session with
          // `--resume`. Tasks started before resumable sessions have no
          // history, so the check above fails closed; never-started tasks
          // may start fresh.
          const claudeResume = snapshot.harness === "claude-code";
          const resolved = claudeResume
            ? undefined
            : await resolveNativeSelection(ctx, input, dependencies);
          // The explicit API route resumes only on itself, after the operator approval,
          // settings contract and the leaf's remaining budget are admitted again.
          const resumeApi = claudeResume && isClaudeApiRoute(snapshot.model);
          const resumeSelection = resolved ? resolved.selection
            : resumeApi ? resolveClaudeApiSelection(claudeApiModelOf(snapshot.model)!)
            : resolveClaudeCodeSelection(claudeAdmittedModel(snapshot.model)!);
          // Same subscription route as the original, or no resume: a changed or
          // paid route is refused before the one resume is spent.
          const originalRoute = snapshot.selection ? `${snapshot.selection.provider}/${snapshot.selection.modelId}` : snapshot.model;
          const refuseRoute = (why: string): never => {
            throw new Error(`Resume refused: ${why}. A resume continues only on the original ${resumeApi ? "explicit API" : "subscription"} route (${originalRoute}, ${snapshot.thinkingLevel}); dispatch a new task to change it.`);
          };
          if (resumeApi) {
            for (const task of unfinished) {
              admitClaudeApiRoute({ route: snapshot.model, taskCount: snapshot.tasks.length, roles: [task.role],
                priorSpendUsd: task.usage.cost.total + (task.priorSpendUsd ?? 0), ...(task.apiLeafCapUsd === undefined ? {} : { leafCapLimitUsd: task.apiLeafCapUsd }) }, dependencies.now ? { now: dependencies.now } : {});
            }
          }
          const resumedRoute = resolved ? `${resolved.model.provider}/${resolved.model.id}` : `${resumeSelection.provider}/${resumeSelection.modelId}`;
          if (originalRoute !== snapshot.model || resumedRoute !== snapshot.model) refuseRoute(`the route changed (checkpoint ${originalRoute}, run ${snapshot.model}, now ${resumedRoute})`);
          if (resolved) {
            if (String(resolved.thinkingLevel) !== snapshot.thinkingLevel) refuseRoute(`the reasoning level changed (${snapshot.thinkingLevel} → ${String(resolved.thinkingLevel)})`);
            if (!isSubscriptionOrLocalRoute(resolved.model, resolved.registry.isUsingOAuth(resolved.model))) refuseRoute(`${resumedRoute} is no longer a subscription route (paid or API-key billing)`);
          } else if (!isClaudeCodeEffort(snapshot.thinkingLevel)) {
            refuseRoute(`Claude Code runs only at ${CLAUDE_CODE_EFFORTS.join(", ")}, not ${snapshot.thinkingLevel}`);
          }
          if (snapshot.claudeAccount !== undefined) await resolveClaudeAccount(snapshot.claudeAccount, dependencies.accountCommand);
          const run = normalizeDispatch(input, snapshot.cwd, snapshot.model, resolved ? String(resolved.thinkingLevel) : snapshot.thinkingLevel, dependencies.now?.() ?? Date.now(), dependencies.idFactory);
          // The resume pins the original route: a recorded automatic chain is not
          // carried over, so no pre-output hop can move the session to another route.
          // Provenance follows the run: a resumed automatic review (or its configured fallback) was never
          // operator-requested, so it keeps its automatic source instead of the resume's pinned `override`.
          // `automaticReview` is not carried over, so the resume never re-arms the Claude review fallback.
          const automaticSource = snapshot.selection?.source === "automatic-review" || snapshot.selection?.source === "automatic-review-fallback" ? snapshot.selection.source : undefined;
          // Independence follows the work, not the route: a resumed Claude-tier run still needs Opus verification.
          // A resume names its route explicitly, so the profile that served the original run is carried only when it
          // is still an operator profile with an `ensure` hook for this exact route: the worker needs its server again.
          const recordedProfile = snapshot.selection?.profile;
          const ensureProfile = recordedProfile !== undefined && !resumeApi && !claudeResume
            && routingConfigOrEmpty().workerProfiles?.some((profile) => profile.id === recordedProfile && profile.ensure !== undefined && profile.model === snapshot.model) === true
            ? recordedProfile : undefined;
          run.selection = { ...resumeSelection, ...(automaticSource ? { source: automaticSource } : {}), ...(snapshot.selection?.independence ? { independence: snapshot.selection.independence } : {}),
            ...(ensureProfile ? { profile: ensureProfile } : {}), ...(snapshot.selection?.taskClass ? { taskClass: { ...snapshot.selection.taskClass } } : {}) };
          run.resumedFrom = runId;
          if (run.maxTurns > snapshot.maxTurns || run.timeoutMs > snapshot.timeoutMs) throw new Error("Resume refused: a resume never raises the original turn or time budget");
          run.ownerSessionId = current.ownerSessionId;
          run.ownerSessionFile = current.ownerSessionFile;
          run.tasks.forEach((task, index) => {
            task.sessionFile = unfinished[index].sessionFile;
            task.providerAccount = unfinished[index].providerAccount ? { ...unfinished[index].providerAccount } : undefined;
            task.claudeSessionId = unfinished[index].claudeSessionId;
            if (unfinished[index].subscriptionReceipt) task.subscriptionReceipt = structuredClone(unfinished[index].subscriptionReceipt);
            if (resumeApi) {
              // The ceiling and the spend booked so far carry over; the resume cannot widen either.
              if (unfinished[index].apiLeafCapUsd !== undefined) task.apiLeafCapUsd = unfinished[index].apiLeafCapUsd;
              task.priorSpendUsd = unfinished[index].usage.cost.total + (unfinished[index].priorSpendUsd ?? 0);
            }
            task.changedPaths = unfinished[index].changedPaths;
            task.lastStep = unfinished[index].lastStep;
            task.resumedFrom = unfinished[index].id;
            // A leaf resumed on its fallback route still names the Claude route it replaced and why
            // (a Claude run resumes on Claude, so a mid-run fallback is not carried onto it).
            const fallback = unfinished[index].reviewFallback;
            if (fallback && fallback.to === snapshot.model) task.reviewFallback = { ...fallback };
          });
          try { current.store.prepareResume(runId, run); } catch (error) {
            checkpointFailed(current, snapshot, error, "resume-reservation");
            throw new Error(current.checkpointError);
          }
          // The predecessor's latest telemetry record now names its successor.
          persistTelemetry(current, snapshot);
          if (!claudeResume) {
            current.workerRuntimes.set(run.id, Object.freeze({ model: Object.freeze({ ...resolved!.model }), thinkingLevel: resolved!.thinkingLevel }));
          }
          current.relay.createRun(run.id, [PARENT_RELAY_ID, ...run.tasks.map((task) => task.id)]);
          const parent = current.relay.bindSender(run.id, PARENT_RELAY_ID);
          try {
            const started = current.coordinator.start(run);
            const resumed: RunBinding = { parent, background: true, completion: Promise.resolve(started), usageClaimed: false };
            current.bindings.set(run.id, resumed);
            resumed.completion = attachCompletion(current, run.id);
            setStatus(current, ctx);
            return { content: [{ type: "text" as const, text: `Resumed ${unfinished.length} unfinished tasks as ${run.id} (the one bounded resume; no second resume is possible). Completed tasks were not replayed. The same budget applies again — maxTurns ${run.maxTurns}, timeoutMs ${run.timeoutMs}, never raised — on the same route ${snapshot.model}; inspect prior side effects.` }], details: dispatchDetails(started, persistenceOf(current)) };
          } catch (error) { parent.close(); current.relay.cleanupRun(run.id); current.workerRuntimes.delete(run.id); current.workerRuntimes.delete(`${run.id}:review-fallback`); throw error; }
        }

        if (params.action === "status") {
          if (snapshot.state !== "running") markDeliveredDurably(current, runId);
          const warning = sessionWarning(current);
          return {
            content: [{ type: "text" as const, text: warning ? `${renderRunResult(snapshot)}\n${warning}` : renderRunResult(snapshot) }],
            details: { action: "status" as const, run: toRunView(snapshot, linksFor(current, snapshot)), persistence: persistenceOf(current), readOnly: !current.store && current.checkpointDegraded, shutdownWarning: warning ?? null },
          };
        }

        if (params.action === "wait" && !binding) {
          if (snapshot.state !== "running") markDeliveredDurably(current, runId);
          return { content: [{ type: "text" as const, text: [renderRunResult(snapshot), reviewFallbackReceipt(snapshot, current.store?.directory)].filter(Boolean).join("\n") }], details: { action: "wait", run: toRunView(snapshot), timedOut: false } };
        }
        if (!binding) throw new Error("Archived run: use status, diagnose, or explicitly resume unfinished work");

        if (params.action === "wait") {
          const timeoutMs = boundedHubWait(params.timeoutMs);
          try {
            const waited = await current.coordinator.wait(runId, params.mode ?? "next", { timeoutMs, signal });
            assertOwner(current, ctx);
            if (waited.state !== "running") markDeliveredDurably(current, runId);
            const result: {
              content: Array<{ type: "text"; text: string }>;
              details: HubDetails;
              usage?: UsageTotals;
            } = {
              content: [{ type: "text", text: [renderRunResult(waited), reviewFallbackReceipt(waited, current.store?.directory)].filter(Boolean).join("\n") }],
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

        if (params.action === "send" || params.action === "redirect") {
          if (harnessOf(snapshot.harness) === "steak-dsh") {
            throw new Error("USAP harness steak-dsh does not support relay steering (hub send/redirect): the DSH headless CLI has no running-worker input channel in v1. Put coordination needs in the leaf's task text, or read them from its final report.");
          }
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
            details: { action: params.action, run: toRunView(snapshot), relay },
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

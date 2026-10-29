import { resolveStagedModule } from "../src/subagents/staged-runtime.ts";
import { registryForSolSelection, type CreateIsolatedModelRuntime } from "../src/subagents/codex-selection.ts";
import { GO_ACCOUNT_ROUTER_TIMEOUT_MS, type AccountCommand } from "../src/subagents/provider-accounts.ts";
import { claudeQuotaBlock, isQuotaLaunchFailure, pickClaudeAccount, quotaProviderOf, readProviderQuota, routeQuotaBlock, type ClaudeAccountPick, type QuotaProvider, type QuotaSnapshot } from "../src/subagents/provider-quota.ts";
import { canFallbackReview, isReadOnlyReviewWave, recordReviewFallback } from "../src/subagents/reviewer-fallback.ts";
import { SOL_MODEL_ROUTE } from "../src/retired-model-selection.ts";
import { statSync } from "node:fs";
import { PersistenceHealth } from "../src/subagents/persistence-health.ts";
import { deferredToolsEnabled, setToolActive } from "../src/deferred-tools.ts";
import { setPinnedPanel } from "../src/tui/pinned-panels.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { SubagentCoordinator, CoordinatorWaitTimeoutError } from "../src/subagents/coordinator.ts";
import { normalizeDispatch, SubagentPolicyError } from "../src/subagents/policy.ts";
import { assertClaudeAccountId, resolveClaudeAccount } from "../src/subagents/claude-account.ts";
import { assertActiveModelSelector } from "../src/retired-model-selection.ts";
import { resolveWorkerSelection, resolveClaudeCodeSelection, assertClaudeCodeImageAdmission, claudeCodeModelOf, claudeCodeModelName, claudeFallbackTier, defaultClaudeCodeRoute, CLAUDE_CODE_HAIKU_ROUTE, CLAUDE_CODE_OPUS_ROUTE, CLAUDE_CODE_ROUTES, type ClaudeFallbackTier, type WorkerProfile } from "../src/subagents/model-selection.ts";
import { admitClaudeApiRoute, anyClaudeRouteModelOf, claudeApiConcurrency, claudeApiModelOf, CLAUDE_API_ROUTES, formatClaudeApiReceipt, isClaudeApiRoute, resolveClaudeApiSelection, stampClaudeApiRun } from "../src/subagents/claude-api-route.ts";
import { AUTOMATIC_CHAIN_APPROVAL, NoChainRouteError, isDefaultTextChainExhausted, type ChainOptions, type WorkerRouteStep } from "../src/model-route-policy.ts";
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
import {
  addUsage,
  USAP_VERSION,
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
  type PartialReason,
  type RunRecord,
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
 * named cause. The window must outlast the worker's own account phase: a Go or Sol worker makes two
 * bounded router calls before any request (reserve, then bind), each up to the router timeout, so a
 * slow router answers its refusal inside the window instead of after `Started`. Known limit: a first
 * request that fails with a 429 also reports the cooldown and releases the lease (two more router
 * calls) before it settles; with a router answering near its timeout that settle can land after the
 * window, and the failure then arrives as an ordinary completion naming the cause. */
export const DEFAULT_STARTUP_WINDOW_MS = 2 * GO_ACCOUNT_ROUTER_TIMEOUT_MS + 5_000;
export const MAX_STARTUP_WINDOW_MS = 30_000;
/** An implicit dispatch whose worker is refused on a provider quota or usage limit before any output re-runs
 * the same tasks on the next tier of Go -> Sol -> Claude. Each tier is tried at most once, so a wave makes at
 * most this many fall-throughs (Go -> Sol, Sol -> Claude): there is no loop. */
export const MAX_QUOTA_FALL_THROUGHS = 2;

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
const HubActionSchema = stringEnum(["list", "status", "wait", "cancel", "send", "redirect", "inbox", "resume", "diagnose"] as const);
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
  allowBash: Type.Optional(Type.Boolean({ description: "Enable unsandboxed shell access in the operator trust domain; defaults to false. Claude read-only reviewers never receive Bash; stage git evidence for Read/Grep/Glob." })),
}, { additionalProperties: false });

/** Public dispatcher schema, exported so contract tests do not have to load Pi. */
export const ultratermSubagentsSchema = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 8_000 }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Exact authenticated provider/model for all tasks; mutually exclusive with profile." })),
  claudeAccount: Type.Optional(Type.Unsafe<"primary" | "b">({ type: "string", enum: ["primary", "b"], description: "Task-scoped Claude subscription account (primary = Claude 1, b = Claude 2). Requires a Claude subscription route; unknown, unavailable, Pi and API selections fail closed. Never changes defaults or enables credits." })),
  profile: Type.Optional(Type.String({ minLength: 1, maxLength: 256, description: "Native harness/profile route (e.g. steak-pi/gpt-6-1-sol); mutually exclusive with model. GPT-6.0 Sol is retired and rejected." })),
  harness: Type.Optional(Type.Unsafe<"pi" | "claude-code">({ type: "string", enum: ["pi", "claude-code"], description: "Execution harness. pi (default) is the native runner; claude-code is the official headless Claude CLI at xhigh: Sonnet 5.5 by default, Opus 5.5 for all-reviewer waves or model claude-code/claude-opus-5-5; workers, scouts and reviewers alike, with CLI-enforced ownedPaths; no Bash for read-only reviewers. Image review reads staged files under cwd with native Read." })),
  requireImages: Type.Optional(Type.Boolean({ description: "Require advertised image input; no silent fallback. Claude Code uses native Read on staged image files under cwd, not inline attachments." })),
  constraints: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_000 }), { maxItems: 64 })),
  contract: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
  tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_CONCURRENCY, description: "Defaults to min(8, task count)." })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TIMEOUT_MS, description: "Absolute run budget including queue time; default 10 minutes, maximum 8 hours. Reviewer launch waits are additionally bounded to 60 seconds." })),
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
  action: "list" | "status" | "wait" | "cancel" | "send" | "redirect" | "inbox" | "resume" | "diagnose";
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
    tasks: Array<{
      label: string;
      role: TaskRecord["role"];
      mayEdit: boolean;
      allowBash: boolean;
      ownedPaths: number;
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
  accountCommand?: AccountCommand;
  /** Bounded startup window (default {@link DEFAULT_STARTUP_WINDOW_MS}); 0 disables the wait. */
  startupWindowMs?: number;
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
 * later (e.g. gpt-6.1-sol) reads as "unavailable" until a restart. On that
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

async function resolveNativeSelection(ctx: ExtensionContext, input: Parameters<typeof resolveWorkerSelection>[2], dependencies: UltratermSubagentsDependencies,
  quota: Pick<ChainOptions, "skipRoute" | "forceDefaultChain"> = {}) {
  const registry = await registryForSolSelection(ctx.model!, input, ctx.modelRegistry,
    dependencies.accountCommand, dependencies.createModelRuntime, dependencies.profiles);
  const resolve = (from: ExtensionContext["modelRegistry"]) => resolvePiSelection(() => resolveWorkerSelection(ctx.model!, ctx.thinkingLevel, input,
    from, dependencies.profiles, undefined, { ...automaticChainOptions(dependencies), ...quota }), from);
  try { return { ...await resolve(registry), registry }; }
  catch (failure) {
    // A Go parent's own store has no Codex login, so the default chain's Sol step cannot resolve there.
    // When the chain found nothing else (Go skipped or unavailable), offer Sol the same isolated Codex
    // store an explicit Sol dispatch gets. No eligible account, runtime or Sol model there leaves the
    // original no-route error unchanged. A Sol step already vetoed for quota is not offered at all.
    if (ctx.model!.provider === "opencode-go" && isDefaultTextChainExhausted(failure) && quota.skipRoute?.(SOL_REVIEW_STEP) !== true &&
        failure.tried.some((step) => routeOfStep(step) === SOL_MODEL_ROUTE)) {
      try {
        const isolated = await registryForSolSelection(ctx.model!, { model: SOL_MODEL_ROUTE }, ctx.modelRegistry,
          dependencies.accountCommand, dependencies.createModelRuntime, dependencies.profiles);
        if (isolated !== ctx.modelRegistry) {
          const sol = await resolve(isolated);
          if (`${sol.selection.provider}/${sol.selection.modelId}` === SOL_MODEL_ROUTE) return { ...sol, registry: isolated };
        }
      } catch { /* Codex is unavailable for this parent: the original outcome stands. */ }
    }
    throw failure;
  }
}

function automaticChainOptions(dependencies: UltratermSubagentsDependencies): ChainOptions {
  return { approvePaidRoute: dependencies.approvePaidRoute ?? AUTOMATIC_CHAIN_APPROVAL };
}

type NativeSelection = Awaited<ReturnType<typeof resolveNativeSelection>>;

/** Product names for the chain steps a dispatch note reports on. */
function routeStepLabel(step: WorkerRouteStep): string {
  return step.provider === "openai-codex" && step.id === "gpt-6.1-sol" ? "GPT-6.1 Sol"
    : step.provider === "opencode-go" ? "OpenCode Go" : `${step.provider}/${step.id}`;
}
/** The router-gated step the automatic Sol review fallback would launch on. */
const SOL_REVIEW_STEP: WorkerRouteStep = { provider: "openai-codex", id: "gpt-6.1-sol" };
const stepOfSelection = (selection: { provider: string; modelId: string }): WorkerRouteStep => ({ provider: selection.provider, id: selection.modelId });
const routeOfStep = (step: WorkerRouteStep): string => `${step.provider}/${step.id}`;
/** Receipts stay bounded: a router cause is echoed, never an unbounded blob. */
const boundedReason = (text: string, limit = 480): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit);

/** The router-gated tiers of the default implicit chain, in order. The Claude subscription tier follows
 * them and is not router-gated here. */
const QUOTA_CHAIN: readonly QuotaProvider[] = ["opencode-go", "codex"];
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
}

/** Providers a fall-through must not revisit: the furthest tier a failed run reached and everything before it. */
function spentProviders(fallThroughs: readonly QuotaFallThrough[]): ReadonlySet<QuotaProvider> {
  const furthest = Math.max(-1, ...fallThroughs.flatMap((item) => item.providers.map((provider) => QUOTA_CHAIN.indexOf(provider))));
  return new Set(QUOTA_CHAIN.slice(0, furthest + 1));
}

/** Router-gated providers a run launched on. */
function reachedProviders(run: RunRecord): QuotaProvider[] {
  const slash = run.model.indexOf("/");
  const provider = slash > 0 ? quotaProviderOf({ provider: run.model.slice(0, slash), id: run.model.slice(slash + 1) }) : undefined;
  return provider ? [provider] : [];
}

/** The text a worker's launch failure is classified on. */
const launchFailureText = (task: TaskRecord): string => task.error ?? "";

/**
 * The tiers a run reached, when its pre-output failure may fall through to the next tier: every worker
 * that failed at launch (`failures`) died on a provider quota or usage limit, and no worker anywhere in
 * the run (`seen`, the settled snapshot) produced output or finished, since re-running would repeat work.
 * A plain auth, route or spawn failure, or any mix with one, is not a quota cause and stays a
 * synchronous failure.
 */
function quotaFallThroughProviders(seen: RunRecord | undefined, failures: readonly TaskRecord[]): QuotaProvider[] | undefined {
  if (!seen || seen.tasks.some((task) => task.outputStarted === true || task.state === "done")) return undefined;
  if (failures.length === 0 || !failures.every((task) => isQuotaLaunchFailure(launchFailureText(task)))) return undefined;
  const providers = reachedProviders(seen);
  return providers.length > 0 ? providers : undefined;
}

/** What the dispatch tells a parent about the tiers that were refused before it, in the words of a receipt. */
const fallThroughSummary = (fallThroughs: readonly QuotaFallThrough[]): string =>
  fallThroughs.map((item) => `run ${item.runId} · ${item.route} was refused on a provider usage limit before any worker produced output (${item.cause})`).join("; ");

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
}

/**
 * Quota-aware route for an IMPLICIT routine text wave (no harness, model, profile or Claude
 * account from the caller). Selection used to resolve Go or Sol without asking the account router,
 * so an exhausted provider was only discovered at worker launch, after `Started`. Now, before a
 * selection is returned:
 *
 *  1. resolve exactly as before; a route the router does not gate (MiMo, local, ...) is final;
 *  2. a router-gated Go/Sol route is kept unless the router proves EVERY configured account of
 *     that provider unavailable (cooling down, signed out, or a 100% window). Busy, unknown and
 *     unreadable are not exhaustion, so a busy Go stays Go;
 *  3. an exhausted route is never selected: the built-in default chain (Go -> Sol) is walked
 *     with the exhausted providers skipped;
 *  4. when both are out (or neither is configured), the wave goes to the official claude-code
 *     subscription route on the cheapest capable tier (Haiku 5.5 or Sonnet 5.5), never to the
 *     paid claude-code-api route and never past a proven-ineligible Claude account. If no
 *     route can launch, the dispatch refuses synchronously naming every cause.
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
): Promise<ImplicitWorkerRoute> {
  const spent = spentProviders(fallThroughs);
  const tierBlock = (snapshot: QuotaSnapshot, step: WorkerRouteStep): string | undefined => {
    const provider = quotaProviderOf(step);
    if (provider === undefined || !spent.has(provider)) return routeQuotaBlock(snapshot, step);
    const failed = fallThroughs.find((item) => item.providers.includes(provider));
    return failed ? `run ${failed.runId} was refused on a usage limit before any output (${failed.cause})`
      : routeQuotaBlock(snapshot, step) ?? "an earlier tier of this chain was refused on a usage limit, so it is not retried";
  };
  let first: NativeSelection | undefined;
  let failure: unknown;
  try { first = await resolveNativeSelection(ctx, requested, dependencies); } catch (error) { failure = error; }
  if (!first && !isDefaultTextChainExhausted(failure)) throw failure;
  let quota: QuotaSnapshot | undefined;
  if (first) {
    const step = stepOfSelection(first.selection);
    if (quotaProviderOf(step) === undefined) return { resolved: first, tried: [], causes: [] };
    quota = await readQuota();
    const cause = tierBlock(quota, step);
    if (cause === undefined) return { resolved: first, tried: [], causes: [] };
    // The resolved route is out of quota: leave it, continue down the default chain.
    const skip = (candidate: WorkerRouteStep) => tierBlock(quota!, candidate) !== undefined;
    try {
      const next = await resolveNativeSelection(ctx, requested, dependencies, { forceDefaultChain: true, skipRoute: skip });
      return { resolved: next, tried: [], causes: [`${routeStepLabel(step)}: ${cause}`] };
    } catch (error) {
      if (!isDefaultTextChainExhausted(error)) throw error;
      failure = error;
    }
  }
  quota ??= await readQuota();
  const exhausted = failure as NoChainRouteError;
  const causes = exhausted.tried.map((step) =>
    `${routeStepLabel(step)}: ${tierBlock(quota!, step) ?? "no authenticated route is available in this session"}`);
  const claudeBlock = claudeQuotaBlock(quota);
  const effortBlock = requested.thinking !== undefined && requested.thinking !== "xhigh"
    ? `the Claude subscription tier runs only at xhigh effort and thinking ${requested.thinking} is not silently overridden` : undefined;
  // A tier worker launched without a pinned account would run on the parent's default login, which
  // the same snapshot may show cooling down while the other account is eligible: pin an eligible one.
  const pick = claudeBlock === undefined ? pickClaudeAccount(quota) : {};
  const accountBlock = claudeBlock ?? pick.cause;
  if (accountBlock !== undefined || effortBlock !== undefined) {
    throw new Error(`USAP implicit routing found no route that can launch this wave (${[...causes,
      ...(accountBlock !== undefined ? [`Claude subscription tier: ${accountBlock}`] : []),
      ...(effortBlock !== undefined ? [`Claude subscription tier: ${effortBlock}`] : [])].join(" | ")}). ${fallThroughs.length > 0
      ? `The tier that launched was refused before any output (run ${fallThroughs.map((item) => item.runId).join(", ")}) and no further route was started; wait for a window to return or name a route explicitly.`
      : "No route was started and no fallback was selected; wait for a window to return or name a route explicitly."}`);
  }
  return { tier: claudeFallbackTier({ tasks: requested.tasks, thinking: requested.thinking }), tried: exhausted.tried, causes, ...(pick.account ? { claudeAccount: pick.account } : {}) };
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
  /** Terminal hub observations and native receipts suppress future delivery. */
  acknowledgedCompletions: Set<string>;
  /** A rejected trigger is never attempted again for the same completion. */
  wakeAttempted: Set<string>;
  wakeParent: boolean;
  wakePending: boolean;
  flushingCompletions: boolean;
  deliveryRetry?: ReturnType<typeof setTimeout>;
  deliveryRetries: number;
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
  return run.tasks.filter(task => task.state === "done" && task.role === "reviewer" && task.reviewFallback?.to === SOL_MODEL_ROUTE)
    .map(task => `Sol fallback review: USAP ${run.id} receipt=${directory}/${run.id}.json report=${task.id}`).join("\n");
}

export function renderRunResult(run: RunRecord, limit = MAX_TOOL_CONTENT): string {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("render limit must be a non-negative integer");
  const independence = run.selection?.independence === "requires-opus"
    ? ` · ${run.model === CLAUDE_CODE_HAIKU_ROUTE ? "Haiku 5.5" : "Sonnet 5.5"} tier: requires Opus 5.5 verification${run.selection.fallbackReason ? ` · ${run.selection.fallbackReason}` : ""}` : "";
  let text = `${renderRunProgress(run)}\nmodel ${run.model} · thinking ${run.thinkingLevel}${run.selection ? ` · ${run.selection.source}${run.selection.profile ? ` · ${run.selection.profile}` : ""}` : ""}${independence}`.slice(0, limit);
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
      tasks: run.tasks.map((task) => ({
        label: task.label,
        role: task.role,
        mayEdit: task.mayEdit,
        allowBash: task.allowBash,
        ownedPaths: task.ownedPaths.length,
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
): WorkerRunner {
  let piRunner: Promise<WorkerRunner> | undefined;
  let claudeRunner: Promise<WorkerRunner> | undefined;
  return async (context) => {
    if (harnessOf(context.run.harness) === "claude-code") {
      claudeRunner ??= import(resolveStagedModule("src/subagents/claude-worker.ts").url)
        .then((module) => {
          const factory = (module as unknown as Partial<ClaudeWorkerModule>).createClaudeWorkerRunner;
          if (typeof factory !== "function") {
            throw new Error("claude-worker module does not export createClaudeWorkerRunner");
          }
          return factory({ relay, ...(claudeSpawn ? { spawn: claudeSpawn } : {}), accountCommand });
        });
      const runner = await claudeRunner.catch((error) => { claudeRunner = undefined; throw error; });
      const result = await runner(context);
      if (!canFallbackReview(context.run, result, context.signal)) return result;
      const fallback = workerRuntimes.get(`${context.run.id}:review-fallback`);
      if (!fallback) return result;
      recordReviewFallback(context.task, result.reviewFallbackReason!);
      // A per-task view keeps sibling Claude routes and parent environment exact.
      const fallbackRun = { ...context.run, harness: "pi" as const,
        model: SOL_MODEL_ROUTE, thinkingLevel: String(fallback.thinkingLevel),
        selection: { provider: "openai-codex", modelId: "gpt-6.1-sol", source: "override" as const, harness: "pi" as const, images: false, tools: true } };
      context.task.claudeSessionId = undefined;
      if (!context.task.mayEdit) context.task.allowBash = false;
      context.onProgress({ currentTool: `model-fallback:${SOL_MODEL_ROUTE}` });
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
    let clearedStatusUi: ExtensionContext["ui"] | undefined;
    // Replacements share leases with any late-disposing prior initialization.
    // Session-wide ceiling comes from usap-caps.json (default 14 = 8 + 6 Codex
    // Codex); each run stays capped at MAX_CONCURRENCY by dispatch validation.
    const scheduler = dependencies.createScheduler?.() ?? new SessionScheduler();
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
      if (runtime !== current || !current.telemetryWritable || !ownsContext(current, current.statusContext)) return;
      const snapshot = usapTelemetrySnapshot(run, linksFor(current, run));
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
        ?? defaultWorkerRunner(relay, workerRuntimes, dependencies.claudeSpawn, dependencies.accountCommand);
      const coordinator = new SubagentCoordinator(runner, {
        scheduler,
        now: dependencies.now,
        sessionDir: () => store?.sessionsDirectory,
        onChange: (run) => {
          if (!created || created.closed) return;
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
        statusContext: ctx,
        closed: false,
        completionBuffer: [],
        awaitingReceipt: new Set(),
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
        shutdownWarning: lastShutdownWarning?.owner === owner ? lastShutdownWarning.message : undefined,
        attachStore: (candidate: CheckpointStore, adoptCtx?: ExtensionContext) => adoptStore(candidate, adoptCtx),
        // Tools can initialize the runtime after agent_start already fired.
        agentIdle: ctx.isIdle?.() ?? true,
        startupWatchers: new Set(),
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

    /** Busy completions steer into the current turn. Idle background completions
     * request at most one new turn per flush; receipts prevent repeat delivery. */
    const flushCompletions = (current: SessionRuntime): void => {
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
            pi.sendMessage(message, current.agentIdle
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
              try { pi.sendMessage(message, { deliverAs: "steer", triggerTurn: false }); }
              catch { retryDelivery(current); return; }
            }
          }
          for (const item of batch) if (!current.acknowledgedCompletions.has(item.runId)) current.awaitingReceipt.add(item.runId);
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
      // The hub only acts on existing runs: expose it when this session has
      // checkpointed or live runs, otherwise after the first dispatch.
      if (deferredToolsEnabled()) {
        const hasRuns = current.coordinator.list().length > 0 || (current.store?.list().length ?? 0) > 0;
        setToolActive(pi, "ultraterm_hub", hasRuns);
      }
    });

    pi.on("tool_result", (event) => {
      if (event.toolName === "ultraterm_subagents") setToolActive(pi, "ultraterm_hub", true);
    });

    pi.on("agent_start", async (_event, ctx) => {
      if (runtime && ownsContext(runtime, ctx)) { runtime.statusContext = ctx; runtime.agentIdle = false; runtime.wakePending = false; }
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

    /**
     * One dispatch attempt. An implicit routine wave whose launched worker is refused on a provider
     * quota or usage limit before any worker produced output does not throw: it returns the failed tier
     * so `execute` can re-run the same tasks on the next one. Everything else returns the tool result or
     * throws, exactly as a single dispatch always did.
     */
    const dispatchWave = async (rawParams: unknown, signal: AbortSignal | undefined, onUpdate: RunBinding["onUpdate"], ctx: ExtensionContext, fallThroughs: readonly QuotaFallThrough[]) => {
      const requested = rawParams as UltratermSubagentsParams;
      const startupWindowMs = dependencies.startupWindowMs ?? DEFAULT_STARTUP_WINDOW_MS;
      // Do not let a mixed implicit wave silently bypass the Opus review
      // standard or spend expert quota on routine implementation leaves.
      if (requested.claudeAccount !== undefined) {
        assertClaudeAccountId(requested.claudeAccount);
        if (requested.profile !== undefined || (requested.harness !== undefined && requested.harness !== "claude-code") || (requested.harness !== "claude-code" && !CLAUDE_CODE_ROUTES.includes(requested.model ?? "")) || (requested.model !== undefined && !CLAUDE_CODE_ROUTES.includes(requested.model))) {
          throw new Error("claudeAccount requires an explicit Claude subscription harness or exact model; Pi, API and profile routes are refused");
        }
      }
      const implicitRoute = requested.claudeAccount === undefined && requested.harness === undefined && requested.model === undefined && requested.profile === undefined;
      const hasReviewer = requested.tasks.some((task) => task.role === "reviewer");
      const allReviewers = requested.tasks.length > 0 && requested.tasks.every((task) => task.role === "reviewer");
      if (implicitRoute && hasReviewer && !allReviewers) {
        throw new Error("Mixed worker/reviewer waves need an explicit route; split routine workers from the Opus review wave. No fallback was selected.");
      }
      // Explicit Pi/model/profile selections win; only implicit all-reviewer
      // waves select the official Opus Pass CLI route automatically.
      const opusReviewDefault = implicitRoute && allReviewers;
      if (opusReviewDefault && requested.thinking !== undefined && requested.thinking !== "xhigh") throw new Error("Automatic Opus review requires xhigh effort; a different explicit effort is not silently overridden.");
      // A fallback may change the harness only for permission-free reviewers.
      // Keep privileged leaves on Claude so exact path admission and reviewer
      // shell denial cannot be bypassed when its subscription is unavailable.
      const readOnlyReviewFallback = opusReviewDefault && isReadOnlyReviewWave(requested.tasks);
      // One router `status` read per dispatch, taken only where a route decision needs it. An
      // unreadable router is "unknown" and never proves exhaustion.
      let quotaRead: Promise<QuotaSnapshot> | undefined;
      const readQuota = (): Promise<QuotaSnapshot> => quotaRead ??= readProviderQuota(dependencies.accountCommand, dependencies.now?.());
      const reviewQuota = readOnlyReviewFallback && requested.requireImages !== true ? await readQuota() : undefined;
      const claudeBlock = reviewQuota ? claudeQuotaBlock(reviewQuota) : undefined;
      const claudeUnavailable = claudeBlock !== undefined;
      if (!ctx.model) throw new Error("ultraterm_subagents requires a resolved current model");
      if (claudeUnavailable) {
        // The Sol review fallback launches on a reserved GPT account: refuse now, naming both
        // causes, instead of dying at launch after `Started`.
        const solBlock = routeQuotaBlock(reviewQuota!, SOL_REVIEW_STEP);
        if (solBlock !== undefined) {
          throw new Error(`USAP implicit review cannot run: Claude subscription tier: ${claudeBlock} | GPT-6.1 Sol review fallback: ${solBlock}. No review was started and no fallback was selected; wait for a window to return or name a route explicitly.`);
        }
      }
      // Quota-aware default route for an implicit routine text wave (Go -> Sol -> Claude Haiku/Sonnet
      // 5.5). A Claude Code CLI route is not a Pi provider, so it cannot be a step of the Pi chain
      // and is reached here instead, only when the default chain cannot launch, never past a
      // proven-ineligible Claude account and never on the paid claude-code-api route. Explicit
      // selections and image waves stay exact.
      let nativeResolved: NativeSelection | undefined;
      let claudeTier: ClaudeFallbackTier | undefined;
      let tierTried: readonly WorkerRouteStep[] = [];
      let quotaCauses: string[] = [];
      let tierAccount: ImplicitWorkerRoute["claudeAccount"];
      const quotaRouted = implicitRoute && !hasReviewer && requested.requireImages !== true;
      if (quotaRouted) {
        const route = await resolveImplicitWorkerRoute(ctx, requested, dependencies, readQuota, fallThroughs);
        nativeResolved = route.resolved;
        claudeTier = route.tier;
        tierTried = route.tried;
        quotaCauses = route.causes;
        tierAccount = route.claudeAccount;
      }
      const claudeWorkerTier = claudeTier !== undefined;
      const params: UltratermSubagentsParams = {
        ...requested,
        ...(tierAccount ? { claudeAccount: tierAccount.id } : {}),
        ...(claudeUnavailable ? { harness: "pi" as const, model: SOL_MODEL_ROUTE, thinking: "high" as const, thinkingReason: "Automatic expert text review fallback after proven Claude unavailability." } : {}),
        ...((!claudeUnavailable && opusReviewDefault || claudeWorkerTier || (requested.harness === undefined && (CLAUDE_CODE_ROUTES.includes(requested.model ?? "") || CLAUDE_API_ROUTES.includes(requested.model ?? "")))) ? { harness: "claude-code" as const } : {}),
      };
      const current = ensureRuntime(ctx);
      // Never launch a run this session could not recover from its durable store.
      assertDurableForNewWork(current);
      const persistence = persistenceOf(current);
      const persistenceNote = current.store
        ? ""
        : `USAP checkpoints are unavailable in this session (${current.checkpointError ?? "no native session file"}): this run is memory-only and cannot be resumed.\n`;
      // The Sol review fallback launches on a reserved GPT account too: when the router proves every
      // GPT account unavailable it is not installed (a Claude quota/auth failure would only trade one
      // refusal for another after `Started`), and the dispatch says so.
      const reviewFallbackBlock = reviewQuota && !claudeUnavailable ? routeQuotaBlock(reviewQuota, SOL_REVIEW_STEP) : undefined;
      const reviewFallbackSkipNote = reviewFallbackBlock !== undefined
        ? `Review note: the GPT-6.1 Sol review fallback is unavailable (${reviewFallbackBlock}); a Claude quota or auth failure ends this review without falling back.\n` : "";
      const tierName = claudeTier ? claudeCodeModelName(claudeTier.model) : "";
      const fallThroughReason = fallThroughs.length > 0 ? "automatic fall-through after a usage-limit refusal before any output; " : "";
      const fallThroughNote = fallThroughs.length > 0
        ? `Fall-through: ${fallThroughSummary(fallThroughs)}. The same tasks were re-run here on the next tier, with no parent re-dispatch.\n` : "";
      const routeNote = fallThroughNote + (claudeTier
        ? `Route note: neither ${tierTried.map(routeStepLabel).join(" nor ")} could launch (${quotaCauses.join(" | ")}), so this implicit wave runs ${claudeTier.route} at xhigh (subscription) on the ${tierName} tier: ${claudeTier.reason}. `
          + `Claude account: ${tierAccount ? `${tierAccount.label} (an eligible account in the router snapshot, the least used)` : "the parent's own Claude login (the router listed no Claude account to pin)"}. `
          + `${tierName} work needs verification: review it with an Opus 5.5 reviewer wave (all-reviewer waves default to model ${CLAUDE_CODE_OPUS_ROUTE}).\n`
        : nativeResolved && quotaCauses.length > 0
          ? `Route note: ${quotaCauses.join(" | ")}; this implicit wave continues down the default chain on ${nativeResolved.model.provider}/${nativeResolved.model.id}.\n`
          : "") + reviewFallbackSkipNote;
      // Foreign-harness routing happens before native selection: the claude-code
      // CLI route is explicit and fixed, and the native Pi registry is never
      // consulted for it (it cannot resolve, and must not appear to).
      const foreignHarness = params.harness === "claude-code";
      if (foreignHarness && ((params.model !== undefined && !CLAUDE_CODE_ROUTES.includes(params.model) && !CLAUDE_API_ROUTES.includes(params.model)) || params.profile !== undefined)) {
        throw new Error("USAP harness claude-code runs only claude-code/claude-sonnet-5-5 or claude-code/claude-opus-5-5 at xhigh (subscription), or the explicitly approved claude-code-api/claude-sonnet-5-5 or claude-code-api/claude-opus-5-5; other model/profile selectors are refused.");
      }
      // Sonnet 5.5 is the default Claude worker; all-reviewer waves keep the Opus Pass. The automatic
      // quota tier names its own route (Haiku 5.5 or Sonnet 5.5).
      // The API route is never a default: only an exact, explicit model names it.
      const claudeRoute = foreignHarness ? params.model ?? (claudeTier ? claudeTier.route : defaultClaudeCodeRoute(params.tasks)) : undefined;
      const claudeModel = anyClaudeRouteModelOf(claudeRoute);
      const apiRoute = foreignHarness && isClaudeApiRoute(claudeRoute);
      // Operator approval, settings contract and budget are checked before any
      // checkpoint, relay peer or worker exists; the runner re-checks at every launch.
      const apiAdmission = apiRoute
        ? admitClaudeApiRoute({ route: claudeRoute, taskCount: params.tasks.length, roles: params.tasks.map((task) => task.role ?? "worker"), requireImages: params.requireImages === true }, dependencies.now ? { now: dependencies.now } : {})
        : undefined;
      if (apiRoute) params.concurrency = claudeApiConcurrency(params.concurrency, params.tasks.length);
      if (foreignHarness && params.thinking !== undefined && params.thinking !== "xhigh") {
        throw new Error(`USAP claude-code ${claudeCodeModelName(claudeModel!)} requires xhigh effort; a different explicit effort is not silently overridden.`);
      }
      if (foreignHarness && params.requireImages === true && !apiRoute) assertClaudeCodeImageAdmission(claudeRoute);
      const piResolved = foreignHarness
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
      let reviewFallbackRuntime: PiWorkerRuntime | undefined;
      if (readOnlyReviewFallback && !claudeUnavailable && requested.requireImages !== true && reviewFallbackBlock === undefined) {
        try {
          const sol = await resolveNativeSelection(ctx,
            { ...requested, harness: "pi", model: SOL_MODEL_ROUTE, profile: undefined, thinking: "high", thinkingReason: "Automatic expert text review fallback after proven Claude unavailability." }, dependencies);
          reviewFallbackRuntime = { model: sol.model, thinkingLevel: sol.thinkingLevel };
        } catch { /* Claude may still succeed; unavailable Sol is not a route substitute. */ }
      }
      const resolvedSelection = piResolved ? piResolved.selection : apiRoute ? resolveClaudeApiSelection(claudeModel!) : resolveClaudeCodeSelection(claudeModel);
      const resolvedThinking = piResolved ? String(piResolved.thinkingLevel) : "xhigh";
      const model = foreignHarness ? claudeRoute! : `${piResolved!.model.provider}/${piResolved!.model.id}`;
      const thinking = resolvedThinking;
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

      if (run.claudeAccount !== undefined) {
        try { await resolveClaudeAccount(run.claudeAccount, dependencies.accountCommand); }
        catch (error) {
          // The tier account came from the router snapshot a moment ago: if the router now refuses it, say which and why.
          if (!tierAccount) throw error;
          throw new Error(`USAP implicit routing picked ${tierAccount.label} for the ${tierName} tier, but the router would not select it now (${boundedReason(error instanceof Error ? error.message : String(error), 200)}). ${fallThroughs.length > 0
            ? `No further worker was started after the earlier tier was refused (${fallThroughSummary(fallThroughs)}); retry or name a route explicitly.`
            : "No worker was started and no fallback was selected; retry or name a route explicitly."}`);
        }
      }
      if (apiAdmission) stampClaudeApiRun(run, apiAdmission);
      run.selection = { ...resolvedSelection,
        // The Claude worker tier records the steps that were really tried, then the tier itself,
        // so a receipt shows exactly why it was reached; its work needs an Opus verification.
        // It also names the tier chosen and why (cheapest capable model) beside the router causes.
        ...(claudeTier ? { source: "chain" as const, chainRoutes: [...tierTried.map(routeOfStep), claudeRoute!], independence: "requires-opus" as const,
          fallbackReason: boundedReason(`${fallThroughReason}${tierName}: ${claudeTier.reason}${tierAccount ? `; Claude account ${tierAccount.label}` : ""}; ${quotaCauses.join(" | ")}`, FALLBACK_REASON_LIMIT) } : {}),
        ...(!claudeTier && quotaCauses.length > 0 ? { fallbackReason: boundedReason(`${fallThroughReason}${quotaCauses.join(" | ")}`, FALLBACK_REASON_LIMIT) } : {}),
        // No route was requested for an implicit review wave: a Sol review chosen only because no Claude
        // account was eligible is an automatic fallback, never an operator-requested override.
        ...(opusReviewDefault ? { source: claudeUnavailable ? "automatic-review-fallback" as const : "automatic-review" as const, automaticReview: true, reviewRequiresImages: requested.requireImages === true } : {}) };
      if (claudeUnavailable) for (const task of run.tasks) recordReviewFallback(task, "no-eligible-claude");
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
      // run.harness and never consults the Pi registry or the relay workers.
      if (!foreignHarness) {
        current.workerRuntimes.set(run.id, Object.freeze({
          model: Object.freeze({ ...(piResolved!.model) }),
          thinkingLevel: piResolved!.thinkingLevel,
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
        // tier of Go -> Sol -> Claude instead of failing: only for a router-gated Pi tier, only once per
        // tier, only when the whole run settled (so nothing can still be running or have written), and
        // never after the operator aborted. An explicit route, the Claude tier and every non-quota failure
        // (auth, route, spawn) fall through to the error below.
        const reached = quotaRouted && !claudeWorkerTier && stillRunning.length === 0 && !signal?.aborted && fallThroughs.length < MAX_QUOTA_FALL_THROUGHS
          ? quotaFallThroughProviders(final ?? startedRun, startupFailures) : undefined;
        if (reached) return { fallThrough: { runId: run.id, route: model, providers: reached, cause: boundedReason(failureText, 240) } satisfies QuotaFallThrough };
        throw new Error(`USAP dispatch failed before any worker produced model output (run ${run.id} · ${model}): ${failureText}. ${aftermath} ${fallThroughs.length > 0
          ? `This was the automatic fall-through after ${fallThroughSummary(fallThroughs)}: no further fall-through applies, so the dispatch fails with both causes.`
          : "No fallback was selected."}`);
      }
      binding.completion = attachCompletion(current, run.id);

      if (run.background) {
        const snapshot = current.coordinator.snapshot(run.id)!;
        return {
          content: [{
            type: "text" as const,
            text: `${persistenceNote}${routeNote}Started USAP run ${run.id} · ${model} · ${resolvedSelection.source}${resolvedSelection.profile ? ` · ${resolvedSelection.profile}` : ""}: ${run.tasks.map((task) => task.id).join(", ")}\nDispatch summary: ${JSON.stringify(dispatchDetails(snapshot, persistence).summary)}`,
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
          content: [{ type: "text" as const, text: `${persistenceNote}${routeNote}Dispatch summary: ${JSON.stringify(dispatchDetails(settled, persistence).summary)}\n${renderRunResult(settled)}\n${reviewFallbackReceipt(settled, current.store?.directory)}` }],
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
      description: "Dispatch 1-8 bounded tasks through Pi or the official headless Claude Code CLI. All-reviewer waves default to Opus 5.5 xhigh; other claude-code waves run Sonnet 5.5 xhigh. Implicit routine waves run Go, then Sol, and the router's quota is checked first: a provider whose every account is cooling down or at 100% is skipped, and when both are out the wave runs on the claude-code subscription at the cheapest capable tier (Haiku 5.5, or Sonnet 5.5 for substantial code work; verify with Opus 5.5). Explicit routes win and are never rerouted; an explicit route in an exhausted provider is refused with the router's cause. A worker that fails before its first model output fails this call itself, background or not, except that an implicit wave refused on a provider quota or usage limit (Go GoUsageLimitError, Codex usage limit, a cooling-down router refusal) re-runs the same tasks once on the next tier (Go, Sol, then Claude Haiku/Sonnet) inside this call, before Started. Foreground default; ownedPaths grants guarded writes on either harness; allowBash is unsandboxed shell except Claude read-only reviewers get no Bash. Claude image review uses native Read on staged files under cwd.",
      promptSnippet: "Dispatch bounded independent child tasks with explicit permissions and path ownership",
      promptGuidelines: [
        "Fan out by default: independent leaves (disjoint files, modules, screens, angles) dispatch in ONE parallel wave — width defaults to min(8, task count); automatic Go/Sol chain lanes fill 8, explicit Luna lanes stay at 6 or fewer.",
        "Delegation must buy completion speed; modest token premiums for real throughput are correct. Trivial or tightly coupled edits and direct answers stay in the parent.",
        "Parent owns decomposition, integration, verification; workers own leaves end to end. With exact disjoint paths and acceptance contracts in hand, dispatch in the first tool turn without pre-reading child-owned files; do not duplicate child discovery in the parent.",
        "model or profile picks an explicit authenticated route (mutually exclusive, overrides roles). Every GPT choice requires paid openai-codex OAuth — never OpenRouter, API-key, or batch GPT. Do not select GPT-6 Astra; use GPT-6.1 Sol instead. requireImages=true for visual critics or render inspection.",
        "Claude work defaults to Sonnet 5.5: harness claude-code (or model claude-code/claude-sonnet-5-5) runs Sonnet 5.5 xhigh, nearly Opus-level at far less quota. Escalate to Opus 5.5 (model claude-code/claude-opus-5-5) only for frontier needs: expert review and sign-off (all-reviewer waves default to it), hard architecture or security reasoning, or a leaf Sonnet already failed. When neither Go nor Sol can launch (not authenticated, not configured, or every account cooling down / at a 100% window per the account router; busy or unknown is NOT exhaustion), an implicit routine text wave runs on the claude-code subscription with no re-dispatch: Haiku 5.5 for ordinary leaves, Sonnet 5.5 when any leaf may edit AND run a shell or thinking xhigh is requested (the tier and why are named in the dispatch note and receipts); verify that work with an Opus 5.5 review. That fallback never uses the paid claude-code-api route, never passes a proven-ineligible Claude account, and if no route can launch the call is refused synchronously naming every cause. A spent Go plan is invisible to the router (no usage API), so an implicit wave whose worker is refused on a provider usage limit before any output falls through to the next tier by itself within the same call (each tier once; the refused run stays failed; the receipt names it; both causes are named if the next tier also cannot launch); auth, route and spawn failures and a bare 429 still fail synchronously. An explicit route whose Go or Sol provider is exhausted is refused with the router cause, not rerouted. mayEdit+ownedPaths are CLI-enforced; allowBash is unsandboxed except read-only reviewers get no shell, even when requested. Stage git evidence for review. requireImages=true admits native Read-image of files staged under cwd, not inline attachments. Explicit routes never fall back; implicit automatic text review may use GPT-6.1 Sol only on proven Claude quota/auth unavailability before output. Hub send/redirect steers running Claude workers through stream-json stdin; replies use the same run-local inbox. Native Pi resume is unavailable on this harness. The exact model claude-code-api/claude-sonnet-5-5 (or claude-code-api/claude-opus-5-5) runs this same headless CLI on approved Claude API credits: explicit only, never a default or fallback, admitted per dispatch and launch by the operator's task-scoped approval record with hard per-session budget ceilings, and a failure never falls back to the subscription or Sol. Promotional API credits cover headless runs only, never interactive Claude Code.",
        "Background only when the parent can integrate while children run, then one bounded ultraterm_hub wait. Never start a background run merely to wait immediately. A background dispatch holds up to ~25 s for each launched worker to produce its first model output: `Started` means no launched worker has died yet, and a worker that fails before it (router refusal, auth, route, spawn, a first request that errors) makes the call throw with that cause and cancels its siblings (a provider quota or usage-limit refusal on an implicit wave instead re-runs the same tasks on the next tier before `Started`).",
        "For read-only tasks omit ownedPaths and state the read scope in task text; mayEdit requires ownedPaths. allowBash bypasses ownedPaths — grant only when operator-level shell access is necessary.",
      ],
      parameters: ultratermSubagentsSchema as any,
      renderShell: "self",
      renderCall: renderSubagentCall,
      renderResult: renderSubagentResult,
      async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
        // An implicit wave whose worker is refused on a provider usage limit before any output re-runs the same
        // tasks on the next tier (Go -> Sol -> Claude) right here, so the parent never re-dispatches. Each tier
        // is tried at most once; explicit routes and every other failure surface as the error they are.
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
      description: "Inspect this native session's live and checkpointed USAP runs: list, status, bounded wait, cancel, send, redirect, inbox, diagnose, or explicitly resume unfinished work. Redirect appends instructions to a running worker without cancellation or new permissions. Resume never repeats completed tasks; host exit interrupts execution but preserves checkpoints.",
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
            details: { action: "list" as const, runs: runs.map((run) => toRunView(run, linksFor(current, run))), persistence: persistenceOf(current), readOnly: !current.store && current.checkpointDegraded, checkpointError: current.checkpointError ?? null, checkpointHealth: current.checkpointHealth.diagnose(), shutdownWarning: warning ?? null },
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
            throw new Error(`Resume refused: ${unfinished.filter((task) => !isReadOnlyReviewWave([task])).map((task) => JSON.stringify(task.label)).join(", ")} reached Sol only through the automatic review fallback, which admits read-only reviewers alone (no write, shell or owned paths). Dispatch a new task on Claude or an explicit Pi route to choose its permissions.`);
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
            background: true, tasks: unfinished.map((task) => ({ label: task.label, task: task.task, role: task.role, mayEdit: task.mayEdit, ...(task.mayEdit ? { ownedPaths: task.ownedPaths } : {}), allowBash: task.allowBash })),
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
            : resolveClaudeCodeSelection(claudeCodeModelOf(snapshot.model));
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
          } else if (snapshot.thinkingLevel !== "xhigh") {
            refuseRoute(`Claude Code runs only at xhigh, not ${snapshot.thinkingLevel}`);
          }
          if (snapshot.claudeAccount !== undefined) await resolveClaudeAccount(snapshot.claudeAccount, dependencies.accountCommand);
          const run = normalizeDispatch(input, snapshot.cwd, snapshot.model, resolved ? String(resolved.thinkingLevel) : "xhigh", dependencies.now?.() ?? Date.now(), dependencies.idFactory);
          // The resume pins the original route: a recorded automatic chain is not
          // carried over, so no pre-output hop can move the session to another route.
          // Provenance follows the run: a resumed automatic review (or its Sol fallback) was never
          // operator-requested, so it keeps its automatic source instead of the resume's pinned `override`.
          // `automaticReview` is not carried over, so the resume never re-arms the Claude -> Sol fallback.
          const automaticSource = snapshot.selection?.source === "automatic-review" || snapshot.selection?.source === "automatic-review-fallback" ? snapshot.selection.source : undefined;
          // Independence follows the work, not the route: a resumed Claude-tier run still needs Opus verification.
          run.selection = { ...resumeSelection, ...(automaticSource ? { source: automaticSource } : {}), ...(snapshot.selection?.independence ? { independence: snapshot.selection.independence } : {}) };
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

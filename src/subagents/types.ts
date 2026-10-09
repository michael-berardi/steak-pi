export const USAP_VERSION = "1.3" as const;
/** Execution harness that serves a run's leaves. `"pi"` is the native default;
 * `"claude-code"` is the official headless Claude CLI runner (read,
 * write and shell leaves; writes are scoped by CLI permission rules). The field is omitted on records that never left the Pi default. */
export const HARNESS_IDS = ["pi", "claude-code"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
/** Never infer durability or capability from an absent field: absent means Pi. */
export function harnessOf(value: HarnessId | undefined): HarnessId {
  return value ?? "pi";
}
/** Subscription providers whose workers can be balanced across several accounts. */
export const PROVIDER_ACCOUNT_PROVIDERS = ["claude", "codex"] as const;
export type ProviderAccountProvider = (typeof PROVIDER_ACCOUNT_PROVIDERS)[number];
/** Nonsecret account pin recorded on a task. Labels are canonical (Claude 1/Claude 2,
 * GPT 1/GPT 2, else `Claude (id)` / `GPT (id)`), never the text a router or
 * checkpoint supplied; `configDir` (Claude only) lets a pruned checkpoint find its
 * own transcript. History belongs to the account, so a pin is never moved; only a
 * task that hit a usage limit before producing anything is unpinned and restarts. */
export interface ProviderAccountRef {
  provider: ProviderAccountProvider;
  id: string;
  label: string;
  configDir?: string;
}
/** Canonical names for the initial accounts; safe registered IDs may extend them. */
export const PROVIDER_ACCOUNT_LABELS: Readonly<Record<ProviderAccountProvider, Readonly<Record<string, string>>>> = {
  claude: { primary: "Claude 1", b: "Claude 2" },
  codex: { primary: "GPT 1", fallback: "GPT 2" },
};

export function validProviderAccountId(id: unknown): id is string {
  return typeof id === "string" && /^(?!-)(?!.*--)(?!.*-$)[a-z0-9-]{1,24}$/.test(id);
}

export function providerAccountLabel(provider: ProviderAccountProvider, id: string, supplied?: string): string {
  const names = PROVIDER_ACCOUNT_LABELS[provider];
  if (Object.hasOwn(names, id)) return names[id];
  const family = provider === "claude" ? "Claude" : "GPT";
  return supplied && new RegExp(`^${family} [1-9][0-9]*$`).test(supplied) ? supplied : `${family} (${id})`;
}

/** Untrusted checkpoint/progress data keeps only safe account metadata. */
export function sanitizeProviderAccountRef(value: unknown): ProviderAccountRef | undefined {
  const source = value && typeof value === "object" ? value as Partial<ProviderAccountRef> : undefined;
  const provider = PROVIDER_ACCOUNT_PROVIDERS.find((candidate) => candidate === source?.provider);
  if (!source || !provider) return undefined;
  if (!validProviderAccountId(source.id)) return undefined;
  const configDir = provider === "claude" && typeof source.configDir === "string" && source.configDir.startsWith("/")
    && source.configDir.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(source.configDir) ? source.configDir : undefined;
  return { provider, id: source.id, label: providerAccountLabel(provider, source.id, source.label), ...(configDir ? { configDir } : {}) };
}

/** A task parked behind provider account capacity never started inference, so a
 * settlement that carries this text is not partial work. */
export const ACCOUNT_QUEUE_ERROR = /waiting for (?:Claude|GPT) account capacity/i;
export const MAX_TASKS = 8;
export const MAX_ACTIVE_RUNS = 16;
export const MAX_RETAINED_TERMINAL_RUNS = 50;
/** Fallback launch width when a dispatch supplies no usable task count. */
export const DEFAULT_CONCURRENCY = 4;
/** Session-wide launch ceiling. GLM flash lanes fill 8-wide waves; Luna lanes stay <= 6 by doctrine. */
export const MAX_CONCURRENCY = 8;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const MIN_TIMEOUT_MS = 1_000;
/** Eight hours: one dispatch may hold a long-horizon leaf instead of re-dispatching it. */
export const MAX_TIMEOUT_MS = 8 * 60 * 60_000;
/** Per-task worker turn budget when a dispatch supplies none. */
export const DEFAULT_MAX_TURNS = 64;
/** Hard ceiling for the per-task worker turn budget. */
export const MAX_MAX_TURNS = 2048;
/** Schema ceiling exposed to the extension's `maxTurns` dispatch field. */
export const MAX_WORKER_TURNS = MAX_MAX_TURNS;
export const OUTPUT_LIMIT = 20_000;
export const RELAY_BODY_LIMIT = 4_000;
export const RELAY_MAILBOX_LIMIT = 100;
export const RELAY_RUN_LIMIT = 500;

export type SubagentRole = "scout" | "worker" | "reviewer";
export type TaskState =
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "done"
  | "failed"
  | "aborted"
  | "timed_out";
export type RunState = "running" | "done" | "failed" | "aborted";

/** A budget stop that leaves usable but unfinished work. The task keeps its
 * terminal state (`failed` for turns, `timed_out` for time); `outcome: "partial"`
 * is the explicit marker, so a partial can never be read as a completed leaf. */
export type TaskOutcome = "partial";
export type PartialReason = "turn_budget" | "time_budget";
/** Upper bound for the retained-work summary carried in receipts and telemetry. */
export const PARTIAL_SUMMARY_LIMIT = 400;

/** The one pattern for "this error is a turn-budget stop" (Pi and Claude workers). */
export const TURN_BUDGET_ERROR = /turn.limit|turn budget/i;

/** Classify a settled task. Only a task that actually started can retain work. */
export function partialReasonOf(state: TaskState, error: string | undefined, started: boolean): PartialReason | undefined {
  if (ACCOUNT_QUEUE_ERROR.test(error ?? "")) return undefined;
  if (state === "timed_out") return started ? "time_budget" : undefined;
  if (state === "failed" && TURN_BUDGET_ERROR.test(error ?? "")) return "turn_budget";
  return undefined;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface SubagentTaskInput {
  label: string;
  task: string;
  role?: SubagentRole;
  mayEdit?: boolean;
  ownedPaths?: string[];
  allowBash?: boolean;
}

export interface ModelSelection {
  provider: string;
  modelId: string;
  profile?: string;
  parentProfile?: string;
  /** `chain` marks a capability-aware automatic route; explicit selectors stay `override`. */
  source: "override" | "profile-default" | "legacy-default" | "chain";
  /** Ordered automatic chain routes (provider/model), for auditable provenance. */
  chainRoutes?: string[];
  /** Foreign runners keep their harness identity instead of a native route. */
  harness?: HarnessId;
  images: boolean;
  tools: boolean;
}

export interface DispatchInput {
  goal: string;
  /** Run-level, mutually exclusive native route selectors. */
  model?: string;
  profile?: string;
  /** Explicit execution harness; omitted and "pi" are identical. */
  harness?: HarnessId;
  requireImages?: boolean;
  constraints?: string[];
  contract?: string;
  tasks: SubagentTaskInput[];
  concurrency?: number;
  timeoutMs?: number;
  /** Per-task worker turn budget; defaults to DEFAULT_MAX_TURNS, ceiling MAX_MAX_TURNS. */
  maxTurns?: number;
  background?: boolean;
  thinking?: "medium" | "high" | "xhigh";
  thinkingReason?: string;
}

export interface NormalizedTask {
  id: string;
  label: string;
  task: string;
  role: SubagentRole;
  mayEdit: boolean;
  ownedPaths: string[];
  allowBash: boolean;
}

export interface RelayEnvelope {
  version: typeof USAP_VERSION;
  runId: string;
  id: string;
  seq: number;
  from: string;
  to: string;
  kind: "message" | "request" | "reply" | "status";
  body: string;
  replyTo?: string;
  createdAt: number;
}

export interface TaskRecord extends NormalizedTask {
  retryAttempt?: number;
  retryDelayMs?: number;
  compactions?: number;
  state: TaskState;
  startedAt?: number;
  endedAt?: number;
  output: string;
  error?: string;
  currentTool?: string;
  toolErrors?: number;
  toolSuccesses?: number;
  turns: number;
  usage: UsageTotals;
  relaySent: number;
  relayReceived: number;
  truncated: boolean;
  /**
   * Optional parent-supplied session file. When present the worker continues
   * that persisted history instead of starting from an empty in-memory session.
   */
  sessionFile?: string;
  /** Claude Code worker session id (`--session-id`), resumable with `--resume`. */
  claudeSessionId?: string;
  /** Provider account that owns this task's history. Set once; a resume or
   * automatic continuation stays on it and is queued rather than moved. */
  providerAccount?: ProviderAccountRef;
  /** Automatic resumes after transient failures, each `reason: error`. */
  autoResumes?: string[];
  /** Successful edit/write tool paths journaled for the final report. */
  changedPaths?: string[];
  /** Last observed worker step (tool name or compaction/retry phase). */
  lastStep?: string;
  /** Pre-output runtime chain hops, journaled as `from->to` route pairs so usage and
   * reports name the provider/model that actually served each request. */
  routeFallbacks?: string[];
  /** Epoch ms of the last accepted progress update; drives staleness diagnosis. */
  lastProgressAt?: number;
  /** Set only for a turn- or time-budget stop; absent for every other settlement. */
  outcome?: TaskOutcome;
  partialReason?: PartialReason;
  /** Bounded, content-free description of the retained work (counts and last step). */
  partialSummary?: string;
  /** Predecessor task this attempt continues; set only by an explicit bounded resume. */
  resumedFrom?: string;
}

export interface RunRecord {
  version: typeof USAP_VERSION;
  id: string;
  /** Native parent identity, captured at dispatch (never inferred from a viewing pane). */
  ownerSessionId?: string;
  ownerSessionFile?: string;
  goal: string;
  constraints: string[];
  contract?: string;
  cwd: string;
  model: string;
  /** Set only for non-Pi harnesses; absence is the Pi default. */
  harness?: HarnessId;
  selection?: ModelSelection;
  thinkingLevel: string;
  concurrency: number;
  timeoutMs: number;
  /** Per-task worker turn budget applied to every task in this run. */
  maxTurns: number;
  background: boolean;
  state: RunState;
  createdAt: number;
  endedAt?: number;
  tasks: TaskRecord[];
  usage: UsageTotals;
  /** Predecessor run this run continues; set only by an explicit bounded resume. */
  resumedFrom?: string;
}

export interface WorkerProgress {
  retryAttempt?: number;
  retryDelayMs?: number;
  compactions?: number;
  state?: Extract<TaskState, "starting" | "running" | "waiting">;
  /**
   * Current step name. Compaction and retry phases reuse this existing field
   * ("compaction" / "retry") so progress reporting needs no protocol change.
   */
  currentTool?: string;
  toolErrors?: number;
  toolSuccesses?: number;
  turns?: number;
  usage?: UsageTotals;
  /** Checkpoint path when the worker session is persisted to disk. */
  sessionFile?: string;
  /** Claude Code session id once the CLI has been launched with it. */
  claudeSessionId?: string;
  /** Account the worker reserved for this task; the first value recorded wins. */
  providerAccount?: ProviderAccountRef;
}

export interface WorkerResult {
  /** Cancelled initialization may settle later; retain the launch lease until disposed. */
  cleanup?: Promise<void>;
  state: Extract<TaskState, "done" | "failed" | "aborted" | "timed_out">;
  output: string;
  error?: string;
  toolErrors?: number;
  toolSuccesses?: number;
  turns: number;
  usage: UsageTotals;
  truncated?: boolean;
}

/** The launch slots a running task holds, lent to its worker for one purpose:
 * a task parked behind provider account capacity runs nothing, so it gives
 * them back instead of blocking launches that could use another account. */
export interface WorkerSlots {
  /** Give the slots back while the task only waits. */
  yield(): void;
  /** Take them again before any work starts; rejects once cancelled or the run budget is gone. */
  reclaim(): Promise<void>;
}

export interface WorkerRunContext {
  run: RunRecord;
  task: TaskRecord;
  signal: AbortSignal;
  onProgress: (progress: WorkerProgress) => void;
  /** Optional parent-supplied session directory used when creating a persisted session. */
  sessionDir?: string;
  /** Present when the coordinator can lend this task's launch slots while it waits. */
  slots?: WorkerSlots;
}

export type WorkerRunner = (context: WorkerRunContext) => Promise<WorkerResult>;

export function emptyUsage(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function nonnegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Normalize untrusted provider/runner accounting before it reaches run totals. */
export function sanitizeUsage(value: unknown): UsageTotals {
  const source = value && typeof value === "object" ? value as Partial<UsageTotals> : {};
  const costSource = source.cost && typeof source.cost === "object"
    ? source.cost as Partial<UsageTotals["cost"]>
    : {};
  const input = nonnegativeFinite(source.input);
  const output = nonnegativeFinite(source.output);
  const cacheRead = nonnegativeFinite(source.cacheRead);
  const cacheWrite = nonnegativeFinite(source.cacheWrite);
  const componentTokens = input + output + cacheRead + cacheWrite;
  const totalTokens = Math.max(nonnegativeFinite(source.totalTokens), componentTokens);
  const cost = {
    input: nonnegativeFinite(costSource.input),
    output: nonnegativeFinite(costSource.output),
    cacheRead: nonnegativeFinite(costSource.cacheRead),
    cacheWrite: nonnegativeFinite(costSource.cacheWrite),
    total: nonnegativeFinite(costSource.total),
  };
  const componentCost = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  const roundingTolerance = Number.EPSILON * Math.max(1, componentCost) * 8;
  if (componentCost - cost.total > roundingTolerance) cost.total = componentCost;
  return { input, output, cacheRead, cacheWrite, totalTokens, cost };
}

export function addUsage(target: UsageTotals, value: UsageTotals): UsageTotals {
  const safe = sanitizeUsage(value);
  target.input += safe.input;
  target.output += safe.output;
  target.cacheRead += safe.cacheRead;
  target.cacheWrite += safe.cacheWrite;
  target.totalTokens += safe.totalTokens;
  target.cost.input += safe.cost.input;
  target.cost.output += safe.cost.output;
  target.cost.cacheRead += safe.cost.cacheRead;
  target.cost.cacheWrite += safe.cost.cacheWrite;
  target.cost.total += safe.cost.total;
  return target;
}

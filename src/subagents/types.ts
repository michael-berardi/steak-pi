export const USAP_VERSION = "1.2" as const;
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
  source: "override" | "profile-default" | "legacy-default";
  images: boolean;
  tools: boolean;
}

export interface DispatchInput {
  goal: string;
  /** Run-level, mutually exclusive native route selectors. */
  model?: string;
  profile?: string;
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
  /** Successful edit/write tool paths journaled for the final report. */
  changedPaths?: string[];
  /** Last observed worker step (tool name or compaction/retry phase). */
  lastStep?: string;
  /** Epoch ms of the last accepted progress update; drives staleness diagnosis. */
  lastProgressAt?: number;
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

export interface WorkerRunContext {
  run: RunRecord;
  task: TaskRecord;
  signal: AbortSignal;
  onProgress: (progress: WorkerProgress) => void;
  /** Optional parent-supplied session directory used when creating a persisted session. */
  sessionDir?: string;
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

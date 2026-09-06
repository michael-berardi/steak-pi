export const USAP_VERSION = "1.1" as const;
export const MAX_TASKS = 8;
export const MAX_ACTIVE_RUNS = 16;
export const MAX_RETAINED_TERMINAL_RUNS = 50;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
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
}

export interface RunRecord {
  version: typeof USAP_VERSION;
  id: string;
  goal: string;
  constraints: string[];
  contract?: string;
  cwd: string;
  model: string;
  selection?: ModelSelection;
  thinkingLevel: string;
  concurrency: number;
  timeoutMs: number;
  background: boolean;
  state: RunState;
  createdAt: number;
  endedAt?: number;
  tasks: TaskRecord[];
  usage: UsageTotals;
}

export interface WorkerProgress {
  state?: Extract<TaskState, "starting" | "running" | "waiting">;
  currentTool?: string;
  toolErrors?: number;
  toolSuccesses?: number;
  turns?: number;
  usage?: UsageTotals;
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

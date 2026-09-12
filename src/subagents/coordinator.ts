import {
  MAX_ACTIVE_RUNS,
  MAX_CONCURRENCY,
  MAX_RETAINED_TERMINAL_RUNS,
  MAX_TASKS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  addUsage,
  sanitizeUsage,
  type RunRecord,
  type TaskRecord,
  type TaskState,
  type UsageTotals,
  type WorkerProgress,
  type WorkerResult,
  type WorkerRunner,
} from "./types.ts";
import { abortError, sessionScheduler, type SessionScheduler } from "./scheduler.ts";
import { defaultMachineSlots, type MachineSlots, type NoopSlots } from "./machine-slots.ts";

const TERMINAL_TASK_STATES = new Set<TaskState>([
  "done",
  "failed",
  "aborted",
  "timed_out",
]);

type TerminalTaskState = WorkerResult["state"];
export type WaitMode = "all" | "next";

export interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CoordinatorProgressEvent {
  runId: string;
  taskId: string;
  progress: WorkerProgress;
  run: RunRecord;
  task: TaskRecord;
}

export interface CoordinatorOptions {
  scheduler?: SessionScheduler;
  /** Cross-process launch slots. Defaults to the real machine-tier limiter. */
  machineSlots?: MachineSlots | NoopSlots;
  onProgress?: (event: CoordinatorProgressEvent) => void;
  now?: () => number;
}

export class CoordinatorWaitTimeoutError extends Error {
  readonly runId: string;
  readonly timeoutMs: number;

  constructor(runId: string, timeoutMs: number) {
    super(`Timed out waiting for run ${runId} after ${timeoutMs}ms`);
    this.name = "CoordinatorWaitTimeoutError";
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
}

interface TaskRuntime {
  controller: AbortController;
  dispatched: boolean;
  accounted: boolean;
  stopState?: Extract<TerminalTaskState, "aborted" | "timed_out">;
  stopMessage?: string;
}

interface RunRuntime {
  record: RunRecord;
  tasks: Map<string, TaskRuntime>;
  inFlight: number;
  accepting: boolean;
  completionCount: number;
  listeners: Set<() => void>;
  deadline?: ReturnType<typeof setTimeout>;
}

function cloneUsage(usage: UsageTotals): UsageTotals {
  return sanitizeUsage(usage);
}

function cloneTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    ownedPaths: [...task.ownedPaths],
    usage: cloneUsage(task.usage),
  };
}

function cloneRun(run: RunRecord): RunRecord {
  return {
    ...run,
    ...(run.selection ? { selection: { ...run.selection } } : {}),
    constraints: [...run.constraints],
    tasks: run.tasks.map(cloneTask),
    usage: cloneUsage(run.usage),
  };
}

function isTerminal(state: TaskState): state is TerminalTaskState {
  return TERMINAL_TASK_STATES.has(state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface WorkerJournal {
  changedPaths: Set<string>;
  lastStep: string;
}

const workerJournals = new WeakMap<TaskRecord, WorkerJournal>();

/** Worker-local successful edit/write journal, also available on exceptional settlement. */
export function workerJournal(task: TaskRecord): WorkerJournal {
  let journal = workerJournals.get(task);
  if (!journal) {
    journal = { changedPaths: new Set(), lastStep: "not started" };
    workerJournals.set(task, journal);
  }
  return journal;
}

export function finalWorkerReport(task: TaskRecord, state: WorkerResult["state"], output: string, error?: string): string {
  const journal = workerJournal(task);
  const exhausted = error?.includes("turn limit") === true || error?.includes("-turn limit") === true;
  const status = state === "done" ? "done" : state === "aborted" || state === "timed_out" || exhausted ? "incomplete" : "failed";
  const reason = exhausted ? "turn budget exhausted" : error ?? (state === "done" ? "completed" : state);
  return [
    "FINAL REPORT",
    `Status: ${status}: ${reason}`,
    `Changed paths: ${JSON.stringify([...journal.changedPaths])}`,
    `Progress: last step: ${journal.lastStep}`,
    ...(output.trim() && output.trim() !== "(no output)" ? ["", output] : []),
  ].join("\n");
}

function safeTurns(value: unknown, fallback = 0): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
}

/**
 * Coordinates normalized runs without depending on Pi. Worker execution is
 * injected, while scheduling defaults to the one session-wide scheduler.
 */
export class SubagentCoordinator {
  private readonly runner: WorkerRunner;
  private readonly scheduler: SessionScheduler;
  private readonly machineSlots: MachineSlots | NoopSlots;
  private readonly onProgress?: (event: CoordinatorProgressEvent) => void;
  private readonly now: () => number;
  private readonly runs = new Map<string, RunRuntime>();
  private closed = false;
  private shutdownPromise?: Promise<void>;

  constructor(runner: WorkerRunner, options: CoordinatorOptions = {}) {
    this.runner = runner;
    this.scheduler = options.scheduler ?? sessionScheduler;
    this.machineSlots = options.machineSlots ?? defaultMachineSlots();
    this.onProgress = options.onProgress;
    this.now = options.now ?? Date.now;
  }

  /** Start a normalized run and return an isolated initial snapshot. */
  start(run: RunRecord): RunRecord {
    if (this.closed) throw new Error("Coordinator is shut down");
    if (this.runs.has(run.id)) throw new Error(`Run already exists: ${run.id}`);
    const activeRunCount = [...this.runs.values()]
      .filter(({ record }) => record.state === "running").length;
    if (activeRunCount >= MAX_ACTIVE_RUNS) {
      throw new Error(`Coordinator already has the maximum ${MAX_ACTIVE_RUNS} active runs`);
    }
    if (run.state !== "running") throw new Error(`Run ${run.id} is not in the running state`);
    if (
      !Number.isInteger(run.concurrency)
      || run.concurrency < 1
      || run.concurrency > MAX_CONCURRENCY
    ) {
      throw new RangeError(`Run concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`);
    }
    if (run.tasks.length < 1 || run.tasks.length > MAX_TASKS) {
      throw new RangeError(`Run tasks must contain 1 to ${MAX_TASKS} entries`);
    }
    if (
      !Number.isInteger(run.timeoutMs)
      || run.timeoutMs < MIN_TIMEOUT_MS
      || run.timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new RangeError(`Run timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
    }
    if (run.tasks.some((task) => task.state !== "queued")) {
      throw new Error(`Run ${run.id} contains a task that is not queued`);
    }

    const record = cloneRun(run);
    const runtime: RunRuntime = {
      record,
      tasks: new Map(
        record.tasks.map((task) => [
          task.id,
          { controller: new AbortController(), dispatched: false, accounted: false },
        ]),
      ),
      inFlight: 0,
      accepting: true,
      completionCount: 0,
      listeners: new Set(),
    };
    if (runtime.tasks.size !== record.tasks.length) {
      throw new Error(`Run ${run.id} contains duplicate task IDs`);
    }

    this.runs.set(record.id, runtime);
    runtime.deadline = setTimeout(() => this.expire(runtime), record.timeoutMs);
    this.pump(runtime);
    return cloneRun(record);
  }

  snapshot(runId: string): RunRecord | undefined {
    const runtime = this.runs.get(runId);
    return runtime ? cloneRun(runtime.record) : undefined;
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Runs remain in insertion order; tasks remain in normalized input order. */
  list(): RunRecord[] {
    return [...this.runs.values()].map(({ record }) => cloneRun(record));
  }

  /** Lightweight bounded source for live status rendering; terminal history is excluded. */
  activeRuns(): RunRecord[] {
    return [...this.runs.values()]
      .filter(({ record }) => record.state === "running")
      .map(({ record }) => cloneRun(record));
  }

  wait(runId: string, mode: WaitMode, options?: WaitOptions): Promise<RunRecord>;
  wait(runId: string, mode: WaitMode, timeoutMs?: number, signal?: AbortSignal): Promise<RunRecord>;
  wait(
    runId: string,
    mode: WaitMode,
    optionsOrTimeout: WaitOptions | number = {},
    positionalSignal?: AbortSignal,
  ): Promise<RunRecord> {
    const runtime = this.runs.get(runId);
    if (!runtime) return Promise.reject(new Error(`Unknown run: ${runId}`));
    if (mode !== "all" && mode !== "next") {
      return Promise.reject(new TypeError(`Unknown wait mode: ${String(mode)}`));
    }

    const options = typeof optionsOrTimeout === "number"
      ? { timeoutMs: optionsOrTimeout, signal: positionalSignal }
      : optionsOrTimeout;
    const { timeoutMs, signal } = options;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      return Promise.reject(new RangeError("wait timeoutMs must be a non-negative finite number"));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const baseline = runtime.completionCount;
    const ready = () => runtime.record.state !== "running"
      || (mode === "next" && runtime.completionCount > baseline);
    if (ready()) return Promise.resolve(cloneRun(runtime.record));

    return new Promise<RunRecord>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      const cleanup = () => {
        runtime.listeners.delete(onChange);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const onChange = () => {
        if (ready()) settle(() => resolve(cloneRun(runtime.record)));
      };
      const onAbort = () => settle(() => reject(abortError(signal)));

      runtime.listeners.add(onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(
          () => settle(() => reject(new CoordinatorWaitTimeoutError(runId, timeoutMs))),
          timeoutMs,
        );
      }
      // Recheck after installing listeners so a synchronous completion cannot
      // be lost between the initial predicate and subscription.
      onChange();
    });
  }

  /** Cancel one task, or the entire run when taskId is omitted. */
  cancel(runId: string, taskId?: string): boolean {
    const runtime = this.runs.get(runId);
    if (!runtime) return false;

    if (taskId !== undefined) {
      const task = runtime.record.tasks.find((candidate) => candidate.id === taskId);
      if (!task || isTerminal(task.state)) return false;
      this.stopTask(runtime, task, "aborted", "Task cancelled");
      this.pump(runtime);
      return true;
    }

    if (runtime.record.state !== "running") return false;
    runtime.accepting = false;
    for (const task of runtime.record.tasks) {
      if (!isTerminal(task.state)) this.stopTask(runtime, task, "aborted", "Run cancelled");
    }
    return true;
  }

  /** Abort all live work and permanently reject subsequent starts. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const completions = this.activeRuns().map((run) => this.wait(run.id, "all"));
    this.shutdownPromise = Promise.all(completions).then(() => undefined);
    this.closed = true;
    for (const runtime of this.runs.values()) {
      if (runtime.record.state !== "running") continue;
      runtime.accepting = false;
      for (const task of runtime.record.tasks) {
        if (!isTerminal(task.state)) {
          this.stopTask(runtime, task, "aborted", "Coordinator shut down");
        }
      }
    }
    return this.shutdownPromise;
  }

  private pump(runtime: RunRuntime): void {
    if (!runtime.accepting || runtime.record.state !== "running") return;

    while (runtime.inFlight < runtime.record.concurrency) {
      const task = runtime.record.tasks.find((candidate) => {
        const state = runtime.tasks.get(candidate.id)!;
        return candidate.state === "queued" && !state.dispatched;
      });
      if (!task) break;

      const taskRuntime = runtime.tasks.get(task.id)!;
      taskRuntime.dispatched = true;
      runtime.inFlight += 1;
      void this.execute(runtime, task, taskRuntime).finally(() => {
        runtime.inFlight -= 1;
        this.pump(runtime);
      });
    }
  }

  private async execute(
    runtime: RunRuntime,
    task: TaskRecord,
    taskRuntime: TaskRuntime,
  ): Promise<void> {
    const provider = runtime.record.model.includes("/")
      ? runtime.record.model.slice(0, runtime.record.model.indexOf("/"))
      : "default";
    try {
      await this.scheduler.run(async () => {
        if (taskRuntime.controller.signal.aborted || isTerminal(task.state)) {
          throw abortError(taskRuntime.controller.signal);
        }

        task.state = "starting";
        task.startedAt = this.now();
        if (taskRuntime.controller.signal.aborted) throw abortError(taskRuntime.controller.signal);

        // Machine tier: one launch slot per worker across every local session,
        // bucketed by provider. Released when the task settles or aborts.
        const releaseMachine = await this.machineSlots.acquire(provider, taskRuntime.controller.signal);
        try {
          if (taskRuntime.controller.signal.aborted || isTerminal(task.state)) {
            throw abortError(taskRuntime.controller.signal);
          }
          task.state = "running";
          if (taskRuntime.controller.signal.aborted) throw abortError(taskRuntime.controller.signal);

          const result = await this.runner({
            run: runtime.record,
            task,
            signal: taskRuntime.controller.signal,
            onProgress: (progress) => this.applyProgress(runtime, task, progress),
          });
          if (!isTerminal(task.state)) {
            this.finishTask(runtime, task, taskRuntime.stopState ?? result.state, {
              ...result,
              error: taskRuntime.stopState
                ? result.error ?? taskRuntime.stopMessage
                : result.error,
            });
          }
          // Terminal cancellation is observable promptly, but unresolved native
          // initialization still owns real concurrency until its late disposal.
          await result.cleanup;
        } finally {
          releaseMachine();
        }
      }, taskRuntime.controller.signal, provider);
    } catch (error) {
      if (isTerminal(task.state)) return;
      if (taskRuntime.stopState || taskRuntime.controller.signal.aborted) {
        this.finishTask(runtime, task, taskRuntime.stopState ?? "aborted", {
          output: task.output,
          error: errorMessage(error),
          turns: task.turns,
          usage: task.usage,
        });
      } else {
        this.finishTask(runtime, task, "failed", {
          output: task.output,
          error: errorMessage(error),
          turns: task.turns,
          usage: task.usage,
        });
      }
    }
  }

  private applyProgress(runtime: RunRuntime, task: TaskRecord, progress: WorkerProgress): void {
    if (isTerminal(task.state)) return;
    if (progress.state !== undefined) task.state = progress.state;
    if (Object.prototype.hasOwnProperty.call(progress, "currentTool")) {
      if (progress.currentTool === undefined) delete task.currentTool;
      else task.currentTool = progress.currentTool;
    }
    if (progress.toolErrors !== undefined) task.toolErrors = safeTurns(progress.toolErrors, task.toolErrors ?? 0);
    if (progress.toolSuccesses !== undefined) task.toolSuccesses = safeTurns(progress.toolSuccesses, task.toolSuccesses ?? 0);
    if (progress.turns !== undefined) task.turns = safeTurns(progress.turns, task.turns);
    if (progress.usage !== undefined) task.usage = cloneUsage(progress.usage);

    if (!this.onProgress) return;
    try {
      this.onProgress({
        runId: runtime.record.id,
        taskId: task.id,
        progress: {
          ...progress,
          usage: progress.usage ? cloneUsage(progress.usage) : undefined,
        },
        run: cloneRun(runtime.record),
        task: cloneTask(task),
      });
    } catch {
      // Observation hooks must not turn otherwise-successful workers into failures.
    }
  }

  private stopTask(
    runtime: RunRuntime,
    task: TaskRecord,
    state: Extract<TerminalTaskState, "aborted" | "timed_out">,
    message: string,
  ): void {
    const taskRuntime = runtime.tasks.get(task.id)!;
    taskRuntime.stopState = state;
    taskRuntime.stopMessage = message;
    taskRuntime.controller.abort(new DOMException(message, state === "timed_out" ? "TimeoutError" : "AbortError"));
    // A dispatched task may own a live worker/session. Its terminal transition
    // is performed by execute() only after that worker has settled disposal and
    // returned its final output/usage. A task never dispatched has no lifecycle
    // to await and can settle immediately.
    if (!taskRuntime.dispatched) {
      this.finishTask(runtime, task, state, {
        output: task.output,
        error: message,
        turns: task.turns,
        usage: task.usage,
      });
    }
  }

  private finishTask(
    runtime: RunRuntime,
    task: TaskRecord,
    state: TerminalTaskState,
    result: Pick<WorkerResult, "output" | "error" | "turns" | "usage" | "truncated" | "toolErrors" | "toolSuccesses">,
  ): void {
    if (isTerminal(task.state)) return;

    const safeUsage = sanitizeUsage(result.usage);
    task.state = state;
    task.output = result.output.startsWith("FINAL REPORT\n")
      ? result.output
      : finalWorkerReport(task, state, result.output, result.error);
    task.turns = safeTurns(result.turns, task.turns);
    task.toolErrors = safeTurns(result.toolErrors, task.toolErrors ?? 0);
    task.toolSuccesses = safeTurns(result.toolSuccesses, task.toolSuccesses ?? 0);
    task.usage = safeUsage;
    task.truncated = result.truncated ?? task.truncated;
    if (result.error !== undefined) task.error = result.error;
    else delete task.error;
    delete task.currentTool;
    task.endedAt = this.now();

    const taskRuntime = runtime.tasks.get(task.id)!;
    if (!taskRuntime.accounted) {
      addUsage(runtime.record.usage, task.usage);
      taskRuntime.accounted = true;
    }
    runtime.completionCount += 1;
    this.finishRunIfSettled(runtime);
    this.notify(runtime);
    this.pruneTerminalRuns();
  }

  private pruneTerminalRuns(): void {
    let terminalCount = 0;
    for (const { record } of this.runs.values()) {
      if (record.state !== "running") terminalCount += 1;
    }
    let excess = terminalCount - MAX_RETAINED_TERMINAL_RUNS;
    if (excess <= 0) return;
    for (const [runId, { record }] of this.runs) {
      if (record.state === "running") continue;
      this.runs.delete(runId);
      excess -= 1;
      if (excess === 0) break;
    }
  }

  private finishRunIfSettled(runtime: RunRuntime): void {
    if (runtime.record.state !== "running") return;
    if (!runtime.record.tasks.every((task) => isTerminal(task.state))) return;

    runtime.accepting = false;
    if (runtime.deadline !== undefined) {
      clearTimeout(runtime.deadline);
      runtime.deadline = undefined;
    }
    const states = runtime.record.tasks.map((task) => task.state);
    runtime.record.state = states.some((state) => state === "failed" || state === "timed_out")
      ? "failed"
      : states.some((state) => state === "aborted")
        ? "aborted"
        : "done";
    runtime.record.endedAt = this.now();
  }

  private expire(runtime: RunRuntime): void {
    runtime.deadline = undefined;
    if (runtime.record.state !== "running") return;
    runtime.accepting = false;
    for (const task of runtime.record.tasks) {
      if (!isTerminal(task.state)) this.stopTask(runtime, task, "timed_out", "Run deadline exceeded");
    }
  }

  private notify(runtime: RunRuntime): void {
    for (const listener of [...runtime.listeners]) listener();
  }
}

export { SubagentCoordinator as Coordinator };

import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { MAX_ACTIVE_RUNS, MAX_RETAINED_TERMINAL_RUNS, MAX_TASKS, OUTPUT_LIMIT, type RunRecord } from "./types.ts";

const MAX_BYTES = 2_000_000;
const ID = /^run-[a-zA-Z0-9-]{1,120}$/;
export interface Checkpoint { version: 1; run: RunRecord; delivered: boolean; savedAt: number; resumedAs?: string; pendingResume?: string }

export function canonicalSessionFile(file: string): string {
  const absolute = resolve(file);
  try { return realpathSync(absolute); } catch {
    try { return join(realpathSync(dirname(absolute)), basename(absolute)); } catch { return absolute; }
  }
}

/** Admit legacy path-only data only with native filename AND header proof. */
function provesLegacyOwner(file: string, id: string): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !basename(file).endsWith(`_${id}.jsonl`)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(4096);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const firstLine = bytes.subarray(0, count).toString("utf8").split("\n", 1)[0];
    const header = JSON.parse(firstLine);
    return header.type === "session" && header.id === id;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function privateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe USAP checkpoint directory");
  // Do not chmod a directory owned by a different user or follow a symlink.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fchmodSync(fd, 0o700); } finally { closeSync(fd); }
}
function readPrivate(path: string, maxBytes = MAX_BYTES): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe or oversized USAP checkpoint");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Small, owner-only atomic snapshots. No daemon, database, auto-replay, or model calls. */
export class CheckpointStore {
  readonly directory: string;
  readonly sessionsDirectory: string;
  readonly warnings: string[] = [];
  private readonly token = randomUUID();
  private readonly cache = new Map<string, Checkpoint>();
  private readonly writes = new Map<string, { at: number; state: string }>();
  private closed = false;
  private readonly ownerSessionId?: string;
  private readonly ownerSessionFile: string;
  private readonly allowLegacy: boolean;

  constructor(parentSession: string, root = join(homedir(), ".pi", "agent", "usap"), ownerSessionId?: string) {
    privateDirectory(root);
    this.ownerSessionId = ownerSessionId;
    this.ownerSessionFile = canonicalSessionFile(parentSession);
    const namespace = (identity: string) => join(root, createHash("sha256").update(identity).digest("hex"));
    const legacy = namespace(this.ownerSessionFile);
    const scoped = ownerSessionId ? namespace(JSON.stringify([this.ownerSessionFile, ownerSessionId])) : legacy;
    this.allowLegacy = !ownerSessionId || (!existsSync(scoped) && existsSync(legacy) && provesLegacyOwner(this.ownerSessionFile, ownerSessionId));
    this.directory = this.allowLegacy ? legacy : scoped;
    privateDirectory(this.directory);
    this.sessionsDirectory = join(this.directory, "sessions");
    privateDirectory(this.sessionsDirectory);
    const lock = join(this.directory, "owner.json");
    // Serialize stale-owner inspection AND replacement. Never unlink a lock
    // another contender acquired after our read. A crashed claim fails closed.
    const claim = join(this.directory, ".claim");
    try { mkdirSync(claim, { mode: 0o700 }); } catch { throw new Error("USAP checkpoint claim is busy or interrupted; inspect the private .claim directory before recovery"); }
    try {
      if (existsSync(lock)) {
        const prior = JSON.parse(readPrivate(lock, 1024)) as { pid: number };
        if (alive(prior.pid)) throw new Error("USAP checkpoints already owned by a live host; resume is blocked");
        unlinkSync(lock);
      }
      const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.token })); fsyncSync(fd); } finally { closeSync(fd); }
    } finally { rmdirSync(claim); }
    try {
      const files = readdirSync(this.directory).filter((name) => ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"));
      if (files.length > MAX_RETAINED_TERMINAL_RUNS + MAX_ACTIVE_RUNS + 8) throw new Error("USAP checkpoint retention limit exceeded");
      for (const file of files) {
        try {
          const checkpoint = JSON.parse(readPrivate(join(this.directory, file))) as Checkpoint;
          const run = checkpoint.run;
          if (checkpoint.version !== 1 || !run || !ID.test(run.id) || `${run.id}.json` !== file || !Array.isArray(run.tasks) || run.tasks.length < 1 || run.tasks.length > MAX_TASKS || typeof run.cwd !== "string" || typeof run.model !== "string") throw new Error("Invalid checkpoint shape");
          if (this.ownerSessionId && ((run.ownerSessionId && run.ownerSessionId !== this.ownerSessionId)
            || (!run.ownerSessionId && !this.allowLegacy)
            || (run.ownerSessionFile && canonicalSessionFile(run.ownerSessionFile) !== this.ownerSessionFile))) throw new Error("Foreign-session checkpoint");
          if (this.ownerSessionId) { run.ownerSessionId = this.ownerSessionId; run.ownerSessionFile = this.ownerSessionFile; }
          this.cache.set(run.id, checkpoint);
        } catch { this.warnings.push(`Unreadable checkpoint: ${file}`); }
      }
      // Finish a interrupted resume reservation without launching any work.
      for (const item of this.cache.values()) {
        if (!item.pendingResume) continue;
        if (this.cache.has(item.pendingResume)) item.resumedAs = item.pendingResume;
        delete item.pendingResume;
        this.atomic(item.run.id, item);
      }
    } catch (error) { this.close(); throw error; }
  }

  list(): Checkpoint[] { return structuredClone([...this.cache.values()].sort((a, b) => a.savedAt - b.savedAt)); }
  get(id: string): Checkpoint | undefined { const value = this.cache.get(id); return value ? structuredClone(value) : undefined; }

  save(run: RunRecord, force = false): void {
    if (this.closed) throw new Error("USAP checkpoint store is closed");
    if (!ID.test(run.id)) throw new Error("Invalid checkpoint run ID");
    const now = Date.now();
    const state = run.state + ":" + run.tasks.map((task) => `${task.state}:${task.sessionFile ?? ""}`).join("|");
    const previous = this.writes.get(run.id);
    const copy = structuredClone(run);
    if (this.ownerSessionId) {
      if ((copy.ownerSessionId && copy.ownerSessionId !== this.ownerSessionId)
        || (copy.ownerSessionFile && canonicalSessionFile(copy.ownerSessionFile) !== this.ownerSessionFile)) throw new Error("Foreign-session checkpoint save refused");
      copy.ownerSessionId = this.ownerSessionId;
      copy.ownerSessionFile = this.ownerSessionFile;
    }
    for (const task of copy.tasks) task.output = task.output.slice(-OUTPUT_LIMIT);
    const checkpoint: Checkpoint = { version: 1, run: copy, delivered: this.cache.get(run.id)?.delivered ?? false, savedAt: now, resumedAs: this.cache.get(run.id)?.resumedAs, pendingResume: this.cache.get(run.id)?.pendingResume };
    this.cache.set(run.id, checkpoint);
    if (!force && previous?.state === state && now - previous.at < 1000) return;
    this.atomic(run.id, checkpoint);
    this.writes.set(run.id, { at: now, state });
    this.prune();
  }

  /** Write-ahead reservation: execution may start only after both records commit. */
  prepareResume(id: string, successor: RunRecord): void {
    const checkpoint = this.cache.get(id);
    if (!checkpoint || checkpoint.resumedAs || checkpoint.pendingResume) throw new Error("Checkpoint is already resumed or reserved");
    checkpoint.pendingResume = successor.id;
    this.atomic(id, checkpoint);
    this.save(successor, true);
    checkpoint.resumedAs = successor.id;
    delete checkpoint.pendingResume;
    this.atomic(id, checkpoint);
  }

  markResumed(id: string, successor: string | undefined): void {
    const checkpoint = this.cache.get(id);
    if (!checkpoint) throw new Error("Missing checkpoint");
    if (successor && checkpoint.resumedAs) throw new Error(`Already resumed as ${checkpoint.resumedAs}; inspect that run instead`);
    checkpoint.resumedAs = successor;
    this.atomic(id, checkpoint);
  }

  markDelivered(id: string): void {
    const checkpoint = this.cache.get(id);
    if (!checkpoint || checkpoint.delivered) return;
    checkpoint.delivered = true;
    this.atomic(id, checkpoint);
  }

  /** A continuation can open only a regular owner-only native session in this store. */
  validateSession(path: string): void {
    const full = resolve(path);
    if (!full.startsWith(this.sessionsDirectory + sep) || dirname(full) !== this.sessionsDirectory) throw new Error("Checkpoint session escaped its private directory");
    // Native session history is streamed by Pi; don't load it into the parent.
    const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe worker session checkpoint");
      fchmodSync(fd, 0o600);
    } finally { closeSync(fd); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const lock = join(this.directory, "owner.json");
    try {
      const owner = JSON.parse(readPrivate(lock, 1024)) as { token?: string };
      if (owner.token === this.token) unlinkSync(lock);
    } catch { /* Never remove another host's lock. */ }
  }

  private atomic(id: string, checkpoint: Checkpoint): void {
    const data = JSON.stringify(checkpoint);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("USAP checkpoint exceeds size budget");
    const temp = join(this.directory, `.${id}-${randomUUID()}.tmp`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temp, join(this.directory, `${id}.json`)); } finally { if (existsSync(temp)) unlinkSync(temp); }
  }

  private prune(): void {
    const terminal = [...this.cache.values()].filter((item) => item.run.state !== "running").sort((a, b) => a.savedAt - b.savedAt);
    for (const checkpoint of terminal.slice(0, Math.max(0, terminal.length - MAX_RETAINED_TERMINAL_RUNS))) {
      unlinkSync(join(this.directory, `${checkpoint.run.id}.json`));
      this.cache.delete(checkpoint.run.id);
      this.writes.delete(checkpoint.run.id);
      // Delete only native sessions referenced exclusively by this pruned checkpoint.
      for (const task of checkpoint.run.tasks) {
        if (!task.sessionFile || [...this.cache.values()].some((item) => item.run.tasks.some((other) => other.sessionFile === task.sessionFile))) continue;
        try { this.validateSession(task.sessionFile); unlinkSync(task.sessionFile); } catch { /* Unsafe/unavailable files are never swept. */ }
      }
    }
  }
}

export function recoveredRun(checkpoint: Checkpoint): RunRecord {
  const run = structuredClone(checkpoint.run);
  if (run.state === "running") {
    run.state = "aborted";
    run.endedAt = checkpoint.savedAt;
    for (const task of run.tasks) {
      if (["queued", "starting", "running", "waiting"].includes(task.state)) {
        task.state = "aborted";
        task.error = "Host interrupted; inspect checkpoint and explicitly resume unfinished work";
        task.endedAt = checkpoint.savedAt;
        delete task.currentTool;
      }
    }
  }
  return run;
}

export function diagnoseRun(run: RunRecord, now = Date.now()) {
  return {
    runId: run.id, state: run.state, timeoutMs: run.timeoutMs, maxTurns: run.maxTurns,
    usageCoverage: "observed assistant events; auxiliary provider billing may not be included",
    tasks: run.tasks.map((task) => {
      const error = task.error ?? "";
      const reason = /Host interrupted|Coordinator shut down/i.test(error) ? "host_interrupted"
        : /turn.limit|turn budget/i.test(error) ? "turn_budget"
        : task.state === "timed_out" ? "deadline"
        : task.state === "aborted" ? "cancelled"
        : /Cannot find package|ERR_MODULE_NOT_FOUND|worker dependencies/i.test(error) ? "initialization_dependency"
        : /launch.slots|launch capacity|maximum.*active runs/i.test(error) ? "launch_capacity"
        : /429|rate.limit/i.test(error) ? "provider_rate_limit"
        : /usage.limit|quota.exhaust|insufficient.quota/i.test(error) ? "provider_quota"
        : /unsupported.*(?:model|account|organization)|model.*not.*(?:supported|available)/i.test(error) ? "provider_configuration"
        : /payload.*(?:large|budget)|context.*(?:length|window)|request.*too.large/i.test(error) ? "context_budget"
        : /fetch failed|incomplete.stream|connection.*(?:reset|closed)|ECONNRESET/i.test(error) ? "transport"
        : /auth|401|403|credential/i.test(error) ? "provider_auth"
        : task.toolErrors && !task.toolSuccesses ? "tool_failures"
        : task.state === "failed" ? "worker_failure" : task.state;
      return { taskId: task.id, state: task.state, reason, turns: task.turns,
        toolSuccesses: task.toolSuccesses ?? 0, toolErrors: task.toolErrors ?? 0,
        retryAttempt: task.retryAttempt ?? 0, retryDelayMs: task.retryDelayMs ?? 0, compactions: task.compactions ?? 0,
        lastProgressAgeMs: task.lastProgressAt === undefined ? null : Math.max(0, now - task.lastProgressAt),
        checkpoint: Boolean(task.sessionFile), truncated: task.truncated };
    }),
  };
}

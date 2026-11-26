import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isClaudeAccountId } from "./claude-account.ts";
import { claudeCodeModelOf } from "./model-selection.ts";
import { removeClaudeWorkerSession } from "./claude-session.ts";
import { MAX_ACTIVE_RUNS, MAX_RETAINED_TERMINAL_RUNS, MAX_TASKS, OUTPUT_LIMIT, TURN_BUDGET_ERROR, type RunRecord } from "./types.ts";

const MAX_BYTES = 2_000_000;
const ID = /^run-[a-zA-Z0-9-]{1,120}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => time(value) && Number.isSafeInteger(value);
const metadataString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const knownKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
function validQueue(value: unknown): boolean {
  if (value === undefined) return true; // Legacy checkpoints carry no queue fields.
  if (!object(value) || !["session", "machine"].includes(value.tier as string)
    || !metadataString(value.provider) || !metadataString(value.reason)
    || !time(value.since) || !time(value.deadlineAt) || value.deadlineAt < value.since
    || !knownKeys(value, ["tier", "provider", "reason", "since", "deadlineAt", "capacity"])) return false;
  if (value.capacity === undefined) return true;
  const capacity = value.capacity;
  if (!object(capacity) || !metadataString(capacity.provider)
    || !knownKeys(capacity, ["provider", "providerBucket", "globalBucket"])) return false;
  return [capacity.providerBucket, capacity.globalBucket].every((bucket) => {
    if (!object(bucket) || !integer(bucket.cap) || bucket.cap < 1 || bucket.cap > 128
      || !integer(bucket.held) || bucket.held > bucket.cap || !Array.isArray(bucket.owners)
      || bucket.owners.length > bucket.cap * 2 || !knownKeys(bucket, ["cap", "held", "owners"])) return false;
    return bucket.owners.every((owner) => object(owner) && integer(owner.index) && owner.index < (bucket.cap as number)
      && knownKeys(owner, ["index", "pid", "born", "runId", "taskId", "sessionId", "kind", "status"])
      && (owner.pid === undefined || (integer(owner.pid) && owner.pid > 0))
      && (owner.born === undefined || time(owner.born))
      && ["runId", "taskId", "sessionId"].every((key) => owner[key] === undefined || metadataString(owner[key]))
      && ["lease", "claim"].includes(owner.kind as string)
      && ["live", "dead", "unknown"].includes(owner.status as string));
  });
}

function validSubscriptionReceipt(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value) || !knownKeys(value, ["kind", "account", "configMode", "configDir", "identityHash", "subscriptionType", "attested"]) || value.kind !== "claude-subscription") return false;
  if (value.account !== undefined && !isClaudeAccountId(value.account)) return false;
  if (typeof value.identityHash !== "string" || !/^[a-f0-9]{64}$/.test(value.identityHash) || !["pro", "max", "team", "enterprise"].includes(value.subscriptionType as string)) return false;
  if (value.configMode === "default" ? value.configDir !== undefined : value.configMode !== "explicit" || typeof value.configDir !== "string" || value.configDir.length > 1024 || !isAbsolute(value.configDir) || /[\u0000-\u001f\u007f-\u009f]/.test(value.configDir)) return false;
  return object(value.attested) && knownKeys(value.attested, ["preflight", "init"]) && value.attested.preflight === true && typeof value.attested.init === "boolean";
}

/** Copy only queue metadata: never provider payloads, task text or slot paths. */
function queueDiagnostic(queue: NonNullable<RunRecord["tasks"][number]["launchQueue"]>, now: number) {
  const capacity = queue.capacity;
  const bucket = (value: NonNullable<typeof capacity>["providerBucket"]) => ({
    cap: value.cap, held: value.held,
    owners: value.owners.map((owner) => ({ index: owner.index, kind: owner.kind, status: owner.status,
      ...(owner.pid === undefined ? {} : { pid: owner.pid }),
      ...(owner.born === undefined ? {} : { born: owner.born }),
      ...(owner.runId === undefined ? {} : { runId: owner.runId }),
      ...(owner.taskId === undefined ? {} : { taskId: owner.taskId }),
      ...(owner.sessionId === undefined ? {} : { sessionId: owner.sessionId }),
    })),
  });
  return { tier: queue.tier, provider: queue.provider, reason: queue.reason, since: queue.since, deadlineAt: queue.deadlineAt,
    elapsedMs: Math.max(0, now - queue.since), remainingMs: Math.max(0, queue.deadlineAt - now),
    ...(capacity ? { capacity: { provider: capacity.provider, providerBucket: bucket(capacity.providerBucket), globalBucket: bucket(capacity.globalBucket) } } : {}),
  };
}
export interface Checkpoint { version: 1; run: RunRecord; delivered: boolean; savedAt: number; resumedAs?: string; pendingResume?: string }

/** Why a contender refused to take over a checkpoint lock it does not own. */
export type CheckpointCollisionReason = "live-owner" | "unreadable-owner";

/** Typed, read-only description of the lock that was preserved untouched. */
export interface CheckpointCollision {
  reason: CheckpointCollisionReason;
  /** True when the owner record names this very process (same pid namespace). */
  sameProcess: boolean;
  /** Owner pid recorded in the lock, when a number could be read. */
  ownerPid?: number;
  /** Owner token recorded in the lock, when a string could be read. */
  ownerToken?: string;
  /** Absolute path of the owner record that was left in place. */
  lockPath: string;
}

/**
 * A live (or unverifiable) owner still holds this checkpoint namespace. The
 * typed collision facts are for read-only diagnostics; the lock itself is never
 * read twice, rewritten or deleted. `sameProcess` is true when the owner record
 * names this very process, which means a replacement session or a duplicate
 * extension resource is contending with a store this process did not release —
 * never another host.
 */
export class CheckpointOwnershipError extends Error {
  readonly code = "USAP_CHECKPOINT_OWNERSHIP";
  readonly reason: CheckpointCollisionReason;
  readonly sameProcess: boolean;
  readonly ownerPid?: number;
  readonly ownerToken?: string;
  readonly lockPath: string;
  readonly collision: Readonly<CheckpointCollision>;
  constructor(collision: CheckpointCollision) {
    super(collision.reason === "unreadable-owner"
      ? "USAP checkpoints already owned by a live host; the owner record is unreadable and resume is blocked"
      : collision.sameProcess
        ? "USAP checkpoints already owned by a live host in this process; resume is blocked"
        : "USAP checkpoints already owned by a live host; resume is blocked");
    this.name = "CheckpointOwnershipError";
    this.reason = collision.reason;
    this.sameProcess = collision.sameProcess;
    this.ownerPid = collision.ownerPid;
    this.ownerToken = collision.ownerToken;
    this.lockPath = collision.lockPath;
    this.collision = Object.freeze({ ...collision });
  }
}

/** True when a checkpoint store in this process is still the live owner. */
export function isInProcessCheckpointCollision(error: unknown): boolean {
  if (error instanceof CheckpointOwnershipError) return error.sameProcess;
  const candidate = error as { code?: unknown; sameProcess?: unknown; message?: unknown } | undefined;
  if (candidate?.code === "USAP_CHECKPOINT_OWNERSHIP" && candidate.sameProcess === true) return true;
  // Duplicate module instances cannot share a class identity; match the marker.
  return /live host in this process/.test(typeof candidate?.message === "string" ? candidate.message : "");
}

/**
 * Tokens whose store in THIS isolate ran `close()` to completion. `close()` is
 * an explicit, ownership-safe release: a lock file that still names such a token
 * was left behind by a store that provably no longer exists and provably
 * belonged to this isolate, so a replacement may reclaim it.
 *
 * This is deliberately isolate-local, never a liveness proof. A second isolate
 * (worker_threads, a container sharing the pid namespace) never sees these
 * tokens and therefore still fails closed, exactly like a dropped store, a
 * collected WeakRef, or any missing marker.
 */
const CLOSED_OWNER_TOKENS = Symbol.for("ultraterm.usap.checkpoint.closed-owners.v1");
function closedOwnerTokens(): Set<string> {
  const holder = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!holder[CLOSED_OWNER_TOKENS]) holder[CLOSED_OWNER_TOKENS] = new Set();
  return holder[CLOSED_OWNER_TOKENS]!;
}
function isClosedOwnerToken(token: unknown): boolean {
  return typeof token === "string" && closedOwnerTokens().has(token);
}

/** Read the owner record for inspection only; never rewrite or delete it here. */
function readOwnerRecord(lock: string): { pid?: number; token?: unknown } | undefined {
  try {
    const record = JSON.parse(readPrivate(lock, 1024)) as { pid?: unknown; token?: unknown } | null;
    if (!record || typeof record !== "object") return undefined;
    return { pid: typeof record.pid === "number" ? record.pid : undefined, token: record.token };
  } catch { return undefined; }
}

export function canonicalSessionFile(file: string): string {
  const absolute = resolve(file);
  try { return realpathSync(absolute); } catch {
    try { return join(realpathSync(dirname(absolute)), basename(absolute)); } catch { return absolute; }
  }
}

/**
 * Copy ONLY a validated Pi JSONL session file into a fresh owner-only file in `sessionsDirectory`.
 * Never copies scratch, workspace, or build directories; fails closed on symlinks, non-regular
 * files, missing session headers, or empty transcripts.
 */
export function forkWorkerSessionFile(sourcePath: string, sessionsDirectory: string, cwd: string): string {
  const resolvedSource = resolve(sourcePath);
  const resolvedDir = resolve(sessionsDirectory);
  const fd = openSync(resolvedSource, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("Source worker session file is missing, empty, or unsafe");
    }
    raw = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const entries: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error("Source worker session file contains invalid JSONL"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Source worker session file contains a malformed entry");
    }
    entries.push(parsed as Record<string, unknown>);
  }
  const header = entries.find((entry) => entry.type === "session");
  if (!header) throw new Error("Source worker session file has no session header");
  if (!entries.some((entry) => entry.type === "message")) {
    throw new Error("Source worker session file contains no conversation history to fork");
  }
  const newId = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const targetPath = join(resolvedDir, `${fileTimestamp}_${newId}.jsonl`);
  if (!targetPath.startsWith(resolvedDir + sep) || dirname(targetPath) !== resolvedDir) {
    throw new Error("Forked worker session path escaped sessions directory");
  }
  const newHeader = {
    type: "session",
    version: typeof header.version === "number" ? header.version : 3,
    id: newId,
    timestamp,
    cwd: resolve(cwd),
    parentSession: resolvedSource,
  };
  const payload = [
    JSON.stringify(newHeader),
    ...entries.filter((entry) => entry.type !== "session").map((entry) => JSON.stringify(entry)),
  ].join("\n") + "\n";
  const outFd = openSync(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(outFd, payload, "utf8");
    fsyncSync(outFd);
  } finally {
    closeSync(outFd);
  }
  return targetPath;
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
        const prior = readOwnerRecord(lock);
        const sameProcess = prior?.pid === process.pid;
        // Takeover needs positive proof of release, and nothing else counts:
        //   1. the recorded pid is provably dead (`kill(pid, 0)` = ESRCH), or
        //   2. the recorded token is tombstoned because a store in THIS isolate
        //      completed close(), the explicit ownership-safe release.
        // A missing registry entry or WeakRef, a collected handle, a missing or
        // differing boot/build marker, an unreadable record, or a same-pid record
        // are NEVER evidence of death: they fail closed and leave the lock
        // byte-identical so a live owner (another isolate, another host) keeps
        // working. Unknown is never treated as stale.
        const deadOwner = prior?.pid !== undefined && !alive(prior.pid);
        const releasedOwner = prior !== undefined && isClosedOwnerToken(prior.token);
        if (!deadOwner && !releasedOwner) throw new CheckpointOwnershipError({
          reason: prior === undefined ? "unreadable-owner" : "live-owner",
          sameProcess,
          ownerPid: prior?.pid,
          ownerToken: typeof prior?.token === "string" ? prior.token : undefined,
          lockPath: lock,
        });
        unlinkSync(lock);
        this.warnings.push(sameProcess || releasedOwner
          ? "Reclaimed a stale checkpoint lock left by this process"
          : `Reclaimed a checkpoint lock left by a host that is no longer running (pid ${prior!.pid})`);
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
          if (run.tasks.some((task) => !object(task) || !validQueue(task.launchQueue) || !validQueue(task.lastLaunchQueue))) throw new Error("Invalid checkpoint queue metadata");
          if (run.claudeAccount !== undefined && (run.harness !== "claude-code" || claudeCodeModelOf(run.model) === undefined || !isClaudeAccountId(run.claudeAccount))) throw new Error("Invalid checkpoint Claude account");
          if (run.tasks.some((task) => !validSubscriptionReceipt(task.subscriptionReceipt) || (task.subscriptionReceipt !== undefined && (run.harness !== "claude-code" || claudeCodeModelOf(run.model) === undefined || task.subscriptionReceipt.account !== run.claudeAccount)))) throw new Error("Invalid checkpoint Claude subscription receipt");
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

  save(run: RunRecord, force = false): boolean {
    if (this.closed) throw new Error("USAP checkpoint store is closed");
    if (!ID.test(run.id)) throw new Error("Invalid checkpoint run ID");
    const now = Date.now();
    // Queue transitions are durable metadata; elapsed time is derived on reads.
    const state = run.state + ":" + run.tasks.map((task) => `${task.state}:${task.sessionFile ?? ""}:${task.claudeSessionId ?? ""}:${task.dshSessionId ?? ""}:${task.autoResumes?.length ?? 0}:${JSON.stringify([task.launchQueue, task.lastLaunchQueue, task.subscriptionReceipt, task.worktree])}`).join("|");
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
    if (!force && previous?.state === state && now - previous.at < 1000) return false;
    this.atomic(run.id, checkpoint);
    // Never advertise an unwritten terminal snapshot as durable recovery evidence.
    this.cache.set(run.id, checkpoint);
    this.writes.set(run.id, { at: now, state });
    this.prune();
    return true;
  }

  /** Write-ahead reservation: execution may start only after both records commit. */
  prepareResume(id: string, successor: RunRecord, options?: { allowModelOverride?: boolean }): void {
    const checkpoint = this.cache.get(id);
    if (!checkpoint || checkpoint.resumedAs || checkpoint.pendingResume) throw new Error("Checkpoint is already resumed or reserved");
    // The single choke point for the bounded-resume contract: a successor may
    // continue one predecessor, only once, and never with a larger budget or
    // different harness. An explicit operator model override is allowed only
    // when explicitly opted in by the hub resume action on the Pi harness.
    const original = checkpoint.run;
    if (original.resumedFrom) throw new Error(`Resume refused: ${id} is already a resumed attempt of ${original.resumedFrom}; a task is resumed at most once`);
    if (successor.resumedFrom !== id) throw new Error("Resume refused: the successor does not record the run it resumes");
    if (successor.maxTurns > original.maxTurns || successor.timeoutMs > original.timeoutMs) throw new Error("Resume refused: a resume never raises the original turn or time budget");
    const allowOverride = options?.allowModelOverride === true && (original.harness ?? "pi") === "pi" && (successor.harness ?? "pi") === "pi";
    if ((successor.harness ?? "pi") !== (original.harness ?? "pi")
      || successor.thinkingLevel !== original.thinkingLevel
      || (!allowOverride && successor.model !== original.model)) {
      throw new Error("Resume refused: a resume stays on the original route");
    }
    if (successor.claudeAccount !== original.claudeAccount) throw new Error("Resume refused: a resume stays on the original Claude subscription account");
    for (const task of successor.tasks) {
      const predecessor = original.tasks.find((item) => item.id === task.resumedFrom);
      if (predecessor?.subscriptionReceipt && JSON.stringify(task.subscriptionReceipt) !== JSON.stringify(predecessor.subscriptionReceipt)) throw new Error("Resume refused: the original Claude authentication receipt must be preserved");
    }
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
    const delivered = { ...checkpoint, delivered: true };
    this.atomic(id, delivered);
    this.cache.set(id, delivered);
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

  /**
   * Fork ONLY a validated Pi JSONL session file in this store into a fresh owner-only
   * session file in `this.sessionsDirectory`. Never copies scratch or workspace directories.
   */
  forkSession(sourcePath: string, cwd: string): string {
    this.validateSession(sourcePath);
    return forkWorkerSessionFile(sourcePath, this.sessionsDirectory, cwd);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Record the explicit release before touching the lock: if the compare-and-
    // swap below cannot run (unreadable record, racing rewrite), the leftover
    // lock is still provably this store's and reclaimable in this isolate.
    closedOwnerTokens().add(this.token);
    const lock = join(this.directory, "owner.json");
    try {
      const owner = JSON.parse(readPrivate(lock, 1024)) as { token?: string };
      // Compare-and-swap on the recorded token: only this store's own lock is
      // ever removed, never another owner's (live or unknown) lock.
      if (owner.token === this.token) unlinkSync(lock);
    } catch { /* Never remove another host's lock. */ }
    try { sweepDeadNamespaces(dirname(this.directory), { skipDir: this.directory }); } catch { /* Best-effort hygiene. */ }
  }

  private atomic(id: string, checkpoint: Checkpoint): void {
    const data = JSON.stringify(checkpoint);
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error("USAP checkpoint exceeds size budget");
    const temp = join(this.directory, `.${id}-${randomUUID()}.tmp`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { writeFileSync(fd, data); fsyncSync(fd); } catch (error) {
        // Close still runs, but a secondary close error must not replace the
        // first write/fsync failure (including its errno).
        try { closeSync(fd); } catch { /* Preserve the first failure. */ }
        throw error;
      }
      closeSync(fd); // With no earlier failure, a close error is authoritative.
      renameSync(temp, join(this.directory, `${id}.json`));
    } finally {
      // Cleanup must not mask the original errno (or remove a prior snapshot).
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* Retain failed temp for private inspection. */ }
    }
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
      // A failed Claude worker kept its transcript for resume; once its run is pruned it is never resumed.
      for (const task of checkpoint.run.tasks) {
        if (!task.claudeSessionId || [...this.cache.values()].some((item) => item.run.tasks.some((other) => other.claudeSessionId === task.claudeSessionId))) continue;
        try { removeClaudeWorkerSession(task.claudeSessionId, undefined, task.subscriptionReceipt?.configDir); } catch { /* best effort */ }
      }
    }
  }
}

const NAMESPACE_DIR_RE = /^[0-9a-f]{64}$/;
export const DEFAULT_NAMESPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function newestMtimeInNamespace(dir: string, dirMtimeMs: number): number {
  let newest = dirMtimeMs;
  for (const child of readdirSync(dir)) {
    if (child === ".claim") continue;
    const childPath = join(dir, child);
    try {
      const cst = lstatSync(childPath);
      newest = Math.max(newest, cst.mtimeMs);
      if (child === "sessions" && cst.isDirectory() && !cst.isSymbolicLink()) {
        for (const grand of readdirSync(childPath)) {
          try { newest = Math.max(newest, lstatSync(join(childPath, grand)).mtimeMs); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  return newest;
}

/**
 * Bounded, owner-safe cleanup of expired dead USAP namespace directories under `rootDir` (e.g. `~/.pi/agent/usap`).
 * Only inspects 64-hex namespace subdirectories owned by the current user; serializes on `.claim` like the
 * constructor, fails closed on unreadable/missing-pid locks, skips symlinks and live owners, and removes only
 * namespaces whose newest file (including `sessions/`) is at least `maxAgeMs` old.
 */
export function sweepDeadNamespaces(
  rootDir: string,
  opts?: { maxAgeMs?: number; now?: number; maxRemovals?: number; skipDir?: string },
): number {
  const maxAgeMs = opts?.maxAgeMs ?? DEFAULT_NAMESPACE_TTL_MS;
  const now = opts?.now ?? Date.now();
  const maxRemovals = opts?.maxRemovals ?? 32;
  const skip = opts?.skipDir ? resolve(opts.skipDir) : undefined;
  let names: string[];
  try { names = readdirSync(rootDir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (removed >= maxRemovals) break;
    if (!NAMESPACE_DIR_RE.test(name)) continue;
    const dir = join(rootDir, name);
    if (skip && resolve(dir) === skip) continue;
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (process.getuid && st.uid !== process.getuid()) continue;
      // Check age before acquiring `.claim` so sweeping never bumps mtime on young namespaces.
      const preNewest = newestMtimeInNamespace(dir, st.mtimeMs);
      if (now - preNewest < maxAgeMs) continue;
      const claim = join(dir, ".claim");
      try { mkdirSync(claim, { mode: 0o700 }); } catch { continue; }
      let deleted = false;
      try {
        const lock = join(dir, "owner.json");
        if (existsSync(lock)) {
          let owner: { pid?: unknown };
          try {
            owner = JSON.parse(readPrivate(lock, 1024)) as { pid?: unknown };
          } catch {
            continue; // Unreadable lock: fail closed.
          }
          if (typeof owner.pid !== "number" || alive(owner.pid)) continue;
        }
        const newest = newestMtimeInNamespace(dir, st.mtimeMs);
        if (now - newest >= maxAgeMs) {
          rmSync(dir, { recursive: true, force: true });
          deleted = true;
          removed += 1;
        }
      } finally {
        if (!deleted) {
          try { rmdirSync(claim); } catch { /* ignore */ }
        }
      }
    } catch { /* Never break callers on concurrent filesystem changes. */ }
  }
  return removed;
}

export function recoveredRun(checkpoint: Checkpoint): RunRecord {
  const run = structuredClone(checkpoint.run);
  if (run.state === "running") {
    run.state = "aborted";
    run.endedAt = checkpoint.savedAt;
    for (const task of run.tasks) {
      if (["queued", "starting", "running", "waiting"].includes(task.state)) {
        task.state = "aborted";
        task.error = run.harness === "claude-code" && task.startedAt !== undefined
          ? "Host interrupted; Claude CLI tasks have no persistent history. Inspect partial work before a new dispatch."
          : "Host interrupted; inspect checkpoint and explicitly resume unfinished work";
        task.endedAt = checkpoint.savedAt;
        delete task.currentTool;
        if (task.launchQueue) { task.lastLaunchQueue = task.launchQueue; delete task.launchQueue; }
      }
    }
  }
  return run;
}

export const DEFAULT_DIAGNOSE_STALE_MS = 120_000;

export interface DiagnoseRunOptions {
  /** Inactivity threshold (ms) after which an active task without progress is flagged stalled. Default 120s. */
  staleThresholdMs?: number;
  /** Unanswered relay requests observed in the live relay broker for this run. */
  unansweredRequests?: ReadonlyArray<{ id: string; seq: number; from: string; to: string; ageMs: number }>;
}

export function diagnoseRun(run: RunRecord, now = Date.now(), options: DiagnoseRunOptions = {}) {
  const staleThresholdMs = options.staleThresholdMs ?? DEFAULT_DIAGNOSE_STALE_MS;
  const taskById = new Map(run.tasks.map((task) => [task.id, task]));
  const stalledTasks: Array<{ taskId: string; label: string; state: RunRecord["tasks"][number]["state"]; silentMs: number; currentTool: string | null; reason: string }> = [];
  const awaitingDependencies: Array<{ taskId: string; label: string; waitingOn: Array<{ taskId: string; label: string; state: RunRecord["tasks"][number]["state"] }> }> = [];

  const tasks = run.tasks.map((task) => {
    const error = task.error ?? "";
    const active = ["queued", "starting", "running", "waiting"].includes(task.state);
    const activeQueue = active ? task.launchQueue : undefined;
    const unmetDeps = task.state === "queued" && task.dependsOn?.length
      ? task.dependsOn
        .map((depId) => taskById.get(depId))
        .filter((dep): dep is NonNullable<typeof dep> => dep !== undefined && dep.state !== "done")
      : [];
    if (unmetDeps.length > 0) {
      awaitingDependencies.push({
        taskId: task.id,
        label: task.label,
        waitingOn: unmetDeps.map((dep) => ({ taskId: dep.id, label: dep.label, state: dep.state })),
      });
    }
    const lastActivity = task.lastProgressAt ?? task.startedAt;
    const silentMs = lastActivity === undefined ? null : Math.max(0, now - lastActivity);
    if (["starting", "running", "waiting"].includes(task.state) && !activeQueue && silentMs !== null && silentMs >= staleThresholdMs) {
      stalledTasks.push({
        taskId: task.id,
        label: task.label,
        state: task.state,
        silentMs,
        currentTool: task.currentTool ?? null,
        reason: task.currentTool ? `silent during tool ${task.currentTool}` : "no model or tool progress update",
      });
    }
    const reason = /Host interrupted|Coordinator shut down/i.test(error) ? "host_interrupted"
      : unmetDeps.length > 0 ? "awaiting_dependencies"
      : activeQueue ? (activeQueue.tier === "machine" ? "launch_capacity" : "session_capacity")
      : /launch.queue.*(?:budget|deadline|exceed|exhaust)|(?:budget|deadline).*launch.queue/i.test(error) ? "launch_capacity"
      : TURN_BUDGET_ERROR.test(error) ? "turn_budget"
      : task.state === "timed_out" ? "deadline"
      : task.state === "aborted" ? "cancelled"
      : /Cannot find package|ERR_MODULE_NOT_FOUND|worker dependencies/i.test(error) ? "initialization_dependency"
      : /launch.slots|launch capacity|maximum.*active runs/i.test(error) ? "launch_capacity"
      : /usage.limit|quota.(?:limit|exhaust|exceed)|insufficient.quota/i.test(error) ? "provider_quota"
      : /429|rate.limit/i.test(error) ? "provider_rate_limit"
      : /unsupported.*(?:model|account|organization)|model.*not.*(?:supported|available)/i.test(error) ? "provider_configuration"
      : /payload.*(?:large|budget)|context.*(?:length|window)|request.*too.large/i.test(error) ? "context_budget"
      : /No model or tool activity/i.test(error) ? "stalled_stream"
      : /fetch failed|incomplete.stream|connection.*(?:reset|closed)|ECONNRESET|transport failure; connection or request did not complete/i.test(error) ? "transport"
      : /auth|401|403|credential/i.test(error) ? "provider_auth"
      : task.toolErrors && !task.toolSuccesses ? "tool_failures"
      : task.state === "failed" ? "worker_failure" : task.state;
    return { taskId: task.id, label: task.label, role: task.role, state: task.state,
      ...(task.outcome ? { outcome: task.outcome, partialReason: task.partialReason ?? null, partialSummary: task.partialSummary ?? null } : {}),
      ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}),
      ...(task.dependsOn?.length ? { dependsOn: [...task.dependsOn] } : {}),
      ...(task.routeFallbacks?.length ? { routeFallbacks: [...task.routeFallbacks] } : {}),
      ...(task.worktree ? { worktree: { branch: task.worktree.branch, worktreePath: task.worktree.worktreePath, dirty: task.worktree.dirty, committed: task.worktree.committed ?? false, cleaned: task.worktree.cleaned ?? false } } : {}),
      reason, turns: task.turns,
      ...(task.launchQueue ? { launchQueue: queueDiagnostic(task.launchQueue, Math.min(now, task.endedAt ?? now)) } : {}),
      ...(task.lastLaunchQueue ? { lastLaunchQueue: queueDiagnostic(task.lastLaunchQueue, Math.min(now, task.endedAt ?? now)) } : {}),
      ...(reason === "provider_quota" && run.harness === "claude-code"
        ? { recovery: "Check Claude usage before debugging; retry the same route only after the usage reset. No paid fallback or review approval." } : {}),
      toolSuccesses: task.toolSuccesses ?? 0, toolErrors: task.toolErrors ?? 0,
      retryAttempt: task.retryAttempt ?? 0, retryDelayMs: task.retryDelayMs ?? 0, compactions: task.compactions ?? 0,
      lastProgressAgeMs: task.lastProgressAt === undefined ? null : Math.max(0, now - task.lastProgressAt),
      checkpoint: Boolean(task.sessionFile || task.claudeSessionId || task.dshSessionId), autoResumes: task.autoResumes?.length ?? 0, truncated: task.truncated };
  });

  const unansweredRequests = (options.unansweredRequests ?? []).map((req) => ({
    id: req.id,
    seq: req.seq,
    from: req.from,
    to: req.to,
    ageMs: Math.max(0, req.ageMs),
  }));

  return {
    runId: run.id, state: run.state, timeoutMs: run.timeoutMs, maxTurns: run.maxTurns,
    usageCoverage: "observed assistant events; auxiliary provider billing may not be included",
    stalledTasks,
    unansweredRequests,
    awaitingDependencies,
    tasks,
  };
}

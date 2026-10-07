/** Content-free checkpoint diagnostics. Never echo paths, payloads or arbitrary errors. */
export interface CheckpointFailureCause {
  code: string;
  syscall: string | null;
  stage: string;
  name: string;
  message: string;
}

const CODES = new Set(["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EIO", "EROFS", "ENOENT", "EMFILE", "ENFILE", "EEXIST", "USAP_CHECKPOINT_OWNERSHIP"]);
const SYSCALLS = new Set(["open", "write", "fsync", "close", "rename", "unlink", "mkdir", "rmdir", "chmod", "fchmod", "stat", "lstat", "read", "scandir"]);
const NAMES = new Set(["Error", "TypeError", "RangeError", "CheckpointOwnershipError"]);
export function checkpointFailureCause(error: unknown, stage: string): CheckpointFailureCause {
  const e = error && typeof error === "object" ? error as { code?: unknown; syscall?: unknown; name?: unknown; message?: unknown } : {};
  const code = typeof e.code === "string" && CODES.has(e.code) ? e.code : "UNKNOWN";
  // Only exact, source-owned messages are admissible. Even errno errors can contain secrets in paths.
  const safeMessages = new Set(["USAP checkpoint exceeds size budget", "USAP checkpoint store is closed", "Invalid checkpoint run ID", "Foreign-session checkpoint save refused", "Unsafe USAP checkpoint directory"]);
  const message = typeof e.message === "string" && safeMessages.has(e.message) ? e.message
    : code === "ENOSPC" ? "No space left on device"
    : code === "EDQUOT" ? "Disk quota exceeded"
    : code === "EACCES" || code === "EPERM" ? "Checkpoint permission denied"
    : code === "UNKNOWN" ? "Checkpoint operation failed (private message withheld)" : "Checkpoint filesystem operation failed";
  return { code, syscall: typeof e.syscall === "string" && SYSCALLS.has(e.syscall) ? e.syscall : null,
    stage: stage.replace(/[^a-z-]/g, "").slice(0, 40), name: typeof e.name === "string" && NAMES.has(e.name) ? e.name : "Error", message };
}

/** A successful write repairs only that run, not unrelated failed writes. History stays bounded. */
export class PersistenceHealth {
  private readonly dirty = new Set<string>();
  private first?: CheckpointFailureCause;
  private latest?: CheckpointFailureCause;
  private failures = 0;
  private lastSuccessfulSaveAt?: number;
  failed(runId: string, error: unknown, stage: string): CheckpointFailureCause {
    const cause = checkpointFailureCause(error, stage);
    this.dirty.add(runId);
    this.first ??= cause;
    this.latest = cause;
    this.failures = Math.min(Number.MAX_SAFE_INTEGER, this.failures + 1);
    return cause;
  }
  saved(runId: string): void { this.dirty.delete(runId); this.lastSuccessfulSaveAt = Date.now(); }
  get blocked(): boolean { return this.dirty.size > 0; }
  needsSave(runId: string): boolean { return this.dirty.has(runId); }
  pending(): string[] { return [...this.dirty]; }
  diagnose() {
    return { state: this.blocked ? "failed" : this.lastSuccessfulSaveAt ? "validated-save" : "unvalidated",
      pendingRuns: this.dirty.size, lastSuccessfulSaveAt: this.lastSuccessfulSaveAt ?? null,
      retainedFailure: this.first ? { first: this.first, latest: this.latest, count: this.failures } : null };
  }
}

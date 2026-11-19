// Running agy as a child process. Each child leads its own process group so cancellation reaches whatever agy started.
import { spawn, type ChildProcess } from "node:child_process";
import { AgyError, cleanAgyText, missingMessage } from "./errors.ts";

export const BIN_ENV = "STEAK_PI_AGY_BIN";
export const agyBin = (env: Record<string, string | undefined> = process.env) => env[BIN_ENV]?.trim() || "agy";

const live = new Set<ChildProcess>();
const posix = process.platform !== "win32";

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try { if (posix) process.kill(-child.pid, signal); else child.kill(signal); }
  catch { /* already gone */ }
}

const killLive = () => { for (const child of live) signalGroup(child, "SIGKILL"); };
// A Pi that exits must not leave agy (and its tools) running.
process.on("exit", killLive);
// A Pi that is hung up on or terminated kills agy's groups too. Our listener suppresses the default exit, so when it is the
// only one for that signal we remove it and re-raise, which ends Pi the way the signal would have; otherwise the other
// listeners own the exit.
if (posix) {
  for (const sig of ["SIGHUP", "SIGTERM"] as const) {
    const onSignal = () => {
      killLive();
      if (process.listenerCount(sig) === 1) { process.off(sig, onSignal); process.kill(process.pid, sig); }
    };
    process.on(sig, onSignal);
  }
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stop a child: SIGINT first so agy records INTERRUPTED, then SIGTERM, then SIGKILL, each bounded. Resolves once it has exited. */
export async function stopChild(child: ChildProcess, graceMs = 3_000): Promise<void> {
  if (exited(child)) return;
  const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  signalGroup(child, "SIGINT");
  for (const [signal, wait] of [["SIGTERM", graceMs], ["SIGKILL", 2_000]] as const) {
    const finished = await Promise.race([done.then(() => true), sleep(wait).then(() => false)]);
    if (finished || exited(child)) return;
    signalGroup(child, signal);
  }
  await Promise.race([done, sleep(2_000)]);
}

export interface RunOptions {
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLine?: (line: string) => void;
  /** Written to agy's stdin, then stdin is closed. Without it stdin is closed at once. */
  input?: string;
}

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; signedOut: boolean }

/** Signed out, agy prints this and then waits a minute for a browser sign-in nobody can do from here. */
const SIGNED_OUT_STDERR = /Authentication required/i;
/** Time agy gets after that line to write its own result (its own words make the better cause) before it is stopped. */
export const SIGNED_OUT_GRACE_MS = 1_500;

/** Run agy to completion, delivering stdout line by line. Rejects with a named error only when agy cannot start. */
export function runAgy(options: RunOptions): Promise<RunResult> {
  const env = options.env ?? process.env;
  const bin = agyBin(env);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, options.args, { cwd: options.cwd, env: env as NodeJS.ProcessEnv, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: posix });
    live.add(child);
    let stdout = "", stderr = "", pending = "", timedOut = false, aborted = false, signedOut = false, stopping: Promise<void> | undefined;
    let authTimer: NodeJS.Timeout | undefined;
    const stop = () => { stopping ??= stopChild(child); return stopping; };
    const flush = (final: boolean) => {
      let at: number;
      while ((at = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, at).replace(/\r$/, ""); pending = pending.slice(at + 1); if (line) options.onLine?.(line); }
      if (final && pending.trim()) { options.onLine?.(pending); pending = ""; }
    };
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-4_000_000);
      pending += chunk;
      flush(false);
    });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8_000);
      if (!authTimer && SIGNED_OUT_STDERR.test(stderr)) authTimer = setTimeout(() => { signedOut = true; void stop(); }, SIGNED_OUT_GRACE_MS);
    });
    const onAbort = () => { aborted = true; void stop(); };
    if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
    // The timeout still fires when a gentler stop is already pending (for example a signed-out stop): it goes straight to SIGKILL.
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; if (stopping) signalGroup(child, "SIGKILL"); else void stop(); }, options.timeoutMs) : undefined;
    timer?.unref();
    const cleanup = () => { clearTimeout(timer); clearTimeout(authTimer); options.signal?.removeEventListener("abort", onAbort); live.delete(child); };
    child.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(error.code === "ENOENT" || error.code === "EACCES"
        ? new AgyError("missing", missingMessage(bin), { cause: error })
        : new AgyError("failed", `agy could not be started: ${cleanAgyText(error.message)}`, { cause: error }));
    });
    if (options.input !== undefined) {
      child.stdin!.on("error", () => { /* agy exited before reading it all */ });
      child.stdin!.end(options.input);
    }
    // Resolve on exit, not close: a tool agy started may hold the pipes open. Kill whatever is left of agy's group, give the
    // pipes a moment to drain, then destroy them so nothing can hang the turn.
    child.once("exit", (code) => {
      signalGroup(child, "SIGKILL");
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(drain);
        child.stdout!.destroy(); child.stderr!.destroy();
        flush(true);
        cleanup();
        resolve({ code, stdout, stderr, timedOut, aborted, signedOut });
      };
      const drain = setTimeout(finish, 500);
      child.once("close", finish);
    });
  });
}

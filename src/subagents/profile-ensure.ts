/**
 * Pre-launch `ensure` hook for a worker profile.
 *
 * A route that needs something running before its first request (an on-demand local model server, a
 * tunnel) is expressed as a `workerProfiles[]` entry with `ensure: { command, release?, timeoutMs? }` in the
 * operator's routing.json. Around every worker launched on that profile USAP:
 *
 *  1. runs `command` (an argv array: no shell, the environment passed through, a bounded timeout);
 *  2. refuses the launch when it exits non-zero, times out or cannot start, with the command's stderr as the
 *     named cause (an implicit wave then falls through to the next chain step, see the extension);
 *  3. otherwise runs the worker, and in a `finally` runs `release` however the worker ended (done, failed,
 *     aborted or thrown). A command that was killed by its timeout or an abort may have taken a lease, so
 *     `release` runs after it too; a command that exited non-zero never ran its work, so it does not.
 *
 * Ensure is idempotent from USAP's side: it runs once per worker launch and `release` once per successful
 * ensure, so a lease-counting command sees exactly matched pairs. The wrapper sits around the shared worker
 * runner, so Pi and claude-code workers get it alike. The command is resolved from the operator's
 * routing.json by the profile id the run recorded; a manifest, a task or a checkpoint never supplies one.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { ENSURE_DEFAULT_TIMEOUT_MS, routingConfig, RoutingConfigError, type ProfileEnsureConfig } from "../routing-config.ts";
import { emptyUsage, type ProfileEnsureReceipt, type RunRecord, type WorkerResult, type WorkerRunContext, type WorkerRunner } from "./types.ts";

/** Prefix of the error a refused launch records. The extension reads it to fall through to the next step. */
export const ENSURE_REFUSAL_PREFIX = "USAP profile ensure refused";
export const isEnsureRefusal = (text: string | undefined): boolean => typeof text === "string" && text.includes(ENSURE_REFUSAL_PREFIX);
/** `release` is cleanup, not a launch gate: it never waits longer than this, whatever `timeoutMs` allows. */
export const RELEASE_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const STDERR_FLUSH_MS = 250;
const STDERR_KEEP = 4_000;
const CAUSE_LIMIT = 480;

export interface EnsureExecResult {
  /** Exit code 0. */
  ok: boolean;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  /** Tail of stderr (bounded). */
  stderr: string;
  /** Why the process could not start at all (for example `ENOENT`). */
  spawnError?: string;
}
export type EnsureExec = (argv: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<EnsureExecResult>;

const printable = (text: string, limit = CAUSE_LIMIT): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);

/** Run an argv with no shell and the process environment. It resolves once the process has exited; a daemon
 * it left behind that still holds stderr does not keep the call waiting. */
export const runEnsureCommand: EnsureExec = (argv, { timeoutMs, signal }) => new Promise((resolve) => {
  let stderr = "";
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const finish = (result: Omit<EnsureExecResult, "stderr" | "timedOut" | "aborted">) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killer);
    signal?.removeEventListener("abort", onAbort);
    resolve({ ...result, timedOut, aborted, stderr: stderr.slice(-STDERR_KEEP) });
  };
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(argv[0], argv.slice(1), { shell: false, stdio: ["ignore", "ignore", "pipe"], env: process.env, cwd: homedir(), windowsHide: true });
  } catch (error) {
    finish({ ok: false, code: null, signal: null, spawnError: (error as NodeJS.ErrnoException).code ?? "spawn failed" });
    return;
  }
  const stop = () => {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    killer ??= setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, KILL_GRACE_MS);
    killer.unref?.();
  };
  function onAbort() { aborted = true; stop(); }
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEEP); });
  child.on("error", (error: NodeJS.ErrnoException) => finish({ ok: false, code: null, signal: null, spawnError: error.code ?? "spawn failed" }));
  child.on("exit", (code, exitSignal) => {
    // Give the last stderr bytes a moment, then stop reading: a server started by the command may keep the pipe.
    const flush = setTimeout(() => { child.stderr?.destroy(); finish({ ok: code === 0 && !timedOut && !aborted, code, signal: exitSignal }); }, STDERR_FLUSH_MS);
    flush.unref?.();
    child.on("close", () => { clearTimeout(flush); finish({ ok: code === 0 && !timedOut && !aborted, code, signal: exitSignal }); });
  });
  timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  timer.unref?.();
  if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
});

/** One launch or release of a profile at a time in this process: a wave starts up to eight workers at once, and
 * a "start the server if it is not running" command must not race itself. Other processes are the command's own
 * business (a lock file); the queue is per profile and a waiter can still be aborted. */
class Turns {
  private tail: Promise<void> = Promise.resolve();
  async acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
    const previous = this.tail;
    let open!: () => void;
    const mine = new Promise<void>((resolve) => { open = resolve; });
    this.tail = previous.then(() => mine);
    if (signal?.aborted) { open(); return undefined; }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"abort">((resolve) => { onAbort = () => resolve("abort"); signal?.addEventListener("abort", onAbort, { once: true }); });
    const outcome = await Promise.race([previous.then(() => "turn" as const), aborted]);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (outcome === "abort") { open(); return undefined; }
    return open;
  }
}
const turnsByProfile = new Map<string, Turns>();
const turnsOf = (profile: string): Turns => {
  let turns = turnsByProfile.get(profile);
  if (!turns) turnsByProfile.set(profile, turns = new Turns());
  return turns;
};

/** Why a command did not succeed, in the words of a receipt (stderr first: it is the command's own cause). */
function causeOf(result: EnsureExecResult, timeoutMs: number): string {
  if (result.spawnError) return `could not start (${result.spawnError})`;
  const detail = printable(result.stderr);
  if (result.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)}s${detail ? `: ${detail}` : ""}`;
  if (result.aborted) return "aborted while it was running";
  const how = result.signal ? `was killed by ${result.signal}` : `exited with code ${result.code}`;
  return detail ? `${detail} (${how})` : how;
}

/** The operator's ensure hook for the profile a run recorded, or undefined when it has none. Only a
 * profile id the run recorded and a profile of the operator's routing.json count; the profile must still
 * serve the route the run froze, so a stale id never starts a server for another model. */
export function ensureOf(run: Pick<RunRecord, "model" | "selection">): { profile: string; ensure: ProfileEnsureConfig } | undefined {
  const id = run.selection?.profile;
  if (!id) return undefined;
  const profile = routingConfig().workerProfiles?.find((candidate) => candidate.id === id);
  if (!profile?.ensure) return undefined;
  if (profile.model !== run.model) {
    throw new RoutingConfigError(`profile ${id} now serves ${profile.model}, not this run's ${run.model}; its ensure hook was not run`);
  }
  return { profile: id, ensure: profile.ensure };
}

const refused = (context: WorkerRunContext, profile: string, cause: string): WorkerResult => {
  context.task.profileEnsure = { profile, state: "refused", cause: printable(cause) };
  return {
    state: context.signal.aborted ? "aborted" : "failed",
    output: "",
    error: `${ENSURE_REFUSAL_PREFIX} (${profile}): ${cause}. The worker was not started.`,
    turns: 0,
    usage: emptyUsage(),
  };
};

/** Wrap a worker runner so a launch on a profile with `ensure` runs the hook around the worker. */
export function withProfileEnsure(runner: WorkerRunner, options: { exec?: EnsureExec } = {}): WorkerRunner {
  const exec = options.exec ?? runEnsureCommand;
  return async (context) => {
    // Only a run that recorded a profile reads the operator file: nothing else changes for it.
    if (!context.run.selection?.profile) return runner(context);
    let hook: ReturnType<typeof ensureOf>;
    try { hook = ensureOf(context.run); }
    catch (error) { return refused(context, context.run.selection.profile, error instanceof Error ? printable(error.message) : "its routing configuration cannot be read"); }
    if (!hook) return runner(context);
    const { profile, ensure } = hook;
    const timeoutMs = ensure.timeoutMs ?? ENSURE_DEFAULT_TIMEOUT_MS;
    context.onProgress({ currentTool: `ensure:${profile}` });
    const turn = await turnsOf(profile).acquire(context.signal);
    if (!turn) return refused(context, profile, "aborted while waiting for another launch of this profile");
    let started: EnsureExecResult;
    try { started = await exec(ensure.command, { timeoutMs, signal: context.signal }); }
    finally { turn(); }
    // A command killed by its timeout or an abort may already hold a lease; one that failed on its own did not.
    const holds = started.ok || started.timedOut || started.aborted;
    try {
      if (!started.ok) return refused(context, profile, causeOf(started, timeoutMs));
      context.task.profileEnsure = { profile, state: "ensured" };
      context.onProgress({ currentTool: undefined });
      return await runner(context);
    } finally {
      if (holds && ensure.release) {
        // Cleanup is never cancelled by the abort that ended the worker, and never throws into the settlement.
        const releaseTurn = await turnsOf(profile).acquire();
        const released = await exec(ensure.release, { timeoutMs: Math.min(timeoutMs, RELEASE_TIMEOUT_MS) }).catch((): EnsureExecResult => ({
          ok: false, code: null, signal: null, timedOut: false, aborted: false, stderr: "", spawnError: "release could not run",
        })).finally(() => releaseTurn?.());
        const previous: ProfileEnsureReceipt | undefined = context.task.profileEnsure;
        const releaseCause = released.ok ? undefined : printable(causeOf(released, Math.min(timeoutMs, RELEASE_TIMEOUT_MS)));
        // A refused launch keeps its refusal as the receipt; a release failure is appended to its cause.
        context.task.profileEnsure = previous?.state === "refused"
          ? { ...previous, ...(releaseCause ? { cause: printable(`${previous.cause ?? ""}; release also failed: ${releaseCause}`) } : {}) }
          : released.ok ? { profile, state: "released" } : { profile, state: "release-failed", cause: releaseCause };
        try { context.onProgress({}); } catch { /* observation only */ }
      }
    }
  };
}

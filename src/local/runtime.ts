/**
 * The on-demand local model server.
 *
 * `ensure` takes a lease for a holder (a Pi session, a worker's host process, or "manual") and starts the
 * server when none is running; `release` lets go. Leases are refcounted per holder. A small supervisor process
 * (this module's `supervise`, run as `steak-pi local _supervise <id>`) owns the llama-server child: when the last
 * lease has been gone for the grace period it stops the server it started and confirms the port is free.
 * Nothing is installed as a service; everything lives under `~/.pi/agent/local/`.
 *
 * Starts are refused, with a named cause, when llama-server is missing, the model file is gone, the disk is above 90%,
 * another model server is running, the port is taken, or free + reclaimable memory cannot hold the model.
 * Everything that touches the machine goes through `Deps`, so the rules are testable with a fake clock and server.
 */
import { execFileSync, spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { availableMemory, diskUsedPercent, DISK_MAX_PERCENT, gib, startNeedBytes } from "./hardware.ts";
import { listProfiles, LocalError, readJson, readProfile, withLock, writeAtomic } from "./store.ts";
import { serverArgs, type LaunchProfile } from "./profile.ts";

export const DEFAULT_GRACE_MS = 10 * 60_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 180_000;
export const MANUAL_HOLDER = "manual";
const POLL_MS = 2000;
const INSTALL_HINT = "install llama.cpp (macOS: brew install llama.cpp; other systems: https://github.com/ggml-org/llama.cpp/releases) or set STEAK_PI_LLAMA_SERVER to the llama-server path";
// Local model servers that must not run next to this one (matched on the executable's name only).
const OTHER_SERVERS = /^(?:llama-server|llama-cli|llama-run|ollama|ollama_llama_server|vllm|sglang|lms)$/;

export interface Holder { count: number; pid?: number; pidStart?: string }
export interface LeaseFile { holders: Record<string, Holder>; idleSince?: number }
export interface ServerRecord {
  id: string; port: number; ctx: number; supervisorPid: number; supervisorStart?: string;
  serverPid?: number; serverStart?: string; startedAt: number; log: string;
}

export interface Deps {
  dir: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Is the process alive (and, when `start` is given, still the same process)? */
  alive(pid: number, start?: string): boolean;
  procStart(pid: number): string | undefined;
  signal(pid: number, signal: NodeJS.Signals, group?: boolean): void;
  health(port: number): Promise<boolean>;
  portFree(port: number): Promise<boolean>;
  availableBytes(): number;
  diskPercent(path: string): number;
  /** Other model servers on this machine, by executable name (never their command lines). */
  otherServers(exclude: number[]): Array<{ pid: number; name: string }>;
  findServerBinary(): string | undefined;
  spawnSupervisor(id: string): number;
  spawnServer(binary: string, args: string[], log: string): { pid: number; exited: Promise<number | null> };
  graceMs: number;
  healthTimeoutMs: number;
}

export class Refused extends LocalError {}
const refuse = (code: string, detail: string): never => { throw new Refused(code, detail); };

// ---- leases ---------------------------------------------------------------------------------------------------------

const leasePath = (deps: Deps): string => join(deps.dir, "leases.json");
const serverPath = (deps: Deps): string => join(deps.dir, "server.json");
export const logPath = (deps: Deps): string => join(deps.dir, "server.log");

function readLeases(deps: Deps): LeaseFile {
  const file = readJson<LeaseFile>(leasePath(deps));
  return file && typeof file.holders === "object" && file.holders ? file : { holders: {} };
}
function saveLeases(deps: Deps, file: LeaseFile): void { writeAtomic(leasePath(deps), `${JSON.stringify(file)}\n`); }

/** Drop holders whose process is gone (same PID and start time); start the idle clock when none remain. */
function prune(deps: Deps, file: LeaseFile): LeaseFile {
  for (const [name, holder] of Object.entries(file.holders)) {
    const dead = holder.pid !== undefined && !deps.alive(holder.pid, holder.pidStart);
    if (dead || holder.count <= 0) delete file.holders[name];
  }
  if (!Object.keys(file.holders).length) file.idleSince ??= deps.now();
  else delete file.idleSince;
  return file;
}

export interface HolderRef { name: string; pid?: number }
/** A holder for a long-lived process: it is dropped when that process exits. */
export const pidHolder = (pid: number): HolderRef => ({ name: `pid:${pid}`, pid });
export const manualHolder = (): HolderRef => ({ name: MANUAL_HOLDER });

/** Take one reference for the holder. Call under the lock. */
function acquireLease(deps: Deps, holder: HolderRef): void {
  const file = prune(deps, readLeases(deps));
  const previous = file.holders[holder.name];
  file.holders[holder.name] = {
    count: holder.name === MANUAL_HOLDER ? 1 : (previous?.count ?? 0) + 1,
    ...(holder.pid !== undefined ? { pid: holder.pid, pidStart: deps.procStart(holder.pid) } : {}),
  };
  delete file.idleSince;
  saveLeases(deps, file);
}
/** Let go of one reference. The last one out starts the idle clock. Call under the lock. */
function releaseLease(deps: Deps, holder: HolderRef): { remaining: number } {
  const file = readLeases(deps);
  const current = file.holders[holder.name];
  if (current) { current.count -= 1; if (current.count <= 0) delete file.holders[holder.name]; }
  prune(deps, file);
  saveLeases(deps, file);
  return { remaining: countOf(file) };
}
const countOf = (file: LeaseFile): number => Object.values(file.holders).reduce((sum, entry) => sum + entry.count, 0);
/** References currently held, and when the server became idle (a read-only view: it never writes, so it needs no lock). */
function peekLeases(deps: Deps): { holders: number; idleSince?: number } {
  const file = readLeases(deps);
  const persisted = file.idleSince;
  prune(deps, file);
  const holders = countOf(file);
  return { holders, ...(holders === 0 && persisted !== undefined ? { idleSince: persisted } : {}) };
}
/** Like `peekLeases`, but also saves the pruned file. Call under the lock. */
function leaseState(deps: Deps): { holders: number; idleMs?: number } {
  const file = prune(deps, readLeases(deps));
  saveLeases(deps, file);
  const holders = countOf(file);
  return { holders, ...(holders === 0 && file.idleSince !== undefined ? { idleMs: deps.now() - file.idleSince } : {}) };
}

// ---- the running server -----------------------------------------------------------------------------------------------

/** The server record when its supervisor (or the server it started) is really still running; stale records are removed. */
function runningServer(deps: Deps): ServerRecord | undefined {
  const record = readJson<ServerRecord>(serverPath(deps));
  if (!record) return undefined;
  const supervisor = deps.alive(record.supervisorPid, record.supervisorStart);
  const server = record.serverPid !== undefined && deps.alive(record.serverPid, record.serverStart);
  if (supervisor || server) return record;
  rmSync(serverPath(deps), { force: true });
  return undefined;
}

async function preflight(deps: Deps, profile: LaunchProfile, running: ServerRecord | undefined): Promise<{ need: number; free: number }> {
  if (!deps.findServerBinary()) refuse("llama-server-missing", `llama-server was not found on PATH; ${INSTALL_HINT}`);
  if (profile.source.kind === "file" && !existsSync(profile.source.path)) refuse("model-missing", `the model file is gone: ${profile.source.path}`);
  const used = deps.diskPercent(profile.source.kind === "file" ? profile.source.path : deps.dir);
  if (used > DISK_MAX_PERCENT) refuse("disk-full", `the disk is ${used.toFixed(0)}% used (limit ${DISK_MAX_PERCENT}%); free space before starting a ${gib(profile.modelBytes)} model`);
  const own = [running?.serverPid, running?.supervisorPid].filter((pid): pid is number => pid !== undefined);
  const other = deps.otherServers(own)[0];
  if (other) refuse("other-server", `PID ${other.pid} (${other.name}) is already running a local model; one model server at a time`);
  if (!(await deps.portFree(profile.port))) refuse("port-busy", `127.0.0.1:${profile.port} is held by a process Steak Pi did not start`);
  const need = startNeedBytes(profile.modelBytes, profile.ctx, profile.kvBytesPerToken);
  const free = deps.availableBytes();
  if (free < need) refuse("insufficient-memory", `starting ${profile.id} needs about ${gib(need)} (weights + KV cache at ${profile.ctx} tokens + server overhead) but only ${gib(free)} is free or reclaimable; close something heavy or lower the context with: steak-pi local add ... --ctx N`);
  return { need, free };
}

export type StartPlan =
  | { kind: "attach"; running: ServerRecord }
  | { kind: "start"; stop?: ServerRecord; need: number; free: number };

/**
 * The one decision `ensure` and `check` both make, without changing anything: attach to the server already running for this
 * model, or start it (first stopping an orphan or an idle server of another model). Throws `Refused` with the named cause
 * when a start would not be allowed. Because `ensure` acts on this exact answer, `check` can never disagree with it.
 */
export async function planStart(deps: Deps, profile: LaunchProfile): Promise<StartPlan> {
  const record = readJson<ServerRecord>(serverPath(deps));
  const supervisorUp = !!record && deps.alive(record.supervisorPid, record.supervisorStart);
  const serverUp = !!record && record.serverPid !== undefined && deps.alive(record.serverPid, record.serverStart);
  let stop: ServerRecord | undefined;
  if (record && (supervisorUp || serverUp)) {
    // A server without its supervisor is an orphan nothing would ever stop: replace it.
    if (supervisorUp && record.id === profile.id) return { kind: "attach", running: record };
    if (supervisorUp) {
      const { holders } = peekLeases(deps);
      if (holders > 0) refuse("other-model-running", `${record.id} is running with ${holders} user(s) attached; one model server at a time (stop it with: steak-pi local stop)`);
    }
    stop = record;
  }
  const { need, free } = await preflight(deps, profile, stop);
  return { kind: "start", ...(stop ? { stop } : {}), need, free };
}

/** Read-only: would `ensure` for this model attach, start, or be refused? Takes no lease and starts nothing. */
export async function check(deps: Deps, id: string): Promise<{ kind: "running"; healthy: boolean } | { kind: "fits"; need: number; free: number }> {
  const profile = requireProfile(deps, id);
  const plan = await planStart(deps, profile);
  if (plan.kind === "attach") return { kind: "running", healthy: await deps.health(profile.port) };
  return { kind: "fits", need: plan.need, free: plan.free };
}

function requireProfile(deps: Deps, id: string): LaunchProfile {
  const profile = readProfile(deps.dir, id);
  if (profile) return profile;
  const known = listProfiles(deps.dir).map((entry) => entry.id);
  throw new LocalError("unknown-model", `no local model "${id}" (${known.length ? `known: ${known.join(", ")}` : "none added yet"}); add one with: steak-pi local add <gguf path or owner/repo:quant>`);
}

const logTail = (path: string): string => {
  try { return readFileSync(path, "utf8").slice(-400).replace(/\s+/g, " ").trim(); } catch { return ""; }
};

export interface EnsureResult { started: boolean; baseUrl: string }

/** Take a lease for `id` and make sure its server is up and healthy. Throws `Refused` (or `LocalError`) with a named cause. */
export async function ensure(deps: Deps, id: string, holder: HolderRef): Promise<EnsureResult> {
  const profile = requireProfile(deps, id);
  let started = false;
  await withLock(deps.dir, async () => {
    runningServer(deps); // drop a stale record before deciding
    const plan = await planStart(deps, profile);
    if (plan.kind === "start") {
      if (plan.stop) await stopRecord(deps, plan.stop);
      started = true;
    }
    acquireLease(deps, holder);
    if (started) {
      try {
        const supervisorPid = deps.spawnSupervisor(profile.id);
        const record: ServerRecord = { id: profile.id, port: profile.port, ctx: profile.ctx, supervisorPid, supervisorStart: deps.procStart(supervisorPid), startedAt: deps.now(), log: logPath(deps) };
        writeAtomic(serverPath(deps), `${JSON.stringify(record)}\n`);
      } catch (error) { releaseLease(deps, holder); throw error; }
    }
  });
  const baseUrl = `http://127.0.0.1:${profile.port}/v1`;
  const deadline = deps.now() + deps.healthTimeoutMs;
  let failure: Refused | undefined;
  while (!failure) {
    if (await deps.health(profile.port)) return { started, baseUrl };
    const record = readJson<ServerRecord>(serverPath(deps));
    if (!record || !deps.alive(record.supervisorPid, record.supervisorStart)) failure = new Refused("server-exited", `llama-server stopped while loading ${profile.id}${logTail(logPath(deps)) ? `; log tail: ${logTail(logPath(deps))}` : ""} (full log: ${logPath(deps)})`);
    else if (deps.now() >= deadline) failure = new Refused("health-timeout", `${profile.id} did not report healthy on port ${profile.port} within ${Math.round(deps.healthTimeoutMs / 1000)}s (the model may still be loading or downloading; see ${logPath(deps)})`);
    else await deps.sleep(1000);
  }
  // A start that did not come up must not keep a lease, nor a server nobody uses.
  await withLock(deps.dir, async () => {
    releaseLease(deps, holder);
    const running = runningServer(deps);
    if (started && running && leaseState(deps).holders === 0) await stopRecord(deps, running);
  });
  throw failure;
}

/** Let go of one reference. The server stops by itself after the grace period once the last one is gone. */
export async function release(deps: Deps, holder: HolderRef): Promise<{ remaining: number }> {
  return withLock(deps.dir, () => releaseLease(deps, holder));
}

async function waitPortFree(deps: Deps, port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  for (;;) {
    if (await deps.portFree(port)) return true;
    if (deps.now() >= deadline) return false;
    await deps.sleep(250);
  }
}

/** Stop what Steak Pi started: the supervisor stops its server in order; if the supervisor is gone, the server it
 * recorded (same PID, same start time) is stopped directly. Resolves once the port is released. */
async function stopRecord(deps: Deps, record: ServerRecord): Promise<{ portReleased: boolean }> {
  // The server gets exactly one SIGTERM, then SIGKILL: a second SIGTERM makes llama.cpp abort mid-shutdown (a Metal
  // assertion, 2026-11-02). A live supervisor sends that SIGTERM itself when asked to stop; only without one does stop send it.
  const supervisor = deps.alive(record.supervisorPid, record.supervisorStart);
  if (supervisor) deps.signal(record.supervisorPid, "SIGTERM");
  const deadline = deps.now() + 30_000;
  while (deps.alive(record.supervisorPid, record.supervisorStart) && deps.now() < deadline) await deps.sleep(250);
  if (record.serverPid !== undefined && deps.alive(record.serverPid, record.serverStart)) {
    if (!supervisor) deps.signal(record.serverPid, "SIGTERM", true);
    const until = deps.now() + 15_000;
    while (deps.alive(record.serverPid, record.serverStart) && deps.now() < until) await deps.sleep(250);
    if (deps.alive(record.serverPid, record.serverStart)) deps.signal(record.serverPid, "SIGKILL", true);
  }
  const portReleased = await waitPortFree(deps, record.port);
  rmSync(serverPath(deps), { force: true });
  return { portReleased };
}

export interface StopResult { stopped: boolean; id?: string; port?: number; portReleased?: boolean; detached: number }
/** `local stop`: stop the server Steak Pi started (even if sessions still hold leases) and clear the leases. */
export async function stop(deps: Deps): Promise<StopResult> {
  return withLock(deps.dir, async () => {
    const record = runningServer(deps);
    const detached = leaseState(deps).holders;
    if (!record) return { stopped: false, detached };
    const { portReleased } = await stopRecord(deps, record);
    saveLeases(deps, { holders: {}, idleSince: deps.now() });
    return { stopped: true, id: record.id, port: record.port, portReleased, detached };
  });
}

export interface Status { running?: ServerRecord; healthy: boolean; holders: number; idleMs?: number; graceMs: number }
export async function status(deps: Deps): Promise<Status> {
  const running = runningServer(deps);
  const { holders, idleSince } = peekLeases(deps);
  return { ...(running ? { running } : {}), healthy: running ? await deps.health(running.port) : false, holders, ...(idleSince !== undefined ? { idleMs: deps.now() - idleSince } : {}), graceMs: deps.graceMs };
}

// ---- the supervisor ---------------------------------------------------------------------------------------------------

export interface SuperviseResult { reason: "idle" | "server-exited" | "signal"; portReleased: boolean }

/** Own the llama-server child of `id`: keep it while leases exist, stop it once idle for the grace period (or on SIGTERM),
 * confirm the port is released and remove the record. `stopRequested` resolves when the supervisor is told to stop. */
export async function supervise(deps: Deps, id: string, stopRequested: Promise<void> = new Promise(() => {})): Promise<SuperviseResult> {
  const profile = readProfile(deps.dir, id);
  const binary = deps.findServerBinary();
  if (!profile || !binary) throw new LocalError(profile ? "llama-server-missing" : "unknown-model", profile ? `llama-server was not found on PATH; ${INSTALL_HINT}` : `no local model "${id}"`);
  const child = deps.spawnServer(binary, serverArgs(profile), logPath(deps));
  let exited = false;
  void child.exited.then(() => { exited = true; });
  let asked = false;
  void stopRequested.then(() => { asked = true; });
  const record = readJson<ServerRecord>(serverPath(deps));
  if (record) writeAtomic(serverPath(deps), `${JSON.stringify({ ...record, serverPid: child.pid, serverStart: deps.procStart(child.pid) })}\n`);
  // The loop only reads the leases (no lock): a stop in progress holds the lock while it waits for this process.
  let idleSince: number | undefined;
  let reason: SuperviseResult["reason"] = "idle";
  for (;;) {
    if (exited) { reason = "server-exited"; break; }
    if (asked) { reason = "signal"; break; }
    const state = peekLeases(deps);
    idleSince = state.holders > 0 ? undefined : state.idleSince ?? idleSince ?? deps.now();
    if (idleSince !== undefined && deps.now() - idleSince >= deps.graceMs) break;
    await Promise.race([deps.sleep(POLL_MS), stopRequested]);
  }
  if (!exited) {
    deps.signal(child.pid, "SIGTERM", true);
    await Promise.race([child.exited, deps.sleep(15_000)]);
    if (!exited) { deps.signal(child.pid, "SIGKILL", true); await Promise.race([child.exited, deps.sleep(5_000)]); }
  }
  const portReleased = await waitPortFree(deps, profile.port);
  rmSync(serverPath(deps), { force: true });
  return { reason, portReleased };
}

// ---- the real machine -------------------------------------------------------------------------------------------------

// A referenced timer: the CLI must stay alive while it waits for /health or a stop (an unref'd timer let Node exit mid-await
// with code 0, so `local ensure` reported success before the server was up and `local stop` left its lock behind).
const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function procStart(pid: number): string | undefined {
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim() || undefined; } catch { return undefined; }
}

export function findOnPath(name: string, path = process.env.PATH ?? ""): string | undefined {
  for (const folder of path.split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return undefined;
}

const envSeconds = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value * 1000 : fallback;
};

export function systemDeps(dir: string): Deps {
  return {
    dir,
    now: () => Date.now(),
    sleep: sleepFor,
    procStart,
    alive: (pid, start) => {
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; }
      return start === undefined || procStart(pid) === start;
    },
    signal: (pid, signal, group) => { try { process.kill(group ? -pid : pid, signal); } catch { /* already gone */ } },
    health: async (port) => {
      try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
    },
    portFree: (port) => new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    }),
    availableBytes: availableMemory,
    diskPercent: diskUsedPercent,
    otherServers: (exclude) => {
      try {
        const listing = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 5000 });
        return listing.split("\n").flatMap((line) => {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          const name = match?.[2].split("/").pop() ?? "";
          return match && OTHER_SERVERS.test(name) && !exclude.includes(Number(match[1])) ? [{ pid: Number(match[1]), name }] : [];
        });
      } catch { return []; }
    },
    findServerBinary: () => {
      const override = process.env.STEAK_PI_LLAMA_SERVER;
      if (override) { try { accessSync(override, constants.X_OK); return override; } catch { return undefined; } }
      return findOnPath("llama-server");
    },
    spawnSupervisor: (id) => {
      // Double fork: a short-lived shell starts the supervisor in the background and exits, so the supervisor belongs to
      // launchd/init, not to the Pi session that asked for it. Closing that session (UltraTerm stops a slot's whole process
      // tree) then leaves the server to its idle grace instead of stopping it on the spot (2026-11-02).
      const log = join(dir, "server.log");
      const main = fileURLToPath(new URL("./main.ts", import.meta.url));
      const out = execFileSync("/bin/sh", ["-c", 'umask 077; "$0" --no-warnings "$1" _supervise "$2" </dev/null >>"$3" 2>&1 & echo $!', process.execPath, main, id, log],
        { encoding: "utf8", env: process.env, cwd: dir, timeout: 10_000 });
      const pid = Number(out.trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new LocalError("supervisor-spawn", `could not start the local server supervisor (got ${JSON.stringify(out.trim().slice(0, 40))})`);
      return pid;
    },
    spawnServer: (binary, args, logFile) => {
      const log = openSync(logFile, "a", 0o600);
      try {
        const child = spawn(binary, args, { detached: true, stdio: ["ignore", log, log], env: process.env, cwd: dir });
        const exited = new Promise<number | null>((resolve) => { child.once("exit", (code) => resolve(code)); child.once("error", () => resolve(null)); });
        return { pid: child.pid ?? 0, exited };
      } finally { closeSync(log); }
    },
    graceMs: envSeconds("STEAK_PI_LOCAL_GRACE_S", DEFAULT_GRACE_MS),
    healthTimeoutMs: envSeconds("STEAK_PI_LOCAL_HEALTH_TIMEOUT_S", DEFAULT_HEALTH_TIMEOUT_MS),
  };
}

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { claudeEscapedOwnedPath, printablePath } from "./claude-owned-paths.ts";

/**
 * Machine-local proof that the installed Claude Code CLI honours backslash escapes in `Edit(...)` permission rules.
 *
 * The owned-path write fence writes `[id]` as `\[id\]`. That is only exact while the CLI reads `\[` as a literal
 * bracket; if an update changed this, the rule would silently become a character class and widen the fence. A version
 * allowlist would break on every CLI update, so instead the behaviour is measured here, on this machine, against the
 * real CLI and a local fake Messages server (no network, no model, a fake key, a throwaway config dir), and the
 * verdict is cached per CLI identity (version, real path, mtime, size). Not proven means refused.
 */

export const ESCAPE_SELFTEST_CACHE_ENV = "STEAK_PI_ESCAPE_SELFTEST_CACHE";
export const ESCAPE_SELFTEST_RUN_TIMEOUT_MS = 30_000;
/** A real failure (the CLI allowed a write the rule should deny, or refused one it should allow) is reused for this long. */
export const ESCAPE_SELFTEST_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** An inconclusive failure (could not run, timed out, could not start) is reused for this long only: a busy machine can cause it. */
export const ESCAPE_SELFTEST_INCONCLUSIVE_RETRY_AFTER_MS = 10 * 60 * 1000;
const CACHE_ENTRY_LIMIT = 16;
const KILL_SETTLE_MS = 3_000;
/** Bumped whenever the case set changes, so a verdict earned with fewer cases is never reused. */
const SELFTEST_REVISION = 3;

export const escapeSelfTestCachePath = (): string =>
  process.env[ESCAPE_SELFTEST_CACHE_ENV] ?? join(homedir(), ".pi", "agent", "usap", "claude-escape-selftest.json");

export interface EscapeVerdict { ok: boolean; version: string; cause?: string }

export interface EscapeSelfTestOptions {
  cachePath?: string;
  now?: () => number;
  /** Per CLI run (default 30 s). */
  timeoutMs?: number;
  /** Where the throwaway directories live. Default: the Steak Pi state directory under the home directory. Measured:
   * the CLI does not match `Edit(...)` rules for paths under the system temporary directory (a plain rule is
   * denied there), so the default must not be a system temp path. */
  workDir?: string;
  /** Test seam for callers: replaces the proof itself. */
  prove?: (executable: string, options: EscapeSelfTestOptions) => Promise<EscapeVerdict>;
  /** Stops the proof when aborted: the child is killed, the server closed, the temp dirs removed, the result is "not
   * proven" and nothing is cached. */
  signal?: AbortSignal;
  /** TEST-ONLY SEAM: skips the proof entirely. Production code paths never set it; a launch with this set is not
   * protected against an escape-ignoring CLI. */
  skip?: boolean;
  /** Environment whose PATH finds a bare command name (the worker's child environment). Default: this process. */
  env?: NodeJS.ProcessEnv;
}

const CANCELLED = "the escape self-test was cancelled";

interface CliIdentity { version: string; key: string }

interface CacheEntry { ok: boolean; cause?: string; at: number; conclusive?: boolean }

function readCache(path: string): Record<string, CacheEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return {};
    const out: Record<string, CacheEntry> = {};
    for (const [key, value] of Object.entries(entries)) {
      const v = value as Partial<CacheEntry> | null;
      if (v && typeof v.ok === "boolean" && typeof v.at === "number" && Number.isFinite(v.at) && (v.cause === undefined || typeof v.cause === "string")) {
        out[key] = { ok: v.ok, at: v.at, ...(v.cause === undefined ? {} : { cause: v.cause }), ...(v.conclusive === true ? { conclusive: true } : {}) };
      }
    }
    return out;
  } catch { return {}; } // missing, unreadable or corrupt: not proven, rerun
}

function writeCache(path: string, entries: Record<string, CacheEntry>): void {
  try {
    const keep = Object.entries(entries).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_ENTRY_LIMIT);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ entries: Object.fromEntries(keep) }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch { /* an unwritable cache only means the proof is not remembered */ }
}

/** A minimal environment: no inherited credentials, no operator configuration. */
function minimalEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.HOME !== undefined) env.HOME = process.env.HOME;
  return { ...env, ...QUIET_ENV, ...extra };
}

/** The self-test talks only to the local fake server: no telemetry, update check, error report or other traffic. */
const QUIET_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_ERROR_REPORTING: "1",
};

interface RunResult { timedOut: boolean; aborted?: boolean; code: number | null; stdout: string; spawnError?: string }

/** Resolves within KILL_SETTLE_MS of a timeout or abort even if `close` never fires (a grandchild may hold stdout open). */
function runProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; input?: string; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let stdout = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(settleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      try { child?.stdout?.destroy(); } catch { /* already closed */ }
      resolve(result);
    };
    const killTree = (): void => {
      if (child === undefined) return;
      try { if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { try { child!.kill("SIGKILL"); } catch { /* already gone */ } }
    };
    const stop = (): void => {
      killTree();
      settleTimer ??= setTimeout(() => finish({ timedOut, aborted, code: null, stdout }), KILL_SETTLE_MS);
    };
    function onAbort(): void { aborted = true; stop(); }
    if (options.signal?.aborted) { resolve({ timedOut: false, aborted: true, code: null, stdout }); return; }
    try {
      child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
    } catch (error) {
      resolve({ timedOut: false, code: null, stdout, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 64_000) stdout += chunk.toString("utf8"); });
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => finish({ timedOut: false, code: null, stdout, spawnError: error.message }));
    // `close` fires after exit and stdio end; the group is killed again so a stray grandchild never outlives the test.
    child.on("close", (code) => { killTree(); finish({ timedOut, aborted, code, stdout }); });
    if (options.input !== undefined) child.stdin?.end(options.input); else child.stdin?.end();
  });
}

/**
 * The absolute PATH candidate a command name resolves to on `env`'s PATH (the environment the worker spawns with), as
 * found and not its realpath (a shim may dispatch on its own name), or undefined when no candidate's realpath is a
 * regular file. The proof and the launch both use this path; the cache identity is keyed on its realpath.
 */
export function resolveClaudeExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates: string[] = [];
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) candidates.push(command);
  else for (const directory of (env.PATH ?? "").split(delimiter)) if (directory !== "") candidates.push(join(directory, command));
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      if (isAbsolute(real) && statSync(real).isFile()) return resolve(candidate);
    } catch { /* next */ }
  }
  return undefined;
}

async function cliIdentity(executable: string, timeoutMs: number, signal?: AbortSignal): Promise<CliIdentity | { error: string }> {
  let real: string;
  let stat;
  try { real = realpathSync(executable); stat = statSync(real); } catch { return { error: "the Claude Code CLI executable could not be inspected" }; }
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), "steak-pi-ver-"));
  try {
    const result = await runProcess(executable, ["--version"], { env: minimalEnv(), cwd, timeoutMs: Math.min(timeoutMs, 10_000), ...(signal ? { signal } : {}) });
    const version = result.stdout.split("\n")[0]?.trim() ?? "";
    if (result.aborted) return { error: CANCELLED };
    if (result.spawnError !== undefined || result.timedOut || result.code !== 0 || version === "") return { error: "the Claude Code CLI did not report a version" };
    const key = createHash("sha256").update(JSON.stringify([SELFTEST_REVISION, version, real, stat.mtimeMs, stat.size])).digest("hex");
    return { version: version.slice(0, 80), key };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The fake Messages API: the first request asks for a Write of `target`; any later request (after a tool result) ends the turn. */
function startFakeApi(target: string): Promise<{ server: Server; port: number; toolResults: () => number }> {
  let counter = 0;
  let toolResults = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { if (body.length < 4_000_000) body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (!request.url?.startsWith("/v1/messages")) { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
      let parsed: { model?: string; messages?: unknown } = {};
      try { parsed = JSON.parse(body || "{}") as typeof parsed; } catch { /* treated as a first request */ }
      const hasResult = JSON.stringify(parsed.messages ?? []).includes("tool_result");
      if (hasResult) toolResults += 1;
      const id = `msg_${++counter}`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }));
      if (!hasResult) {
        response.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${counter}`, name: "Write", input: {} } }));
        response.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: target, content: "x" }) } }));
        response.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
        response.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }));
      } else {
        response.write(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
        response.write(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }));
        response.write(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
        response.write(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }));
      }
      response.write(sse("message_stop", { type: "message_stop" }));
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, toolResults: () => toolResults }));
  });
}

interface EscapeCase { name: string; rule: (root: string) => string; target: (root: string) => string; expectWritten: boolean }

/** One pair (or one exact-file rule) per escaped character class, so each is proven on its own. */
const pair = (label: string, rule: (t: string) => string, deny: (t: string) => string, allow: (t: string) => string): EscapeCase[] => [
  { name: `${label} stays denied`, rule, target: deny, expectWritten: false },
  { name: `${label} literal is allowed`, rule, target: allow, expectWritten: true },
];

const ESCAPE_CASES: EscapeCase[] = [
  ...pair("bracket class", (t) => `Edit(/${t}/\\[id\\]/**)`, (t) => `${t}/i/f.txt`, (t) => `${t}/[id]/f.txt`),
  ...pair("pattern characters", (t) => `Edit(/${t}/d\\*x\\(1\\)\\{a\\}\\!/**)`, (t) => `${t}/dzzx(1){a}!/f.txt`, (t) => `${t}/d*x(1){a}!/f.txt`),
  ...pair("braces", (t) => `Edit(/${t}/x\\{a,b\\}/**)`, (t) => `${t}/xa/f.txt`, (t) => `${t}/x{a,b}/f.txt`),
  ...pair("parentheses with a leading plus", (t) => `Edit(/${t}/+\\(a\\)/**)`, (t) => `${t}/aa/f.txt`, (t) => `${t}/+(a)/f.txt`),
  // An unescaped `!(a)` is a negation: it would allow `b/f.txt` and refuse the literal `!(a)/f.txt`.
  ...pair("exclamation", (t) => `Edit(/${t}/\\!\\(a\\)/**)`, (t) => `${t}/b/f.txt`, (t) => `${t}/!(a)/f.txt`),
  ...pair("exact file with brackets", (t) => `Edit(/${t}/\\[id\\].txt)`, (t) => `${t}/i.txt`, (t) => `${t}/[id].txt`),
];

/** Thrown inside a case when the caller's signal aborts: the run is abandoned and nothing is cached. */
class SelfTestCancelled extends Error {}

/** `conclusive` is true only for a real failure (the CLI ran to the permission check and decided wrongly). */
interface CaseFailure { cause: string; conclusive: boolean }
const inconclusive = (cause: string): CaseFailure => ({ cause, conclusive: false });

async function runCase(executable: string, test: EscapeCase, timeoutMs: number, workDir: string, signal?: AbortSignal): Promise<CaseFailure | undefined> {
  let temp: string | undefined;
  let server: Server | undefined;
  try {
    if (signal?.aborted) throw new SelfTestCancelled();
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    temp = mkdtempSync(join(realpathSync(workDir), "escape-selftest-"));
    // The target tree lives inside the CLI's working directory: it never allows a write outside it, whatever the rules say.
    const work = join(temp, "work");
    const root = join(work, "T");
    const config = join(temp, "cfg");
    for (const dir of [root, work, config]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (/[\s*[\]{}()!?\\,]/u.test(root)) return inconclusive("the temporary directory path contains characters that need escaping");
    const target = test.target(root);
    const api = await startFakeApi(target);
    server = api.server;
    const args = ["--print", "--output-format", "json", "--permission-mode", "dontAsk", "--safe-mode", "--restricted", "--setting-sources", "",
      "--strict-mcp-config", "--tools", "Write,Edit", "--allowedTools", test.rule(root)];
    const env = minimalEnv({ CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ANTHROPIC_API_KEY: "sk-fake-escape-selftest-key" });
    const result = await runProcess(executable, args, { env, cwd: work, input: "go\n", timeoutMs, ...(signal ? { signal } : {}) });
    if (result.aborted || signal?.aborted) throw new SelfTestCancelled();
    if (result.spawnError !== undefined) return inconclusive(`the CLI could not be started (${printablePath(result.spawnError).slice(0, 120)})`);
    if (result.timedOut) return inconclusive(`the check "${test.name}" timed out after ${Math.round(timeoutMs / 1000)} s`);
    // Every case, deny or allow, must prove the CLI ran to the permission check: a clean exit AND a follow-up request
    // carrying the tool result. An absent file alone proves nothing (a crash also leaves it absent).
    if (result.code !== 0) return inconclusive(`the check "${test.name}" could not run: the CLI exited with code ${result.code === null ? "none" : result.code}`);
    if (api.toolResults() < 1) return inconclusive(`the check "${test.name}" could not run: the CLI never reported a tool result to the local server`);
    const written = existsSync(target);
    if (written !== test.expectWritten) {
      return {
        conclusive: true,
        cause: test.expectWritten
          ? `the check "${test.name}" failed: the CLI refused a write the escaped rule should allow`
          : `the check "${test.name}" failed: the CLI allowed a write the escaped rule should deny (it does not read the escape literally)`,
      };
    }
    return undefined;
  } catch (error) {
    if (error instanceof SelfTestCancelled) throw error;
    return inconclusive(`the check "${test.name}" could not run (${printablePath(error instanceof Error ? error.message : String(error)).slice(0, 120)})`);
  } finally {
    if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections?.(); });
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

interface FlightResult { verdict: EscapeVerdict; cancelled: boolean }
const inFlight = new Map<string, Promise<FlightResult>>();

/** Prove (or recall the proof) that this CLI honours backslash escapes. Never throws: every failure is a not-proven verdict. */
export async function proveClaudeEscapes(command: string, options: EscapeSelfTestOptions = {}): Promise<EscapeVerdict> {
  try {
    return await proveUnchecked(command, options);
  } catch (error) {
    return { ok: false, version: "unknown", cause: `the escape self-test could not run (${printablePath(error instanceof Error ? error.message : String(error)).slice(0, 120)})` };
  }
}

/** The flight's result, or undefined when `signal` aborts first. The abort listener is removed once either settles. */
function raceAbort(flight: Promise<FlightResult>, signal?: AbortSignal): Promise<FlightResult | undefined> {
  if (signal === undefined) return flight;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolveRace, rejectRace) => {
    const onAbort = (): void => resolveRace(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    flight.then(resolveRace, rejectRace).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function proveUnchecked(command: string, options: EscapeSelfTestOptions): Promise<EscapeVerdict> {
  // No fallback to the bare command: a name that cannot be resolved on the caller's PATH is never proven.
  const executable = resolveClaudeExecutable(command, options.env);
  if (executable === undefined) return { ok: false, version: "unknown", cause: "the Claude Code CLI was not found" };
  const cachePath = options.cachePath ?? escapeSelfTestCachePath();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? ESCAPE_SELFTEST_RUN_TIMEOUT_MS;
  const workDir = options.workDir ?? join(homedir(), ".pi", "agent", "usap");
  const { signal } = options;
  const cancelled: EscapeVerdict = { ok: false, version: "unknown", cause: CANCELLED };
  for (;;) {
    if (signal?.aborted) return cancelled;
    const identity = await cliIdentity(executable, timeoutMs, signal);
    if ("error" in identity) return { ok: false, version: "unknown", cause: identity.error };
    const flightKey = `${cachePath}\0${identity.key}`;
    let flight = inFlight.get(flightKey);
    const joined = flight !== undefined;
    if (!flight) {
      // The run belongs to the caller that started it; its abort stops it. A joiner whose own signal is still live
      // retries (below) instead of inheriting someone else's cancellation.
      flight = (async (): Promise<FlightResult> => {
        const entries = readCache(cachePath);
        const hit = entries[identity.key];
        if (hit?.ok === true) return { verdict: { ok: true, version: identity.version }, cancelled: false };
        const reuseFor = hit?.conclusive === true ? ESCAPE_SELFTEST_RETRY_AFTER_MS : ESCAPE_SELFTEST_INCONCLUSIVE_RETRY_AFTER_MS;
        if (hit !== undefined && now() - hit.at >= 0 && now() - hit.at < reuseFor) {
          return { verdict: { ok: false, version: identity.version, cause: hit.cause ?? "an earlier self-test failed" }, cancelled: false };
        }
        let failure: CaseFailure | undefined;
        try {
          for (const test of ESCAPE_CASES) {
            failure = await runCase(executable, test, timeoutMs, workDir, signal);
            if (failure !== undefined) break;
          }
        } catch (error) {
          if (error instanceof SelfTestCancelled) return { verdict: { ...cancelled, version: identity.version }, cancelled: true };
          throw error;
        }
        const fresh = readCache(cachePath);
        fresh[identity.key] = failure === undefined ? { ok: true, at: now() } : { ok: false, at: now(), cause: failure.cause, ...(failure.conclusive ? { conclusive: true } : {}) };
        writeCache(cachePath, fresh);
        return { verdict: failure === undefined ? { ok: true, version: identity.version } : { ok: false, version: identity.version, cause: failure.cause }, cancelled: false };
      })().finally(() => inFlight.delete(flightKey));
      inFlight.set(flightKey, flight);
    }
    // The run belongs to its owner; a joiner stops waiting the moment its own signal aborts (the owner's run goes on).
    // The owner always waits for its own flight: that is where its child is killed and its temporary directories removed.
    const result = joined ? await raceAbort(flight, signal) : await flight;
    if (result === undefined) return cancelled;
    if (result.cancelled && !signal?.aborted) continue;
    return result.verdict;
  }
}

/**
 * Fail closed: when any rule the wave emits contains a backslash escape, the escape self-test must pass for this CLI.
 * Rules without one never run it. Throws the operator-facing refusal otherwise. `what` names the offending rule or path.
 */
async function assertProven(needsProof: boolean, what: string, executable: string | undefined, options: EscapeSelfTestOptions): Promise<void> {
  if (!needsProof || options.skip === true) return;
  const refuse = (version: string, cause: string): Error => new Error(
    `claude-code owned path ${JSON.stringify(printablePath(what).slice(0, 1000))} needs an escaped permission rule, and this Claude Code CLI (${printablePath(version).slice(0, 80)}) did not pass the escape self-test: ${cause}`);
  if (executable === undefined) throw refuse("not found", "the Claude Code CLI was not found");
  const verdict = await (options.prove ?? ((command: string) => proveClaudeEscapes(command, options)))(executable, options);
  if (!verdict.ok) throw refuse(verdict.version, verdict.cause ?? "not proven");
}

/** Judged from the rules actually emitted: any backslash means the proof is required. */
export function assertClaudeRulesProven(rules: readonly string[], executable: string | undefined, options: EscapeSelfTestOptions = {}): Promise<void> {
  const escaped = rules.find((rule) => rule.includes("\\"));
  return assertProven(escaped !== undefined, escaped ?? "", executable, options);
}

/** Same, judged from owned paths (the rules their forms would need). */
export function assertClaudeEscapesProven(
  ownedPaths: readonly string[],
  executable: string | undefined,
  resolve?: (value: string) => string | undefined,
  options: EscapeSelfTestOptions = {},
): Promise<void> {
  const escaped = claudeEscapedOwnedPath(ownedPaths, resolve);
  return assertProven(escaped !== undefined, escaped ?? "", executable, options);
}

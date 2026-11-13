import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
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
export const ESCAPE_SELFTEST_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const CACHE_ENTRY_LIMIT = 16;

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
  prove?: (executable: string) => Promise<EscapeVerdict>;
}

interface CliIdentity { version: string; key: string }

interface CacheEntry { ok: boolean; cause?: string; at: number }

function readCache(path: string): Record<string, CacheEntry> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return {};
    const out: Record<string, CacheEntry> = {};
    for (const [key, value] of Object.entries(entries)) {
      const v = value as Partial<CacheEntry> | null;
      if (v && typeof v.ok === "boolean" && typeof v.at === "number" && Number.isFinite(v.at) && (v.cause === undefined || typeof v.cause === "string")) {
        out[key] = { ok: v.ok, at: v.at, ...(v.cause === undefined ? {} : { cause: v.cause }) };
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
  return { ...env, ...extra };
}

interface RunResult { timedOut: boolean; code: number | null; stdout: string; spawnError?: string }

function runProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; input?: string; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    try {
      child = spawn(command, args, { env: options.env, cwd: options.cwd, stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
    } catch (error) {
      resolve({ timedOut: false, code: null, stdout, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }
    const killTree = (): void => {
      try { if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < 64_000) stdout += chunk.toString("utf8"); });
    child.stdin?.on("error", () => undefined);
    child.on("error", (error) => finish({ timedOut: false, code: null, stdout, spawnError: error.message }));
    // `close` fires after exit and stdio end; the group is killed again so a stray grandchild never outlives the test.
    child.on("close", (code) => { killTree(); finish({ timedOut, code, stdout }); });
    if (options.input !== undefined) child.stdin?.end(options.input); else child.stdin?.end();
  });
}

/** A bare command name is looked up on PATH the way the worker's spawn does. */
function locateExecutable(executable: string): string {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) return executable;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, executable);
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return executable;
}

async function cliIdentity(executable: string, timeoutMs: number): Promise<CliIdentity | { error: string }> {
  let real: string;
  let stat;
  try { real = realpathSync(executable); stat = statSync(real); } catch { return { error: "the Claude Code CLI executable could not be inspected" }; }
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), "steak-pi-ver-"));
  try {
    const result = await runProcess(executable, ["--version"], { env: minimalEnv(), cwd, timeoutMs: Math.min(timeoutMs, 10_000) });
    const version = result.stdout.split("\n")[0]?.trim() ?? "";
    if (result.spawnError !== undefined || result.timedOut || result.code !== 0 || version === "") return { error: "the Claude Code CLI did not report a version" };
    const key = createHash("sha256").update(JSON.stringify([version, real, stat.mtimeMs, stat.size])).digest("hex");
    return { version: version.slice(0, 80), key };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The fake Messages API: the first request asks for a Write of `target`; any later request (after a tool result) ends the turn. */
function startFakeApi(target: string): Promise<{ server: Server; port: number }> {
  let counter = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { if (body.length < 4_000_000) body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (!request.url?.startsWith("/v1/messages")) { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return; }
      let parsed: { model?: string; messages?: unknown } = {};
      try { parsed = JSON.parse(body || "{}") as typeof parsed; } catch { /* treated as a first request */ }
      const hasResult = JSON.stringify(parsed.messages ?? []).includes("tool_result");
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
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

interface EscapeCase { name: string; rule: (root: string) => string; target: (root: string) => string; expectWritten: boolean }

const ESCAPE_CASES: EscapeCase[] = [
  { name: "bracket class stays denied", rule: (t) => `Edit(/${t}/\\[id\\]/**)`, target: (t) => `${t}/i/f.txt`, expectWritten: false },
  { name: "literal bracket directory is allowed", rule: (t) => `Edit(/${t}/\\[id\\]/**)`, target: (t) => `${t}/[id]/f.txt`, expectWritten: true },
  { name: "pattern characters stay denied", rule: (t) => `Edit(/${t}/d\\*x\\(1\\)\\{a\\}\\!/**)`, target: (t) => `${t}/dzzx(1){a}!/f.txt`, expectWritten: false },
  { name: "literal pattern characters are allowed", rule: (t) => `Edit(/${t}/d\\*x\\(1\\)\\{a\\}\\!/**)`, target: (t) => `${t}/d*x(1){a}!/f.txt`, expectWritten: true },
];

async function runCase(executable: string, test: EscapeCase, timeoutMs: number, workDir: string): Promise<string | undefined> {
  let temp: string | undefined;
  let server: Server | undefined;
  try {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    temp = mkdtempSync(join(realpathSync(workDir), "escape-selftest-"));
    // The target tree lives inside the CLI's working directory: it never allows a write outside it, whatever the rules say.
    const work = join(temp, "work");
    const root = join(work, "T");
    const config = join(temp, "cfg");
    for (const dir of [root, work, config]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (/[\s*[\]{}()!?\\,]/u.test(root)) return "the temporary directory path contains characters that need escaping";
    const target = test.target(root);
    const api = await startFakeApi(target);
    server = api.server;
    const args = ["--print", "--output-format", "json", "--permission-mode", "dontAsk", "--safe-mode", "--restricted", "--setting-sources", "",
      "--strict-mcp-config", "--tools", "Write,Edit", "--allowedTools", test.rule(root)];
    const env = minimalEnv({ CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`, ANTHROPIC_API_KEY: "sk-fake-escape-selftest-key" });
    const result = await runProcess(executable, args, { env, cwd: work, input: "go\n", timeoutMs });
    if (result.spawnError !== undefined) return `the CLI could not be started (${printablePath(result.spawnError).slice(0, 120)})`;
    if (result.timedOut) return `the check "${test.name}" timed out after ${Math.round(timeoutMs / 1000)} s`;
    const written = existsSync(target);
    if (written !== test.expectWritten) {
      return test.expectWritten
        ? `the check "${test.name}" failed: the CLI refused a write the escaped rule should allow`
        : `the check "${test.name}" failed: the CLI allowed a write the escaped rule should deny (it does not read the escape literally)`;
    }
    return undefined;
  } catch (error) {
    return `the check "${test.name}" could not run (${printablePath(error instanceof Error ? error.message : String(error)).slice(0, 120)})`;
  } finally {
    if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections?.(); });
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

const inFlight = new Map<string, Promise<EscapeVerdict>>();

/** Prove (or recall the proof) that this CLI honours backslash escapes. Never throws. */
export function proveClaudeEscapes(command: string, options: EscapeSelfTestOptions = {}): Promise<EscapeVerdict> {
  const executable = locateExecutable(command);
  const cachePath = options.cachePath ?? escapeSelfTestCachePath();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? ESCAPE_SELFTEST_RUN_TIMEOUT_MS;
  const workDir = options.workDir ?? join(homedir(), ".pi", "agent", "usap");
  return (async (): Promise<EscapeVerdict> => {
    const identity = await cliIdentity(executable, timeoutMs);
    if ("error" in identity) return { ok: false, version: "unknown", cause: identity.error };
    const flightKey = `${cachePath}\0${identity.key}`;
    const running = inFlight.get(flightKey);
    if (running) return running;
    const work = (async (): Promise<EscapeVerdict> => {
      const entries = readCache(cachePath);
      const hit = entries[identity.key];
      if (hit?.ok === true) return { ok: true, version: identity.version };
      if (hit !== undefined && now() - hit.at >= 0 && now() - hit.at < ESCAPE_SELFTEST_RETRY_AFTER_MS) {
        return { ok: false, version: identity.version, cause: hit.cause ?? "an earlier self-test failed" };
      }
      let cause: string | undefined;
      for (const test of ESCAPE_CASES) {
        cause = await runCase(executable, test, timeoutMs, workDir);
        if (cause !== undefined) break;
      }
      const fresh = readCache(cachePath);
      fresh[identity.key] = cause === undefined ? { ok: true, at: now() } : { ok: false, at: now(), cause };
      writeCache(cachePath, fresh);
      return cause === undefined ? { ok: true, version: identity.version } : { ok: false, version: identity.version, cause };
    })().finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, work);
    return work;
  })();
}

/**
 * Fail closed: when any owned path's rule needs a backslash escape, the escape self-test must pass for this CLI.
 * Paths that need no escaping never run it. Throws the operator-facing refusal otherwise.
 */
export async function assertClaudeEscapesProven(
  ownedPaths: readonly string[],
  executable: string | undefined,
  resolve?: (value: string) => string | undefined,
  options: EscapeSelfTestOptions = {},
): Promise<void> {
  const escaped = claudeEscapedOwnedPath(ownedPaths, resolve);
  if (escaped === undefined) return;
  const refuse = (version: string, cause: string): Error => new Error(
    `claude-code owned path ${JSON.stringify(printablePath(escaped).slice(0, 1000))} needs an escaped permission rule, and this Claude Code CLI (${printablePath(version).slice(0, 80)}) did not pass the escape self-test: ${cause}`);
  if (executable === undefined) throw refuse("not found", "the Claude Code CLI was not found");
  const verdict = await (options.prove ?? ((command: string) => proveClaudeEscapes(command, options)))(executable);
  if (!verdict.ok) throw refuse(verdict.version, verdict.cause ?? "not proven");
}

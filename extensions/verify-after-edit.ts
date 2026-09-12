import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };
const DEBOUNCE_MS = 500;
const DEFAULT_FAIL_LIMIT = 2;
const DEFAULT_TIMEOUT_MS = 90_000;
const OUTPUT_TAIL = 4_000;
const FORCE_KILL_MS = 250;
const KILL_SETTLE_MS = 2_000;

export interface VerifyConfig {
  command: string;
  failLimit: number;
  timeoutMs: number;
}

/**
 * Loads `.steak-pi/config.json` → `{ "verify": { "command": ... } }`.
 * Only eligible edit results read config; absent config/command skips verification.
 */
export function loadVerifyConfig(cwd: string): VerifyConfig | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, ".steak-pi", "config.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      verify?: { command?: unknown; failLimit?: unknown; timeoutMs?: unknown };
    };
    const verify = parsed?.verify ?? {};
    const command = verify.command;
    if (typeof command !== "string" || command.trim().length === 0) return null;
    const failLimit =
      typeof verify.failLimit === "number" &&
      Number.isInteger(verify.failLimit) &&
      verify.failLimit > 0
        ? verify.failLimit
        : DEFAULT_FAIL_LIMIT;
    const timeoutMs =
      typeof verify.timeoutMs === "number" &&
      Number.isFinite(verify.timeoutMs) &&
      verify.timeoutMs > 0
        ? verify.timeoutMs
        : DEFAULT_TIMEOUT_MS;
    return { command, failLimit, timeoutMs };
  } catch {
    return null;
  }
}

export function shouldVerify(
  config: VerifyConfig | null,
  toolName: string,
  isError: boolean,
  consecutiveFailures: number,
  nowMs: number,
  lastRunMs: number,
): boolean {
  if (!config) return false;
  if (!EDIT_TOOLS[toolName.toLowerCase()]) return false;
  if (isError) return false;
  if (consecutiveFailures >= config.failLimit) return false;
  return nowMs - lastRunMs >= DEBOUNCE_MS;
}

interface ShellInvocation {
  executable: string;
  args: string[];
}

/**
 * Verification commands keep their existing shell-command semantics. They are
 * passed as one `-c`/`/c` argument to a fixed system shell, never through
 * `shell: true` and never through a project-controlled shell path.
 */
export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ShellInvocation {
  if (platform === "win32") {
    return {
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return { executable: "/bin/sh", args: ["-c", command] };
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_TAIL ? next.slice(-OUTPUT_TAIL) : next;
}

function appendReason(tail: string, reason: string): string {
  return appendTail(tail ? `${tail}\n` : "", reason);
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if process-group termination is unavailable.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

export async function runVerify(
  config: VerifyConfig,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ failed: boolean; tail: string }> {
  if (signal?.aborted) {
    return { failed: true, tail: "verification aborted" };
  }

  const shell = shellInvocation(config.command);
  return await new Promise((resolve) => {
    let tail = "";
    let settled = false;
    let terminationReason: string | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let killSettleTimer: NodeJS.Timeout | undefined;

    const child = spawn(shell.executable, shell.args, {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (killSettleTimer) clearTimeout(killSettleTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (failed: boolean, resultTail: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ failed, tail: failed ? resultTail.slice(-OUTPUT_TAIL) : "" });
    };
    const terminate = (reason: string): void => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      killProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), FORCE_KILL_MS);
      killSettleTimer = setTimeout(
        () => finish(true, appendReason(tail, reason)),
        KILL_SETTLE_MS,
      );
    };
    const onAbort = (): void => terminate("verification aborted");
    const timeoutTimer = setTimeout(
      () => terminate(`verification timed out after ${config.timeoutMs}ms`),
      config.timeoutMs,
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      tail = appendTail(tail, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      tail = appendTail(tail, chunk);
    });
    child.on("error", (error) => {
      finish(true, appendReason(tail, String(error)));
    });
    child.on("close", (code, closeSignal) => {
      if (terminationReason) {
        // The shell may exit before a descendant that ignored SIGTERM. Kill the
        // detached process group once more before clearing the escalation timer.
        killProcessTree(child, "SIGKILL");
        finish(true, appendReason(tail.trim(), terminationReason));
        return;
      }
      if (code !== 0) {
        const resultTail = tail.trim() ||
          (closeSignal ? `verification terminated by ${closeSignal}` : "");
        finish(true, resultTail);
        return;
      }
      finish(false, "");
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function formatAppendix(
  command: string,
  attempt: number,
  limit: number,
  tail: string,
): string {
  return (
    `\n\n[steak-pi] verify failed (attempt ${attempt}/${limit}): ${command}\n` +
    (tail ? tail + "\n" : "") +
    "Fix the reported problem before finishing."
  );
}

/** Hash the Git-visible working subtree, including untracked non-ignored files.
 * Non-Git directories or unreadable trees are explicitly reported as unavailable.
 */
export function verificationTreeHash(cwd: string): string {
  try {
    const names = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const hash = createHash("sha256");
    for (const name of [...new Set(names.split("\0").filter(Boolean))].sort()) {
      const file = path.join(cwd, name);
      hash.update(JSON.stringify(name));
      try {
        const stat = fs.lstatSync(file);
        hash.update(String(stat.mode));
        const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : fs.readFileSync(file);
        hash.update(String(bytes.length) + ":");
        hash.update(bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        hash.update("deleted");
      }
    }
    return hash.digest("hex").slice(0, 16);
  } catch {
    return "unavailable";
  }
}

export default function verifyAfterEditExtension(pi: ExtensionAPI): void {
  let consecutive = 0;
  let running = false;
  let lastEdit = 0;
  let revision = 0;

  pi.on("tool_result", async (event, ctx) => {
    if (!ctx.isProjectTrusted()) return undefined;
    if (event.isError || !EDIT_TOOLS[event.toolName.toLowerCase()]) return undefined;
    lastEdit = performance.now();
    revision += 1;
    // Concurrent edits join the active batch; edits during verification trigger
    // another quiet-period run rather than being lost to a leading-edge throttle.
    if (running) return undefined;
    const config = loadVerifyConfig(ctx.cwd);
    if (!config || consecutive >= config.failLimit) return undefined;
    running = true;
    try {
      while (true) {
        let remaining: number;
        while ((remaining = DEBOUNCE_MS - (performance.now() - lastEdit)) > 0) {
          await new Promise((resolve) => setTimeout(resolve, remaining));
        }
        const batch = revision;
        const tree = verificationTreeHash(ctx.cwd);
        const started = performance.now();
        const { failed, tail } = await runVerify(config, ctx.cwd, ctx.signal);
        const duration = Math.round(performance.now() - started);
        if (failed) {
          consecutive += 1;
          return { content: [...event.content, { type: "text", text:
            formatAppendix(config.command, consecutive, config.failLimit, tail) }] };
        }
        consecutive = 0;
        if (revision !== batch) continue;
        const changed = verificationTreeHash(ctx.cwd) !== tree;
        return { content: [...event.content, { type: "text", text:
          `[steak-pi] verify passed: ${config.command.replace(/\s+/g, " ").trim()} | tree=${tree}${changed ? " (changed during verification)" : ""} | ${duration}ms` }] };
      }
    } finally {
      running = false;
    }
  });
}

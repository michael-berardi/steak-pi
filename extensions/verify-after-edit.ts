import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true };
const DEBOUNCE_MS = 500;
const DEFAULT_FAIL_LIMIT = 2;
const DEFAULT_TIMEOUT_MS = 90_000;
const OUTPUT_TAIL = 4_000;

export interface VerifyConfig {
  command: string;
  failLimit: number;
  timeoutMs: number;
}

/**
 * Loads `.cherry-pi/config.json` → `{ "verify": { "command": ... } }`.
 * No config or no command means the feature is idle: zero overhead.
 */
export function loadVerifyConfig(cwd: string): VerifyConfig | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, ".cherry-pi", "config.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      verify?: { command?: unknown; failLimit?: unknown; timeoutMs?: unknown };
    };
    const verify = parsed?.verify ?? {};
    const command = verify.command;
    if (typeof command !== "string" || command.trim().length === 0) return null;
    const failLimit =
      typeof verify.failLimit === "number" && verify.failLimit > 0
        ? verify.failLimit
        : DEFAULT_FAIL_LIMIT;
    const timeoutMs =
      typeof verify.timeoutMs === "number" && verify.timeoutMs > 0
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

export function runVerify(
  config: VerifyConfig,
  cwd: string,
): { failed: boolean; tail: string } {
  try {
    const result = spawnSync(config.command, {
      shell: true,
      cwd,
      encoding: "utf8",
      timeout: config.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status !== 0) {
      return { failed: true, tail: output.slice(-OUTPUT_TAIL) };
    }
    return { failed: false, tail: "" };
  } catch (error) {
    return { failed: true, tail: String(error).slice(-OUTPUT_TAIL) };
  }
}

export function formatAppendix(
  command: string,
  attempt: number,
  limit: number,
  tail: string,
): string {
  return (
    `\n\n[cherry-pi] verify failed (attempt ${attempt}/${limit}): ${command}\n` +
    (tail ? tail + "\n" : "") +
    "Fix the reported problem before finishing."
  );
}

export default function verifyAfterEditExtension(pi: ExtensionAPI): void {
  let consecutive = 0;
  let lastRunMs = -DEBOUNCE_MS;

  pi.on("tool_result", async (event) => {
    const config = loadVerifyConfig(process.cwd());
    if (!config) return undefined;
    if (
      !shouldVerify(config, event.toolName, event.isError, consecutive, Date.now(), lastRunMs)
    ) {
      return undefined;
    }
    lastRunMs = Date.now();
    const { failed, tail } = runVerify(config, process.cwd());
    if (!failed) {
      consecutive = 0;
      return undefined;
    }
    consecutive += 1;
    if (consecutive >= config.failLimit) {
      // Limit reached: further edits run silently instead of nagging.
      return undefined;
    }
    return {
      content: [
        ...event.content,
        { type: "text", text: formatAppendix(config.command, consecutive, config.failLimit, tail) },
      ],
    };
  });
}

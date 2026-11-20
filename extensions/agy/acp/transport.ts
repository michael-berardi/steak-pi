// Mode selection. ACP is tried when available; headless stays the documented fallback, never a silent one.
import { agyBin, runAgy } from "../process.ts";
import { AgyError, cleanAgyText } from "../errors.ts";

export const TRANSPORT_PI = "STEAK_PI_AGY_TRANSPORT";
export const TRANSPORT_DSH = "STEAK_DSH_AGY_TRANSPORT";
export type AcpTransport = "acp" | "headless" | "auto";

/** DSH names its own override; when both are set DSH's wins so an operator can change one host without the other. */
export function resolveTransport(env: Record<string, string | undefined> = process.env): AcpTransport {
  const raw = env[TRANSPORT_DSH]?.trim() || env[TRANSPORT_PI]?.trim() || "auto";
  if (raw === "acp" || raw === "headless" || raw === "auto") return raw;
  const name = env[TRANSPORT_DSH] ? TRANSPORT_DSH : TRANSPORT_PI;
  throw new AgyError("failed", `${name} must be acp, headless or auto (got "${cleanAgyText(raw, 40)}")`);
}

const logListeners = new Set<(message: string) => void>();
export const acpLogs: string[] = [];
/** Set the single log sink (the Pi extension's `ui.notify`). A fallback always leaves a reason here. */
export function setAcpLog(listener: ((message: string) => void) | undefined): void {
  logListeners.clear();
  if (listener) logListeners.add(listener);
}
export function acpLog(message: string): void {
  acpLogs.push(message);
  if (acpLogs.length > 50) acpLogs.shift();
  for (const listener of logListeners) { try { listener(message); } catch { /* a UI failure must not break transport */ } }
}
export function clearAcpLog(): void { acpLogs.length = 0; }

/** Google's docs: run `agy acp --help` to confirm the installed version has ACP. No credentials or config are touched. */
export async function probeAcpSupport(options: {
  bin?: string; env?: Record<string, string | undefined>; cwd?: string; signal?: AbortSignal; force?: boolean;
} = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const bin = options.bin ?? agyBin(env);
  try {
    const result = await runAgy({
      args: ["acp", "--help"],
      cwd: options.cwd ?? process.cwd(),
      env,
      signal: options.signal,
      timeoutMs: 8_000,
    });
    return result.code === 0 && /acp/i.test(`${result.stdout}\n${result.stderr}`);
  } catch (error) {
    acpLog(`agy acp --help failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

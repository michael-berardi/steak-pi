/**
 * How much of the GPU is in use, read without privileges.
 *
 * macOS exposes the accelerator's own counters in the IORegistry: `ioreg -r -d 1 -w 0 -c IOAccelerator` prints a
 * `PerformanceStatistics` dictionary whose `"Device Utilization %"` is the same number Activity Monitor shows. One
 * sample costs about 0.01 s, so it is taken at a request start and while a start is waiting — never per token.
 * `powermetrics` would need root, so it is not used.
 *
 * Everywhere else, and whenever the probe fails or its answer cannot be parsed, the answer is `unknown`: the headroom
 * check then does nothing and says why, once per session. A probe must never be the reason a request cannot run.
 */
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { PROBE_TIMEOUT_MS, type ProbeSample } from "./limits.ts";

export const IOREG_ARGS = ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"] as const;

/** `"Device Utilization %"=98` from an IORegistry dump, or `undefined` when the dump does not carry it. */
export function parseDeviceUtilization(text: string): number | undefined {
  const match = /"Device Utilization %"\s*=\s*(\d{1,3})/.exec(text);
  if (!match) return undefined;
  const percent = Number(match[1]);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : undefined;
}

export interface GpuProbeDeps {
  platform(): string;
  /** Run a command and return its stdout; `undefined` when it could not be run. */
  run(file: string, args: readonly string[], timeoutMs: number): string | undefined;
  timeoutMs?: number;
}

export type GpuProbe = () => Promise<ProbeSample>;

/** A probe for this machine: `ioreg` on macOS, `unknown` (with the reason) anywhere else. */
export function createGpuProbe(deps: GpuProbeDeps): GpuProbe {
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  return async () => {
    const os = deps.platform();
    if (os !== "darwin") return { kind: "unknown", reason: `no GPU utilisation probe on ${os}` };
    let output: string | undefined;
    try { output = deps.run("ioreg", IOREG_ARGS, timeoutMs); }
    catch (error) { return { kind: "unknown", reason: `ioreg failed: ${(error as Error).message}` }; }
    if (output === undefined) return { kind: "unknown", reason: "ioreg produced no output" };
    const percent = parseDeviceUtilization(output);
    return percent === undefined ? { kind: "unknown", reason: "ioreg output has no Device Utilization %" } : { kind: "util", percent };
  };
}

/** The real probe: one unprivileged `ioreg` read, bounded by a timeout. */
export const systemGpuProbe: GpuProbe = createGpuProbe({
  platform,
  run: (file, args, timeoutMs) => execFileSync(file, [...args], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }),
});

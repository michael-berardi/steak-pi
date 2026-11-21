/**
 * `steak-pi local tune <id>`: hand one added model to the optional `uio` tuner (ultra-inference-optimization).
 *
 * Steak Pi's part is the machine etiquette, not the tuning: it refuses while a hold or the quiet-day rule is on, takes the
 * exclusive "tuning" state (the server stops if idle; any user holding it refuses the run by name), runs `uio tune` on the
 * model's launch profile while streaming its progress, and always gives the state back. `ensure` and `check` refuse with
 * "tuning in progress" until it ends; a marker whose process is gone is not tuning.
 *
 * Nothing here names a model, and nothing is fetched: `uio` is found on this machine or not at all.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath, beginTuning, endTuning, retargetTuning, type Deps } from "./runtime.ts";
import { parseDuration } from "./hold.ts";
import { LocalError, profilePath, readProfile, writeProfile } from "./store.ts";
import type { LaunchProfile } from "./profile.ts";

export const UIO_INSTALL = "curl -fsSL https://github.com/michael-berardi/ultra-inference-optimization/releases/latest/download/install.sh | sh";
export const TARGETS = ["decode", "prefill", "ttft", "balanced"] as const;
export const ALLOWS = ["lossless", "lossy"] as const;

export interface TuneOptions {
  id: string;
  budget?: string;
  target?: string;
  allow?: string;
  apply?: boolean;
  env?: NodeJS.ProcessEnv;
  io: { out(text: string): void; err(text: string): void };
}

const executable = (path: string): boolean => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

/** `STEAK_PI_UIO`, else `uio` on PATH, else `~/.local/bin/uio`. */
export function resolveUio(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const given = env.STEAK_PI_UIO;
  if (given) return executable(given) ? given : undefined;
  const found = findOnPath("uio", env.PATH ?? "");
  if (found) return found;
  const fallback = join(env.HOME || homedir(), ".local", "bin", "uio");
  return executable(fallback) ? fallback : undefined;
}

interface Metrics { decode?: number; prefill?: number; ttft?: number }
const num = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") for (const key of ["median", "value", "tokS", "max", "upper"]) { const inner = num((value as Record<string, unknown>)[key]); if (inner !== undefined) return inner; }
  return undefined;
};
const metricsOf = (side: unknown): Metrics => {
  const o = (side && typeof side === "object" ? side : {}) as Record<string, unknown>;
  return { decode: num(o.decodeTokS), prefill: num(o.prefillTokS), ttft: num(o.ttftMs) };
};
const cell = (value: number | undefined, digits = 1): string => (value === undefined ? "n/a" : value.toFixed(digits));

export interface TuneResult { baseline?: unknown; best?: unknown; ceiling?: unknown; bestArgs?: unknown; accepted?: unknown[]; rejected?: unknown[]; plateau?: boolean; workdir?: string }

export function beforeAfterTable(result: TuneResult): string {
  const before = metricsOf(result.baseline), after = metricsOf(result.best), ceiling = metricsOf(result.ceiling);
  const pct = (m: Metrics): string => (m.decode !== undefined && ceiling.decode ? `${((m.decode / ceiling.decode) * 100).toFixed(0)}%` : "n/a");
  const rows = [
    ["", "before", "after"],
    ["decode tok/s", cell(before.decode), cell(after.decode)],
    ["prefill tok/s", cell(before.prefill), cell(after.prefill)],
    ["TTFT ms", cell(before.ttft, 0), cell(after.ttft, 0)],
    ["ceiling %", pct(before), pct(after)],
  ];
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

const sameArgs = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Returns the exit code: 0 done, 2 refused, 3 the tuner failed. */
export async function tuneModel(deps: Deps, options: TuneOptions): Promise<number> {
  const { io, id } = options;
  const profile = readProfile(deps.dir, id);
  if (!profile) throw new LocalError("unknown-model", `no local model "${id}"`);
  if (options.target !== undefined && !(TARGETS as readonly string[]).includes(options.target)) throw new LocalError("bad-option", `--target must be one of ${TARGETS.join(", ")}`);
  if (options.allow !== undefined && !(ALLOWS as readonly string[]).includes(options.allow)) throw new LocalError("bad-option", `--allow must be one of ${ALLOWS.join(", ")}`);
  if (options.budget !== undefined) parseDuration(options.budget);
  const uio = resolveUio(options.env);
  if (!uio) { io.err(`steak-pi local: REFUSED (uio-missing): the optional tuner uio is not installed; install it with: ${UIO_INSTALL}`); return 2; }

  const { stopped } = await beginTuning(deps, id, process.pid);
  if (stopped) io.out(`stopped local/${stopped} (idle) so the tuner has the machine to itself`);
  let child: ReturnType<typeof spawn> | undefined;
  const forward = (signal: NodeJS.Signals) => () => { if (child?.pid) try { process.kill(child.pid, signal); } catch { /* gone */ } };
  const onTerm = forward("SIGTERM"), onInt = forward("SIGINT");
  process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
  try {
    const args = ["tune", "--profile", profilePath(deps.dir, id),
      ...(options.budget ? ["--budget", options.budget] : []),
      ...(options.target ? ["--target", options.target] : []),
      ...(options.allow ? ["--allow", options.allow] : []),
      ...(options.apply ? ["--apply"] : [])];
    io.out(`tuning local/${id} with ${uio} (progress below; the server stays off until it ends)`);
    const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child = spawn(uio, args, { stdio: ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
      if (child.pid) retargetTuning(deps, child.pid);
      let stdout = "", stderr = "", pending = "";
      child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk; });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk; pending += chunk;
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) io.out(`  uio: ${line}`);
      });
      child.on("error", reject);
      child.on("close", (code) => { if (pending.trim()) io.out(`  uio: ${pending}`); resolve({ code, stdout, stderr }); });
    });
    const lastLine = run.stderr.trim().split("\n").pop() ?? "";
    if (run.code === 2) { io.err(`steak-pi local: REFUSED (uio-refused): ${lastLine || "uio refused the run"}`); return 2; }
    if (run.code !== 0) { io.err(`steak-pi local: uio tune failed (exit ${run.code})${lastLine ? `: ${lastLine}` : ""}`); return 3; }
    let result: TuneResult;
    try { result = JSON.parse(run.stdout.trim().split("\n").filter(Boolean).pop() ?? "") as TuneResult; }
    catch { io.err("steak-pi local: uio tune succeeded but printed no JSON result"); return 3; }
    io.out(beforeAfterTable(result));
    io.out(`${result.plateau ? "plateau reached" : "stopped at the budget"}; ${(result.accepted ?? []).length} change(s) accepted, ${(result.rejected ?? []).length} rejected${result.workdir ? `; record: ${result.workdir}` : ""}`);
    if (!options.apply) {
      const args2 = Array.isArray(result.bestArgs) ? result.bestArgs.join(" ") : "";
      io.out(`not applied; best extraArgs: ${args2 || "(unchanged)"}\nrun again with --apply to write them into the profile`);
      return 0;
    }
    const after: LaunchProfile | undefined = readProfile(deps.dir, id);
    if (!after || !sameArgs(after.extraArgs, result.bestArgs)) {
      io.err(`steak-pi local: uio reported success but the profile's extraArgs are not the best args (${after ? JSON.stringify(after.extraArgs) : "profile missing"}); nothing else was changed`);
      return 3;
    }
    const decode = metricsOf(result.best).decode;
    writeProfile(deps.dir, { ...after, uioLastTune: { at: new Date(deps.now()).toISOString(), workdir: result.workdir ?? "", decodeTokS: decode ?? 0 } });
    io.out(`applied: local/${id} extraArgs are now ${JSON.stringify(after.extraArgs)} (confirmed from the profile; used from the next server start)`);
    return 0;
  } catch (error) {
    if (error instanceof LocalError) throw error;
    io.err(`steak-pi local: could not run uio: ${error instanceof Error ? error.message : String(error)}`);
    return 3;
  } finally {
    process.off("SIGTERM", onTerm); process.off("SIGINT", onInt);
    endTuning(deps);
  }
}

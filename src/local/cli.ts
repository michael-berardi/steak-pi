/**
 * `steak-pi local ...`: slot an OpenAI-compatible local model (a GGUF served by llama-server) into Pi.
 *
 *   add <gguf path | owner/repo[:quant]> [--name id] [--ctx N] [--port N] [-- extra llama-server args]
 *   start [id] | stop | status [id]      run and inspect the on-demand server by hand
 *   ensure <id> | release <id>           argv-friendly lease commands for routing.json `workerProfiles[].ensure`
 *
 * Refusals exit 2 and print one line: `steak-pi local: REFUSED (<cause>): <detail>`.
 */
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readGguf, type GgufInfo } from "./gguf.ts";
import { totalMemory } from "./hardware.ts";
import { HF_SPEC, readHfHeader, resolveHf, type Fetch } from "./hf.ts";
import { DEFAULT_PORT, idFromSource, planProfile, PlanError, type Source } from "./profile.ts";
import { ensure, manualHolder, pidHolder, release, status, stop, supervise, systemDeps, type Deps } from "./runtime.ts";
import { checkId, listProfiles, localDir, LocalError, modelsJsonPath, readProfile, upsertLocalModel, writeProfile } from "./store.ts";

export interface Io { out(text: string): void; err(text: string): void }
export interface CliOptions { io?: Io; deps?: Deps; fetch?: Fetch; totalBytes?: number; modelsJson?: string; ppid?: number }

const USAGE = `usage: steak-pi local <command>
  add <gguf path | owner/repo[:quant]> [--name id] [--ctx N] [--port N] [-- extra llama-server args]
                  slot a model into Pi as local/<id>, sized for this machine
  start [id]      start the server and keep it up until 'stop'
  stop            stop the server Steak Pi started
  status [id]     show the server, its users and the added models
  ensure <id>     take a lease and bring the server up (for routing.json ensure.command)
  release <id>    let go of that lease (for ensure.release); the server stops after an idle grace`;

const SHARD_FIRST = /-00001-of-(\d{5})\.gguf$/i;

function fileSource(path: string): { source: Source; bytes: number; header: string } {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new LocalError("model-missing", `${path} is not a file`);
  const split = SHARD_FIRST.exec(absolute);
  const parts = split ? Array.from({ length: Number(split[1]) }, (_, index) => absolute.replace(SHARD_FIRST, `-${String(index + 1).padStart(5, "0")}-of-${split[1]}.gguf`)) : [absolute];
  const missing = parts.find((part) => !existsSync(part));
  if (missing) throw new LocalError("model-missing", `shard ${basename(missing)} is missing next to ${basename(absolute)}`);
  return { source: { kind: "file", path: absolute }, bytes: parts.reduce((sum, part) => sum + statSync(part).size, 0), header: absolute };
}

async function add(argv: string[], options: CliOptions, io: Io): Promise<number> {
  const split = argv.indexOf("--");
  const own = split < 0 ? argv : argv.slice(0, split);
  const extraArgs = split < 0 ? [] : argv.slice(split + 1);
  const { values, positionals } = parseArgs({ args: own, allowPositionals: true, options: { name: { type: "string" }, ctx: { type: "string" }, port: { type: "string" } } });
  const [target] = positionals;
  if (!target || positionals.length > 1) { io.err(USAGE); return 1; }
  const number = (name: string, text: string | undefined, min: number, max: number): number | undefined => {
    if (text === undefined) return undefined;
    const value = Number(text);
    if (!Number.isInteger(value) || value < min || value > max) throw new LocalError("bad-option", `--${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  const requestedCtx = number("ctx", values.ctx, 1024, 4_194_304);
  const port = number("port", values.port, 1024, 65535) ?? DEFAULT_PORT;
  let source: Source; let info: GgufInfo;
  if (existsSync(resolve(target))) {
    const file = fileSource(target);
    source = file.source;
    info = { ...readGgufOrThrow(file.header), fileBytes: file.bytes };
  } else if (HF_SPEC.test(target) && !target.startsWith(".") && !target.startsWith("/") && !/\.gguf$/i.test(target)) {
    const model = await resolveHf(target, options.fetch);
    source = { kind: "hf", spec: target };
    info = await readHfHeader(model, options.fetch);
  } else throw new LocalError("model-missing", `${target} is not a file, and not an owner/repo[:quant] Hugging Face spec`);
  const id = checkId(values.name ?? idFromSource(source));
  const dir = options.deps?.dir ?? localDir();
  let plan;
  try { plan = planProfile({ id, source, info, modelBytes: info.fileBytes, totalBytes: options.totalBytes ?? totalMemory(), port, requestedCtx, extraArgs }); }
  catch (error) { if (error instanceof PlanError) throw new LocalError(error.code, error.message); throw error; }
  const modelsJson = options.modelsJson ?? modelsJsonPath();
  const { backup } = upsertLocalModel(modelsJson, plan.model as { id: string; baseUrl: string });
  writeProfile(dir, plan.profile);
  io.out([`added local/${id}`, ...plan.lines.map((line) => `  ${line}`),
    `  wrote     ${modelsJson}${backup ? ` (backup ${basename(backup)})` : ""} and ${join(dir, "profiles", `${id}.json`)}`,
    `  use       pi --model local/${id}   (the server starts on demand and stops after an idle grace)`].join("\n"));
  return 0;
}

function readGgufOrThrow(path: string): GgufInfo {
  try { return readGguf(path); }
  catch (error) { throw new LocalError("bad-gguf", `${basename(path)}: ${(error as Error).message}`); }
}

function pickId(dir: string, given: string | undefined): string {
  if (given) return checkId(given);
  const all = listProfiles(dir);
  if (all.length === 1) return all[0].id;
  throw new LocalError("unknown-model", all.length ? `name the model: ${all.map((entry) => entry.id).join(", ")}` : "no local model added yet; add one with: steak-pi local add <gguf path or owner/repo:quant>");
}

const minutes = (ms: number): string => ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)}s`;

export async function main(argv: string[], options: CliOptions = {}): Promise<number> {
  const io = options.io ?? { out: (text) => console.log(text), err: (text) => console.error(text) };
  const [command, ...rest] = argv;
  try {
    const deps = options.deps ?? systemDeps(localDir());
    const holder = () => pidHolder(options.ppid ?? process.ppid);
    switch (command) {
      case "add": return await add(rest, options, io);
      case "start": {
        const id = pickId(deps.dir, rest[0]);
        const result = await ensure(deps, id, manualHolder());
        io.out(`local/${id} ${result.started ? "started" : "already running"} at ${result.baseUrl}; it stays up until: steak-pi local stop`);
        return 0;
      }
      case "stop": {
        const result = await stop(deps);
        io.out(result.stopped
          ? `stopped local/${result.id}; port ${result.port} ${result.portReleased ? "released" : "STILL HELD, check the process list"}${result.detached ? ` (${result.detached} user(s) were still attached)` : ""}`
          : "no server started by Steak Pi is running");
        return result.stopped && !result.portReleased ? 2 : 0;
      }
      case "status": {
        const state = await status(deps);
        const profiles = listProfiles(deps.dir).filter((entry) => !rest[0] || entry.id === rest[0]);
        if (rest[0] && !profiles.length) throw new LocalError("unknown-model", `no local model "${rest[0]}"`);
        io.out([
          state.running ? `server   local/${state.running.id} on port ${state.running.port} (pid ${state.running.serverPid ?? "starting"}), ${state.healthy ? "healthy" : "not healthy yet"}` : "server   stopped",
          `users    ${state.holders}${state.holders ? "" : state.running && state.idleMs !== undefined ? `, idle ${minutes(state.idleMs)} (stops after ${minutes(state.graceMs)} idle)` : ""}`,
          ...profiles.map((entry) => `model    local/${entry.id}  ctx ${entry.ctx}, port ${entry.port}, ${entry.source.kind === "file" ? entry.source.path : entry.source.spec}`),
          ...(profiles.length ? [] : ["model    none added yet"]),
        ].join("\n"));
        return 0;
      }
      case "ensure": {
        if (!rest[0]) { io.err(USAGE); return 1; }
        const result = await ensure(deps, checkId(rest[0]), holder());
        io.out(`ready: local/${rest[0]} at ${result.baseUrl} (${result.started ? "started" : "already running"})`);
        return 0;
      }
      case "release": {
        if (!rest[0]) { io.err(USAGE); return 1; }
        const { remaining } = await release(deps, holder());
        io.out(`released local/${rest[0]}; ${remaining} user(s) remain${remaining ? "" : `; the server stops after ${minutes(deps.graceMs)} idle`}`);
        return 0;
      }
      case "_supervise": {
        if (!rest[0] || !readProfile(deps.dir, rest[0])) return 1;
        const stopped = new Promise<void>((resolveStop) => { for (const name of ["SIGTERM", "SIGINT"] as const) process.once(name, () => resolveStop()); });
        const result = await supervise(deps, rest[0], stopped);
        io.err(`supervisor: local/${rest[0]} stopped (${result.reason}); port ${result.portReleased ? "released" : "STILL HELD"}`);
        return 0;
      }
      default:
        io.err(USAGE);
        return command && command !== "help" && command !== "--help" ? 1 : 0;
    }
  } catch (error) {
    if (error instanceof LocalError) { io.err(`steak-pi local: REFUSED (${error.code}): ${error.message}`); return 2; }
    io.err(`steak-pi local: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}


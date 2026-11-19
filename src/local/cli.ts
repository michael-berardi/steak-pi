/**
 * `steak-pi local ...`: slot an OpenAI-compatible local model (a GGUF served by llama-server) into Pi.
 *
 *   add <gguf path | owner/repo[:quant]> [--name id] [--ctx N] [--port N] [--lora <adapter>]... [--lora-scale S] [--no-adapter] [-- extra llama-server args]
 *   start [id] | stop | status [id]      run and inspect the on-demand server by hand
 *   ensure <id> | release <id>           argv-friendly lease commands for routing.json `workerProfiles[].ensure`
 *
 * `check <id>` is the read-only form of ensure (exit 0 ok, 3 refused, 1 unknown id). Refusals exit 2 and print one line: `steak-pi local: REFUSED (<cause>): <detail>`.
 */
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readGguf, type GgufInfo } from "./gguf.ts";
import { adapterFromFile, adapterFromHub, type AdapterRef, type Download } from "./adapter.ts";
import { findHarnessAdapter, type HarnessAdapterResult, type TrustPrompt } from "./harness-adapter.ts";
import { gib, totalMemory } from "./hardware.ts";
import { HF_SPEC, readHfHeader, resolveHf, type Fetch } from "./hf.ts";
import { DEFAULT_PORT, idFromSource, planProfile, PlanError, type Source } from "./profile.ts";
import { check, ensure, manualHolder, pidHolder, release, status, stop, supervise, systemDeps, type Deps } from "./runtime.ts";
import { promptCapTokens, resolveLimits } from "./limits.ts";
import { activeHold, addQuiet, clearHold, describeHold, markQuietToday, parseDuration, removeQuiet, setHold } from "./hold.ts";
import { checkId, listProfiles, localDir, LocalError, modelsJsonPath, readModelEntry, readProfile, upsertLocalModel, writeProfile } from "./store.ts";

export interface Io { out(text: string): void; err(text: string): void }
export interface CliOptions { io?: Io; deps?: Deps; fetch?: Fetch; download?: Download; totalBytes?: number; modelsJson?: string; ppid?: number; ask?: TrustPrompt }

/** Ask a yes/no question on the terminal; undefined (nobody to ask) when stdin or stdout is not a terminal. */
function terminalAsk(): TrustPrompt | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return async (question) => {
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
  };
}

const USAGE = `usage: steak-pi local <command>
  add <gguf path | owner/repo[:quant]> [--name id] [--ctx N] [--port N] [--lora <file | owner/repo[:file]>]...
      [--lora-scale S] [--no-adapter] [-- extra llama-server args]
                  slot a model into Pi as local/<id>, sized for this machine. When the hub has an adapter trained for
                  this harness on exactly this model, it is fetched, SHA-256 checked, matched and applied; --no-adapter
                  skips that, --lora names an adapter yourself
  start [id]      start the server and keep it up until 'stop'
  stop            stop the server Steak Pi started
  status [id]     show the server, its users and the added models
  ensure <id>     take a lease and bring the server up (for routing.json ensure.command)
  check <id>      would 'ensure' start it? ok (exit 0), REFUSED (exit 3), unknown id (exit 1); starts nothing, but
                  may record that the quiet-day rule fired today
  release <id>    let go of that lease (for ensure.release); the server stops after an idle grace
  hold <N>m|h|d [--replace] [reason]   switch the local model off until then (stops it now); a shorter hold never
                  shortens a longer one still in force unless --replace; 'hold off' ends it
  quiet           show the quiet-day rule: work the local model must not share the machine with
  quiet path <repo dir> | quiet process <name> | quiet remove <dir or name>
                  the first sign of that work on a day keeps the local model off until the next day
  quiet today [reason]     switch it off for the rest of today by hand
  adapter [id] [--trust] | adapter off [id]
                  look for this harness's adapter for a model added before (add does it by itself); --trust
                  trusts its publisher without asking. 'off' stops using it`;

const SHARD_FIRST = /-00001-of-(\d{5})\.gguf$/i;

function fileSource(path: string): { source: Source; bytes: number; header: string; parts: string[] } {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new LocalError("model-missing", `${path} is not a file`);
  const split = SHARD_FIRST.exec(absolute);
  const parts = split ? Array.from({ length: Number(split[1]) }, (_, index) => absolute.replace(SHARD_FIRST, `-${String(index + 1).padStart(5, "0")}-of-${split[1]}.gguf`)) : [absolute];
  const missing = parts.find((part) => !existsSync(part));
  if (missing) throw new LocalError("model-missing", `shard ${basename(missing)} is missing next to ${basename(absolute)}`);
  return { source: { kind: "file", path: absolute }, bytes: parts.reduce((sum, part) => sum + statSync(part).size, 0), header: absolute, parts };
}

async function add(argv: string[], options: CliOptions, io: Io): Promise<number> {
  const split = argv.indexOf("--");
  const own = split < 0 ? argv : argv.slice(0, split);
  const extraArgs = split < 0 ? [] : argv.slice(split + 1);
  const { values, positionals } = parseArgs({ args: own, allowPositionals: true, options: { name: { type: "string" }, ctx: { type: "string" }, port: { type: "string" }, lora: { type: "string", multiple: true }, "lora-scale": { type: "string" }, "no-adapter": { type: "boolean" } } });
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
  const loras = values.lora ?? [];
  if (values["lora-scale"] !== undefined && !loras.length) throw new LocalError("bad-option", "--lora-scale needs --lora");
  const loraScale = values["lora-scale"] === undefined ? 1 : Number(values["lora-scale"]);
  if (!(Number.isFinite(loraScale) && loraScale > 0 && loraScale <= 4)) throw new LocalError("bad-option", "--lora-scale must be a number above 0 and at most 4");
  if (values["no-adapter"] && loras.length) throw new LocalError("bad-option", "--no-adapter and --lora cannot be used together");
  // Local mode looks for the harness adapter by default, so the tensor table is read to match one against the model.
  const tensors = !values["no-adapter"];
  let source: Source; let info: GgufInfo;
  if (existsSync(resolve(target))) {
    const file = fileSource(target);
    source = file.source;
    info = { ...readGgufOrThrow(file.header, tensors), fileBytes: file.bytes };
    // A split model keeps tensors in every shard: an adapter is matched against all of them.
    if (tensors && info.tensors) for (const part of file.parts.slice(1)) {
      let shard: GgufInfo;
      try { shard = readGguf(part, { tensors: true, shard: true }); }
      catch (error) { throw new LocalError("bad-gguf", `${basename(part)}: ${(error as Error).message}`); }
      for (const [name, dims] of shard.tensors ?? []) info.tensors.set(name, dims);
    }
  } else if (HF_SPEC.test(target) && !target.startsWith(".") && !target.startsWith("/") && !/\.gguf$/i.test(target)) {
    const model = await resolveHf(target, options.fetch);
    source = { kind: "hf", spec: target };
    info = await readHfHeader(model, options.fetch, { tensors });
  } else throw new LocalError("model-missing", `${target} is not a file, and not an owner/repo[:quant] Hugging Face spec`);
  if (info.fileType === "adapter") throw new LocalError("bad-source", `${target} is an adapter, not a model; add the base model and pass the adapter with --lora`);
  const id = checkId(values.name ?? idFromSource(source));
  const dir = options.deps?.dir ?? localDir();
  const adapters: AdapterRef[] = [];
  const adapterLines: string[] = [];
  for (const spec of loras) {
    // A path that exists is a file; otherwise an owner/repo[:file] spec is fetched; anything else is named as missing.
    const hub = !existsSync(resolve(spec)) && !spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("~") && HF_SPEC.test(spec) && (spec.includes(":") || !/\.gguf$/i.test(spec));
    const { ref, lines } = !hub
      ? adapterFromFile(spec, info, loraScale)
      : await adapterFromHub(spec, dir, info, loraScale, { list: options.fetch, download: options.download, progress: (text) => io.out(text) });
    adapters.push(ref);
    adapterLines.push(...lines, `lora      ${ref.origin} at scale ${loraScale}`);
  }
  let trained: HarnessAdapterResult["trained"];
  if (!loras.length && !values["no-adapter"]) {
    const found = await findHarnessAdapter(info, source.kind === "hf" ? source : { kind: "file" }, dir, { list: options.fetch, download: options.download, progress: (text) => io.out(text), ask: options.ask ?? terminalAsk() });
    if (found.ref) adapters.push(found.ref);
    trained = found.trained;
    adapterLines.push(...found.lines);
  }
  let plan;
  try { plan = planProfile({ id, source, info, modelBytes: info.fileBytes, totalBytes: options.totalBytes ?? totalMemory(), port, requestedCtx, extraArgs }); }
  catch (error) { if (error instanceof PlanError) throw new LocalError(error.code, error.message); throw error; }
  if (adapters.length) plan.profile.adapters = adapters;
  if (values["no-adapter"]) plan.profile.harnessAdapter = "off";
  if (trained?.thinking === "off" && plan.model.reasoning) plan.profile.trainedThinking = "off";
  const modelsJson = options.modelsJson ?? modelsJsonPath();
  const { backup } = upsertLocalModel(modelsJson, plan.model as { id: string; baseUrl: string });
  writeProfile(dir, plan.profile);
  const limits = resolveLimits(plan.profile);
  const duty = limits.duty ? `${Math.round(limits.duty.target * 100)}% GPU duty cycle, at most ${Math.round(limits.duty.maxGapMs / 1000)}s of idle between requests` : "no duty-cycle pacing";
  const headroom = limits.headroom ? `a start waits while the GPU is at or above ${limits.headroom.highWater}% (until ${limits.headroom.lowWater}% for ${limits.headroom.confirmSamples} samples, at most ${Math.round(limits.headroom.maxDeferMs / 1000)}s)` : "no GPU headroom check";
  io.out([`added local/${id}`, ...plan.lines.map((line) => `  ${line}`), ...adapterLines.map((line) => `  ${line}`),
    `  limits    ${limits.maxOutputTokens} output tokens per request, prompts up to ${promptCapTokens(limits, plan.profile.ctx)} tokens (${Math.round(limits.promptCapRatio * 100)}% of the context) before the local route compacts; ${duty}; ${headroom}. Override any of them under "limits" in the profile file`,
    `  wrote     ${modelsJson}${backup ? ` (backup ${basename(backup)})` : ""} and ${join(dir, "profiles", `${id}.json`)}`,
    `  use       pi --model local/${id}   (the server starts on demand and stops after an idle grace)`].join("\n"));
  return 0;
}

function readGgufOrThrow(path: string, tensors = false): GgufInfo {
  try { return readGguf(path, { tensors }); }
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
          ...(state.orphan ? [`server   local/${state.orphan.id} on port ${state.orphan.port} (pid ${state.orphan.pid}) was orphaned (supervisor gone): ${state.orphan.action === "stopped" ? `stopped (idle past the grace), port ${state.orphan.portReleased ? "released" : "STILL HELD, check the process list"}` : "adopted by a new supervisor"}`] : []),
          state.running ? `server   local/${state.running.id} on port ${state.running.port} (pid ${state.running.serverPid ?? "starting"}), ${state.supervisorGone ? "orphaned (supervisor gone)" : state.healthy ? "healthy" : "not healthy yet"}` : "server   stopped",
          `users    ${state.holders}${state.holders ? "" : state.running && state.idleMs !== undefined ? `, idle ${minutes(state.idleMs)} (stops after ${minutes(state.graceMs)} idle)` : ""}`,
          ...profiles.map((entry) => `model    local/${entry.id}  ctx ${entry.ctx}, port ${entry.port}, ${entry.source.kind === "file" ? entry.source.path : entry.source.spec}${(entry.adapters ?? []).map((adapter) => ` + LoRA ${adapter.origin} x${adapter.scale}`).join("")}`),
          ...(profiles.length ? [] : ["model    none added yet"]),
          ...describeHold(deps.dir, deps.now(), deps.holdProbe),
        ].join("\n"));
        return 0;
      }
      case "ensure": {
        if (!rest[0]) { io.err(USAGE); return 1; }
        const result = await ensure(deps, checkId(rest[0]), holder());
        io.out(`ready: local/${rest[0]} at ${result.baseUrl} (${result.started ? "started" : "already running"})`);
        return 0;
      }
      case "adapter": {
        // Look again for the harness adapter of a model added before (or after an opt-out); `off` opts out.
        const trust = rest.includes("--trust");
        const words = rest.filter((word) => word !== "--trust");
        const id = pickId(deps.dir, words[0] === "off" ? words[1] : words[0]);
        const profile = readProfile(deps.dir, id);
        if (!profile) throw new LocalError("unknown-model", `no local model "${id}"`);
        if (words[0] === "off") {
          writeProfile(deps.dir, { ...profile, adapters: [], harnessAdapter: "off", trainedThinking: undefined });
          io.out(`local/${id} runs without an adapter from its next start (turn it back on with: steak-pi local adapter ${id})`);
          return 0;
        }
        if (profile.source.kind !== "file") throw new LocalError("bad-source", `local/${id} streams its weights from the hub; add it again to look for its adapter`);
        const info = { ...readGgufOrThrow(profile.source.path, true), fileBytes: profile.modelBytes };
        const found = await findHarnessAdapter(info, { kind: "file" }, deps.dir, { list: options.fetch, download: options.download, progress: (text) => io.out(text), strict: true, trust, ask: options.ask ?? terminalAsk() });
        const reasoning = Boolean(readModelEntry(options.modelsJson ?? modelsJsonPath(), id)?.reasoning);
        writeProfile(deps.dir, { ...profile, adapters: found.ref ? [found.ref] : [], harnessAdapter: undefined, trainedThinking: found.trained?.thinking === "off" && reasoning ? "off" : undefined });
        io.out([`local/${id}`, ...found.lines.map((line) => `  ${line}`), "  applied   from the next start of the model server"].join("\n"));
        return 0;
      }
      case "check": {
        if (!rest[0]) { io.err(USAGE); return 1; }
        try {
          const id = checkId(rest[0]);
          const result = await check(deps, id);
          io.out(result.kind === "running"
            ? (result.healthy ? `ok: local/${id} is running` : `ok: local/${id} is up but not healthy yet (still loading, or wedged: see the log in \`steak-pi local status\`)`)
            : `ok: local/${id} fits (needs ${gib(result.need)}, ${gib(result.free)} free)`);
          return 0;
        } catch (error) {
          if (!(error instanceof LocalError)) throw error;
          io.err(`steak-pi local: REFUSED (${error.code}): ${error.message}`);
          return error.code === "unknown-model" || error.code === "bad-id" ? 1 : 3;
        }
      }
      case "release": {
        if (!rest[0]) { io.err(USAGE); return 1; }
        const { remaining } = await release(deps, holder());
        io.out(`released local/${rest[0]}; ${remaining} user(s) remain${remaining ? "" : `; the server stops after ${minutes(deps.graceMs)} idle`}`);
        return 0;
      }
      case "hold": {
        if (!rest[0]) { io.err(USAGE); return 1; }
        if (rest[0] === "off") {
          const cleared = await clearHold(deps.dir);
          const still = activeHold(deps.dir, deps.now(), deps.holdProbe);
          if (cleared.quarantined) io.out(`hold.json could not be read; kept it as ${cleared.quarantined} and started a clean one (the quiet rule in it is gone: add it back from that copy)`);
          io.out(still ? `timed hold ended; still off: ${still.detail}` : "timed hold ended; the local model may run");
          return 0;
        }
        const replace = rest.includes("--replace");
        const words = rest.slice(1).filter((word) => word !== "--replace");
        const until = deps.now() + parseDuration(rest[0]);
        const set = await setHold(deps.dir, until, words.join(" ").trim() || undefined, { replace, now: deps.now() });
        if (set.quarantined) io.out(`hold.json could not be read; kept it as ${set.quarantined} and started a clean one`);
        if (set.kept) io.out(`kept the longer hold already in force; to shorten it use: steak-pi local hold ${rest[0]} --replace`);
        const stopped = await stop(deps);
        io.out(`${activeHold(deps.dir, deps.now(), deps.holdProbe)?.detail ?? "hold set"}${stopped.stopped ? `; stopped local/${stopped.id}, port ${stopped.port} ${stopped.portReleased ? "released" : "STILL HELD, check the process list"}` : ""}`);
        return stopped.stopped && !stopped.portReleased ? 2 : 0;
      }
      case "quiet": {
        const [action, ...words] = rest;
        if (action === "path" || action === "process") {
          if (!words[0]) { io.err(USAGE); return 1; }
          const added = await addQuiet(deps.dir, action, words.join(" "), deps.holdProbe);
          if (added.quarantined) io.out(`hold.json could not be read; kept it as ${added.quarantined} and started a clean one`);
        } else if (action === "remove") {
          if (!words[0]) { io.err(USAGE); return 1; }
          const { removed, file: after } = await removeQuiet(deps.dir, words.join(" "));
          if (after.quarantined) io.out(`hold.json could not be read; kept it as ${after.quarantined} and started a clean one`);
          if (!removed) throw new LocalError("bad-option", `${words.join(" ")} is not in the quiet rule`);
        } else if (action === "today") {
          const marked = await markQuietToday(deps.dir, deps.now(), words.join(" ").trim() || "switched off by hand");
          if (marked.quarantined) io.out(`hold.json could not be read; kept it as ${marked.quarantined} and started a clean one`);
        } else if (action !== undefined) { io.err(USAGE); return 1; }
        // The rule may fire the moment it is written (the program is open, the repository was worked in today): act on it now.
        const held = activeHold(deps.dir, deps.now(), deps.holdProbe);
        const stopped = held ? await stop(deps) : undefined;
        io.out([...describeHold(deps.dir, deps.now(), deps.holdProbe), ...(stopped?.stopped ? [`stopped  local/${stopped.id}, port ${stopped.port} ${stopped.portReleased ? "released" : "STILL HELD, check the process list"}`] : [])].join("\n"));
        return stopped?.stopped && !stopped.portReleased ? 2 : 0;
      }
      case "_supervise": {
        if (!rest[0] || !readProfile(deps.dir, rest[0])) return 1;
        const stopped = new Promise<void>((resolveStop) => { for (const name of ["SIGTERM", "SIGINT"] as const) process.once(name, () => resolveStop()); });
        const adoptPid = Number(process.env.STEAK_PI_ADOPT_PID);
        const adopt = Number.isInteger(adoptPid) && adoptPid > 0 ? { pid: adoptPid, start: process.env.STEAK_PI_ADOPT_START || undefined } : undefined;
        const result = await supervise(deps, rest[0], stopped, adopt);
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


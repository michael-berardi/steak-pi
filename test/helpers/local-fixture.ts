// Fixtures for the local-model module: a synthetic GGUF writer and fake machine dependencies with a fake clock.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../../src/local/runtime.ts";
import type { LaunchProfile } from "../../src/local/profile.ts";
import { writeProfile } from "../../src/local/store.ts";

type Entry = [key: string, kind: "str" | "u32" | "f32" | "u64" | "u32[]" | "str[]", value: unknown];

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string) => { const body = Buffer.from(s, "utf8"); return Buffer.concat([u64(body.length), body]); };

/** A GGUF v3 header with the given metadata and no tensors. */
export function ggufBytes(entries: Entry[]): Buffer {
  const parts: Buffer[] = [Buffer.from("GGUF"), u32(3), u64(0), u64(entries.length)];
  for (const [key, kind, value] of entries) {
    parts.push(str(key));
    switch (kind) {
      case "str": parts.push(u32(8), str(value as string)); break;
      case "u32": parts.push(u32(4), u32(value as number)); break;
      case "u64": parts.push(u32(10), u64(value as number)); break;
      case "f32": { const b = Buffer.alloc(4); b.writeFloatLE(value as number); parts.push(u32(6), b); break; }
      case "u32[]": parts.push(u32(9), u32(4), u64((value as number[]).length)); for (const item of value as number[]) parts.push(u32(item)); break;
      case "str[]": parts.push(u32(9), u32(8), u64((value as string[]).length)); for (const item of value as string[]) parts.push(str(item)); break;
    }
  }
  return Buffer.concat(parts);
}

export interface ModelShape { arch?: string; blocks?: number; heads?: number; kvHeads?: number | number[]; keyLength?: number; interval?: number; ctx?: number; template?: string; sampling?: boolean; tokens?: number }
/** A header shaped like a hybrid model (a KV cache on every 4th layer) unless told otherwise. */
export function modelGguf(shape: ModelShape = {}): Buffer {
  const arch = shape.arch ?? "arch-a";
  const entries: Entry[] = [
    ["general.architecture", "str", arch],
    ["general.name", "str", "Test Model"],
    [`${arch}.context_length`, "u32", shape.ctx ?? 262144],
    [`${arch}.block_count`, "u32", shape.blocks ?? 64],
    [`${arch}.embedding_length`, "u32", 5120],
    [`${arch}.attention.head_count`, "u32", shape.heads ?? 24],
    [`${arch}.attention.key_length`, "u32", shape.keyLength ?? 256],
  ];
  const kvHeads = shape.kvHeads ?? 4;
  entries.push(Array.isArray(kvHeads) ? [`${arch}.attention.head_count_kv`, "u32[]", kvHeads] : [`${arch}.attention.head_count_kv`, "u32", kvHeads]);
  if (shape.interval !== undefined || shape.kvHeads === undefined) entries.push([`${arch}.full_attention_interval`, "u32", shape.interval ?? 4]);
  if (shape.sampling) entries.push(["general.sampling.temp", "f32", 0.5], ["general.sampling.top_k", "u32", 20]);
  // A tokenizer-sized array (about 2 MiB) so the reader must refill its buffer while skipping.
  entries.push(["tokenizer.ggml.tokens", "str[]", Array.from({ length: shape.tokens ?? 200_000 }, (_, i) => `tok${i}`)]);
  if (shape.template !== undefined) entries.push(["tokenizer.chat_template", "str", shape.template]);
  return ggufBytes(entries);
}

export const tempDir = (prefix = "steak-pi-local-"): { path: string; cleanup(): void } => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
};

export function writeGguf(dir: string, name: string, shape?: ModelShape): string {
  const path = join(dir, name);
  writeFileSync(path, modelGguf(shape));
  return path;
}

export const GB = 1e9;
export const GIB = 1024 ** 3;

export interface Fake {
  deps: Deps;
  clock: { t: number };
  alive: Set<number>;
  calls: string[];
  state: { healthy: boolean; healthyAfterMs?: number; portTaken: boolean; others: Array<{ pid: number; name: string }>; available: number; disk: number; binary: string | undefined; spawnedAt?: number };
  signals: Array<{ pid: number; signal: string; group: boolean }>;
}

/** Fake machine: a manual clock that `sleep` advances, a set of live PIDs, and recorded signals. */
export function fakeMachine(dir: string, overrides: Partial<Deps> = {}): Fake {
  const clock = { t: 1_000_000 };
  const alive = new Set<number>([100]);
  const calls: string[] = [];
  const signals: Fake["signals"] = [];
  const state: Fake["state"] = { healthy: false, portTaken: false, others: [], available: 64 * GIB, disk: 40, binary: "/fake/llama-server" };
  let nextPid = 5000;
  const deps: Deps = {
    dir,
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    alive: (pid) => alive.has(pid),
    procStart: (pid) => (alive.has(pid) ? `start-${pid}` : undefined),
    signal: (pid, signal, group) => { signals.push({ pid, signal, group: group === true }); if (signal === "SIGTERM" || signal === "SIGKILL") alive.delete(pid); },
    health: async () => state.healthy || (state.healthyAfterMs !== undefined && state.spawnedAt !== undefined && clock.t - state.spawnedAt >= state.healthyAfterMs),
    portFree: async () => !state.portTaken,
    availableBytes: () => state.available,
    diskPercent: () => state.disk,
    otherServers: (exclude) => state.others.filter((entry) => !exclude.includes(entry.pid)),
    findServerBinary: () => state.binary,
    spawnSupervisor: (id) => { calls.push(`supervisor:${id}`); const pid = nextPid++; alive.add(pid); state.spawnedAt = clock.t; return pid; },
    spawnServer: () => { throw new Error("not used"); },
    graceMs: 600_000,
    healthTimeoutMs: 30_000,
    ...overrides,
  };
  return { deps, clock, alive, calls, state, signals };
}

export function profileFor(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    id: "model-a", source: { kind: "file", path: "/nonexistent/model-a.gguf" }, ctx: 32768, port: 18089,
    modelBytes: 12 * GB, kvBytesPerToken: 34816, extraArgs: [], ...overrides,
  };
}

/** Write a profile whose model file really exists (a placeholder), so the model-missing refusal does not fire. */
export function seedProfile(dir: string, overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${overrides.id ?? "model-a"}.gguf`);
  writeFileSync(file, "x");
  const profile = profileFor({ source: { kind: "file", path: file }, ...overrides });
  writeProfile(dir, profile);
  return profile;
}

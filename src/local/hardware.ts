/**
 * What a local model costs on this machine, and what this machine can spare.
 *
 * The constraints come from running one model server next to a normal working session:
 *  - one model server at a time, one parallel slot, flash attention, a q8_0 KV cache;
 *  - 6 GiB of RAM stay free for the system and the rest of the session, so weights + KV cache must fit
 *    in `total - 6 GiB`;
 *  - the server also needs a compute buffer and a bounded prompt cache (SERVER_OVERHEAD_BYTES);
 *  - the context is capped at 32768 tokens unless the operator asks for more, and rounded down to a power of two;
 *  - nothing starts while the disk is above 90% used.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statfsSync } from "node:fs";
import { freemem, platform, totalmem } from "node:os";
import type { GgufInfo } from "./gguf.ts";

export const GIB = 1024 ** 3;
export const HEADROOM_BYTES = 6 * GIB;
export const DEFAULT_CTX_CAP = 32768;
export const MIN_CTX = 8192;
/** q8_0 stores 32 values in 34 bytes. */
export const KV_BYTES_PER_ELEMENT = 34 / 32;
export const CACHE_RAM_MIB = 2048;
/** Compute buffers (about 1 GiB) plus the bounded prompt cache. */
export const SERVER_OVERHEAD_BYTES = GIB + CACHE_RAM_MIB * 1024 * 1024;
/** Used when the file does not describe its attention shape: a deliberately generous 128 KiB per token. */
export const FALLBACK_KV_BYTES_PER_TOKEN = 128 * 1024;
export const DISK_MAX_PERCENT = 90;

export interface KvEstimate { bytesPerToken: number; estimated: boolean }

/** KV-cache bytes per token at q8_0, from the attention shape in the metadata. */
export function kvBytesPerToken(info: Pick<GgufInfo, "kvHeadsPerLayer" | "keyLength" | "valueLength" | "embeddingLength" | "headCount">): KvEstimate {
  const keyLength = info.keyLength ?? (info.embeddingLength && info.headCount ? info.embeddingLength / info.headCount : undefined);
  if (!info.kvHeadsPerLayer?.length || !keyLength) return { bytesPerToken: FALLBACK_KV_BYTES_PER_TOKEN, estimated: true };
  const valueLength = info.valueLength ?? keyLength;
  const elements = info.kvHeadsPerLayer.reduce((sum, heads) => sum + heads, 0) * (keyLength + valueLength);
  return { bytesPerToken: Math.ceil(elements * KV_BYTES_PER_ELEMENT), estimated: false };
}

export const floorPow2 = (n: number): number => n >= 1 ? 2 ** Math.floor(Math.log2(n)) : 0;

export interface SizeInput {
  totalBytes: number;
  modelBytes: number;
  kvBytesPerToken: number;
  /** The model's native context, when the file says. */
  nativeCtx?: number;
  /** The operator's `--ctx`; a ceiling, not a promise. */
  requestedCtx?: number;
}
export type SizeResult =
  | { ok: true; ctx: number; kvBytes: number; roomBytes: number; fitCtx: number; cap: number; capReason: string; shrunkFrom?: number }
  | { ok: false; cause: "model-too-large" | "context-too-small"; detail: string };

export const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

/** The largest power-of-two context whose weights + KV cache fit in `total - headroom`, within the cap. */
export function sizeContext(input: SizeInput): SizeResult {
  const roomBytes = input.totalBytes - HEADROOM_BYTES - input.modelBytes;
  if (roomBytes <= 0) {
    return { ok: false, cause: "model-too-large", detail: `${gib(input.modelBytes)} of weights plus ${gib(HEADROOM_BYTES)} of headroom do not fit in ${gib(input.totalBytes)} of RAM` };
  }
  const fitCtx = Math.floor(roomBytes / input.kvBytesPerToken);
  let cap = input.requestedCtx ?? DEFAULT_CTX_CAP;
  let capReason = input.requestedCtx ? `your --ctx ${input.requestedCtx}` : `the default ${DEFAULT_CTX_CAP} cap`;
  if (input.nativeCtx && input.nativeCtx < cap) { cap = input.nativeCtx; capReason = `the model's native ${input.nativeCtx}`; }
  const ctx = floorPow2(Math.min(fitCtx, cap));
  if (ctx < MIN_CTX) {
    return { ok: false, cause: "context-too-small", detail: `only ${ctx} tokens of context would fit (${gib(roomBytes)} left after weights and headroom; ${MIN_CTX} is the minimum a coding session needs)` };
  }
  const shrunkFrom = input.requestedCtx && ctx < floorPow2(input.requestedCtx) ? input.requestedCtx : undefined;
  return { ok: true, ctx, kvBytes: ctx * input.kvBytesPerToken, roomBytes, fitCtx, cap, capReason, ...(shrunkFrom ? { shrunkFrom } : {}) };
}

/** RAM a start needs: weights + KV cache at the profile's context + the server's own overhead. */
export const startNeedBytes = (modelBytes: number, ctx: number, kvPerToken: number): number => modelBytes + ctx * kvPerToken + SERVER_OVERHEAD_BYTES;

export const totalMemory = (): number => totalmem();

/** Memory that can be had without swapping: free + reclaimable (file cache, inactive, purgeable). */
export function availableMemory(): number {
  try {
    if (platform() === "darwin") {
      const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 5000 });
      const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384);
      const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * page;
    }
    if (platform() === "linux") {
      const kb = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
      if (kb) return Number(kb) * 1024;
    }
  } catch { /* fall through to the portable figure */ }
  return freemem();
}

/** Percent of the disk holding `path` that is in use. */
export function diskUsedPercent(path: string): number {
  const stats = statfsSync(path);
  return stats.blocks ? (1 - stats.bavail / stats.blocks) * 100 : 0;
}

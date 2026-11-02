/**
 * A tiny GGUF header reader: only the key/value metadata, never the tensors, and never the whole file.
 *
 * It answers what a local profile needs to size itself: the architecture, the native context length, the
 * attention shape (for the KV-cache cost per token) and the chat template (for the reasoning controls).
 * Big arrays (the tokenizer) are skipped without being kept. Little-endian GGUF v2 and v3 only.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export class GgufError extends Error {}

type Scalar = number | string | boolean;
type Value = Scalar | number[];

export interface GgufInfo {
  fileBytes: number;
  version: number;
  architecture: string;
  name?: string;
  /** Native training context, tokens. */
  contextLength?: number;
  blockCount?: number;
  embeddingLength?: number;
  headCount?: number;
  /** Key/value heads of every layer (0 = the layer keeps no KV cache), when the attention shape is known. */
  kvHeadsPerLayer?: number[];
  keyLength?: number;
  valueLength?: number;
  chatTemplate?: string;
  /** Sampling defaults the file itself carries (`general.sampling.*`), if any. */
  sampling: { temperature?: number; top_p?: number; top_k?: number; min_p?: number };
}

const SCALAR_BYTES = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];
const STRING = 8;
const ARRAY = 9;
const KEEP_ARRAY_MAX = 4096;
const KEEP_STRING_MAX = 512 * 1024;
const MAX_KEYS = 100_000;

class Reader {
  private readonly buffer = Buffer.alloc(1 << 20);
  private start = 0;
  private length = 0;
  pos = 0;
  private readonly fd: number;
  constructor(fd: number) { this.fd = fd; }

  private take(n: number): Buffer {
    if (this.pos < this.start || this.pos + n > this.start + this.length) {
      this.length = readSync(this.fd, this.buffer, 0, this.buffer.length, this.pos);
      this.start = this.pos;
      if (this.length < n) throw new GgufError("the header is truncated");
    }
    const at = this.pos - this.start;
    this.pos += n;
    return this.buffer.subarray(at, at + n);
  }
  u32(): number { return this.take(4).readUInt32LE(0); }
  u64(): number {
    const value = this.take(8).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new GgufError("the header holds an implausibly large length");
    return Number(value);
  }
  skip(n: number): void { this.pos += n; }
  /** A string, or undefined (skipped) when it is longer than `max`. */
  string(max = KEEP_STRING_MAX): string | undefined {
    const n = this.u64();
    if (n > max) { this.skip(n); return undefined; }
    return this.take(n).toString("utf8");
  }
  scalar(type: number): number | boolean {
    const bytes = this.take(SCALAR_BYTES[type]);
    switch (type) {
      case 0: return bytes.readUInt8(0);
      case 1: return bytes.readInt8(0);
      case 2: return bytes.readUInt16LE(0);
      case 3: return bytes.readInt16LE(0);
      case 4: return bytes.readUInt32LE(0);
      case 5: return bytes.readInt32LE(0);
      case 6: return Number(bytes.readFloatLE(0).toPrecision(7)); // float32 carries about 7 digits: 0.95, not 0.949999988
      case 7: return bytes.readUInt8(0) !== 0;
      case 10: return Number(bytes.readBigUInt64LE(0));
      case 11: return Number(bytes.readBigInt64LE(0));
      default: return bytes.readDoubleLE(0);
    }
  }
}

function skipValue(reader: Reader, type: number): void {
  if (type === STRING) { reader.string(0); return; }
  if (type === ARRAY) {
    const inner = reader.u32();
    const count = reader.u64();
    if (inner === STRING || inner === ARRAY) for (let i = 0; i < count; i++) skipValue(reader, inner);
    else reader.skip(count * validType(inner));
    return;
  }
  reader.skip(validType(type));
}
function validType(type: number): number {
  const bytes = SCALAR_BYTES[type];
  if (!bytes) throw new GgufError(`unknown value type ${type}`);
  return bytes;
}

function readValue(reader: Reader, type: number): Value | undefined {
  if (type === STRING) return reader.string();
  if (type !== ARRAY) { validType(type); return reader.scalar(type); }
  const inner = reader.u32();
  const count = reader.u64();
  if (inner === STRING || inner === ARRAY || count > KEEP_ARRAY_MAX) {
    if (inner === STRING || inner === ARRAY) for (let i = 0; i < count; i++) skipValue(reader, inner);
    else reader.skip(count * validType(inner));
    return undefined;
  }
  validType(inner);
  const items: number[] = [];
  for (let i = 0; i < count; i++) items.push(Number(reader.scalar(inner)));
  return items;
}

const num = (value: Value | undefined): number | undefined => typeof value === "number" ? value : undefined;
const max = (value: Value | undefined): number | undefined => Array.isArray(value) ? Math.max(...value) : num(value);

/** Read the metadata of a GGUF file (the first shard of a split model is enough). */
export function readGguf(path: string): GgufInfo {
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch (error) { throw new GgufError(`cannot open ${path} (${(error as NodeJS.ErrnoException).code ?? "error"})`); }
  try {
    const reader = new Reader(fd);
    if (reader.u32() !== 0x46554747) throw new GgufError("not a GGUF file (bad magic)");
    const version = reader.u32();
    if (version !== 2 && version !== 3) throw new GgufError(`GGUF version ${version} is not supported (2 and 3 are)`);
    reader.u64(); // tensor count
    const keys = reader.u64();
    if (keys > MAX_KEYS) throw new GgufError("the header claims an implausible number of keys");
    const kv = new Map<string, Value>();
    for (let i = 0; i < keys; i++) {
      const key = reader.string(4096);
      if (key === undefined) throw new GgufError("the header holds an oversized key");
      const value = readValue(reader, reader.u32());
      if (value !== undefined) kv.set(key, value);
    }
    const architecture = kv.get("general.architecture");
    if (typeof architecture !== "string") throw new GgufError("the file has no general.architecture");
    const arch = (suffix: string) => kv.get(`${architecture}.${suffix}`);
    const blockCount = num(arch("block_count"));
    const headCount = max(arch("attention.head_count"));
    const kvHeads = arch("attention.head_count_kv");
    const interval = num(arch("full_attention_interval"));
    let kvHeadsPerLayer: number[] | undefined;
    if (blockCount) {
      if (Array.isArray(kvHeads)) kvHeadsPerLayer = kvHeads.slice(0, blockCount);
      else {
        const heads = num(kvHeads) ?? headCount;
        // A hybrid model keeps a KV cache only on every `interval`-th layer.
        if (heads !== undefined) kvHeadsPerLayer = Array.from({ length: blockCount }, (_, layer) => (!interval || interval <= 1 || (layer + 1) % interval === 0 ? heads : 0));
      }
    }
    const sampling: GgufInfo["sampling"] = {};
    for (const [from, to] of [["temp", "temperature"], ["top_p", "top_p"], ["top_k", "top_k"], ["min_p", "min_p"]] as const) {
      const value = num(kv.get(`general.sampling.${from}`));
      if (value !== undefined && Number.isFinite(value)) sampling[to] = value;
    }
    const template = kv.get("tokenizer.chat_template");
    const name = kv.get("general.name");
    return {
      fileBytes: fstatSync(fd).size,
      version,
      architecture,
      ...(typeof name === "string" ? { name } : {}),
      contextLength: num(arch("context_length")),
      blockCount,
      embeddingLength: num(arch("embedding_length")),
      headCount,
      kvHeadsPerLayer,
      keyLength: num(arch("attention.key_length")),
      valueLength: num(arch("attention.value_length")),
      ...(typeof template === "string" ? { chatTemplate: template } : {}),
      sampling,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * LoRA adapters for a local model: an optional, separately downloaded GGUF that llama-server applies on top of the base
 * weights (`--lora`). Nothing ships with Steak Pi; an adapter is fetched only when the operator adds one, into
 * `~/.pi/agent/local/adapters/`, and checked against the SHA-256 the hub publishes before it is used.
 *
 * Before an adapter is accepted it is matched against the base model, tensor by tensor: it must be a LoRA adapter
 * file, for the same architecture, and every `<name>.lora_a` / `<name>.lora_b` pair must fit a base tensor of that
 * name. A mismatch is refused by name, so an adapter for another model never reaches the server.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readGguf, type GgufInfo } from "./gguf.ts";
import { HF_SPEC } from "./hf.ts";
import { LocalError } from "./errors.ts";

export interface AdapterRef {
  /** Absolute path of the adapter GGUF. */
  path: string;
  /** Scale passed to llama-server (`--lora-scaled path:scale`); 1 is the trained strength. */
  scale: number;
  bytes: number;
  /** Where it came from: a file the operator gave, or `owner/repo:file` on the hub. */
  origin: string;
  sha256?: string;
}

/** Largest adapter accepted. A LoRA of any rank used in practice is far below this; a bigger file is a full model. */
export const MAX_ADAPTER_BYTES = 4 * 1024 ** 3;

const readHeader = (path: string, tensors: boolean): GgufInfo => {
  try { return readGguf(path, { tensors }); }
  catch (error) { throw new LocalError("bad-adapter", `${basename(path)}: ${(error as Error).message}`); }
};

export interface AdapterCheck { lines: string[] }

/**
 * Match an adapter against its base. `base` must have been read with `{ tensors: true }`. Throws `bad-adapter` naming
 * the first mismatch; returns what was checked.
 */
export function checkAdapter(adapter: GgufInfo, base: GgufInfo, adapterName: string): AdapterCheck {
  if (adapter.fileType !== "adapter" || adapter.adapterType !== "lora") {
    throw new LocalError("bad-adapter", `${adapterName} is not a LoRA adapter (general.type ${adapter.fileType ?? "missing"}, adapter.type ${adapter.adapterType ?? "missing"}); a full model is added with: steak-pi local add <file>`);
  }
  if (adapter.architecture !== base.architecture) {
    throw new LocalError("bad-adapter", `${adapterName} is for architecture ${adapter.architecture}, the base model is ${base.architecture}`);
  }
  if (!adapter.tensors?.size) throw new LocalError("bad-adapter", `${adapterName} holds no tensors`);
  if (!base.tensors?.size) throw new LocalError("bad-adapter", "the base model's tensor table could not be read, so the adapter cannot be checked against it");
  const pairs = new Map<string, { a?: number[]; b?: number[] }>();
  for (const [name, dims] of adapter.tensors) {
    const match = /^(.*)\.lora_([ab])$/.exec(name);
    if (!match) throw new LocalError("bad-adapter", `${adapterName}: unexpected tensor ${name} (only <name>.lora_a / <name>.lora_b are allowed)`);
    const entry = pairs.get(match[1]) ?? {};
    entry[match[2] as "a" | "b"] = dims;
    pairs.set(match[1], entry);
  }
  let rank: number | undefined;
  for (const [name, { a, b }] of pairs) {
    if (!a || !b) throw new LocalError("bad-adapter", `${adapterName}: ${name} has lora_${a ? "a" : "b"} without lora_${a ? "b" : "a"}`);
    const target = base.tensors.get(name);
    if (!target) throw new LocalError("bad-adapter", `${adapterName} adapts ${name}, which the base model does not have: it was made for another model`);
    if (a.length !== 2 || b.length !== 2 || target.length !== 2) {
      throw new LocalError("bad-adapter", `${adapterName}: ${name} is a ${Math.max(a.length, b.length, target.length)}-D adaptation (for example of expert tensors), which this check does not cover; it is refused rather than passed unchecked`);
    }
    // GGUF lists dimensions innermost first: base [in, out], lora_a [in, r], lora_b [r, out]. The token embedding is the
    // one llama.cpp stores with A and B swapped (it is looked up, not multiplied): base [n_embd, n_vocab] fits b[1], a[1].
    const embedding = /(^|\.)token_embd\.weight$/.test(name);
    const fits = embedding ? target[0] === b[1] && target[1] === a[1] && a[0] === b[0] : a[0] === target[0] && b[1] === target[1] && a[1] === b[0];
    if (!fits) {
      throw new LocalError("bad-adapter", `${adapterName}: ${name} has shape lora_a ${JSON.stringify(a)} / lora_b ${JSON.stringify(b)}, which does not fit the base tensor ${JSON.stringify(target)}: it was made for another model`);
    }
    const r = embedding ? a[0] : a[1];
    rank = rank === undefined ? r : Math.max(rank, r);
  }
  return { lines: [`adapter   LoRA rank ${rank}${adapter.loraAlpha !== undefined ? `, alpha ${adapter.loraAlpha}` : ""}, ${pairs.size} base tensors adapted; every shape matches the base model`] };
}

/** Read an adapter file given by path and check it against the base. */
export function adapterFromFile(path: string, base: GgufInfo, scale: number): { ref: AdapterRef; lines: string[] } {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new LocalError("adapter-missing", `${path} is not a file`);
  const bytes = statSync(absolute).size;
  if (bytes > MAX_ADAPTER_BYTES) throw new LocalError("bad-adapter", `${basename(absolute)} is ${(bytes / 1024 ** 3).toFixed(1)} GiB, larger than any LoRA adapter (limit ${MAX_ADAPTER_BYTES / 1024 ** 3} GiB)`);
  const { lines } = checkAdapter(readHeader(absolute, true), base, basename(absolute));
  return { ref: { path: absolute, scale, bytes, origin: absolute }, lines };
}

export type Download = (url: string, headers: Record<string, string>, target: string, onBytes?: (bytes: number) => void) => Promise<void>;
export type ListFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const hfHeaders = (): Record<string, string> => process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};

/** Stream a URL to a file (no whole-file buffer), following redirects; a non-2xx answer is a named error. */
export const httpDownload: Download = async (url, headers, target, onBytes) => {
  const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60 * 60_000) }).catch((error: Error) => {
    throw new LocalError("hf-unreachable", `cannot reach Hugging Face (${error.message})`);
  });
  if (!response.ok || !response.body) throw new LocalError("hf-unreachable", `Hugging Face answered ${response.status} for ${url}`);
  const out = createWriteStream(target, { mode: 0o600 });
  let total = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_ADAPTER_BYTES) throw new LocalError("bad-adapter", `the download passed ${MAX_ADAPTER_BYTES / 1024 ** 3} GiB, larger than any LoRA adapter; stopped`);
      if (!out.write(chunk)) await new Promise((done) => out.once("drain", done));
      onBytes?.(total);
    }
  } finally {
    await new Promise<void>((done, fail) => out.end((error?: Error | null) => (error ? fail(error) : done())));
  }
};

async function sha256(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

interface TreeEntry { type?: string; path: string; size?: number; lfs?: { size?: number; oid?: string } }

/**
 * Fetch an adapter named `owner/repo[:file or part of its name]` into `<dir>/adapters/`, verify its SHA-256 against the
 * hub's record, then check it against the base. A file already there with the right hash is reused, not downloaded again.
 */
export async function adapterFromHub(spec: string, dir: string, base: GgufInfo, scale: number, deps: { list?: ListFetch; download?: Download; progress?: (text: string) => void } = {}): Promise<{ ref: AdapterRef; lines: string[] }> {
  const match = HF_SPEC.exec(spec);
  if (!match) throw new LocalError("bad-adapter", `"${spec}" is neither a file nor an owner/repo[:file] Hugging Face spec`);
  const [, repo, wanted] = match;
  const list = deps.list ?? (fetch as unknown as ListFetch);
  const response = await list(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, { headers: hfHeaders(), signal: AbortSignal.timeout(20_000) }).catch((error: Error) => {
    throw new LocalError("hf-unreachable", `cannot reach Hugging Face (${error.message}); download the adapter yourself and pass its path`);
  });
  if (!response.ok) throw new LocalError("hf-unreachable", `Hugging Face answered ${response.status} for ${repo} (a gated repo needs HF_TOKEN)`);
  const ggufs = ((await response.json()) as TreeEntry[]).filter((entry) => entry.type !== "directory" && /\.gguf$/i.test(entry.path));
  const exact = wanted ? ggufs.filter((entry) => entry.path === wanted || basename(entry.path) === wanted) : [];
  const hits = exact.length ? exact : wanted ? ggufs.filter((entry) => entry.path.toLowerCase().includes(wanted.toLowerCase())) : ggufs;
  if (hits.length !== 1) {
    throw new LocalError("hf-adapter", `${repo} ${hits.length ? `has ${hits.length} matching GGUF files (${hits.map((entry) => entry.path).slice(0, 5).join(", ")})` : `has no GGUF${wanted ? ` matching ${wanted}` : ""} (files: ${ggufs.map((entry) => entry.path).slice(0, 8).join(", ") || "none"})`}; name it: owner/repo:file`);
  }
  const entry = hits[0];
  const bytes = entry.lfs?.size ?? entry.size ?? 0;
  const oid = entry.lfs?.oid;
  if (!oid || !/^[0-9a-f]{64}$/.test(oid)) throw new LocalError("hf-adapter", `${repo}/${entry.path} has no published SHA-256, so it cannot be verified; download it yourself and pass its path`);
  if (bytes > MAX_ADAPTER_BYTES) throw new LocalError("bad-adapter", `${repo}/${entry.path} is ${(bytes / 1024 ** 3).toFixed(1)} GiB, larger than any LoRA adapter`);
  const folder = join(dir, "adapters", repo.replace("/", "--"));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = join(folder, basename(entry.path));
  if (!(existsSync(target) && statSync(target).size === bytes && (await sha256(target)) === oid)) {
    const partial = `${target}.${process.pid}.part`;
    try {
      deps.progress?.(`downloading ${repo}/${entry.path} (${(bytes / 1024 ** 2).toFixed(0)} MiB)`);
      await (deps.download ?? httpDownload)(`https://huggingface.co/${repo}/resolve/main/${entry.path.split("/").map(encodeURIComponent).join("/")}`, hfHeaders(), partial);
      const got = await sha256(partial);
      if (got !== oid) throw new LocalError("adapter-checksum", `${repo}/${entry.path}: SHA-256 ${got} does not match the published ${oid}; the file was discarded`);
      renameSync(partial, target);
    } finally {
      rmSync(partial, { force: true });
    }
  }
  let check: AdapterCheck;
  try { check = checkAdapter(readHeader(target, true), base, `${repo}/${entry.path}`); }
  catch (error) { if (error instanceof LocalError) rmSync(target, { force: true }); throw error; }
  return { ref: { path: target, scale, bytes: statSync(target).size, origin: `${repo}:${entry.path}`, sha256: oid }, lines: [`fetched   ${repo}/${entry.path}, SHA-256 verified`, ...check.lines] };
}

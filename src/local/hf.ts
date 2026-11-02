/**
 * Read a Hugging Face `owner/repo[:quant]` GGUF without downloading the model: list the repo's files, pick the
 * quant, and fetch only the first few MiB of its first shard (the metadata lives at the front of the file).
 * The server itself downloads the weights, on the first `start`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GgufError, readGguf, type GgufInfo } from "./gguf.ts";
import { LocalError } from "./store.ts";

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export const HF_SPEC = /^([\w.-]+\/[\w.-]+)(?::([\w.-]+))?$/;
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
const HEADER_TRIES = [16, 64].map((mib) => mib * 1024 * 1024);

interface TreeEntry { type?: string; path: string; size?: number; lfs?: { size?: number } }
export interface HfModel { repo: string; files: string[]; bytes: number }

const headers = (): Record<string, string> => process.env.HF_TOKEN ? { Authorization: `Bearer ${process.env.HF_TOKEN}` } : {};

/** The GGUF file set (all shards) that `owner/repo:quant` names. */
export async function resolveHf(spec: string, fetchImpl: Fetch = fetch as Fetch): Promise<HfModel> {
  const match = HF_SPEC.exec(spec);
  if (!match) throw new LocalError("bad-source", `"${spec}" is neither a file nor an owner/repo[:quant] Hugging Face spec`);
  const [, repo, quant] = match;
  const response = await fetchImpl(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, { headers: headers(), signal: AbortSignal.timeout(20_000) }).catch((error: Error) => {
    throw new LocalError("hf-unreachable", `cannot reach Hugging Face (${error.message}); pass a local .gguf path instead`);
  });
  if (!response.ok) throw new LocalError("hf-unreachable", `Hugging Face answered ${response.status} for ${repo} (a gated repo needs HF_TOKEN); pass a local .gguf path instead`);
  const entries = ((await response.json()) as TreeEntry[]).filter((entry) => entry.type !== "directory" && /\.gguf$/i.test(entry.path) && !/mmproj/i.test(entry.path));
  const wanted = quant ? new RegExp(`(^|[^a-z0-9])${quant.replace(/[^\w]/g, "\\$&")}([^a-z0-9]|$)`, "i") : /(^|[^a-z0-9])Q4_K_M([^a-z0-9]|$)/i;
  const hits = entries.filter((entry) => wanted.test(entry.path));
  const sets = new Map<string, TreeEntry[]>();
  for (const entry of hits) sets.set(entry.path.replace(SHARD, ".gguf"), [...(sets.get(entry.path.replace(SHARD, ".gguf")) ?? []), entry]);
  if (sets.size !== 1) {
    const detail = sets.size ? `matches ${sets.size} files: ${[...sets.keys()].slice(0, 5).join(", ")}` : `has no GGUF for ${quant ?? "the default quant"} (files: ${entries.map((entry) => entry.path).slice(0, 8).join(", ") || "none"})`;
    throw new LocalError("hf-quant", `${repo} ${detail}; name the quant exactly: owner/repo:quant`);
  }
  const files = [...sets.values()][0].sort((a, b) => a.path.localeCompare(b.path));
  return { repo, files: files.map((entry) => entry.path), bytes: files.reduce((sum, entry) => sum + (entry.lfs?.size ?? entry.size ?? 0), 0) };
}

/** Fetch the head of the first shard into a temp file and read its metadata; the temp file is removed. */
export async function readHfHeader(model: HfModel, fetchImpl: Fetch = fetch as Fetch): Promise<GgufInfo> {
  const folder = mkdtempSync(join(tmpdir(), "steak-pi-gguf-"));
  try {
    for (const bytes of HEADER_TRIES) {
      const response = await fetchImpl(`https://huggingface.co/${model.repo}/resolve/main/${model.files[0]}`, { headers: { ...headers(), Range: `bytes=0-${bytes - 1}` }, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new LocalError("hf-unreachable", `Hugging Face answered ${response.status} while reading the header of ${model.files[0]}`);
      const file = join(folder, "head.gguf");
      writeFileSync(file, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
      try { return { ...readGguf(file), fileBytes: model.bytes }; }
      catch (error) { if (!(error instanceof GgufError) || !/truncated/.test(error.message) || bytes === HEADER_TRIES.at(-1)) throw error; }
    }
    throw new GgufError("the header is larger than expected");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

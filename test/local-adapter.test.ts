// LoRA adapters on a local model: matched against the base tensor by tensor, fetched only when asked for and checked
// against the published SHA-256, and passed to llama-server as --lora-scaled. No real download, no real server.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/local/cli.ts";
import type { Download } from "../src/local/adapter.ts";
import type { Fetch } from "../src/local/hf.ts";
import { serverArgs } from "../src/local/profile.ts";
import { check } from "../src/local/runtime.ts";
import { readProfile } from "../src/local/store.ts";
import { fakeMachine, GIB, profileFor, seedProfile, tempDir } from "./helpers/local-fixture.ts";

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string) => { const body = Buffer.from(s, "utf8"); return Buffer.concat([u64(body.length), body]); };
type Meta = [string, "str" | "u32" | "f32", string | number];

/** A GGUF v3 header with metadata and a tensor table (names and shapes; no tensor data). */
function gguf(meta: Meta[], tensors: Array<[string, number[]]>): Buffer {
  const parts: Buffer[] = [Buffer.from("GGUF"), u32(3), u64(tensors.length), u64(meta.length)];
  for (const [key, kind, value] of meta) {
    parts.push(str(key));
    if (kind === "str") parts.push(u32(8), str(value as string));
    else if (kind === "u32") parts.push(u32(4), u32(value as number));
    else { const b = Buffer.alloc(4); b.writeFloatLE(value as number); parts.push(u32(6), b); }
  }
  for (const [name, dims] of tensors) parts.push(str(name), u32(dims.length), ...dims.map(u64), u32(1), u64(0));
  return Buffer.concat(parts);
}
const BASE_TENSORS: Array<[string, number[]]> = [
  ["blk.0.ffn_up.weight", [512, 1536]], ["blk.0.ffn_down.weight", [1536, 512]], ["blk.0.attn_q.weight", [512, 1024]],
];
const base = (arch = "arch-a") => gguf([
  ["general.architecture", "str", arch], ["general.type", "str", "model"], ["general.name", "str", "Base"],
  [`${arch}.context_length`, "u32", 65536], [`${arch}.block_count`, "u32", 1], [`${arch}.embedding_length`, "u32", 512],
  [`${arch}.attention.head_count`, "u32", 8], [`${arch}.attention.head_count_kv`, "u32", 2], [`${arch}.attention.key_length`, "u32", 64],
], BASE_TENSORS);
const lora = (opts: { arch?: string; type?: string; shapes?: Array<[string, number[]]> } = {}) => gguf([
  ["general.architecture", "str", opts.arch ?? "arch-a"], ["general.type", "str", opts.type ?? "adapter"],
  ["adapter.type", "str", "lora"], ["adapter.lora.alpha", "f32", 64],
], opts.shapes ?? [
  ["blk.0.ffn_up.weight.lora_a", [512, 32]], ["blk.0.ffn_up.weight.lora_b", [32, 1536]],
  ["blk.0.attn_q.weight.lora_a", [512, 32]], ["blk.0.attn_q.weight.lora_b", [32, 1024]],
]);

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); });
function setup() {
  const dir = tempDir();
  dirs.push(dir);
  const out: string[] = []; const err: string[] = [];
  const io: Io = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const state = join(dir.path, "local");
  const fake = fakeMachine(state);
  // No test reaches the real hub: the harness-adapter lookup sees an offline hub unless a test passes its own fetch.
  const offline = (async () => { throw new Error("offline in tests"); }) as never;
  const options = { io, deps: fake.deps, totalBytes: 36 * GIB, modelsJson: join(dir.path, "models.json"), ppid: 100, fetch: offline };
  const model = join(dir.path, "base.gguf");
  writeFileSync(model, base());
  return { dir: dir.path, out, err, fake, options, state, model };
}

describe("steak-pi local add --lora", () => {
  it("accepts a matching adapter file, records it in the profile, and the server gets --lora-scaled", async () => {
    const { dir, out, options, state, model } = setup();
    const adapter = join(dir, "pi.gguf");
    writeFileSync(adapter, lora());
    expect(await main(["add", model, "--name", "m", "--lora", adapter, "--lora-scale", "0.5"], options)).toBe(0);
    const profile = readProfile(state, "m")!;
    expect(profile.adapters).toEqual([expect.objectContaining({ path: adapter, scale: 0.5, origin: adapter })]);
    expect(out.join("\n")).toMatch(/LoRA rank 32, alpha 64, 2 base tensors adapted; every shape matches/);
    const args = serverArgs(profile);
    expect(args.slice(args.indexOf("--lora-scaled"), args.indexOf("--lora-scaled") + 2)).toEqual(["--lora-scaled", `${adapter}:0.5`]);
    expect(serverArgs(profileFor())).not.toContain("--lora-scaled");
  });

  it("refuses an adapter made for another model, by name, and writes nothing", async () => {
    const { dir, err, options, state, model } = setup();
    const cases: Array<[Buffer, RegExp]> = [
      [lora({ arch: "arch-b" }), /architecture arch-b, the base model is arch-a/],
      [lora({ shapes: [["blk.0.ffn_up.weight.lora_a", [256, 32]], ["blk.0.ffn_up.weight.lora_b", [32, 1536]]] }), /does not fit the base tensor/],
      [lora({ shapes: [["blk.9.ffn_up.weight.lora_a", [512, 32]], ["blk.9.ffn_up.weight.lora_b", [32, 1536]]] }), /which the base model does not have/],
      [lora({ shapes: [["blk.0.ffn_up.weight.lora_a", [512, 32]]] }), /lora_a without lora_b/],
      [lora({ type: "model" }), /is not a LoRA adapter/],
    ];
    for (const [bytes, pattern] of cases) {
      const adapter = join(dir, "bad.gguf");
      writeFileSync(adapter, bytes);
      expect(await main(["add", model, "--name", "m", "--lora", adapter], options)).toBe(2);
      expect(err.at(-1)).toMatch(/REFUSED \(bad-adapter\)/);
      expect(err.at(-1)).toMatch(pattern);
    }
    expect(readProfile(state, "m")).toBeUndefined();
    expect(existsSync(options.modelsJson)).toBe(false);
  });

  it("an adapter passed as the model is named, and bad options are refused", async () => {
    const { dir, err, options, model } = setup();
    const adapter = join(dir, "pi.gguf");
    writeFileSync(adapter, lora());
    expect(await main(["add", adapter], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-source\).*is an adapter, not a model/);
    expect(await main(["add", model, "--lora-scale", "1"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/--lora-scale needs --lora/);
    expect(await main(["add", model, "--lora", adapter, "--lora-scale", "9"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-option\)/);
    expect(await main(["add", model, "--lora", join(dir, "missing.gguf")], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(adapter-missing\)/);
  });

  it("fetches a hub adapter only when asked, verifies its SHA-256, reuses a verified copy, and discards a bad download", async () => {
    const { out, err, options, state, model } = setup();
    const bytes = lora();
    const oid = createHash("sha256").update(bytes).digest("hex");
    let served = bytes;
    const listed: string[] = [];
    const fetchFake: Fetch = async (url) => {
      listed.push(url);
      return { ok: true, status: 200, json: async () => [
        { type: "file", path: "README.md", size: 10 },
        { type: "file", path: "adapter-F16.gguf", size: bytes.length, lfs: { size: bytes.length, oid } },
      ], arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const downloads: string[] = [];
    const download: Download = async (url, _headers, target) => { downloads.push(url); writeFileSync(target, served); };
    expect(await main(["add", model, "--name", "m", "--lora", "owner/adapter-GGUF"], { ...options, fetch: fetchFake, download })).toBe(0);
    expect(listed).toEqual(["https://huggingface.co/api/models/owner/adapter-GGUF/tree/main?recursive=true", "https://huggingface.co/owner/adapter-GGUF/raw/main/README.md"]); // the listing, then the card (for its thinking setting)
    expect(downloads).toEqual(["https://huggingface.co/owner/adapter-GGUF/resolve/main/adapter-F16.gguf"]);
    const ref = readProfile(state, "m")!.adapters![0];
    expect(ref).toMatchObject({ origin: "owner/adapter-GGUF:adapter-F16.gguf", sha256: oid, scale: 1 });
    expect(ref.path.startsWith(join(state, "adapters", "owner--adapter-GGUF"))).toBe(true);
    expect(readFileSync(ref.path).equals(bytes)).toBe(true);
    expect(out.join("\n")).toMatch(/SHA-256 verified/);
    // A second add reuses the verified file.
    expect(await main(["add", model, "--name", "m2", "--lora", "owner/adapter-GGUF:F16"], { ...options, fetch: fetchFake, download })).toBe(0);
    expect(downloads).toHaveLength(1);
    // A tampered download is refused and not kept.
    served = Buffer.concat([bytes, Buffer.from("x")]);
    writeFileSync(ref.path, "corrupt");
    expect(await main(["add", model, "--name", "m3", "--lora", "owner/adapter-GGUF"], { ...options, fetch: fetchFake, download })).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(adapter-checksum\).*does not match the published/);
    expect(readProfile(state, "m3")).toBeUndefined();
  });

  it("a hub file with no published hash, or several matches, is refused", async () => {
    const { err, options, model } = setup();
    const noHash: Fetch = async () => ({ ok: true, status: 200, json: async () => [{ type: "file", path: "a.gguf", size: 5 }], arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await main(["add", model, "--lora", "owner/x"], { ...options, fetch: noHash })).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(hf-adapter\).*no published SHA-256/);
    const two: Fetch = async () => ({ ok: true, status: 200, json: async () => [{ type: "file", path: "a.gguf" }, { type: "file", path: "b.gguf" }], arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await main(["add", model, "--lora", "owner/x"], { ...options, fetch: two })).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(hf-adapter\).*2 matching GGUF files/);
  });
});

describe("adapter shapes", () => {
  it("matches a split base across every shard, accepts the swapped token-embedding layout, and refuses 3-D adaptations", async () => {
    const { dir, out, err, options } = setup();
    // Two shards: the second carries the tensor the adapter touches and no architecture key.
    const first = join(dir, "split-00001-of-00002.gguf");
    const second = join(dir, "split-00002-of-00002.gguf");
    writeFileSync(first, base());
    writeFileSync(second, gguf([["split.no", "u32", 1]], [["blk.1.ffn_up.weight", [512, 1536]], ["token_embd.weight", [512, 32000]]]));
    const late = join(dir, "late.gguf");
    writeFileSync(late, lora({ shapes: [
      ["blk.1.ffn_up.weight.lora_a", [512, 16]], ["blk.1.ffn_up.weight.lora_b", [16, 1536]],
      ["token_embd.weight.lora_a", [16, 32000]], ["token_embd.weight.lora_b", [16, 512]],
    ] }));
    expect(await main(["add", first, "--name", "split", "--lora", late], options)).toBe(0);
    expect(out.join("\n")).toMatch(/LoRA rank 16, alpha 64, 2 base tensors adapted/);
    const moe = join(dir, "moe.gguf");
    writeFileSync(moe, lora({ shapes: [["blk.0.ffn_up.weight.lora_a", [512, 32, 8]], ["blk.0.ffn_up.weight.lora_b", [32, 1536, 8]]] }));
    expect(await main(["add", join(dir, "base.gguf"), "--name", "moe", "--lora", moe], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-adapter\).*3-D adaptation/);
  });

  it("an exact hub file name wins over other files that contain it", async () => {
    const { options, state, model } = setup();
    const bytes = lora();
    const oid = createHash("sha256").update(bytes).digest("hex");
    const fetchFake: Fetch = async () => ({ ok: true, status: 200, json: async () => [
      { type: "file", path: "a.gguf", size: bytes.length, lfs: { size: bytes.length, oid } },
      { type: "file", path: "extra-a.gguf", size: 1, lfs: { size: 1, oid: "0".repeat(64) } },
    ], arrayBuffer: async () => new ArrayBuffer(0) });
    const urls: string[] = [];
    const download: Download = async (url, _headers, target) => { urls.push(url); writeFileSync(target, bytes); };
    expect(await main(["add", model, "--name", "m", "--lora", "owner/x:a.gguf"], { ...options, fetch: fetchFake, download })).toBe(0);
    expect(urls).toEqual(["https://huggingface.co/owner/x/resolve/main/a.gguf"]);
    expect(readProfile(state, "m")!.adapters![0].bytes).toBe(bytes.length);
  });
});

describe("a profile with an adapter at start", () => {
  it("is refused by name when the adapter file is gone, and counts the adapter toward memory", async () => {
    const { dir, fake, state } = setup();
    const adapter = join(dir, "a.gguf");
    writeFileSync(adapter, "x");
    seedProfile(state, { id: "with", adapters: [{ path: adapter, scale: 1, bytes: 2 * GIB, origin: adapter }] });
    seedProfile(state, { id: "plain" });
    const withAdapter = await check(fake.deps, "with");
    const plain = await check(fake.deps, "plain");
    expect(withAdapter.kind === "fits" && plain.kind === "fits" && withAdapter.need - plain.need).toBe(2 * GIB);
    seedProfile(state, { id: "gone", adapters: [{ path: join(dir, "missing.gguf"), scale: 1, bytes: 1, origin: "x" }] });
    await expect(check(fake.deps, "gone")).rejects.toMatchObject({ code: "adapter-missing" });
  });

  it("a path llama-server cannot carry, or a bad scale in a hand-edited profile, is refused", () => {
    expect(() => serverArgs(profileFor({ adapters: [{ path: "/a,b.gguf", scale: 1, bytes: 1, origin: "x" }] }))).toThrow(/comma or colon/);
    expect(() => serverArgs(profileFor({ adapters: [{ path: "/a.gguf", scale: 0, bytes: 1, origin: "x" }] }))).toThrow(/scale 0/);
  });
});

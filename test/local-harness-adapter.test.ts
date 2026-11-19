// Local mode finds and applies the harness adapter by itself: only for the exact original base model, only one the hub
// lists for this harness, fetched once and verified. A fake hub answers; nothing reaches the network.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/local/cli.ts";
import type { Download } from "../src/local/adapter.ts";
import type { Fetch } from "../src/local/hf.ts";
import { serverArgs } from "../src/local/profile.ts";
import { readProfile } from "../src/local/store.ts";
import { fakeMachine, GIB, tempDir } from "./helpers/local-fixture.ts";

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s: string) => { const body = Buffer.from(s, "utf8"); return Buffer.concat([u64(body.length), body]); };
type Meta = [string, "str" | "u32" | "f32", string | number];
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
const TEMPLATE = "{% if enable_thinking is defined and enable_thinking is false %}{% endif %}{% set e = reasoning_effort|default('xhigh') %}{% if e == 'low' %}{% elif e == 'medium' %}{% endif %}";
const model = (identity: Meta[]) => gguf([
  ["general.architecture", "str", "arch-a"], ["general.type", "str", "model"], ...identity,
  ["arch-a.context_length", "u32", 65536], ["arch-a.block_count", "u32", 1], ["arch-a.embedding_length", "u32", 512],
  ["arch-a.attention.head_count", "u32", 8], ["arch-a.attention.head_count_kv", "u32", 2], ["arch-a.attention.key_length", "u32", 64],
  ["tokenizer.chat_template", "str", TEMPLATE],
], [["blk.0.ffn_up.weight", [512, 1536]], ["blk.0.attn_q.weight", [512, 1024]]]);
const BASE_IDENTITY: Meta[] = [["general.name", "str", "Model-7B"], ["general.base_model.count", "u32", 1], ["general.base_model.0.organization", "str", "Org"], ["general.base_model.0.repo_url", "str", "https://huggingface.co/Org/Model-7B"]];
const adapterBytes = gguf([["general.architecture", "str", "arch-a"], ["general.type", "str", "adapter"], ["adapter.type", "str", "lora"], ["adapter.lora.alpha", "f32", 64]],
  [["blk.0.ffn_up.weight.lora_a", [512, 32]], ["blk.0.ffn_up.weight.lora_b", [32, 1536]]]);
const OID = createHash("sha256").update(adapterBytes).digest("hex");
const REV = "0123456789abcdef0123456789abcdef01234567";

/** A fake hub: Org/Model-7B is an original model with one harness adapter (and its GGUF form). */
function hub(overrides: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const routes: Record<string, unknown> = {
    "https://huggingface.co/api/models/Org/Model-7B": { id: "Org/Model-7B", tags: [] },
    [`https://huggingface.co/api/models?filter=${encodeURIComponent("base_model:adapter:Org/Model-7B")}&filter=pi&sort=downloads&limit=20`]: [{ id: "lab/Model-7B-pi", tags: ["lora", "pi"] }, { id: "someone/Model-7B-pi", tags: ["lora", "pi"] }],
    [`https://huggingface.co/api/models?filter=${encodeURIComponent("base_model:adapter:lab/Model-7B-pi")}&filter=gguf&sort=downloads&limit=20`]: [{ id: "squatter/Model-7B-pi-GGUF", tags: ["gguf", "lora", "pi"] }, { id: "lab/Model-7B-pi-GGUF", tags: ["gguf", "lora", "pi"] }],
    "https://huggingface.co/api/models/lab/Model-7B-pi-GGUF": { id: "lab/Model-7B-pi-GGUF", sha: REV, downloads: 1234 },
    "https://huggingface.co/lab/Model-7B-pi/raw/main/README.md": "Evaluated under the harness, thinking off unless stated.",
    [`https://huggingface.co/lab/Model-7B-pi-GGUF/raw/${REV}/README.md`]: "The GGUF form.",
    [`https://huggingface.co/api/models/lab/Model-7B-pi-GGUF/tree/${REV}?recursive=true`]: [{ type: "file", path: "Model-7B-pi-lora-F16.gguf", size: adapterBytes.length, lfs: { size: adapterBytes.length, oid: OID } }],
    ...overrides,
  };
  const fetchFake: Fetch = async (url) => {
    asked.push(url);
    if (!(url in routes)) return url.includes("/raw/") ? { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } : { ok: true, status: 200, json: async () => (url.includes("/api/models?") ? [] : {}), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, json: async () => routes[url], text: async () => String(routes[url]), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const downloads: string[] = [];
  const download: Download = async (url, _headers, target) => { downloads.push(url); writeFileSync(target, adapterBytes); };
  return { fetchFake, download, asked, downloads };
}

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); });
function setup(identity: Meta[] = BASE_IDENTITY) {
  const dir = tempDir();
  dirs.push(dir);
  const out: string[] = []; const err: string[] = [];
  const io: Io = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const state = join(dir.path, "local");
  // The operator answers yes when asked to trust a publisher, unless a test says otherwise.
  const asked: string[] = [];
  const options = { io, deps: fakeMachine(state).deps, totalBytes: 36 * GIB, modelsJson: join(dir.path, "models.json"), ppid: 100, ask: async (question: string) => { asked.push(question); return true; } };
  const file = join(dir.path, "model.gguf");
  writeFileSync(file, model(identity));
  return { out, err, options, state, file, asked };
}

describe("local mode applies the harness adapter by itself", () => {
  it("a publisher is used only once trusted: asked once interactively, never by popularity, never another publisher's copy", async () => {
    const { out, options, state, file, asked } = setup();
    const h = hub();
    // Declined: the adapter is named, not applied, and nothing is downloaded.
    expect(await main(["add", file, "--name", "a"], { ...options, fetch: h.fetchFake, download: h.download, ask: async () => false })).toBe(0);
    expect(readProfile(state, "a")!.adapters ?? []).toEqual([]);
    expect(h.downloads).toEqual([]);
    expect(out.join("\n")).toMatch(/not applied because "lab" is not a trusted publisher. Trust it and apply it with: steak-pi local adapter a --trust lab/);
    // Nobody to ask (no terminal): same, never applied silently.
    expect(await main(["add", file, "--name", "b"], { ...options, fetch: h.fetchFake, download: h.download, ask: undefined as never })).toBe(0);
    expect(readProfile(state, "b")!.adapters ?? []).toEqual([]);
    // Accepted once: remembered, not asked again; the squatter's more popular copy is never used.
    expect(await main(["add", file, "--name", "c"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
    expect(await main(["add", file, "--name", "d"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/lab\/Model-7B-pi-GGUF at commit 0123456789ab [^]*tool calls run with your permissions. Trust adapters from "lab"\?/);
    expect(h.downloads.every((url) => url.includes("/lab/"))).toBe(true);
    expect(JSON.parse(readFileSync(join(state, "trusted-publishers.json"), "utf8"))).toEqual({ publishers: ["lab"] });
  });

  it("--trust <publisher> trusts only that publisher; the not-applied message names the model and the publisher", async () => {
    const { out, err, options, state, file } = setup();
    const h = hub();
    const noAsk = { ...options, fetch: h.fetchFake, download: h.download, ask: undefined as never };
    expect(await main(["add", file, "--name", "m"], noAsk)).toBe(0);
    expect(out.join("\n")).toMatch(/steak-pi local adapter m --trust lab$/m);
    expect(await main(["adapter", "m", "--trust", "squatter"], noAsk)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(untrusted-publisher\).*from "lab", not "squatter"; nothing was trusted/);
    expect(readProfile(state, "m")!.adapters ?? []).toEqual([]);
    expect(await main(["adapter", "m", "--trust", "lab"], noAsk)).toBe(0);
    expect(readProfile(state, "m")!.adapters).toHaveLength(1);
    expect(await main(["add", file, "--name", "n", "--trust", "lab"], noAsk)).toBe(0);
    expect(readProfile(state, "n")!.adapters).toHaveLength(1);
  });

  it("an Instruct release that declares its pretrained base is not given the base's adapter", async () => {
    const { resolveBase } = await import("../src/local/harness-adapter.ts");
    const { readGguf } = await import("../src/local/gguf.ts");
    const f = setup([["general.name", "str", "Model 7B Instruct"], ["general.basename", "str", "Model"], ["general.size_label", "str", "7B"], ["general.finetune", "str", "Instruct"], ["general.base_model.count", "u32", 1], ["general.base_model.0.organization", "str", "Org"], ["general.base_model.0.repo_url", "str", "https://huggingface.co/Org/Model-7B"]]);
    const r = await resolveBase(readGguf(f.file), { kind: "file" }, hub().fetchFake as never);
    expect(r.repo).not.toBe("Org/Model-7B");
  });

  it("a hint that weighs both settings does not turn thinking off", async () => {
    const { options, state, file } = setup();
    const h = hub({ "https://huggingface.co/lab/Model-7B-pi/raw/main/README.md": "Works with or without thinking; thinking off is faster." });
    expect(await main(["add", file, "--name", "m"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
    expect(readProfile(state, "m")!.trainedThinking).toBeUndefined();
  });

  it("--lora on an existing model (a fine-tune local mode skips) applies the named adapter and its card's thinking-off", async () => {
    const { err, options, state, file } = setup([["general.name", "str", "Tuned-7B"], ["general.finetune", "str", "tuned"], ...BASE_IDENTITY.slice(1)]);
    const listing = [{ type: "file", path: "Model-7B-pi-lora-F16.gguf", size: adapterBytes.length, lfs: { size: adapterBytes.length, oid: OID } }];
    const h = hub({ "https://huggingface.co/lab/Model-7B-pi-GGUF/raw/main/README.md": "Evaluated with thinking off.", "https://huggingface.co/api/models/lab/Model-7B-pi-GGUF/tree/main?recursive=true": listing });
    expect(await main(["add", file, "--name", "tuned"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
    expect(readProfile(state, "tuned")!.adapters ?? []).toEqual([]);
    const code = await main(["adapter", "tuned", "--lora", "lab/Model-7B-pi-GGUF"], { ...options, fetch: h.fetchFake, download: h.download });
    expect(err, err.join("\n")).toEqual([]);
    expect(code).toBe(0);
    const profile = readProfile(state, "tuned")!;
    expect(profile.adapters).toEqual([expect.objectContaining({ origin: "lab/Model-7B-pi-GGUF:Model-7B-pi-lora-F16.gguf" })]);
    expect(profile.trainedThinking).toBe("off");
    expect(serverArgs(profile)).toEqual(expect.arrayContaining(["--reasoning", "off"]));
  });

  it("an adapter whose only GGUF form is from another publisher is not used", async () => {
    const { out, options, state, file } = setup();
    const h = hub({ [`https://huggingface.co/api/models?filter=${encodeURIComponent("base_model:adapter:lab/Model-7B-pi")}&filter=gguf&sort=downloads&limit=20`]: [{ id: "squatter/Model-7B-pi-GGUF", tags: ["gguf", "lora", "pi"] }] });
    expect(await main(["add", file, "--name", "m"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
    expect(readProfile(state, "m")!.adapters ?? []).toEqual([]);
    expect(out.join("\n")).toMatch(/lab\/Model-7B-pi has no llama.cpp \(GGUF\) form from the same publisher/);
  });

  it("thinking off comes from the adapter's card, never assumed", async () => {
    const { options, state, file } = setup();
    const h = hub({ "https://huggingface.co/lab/Model-7B-pi/raw/main/README.md": "A harness adapter." });
    expect(await main(["add", file, "--name", "m"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
    expect(readProfile(state, "m")!.adapters).toHaveLength(1);
    expect(readProfile(state, "m")!.trainedThinking).toBeUndefined();
    expect(serverArgs(readProfile(state, "m")!)).not.toContain("--reasoning");
  });

  it("a release name part (Instruct) is not a fine-tune; a file with no declared base is not guessed by name search", async () => {
    const { resolveBase } = await import("../src/local/harness-adapter.ts");
    const { readGguf } = await import("../src/local/gguf.ts");
    const instruct = setup([["general.name", "str", "Model-7B-Instruct"], ["general.basename", "str", "Model"], ["general.size_label", "str", "7B"], ["general.finetune", "str", "Instruct"], ["general.base_model.count", "u32", 1], ["general.base_model.0.repo_url", "str", "https://huggingface.co/Org/Model-7B-Instruct"]]);
    expect((await resolveBase(readGguf(instruct.file), { kind: "file" }, hub().fetchFake as never)).repo).toBe("Org/Model-7B-Instruct");
    const bare = setup([["general.name", "str", "Model-7B"]]);
    const searched: string[] = [];
    const r = await resolveBase(readGguf(bare.file), { kind: "file" }, (async (url: string) => { searched.push(url); return { ok: true, status: 200, json: async () => [] }; }) as never);
    expect(r.repo).toBeUndefined();
    expect(searched.filter((url) => url.includes("search="))).toEqual([]);
  });

  it("finds the adapter for the exact base, fetches and verifies it once, applies it, and starts with thinking off", async () => {
    const { out, options, state, file } = setup();
    const h = hub();
    expect(await main(["add", file, "--name", "m"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
    const profile = readProfile(state, "m")!;
    expect(profile.adapters).toEqual([expect.objectContaining({ origin: "lab/Model-7B-pi-GGUF:Model-7B-pi-lora-F16.gguf", sha256: OID, scale: 1 })]);
    expect(profile.trainedThinking).toBe("off");
    const args = serverArgs(profile);
    expect(args).toEqual(expect.arrayContaining(["--lora-scaled", "--reasoning", "off"]));
    expect(h.downloads).toEqual([`https://huggingface.co/lab/Model-7B-pi-GGUF/resolve/${REV}/Model-7B-pi-lora-F16.gguf`]);
    expect(profile.adapters![0]).toMatchObject({ publisher: "lab", revision: REV });
    expect(out.join("\n")).toMatch(/adapter {3}lab\/Model-7B-pi-GGUF at commit 0123456789ab \(1234 downloads\), trained for this harness on Org\/Model-7B; publisher "lab" is trusted/);
    expect(out.join("\n")).toMatch(/SHA-256 verified/);
    // A second model of the same base reuses the verified file.
    expect(await main(["add", file, "--name", "m2"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
    expect(h.downloads).toHaveLength(1);
  });

  it("a fine-tune of the base gets no adapter, and the hub is not asked for one", async () => {
    for (const identity of [
      [["general.name", "str", "Tuned-7B"], ["general.finetune", "str", "tuned"], ...BASE_IDENTITY.slice(1)] as Meta[],
      [["general.name", "str", "Other-Name"], ...BASE_IDENTITY.slice(1)] as Meta[],
    ]) {
      const { out, options, state, file } = setup(identity);
      const h = hub();
      expect(await main(["add", file, "--name", "t"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
      expect(readProfile(state, "t")!.adapters ?? []).toEqual([]);
      expect(h.downloads).toEqual([]);
      expect(out.join("\n")).toMatch(/adapter {3}none: .*(fine-tune|derived from that base)/);
      expect(serverArgs(readProfile(state, "t")!)).not.toContain("--lora-scaled");
    }
  });

  it("a model added from a hub repo that is a fine-tune gets none; one with no harness adapter runs plain", async () => {
    const tuned = setup();
    const h1 = hub({ "https://huggingface.co/api/models/someone/Tuned-GGUF": { id: "someone/Tuned-GGUF", tags: ["base_model:finetune:Org/Model-7B"] } });
    const { resolveBase } = await import("../src/local/harness-adapter.ts");
    const { readGguf } = await import("../src/local/gguf.ts");
    expect((await resolveBase(readGguf(tuned.file), { kind: "hf", spec: "someone/Tuned-GGUF:Q4_K_M" }, h1.fetchFake as never)).repo).toBeUndefined();
    const none = setup();
    const h2 = hub({ [`https://huggingface.co/api/models?filter=${encodeURIComponent("base_model:adapter:Org/Model-7B")}&filter=pi&sort=downloads&limit=20`]: [] });
    expect(await main(["add", none.file, "--name", "b"], { ...none.options, fetch: h2.fetchFake, download: h2.download })).toBe(0);
    expect(none.out.join("\n")).toMatch(/adapter {3}none: no adapter trained for this harness is listed for Org\/Model-7B/);
  });

  it("an adapter that fails its checksum is skipped with its cause and the model still gets added", async () => {
    const { out, options, state, file } = setup();
    const h = hub();
    const bad: Download = async (_url, _headers, target) => { writeFileSync(target, "tampered"); };
    expect(await main(["add", file, "--name", "m"], { ...options, fetch: h.fetchFake, download: bad })).toBe(0);
    expect(readProfile(state, "m")!.adapters ?? []).toEqual([]);
    expect(out.join("\n")).toMatch(/adapter {3}none: lab\/Model-7B-pi-GGUF did not check out \(adapter-checksum/);
  });

  it("an offline hub never blocks add; --no-adapter skips the lookup; `local adapter` adds it later and `adapter off` removes it", async () => {
    const { out, options, state, file } = setup();
    const offline = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as unknown as Fetch;
    expect(await main(["add", file, "--name", "m"], { ...options, fetch: offline })).toBe(0);
    expect(out.join("\n")).toMatch(/adapter {3}not checked: cannot reach Hugging Face.*steak-pi local adapter <id>/);
    const h = hub();
    expect(await main(["add", file, "--name", "n", "--no-adapter"], { ...options, fetch: h.fetchFake, download: h.download })).toBe(0);
    expect(h.asked).toEqual([]);
    expect(readProfile(state, "n")!.harnessAdapter).toBe("off");
    expect(await main(["adapter", "m"], { ...options, fetch: h.fetchFake, download: h.download, ask: undefined as never })).toBe(2); // nobody to ask, publisher not trusted yet
    expect(await main(["adapter", "m", "--trust"], { ...options, fetch: h.fetchFake, download: h.download, ask: undefined as never })).toBe(0); // bare --trust: the candidate the output names
    expect(readProfile(state, "m")!.adapters).toHaveLength(1);
    expect(readProfile(state, "m")!.trainedThinking).toBe("off");
    expect(await main(["adapter", "off", "m"], options)).toBe(0);
    expect(readProfile(state, "m")!.adapters).toEqual([]);
    expect(serverArgs(readProfile(state, "m")!)).not.toContain("--reasoning");
  });

  it("an explicit `local adapter` request for a model with none is a named refusal", async () => {
    const { err, options, file } = setup([["general.name", "str", "Tuned-7B"], ["general.finetune", "str", "tuned"]]);
    expect(await main(["add", file, "--name", "t", "--no-adapter"], options)).toBe(0);
    expect(await main(["adapter", "t"], { ...options, fetch: hub().fetchFake })).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(no-harness-adapter\).*fine-tune/);
  });
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GgufError, readGguf } from "../src/local/gguf.ts";
import { DEFAULT_CTX_CAP, floorPow2, kvBytesPerToken, sizeContext, startNeedBytes } from "../src/local/hardware.ts";
import { detectReasoning, effortMap, idFromSource, planProfile, serverArgs } from "../src/local/profile.ts";
import { GB, GIB, ggufBytes, modelGguf, tempDir, writeGguf } from "./helpers/local-fixture.ts";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); });
const temp = () => { const dir = tempDir(); dirs.push(dir); return dir.path; };

describe("GGUF header reader", () => {
  it("reads the attention shape, context, template and sampling from a synthetic file, skipping the tokenizer", () => {
    const path = writeGguf(temp(), "m.gguf", { template: "{{ reasoning_effort }}", sampling: true });
    const info = readGguf(path);
    expect(info).toMatchObject({ architecture: "arch-a", name: "Test Model", contextLength: 262144, blockCount: 64, headCount: 24, keyLength: 256, version: 3 });
    expect(info.chatTemplate).toBe("{{ reasoning_effort }}");
    expect(info.sampling).toEqual({ temperature: 0.5, top_k: 20 });
    // Hybrid: a KV cache on every 4th layer only.
    expect(info.kvHeadsPerLayer?.filter((heads) => heads > 0)).toHaveLength(16);
    expect(info.kvHeadsPerLayer?.[3]).toBe(4);
    expect(info.kvHeadsPerLayer?.[0]).toBe(0);
    expect(info.fileBytes).toBeGreaterThan(1_500_000);
  });

  it("keeps a per-layer head_count_kv array and treats a scalar as dense", () => {
    const dense = readGguf(writeGguf(temp(), "dense.gguf", { kvHeads: 8, blocks: 4, tokens: 10 }));
    expect(dense.kvHeadsPerLayer).toEqual([8, 8, 8, 8]);
    const perLayer = readGguf(writeGguf(temp(), "layers.gguf", { kvHeads: [8, 0, 8, 0], blocks: 4, tokens: 10 }));
    expect(perLayer.kvHeadsPerLayer).toEqual([8, 0, 8, 0]);
  });

  it("names why a file is refused", () => {
    const dir = temp();
    writeFileSync(join(dir, "text.gguf"), "this is not a model");
    expect(() => readGguf(join(dir, "text.gguf"))).toThrow(/bad magic/);
    const whole = modelGguf({ tokens: 10 });
    writeFileSync(join(dir, "cut.gguf"), whole.subarray(0, whole.length - 20));
    expect(() => readGguf(join(dir, "cut.gguf"))).toThrow(GgufError);
    expect(() => readGguf(join(dir, "cut.gguf"))).toThrow(/truncated/);
    writeFileSync(join(dir, "noarch.gguf"), ggufBytes([["general.name", "str", "x"]]));
    expect(() => readGguf(join(dir, "noarch.gguf"))).toThrow(/general\.architecture/);
    expect(() => readGguf(join(dir, "missing.gguf"))).toThrow(/cannot open/);
  });
});

describe("hardware sizing", () => {
  const hybridKv = () => kvBytesPerToken(readGguf(writeGguf(temp(), "kv.gguf", { tokens: 10 })));

  it("estimates q8_0 KV bytes per token from the shape: 16 cached layers x 4 heads x (256+256) x 34/32", () => {
    expect(hybridKv()).toEqual({ bytesPerToken: 34816, estimated: false });
    expect(kvBytesPerToken({}).estimated).toBe(true);
  });

  it("a 36 GiB machine with a 12 GB model gets 32768 context (the default cap), a power of two", () => {
    const result = sizeContext({ totalBytes: 36 * GIB, modelBytes: 12.1 * GB, kvBytesPerToken: hybridKv().bytesPerToken, nativeCtx: 262144 });
    expect(result).toMatchObject({ ok: true, ctx: 32768, cap: DEFAULT_CTX_CAP });
    if (result.ok) expect(result.fitCtx).toBeGreaterThan(300_000);
  });

  it("an explicit --ctx raises the cap but never past what fits, and says it shrank", () => {
    const kv = hybridKv().bytesPerToken;
    expect(sizeContext({ totalBytes: 36 * GIB, modelBytes: 12.1 * GB, kvBytesPerToken: kv, requestedCtx: 65536 })).toMatchObject({ ok: true, ctx: 65536 });
    const tight = sizeContext({ totalBytes: 20 * GIB, modelBytes: 12.1 * GB, kvBytesPerToken: kv, requestedCtx: 262144 });
    expect(tight).toMatchObject({ ok: true });
    if (tight.ok) { expect(tight.ctx).toBeLessThan(262144); expect(tight.shrunkFrom).toBe(262144); expect(floorPow2(tight.ctx)).toBe(tight.ctx); }
  });

  it("a 16 GiB machine refuses a 12 GB model (weights + 6 GiB headroom do not fit)", () => {
    const result = sizeContext({ totalBytes: 16 * GIB, modelBytes: 12.1 * GB, kvBytesPerToken: hybridKv().bytesPerToken });
    expect(result).toMatchObject({ ok: false, cause: "model-too-large" });
  });

  it("a 16 GiB machine shrinks the context for a smaller dense model, and refuses when too little is left", () => {
    const dense = 100 * 1024; // a dense model's KV cache: 100 KiB per token
    const shrunk = sizeContext({ totalBytes: 16 * GIB, modelBytes: 7.5 * GIB, kvBytesPerToken: dense });
    expect(shrunk).toMatchObject({ ok: true, ctx: 16384 });
    const tooSmall = sizeContext({ totalBytes: 16 * GIB, modelBytes: 9.5 * GIB, kvBytesPerToken: dense });
    expect(tooSmall).toMatchObject({ ok: false, cause: "context-too-small" });
  });

  it("caps at the model's native context", () => {
    expect(sizeContext({ totalBytes: 64 * GIB, modelBytes: 4 * GB, kvBytesPerToken: 10_000, nativeCtx: 16384 })).toMatchObject({ ok: true, ctx: 16384, capReason: expect.stringContaining("native") });
  });

  it("the start need is weights + KV at the chosen context + server overhead (about 16 GB for the 12 GB case)", () => {
    const need = startNeedBytes(12.1 * GB, 32768, 34816);
    expect(need / GIB).toBeGreaterThan(14.5);
    expect(need / GIB).toBeLessThan(16.5);
  });
});

describe("generic profile", () => {
  const input = (template: string | undefined, extra = {}) => {
    const dir = temp();
    const path = writeGguf(dir, "my-model-Q4_K_M.gguf", { template, tokens: 10 });
    return { id: "my-model", source: { kind: "file" as const, path }, info: readGguf(path), modelBytes: 12.1 * GB, totalBytes: 36 * GIB, port: 8089, ...extra };
  };

  it("maps reasoning_effort templates onto the efforts the template names, with ties going up", () => {
    expect(detectReasoning("{% if reasoning_effort == 'low' %}{% elif reasoning_effort == \"medium\" %}{% elif reasoning_effort == 'xhigh' %}")).toEqual({ kind: "effort", values: ["low", "medium", "xhigh"] });
    expect(effortMap(["low", "medium", "xhigh"])).toMatchObject({ off: "low", minimal: "low", low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: "xhigh" });
    expect(effortMap(["low", "medium", "high"])).toMatchObject({ high: "high", xhigh: "high", max: "high" });
  });

  it("writes chat-template reasoning controls only when the template supports them", () => {
    const effort = planProfile(input("{{ reasoning_effort }} 'low' 'high'"));
    expect(effort.model).toMatchObject({ id: "my-model", reasoning: true, contextWindow: 32768, baseUrl: "http://127.0.0.1:8089/v1", compat: { thinkingFormat: "chat-template", chatTemplateKwargs: { reasoning_effort: { $var: "thinking.effort" } } } });
    expect(effort.lines.join("\n")).toMatch(/reasoning_effort through the chat template/);
    const toggle = planProfile(input("{% if enable_thinking %}"));
    expect(toggle.model).toMatchObject({ reasoning: true, compat: { chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } } });
    const plain = planProfile(input("{{ messages }}"));
    expect(plain.model).toMatchObject({ reasoning: false });
    expect(plain.model).not.toHaveProperty("compat");
    expect(plain.model).not.toHaveProperty("thinkingLevelMap");
    expect(plain.lines.join("\n")).toMatch(/plain/);
    expect(planProfile(input(undefined)).model.reasoning).toBe(false);
  });

  it("explains its choices, and carries sampling only when the file does", () => {
    const plan = planProfile(input("x"));
    const text = plan.lines.join("\n");
    expect(text).toMatch(/32768 tokens/);
    expect(text).toMatch(/36\.0 GiB RAM/);
    expect(text).toMatch(/default 32768 cap/);
    expect(text).toMatch(/1 slot, flash attention on, q8_0 KV cache/);
    expect(plan.model).not.toHaveProperty("samplingParams");
    const sampled = planProfile({ ...input("x"), info: { ...input("x").info, sampling: { temperature: 0.6 } } });
    expect(sampled.model).toMatchObject({ samplingParams: { temperature: 0.6 } });
  });

  it("builds the server command: one slot, flash attention, q8_0 KV, jinja, and the operator's extra args last", () => {
    const { profile } = planProfile({ ...input("{{ reasoning_effort }}"), extraArgs: ["--threads", "6"] });
    const args = serverArgs(profile);
    expect(args).toEqual(expect.arrayContaining(["-np", "1", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--jinja", "--host", "127.0.0.1", "-c", "32768"]));
    expect(args.slice(-2)).toEqual(["--threads", "6"]);
    expect(serverArgs({ ...profile, source: { kind: "hf", spec: "owner/repo:Q4_K_M" } })).toEqual(expect.arrayContaining(["-hf", "owner/repo:Q4_K_M"]));
    expect(args).not.toContain("--reasoning-format"); // the server's own default (auto) extracts reasoning
  });

  it("derives a safe id from a file name, a shard or a Hugging Face spec", () => {
    expect(idFromSource({ kind: "file", path: "/m/My Model-Q4_K_M-00001-of-00003.gguf" })).toBe("my-model-q4_k_m");
    expect(idFromSource({ kind: "hf", spec: "owner/Repo-GGUF:Q4_K_M" })).toBe("repo-gguf-q4_k_m");
  });

  it("refuses a model the machine cannot hold, naming the cause", () => {
    expect(() => planProfile({ ...input("x"), totalBytes: 16 * GIB })).toThrow(/do not fit in 16\.0 GiB/);
  });
});

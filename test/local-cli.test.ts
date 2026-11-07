import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/local/cli.ts";
import type { Fetch } from "../src/local/hf.ts";
import { readProfile } from "../src/local/store.ts";
import { fakeMachine, GIB, modelGguf, tempDir, writeGguf } from "./helpers/local-fixture.ts";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); });

function setup() {
  const dir = tempDir();
  dirs.push(dir);
  const out: string[] = []; const err: string[] = [];
  const io: Io = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const state = join(dir.path, "local");
  const fake = fakeMachine(state);
  const options = { io, deps: fake.deps, totalBytes: 36 * GIB, modelsJson: join(dir.path, "models.json"), ppid: 100 };
  return { dir: dir.path, out, err, fake, options, state };
}

describe("steak-pi local add", () => {
  it("slots a GGUF file in: one local provider in models.json, a launch profile, and a printed explanation", async () => {
    const { dir, out, options, state } = setup();
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { other: { baseUrl: "https://example.test", models: [{ id: "x" }] } } }));
    // A header plus padding standing in for the tensors, so the file has a plausible size.
    const file = join(dir, "My-Model-Q4_K_M.gguf");
    writeFileSync(file, Buffer.concat([modelGguf({ template: "{{ reasoning_effort }} 'low' 'medium' 'high'", tokens: 50 }), Buffer.alloc(8 * 1024 * 1024)]));
    expect(await main(["add", file, "--port", "18089", "--", "--threads", "6"], options)).toBe(0);
    const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
    expect(models.providers.other.models).toEqual([{ id: "x" }]);
    expect(models.providers.local.models).toHaveLength(1);
    expect(models.providers.local.models[0]).toMatchObject({ id: "my-model-q4_k_m", contextWindow: 32768, baseUrl: "http://127.0.0.1:18089/v1", reasoning: true });
    expect(readProfile(state, "my-model-q4_k_m")).toMatchObject({ ctx: 32768, port: 18089, extraArgs: ["--threads", "6"], source: { kind: "file", path: file } });
    const text = out.join("\n");
    expect(text).toMatch(/added local\/my-model-q4_k_m/);
    expect(text).toMatch(/context\s+32768 tokens/);
    expect(text).toMatch(/pi --model local\/my-model-q4_k_m/);
    expect(readdirSync(dir).some((name) => name.startsWith("models.json.bak-"))).toBe(true);
  });

  it("--name sets the id; adding a second model keeps both under the one provider", async () => {
    const { dir, options } = setup();
    const file = writeGguf(dir, "a.gguf", { tokens: 10 });
    await main(["add", file, "--name", "first"], options);
    await main(["add", file, "--name", "second", "--ctx", "16384"], options);
    const local = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers.local;
    expect(local.models.map((entry: { id: string }) => entry.id)).toEqual(["first", "second"]);
    expect(local.models[1].contextWindow).toBe(16384);
  });

  it("refuses with a named cause when the machine cannot hold the model, and writes nothing", async () => {
    const { dir, err, options } = setup();
    const file = writeGguf(dir, "a.gguf", { tokens: 10 });
    // 4 GiB of RAM cannot hold even the 6 GiB of headroom.
    expect(await main(["add", file], { ...options, totalBytes: 4 * GIB })).toBe(2);
    expect(err.join("\n")).toMatch(/^steak-pi local: REFUSED \(model-too-large\)/);
    expect(existsSync(join(dir, "models.json"))).toBe(false);
  });

  it("names bad input: not a GGUF, bad ids, bad numbers, an unknown target", async () => {
    const { dir, err, options } = setup();
    writeFileSync(join(dir, "junk.gguf"), "nope");
    expect(await main(["add", join(dir, "junk.gguf")], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-gguf\).*bad magic/);
    const file = writeGguf(dir, "a.gguf", { tokens: 10 });
    expect(await main(["add", file, "--name", "Bad Name"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-id\)/);
    expect(await main(["add", file, "--ctx", "abc"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-option\)/);
    expect(await main(["add", join(dir, "missing.gguf")], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(model-missing\)/);
  });

  it("reads an owner/repo:quant spec from the first bytes of the file, never the whole model", async () => {
    const { out, options, state } = setup();
    const head = modelGguf({ template: "{% if enable_thinking %}", tokens: 20 });
    const urls: string[] = [];
    const fetchFake: Fetch = async (url, init) => {
      urls.push(`${url} ${init?.headers?.Range ?? ""}`.trim());
      if (url.includes("/api/models/")) return { ok: true, status: 200, json: async () => [
        { type: "file", path: "README.md", size: 10 },
        { type: "file", path: "x-Q4_K_M.gguf", size: 7_000_000_000 },
        { type: "file", path: "x-Q8_0.gguf", size: 9_000_000_000 },
        { type: "file", path: "mmproj-Q4_K_M.gguf", size: 1 },
      ], arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 206, json: async () => ({}), arrayBuffer: async () => head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength) as ArrayBuffer };
    };
    expect(await main(["add", "owner/x-GGUF:Q4_K_M"], { ...options, fetch: fetchFake })).toBe(0);
    expect(urls).toEqual(["https://huggingface.co/api/models/owner/x-GGUF/tree/main?recursive=true", "https://huggingface.co/owner/x-GGUF/resolve/main/x-Q4_K_M.gguf bytes=0-16777215"]);
    expect(readProfile(state, "x-gguf-q4_k_m")).toMatchObject({ source: { kind: "hf", spec: "owner/x-GGUF:Q4_K_M" }, modelBytes: 7_000_000_000 });
    expect(out.join("\n")).toMatch(/enable_thinking/);
  });

  it("an ambiguous quant is named, not guessed", async () => {
    const { err, options } = setup();
    const fetchFake: Fetch = async () => ({ ok: true, status: 200, json: async () => [{ type: "file", path: "a-Q4_K_M.gguf", size: 1 }, { type: "file", path: "b-Q4_K_M.gguf", size: 1 }], arrayBuffer: async () => new ArrayBuffer(0) });
    expect(await main(["add", "owner/x:Q4_K_M"], { ...options, fetch: fetchFake })).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(hf-quant\).*matches 2 files/);
  });
});

describe("steak-pi local ensure / release / status / start / stop", () => {
  async function added() {
    const world = setup();
    const file = writeGguf(world.dir, "m.gguf", { tokens: 10 });
    await main(["add", file, "--name", "model-a", "--port", "18089"], world.options);
    world.out.length = 0;
    // The profile points at a real file but this machine's fake memory/disk are generous.
    world.fake.state.healthy = true;
    return world;
  }

  it("ensure prints readiness, release lets go; a refusal exits 2 with one named line on stderr", async () => {
    const { out, err, options, fake, state } = await added();
    fake.alive.add(100);
    expect(await main(["ensure", "model-a"], options)).toBe(0);
    expect(out.at(-1)).toBe("ready: local/model-a at http://127.0.0.1:18089/v1 (started)");
    expect(await main(["ensure", "model-a"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/already running/);
    expect(await main(["release", "model-a"], options)).toBe(0);
    expect(out.at(-1)).toBe("released local/model-a; 1 user(s) remain");
    expect(await main(["release", "model-a"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/0 user\(s\) remain; the server stops after 10 min idle/);
    fake.state.disk = 95;
    await main(["stop"], options);
    expect(await main(["ensure", "model-a"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/^steak-pi local: REFUSED \(disk-full\): the disk is 95% used/);
    expect(await main(["ensure", "nope"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(unknown-model\).*known: model-a/);
    expect(readProfile(state, "model-a")).toBeDefined();
  });

  it("check is read-only and agrees with ensure: fits, running, refused (exit 3), unknown id (exit 1)", async () => {
    const { out, err, options, fake, state } = await added();
    fake.alive.add(100);
    expect(await main(["check", "model-a"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/^ok: local\/model-a fits \(needs \d+\.\d GiB, \d+\.\d GiB free\)$/);
    expect(fake.calls).toEqual([]); // started nothing
    expect(existsSync(join(state, "server.json"))).toBe(false);
    expect(existsSync(join(state, "leases.json"))).toBe(false); // took no lease
    fake.state.available = 0.5 * GIB;
    expect(await main(["check", "model-a"], options)).toBe(3);
    expect(err.at(-1)).toMatch(/^steak-pi local: REFUSED \(insufficient-memory\): starting model-a needs about .* but only 0\.5 GiB is free or reclaimable/);
    expect(await main(["ensure", "model-a"], options)).toBe(2); // ensure refuses with the very same line
    expect(err.at(-1)).toBe(err.at(-2));
    fake.state.available = 64 * GIB;
    expect(await main(["ensure", "model-a"], options)).toBe(0);
    expect(await main(["check", "model-a"], options)).toBe(0);
    expect(out.at(-1)).toBe("ok: local/model-a is running");
    expect(await main(["check", "nope"], options)).toBe(1);
    expect(err.at(-1)).toMatch(/REFUSED \(unknown-model\)/);
    expect(await main(["check"], options)).toBe(1);
    expect(await main(["check", "Bad Id!"], options)).toBe(1); // a malformed id is a usage error (1), not a refusal (2)
    expect(err.at(-1)).toMatch(/REFUSED \(bad-id\)/);
  });

  it("start pins the server until stop; status shows it; stop confirms the port", async () => {
    const { out, options, fake } = await added();
    expect(await main(["start"], options)).toBe(0); // one model added: no id needed
    expect(out.at(-1)).toMatch(/local\/model-a started at http:\/\/127\.0\.0\.1:18089\/v1; it stays up until: steak-pi local stop/);
    expect(await main(["status"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/server\s+local\/model-a on port 18089.*healthy\nusers\s+1\nmodel\s+local\/model-a\s+ctx 32768, port 18089/);
    expect(await main(["stop"], options)).toBe(0);
    expect(out.at(-1)).toBe("stopped local/model-a; port 18089 released (1 user(s) were still attached)");
    expect(await main(["stop"], options)).toBe(0);
    expect(out.at(-1)).toBe("no server started by Steak Pi is running");
    expect(fake.calls).toEqual(["supervisor:model-a"]);
    expect(await main(["status"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/^server\s+stopped\nusers\s+0/);
  });

  it("status says orphaned (supervisor gone), never healthy, for a server without its supervisor", async () => {
    const { out, options, fake, state } = await added();
    await main(["start"], options);
    const path = join(state, "server.json");
    const record = JSON.parse(readFileSync(path, "utf8"));
    fake.alive.delete(record.supervisorPid);
    fake.alive.add(7001);
    // No recorded start time: it cannot be proven to be the server, so it is reported but not touched.
    writeFileSync(path, JSON.stringify({ ...record, serverPid: 7001, serverStart: undefined }));
    expect(await main(["status"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/pid 7001\), orphaned \(supervisor gone\)\n/);
    expect(out.at(-1)).not.toMatch(/healthy/);
    // With a proven start time and no holders past the grace it is stopped, and status says so.
    writeFileSync(path, JSON.stringify({ ...record, serverPid: 7001, serverStart: "start-7001" }));
    await main(["stop"], options); // (clears the leases; the record is rewritten below)
    writeFileSync(path, JSON.stringify({ ...record, serverPid: 7001, serverStart: "start-7001" }));
    fake.alive.add(7001);
    fake.clock.t += fake.deps.graceMs + 1000;
    expect(await main(["status"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/was orphaned \(supervisor gone\): stopped \(idle past the grace\), port released\nserver\s+stopped/);
  });

  it("prints usage for nothing or an unknown command", async () => {
    const { err, out, options } = setup();
    expect(await main([], options)).toBe(0);
    expect(await main(["bogus"], options)).toBe(1);
    expect(err.join("\n")).toMatch(/usage: steak-pi local/);
    expect(out).toEqual([]);
  });
});

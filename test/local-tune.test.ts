import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/local/cli.ts";
import { readProfile, writeAtomic } from "../src/local/store.ts";
import { fakeMachine, seedProfile, tempDir } from "./helpers/local-fixture.ts";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); delete process.env.STEAK_PI_UIO; delete process.env.FAKE_UIO_MODE; });

const RESULT = { baseline: { decodeTokS: { median: 20 }, prefillTokS: 200, ttftMs: 900 }, best: { decodeTokS: { median: 24 }, prefillTokS: 210, ttftMs: 800 }, ceiling: { decodeTokS: { median: 40 } }, bestArgs: ["--flash-attn", "on"], accepted: [{}], rejected: [{}, {}], plateau: true, workdir: "/tmp/uio-work" };

/** A fake `uio`: a node script whose behaviour follows FAKE_UIO_MODE; it logs its argv and whether the tuning marker existed. */
function fakeUio(dir: string, state: string): string {
  const path = join(dir, "uio");
  writeFileSync(path, `#!${process.execPath}
const fs = require("fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify({ argv, marker: fs.existsSync(${JSON.stringify(join(state, "tuning.json"))}) }));
const mode = process.env.FAKE_UIO_MODE || "ok";
console.error("round 1: control");
if (mode === "refuse") { console.error("on battery"); process.exit(2); }
if (mode === "fail") { console.error("server crashed"); process.exit(3); }
if (argv.includes("--apply") && mode !== "noapply") {
  const file = argv[argv.indexOf("--profile") + 1];
  const p = JSON.parse(fs.readFileSync(file, "utf8")); p.extraArgs = ${JSON.stringify(RESULT.bestArgs)};
  fs.writeFileSync(file, JSON.stringify(p));
}
console.log(JSON.stringify(${JSON.stringify(RESULT)}));
`);
  chmodSync(path, 0o755);
  return path;
}

function setup() {
  const dir = tempDir(); dirs.push(dir);
  const out: string[] = []; const err: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t) };
  const state = join(dir.path, "local");
  const fake = fakeMachine(state);
  fake.alive.add(process.pid);
  seedProfile(state);
  const options = { io, deps: fake.deps, ppid: 100 };
  const uio = fakeUio(dir.path, state);
  return { dir: dir.path, out, err, fake, options, state, uio };
}

describe("steak-pi local tune", () => {
  it("runs uio on the profile, holds the tuning state meanwhile, and prints a before/after table", async () => {
    const { dir, out, options, state, uio } = setup();
    process.env.STEAK_PI_UIO = uio;
    expect(await main(["tune", "model-a", "--budget", "30m", "--target", "decode", "--allow", "lossless"], options)).toBe(0);
    const seen = JSON.parse(readFileSync(join(dir, "argv.json"), "utf8"));
    expect(seen.marker).toBe(true);
    expect(seen.argv).toEqual(["tune", "--profile", join(state, "profiles", "model-a.json"), "--budget", "30m", "--target", "decode", "--allow", "lossless"]);
    const text = out.join("\n");
    expect(text).toMatch(/uio: round 1: control/);
    expect(text).toMatch(/decode tok\/s\s+20\.0\s+24\.0/);
    expect(text).toMatch(/ceiling %\s+50%\s+60%/);
    expect(text).toMatch(/not applied/);
    expect(existsSync(join(state, "tuning.json"))).toBe(false);
    expect(readProfile(state, "model-a")?.extraArgs).toEqual([]);
  });

  it("--apply: re-reads the profile, confirms the new args and records uioLastTune", async () => {
    const { out, options, state, uio } = setup();
    process.env.STEAK_PI_UIO = uio;
    expect(await main(["tune", "model-a", "--apply"], options)).toBe(0);
    const profile = readProfile(state, "model-a");
    expect(profile?.extraArgs).toEqual(["--flash-attn", "on"]);
    expect(profile?.uioLastTune).toMatchObject({ workdir: "/tmp/uio-work", decodeTokS: 24 });
    expect(out.join("\n")).toMatch(/applied: local\/model-a extraArgs are now \["--flash-attn","on"\]/);
  });

  it("--apply fails (exit 3) when the profile does not carry the best args afterwards", async () => {
    const { err, options, uio } = setup();
    process.env.STEAK_PI_UIO = uio; process.env.FAKE_UIO_MODE = "noapply";
    expect(await main(["tune", "model-a", "--apply"], options)).toBe(3);
    expect(err.join("\n")).toMatch(/not the best args/);
  });

  it("passes uio's refusal (exit 2) through and releases the state", async () => {
    const { err, options, state, uio } = setup();
    process.env.STEAK_PI_UIO = uio; process.env.FAKE_UIO_MODE = "refuse";
    expect(await main(["tune", "model-a"], options)).toBe(2);
    expect(err.join("\n")).toMatch(/REFUSED \(uio-refused\): on battery/);
    expect(existsSync(join(state, "tuning.json"))).toBe(false);
  });

  it("reports a uio failure (exit 3) and releases the state", async () => {
    const { err, options, state, uio } = setup();
    process.env.STEAK_PI_UIO = uio; process.env.FAKE_UIO_MODE = "fail";
    expect(await main(["tune", "model-a"], options)).toBe(3);
    expect(err.join("\n")).toMatch(/uio tune failed \(exit 3\): server crashed/);
    expect(existsSync(join(state, "tuning.json"))).toBe(false);
  });

  it("prints the one install command and exits 2 when uio is missing", async () => {
    const { err, options, dir } = setup();
    process.env.STEAK_PI_UIO = join(dir, "nope");
    expect(await main(["tune", "model-a"], options)).toBe(2);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("curl -fsSL https://github.com/michael-berardi/ultra-inference-optimization/releases/latest/download/install.sh | sh");
  });

  it("refuses by name, with the user count, when a lease holds the server; the server is left alone", async () => {
    const { err, options, state, uio, fake } = setup();
    process.env.STEAK_PI_UIO = uio;
    fake.state.healthy = true;
    expect(await main(["ensure", "model-a"], options)).toBe(0);
    expect(await main(["tune", "model-a"], options)).toBe(2);
    expect(err.join("\n")).toMatch(/REFUSED \(in-use\): local\/model-a is in use by 1 user\(s\)/);
    expect(existsSync(join(state, "tuning.json"))).toBe(false);
    expect(fake.signals).toEqual([]);
  });

  it("stops the idle server before tuning", async () => {
    const { out, options, uio, fake } = setup();
    process.env.STEAK_PI_UIO = uio;
    fake.state.healthy = true;
    await main(["ensure", "model-a"], options);
    await main(["release", "model-a"], options);
    expect(await main(["tune", "model-a"], options)).toBe(0);
    expect(out.join("\n")).toMatch(/stopped local\/model-a \(idle\)/);
    expect(fake.signals.length).toBeGreaterThan(0);
  });

  it("refuses with the hold decision when a hold is on", async () => {
    const { err, options, uio } = setup();
    process.env.STEAK_PI_UIO = uio;
    await main(["hold", "2h", "demo"], options);
    expect(await main(["tune", "model-a"], options)).toBe(2);
    expect(err.join("\n")).toMatch(/REFUSED \(on-hold\)/);
  });

  it("ensure and check refuse 'tuning in progress' while it runs, and a dead PID is not tuning (crash recovery)", async () => {
    const { err, options, state, fake } = setup();
    writeAtomic(join(state, "tuning.json"), JSON.stringify({ id: "model-a", pid: 100, since: 1_000_000 }));
    expect(await main(["check", "model-a"], options)).toBe(3);
    expect(await main(["ensure", "model-a"], options)).toBe(2);
    expect(err.join("\n")).toMatch(/REFUSED \(tuning\): tuning in progress \(since 1970-01-01 00:16:40 UTC\)/);
    fake.alive.delete(100);
    fake.alive.add(101);
    writeAtomic(join(state, "tuning.json"), JSON.stringify({ id: "model-a", pid: 4242, since: 1_000_000 }));
    expect(await main(["check", "model-a"], options)).toBe(0);
    expect(existsSync(join(state, "tuning.json"))).toBe(false);
  });

  it("rejects bad options and unknown models before touching anything", async () => {
    const { err, options, uio } = setup();
    process.env.STEAK_PI_UIO = uio;
    expect(await main(["tune", "model-a", "--target", "speed"], options)).toBe(2);
    expect(await main(["tune", "model-a", "--budget", "soon"], options)).toBe(2);
    expect(await main(["tune", "nope"], options)).toBe(2);
    expect(err.join("\n")).toMatch(/no local model "nope"/);
  });
});

describe("provider neutrality", () => {
  it("the tune module names no model, publisher, repo or quant", () => {
    const text = readFileSync(join(__dirname, "..", "src", "local", "tune.ts"), "utf8");
    expect(text).not.toMatch(/qwen|llama-?3|mistral|gemma|phi-?\d|deepseek|unsloth|bartowski|Q4_K|Q5_K|Q8_0|huggingface\.co\/[a-z]/i);
  });
});

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sameProcess, systemDeps } from "../src/local/runtime.ts";
import { main, type Io } from "../src/local/cli.ts";
import { readProfile, writeAtomic } from "../src/local/store.ts";
import { fakeMachine, seedProfile, tempDir } from "./helpers/local-fixture.ts";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); delete process.env.STEAK_PI_UIO; delete process.env.FAKE_UIO_MODE; });

const LAUNCH = ["-np", "1", "-ngl", "999", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--jinja", "--cache-ram", "2048", "--no-webui", "--batch-size", "512", "--ubatch-size", "128", "--metrics"];
const WRITTEN = ["--spec-type", "draft-mtp", "--spec-draft-n-max", "5"];
/** A v2-shaped result (CONTRACT-v2), modelled on a captured `uio tune` stdout. */
const RESULT = {
  baseline: { args: LAUNCH, decode: 20, prefill: 200, ttft: 900 },
  best: { args: [...LAUNCH, ...WRITTEN], decode: 24, prefill: 210, ttft: 800 },
  ceiling: { decodeTokS: { weightsOnly: 40, atCtx: 33.6, speculative: null, ctx: 65536 }, kvBytesPerToken: 69632 },
  percentOfCeiling: 60,
  accepted: [{ lever: "speculative-draft-length" }], rejected: [{}, {}], plateau: true, stoppedBecause: "plateau", workdir: "/tmp/uio-work",
  applied: { written: true, extraArgs: WRITTEN, backup: "/tmp/uio-work/backup.json", reason: "applied" },
  confirmation: { ran: true, gainRatio: 1.2, ci: [1.1, 1.3], passed: true },
};

/** A fake `uio`: a node script whose behaviour follows FAKE_UIO_MODE; it logs its argv and whether the tuning marker existed. */
function fakeUio(dir: string, state: string): string {
  const path = join(dir, "uio");
  writeFileSync(path, `#!${process.execPath}
const fs = require("fs");
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify({ argv, marker: fs.existsSync(${JSON.stringify(join(state, "tuning.json"))}) }));
const mode = process.env.FAKE_UIO_MODE || "ok";
console.error("round 1: control");
const result = ${JSON.stringify(RESULT)};
if (mode === "notwritten") result.applied = { written: false, extraArgs: null, backup: null, reason: "confirmation failed" };
if (mode === "nulldecode") result.best.decode = null;
if (mode === "refuse") { console.error("on battery"); process.exit(2); }
if (mode === "fail") { console.error("server crashed"); process.exit(3); }
if (argv.includes("--apply") && mode !== "noapply" && mode !== "notwritten") {
  const file = argv[argv.indexOf("--profile") + 1];
  const p = JSON.parse(fs.readFileSync(file, "utf8")); p.extraArgs = mode === "mismatch" ? ["--other"] : ${JSON.stringify(WRITTEN)};
  fs.writeFileSync(file, JSON.stringify(p));
}
console.log(JSON.stringify(result));
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
    expect(seen.argv.slice(0, 3)).toEqual(["tune", "--profile", join(state, "profiles", "model-a.json")]);
    expect(seen.argv[3]).toBe("--launch-args");
    // The baseline is the server Steak Pi really launches: its fixed flags go to uio, never the model path, host, port or ctx.
    const launch = JSON.parse(seen.argv[4]) as string[];
    expect(launch).toEqual(expect.arrayContaining(["-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0", "--jinja"]));
    for (const flag of ["-m", "-hf", "--host", "--port", "-c"]) expect(launch).not.toContain(flag);
    expect(seen.argv.slice(5)).toEqual(["--budget", "30m", "--target", "decode", "--allow", "lossless"]);
    const text = out.join("\n");
    expect(text).toMatch(/uio: round 1: control/);
    expect(text).toMatch(/decode tok\/s\s+20\.0\s+24\.0/);
    expect(text).toMatch(/ceiling %\s+60%/);
    expect(text).toMatch(/not applied; tested arguments .*--spec-draft-n-max 5/);
    expect(existsSync(join(state, "tuning.json"))).toBe(false);
    expect(readProfile(state, "model-a")?.extraArgs).toEqual([]);
  });

  it("--apply: re-reads the profile, confirms the new args and records uioLastTune", async () => {
    const { out, options, state, uio } = setup();
    process.env.STEAK_PI_UIO = uio;
    expect(await main(["tune", "model-a", "--apply"], options)).toBe(0);
    const profile = readProfile(state, "model-a");
    expect(profile?.extraArgs).toEqual(WRITTEN);
    expect(profile?.uioLastTune).toMatchObject({ workdir: "/tmp/uio-work", decodeTokS: 24 });
    expect(out.join("\n")).toMatch(/applied: local\/model-a written extraArgs are now \["--spec-type"/);
  });

  it("--apply fails (exit 3) when the profile does not carry the best args afterwards", async () => {
    const { err, options, uio } = setup();
    process.env.STEAK_PI_UIO = uio; process.env.FAKE_UIO_MODE = "noapply";
    expect(await main(["tune", "model-a", "--apply"], options)).toBe(3);
    expect(err.join("\n")).toMatch(/not the ones uio reported/);
  });

  it("--apply fails (exit 3) when the profile's extraArgs differ from applied.extraArgs", async () => {
    const { err, options, uio } = setup();
    process.env.STEAK_PI_UIO = uio; process.env.FAKE_UIO_MODE = "mismatch";
    expect(await main(["tune", "model-a", "--apply"], options)).toBe(3);
    expect(err.join("\n")).toMatch(/not the ones uio reported/);
  });

  it("--apply with applied.written false prints 'not applied: <reason>', exits 0 and records nothing", async () => {
    const { out, err, options, state, uio } = setup();
    process.env.STEAK_PI_UIO = uio; process.env.FAKE_UIO_MODE = "notwritten";
    expect(await main(["tune", "model-a", "--apply"], options)).toBe(0);
    expect(out.join("\n")).toMatch(/not applied: confirmation failed/);
    expect(err).toEqual([]);
    expect(readProfile(state, "model-a")?.uioLastTune).toBeUndefined();
  });

  it("does not record uioLastTune when best.decode is not a number", async () => {
    const { options, state, uio } = setup();
    process.env.STEAK_PI_UIO = uio; process.env.FAKE_UIO_MODE = "nulldecode";
    expect(await main(["tune", "model-a", "--apply"], options)).toBe(0);
    expect(readProfile(state, "model-a")?.extraArgs).toEqual(WRITTEN);
    expect(readProfile(state, "model-a")?.uioLastTune).toBeUndefined();
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
    expect(err[0]).toContain('uv tool install "git+https://github.com/michael-berardi/ultra-inference-optimization@v0.1.0"');
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

describe("tuner liveness", () => {
  it("an unknown start time counts as the same process; a known different one does not", () => {
    expect(sameProcess("Mon 1", undefined)).toBe(true);
    expect(sameProcess(undefined, "Mon 1")).toBe(true);
    expect(sameProcess("Mon 1", "Mon 1")).toBe(true);
    expect(sameProcess("Mon 1", "Tue 2")).toBe(false);
  });
  it("systemDeps.alive is true for a live PID with no recorded start", () => {
    expect(systemDeps("/nonexistent").alive(process.pid)).toBe(true);
    expect(systemDeps("/nonexistent").alive(process.pid, "bogus start")).toBe(false);
  });
});

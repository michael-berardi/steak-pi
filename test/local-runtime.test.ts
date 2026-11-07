import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { ensure, WATCHDOG, manualHolder, pidHolder, Refused, release, status, stop, supervise, type Deps, type LeaseFile, type ServerRecord } from "../src/local/runtime.ts";
import { LocalError, readJson } from "../src/local/store.ts";
import { fakeMachine, GIB, seedProfile, tempDir, type Fake } from "./helpers/local-fixture.ts";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); });
function setup(profileOverrides = {}, deps: Partial<Deps> = {}): { dir: string; fake: Fake } {
  const dir = tempDir();
  dirs.push(dir);
  seedProfile(dir.path, profileOverrides);
  return { dir: dir.path, fake: fakeMachine(dir.path, deps) };
}
const holders = (dir: string) => readJson<LeaseFile>(join(dir, "leases.json"))?.holders ?? {};
const count = (dir: string) => Object.values(holders(dir)).reduce((sum, entry) => sum + entry.count, 0);
const refusal = async (promise: Promise<unknown>): Promise<Refused> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Refused);
  return error as Refused;
};

describe("leases and ensure", () => {
  it("starts the server once, then shares it: ensure/release are refcounted per holder", async () => {
    const { dir, fake } = setup();
    fake.alive.add(301).add(302);
    fake.state.healthyAfterMs = 3000;
    const first = await ensure(fake.deps, "model-a", pidHolder(301));
    expect(first).toMatchObject({ started: true, baseUrl: "http://127.0.0.1:18089/v1" });
    expect(fake.calls).toEqual(["supervisor:model-a"]);
    const second = await ensure(fake.deps, "model-a", pidHolder(302));
    expect(second.started).toBe(false);
    expect(fake.calls).toHaveLength(1);
    await ensure(fake.deps, "model-a", pidHolder(301)); // the same holder twice (a session and a worker it launched)
    expect(count(dir)).toBe(3);
    expect((await release(fake.deps, pidHolder(301))).remaining).toBe(2);
    expect((await release(fake.deps, pidHolder(302))).remaining).toBe(1);
    expect(readJson<LeaseFile>(join(dir, "leases.json"))?.idleSince).toBeUndefined();
    expect((await release(fake.deps, pidHolder(301))).remaining).toBe(0);
    expect(readJson<LeaseFile>(join(dir, "leases.json"))?.idleSince).toBe(fake.clock.t);
    expect((await release(fake.deps, pidHolder(301))).remaining).toBe(0); // an extra release is harmless
  });

  it("a manual start is a single pinned reference, however many times it runs", async () => {
    const { dir, fake } = setup();
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", manualHolder());
    await ensure(fake.deps, "model-a", manualHolder());
    expect(holders(dir).manual?.count).toBe(1);
  });

  it("drops a holder whose process died, starting the idle clock", async () => {
    const { dir, fake } = setup();
    fake.alive.add(301);
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", pidHolder(301));
    fake.alive.delete(301);
    const record = readJson<ServerRecord>(join(dir, "server.json"))!;
    expect(record.id).toBe("model-a");
    const state = await status(fake.deps);
    expect(state.holders).toBe(0);
    fake.clock.t += 5000;
    await release(fake.deps, pidHolder(999)); // any write prunes: the dead holder is gone
    expect(count(dir)).toBe(0);
    expect(readJson<LeaseFile>(join(dir, "leases.json"))?.idleSince).toBeDefined();
  });

  it("names a missing profile, and lists the known ones", async () => {
    const { fake } = setup();
    const error = await ensure(fake.deps, "nope", pidHolder(100)).then(() => undefined, (caught: unknown) => caught as LocalError);
    expect(error).toBeInstanceOf(LocalError);
    expect(error?.code).toBe("unknown-model");
    expect(error?.message).toMatch(/known: model-a/);
  });
});

describe("refusals", () => {
  const cases: Array<[string, (fake: Fake) => void, RegExp]> = [
    ["llama-server-missing", (fake) => { fake.state.binary = undefined; }, /not found on PATH; install llama\.cpp/],
    ["disk-full", (fake) => { fake.state.disk = 93; }, /93% used \(limit 90%\)/],
    ["other-server", (fake) => { fake.state.others = [{ pid: 4242, name: "llama-server" }]; }, /PID 4242 \(llama-server\).*one model server at a time/],
    ["port-busy", (fake) => { fake.state.portTaken = true; }, /127\.0\.0\.1:18089 is held/],
    ["insufficient-memory", (fake) => { fake.state.available = 8 * GIB; }, /needs about 1[4-6]\.\d GiB.*only 8\.0 GiB is free or reclaimable/],
  ];
  it.each(cases)("%s: refuses with a named cause, leaves no lease and starts nothing", async (code, arrange, message) => {
    const { dir, fake } = setup();
    arrange(fake);
    const error = await refusal(ensure(fake.deps, "model-a", pidHolder(100)));
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
    expect(count(dir)).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(existsSync(join(dir, "server.json"))).toBe(false);
  });

  it("model-missing: the model file is gone", async () => {
    const { fake } = setup({ source: { kind: "file", path: "/nonexistent/gone.gguf" } });
    expect((await refusal(ensure(fake.deps, "model-a", pidHolder(100)))).code).toBe("model-missing");
  });

  it("other-model-running: refuses while another model has users, and replaces an idle one", async () => {
    const { dir, fake } = setup();
    seedProfile(dir, { id: "model-b", port: 18090 });
    fake.alive.add(301).add(302);
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", pidHolder(301));
    const error = await refusal(ensure(fake.deps, "model-b", pidHolder(302)));
    expect(error.code).toBe("other-model-running");
    expect(error.message).toMatch(/model-a is running with 1 user/);
    expect(count(dir)).toBe(1);
    await release(fake.deps, pidHolder(301));
    const result = await ensure(fake.deps, "model-b", pidHolder(302));
    expect(result.started).toBe(true);
    expect(fake.calls).toEqual(["supervisor:model-a", "supervisor:model-b"]);
    expect(fake.signals.some((entry) => entry.signal === "SIGTERM" && entry.pid === 5000)).toBe(true); // the old supervisor was told to stop
    expect(readJson<ServerRecord>(join(dir, "server.json"))?.id).toBe("model-b");
  });

  it("replaces an idle server of another model on the SAME port (the port stays taken until the stop)", async () => {
    const { dir, fake } = setup();
    seedProfile(dir, { id: "model-b" }); // same default port as model-a
    fake.alive.add(301).add(302);
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", pidHolder(301));
    await release(fake.deps, pidHolder(301));
    fake.deps.portFree = async () => !fake.alive.has(5000); // model-a's supervisor holds the port until it is stopped
    const result = await ensure(fake.deps, "model-b", pidHolder(302));
    expect(result.started).toBe(true);
    expect(readJson<ServerRecord>(join(dir, "server.json"))?.id).toBe("model-b");
  });

  it("replaces an orphaned server (supervisor gone, server alive) on the same port", async () => {
    const { dir, fake } = setup();
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", pidHolder(100));
    await release(fake.deps, pidHolder(100));
    const record = readJson<ServerRecord>(join(dir, "server.json"))!;
    fake.alive.delete(record.supervisorPid);
    fake.alive.add(777);
    writeFileSync(join(dir, "server.json"), JSON.stringify({ ...record, serverPid: 777, serverStart: "start-777" }));
    fake.deps.portFree = async () => !fake.alive.has(777);
    fake.clock.t += fake.deps.graceMs + 1000; // idle past the grace: reaped, then started fresh
    expect((await ensure(fake.deps, "model-a", pidHolder(100))).started).toBe(true);
    expect(fake.alive.has(777)).toBe(false);
  });

  it("counts the replaced server's memory as free before the stop", async () => {
    const { dir, fake } = setup();
    seedProfile(dir, { id: "model-b" });
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", pidHolder(100));
    await release(fake.deps, pidHolder(100));
    fake.deps.availableBytes = () => (fake.alive.has(5000) ? 1 * GIB : 64 * GIB); // model-a's weights are still resident until it stops
    expect((await ensure(fake.deps, "model-b", pidHolder(100))).started).toBe(true);
  });

  it("a refused start leaves the idle server running (it is refused before any stop)", async () => {
    const { dir, fake } = setup();
    seedProfile(dir, { id: "model-b", source: { kind: "file", path: "/nonexistent/gone.gguf" } });
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", pidHolder(100));
    await release(fake.deps, pidHolder(100));
    expect((await refusal(ensure(fake.deps, "model-b", pidHolder(100)))).code).toBe("model-missing");
    expect(fake.alive.has(5000)).toBe(true);
    expect(readJson<ServerRecord>(join(dir, "server.json"))?.id).toBe("model-a");
  });

  it("health-timeout: a server that never reports healthy is stopped and its lease given back", async () => {
    const { dir, fake } = setup();
    const error = await refusal(ensure(fake.deps, "model-a", pidHolder(100)));
    expect(error.code).toBe("health-timeout");
    expect(error.message).toMatch(/within 30s/);
    expect(count(dir)).toBe(0);
    expect(fake.signals.some((entry) => entry.signal === "SIGTERM")).toBe(true);
    expect(existsSync(join(dir, "server.json"))).toBe(false);
  });

  it("server-exited: names it when the supervisor dies while loading", async () => {
    const { dir, fake } = setup();
    let ticks = 0;
    const sleep = fake.deps.sleep;
    fake.deps.sleep = async (ms) => { await sleep(ms); if (++ticks === 2) fake.alive.delete(5000); };
    const error = await refusal(ensure(fake.deps, "model-a", pidHolder(100)));
    expect(error.code).toBe("server-exited");
    expect(count(dir)).toBe(0);
  });
});

describe("stop and status", () => {
  it("stops only what it started, clears the leases and confirms the port is released", async () => {
    const { dir, fake } = setup();
    fake.alive.add(301).add(302);
    fake.state.healthy = true;
    expect((await stop(fake.deps)).stopped).toBe(false);
    await ensure(fake.deps, "model-a", pidHolder(301));
    await ensure(fake.deps, "model-a", pidHolder(302));
    expect((await status(fake.deps)).holders).toBe(2);
    const result = await stop(fake.deps);
    expect(result).toMatchObject({ stopped: true, id: "model-a", port: 18089, portReleased: true, detached: 2 });
    expect(count(dir)).toBe(0);
    expect(existsSync(join(dir, "server.json"))).toBe(false);
    expect(fake.signals.every((entry) => entry.pid === 5000)).toBe(true);
  });

  it("reports a port that is still held after the stop", async () => {
    const { fake } = setup();
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", manualHolder());
    fake.state.portTaken = true;
    expect(await stop(fake.deps)).toMatchObject({ stopped: true, portReleased: false });
  });
});

/** A fake llama-server child: it exits when it is sent SIGTERM. */
function fakeChild(fake: Fake) {
  let end!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => { end = resolve; });
  fake.alive.add(7000);
  fake.deps.spawnServer = () => ({ pid: 7000, exited });
  const base = fake.deps.signal;
  fake.deps.signal = (pid, signal, group) => { base(pid, signal, group); if (pid === 7000 && (signal === "SIGTERM" || signal === "SIGKILL")) end(143); };
  return { end };
}

describe("idle auto-stop (fake clock, fake server)", () => {
  const GRACE = 600_000;

  it("stops the server exactly one grace period after the last lease is released, and not before", async () => {
    const { dir, fake } = setup();
    fake.alive.add(301);
    fake.state.healthy = true;
    fakeChild(fake);
    await ensure(fake.deps, "model-a", pidHolder(301));
    let ticks = 0; let releasedAt = 0; let stoppedAt = 0;
    const tick = fake.deps.sleep;
    fake.deps.sleep = async (ms) => {
      await tick(ms);
      if (++ticks === 5) { await release(fake.deps, pidHolder(301)); releasedAt = fake.clock.t; }
    };
    const signal = fake.deps.signal;
    fake.deps.signal = (pid, name, group) => { if (pid === 7000 && !stoppedAt) stoppedAt = fake.clock.t; signal(pid, name, group); };
    const result = await supervise(fake.deps, "model-a");
    expect(result).toEqual({ reason: "idle", portReleased: true });
    expect(releasedAt).toBeGreaterThan(0);
    expect(stoppedAt - releasedAt).toBeGreaterThanOrEqual(GRACE);
    expect(stoppedAt - releasedAt).toBeLessThan(GRACE + 5000);
    expect(fake.signals.filter((entry) => entry.pid === 7000 && entry.signal === "SIGTERM")).toHaveLength(1);
    expect(existsSync(join(dir, "server.json"))).toBe(false);
  });

  it("a new lease inside the grace period cancels the stop", async () => {
    const { fake } = setup();
    fake.alive.add(301).add(302);
    fake.state.healthy = true;
    fakeChild(fake);
    await ensure(fake.deps, "model-a", pidHolder(301));
    let ticks = 0;
    let finish!: () => void;
    const stopRequested = new Promise<void>((resolve) => { finish = resolve; });
    const tick = fake.deps.sleep;
    fake.deps.sleep = async (ms) => {
      await tick(ms);
      ticks++;
      if (ticks === 5) await release(fake.deps, pidHolder(301));
      if (ticks === 100) await ensure(fake.deps, "model-a", pidHolder(302)); // 200 s into the grace period
      if (ticks === 400) { expect(fake.signals.filter((entry) => entry.pid === 7000)).toHaveLength(0); finish(); } // well past one grace from the first release
    };
    const result = await supervise(fake.deps, "model-a", stopRequested);
    expect(result.reason).toBe("signal");
  });

  it("a holder that died counts as released: the grace period starts when the supervisor notices", async () => {
    const { fake } = setup();
    fake.alive.add(301);
    fake.state.healthy = true;
    fakeChild(fake);
    await ensure(fake.deps, "model-a", pidHolder(301));
    fake.alive.delete(301);
    const start = fake.clock.t;
    const result = await supervise(fake.deps, "model-a");
    expect(result.reason).toBe("idle");
    expect(fake.clock.t - start).toBeGreaterThanOrEqual(GRACE);
  });

  it("ends, with the record removed, when the server exits on its own", async () => {
    const { dir, fake } = setup();
    fake.state.healthy = true;
    const child = fakeChild(fake);
    await ensure(fake.deps, "model-a", manualHolder());
    child.end(1);
    expect(await supervise(fake.deps, "model-a")).toMatchObject({ reason: "server-exited" });
    expect(existsSync(join(dir, "server.json"))).toBe(false);
    expect(readJson<ServerRecord>(join(dir, "server.json"))).toBeUndefined();
    expect(readFileSync(join(dir, "leases.json"), "utf8")).toContain("manual");
  });
});

describe("one SIGTERM per server", () => {
  it("stop lets a live supervisor send the server's SIGTERM; it never sends a second one", async () => {
    // 2026-11-02: a second SIGTERM made llama.cpp abort with a Metal assertion mid-shutdown.
    const { dir, fake } = setup();
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", manualHolder());
    const record = readJson<ServerRecord>(join(dir, "server.json"))!;
    fake.alive.add(7002);
    writeFileSync(join(dir, "server.json"), JSON.stringify({ ...record, serverPid: 7002, serverStart: "start-7002" }));
    // The supervisor, asked to stop, has already sent its server the one SIGTERM and exits; the server is still shutting
    // down (Metal teardown) when stop looks. Stop must wait and then SIGKILL, never SIGTERM it again.
    const base = fake.deps.signal;
    fake.deps.signal = (pid, signal, group) => {
      fake.signals.push({ pid, signal, group: group === true });
      if (pid === 7002) { if (signal === "SIGKILL") fake.alive.delete(7002); return; }
      base(pid, signal, group);
      fake.signals.pop();
    };
    await stop(fake.deps);
    expect(fake.signals.filter((entry) => entry.pid === 7002).map((entry) => entry.signal)).toEqual(["SIGKILL"]);
  });

  it("without a supervisor, stop sends the server one SIGTERM, then SIGKILL only if it is still there", async () => {
    const { dir, fake } = setup();
    fake.state.healthy = true;
    await ensure(fake.deps, "model-a", manualHolder());
    const record = readJson<ServerRecord>(join(dir, "server.json"))!;
    fake.alive.add(7003);
    writeFileSync(join(dir, "server.json"), JSON.stringify({ ...record, serverPid: 7003, serverStart: "start-7003" }));
    fake.alive.delete(record.supervisorPid);
    const base = fake.deps.signal;
    fake.deps.signal = (pid, signal, group) => { fake.signals.push({ pid, signal, group: group === true }); if (pid === 7003 && signal === "SIGKILL") fake.alive.delete(7003); else if (pid !== 7003) base(pid, signal, group); };
    await stop(fake.deps);
    expect(fake.signals.filter((entry) => entry.pid === 7003).map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("orphans", () => {
  /** A server recorded as started by a supervisor that was then killed hard (the server, with its start time, lives on). */
  async function orphaned(holder?: number) {
    const world = setup();
    world.fake.alive.add(301);
    world.fake.state.healthy = true;
    await ensure(world.fake.deps, "model-a", pidHolder(301));
    if (holder === undefined) await release(world.fake.deps, pidHolder(301));
    const record = readJson<ServerRecord>(join(world.dir, "server.json"))!;
    world.fake.alive.add(7001);
    writeFileSync(join(world.dir, "server.json"), JSON.stringify({ ...record, serverPid: 7001, serverStart: "start-7001" }));
    world.fake.alive.delete(record.supervisorPid);
    return { ...world, record };
  }
  const recorded = (dir: string) => readJson<ServerRecord>(join(dir, "server.json"));

  it("with live holders, ensure adopts the orphan: a new supervisor takes over and nothing is stopped", async () => {
    const { dir, fake, record } = await orphaned(301);
    const result = await ensure(fake.deps, "model-a", pidHolder(301));
    expect(result.started).toBe(false);
    expect(fake.signals.some((entry) => entry.pid === 7001)).toBe(false);
    expect(fake.calls).toEqual(["supervisor:model-a", "supervisor:model-a"]);
    expect(recorded(dir)).toMatchObject({ serverPid: 7001, serverStart: "start-7001" });
    expect(recorded(dir)?.supervisorPid).not.toBe(record.supervisorPid);
  });

  it("idle past the grace, any entry point stops the orphan, verifies the port and clears server.json", async () => {
    for (const entry of ["status", "ensure", "release", "stop"] as const) {
      const { dir, fake } = await orphaned();
      fake.clock.t += fake.deps.graceMs + 1000;
      if (entry === "status") {
        const state = await status(fake.deps);
        expect(state.orphan).toMatchObject({ action: "stopped", pid: 7001, portReleased: true });
        expect(state.running).toBeUndefined();
      }
      if (entry === "ensure") expect((await ensure(fake.deps, "model-a", pidHolder(301))).started).toBe(true);
      if (entry === "release") await release(fake.deps, pidHolder(301));
      if (entry === "stop") await stop(fake.deps);
      expect(fake.signals.some((e) => e.pid === 7001 && e.signal === "SIGTERM" && e.group)).toBe(true);
      expect(fake.alive.has(7001)).toBe(false);
      if (entry !== "ensure") expect(existsSync(join(dir, "server.json"))).toBe(false);
    }
  });

  it("idle but inside the grace: status adopts it, so the new supervisor does the idle stop", async () => {
    const { dir, fake } = await orphaned();
    fake.clock.t += 60_000;
    const state = await status(fake.deps);
    expect(state.orphan).toMatchObject({ action: "adopted" });
    expect(fake.signals.some((entry) => entry.pid === 7001)).toBe(false);
    expect(recorded(dir)?.supervisorPid).toBeGreaterThan(5000);
  });

  it("never touches a process that is not the recorded server (start time differs)", async () => {
    const { dir, fake } = await orphaned();
    fake.clock.t += fake.deps.graceMs + 1000;
    fake.deps.alive = (pid, start) => fake.alive.has(pid) && (start === undefined || start === `start-${pid}`) && pid !== 7001;
    expect((await status(fake.deps)).orphan).toBeUndefined();
    expect(fake.signals.some((entry) => entry.pid === 7001)).toBe(false);
    expect(existsSync(join(dir, "server.json"))).toBe(false); // the stale record goes; the stranger is left alone
  });

  it("supervise in adopt mode idle-stops the adopted server after the grace", async () => {
    const { dir, fake } = await orphaned();
    const result = await supervise(fake.deps, "model-a", undefined, { pid: 7001, start: "start-7001" });
    expect(result.reason).toBe("idle");
    expect(fake.alive.has(7001)).toBe(false);
    expect(existsSync(join(dir, "server.json"))).toBe(false);
  });
});

describe("the server dies with its supervisor (real sh watchdog)", () => {
  const gone = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch { return true; } };
  it("SIGKILL of the supervisor stops the server within seconds", async () => {
    // The middle sh stands in for the supervisor: it starts the watchdog with its own PID as `sup`.
    const middle = spawn("/bin/sh", ["-c", `/bin/sh -c "$1" w $$ /bin/sleep 300 & echo $!; wait`, "m", WATCHDOG], { stdio: ["ignore", "pipe", "ignore"] });
    const watchdog = Number(await new Promise<string>((resolve) => middle.stdout.once("data", (chunk) => resolve(String(chunk).trim()))));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const sleeper = Number(execFileSync("pgrep", ["-P", String(watchdog)], { encoding: "utf8" }).trim().split("\n")[0]);
    expect(sleeper).toBeGreaterThan(0);
    process.kill(middle.pid!, "SIGKILL");
    const deadline = Date.now() + 8000;
    while ((!gone(sleeper) || !gone(watchdog)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gone(sleeper)).toBe(true);
    expect(gone(watchdog)).toBe(true);
  }, 15_000);
});

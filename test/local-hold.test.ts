import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/local/cli.ts";
import { activeHold, addQuiet, holdPath, localDay, parseDuration, quietTrigger, readHold, setHold, type HoldProbe } from "../src/local/hold.ts";
import { check, ensure, pidHolder, Refused, supervise } from "../src/local/runtime.ts";
import { LocalError, readJson } from "../src/local/store.ts";
import { fakeMachine, seedProfile, tempDir } from "./helpers/local-fixture.ts";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); });

const HOUR = 3_600_000;
// Noon local time on a fixed day, so "today" and "tomorrow" are unambiguous in any time zone.
const NOON = new Date(2031, 4, 10, 12, 0, 0).getTime();

interface World { processes: string[]; times: Map<string, number>; worktrees: string[] }
function setup() {
  const dir = tempDir();
  dirs.push(dir);
  seedProfile(dir.path);
  const world: World = { processes: [], times: new Map(), worktrees: [] };
  const probe: HoldProbe = {
    processNames: () => world.processes,
    mtime: (path) => world.times.get(path),
    list: (path) => (path.endsWith(join(".git", "worktrees")) ? world.worktrees : []),
  };
  const fake = fakeMachine(dir.path, { holdProbe: probe });
  fake.clock.t = NOON;
  fake.alive.add(301);
  fake.state.healthy = true;
  const repo = join(dir.path, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const out: string[] = []; const err: string[] = [];
  const io: Io = { out: (text) => out.push(text), err: (text) => err.push(text) };
  return { dir: dir.path, fake, world, probe, repo, out, err, options: { io, deps: fake.deps, ppid: 301 } };
}
const refusal = async (promise: Promise<unknown>): Promise<Refused> => {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(Refused);
  return error as Refused;
};

describe("timed hold", () => {
  it("refuses every start until the hold ends, then allows them again with nobody doing anything", async () => {
    const { dir, fake } = setup();
    await setHold(dir, NOON + 24 * HOUR, "heavy work");
    const refused = await refusal(ensure(fake.deps, "model-a", pidHolder(301)));
    expect(refused.code).toBe("on-hold");
    expect(refused.message).toMatch(/on hold until 2031-05-11 12:00 \(heavy work\)/);
    expect((await refusal(check(fake.deps, "model-a"))).code).toBe("on-hold");
    expect(fake.calls).toEqual([]); // nothing was started
    expect(existsSync(join(dir, "leases.json"))).toBe(false); // and no lease was taken
    fake.clock.t = NOON + 24 * HOUR - 1;
    expect(activeHold(dir, fake.clock.t, fake.deps.holdProbe)?.code).toBe("on-hold");
    fake.clock.t = NOON + 24 * HOUR;
    expect(activeHold(dir, fake.clock.t, fake.deps.holdProbe)).toBeUndefined();
    expect((await ensure(fake.deps, "model-a", pidHolder(301))).started).toBe(true);
  });

  it("refuses to join a server that is already running", async () => {
    const { dir, fake } = setup();
    await ensure(fake.deps, "model-a", pidHolder(301));
    await setHold(dir, NOON + HOUR);
    expect((await refusal(ensure(fake.deps, "model-a", pidHolder(301)))).code).toBe("on-hold");
  });

  it("a running server is stopped when a hold begins, even with users attached", async () => {
    const { dir, fake } = setup();
    await ensure(fake.deps, "model-a", pidHolder(301)); // a live lease
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
    const signals: string[] = [];
    const deps = { ...fake.deps,
      spawnServer: () => ({ pid: 7001, exited }),
      signal: (_pid: number, signal: NodeJS.Signals) => { signals.push(signal); resolveExit(0); } };
    await setHold(dir, NOON + HOUR);
    const result = await supervise(deps, "model-a");
    expect(result.reason).toBe("hold");
    expect(signals).toEqual(["SIGTERM"]); // one SIGTERM, never two
  });

  it("an unreadable hold file is a hold, never a silent pass", async () => {
    const { dir, fake } = setup();
    writeFileSync(holdPath(dir), "{ not json");
    const refused = await refusal(ensure(fake.deps, "model-a", pidHolder(301)));
    expect(refused.code).toBe("bad-hold");
    expect(refused.message).toMatch(/not valid JSON/);
    writeFileSync(holdPath(dir), JSON.stringify({ until: "tomorrow" }));
    expect((await refusal(ensure(fake.deps, "model-a", pidHolder(301)))).message).toMatch(/until must be a time/);
    writeFileSync(holdPath(dir), JSON.stringify({ quiet: { paths: "x" } }));
    expect((await refusal(ensure(fake.deps, "model-a", pidHolder(301)))).message).toMatch(/quiet\.paths must be a list/);
  });

  it("parses hold lengths and names a bad one", () => {
    expect(parseDuration("24h")).toBe(24 * HOUR);
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("1.5d")).toBe(36 * HOUR);
    for (const bad of ["", "24", "h", "-1h", "0h", "500d", "1w"]) expect(() => parseDuration(bad)).toThrow(LocalError);
  });
});

describe("quiet-day rule", () => {
  it("a listed program running switches the local model off for the rest of that day, and it returns the next day", async () => {
    const { dir, fake, world } = setup();
    await addQuiet(dir, "process", "Heavy App");
    expect((await ensure(fake.deps, "model-a", pidHolder(301))).started).toBe(true); // nothing heavy yet
    world.processes = ["sh", "heavy app"]; // matched without regard to case
    const refused = await refusal(check(fake.deps, "model-a"));
    expect(refused.code).toBe("quiet-day");
    expect(refused.message).toMatch(/off for the rest of today \(2031-05-10\): heavy app is running; it comes back tomorrow/);
    world.processes = []; // the program is closed: the day stays quiet
    fake.clock.t = NOON + 6 * HOUR;
    expect(activeHold(dir, fake.clock.t, fake.deps.holdProbe)?.code).toBe("quiet-day");
    expect(readHold(dir).quietDay).toEqual({ date: "2031-05-10", cause: "heavy app is running" });
    fake.clock.t = new Date(2031, 4, 11, 0, 0, 1).getTime(); // the next day starts clean
    expect(activeHold(dir, fake.clock.t, fake.deps.holdProbe)).toBeUndefined();
  });

  it("work in a listed repository today counts: a commit, a checkout, a merge, or one in a linked worktree; looking at it does not", async () => {
    const { dir, fake, world, repo, probe } = setup();
    await addQuiet(dir, "path", repo);
    const rule = readHold(dir).quiet!;
    world.times.set(join(repo, ".git", "HEAD"), NOON - 30 * HOUR); // yesterday: not today's work
    expect(quietTrigger(rule, NOON, probe)).toBeUndefined();
    world.times.set(join(repo, ".git", "index"), NOON - HOUR); // `git status` refreshes the index: that is not work
    expect(quietTrigger(rule, NOON, probe)).toBeUndefined();
    for (const file of [join(repo, ".git", "HEAD"), join(repo, ".git", "logs", "HEAD"), join(repo, ".git", "ORIG_HEAD")]) {
      world.times.clear();
      world.times.set(file, NOON - HOUR);
      expect(quietTrigger(rule, NOON, probe)).toBe(`work in ${repo} today`);
    }
    world.times.clear();
    world.worktrees = ["feature"];
    world.times.set(join(repo, ".git", "worktrees", "feature", "logs", "HEAD"), NOON - 5 * 60_000);
    expect(quietTrigger(rule, NOON, probe)).toBe(`work in ${repo} today`);
    expect((await refusal(ensure(fake.deps, "model-a", pidHolder(301)))).code).toBe("quiet-day");
    expect(fake.calls).toEqual([]);
  });

  it("a running server is stopped the moment the rule fires", async () => {
    const { dir, fake, world } = setup();
    await addQuiet(dir, "process", "heavy");
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
    let polls = 0;
    const deps = { ...fake.deps,
      spawnServer: () => ({ pid: 7001, exited }),
      sleep: async (ms: number) => { fake.clock.t += ms; if (++polls === 40) world.processes = ["heavy"]; },
      signal: () => { resolveExit(0); } };
    await ensure(fake.deps, "model-a", pidHolder(301));
    const result = await supervise(deps, "model-a");
    expect(result.reason).toBe("hold");
    expect(localDay(fake.clock.t)).toBe("2031-05-10");
  });

  it("refuses a path that is not a repository and a name that is not a program", async () => {
    const { dir } = setup();
    expect(() => addQuiet(dir, "path", join(dir, "nowhere"))).toThrow(/not a git repository/);
    expect(() => addQuiet(dir, "process", "a/b")).toThrow(/not a program name/);
  });
});

describe("steak-pi local hold / quiet", () => {
  it("hold 24h stops the server and refuses starts; hold off ends it; status shows it", async () => {
    const { dir, fake, out, err, options } = setup();
    expect(await main(["ensure", "model-a"], options)).toBe(0);
    expect(await main(["hold", "24h", "heavy", "work"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/^the local model is on hold until 2031-05-11 12:00 \(heavy work\).*; stopped local\/model-a, port 18089 released$/);
    expect(readJson(join(dir, "server.json"))).toBeUndefined();
    expect(await main(["ensure", "model-a"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/^steak-pi local: REFUSED \(on-hold\): the local model is on hold until/);
    expect(await main(["check", "model-a"], options)).toBe(3); // the coordinator's pre-launch check reads the same refusal
    expect(err.at(-1)).toBe(err.at(-2));
    expect(await main(["start"], options)).toBe(2);
    expect(await main(["status"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/\nhold     on-hold: the local model is on hold until 2031-05-11 12:00/);
    expect(await main(["hold", "off"], options)).toBe(0);
    expect(out.at(-1)).toBe("timed hold ended; the local model may run");
    expect(await main(["ensure", "model-a"], options)).toBe(0);
    expect(await main(["hold", "soon"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-option\): "soon" is not a hold length/);
    expect(await main(["hold"], options)).toBe(1);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("quiet path / process / remove / today manage the rule, and a rule that already fires stops the server at once", async () => {
    const { dir, world, repo, out, err, options } = setup();
    expect(await main(["quiet"], options)).toBe(0);
    expect(out.at(-1)).toBe("hold     none");
    expect(await main(["quiet", "process", "Heavy", "App"], options)).toBe(0);
    expect(await main(["quiet", "path", repo], options)).toBe(0);
    expect(out.at(-1)).toBe(`hold     none\nquiet    off for the day when: work in ${repo}; Heavy App runs`);
    expect(await main(["quiet", "process", "Heavy", "App"], options)).toBe(0); // adding twice keeps one entry
    expect(readHold(dir).quiet).toEqual({ paths: [repo], processes: ["Heavy App"] });
    expect(await main(["quiet", "remove", "Heavy", "App"], options)).toBe(0);
    expect(readHold(dir).quiet?.processes).toEqual([]);
    expect(await main(["quiet", "remove", "nope"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-option\): nope is not in the quiet rule/);
    expect(await main(["ensure", "model-a"], options)).toBe(0);
    world.times.set(join(repo, ".git", "logs", "HEAD"), NOON - 60_000);
    expect(await main(["quiet"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/^hold     quiet-day: .*work in .* today.*\nquiet    .*\nstopped  local\/model-a, port 18089 released$/);
    expect(await main(["ensure", "model-a"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(quiet-day\)/);
    expect(await main(["quiet", "sideways"], options)).toBe(1);
  });

  it("quiet today switches it off by hand for the rest of the day", async () => {
    const { dir, out, options } = setup();
    expect(await main(["quiet", "today", "playtest"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/^hold     quiet-day: .*\(2031-05-10\): playtest;/);
    expect(readHold(dir).quietDay).toEqual({ date: "2031-05-10", cause: "playtest" });
    expect(await main(["check", "model-a"], options)).toBe(3);
  });
});

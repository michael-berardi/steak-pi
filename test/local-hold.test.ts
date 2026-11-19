import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, type Io } from "../src/local/cli.ts";
import { activeHold, addQuiet, clearHold, describeHold, gitLayout, holdPath, lastReflogAt, localDay, parseDuration, quietTrigger, readHold, setHold, systemHoldProbe, type HoldProbe } from "../src/local/hold.ts";
import { check, ensure, pidHolder, Refused, supervise } from "../src/local/runtime.ts";
import { LocalError, readJson, tryLockSync, withLock } from "../src/local/store.ts";
import { transientFailure } from "../src/subagents/auto-resume.ts";
import { withProfileEnsure, type EnsureExec } from "../src/subagents/profile-ensure.ts";
import { emptyUsage, type RunRecord, type TaskRecord, type WorkerRunContext } from "../src/subagents/types.ts";
import { fakeMachine, seedProfile, tempDir } from "./helpers/local-fixture.ts";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); });

const HOUR = 3_600_000;
// Noon local time on a fixed day, so "today" and "tomorrow" are unambiguous in any time zone.
const NOON = new Date(2031, 4, 10, 12, 0, 0).getTime();

interface World { processes: string[]; processError?: string; times: Map<string, number>; worktrees: string[]; files: Map<string, string>; present: Set<string> }
function setup() {
  const dir = tempDir();
  dirs.push(dir);
  seedProfile(dir.path);
  const world: World = { processes: [], times: new Map(), worktrees: [], files: new Map(), present: new Set() };
  const probe: HoldProbe = {
    processNames: () => { if (world.processError) throw new Error(world.processError); return world.processes; },
    // A path exists when it has a time, a text or is listed as present (present ones are older than any "today").
    mtime: (path) => world.times.get(path) ?? (world.present.has(path) || world.files.has(path) ? 1 : undefined),
    list: (path) => (path.endsWith(join(".git", "worktrees")) ? world.worktrees : []),
    readText: (path) => world.files.get(path),
  };
  const fake = fakeMachine(dir.path, { holdProbe: probe });
  fake.clock.t = NOON;
  fake.alive.add(301);
  fake.state.healthy = true;
  const repo = join(dir.path, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n"); // a real repository always has a HEAD
  world.present.add(join(repo, ".git")).add(join(repo, ".git", "HEAD"));
  const out: string[] = []; const err: string[] = [];
  const io: Io = { out: (text) => out.push(text), err: (text) => err.push(text) };
  return { dir: dir.path, fake, world, probe, repo, out, err, options: { io, deps: fake.deps, ppid: 301 } };
}
/** A reflog file as git writes it: old new name <mail> <epoch seconds> <tz>, a tab and the message; the last line is the newest. */
const reflog = (...times: number[]): string =>
  times.map((at, index) => `${"0".repeat(40)} ${String(index + 1).repeat(40).slice(0, 40)} Dev <dev@example.invalid> ${Math.floor(at / 1000)} +0000\tcommit: change ${index}`).join("\n") + "\n";
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
    for (const file of [join(repo, ".git", "HEAD"), join(repo, ".git", "ORIG_HEAD")]) {
      world.times.clear();
      world.times.set(file, NOON - HOUR);
      expect(quietTrigger(rule, NOON, probe)).toBe(`work in ${repo} today`);
    }
    world.times.clear();
    world.files.set(join(repo, ".git", "logs", "HEAD"), reflog(NOON - HOUR)); // a commit: the reflog's last entry is today
    expect(quietTrigger(rule, NOON, probe)).toBe(`work in ${repo} today`);
    world.files.clear();
    world.worktrees = ["feature"];
    world.files.set(join(repo, ".git", "worktrees", "feature", "logs", "HEAD"), reflog(NOON - 5 * 60_000));
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
  it("bypass lets the operator run the local model through a hold and a quiet day, keeps both, and ends by itself", async () => {
    const { dir, fake, world, out, err, options } = setup();
    await setHold(dir, NOON + 24 * HOUR, "heavy work");
    world.processes = ["HeavyApp"];
    await addQuiet(dir, "process", "HeavyApp", fake.deps.holdProbe);
    expect(await main(["ensure", "model-a"], options)).toBe(2);
    expect(await main(["bypass", "2h", "operator", "asked"], options)).toBe(0);
    expect(out.at(-2) ?? out.at(-1)).toBeDefined();
    expect(out.at(-1)).toMatch(/hold     bypassed: the timed hold until 2031-05-11 12:00 \(heavy work\)\nbypass   until 2031-05-10 14:00 \(operator asked\)/);
    expect(await main(["ensure", "model-a"], options)).toBe(0);
    expect(await main(["check", "model-a"], options)).toBe(0);
    // The supervisor does not stop the server for the hold while the bypass lasts.
    expect(activeHold(dir, fake.clock.t, fake.deps.holdProbe)).toBeUndefined();
    // Both rules are still recorded.
    expect(readHold(dir)).toMatchObject({ until: NOON + 24 * HOUR, reason: "heavy work", quiet: { processes: ["HeavyApp"] } });
    // It ends by itself.
    fake.clock.t = NOON + 2 * HOUR;
    expect(activeHold(dir, fake.clock.t, fake.deps.holdProbe)?.code).toBe("on-hold");
    // bypass off ends it early.
    fake.clock.t = NOON;
    expect(await main(["bypass", "off"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/^bypass ended; the local model is off again: the local model is on hold/);
    expect(await main(["bypass", "8d"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-option\): a bypass is at most 7d/);
    expect(await main(["bypass"], options)).toBe(1);
  });

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
    expect(out.at(-1)).toMatch(new RegExp(`^hold     none\\nquiet    off for the day when: work in ${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; Heavy App runs\\n.*programs are looked for only when something asks`));
    expect(await main(["quiet", "process", "Heavy", "App"], options)).toBe(0); // adding twice keeps one entry
    expect(readHold(dir).quiet).toEqual({ paths: [repo], processes: ["Heavy App"] });
    expect(await main(["quiet", "remove", "Heavy", "App"], options)).toBe(0);
    expect(readHold(dir).quiet?.processes).toEqual([]);
    expect(await main(["quiet", "remove", "nope"], options)).toBe(2);
    expect(err.at(-1)).toMatch(/REFUSED \(bad-option\): nope is not in the quiet rule/);
    expect(await main(["ensure", "model-a"], options)).toBe(0);
    world.files.set(join(repo, ".git", "logs", "HEAD"), reflog(NOON - 60_000));
    expect(await main(["quiet"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/^hold     quiet-day: .*work in .* today.*\nquiet    .*\n[^\n]*\nstopped  local\/model-a, port 18089 released$/s);
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

describe("review fixes (0.35.3)", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const age = (path: string, days: number) => { const at = new Date(Date.now() - days * 86_400_000); utimesSync(path, at, at); };
  const old = (days: number) => ({ GIT_AUTHOR_DATE: daysAgo(days), GIT_COMMITTER_DATE: daysAgo(days) });
  const commit = (cwd: string, message: string, env: Record<string, string> = {}) => {
    writeFileSync(join(cwd, "file.txt"), `${message}\n`);
    git(cwd, "add", "file.txt");
    execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", message], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env } });
  };
  const scratch = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "hold-git-"))); dirs.push({ cleanup: () => rmSync(root, { recursive: true, force: true }) }); return root; };

  it("M1: a repository whose .git is a FILE (linked worktree, submodule) is resolved and fires; one with no findable HEAD is refused at add", async () => {
    const root = scratch();
    const main = join(root, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    commit(main, "first", old(3));
    const linked = join(root, "linked");
    git(main, "worktree", "add", "-q", linked, "-b", "feature");
    expect(readFileSync(join(linked, ".git"), "utf8")).toMatch(/^gitdir: /); // the shape that never fired
    const layout = gitLayout(linked, systemHoldProbe)!;
    expect(layout.gitdir).toBe(join(main, ".git", "worktrees", "linked"));
    expect(layout.common).toBe(join(main, ".git"));
    for (const name of ["HEAD", "ORIG_HEAD"]) { try { age(join(layout.gitdir, name), 3); } catch { /* not every file exists */ } }
    // the main checkout is watched too (0.35.4), so a fixture that means "no work today" must be old there as well
    for (const name of ["HEAD", "ORIG_HEAD"]) { try { age(join(main, ".git", name), 3); } catch { /* not every file exists */ } }
    const logs = join(layout.gitdir, "logs", "HEAD");
    if (existsSync(logs)) writeFileSync(logs, reflog(Date.now() - 3 * 86_400_000));
    const { dir } = setup();
    await addQuiet(dir, "path", linked); // accepted: its HEAD is found through the gitdir line
    const rule = readHold(dir).quiet!;
    expect(quietTrigger(rule, Date.now(), systemHoldProbe)).toBeUndefined();
    commit(linked, "work today");
    expect(quietTrigger(rule, Date.now(), systemHoldProbe)).toBe(`work in ${linked} today`);

    // a submodule-style pointer: a relative gitdir line into a modules folder
    const sub = join(root, "sub");
    mkdirSync(join(sub), { recursive: true });
    mkdirSync(join(root, "modules", "sub"), { recursive: true });
    writeFileSync(join(root, "modules", "sub", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(sub, ".git"), "gitdir: ../modules/sub\n");
    expect(gitLayout(sub, systemHoldProbe)).toEqual({ gitdir: join(root, "modules", "sub"), common: join(root, "modules", "sub") });
    await addQuiet(dir, "path", sub);

    // a pointer to nowhere can never fire: refused at add, with the cause
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, ".git"), `gitdir: ${join(root, "gone")}\n`);
    expect(() => addQuiet(dir, "path", broken)).toThrow(/points nowhere usable/);
    const bare = join(root, "bare");
    mkdirSync(join(bare, ".git"), { recursive: true }); // a .git folder with no HEAD
    expect(() => addQuiet(dir, "path", bare)).toThrow(/no HEAD found/);
  });

  it("a rule whose repository HEAD later disappears says so in status instead of silently never firing", async () => {
    const { dir, probe, world, repo } = setup();
    await addQuiet(dir, "path", repo);
    expect(describeHold(dir, NOON, probe).join("\n")).not.toMatch(/WARNING/);
    world.present.delete(join(repo, ".git", "HEAD"));
    expect(describeHold(dir, NOON, probe).join("\n")).toMatch(new RegExp(`quiet    WARNING: .*${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} has no readable git HEAD`));
  });

  it("git maintenance rewrites the reflog file with no work done: it does not count, a fetch does not count, a commit does", async () => {
    const root = scratch();
    const upstream = join(root, "upstream");
    const clone = join(root, "clone");
    mkdirSync(upstream);
    git(upstream, "init", "-q", "-b", "main");
    commit(upstream, "one", old(5));
    git(root, "clone", "-q", upstream, clone);
    // every sign of the clone's own history is days old, as in a repository left alone for a while
    writeFileSync(join(clone, ".git", "logs", "HEAD"), reflog(Date.now() - 5 * 86_400_000));
    for (const name of ["HEAD", "ORIG_HEAD"]) { try { age(join(clone, ".git", name), 5); } catch { /* absent */ } }
    const { dir } = setup();
    await addQuiet(dir, "path", clone);
    const rule = readHold(dir).quiet!;
    expect(quietTrigger(rule, Date.now(), systemHoldProbe)).toBeUndefined();
    commit(upstream, "two", old(0));
    git(clone, "fetch", "-q");
    expect(quietTrigger(rule, Date.now(), systemHoldProbe)).toBeUndefined(); // fetch writes FETCH_HEAD only
    git(clone, "gc", "-q");
    git(clone, "reflog", "expire", "--expire=now", "--all");
    git(clone, "reflog", "expire", "--expire=90.days", "--all");
    // Premise checked on this machine: the reflog file's modification time is now, yet nothing was worked on.
    expect(Date.now() - (systemHoldProbe.mtime(join(clone, ".git", "logs", "HEAD")) ?? 0)).toBeLessThan(120_000);
    expect(quietTrigger(rule, Date.now(), systemHoldProbe)).toBeUndefined();
    commit(clone, "real work");
    expect(quietTrigger(rule, Date.now(), systemHoldProbe)).toBe(`work in ${clone} today`);
  });

  it("the quiet day is written under the same lock as every other edit and never over a concurrent one", async () => {
    const { dir, fake, world, probe } = setup();
    await addQuiet(dir, "process", "heavy");
    world.processes = ["heavy"];
    // another process holds the lock (a live owner, here this test's parent) while it edits the file
    mkdirSync(join(dir, "lock"));
    writeFileSync(join(dir, "lock", "owner"), `${process.ppid}\n`);
    const before = readFileSync(holdPath(dir), "utf8");
    expect(activeHold(dir, fake.clock.t, probe)?.code).toBe("quiet-day"); // still a hold now
    expect(readFileSync(holdPath(dir), "utf8")).toBe(before); // but nothing was written outside the lock
    rmSync(join(dir, "lock"), { recursive: true });
    expect(activeHold(dir, fake.clock.t, probe)?.code).toBe("quiet-day");
    expect(readHold(dir).quietDay).toEqual({ date: "2031-05-10", cause: "heavy is running" }); // recorded on the next look
    expect(existsSync(join(dir, "lock"))).toBe(false); // and the lock was let go
    // a caller that already holds the lock (ensure) records it in place, without deadlocking on its own lock
    await addQuiet(dir, "process", "other");
    writeFileSync(holdPath(dir), JSON.stringify({ quiet: { paths: [], processes: ["heavy"] } }));
    await withLock(dir, () => { expect(activeHold(dir, fake.clock.t, probe, true)?.code).toBe("quiet-day"); });
    expect(readHold(dir).quietDay?.date).toBe("2031-05-10");
  });

  it("check may record the quiet day (documented), and ensure records it inside its own lock", async () => {
    const { dir, fake, world } = setup();
    await addQuiet(dir, "process", "heavy");
    world.processes = ["heavy"];
    expect((await refusal(check(fake.deps, "model-a"))).code).toBe("quiet-day");
    expect(readHold(dir).quietDay?.cause).toBe("heavy is running");
    writeFileSync(holdPath(dir), JSON.stringify({ quiet: { paths: [], processes: ["heavy"] } }));
    expect((await refusal(ensure(fake.deps, "model-a", pidHolder(301)))).code).toBe("quiet-day");
    expect(readHold(dir).quietDay?.cause).toBe("heavy is running");
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });

  it("hold off on a corrupt file keeps it as hold.json.bad-<time> and says so", async () => {
    const { dir, out, options } = setup();
    writeFileSync(holdPath(dir), '{ "quiet": { "paths": ["/a/repo"] }, oops');
    expect(await main(["hold", "off"], options)).toBe(0);
    const kept = readdirSync(dir).filter((name) => name.startsWith("hold.json.bad-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dir, kept[0]!), "utf8")).toContain('"/a/repo"'); // the rule is recoverable, not wiped
    expect(out.join("\n")).toContain(`kept it as ${join(dir, kept[0]!)}`);
    expect(out.at(-1)).toBe("timed hold ended; the local model may run");
    expect(existsSync(holdPath(dir))).toBe(true);
    expect(readHold(dir)).toEqual({});
    // a healthy file is never moved
    await setHold(dir, NOON + HOUR);
    await clearHold(dir);
    expect(readdirSync(dir).filter((name) => name.startsWith("hold.json.bad-"))).toHaveLength(1);
  });

  it("unknown keys are bad-hold, naming the key (a typo must not switch the rule off)", async () => {
    const { dir, fake } = setup();
    for (const [body, key] of [
      [{ untill: NOON + HOUR }, '"untill"'],
      [{ quiet: { paths: [], process: ["x"] } }, '"process"'],
      [{ quietDay: { date: "2031-05-10", cause: "x", why: 1 } }, '"why"'],
    ] as const) {
      writeFileSync(holdPath(dir), JSON.stringify(body));
      const refused = await refusal(ensure(fake.deps, "model-a", pidHolder(301)));
      expect(refused.code).toBe("bad-hold");
      expect(refused.message).toContain(`unknown key ${key}`);
    }
  });

  it("a hold file or folder that cannot be read is bad-hold, not 'no hold'", async () => {
    const { dir } = setup();
    mkdirSync(holdPath(dir)); // a directory where the file should be
    expect(activeHold(dir, NOON)?.code).toBe("bad-hold");
    rmSync(holdPath(dir), { recursive: true });
    writeFileSync(holdPath(dir), JSON.stringify({ until: NOON + HOUR }));
    chmodSync(dir, 0o000); // the folder cannot be searched, so existence cannot even be tested
    try {
      expect(activeHold(dir, NOON)?.code).toBe("bad-hold");
      expect(activeHold(dir, NOON)?.detail).toMatch(/cannot be read/);
    } finally { chmodSync(dir, 0o700); }
    expect(activeHold(dir, NOON)?.code).toBe("on-hold");
    rmSync(holdPath(dir));
    expect(activeHold(dir, NOON)).toBeUndefined(); // really absent is still no hold
  });

  it("a failed process list is reported in status, never read as 'no programs'", async () => {
    const { dir, probe, world, out, options } = setup();
    await addQuiet(dir, "process", "heavy");
    world.processError = "ps failed: spawn ps ENOENT";
    expect(activeHold(dir, NOON, probe)).toBeUndefined(); // it cannot fire, but...
    expect(describeHold(dir, NOON, probe).join("\n")).toMatch(/quiet    WARNING: the process list could not be read \(ps failed: spawn ps ENOENT\), so the program rules cannot fire/);
    expect(await main(["status"], options)).toBe(0);
    expect(out.at(-1)).toMatch(/WARNING: the process list could not be read/);
    // the real probe throws instead of returning an empty list
    const path = process.env.PATH;
    process.env.PATH = "";
    try { expect(() => systemHoldProbe.processNames()).toThrow(/ps failed/); } finally { process.env.PATH = path; }
  });

  it("a process name cut to 15 characters (Linux comm) still matches a longer listed name", () => {
    const { probe, world } = setup();
    world.processes = ["heavyprogramlon"];
    expect(quietTrigger({ paths: [], processes: ["heavyprogramlongname"] }, NOON, probe)).toBe("heavyprogramlon is running");
    world.processes = ["heavyprogramlonX"]; // not a truncation of it
    expect(quietTrigger({ paths: [], processes: ["heavyprogramlongname"] }, NOON, probe)).toBeUndefined();
    world.processes = ["heavyprogram"]; // a substring is never a match
    expect(quietTrigger({ paths: [], processes: ["heavyprogramlongname"] }, NOON, probe)).toBeUndefined();
  });

  it("a shorter hold never shortens a longer one in force unless --replace", async () => {
    const { dir, fake, out, options } = setup();
    expect(await main(["hold", "24h", "long", "job"], options)).toBe(0);
    expect(await main(["hold", "1h", "short"], options)).toBe(0);
    expect(out.join("\n")).toMatch(/kept the longer hold already in force; to shorten it use: steak-pi local hold 1h --replace/);
    expect(readHold(dir)).toEqual({ until: NOON + 24 * HOUR, reason: "long job" });
    expect(await main(["hold", "48h", "longer"], options)).toBe(0); // a longer one extends it
    expect(readHold(dir).until).toBe(NOON + 48 * HOUR);
    expect(await main(["hold", "1h", "--replace", "short"], options)).toBe(0);
    expect(readHold(dir)).toEqual({ until: NOON + HOUR, reason: "short" });
    fake.clock.t = NOON + 2 * HOUR; // an ended hold is replaced by anything
    await setHold(dir, NOON + 3 * HOUR, "again", { now: fake.clock.t });
    expect(readHold(dir).until).toBe(NOON + 3 * HOUR);
  });

  it("M2: a hold that stops the server under running work does not reroute it; the resumed worker is refused by name, not looped", async () => {
    const { dir, fake } = setup();
    await ensure(fake.deps, "model-a", pidHolder(301)); // a worker holds a lease and has a request in flight
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
    const deps = { ...fake.deps, spawnServer: () => ({ pid: 7001, exited }), signal: () => { resolveExit(0); } };
    await setHold(dir, NOON + HOUR, "game work");
    expect((await supervise(deps, "model-a")).reason).toBe("hold"); // the server is stopped under the lease holder
    // The request in flight ends with a connection error. The coordinator's auto-resume treats that as a network drop...
    expect(transientFailure("fetch failed", 0)?.reason).toBe("network drop");
    // ...and the resumed worker runs its ensure hook again, which is refused with the hold's own cause (never a silent restart).
    const refused = await refusal(ensure(deps, "model-a", pidHolder(301)));
    expect(refused.code).toBe("on-hold");
    expect(fake.calls.filter((call) => call.startsWith("supervisor:")).length).toBe(1); // only the first start ever happened
    // That refusal is a named, final cause: auto-resume does not retry it, and fall-through is only for a launch with no output yet.
    const cause = `USAP profile ensure refused (local): steak-pi local: REFUSED (on-hold): ${refused.message}`;
    expect(transientFailure(cause, 0)).toBeUndefined();
  });

  it("M4: the refusal reaches auto-resume through the real ensure wrapper, and the operator's reason text cannot make it look transient", async () => {
    const { dir, fake } = setup();
    const routing = join(dir, "routing.json");
    writeFileSync(routing, JSON.stringify({ workerProfiles: [{ id: "hub/local", model: "local-p/small", ensure: { command: ["ensure-local", "model-a"] } }] }));
    vi.stubEnv("STEAK_PI_ROUTING_CONFIG", routing);
    try {
      for (const reason of ["connection error", "fetch failed after a 503 from the proxy", "rate limit, 429, overloaded, socket hang up"]) {
        await setHold(dir, NOON + HOUR, reason, { replace: true });
        // The command is the real `ensure`: its refusal is printed exactly as the CLI prints it, and USAP records that text as the cause.
        const exec: EnsureExec = async () => {
          const error = await ensure(fake.deps, "model-a", pidHolder(301)).then(() => undefined, (caught: unknown) => caught);
          expect(error).toBeInstanceOf(LocalError);
          const stderr = `steak-pi local: REFUSED (${(error as LocalError).code}): ${(error as LocalError).message}\n`;
          return { ok: false, code: 2, signal: null, timedOut: false, aborted: false, stderr };
        };
        const task = { id: "t1", label: "leaf" } as TaskRecord;
        const run = { id: "run-1", model: "local-p/small", selection: { provider: "local-p", modelId: "small", source: "chain", images: false, tools: true, profile: "hub/local" } } as unknown as RunRecord;
        const context: WorkerRunContext = { run, task, signal: new AbortController().signal, onProgress: () => {} };
        const result = await withProfileEnsure(async () => ({ state: "done", output: "", turns: 1, usage: emptyUsage() }), { exec })(context);
        expect(result.state).toBe("failed");
        expect(result.error).toContain(reason); // the operator's words are in the cause...
        expect(transientFailure(result.error, 0)).toBeUndefined(); // ...and are not read as a network or server fault
        expect(transientFailure(result.error, 1)).toBeUndefined();
      }
    } finally { vi.unstubAllEnvs(); }
    // The same words in a real transport failure are still resumed: only the refusal is exempt.
    expect(transientFailure("connection error", 0)?.reason).toBe("network drop");
  });
});

describe("review fixes (0.35.4)", () => {
  const stamp = (at: number) => Math.floor(at / 1000);
  const line = (at: number, message?: string) => `${"0".repeat(40)} ${"1".repeat(40)} Dev <dev@example.invalid> ${stamp(at)} +0000${message === undefined ? "" : `\t${message}`}`;
  const withText = (text: string | undefined) => ({ ...systemHoldProbe, readText: (_path: string, tail = 4096) => (text === undefined ? undefined : text.length > tail ? text.slice(-tail) : text) });
  const T = Date.UTC(2031, 4, 10, 9, 0, 0);

  it("reflog: an entry with no message (no tab after the timezone) counts", () => {
    expect(lastReflogAt("log", withText(`${line(T - 5000, "commit: a")}\n${line(T)}\n`))).toBe(stamp(T) * 1000);
    expect(lastReflogAt("log", withText(`${line(T)}`))).toBe(stamp(T) * 1000);
  });

  it("reflog: a half-written last line does not hide the entry before it", () => {
    const half = `${"0".repeat(40)} ${"1".repeat(40)} Dev <dev@exam`;
    expect(lastReflogAt("log", withText(`${line(T - 9000, "commit: a")}\n${line(T, "commit: b")}\n${half}`))).toBe(stamp(T) * 1000);
    // cut inside the timestamp and inside the timezone as well
    const stampCut = `${"0".repeat(40)} ${"1".repeat(40)} Dev <dev@example.invalid> ${String(stamp(T + 5000)).slice(0, 7)}`;
    expect(lastReflogAt("log", withText(`${line(T, "commit: b")}\n${stampCut}`))).toBe(stamp(T) * 1000);
    const zoneCut = `${"0".repeat(40)} ${"1".repeat(40)} Dev <dev@example.invalid> ${stamp(T + 5000)} +00`;
    expect(lastReflogAt("log", withText(`${line(T, "commit: b")}\n${zoneCut}`))).toBe(stamp(T) * 1000);
    expect(lastReflogAt("log", withText(""))).toBeUndefined();
    expect(lastReflogAt("log", withText(undefined))).toBeUndefined();
  });

  it("reflog: a last line longer than the read window is not cut before its timestamp", () => {
    const long = "x".repeat(200_000);
    expect(lastReflogAt("log", withText(`${line(T - 9000, "commit: old")}\n${line(T, long)}\n`))).toBe(stamp(T) * 1000); // not the older entry
  });

  it("a linked worktree listed as a quiet path also watches the main checkout (the common git dir), once", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hold-common-")));
    dirs.push({ cleanup: () => rmSync(root, { recursive: true, force: true }) });
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    const oldDate = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const main = join(root, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    writeFileSync(join(main, "f.txt"), "1\n");
    git(main, "add", "f.txt");
    execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "first"], { cwd: main, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate } });
    const linked = join(root, "linked");
    git(main, "worktree", "add", "-q", linked, "-b", "feature");
    const past = new Date(Date.now() - 3 * 86_400_000);
    for (const file of [join(main, ".git", "HEAD"), join(main, ".git", "worktrees", "linked", "HEAD"), join(main, ".git", "worktrees", "linked", "ORIG_HEAD")]) if (existsSync(file)) utimesSync(file, past, past);
    for (const log of [join(main, ".git", "logs", "HEAD"), join(main, ".git", "worktrees", "linked", "logs", "HEAD")]) if (existsSync(log)) writeFileSync(log, `${line(past.getTime(), "old")}\n`);
    const rule = { paths: [linked], processes: [] };
    expect(quietTrigger(rule, Date.now(), systemHoldProbe)).toBeUndefined();
    // work in the MAIN checkout (not in the listed linked one) is work in this repository
    writeFileSync(join(main, "f.txt"), "2\n");
    git(main, "add", "f.txt");
    git(main, "commit", "-qm", "second");
    expect(quietTrigger(rule, Date.now(), systemHoldProbe)).toBe(`work in ${linked} today`);

    // and the main git folder is looked at once, not twice (an ordinary clone's own folder is its common folder)
    const reads: string[] = [];
    const counting: HoldProbe = { ...systemHoldProbe, mtime: (path) => { reads.push(path); return systemHoldProbe.mtime(path); } };
    quietTrigger({ paths: [main], processes: [] }, Date.now(), counting);
    expect(reads.filter((path) => path === join(main, ".git", "HEAD") || path === join(main, ".git", "ORIG_HEAD")).length).toBeLessThanOrEqual(3); // gitLayout's own HEAD check + one look each
    expect(reads.filter((path) => path === join(main, ".git", "ORIG_HEAD")).length).toBe(1);
  });

  it("a lock failure never makes the quiet check throw: the hold is reported and the named cause is logged", async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const { dir, fake, world, probe } = setup();
    await addQuiet(dir, "process", "heavy");
    world.processes = ["heavy"];
    const warnings: string[] = [];
    const onWarning = (warning: Error) => { if (warning.name === "SteakPiLocalHold") warnings.push(warning.message); };
    process.on("warning", onWarning);
    chmodSync(dir, 0o500); // the lock folder cannot be created
    try {
      expect(() => activeHold(dir, fake.clock.t, probe)).not.toThrow();
      expect(activeHold(dir, fake.clock.t, probe)?.code).toBe("quiet-day");
      expect((await refusal(check(fake.deps, "model-a"))).code).toBe("quiet-day");
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally { chmodSync(dir, 0o700); process.off("warning", onWarning); }
    expect(warnings.join("\n")).toMatch(/quiet day could not be recorded \(EACCES/);
    expect(readHold(dir).quietDay).toBeUndefined();
  });

  it("tryLockSync removes the lock folder when the owner file cannot be written", () => {
    if (process.getuid?.() === 0) return;
    const { dir } = setup();
    let previous: number | undefined;
    try { previous = process.umask(0o277); } catch { return; } // the folder is then created without write permission
    try { expect(() => tryLockSync(dir)).toThrow(/EACCES/); }
    finally { process.umask(previous); }
    expect(existsSync(join(dir, "lock"))).toBe(false);
    const release = tryLockSync(dir); // and the next caller is not locked out by a leftover
    expect(release).toBeTypeOf("function");
    release?.();
  });

  it("tryLockSync follows withLock's stale rule: a live owner's lock is kept, a dead or unreadable owner's is taken", () => {
    const { dir } = setup();
    const lock = join(dir, "lock");
    const aged = (seconds: number) => { const at = new Date(Date.now() - seconds * 1000); utimesSync(lock, at, at); };
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), `${process.pid}\n`);
    aged(30);
    expect(tryLockSync(dir)).toBeUndefined(); // the owner (this process) is alive
    expect(existsSync(lock)).toBe(true);
    for (const owner of ["", "not-a-pid\n", "0\n", "-5\n", "2147483646\n"]) {
      writeFileSync(join(lock, "owner"), owner);
      aged(30);
      const release = tryLockSync(dir);
      expect(release, `owner file ${JSON.stringify(owner)}`).toBeTypeOf("function"); // nobody owns it: taken over
      release?.();
      mkdirSync(lock);
    }
    rmSync(lock, { recursive: true, force: true });
    // a lock just created (no owner file yet) is given a moment, as withLock does
    mkdirSync(lock);
    expect(tryLockSync(dir)).toBeUndefined();
  });
});

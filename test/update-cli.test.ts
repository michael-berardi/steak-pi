import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "..", "bin", "steak-pi");

/** Isolated release folders and a synthetic git clone; npm installs an empty dependency set offline. */
function fixture(current: string, next: string) {
  const home = mkdtempSync(join(tmpdir(), "steak-update-cli-"));
  const releases = join(home, "share", "steak-pi", "releases");
  const pkg = (dir: string, version: string) => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "steak-pi", version, private: true }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "steak-pi", version, lockfileVersion: 3, requires: true, packages: { "": { name: "steak-pi", version } } }));
    writeFileSync(join(dir, "bin", "steak-pi"), readFileSync(CLI));
    // The CLI delegates report/preference flags to the same TypeScript helpers it ships.
    cpSync(resolve(import.meta.dirname, "..", "src"), join(dir, "src"), { recursive: true });
  };
  for (const v of ["0.1.0", current]) pkg(join(releases, v, "package"), v);
  // A stale marker must not authorize deletion even if another scope still pins this release.
  writeFileSync(join(releases, "0.1.0", ".retired-at"), "1");
  const repo = join(home, "remote");
  pkg(repo, next);
  const bin = join(home, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = clone ] && [ "$6" = "v${next}" ] || exit 1\ncp -R "$7" "$8"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "pi"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // No running Pi session unless a test says otherwise (the machine running the tests may run Pi).
  writeFileSync(join(bin, "ps"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const agent = join(home, "agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [`../share/steak-pi/releases/${current}/package`], theme: "x" }));
  return { home, releases, agent, repo };
}

function run(f: ReturnType<typeof fixture>, current: string, args: string[], tag: string, extra: Record<string, string> = {}) {
  return spawnSync("/bin/sh", [join(f.releases, current, "package", "bin", "steak-pi"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home, PATH: `${join(f.home, "bin")}:${process.env.PATH}`, PI_CODING_AGENT_DIR: f.agent, STEAK_PI_LATEST_TAG: tag, STEAK_PI_RELEASE_SOURCE: f.repo, STEAK_PI_LIBEXEC: "", ...extra },
  });
}

// Each case runs the real shell CLI (and npm ci) several times.
describe("steak-pi update for release-folder installs", { timeout: 60_000 }, () => {
  it("shows the selected settings file and distinct pins across agent directories", () => {
    const f = fixture("0.16.0", "0.17.0");
    const other = join(f.home, ".pi", "agent"); mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "settings.json"), JSON.stringify({ packages: [join(f.releases, "0.1.0", "package")] }));
    const selected = run(f, "0.16.0", ["status"], "v0.17.0");
    const fallback = spawnSync("/bin/sh", [join(f.releases, "0.16.0", "package", "bin", "steak-pi"), "status"], {
      encoding: "utf8", env: { ...process.env, HOME: f.home, PI_CODING_AGENT_DIR: "", STEAK_PI_LIBEXEC: "" },
    });
    expect(selected.stdout).toContain(join(f.agent, "settings.json"));
    expect(selected.stdout).toContain("pi integration    ../share/steak-pi/releases/0.16.0/package  (v0.16.0)");
    expect(fallback.stdout).toContain(join(other, "settings.json"));
    expect(fallback.stdout).toContain(`pi integration    ${join(f.releases, "0.1.0", "package")}  (v0.1.0)`);
    const updated = run(f, "0.16.0", ["update"], "v0.17.0");
    expect(updated.status, updated.stderr).toBe(0);
    // 0.1.0 was pinned by the other directory until now, and no running session can load it: it goes; 0.16.0 is the rollback.
    expect(existsSync(join(f.releases, "0.1.0", "package"))).toBe(false);
    expect(existsSync(join(f.releases, "0.16.0", "package"))).toBe(true);
    // Every known agent directory on this machine follows the update (2026-11-04: 4 of 5 stayed behind).
    expect(JSON.parse(readFileSync(join(other, "settings.json"), "utf8")).packages[0]).toContain("0.17.0");
  });

  it("re-points every known Pi agent directory on this machine, on any old version, and nothing else (2026-11-04)", () => {
    // UltraTerm runs Pi from ~/.pi/agent and one agent dir per provider account; updating only the caller's left 4 of 5 behind.
    const f = fixture("0.16.0", "0.17.0");
    const accounts = join(f.home, ".ultraterm", "provider-accounts");
    const write = (dir: string, packages: unknown[]) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages, theme: "keep" })); };
    const defaultAgent = join(f.home, ".pi", "agent");
    write(defaultAgent, [join(f.releases, "0.16.0", "package")]);
    write(join(accounts, "codex", "primary", "agent"), [join(f.releases, "0.1.0", "package")]);          // an older version
    write(join(accounts, "opencode-go", "b", "agent"), [{ source: join(f.releases, "0.16.0", "package"), extensions: [] }]);
    const foreign = join(f.home, "elsewhere", "steak-pi", "releases", "0.16.0", "package");               // another releases root
    write(join(accounts, "claude", "x", "agent"), [foreign]);
    const r = run(f, "0.16.0", ["update"], "v0.17.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Also re-pointed 3 other Pi agent settings on this machine to 0.17.0.");
    const read = (dir: string) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(read(defaultAgent).packages).toEqual([join(f.releases, "0.17.0", "package")]);
    expect(read(join(accounts, "codex", "primary", "agent")).packages).toEqual([join(f.releases, "0.17.0", "package")]);
    expect(read(join(accounts, "opencode-go", "b", "agent")).packages).toEqual([{ source: join(f.releases, "0.17.0", "package"), extensions: [] }]);
    expect(read(join(accounts, "opencode-go", "b", "agent")).theme).toBe("keep");
    expect(read(join(accounts, "claude", "x", "agent")).packages).toEqual([foreign]);                   // not ours: untouched
    expect(read(f.agent).packages).toEqual(["../share/steak-pi/releases/0.17.0/package"]);
    // 0.1.0 is now pinned nowhere and no running session can load it; 0.16.0 stays as the rollback.
    expect(existsSync(join(f.releases, "0.1.0"))).toBe(false);
    expect(existsSync(join(f.releases, "0.16.0", "package"))).toBe(true);
  });

  it("never re-points Pi at an existing release whose dependencies are missing (2026-11-11)", () => {
    // 0.27.2 existed with its source but an empty node_modules; the update skipped the install, re-pointed settings and
    // every Pi launch failed. A release whose peer dependencies are absent and cannot be installed must leave settings alone.
    const f = fixture("0.16.0", "0.17.0");
    const dest = join(f.releases, "0.17.0", "package");
    mkdirSync(join(dest, "bin"), { recursive: true });
    writeFileSync(join(dest, "package.json"), JSON.stringify({ name: "steak-pi", version: "0.17.0", peerDependencies: { "pi-host-fixture": "*" } }));
    // Its lockfile does not carry the dependency, so npm ci cannot restore it.
    writeFileSync(join(dest, "package-lock.json"), JSON.stringify({ name: "steak-pi", version: "0.17.0", lockfileVersion: 3, requires: true, packages: { "": { name: "steak-pi", version: "0.17.0" } } }));
    const before = readFileSync(join(f.agent, "settings.json"), "utf8");
    const r = run(f, "0.16.0", ["update"], "v0.17.0");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/(npm ci failed in .*0\.17\.0\/package|still lacks pi-host-fixture after npm ci); Pi settings were not changed and still load 0\.16\.0/);
    expect(readFileSync(join(f.agent, "settings.json"), "utf8")).toBe(before);
  }, 60_000); // runs a real `npm ci`, which takes longer than the default 5 s on a busy machine

  it("installs the dependencies of an existing release before re-pointing Pi at it", () => {
    const f = fixture("0.16.0", "0.17.0");
    const dest = join(f.releases, "0.17.0", "package");
    mkdirSync(dest, { recursive: true });
    // The lockfile carries the peer dependency (as npm records dev/peer installs), so npm ci restores it offline.
    mkdirSync(join(f.home, "dep"), { recursive: true });
    writeFileSync(join(f.home, "dep", "package.json"), JSON.stringify({ name: "pi-host-fixture", version: "1.0.0" }));
    writeFileSync(join(dest, "package.json"), JSON.stringify({ name: "steak-pi", version: "0.17.0", peerDependencies: { "pi-host-fixture": "*" }, devDependencies: { "pi-host-fixture": "file:../../../../../dep" } }));
    const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline"], { cwd: dest, encoding: "utf8" });
    expect(install.status, install.stderr).toBe(0);
    rmSync(join(dest, "node_modules"), { recursive: true, force: true });
    const r = run(f, "0.16.0", ["update"], "v0.17.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Release 0.17.0 is missing dependencies (pi-host-fixture); installing them...");
    expect(existsSync(join(dest, "node_modules", "pi-host-fixture", "package.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8")).packages).toEqual(["../share/steak-pi/releases/0.17.0/package"]);
  }, 60_000); // runs a real npm install

  it("preserves an incomplete existing destination", () => {
    const f = fixture("0.16.0", "0.17.0");
    mkdirSync(join(f.releases, "0.17.0"));
    writeFileSync(join(f.releases, "0.17.0", "keep"), "untouched");
    const r = run(f, "0.16.0", ["update"], "v0.17.0");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("preserved it");
    expect(readFileSync(join(f.releases, "0.17.0", "keep"), "utf8")).toBe("untouched");
  });
  it("--check names an available update and changes nothing", () => {
    const f = fixture("0.16.0", "0.17.0");
    const r = run(f, "0.16.0", ["update", "--check"], "v0.17.0");
    expect(r.stdout).toContain("Steak Pi 0.17.0 available (you have 0.16.0) · run: steak-pi update");
    expect(existsSync(join(f.releases, "0.17.0"))).toBe(false);
  });

  it("installs the new release, re-points Pi settings and keeps the rollback", () => {
    const f = fixture("0.16.0", "0.17.0");
    const r = run(f, "0.16.0", ["update"], "v0.17.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Steak Pi updated: 0.16.0 -> 0.17.0");
    const settings = JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8"));
    expect(settings).toEqual({ packages: ["../share/steak-pi/releases/0.17.0/package"], theme: "x" });
    expect(JSON.parse(readFileSync(join(f.releases, "0.17.0", "package", "package.json"), "utf8")).version).toBe("0.17.0");
    expect(r.stdout).toContain("Steak Pi 0.16.0 -> 0.17.0");
    expect(existsSync(join(f.releases, "0.16.0"))).toBe(true); // the one rollback
    expect(existsSync(join(f.releases, "0.1.0"))).toBe(true); // a stale retirement marker cannot authorize deletion
    expect(readdirSync(f.releases).filter((name) => name.startsWith(".staging-"))).toEqual([]); // temp downloads are removed
  });

  it("keeps the release Pi loads as the rollback even when the CLI itself is older (2026-11-03)", () => {
    // A Homebrew CLI at 0.1.0 updating a Pi that loads 0.16.0 must keep 0.16.0 (live sessions load worker modules from it).
    const f = fixture("0.16.0", "0.17.0");
    const r = run(f, "0.1.0", ["update"], "v0.17.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Steak Pi updated: 0.16.0 -> 0.17.0");
    expect(existsSync(join(f.releases, "0.16.0", "package"))).toBe(true);
    expect(existsSync(join(f.releases, "0.1.0"))).toBe(true);
  });

  it("keeps an old release a running session may still load (2026-11-03: 0.18.9 was removed under a live session)", () => {
    const f = fixture("0.16.0", "0.17.0");
    // 0.1.0 was retired an hour ago; a "pi" process that started two hours ago may still be loading it.
    writeFileSync(join(f.releases, "0.1.0", ".retired-at"), String(Date.now() - 3600_000));
    writeFileSync(join(f.home, "bin", "ps"), '#!/bin/sh\necho "02:00:00 pi"\n', { mode: 0o755 });
    const r = run(f, "0.16.0", ["update"], "v0.17.0");
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(f.releases, "0.1.0", "package"))).toBe(true);
    // Once that session is gone, the next update or session start removes it.
    writeFileSync(join(f.home, "bin", "ps"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const pruned = spawnSync(process.execPath, ["--no-warnings", join(f.releases, "0.17.0", "package", "src", "update-cli.ts"), "--prune", f.releases, "0.17.0"], {
      encoding: "utf8", env: { ...process.env, HOME: f.home, PATH: `${join(f.home, "bin")}:${process.env.PATH}`, PI_CODING_AGENT_DIR: f.agent },
    });
    expect(pruned.stdout).toContain("Removed old release 0.1.0.");
    expect(existsSync(join(f.releases, "0.16.0", "package"))).toBe(true); // the rollback waits for 0.17.0 to run once
  });

  it("--check reports the release Pi loads, not an older CLI (2026-11-04)", () => {
    const f = fixture("0.17.0", "0.17.0");
    const r = run(f, "0.1.0", ["update", "--check"], "v0.17.0");
    expect(r.stdout).toContain("Steak Pi 0.17.0 is up to date.");
  });

  it("is a no-op when already up to date, and never installs an older or unparseable release", () => {
    const f = fixture("0.16.0", "0.16.0");
    for (const tag of ["v0.16.0", "v0.15.9", "v0.17.0-beta.1"]) {
      const r = run(f, "0.16.0", ["update"], tag);
      expect(r.status, r.stderr).toBe(tag.includes("beta") ? 1 : 0);
      expect(tag.includes("beta") ? r.stderr : r.stdout).toContain(tag.includes("beta") ? "no published x.y.z release found" : "Steak Pi is up to date (0.16.0).");
    }
    expect(JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8")).packages).toEqual(["../share/steak-pi/releases/0.16.0/package"]);
    expect(existsSync(join(f.releases, "0.1.0"))).toBe(true);
  });

  it("names a failed download and leaves settings unchanged", () => {
    const f = fixture("0.16.0", "0.17.0");
    const r = run(f, "0.16.0", ["update"], "v9.9.9");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/download of v9\.9\.9 failed/);
    expect(JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8")).packages).toEqual(["../share/steak-pi/releases/0.16.0/package"]);
  });

  it("--check exits 10 for a newer release, 0 when current and 1 with the cause, and deletes nothing", () => {
    const f = fixture("0.16.0", "0.17.0");
    writeFileSync(join(f.releases, "0.1.0", ".retired-at"), String(Date.now() - 30 * 24 * 3600_000));
    const available = run(f, "0.16.0", ["update", "--check"], "v0.17.0");
    expect(available.status, available.stderr).toBe(10);
    expect(available.stdout).toBe("Steak Pi 0.17.0 available (you have 0.16.0) · run: steak-pi update\n");
    const current = run(f, "0.16.0", ["update", "--check"], "v0.16.0");
    expect(current.status, current.stderr).toBe(0);
    const failed = run(f, "0.16.0", ["update", "--check"], "nightly");
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("update check failed: STEAK_PI_LATEST_TAG has no x.y.z tag (nightly)");
    expect(existsSync(join(f.releases, "0.1.0", "package"))).toBe(true); // a report never prunes
    // The failure is recorded with its cause for every later session.
    expect(JSON.parse(readFileSync(join(f.home, ".cache", "steak-pi", "update-check.json"), "utf8")).error).toContain("no x.y.z tag");
  });

  it("--skip stores only that version; a newer release can be skipped again", () => {
    const f = fixture("0.16.0", "0.17.0");
    const skipped = run(f, "0.16.0", ["update", "--skip"], "v0.17.0");
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(skipped.stdout).toContain("Skipped Steak Pi 0.17.0.");
    expect(JSON.parse(readFileSync(join(f.agent, "steak-pi.json"), "utf8"))).toEqual({ updates: { skippedVersion: "0.17.0" } });
    expect(run(f, "0.16.0", ["update", "--check"], "v0.17.0").status).toBe(10); // the report still tells the truth
    expect(run(f, "0.16.0", ["update", "--skip"], "v0.18.0").status).toBe(0);
    expect(JSON.parse(readFileSync(join(f.agent, "steak-pi.json"), "utf8")).updates.skippedVersion).toBe("0.18.0");
  });

  it("--auto and --checks persist on/off and report status from Steak Pi's config", () => {
    const f = fixture("0.16.0", "0.17.0");
    const config = () => JSON.parse(readFileSync(join(f.agent, "steak-pi.json"), "utf8")).updates;
    expect(run(f, "0.16.0", ["update", "--auto", "status"], "v0.17.0").stdout).toBe("Automatic updates: off\n"); // off by default
    expect(run(f, "0.16.0", ["update", "--auto", "on"], "v0.17.0").status).toBe(0);
    expect(run(f, "0.16.0", ["update", "--auto", "status"], "v0.17.0").stdout).toBe("Automatic updates: on\n");
    expect(config()).toMatchObject({ auto: true });
    expect(run(f, "0.16.0", ["update", "--auto", "off"], "v0.17.0").status).toBe(0);
    expect(config()).toMatchObject({ auto: false, autoAsked: true });
    expect(run(f, "0.16.0", ["update", "--checks", "off"], "v0.17.0").stdout).toBe("Update checks: off\n");
    expect(config().checks).toBe(false);
    expect(run(f, "0.16.0", ["update", "--auto", "maybe"], "v0.17.0").status).toBe(2);
  });

  it("an explicit --check still answers under the background opt-outs", () => {
    const f = fixture("0.16.0", "0.17.0");
    expect(run(f, "0.16.0", ["update", "--check"], "v0.17.0", { STEAK_PI_NO_UPDATE_CHECK: "1", CI: "1" }).status).toBe(10);
  });

  it("--auto off removes the cache, notice state and automatic-install log", () => {
    const f = fixture("0.16.0", "0.17.0");
    const cache = join(f.home, ".cache", "steak-pi");
    expect(run(f, "0.16.0", ["update", "--skip"], "v0.17.0").status).toBe(0);
    writeFileSync(join(cache, "auto-update.log"), "previous automatic install\n");
    expect(readdirSync(cache).sort()).toEqual(["auto-update.log", "update-check.json"]); // the only files updates write
    expect(run(f, "0.16.0", ["update", "--auto", "off"], "v0.17.0").status).toBe(0);
    expect(readdirSync(cache)).toEqual([]);
    expect(JSON.parse(readFileSync(join(f.agent, "steak-pi.json"), "utf8")).updates).toEqual({ auto: false, autoAsked: true });
  });

  it("--rollback re-points to the previous release without deleting the newer one", () => {
    const f = fixture("0.16.0", "0.17.0");
    expect(run(f, "0.16.0", ["update"], "v0.17.0").status).toBe(0);
    writeFileSync(join(f.releases, "0.17.0", ".ran-at"), String(Date.now()));
    const r = run(f, "0.17.0", ["update", "--rollback"], "v0.17.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Steak Pi rolled back: 0.17.0 -> 0.16.0");
    expect(JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8")).packages).toEqual(["../share/steak-pi/releases/0.16.0/package"]);
    expect(existsSync(join(f.releases, "0.17.0", "package"))).toBe(true);
    expect(existsSync(join(f.releases, "0.16.0", ".ran-at"))).toBe(false); // the target must prove itself again
    expect(run(f, "0.16.0", ["update", "--rollback", "../x"], "v0.17.0").stderr).toContain("not a release version");
  });
});

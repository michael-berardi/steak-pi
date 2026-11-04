import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "..", "bin", "steak-pi");

/** A fake release-folder install: <root>/releases/<v>/package with bin/steak-pi, plus a local "GitHub" repo
 * whose tag v<next> carries a package with no dependencies, so `npm ci` runs offline. */
function fixture(current: string, next: string) {
  const home = mkdtempSync(join(tmpdir(), "steak-update-cli-"));
  const releases = join(home, "share", "steak-pi", "releases");
  const pkg = (dir: string, version: string) => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "steak-pi", version, private: true }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "steak-pi", version, lockfileVersion: 3, requires: true, packages: { "": { name: "steak-pi", version } } }));
    writeFileSync(join(dir, "bin", "steak-pi"), readFileSync(CLI));
  };
  for (const v of ["0.1.0", current]) pkg(join(releases, v, "package"), v);
  // 0.1.0 was replaced long ago (before any session that could still run), so an update may prune it.
  writeFileSync(join(releases, "0.1.0", ".retired-at"), "1");
  const repo = join(home, "remote");
  pkg(repo, next);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q"); git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "release");
  git("tag", `v${next}`);
  const agent = join(home, "agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [`../share/steak-pi/releases/${current}/package`], theme: "x" }));
  return { home, releases, agent, repo };
}

function run(f: ReturnType<typeof fixture>, current: string, args: string[], tag: string) {
  return spawnSync("/bin/sh", [join(f.releases, current, "package", "bin", "steak-pi"), ...args], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: f.agent, STEAK_PI_LATEST_TAG: tag, STEAK_PI_RELEASE_SOURCE: f.repo },
  });
}

describe("steak-pi update for release-folder installs", () => {
  it("--check names an available update and changes nothing", () => {
    const f = fixture("0.16.0", "0.17.0");
    const r = run(f, "0.16.0", ["update", "--check"], "v0.17.0");
    expect(r.stdout).toContain("Steak Pi 0.17.0 is available (you have 0.16.0). Run: steak-pi update");
    expect(existsSync(join(f.releases, "0.17.0"))).toBe(false);
  });

  it("installs the new release, re-points Pi settings and keeps exactly one rollback", () => {
    const f = fixture("0.16.0", "0.17.0");
    const r = run(f, "0.16.0", ["update"], "v0.17.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Steak Pi updated: 0.16.0 -> 0.17.0");
    const settings = JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8"));
    expect(settings).toEqual({ packages: ["../share/steak-pi/releases/0.17.0/package"], theme: "x" });
    expect(JSON.parse(readFileSync(join(f.releases, "0.17.0", "package", "package.json"), "utf8")).version).toBe("0.17.0");
    expect(existsSync(join(f.releases, "0.16.0"))).toBe(true); // the one rollback
    expect(existsSync(join(f.releases, "0.1.0"))).toBe(false); // older releases pruned
  });

  it("keeps the release Pi loads as the rollback even when the CLI itself is older (2026-11-03)", () => {
    // A Homebrew CLI at 0.1.0 updating a Pi that loads 0.16.0 must keep 0.16.0 (live sessions load worker modules from it).
    const f = fixture("0.16.0", "0.17.0");
    const r = run(f, "0.1.0", ["update"], "v0.17.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Steak Pi updated: 0.16.0 -> 0.17.0");
    expect(existsSync(join(f.releases, "0.16.0", "package"))).toBe(true);
    expect(existsSync(join(f.releases, "0.1.0"))).toBe(false);
  });

  it("keeps an old release a running session may still load (2026-11-03: 0.18.9 was removed under a live session)", () => {
    const f = fixture("0.16.0", "0.17.0");
    // 0.1.0 was retired an hour ago; a fake "pi" process that started two hours ago may still be loading it.
    writeFileSync(join(f.releases, "0.1.0", ".retired-at"), String(Math.floor(Date.now() / 1000) - 3600));
    const bin = join(f.home, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "ps"), `#!/bin/sh
case "$*" in
  *lstart*) echo "$(LC_ALL=C date -r $(( $(date +%s) - 7200 )) '+%a %b %d %T %Y')";;
  *) echo "4242 pi";;
esac
`, { mode: 0o755 });
    const r = spawnSync("/bin/sh", [join(f.releases, "0.16.0", "package", "bin", "steak-pi"), "update"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: f.agent, STEAK_PI_LATEST_TAG: "v0.17.0", STEAK_PI_RELEASE_SOURCE: f.repo },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(f.releases, "0.1.0", "package"))).toBe(true);
    expect(r.stdout).toContain("still running");
  });

  it("--check reports the release Pi loads, not an older CLI (2026-11-04)", () => {
    const f = fixture("0.17.0", "0.17.0");
    const r = run(f, "0.1.0", ["update", "--check"], "v0.17.0");
    expect(r.stdout).toContain("Steak Pi is up to date (0.17.0).");
  });

  it("is a no-op when already up to date", () => {
    const f = fixture("0.16.0", "0.16.0");
    const r = run(f, "0.16.0", ["update"], "v0.16.0");
    expect(r.stdout).toContain("Steak Pi is up to date (0.16.0).");
    expect(existsSync(join(f.releases, "0.1.0"))).toBe(true);
  });

  it("names a failed download and leaves settings unchanged", () => {
    const f = fixture("0.16.0", "0.17.0");
    const r = run(f, "0.16.0", ["update"], "v9.9.9");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/download of v9\.9\.9 failed/);
    expect(JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8")).packages).toEqual(["../share/steak-pi/releases/0.16.0/package"]);
  });
});

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  };
  for (const v of ["0.1.0", current]) pkg(join(releases, v, "package"), v);
  // A stale marker must not authorize deletion even if another scope still pins this release.
  writeFileSync(join(releases, "0.1.0", ".retired-at"), "1");
  const repo = join(home, "remote");
  pkg(repo, next);
  const bin = join(home, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = clone ] && [ "$6" = "v${next}" ] || exit 1\ncp -R "$7" "$8"\n`, { mode: 0o755 });
  const agent = join(home, "agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [`../share/steak-pi/releases/${current}/package`], theme: "x" }));
  return { home, releases, agent, repo };
}

function run(f: ReturnType<typeof fixture>, current: string, args: string[], tag: string) {
  return spawnSync("/bin/sh", [join(f.releases, current, "package", "bin", "steak-pi"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: f.home, PATH: `${join(f.home, "bin")}:${process.env.PATH}`, PI_CODING_AGENT_DIR: f.agent, STEAK_PI_LATEST_TAG: tag, STEAK_PI_RELEASE_SOURCE: f.repo, STEAK_PI_LIBEXEC: "" },
  });
}

describe("steak-pi update for release-folder installs", () => {
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
    expect(existsSync(join(f.releases, "0.1.0", "package"))).toBe(true); // old releases are retained
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
    expect(existsSync(join(f.releases, "0.1.0", "package"))).toBe(true);
  });

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
    expect(r.stdout).toContain("Steak Pi 0.17.0 is available (you have 0.16.0). Run: steak-pi update");
    expect(existsSync(join(f.releases, "0.17.0"))).toBe(false);
  });

  it("installs the new release, re-points Pi settings and retains old releases", () => {
    const f = fixture("0.16.0", "0.17.0");
    const r = run(f, "0.16.0", ["update"], "v0.17.0");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Steak Pi updated: 0.16.0 -> 0.17.0");
    const settings = JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8"));
    expect(settings).toEqual({ packages: ["../share/steak-pi/releases/0.17.0/package"], theme: "x" });
    expect(JSON.parse(readFileSync(join(f.releases, "0.17.0", "package", "package.json"), "utf8")).version).toBe("0.17.0");
    expect(existsSync(join(f.releases, "0.16.0"))).toBe(true); // the one rollback
    expect(existsSync(join(f.releases, "0.1.0"))).toBe(true); // stale retirement marker cannot authorize deletion
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
    // 0.1.0 was retired an hour ago; a fake "pi" process that started two hours ago may still be loading it.
    writeFileSync(join(f.releases, "0.1.0", ".retired-at"), String(Math.floor(Date.now() / 1000) - 3600));
    const bin = join(f.home, "bin");
    writeFileSync(join(bin, "ps"), `#!/bin/sh
case "$*" in
  *lstart*) echo "$(LC_ALL=C date -r $(( $(date +%s) - 7200 )) '+%a %b %d %T %Y')";;
  *) echo "4242 pi";;
esac
`, { mode: 0o755 });
    const r = spawnSync("/bin/sh", [join(f.releases, "0.16.0", "package", "bin", "steak-pi"), "update"], {
      encoding: "utf8",
      env: { ...process.env, HOME: f.home, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: f.agent, STEAK_PI_LATEST_TAG: "v0.17.0", STEAK_PI_RELEASE_SOURCE: f.repo, STEAK_PI_LIBEXEC: "" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(f.releases, "0.1.0", "package"))).toBe(true);
    expect(r.stdout).toContain("existing releases retained");
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

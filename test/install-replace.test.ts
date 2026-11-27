// `steak-pi install` against the real Pi CLI (the pinned dev dependency, offline): an existing Steak Pi entry written
// relative to the agent directory must be replaced, not left next to the new one (2026-11-27: Pi resolved the relative
// remove argument against the current directory, matched nothing, and the installer appended 0.46.1 beside 0.46.0).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hermeticEnv } from "./helpers/hermetic-env.ts";

const CLI = resolve(import.meta.dirname, "..", "bin", "steak-pi");
const piPkg = resolve(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
const PI_JS = join(dirname(piPkg), JSON.parse(readFileSync(piPkg, "utf8")).bin.pi);

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "steak-install-replace-")));
  const releases = join(home, ".local", "share", "steak-pi", "releases");
  for (const v of ["0.1.0", "0.2.0"]) {
    const pkg = join(releases, v, "package"); mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "steak-pi", version: v, private: true }));
    writeFileSync(join(pkg, "bin", "steak-pi"), readFileSync(CLI), { mode: 0o755 });
  }
  const other = join(home, "other-ext"); mkdirSync(other);
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "other-ext", version: "1.0.0" }));
  const bin = join(home, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec "${process.execPath}" "${PI_JS}" "$@"\n`, { mode: 0o755 });
  const agent = join(home, ".pi", "agent"); mkdirSync(agent, { recursive: true });
  const cwd = join(home, "elsewhere"); mkdirSync(cwd);
  return { home, releases, agent, bin, other, cwd };
}

function install(f: ReturnType<typeof fixture>, version: string) {
  return spawnSync("/bin/sh", [join(f.releases, version, "package", "bin", "steak-pi"), "install"], {
    cwd: f.cwd, encoding: "utf8", timeout: 60_000,
    env: hermeticEnv(f.home, { PATH: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: f.agent,
      STEAK_PI_LIBEXEC: join(f.releases, version, "package"), PI_OFFLINE: "1", PI_TELEMETRY: "0" }),
  });
}
const packages = (f: ReturnType<typeof fixture>) => JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8")).packages;

describe("steak-pi install with the real Pi CLI", { timeout: 120_000 }, () => {
  it("replaces a relative Steak Pi entry and keeps other packages", () => {
    const f = fixture();
    writeFileSync(join(f.agent, "settings.json"), JSON.stringify({ packages: ["../../.local/share/steak-pi/releases/0.1.0/package", "../../other-ext"] }));
    const r = install(f, "0.2.0");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain(`Replacing the existing pi package entry (${join(f.releases, "0.1.0", "package")})`);
    expect(packages(f)).toEqual(["../../other-ext", "../../.local/share/steak-pi/releases/0.2.0/package"]);
  });

  it("removes every stale Steak Pi entry, including a duplicate, and is idempotent", () => {
    const f = fixture();
    writeFileSync(join(f.agent, "settings.json"), JSON.stringify({ packages: [
      "../../.local/share/steak-pi/releases/0.1.0/package", join(f.releases, "0.1.0", "package"), "../../.local/share/steak-pi/releases/0.2.0/package"] }));
    const r = install(f, "0.2.0");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(packages(f)).toEqual(["../../.local/share/steak-pi/releases/0.2.0/package"]);
    const again = install(f, "0.2.0");
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain("Replacing");
    expect(packages(f)).toEqual(["../../.local/share/steak-pi/releases/0.2.0/package"]);
  });
});

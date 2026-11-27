import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { hermeticEnv } from "./helpers/hermetic-env.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "bin", "steak-pi");

/** A published-release fixture: an archive, SHA256SUMS and a release-folder pin; no network. */
function fixture(current: string, next: string, corrupt = false) {
  const home = mkdtempSync(join(tmpdir(), "steak-install-safety-"));
  const releases = join(home, "share", "steak-pi", "releases");
  const agent = join(home, "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [`../share/steak-pi/releases/${current}/package`], theme: "keep" }));
  const pkg = (dir: string, version: string) => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "steak-pi", version, private: true }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "steak-pi", version, lockfileVersion: 3, requires: true, packages: { "": { name: "steak-pi", version } } }));
    writeFileSync(join(dir, "bin", "steak-pi"), readFileSync(CLI));
    cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
  };
  pkg(join(releases, current, "package"), current);
  const assets = join(home, "assets");
  const stage = join(home, "stage");
  pkg(join(stage, "package"), next);
  mkdirSync(assets, { recursive: true });
  const archive = `steak-pi-${next}.tgz`;
  const packed = spawnSync("tar", ["-czf", join(assets, archive), "-C", stage, "package"], { encoding: "utf8" });
  expect(packed.status, packed.stderr).toBe(0);
  const digest = createHash("sha256").update(readFileSync(join(assets, archive))).digest("hex");
  writeFileSync(join(assets, "SHA256SUMS"), `${corrupt ? "0".repeat(64) : digest}  ${archive}\n`);
  return { home, releases, agent, assets };
}

function run(f: ReturnType<typeof fixture>, current: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync("/bin/sh", [join(f.releases, current, "package", "bin", "steak-pi"), ...args], {
    encoding: "utf8",
    env: hermeticEnv(f.home, { PI_CODING_AGENT_DIR: f.agent, STEAK_PI_BIN_DIR: join(f.home, "bin"), STEAK_PI_LATEST_TAG: "v0.17.0", STEAK_PI_RELEASE_BASE: `file://${f.assets}`, STEAK_PI_LIBEXEC: "", ...extra }),
  });
}
const pin = (f: ReturnType<typeof fixture>) => JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8")).packages[0];

it("refuses to swap an archive whose SHA-256 does not match SHA256SUMS", () => {
  const f = fixture("0.16.0", "0.17.0", true);
  const r = run(f, "0.16.0", ["update"]);
  expect(r.status, r.stderr).not.toBe(0);
  expect(r.stderr).toContain("checksum mismatch for steak-pi-0.17.0.tgz; nothing was changed");
  expect(pin(f)).toBe("../share/steak-pi/releases/0.16.0/package");
  expect(existsSync(join(f.releases, "0.17.0", "package"))).toBe(false);
  expect(readdirSync(f.releases).filter((name) => name.startsWith(".staging-"))).toEqual([]); // temp dir removed on failure
  rmSync(f.home, { recursive: true, force: true });
});

it("refuses an archive SHA256SUMS does not list", () => {
  const f = fixture("0.16.0", "0.17.0");
  writeFileSync(join(f.assets, "SHA256SUMS"), `${"0".repeat(64)}  steak-pi.tgz\n`);
  const r = run(f, "0.16.0", ["update"]);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("no checksum for steak-pi-0.17.0.tgz in SHA256SUMS; nothing was changed");
  expect(pin(f)).toBe("../share/steak-pi/releases/0.16.0/package");
  expect(readdirSync(f.releases)).toEqual(["0.16.0"]);
  rmSync(f.home, { recursive: true, force: true });
});

it("shows current -> new and the first lines of the release notes before installing", () => {
  const f = fixture("0.16.0", "0.17.0");
  const api = join(f.home, "latest.json");
  writeFileSync(api, JSON.stringify({ tag_name: "v0.17.0", body: "## Changes\r\n\r\n- one\n- two\n- three\n- four\n- five\n- six" }));
  const r = run(f, "0.16.0", ["update"], { STEAK_PI_LATEST_TAG: "", STEAK_PI_UPDATE_API: `file://${api}` });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain("Steak Pi 0.16.0 -> 0.17.0\n  ## Changes\n  - one\n  - two\n  - three\n  - four\n  - five\nDownloading");
  expect(r.stdout).not.toContain("Install 0.17.0 now?"); // not a terminal: the explicit command is the consent
  expect(pin(f)).toBe("../share/steak-pi/releases/0.17.0/package");
  rmSync(f.home, { recursive: true, force: true });
}, 60_000); // runs the real install (dependency install included), which takes longer than the default 5 s on a busy machine

it("installs a verified archive and rolls back to the retained release", () => {
  const f = fixture("0.16.0", "0.17.0");
  const updated = run(f, "0.16.0", ["update"]);
  expect(updated.status, updated.stderr).toBe(0);
  expect(pin(f)).toBe("../share/steak-pi/releases/0.17.0/package");
  expect(readFileSync(join(f.agent, "settings.json"), "utf8")).toContain("keep");
  expect(readdirSync(f.releases).filter((name) => name.startsWith(".staging-"))).toEqual([]); // temp dir removed on success
  const rollback = run(f, "0.17.0", ["update", "--rollback"]);
  expect(rollback.status, rollback.stderr).toBe(0);
  expect(rollback.stdout).toContain("Steak Pi rolled back: 0.17.0 -> 0.16.0");
  expect(pin(f)).toBe("../share/steak-pi/releases/0.16.0/package");
  expect(existsSync(join(f.releases, "0.17.0", "package"))).toBe(true); // rollback keeps the newer release
  rmSync(f.home, { recursive: true, force: true });
}, 60_000); // runs the real install (dependency install included), which takes longer than the default 5 s on a busy machine

it("builds the published archive URL from the package's repository metadata", () => {
  const f = fixture("0.16.0", "0.17.0");
  const bin = join(f.home, "bin");
  mkdirSync(bin, { recursive: true });
  const requests = join(f.home, "curl-request");
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${requests}"\nexit 22\n`, { mode: 0o755 });
  const r = spawnSync("/bin/sh", [join(f.releases, "0.16.0", "package", "bin", "steak-pi"), "update"], {
    encoding: "utf8",
    env: hermeticEnv(f.home, { PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: f.agent, STEAK_PI_BIN_DIR: bin, STEAK_PI_LATEST_TAG: "v0.17.0", STEAK_PI_RELEASE_BASE: "", STEAK_PI_LIBEXEC: "" }),
  });
  expect(r.status).not.toBe(0);
  const repoUrl = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).repository.url as string).replace(/\.git$/, "");
  expect(readFileSync(requests, "utf8")).toContain(`${repoUrl}/releases/download/v0.17.0/steak-pi-0.17.0.tgz`);
  expect(pin(f)).toBe("../share/steak-pi/releases/0.16.0/package");
  rmSync(f.home, { recursive: true, force: true });
});

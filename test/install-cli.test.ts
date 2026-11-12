// One-step installer (scripts/install.sh) tests, in the style of update-cli.test.ts: a synthetic release
// served from a local folder (file:// base), a throwaway HOME and PI_CODING_AGENT_DIR, and test doubles for
// pi / npm so both branches (Pi present, Pi absent) run offline. The real `npm ci` path is exercised with an
// empty dependency set, exactly like the updater tests. Nothing touches the operator's ~/.pi or release folder.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "..", "bin", "steak-pi");
const INSTALL_SH = resolve(import.meta.dirname, "..", "scripts", "install.sh");
const V1 = "0.98.0";
const V2 = "0.99.0";
const PI_PIN = "1.0.4";

/** A release base folder: steak-pi.tgz (+ versioned copy) and SHA256SUMS, package/ layout like the real archive.
 * The package carries one offline file: dependency so a real `npm ci` provably installs node_modules on any npm. */
function buildBase(base: string, version: string, withPin: boolean) {
  const stage = mkdtempSync(join(tmpdir(), "steak-install-src-"));
  const pkg = join(stage, "package");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "dep"), { recursive: true });
  writeFileSync(join(pkg, "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0" }));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "steak-pi", version, private: true, bin: { "steak-pi": "bin/steak-pi" }, dependencies: { dep: "file:dep" } }));
  const root: Record<string, unknown> = { name: "steak-pi", version, dependencies: { dep: "file:dep" } };
  // The range in devDependencies differs from the resolved version on purpose: the installer must use the resolved one.
  if (withPin) root.devDependencies = { "@earendil-works/pi-coding-agent": "^1.0.0" };
  writeFileSync(join(pkg, "package-lock.json"), JSON.stringify({ name: "steak-pi", version, lockfileVersion: 3, requires: true, packages: {
    "": root,
    dep: { name: "dep", version: "1.0.0" },
    "node_modules/dep": { name: "dep", version: "1.0.0", resolved: "dep", link: true },
    ...(withPin ? { "node_modules/@earendil-works/pi-coding-agent": { version: PI_PIN } } : {}),
  } }));
  writeFileSync(join(pkg, "bin", "steak-pi"), readFileSync(CLI), { mode: 0o755 });
  mkdirSync(base, { recursive: true });
  const tgz = join(base, "steak-pi.tgz");
  const r = spawnSync("tar", ["-czf", tgz, "-C", stage, "package"], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  copyFileSync(tgz, join(base, `steak-pi-${version}.tgz`));
  const sums = ["steak-pi.tgz", `steak-pi-${version}.tgz`]
    .map((name) => `${createHash("sha256").update(readFileSync(join(base, name))).digest("hex")}  ${name}`)
    .join("\n") + "\n";
  writeFileSync(join(base, "SHA256SUMS"), sums);
}

/** Test double for the pi CLI: install/remove rewrite settings.json packages, like pi does for a local path. */
const FAKE_PI = `#!/bin/sh
agent="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent"
cmd="\${1:-}"; shift || true
case "$cmd" in
  install|remove)
    node -e '
      const fs = require("fs"); const [file, cmd, target] = process.argv.slice(1);
      let s = {}; try { s = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const pkgs = Array.isArray(s.packages) ? s.packages : [];
      s.packages = cmd === "install" ? [target] : pkgs.filter((p) => (typeof p === "string" ? p : p.source) !== target);
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\\n");
    ' "$agent/settings.json" "$cmd" "\${1:-}"
    ;;
esac
exit 0
`;

/** Test double for npm: records every call; ci makes node_modules; install makes a fake Pi package with a pi bin. */
const FAKE_NPM = `#!/bin/sh
printf '%s\\n' "$*" >> "$NPM_CALLS"
cmd="\${1:-}"; shift || true
case "$cmd" in
  ci) mkdir -p node_modules; exit 0;;
  install)
    prefix=""; spec=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --prefix) prefix="$2"; shift 2;;
        -*) shift;;
        *) spec="$1"; shift;;
      esac
    done
    mkdir -p "$prefix/node_modules/.bin" "$prefix/node_modules/@earendil-works/pi-coding-agent"
    printf '{"name":"@earendil-works/pi-coding-agent","version":"%s","bin":{"pi":"dist/bundle/cli.js"}}' "\${spec##*@}" > "$prefix/node_modules/@earendil-works/pi-coding-agent/package.json"
    cp "$FAKE_PI" "$prefix/node_modules/.bin/pi"
    chmod 755 "$prefix/node_modules/.bin/pi"
    exit 0;;
esac
exit 0
`;

const TOOLS = ["node", "npm", "curl", "wget", "tar", "shasum", "sha256sum", "awk", "sed", "grep", "mktemp", "uname",
  "cat", "cut", "head", "tr", "dirname", "basename", "ls", "chmod", "mv", "rm", "mkdir", "ln", "cp"];

function fixture(opts: { piPresent: boolean; fakeNpm: boolean; version?: string }) {
  // realpath: macOS tmpdir is a symlink (/var -> /private/var) and the CLI pins paths with pwd -P.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "steak-install-cli-")));
  const base = join(home, "release-base");
  const version = opts.version ?? V1;
  buildBase(base, version, opts.fakeNpm); // the Pi pin is only read when Pi is absent (fake npm there)
  const tools = join(home, "tools"); mkdirSync(tools);
  for (const tool of TOOLS) {
    // Never place a symlink where a fake will be written: writeFileSync follows symlinks and would
    // overwrite the REAL tool (this once clobbered the machine's npm-cli.js through tools/npm).
    if (opts.fakeNpm && tool === "npm") continue;
    const found = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found) symlinkSync(found, join(tools, tool));
  }
  const fakePi = join(home, "fake-pi"); writeFileSync(fakePi, FAKE_PI, { mode: 0o755, flag: "wx" });
  if (opts.piPresent) symlinkSync(fakePi, join(tools, "pi"));
  const npmCalls = join(home, "npm-calls.log");
  // flag wx: refuse to create through any existing path or symlink; the fake must be a fresh regular file.
  if (opts.fakeNpm) writeFileSync(join(tools, "npm"), FAKE_NPM, { mode: 0o755, flag: "wx" });
  const agent = join(home, "agent"); mkdirSync(agent);
  const steakHome = join(home, "steak-pi-home");
  const bin = join(home, "bin");
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${tools}:/usr/bin:/bin`, // a controlled PATH: the operator's own pi never leaks in
    PI_CODING_AGENT_DIR: agent,
    STEAK_PI_HOME: steakHome,
    STEAK_PI_BIN_DIR: bin,
    STEAK_PI_RELEASE_BASE: `file://${base}`,
    STEAK_PI_LIBEXEC: "",
    STEAK_PI_VERSION: "",
    STEAK_PI_PI_VERSION: "",
    NPM_CALLS: npmCalls,
    FAKE_PI: fakePi,
  };
  return { home, base, tools, agent, steakHome, bin, env, npmCalls, version, fakeNpm: opts.fakeNpm };
}

function runInstall(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}) {
  if (f.fakeNpm) {
    // The fake npm must be a regular file, never a symlink to the operator's real npm.
    const st = lstatSync(join(f.tools, "npm"));
    expect(st.isSymbolicLink(), "tools/npm must not be a symlink").toBe(false);
    expect(st.isFile(), "tools/npm must be a regular file").toBe(true);
  }
  return spawnSync("/bin/sh", [INSTALL_SH], { encoding: "utf8", env: { ...f.env, ...extra }, timeout: 120000 });
}

function settings(f: ReturnType<typeof fixture>) {
  return JSON.parse(readFileSync(join(f.agent, "settings.json"), "utf8"));
}

describe("steak-pi one-step installer (install.sh)", () => {
  it("Pi present: installs the release layout, points Pi's settings at it, adds no pi shim", () => {
    const f = fixture({ piPresent: true, fakeNpm: false });
    const r = runInstall(f);
    expect(r.status, r.stderr).toBe(0);
    const pkg = join(f.steakHome, "releases", V1, "package");
    expect(settings(f).packages).toEqual([pkg]);
    expect(existsSync(join(pkg, "bin", "steak-pi"))).toBe(true);
    expect(existsSync(join(pkg, "node_modules", "dep"))).toBe(true); // real npm ci installed the file: dependency
    expect(existsSync(join(f.bin, "steak-pi"))).toBe(true);
    expect(existsSync(join(f.bin, "pi"))).toBe(false); // pi existed: no shim
    expect(r.stdout).toContain("Pi was already installed");
    expect(r.stdout).toContain(`steak-pi CLI      ${V1}`); // the final status ran
    const v = spawnSync(join(f.bin, "steak-pi"), ["version"], { encoding: "utf8", env: f.env });
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout).toContain(`steak-pi ${V1}`);
  }, 120000);

  it("Pi absent: installs the pinned Pi, adds the pi shim, and says Pi was installed too", () => {
    const f = fixture({ piPresent: false, fakeNpm: true });
    const r = runInstall(f);
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(f.npmCalls, "utf8");
    expect(calls).toContain(`install --prefix ${join(f.steakHome, "pi")} --ignore-scripts --no-audit --no-fund --loglevel=error @earendil-works/pi-coding-agent@${PI_PIN}`);
    expect(calls).toMatch(/^ci --ignore-scripts --no-audit --no-fund/m);
    expect(existsSync(join(f.bin, "pi"))).toBe(true);
    expect(settings(f).packages).toEqual([join(f.steakHome, "releases", V1, "package")]);
    expect(r.stdout).toContain(`Pi ${PI_PIN} was installed too`);
    // The shimmed pi works: the installer used it to pin the package.
    const pi = spawnSync(join(f.bin, "pi"), ["install", "/tmp/other"], { encoding: "utf8", env: f.env });
    expect(pi.status, pi.stderr).toBe(0);
    expect(settings(f).packages).toEqual(["/tmp/other"]);
  }, 120000);

  it("Pi absent: STEAK_PI_PI_VERSION overrides the lock pin", () => {
    const f = fixture({ piPresent: false, fakeNpm: true });
    const r = runInstall(f, { STEAK_PI_PI_VERSION: "2.3.4" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(f.npmCalls, "utf8")).toContain("@earendil-works/pi-coding-agent@2.3.4");
    expect(r.stdout).toContain("Pi 2.3.4 was installed too");
  }, 120000);

  it("refuses a corrupted archive with the checksum error and installs nothing", () => {
    const f = fixture({ piPresent: true, fakeNpm: false });
    const tgz = join(f.base, "steak-pi.tgz");
    const bytes = readFileSync(tgz); bytes[bytes.length - 1] ^= 0xff; writeFileSync(tgz, bytes);
    const r = runInstall(f);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("checksum mismatch for steak-pi.tgz; nothing was installed");
    expect(existsSync(join(f.steakHome, "releases"))).toBe(false);
    expect(existsSync(join(f.bin, "steak-pi"))).toBe(false);
    expect(existsSync(join(f.agent, "settings.json"))).toBe(false);
  }, 120000);

  it("re-running upgrades in place, keeps the old release, and re-points Pi", () => {
    const f = fixture({ piPresent: true, fakeNpm: false });
    expect(runInstall(f).status, "first install").toBe(0);
    buildBase(f.base, V2, false);
    const r = runInstall(f);
    expect(r.status, r.stderr).toBe(0);
    expect(settings(f).packages).toEqual([join(f.steakHome, "releases", V2, "package")]);
    expect(existsSync(join(f.steakHome, "releases", V1, "package"))).toBe(true); // retained, like the updater
    expect(readFileSync(join(f.bin, "steak-pi"), "utf8")).toContain(join("releases", V2, "package"));
    expect(r.stdout).toContain(`steak-pi CLI      ${V2}`);
  }, 180000);

  it("re-running the same version is idempotent", () => {
    const f = fixture({ piPresent: true, fakeNpm: false });
    expect(runInstall(f).status).toBe(0);
    const r = runInstall(f);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Steak Pi ${V1} is already unpacked`);
    expect(settings(f).packages).toEqual([join(f.steakHome, "releases", V1, "package")]);
  }, 180000);

  it("STEAK_PI_VERSION pins the versioned archive and refuses a mismatch", () => {
    const f = fixture({ piPresent: true, fakeNpm: false });
    const r = runInstall(f, { STEAK_PI_VERSION: V1 });
    expect(r.status, r.stderr).toBe(0);
    expect(settings(f).packages).toEqual([join(f.steakHome, "releases", V1, "package")]);
    const bad = runInstall(f, { STEAK_PI_VERSION: "9.9.9" });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("download failed"); // steak-pi-9.9.9.tgz is not in the base
  }, 180000);

  it("names a missing prerequisite and how to get it", () => {
    const f = fixture({ piPresent: true, fakeNpm: false });
    const empty = join(f.home, "empty"); mkdirSync(empty);
    const r = spawnSync("/bin/sh", [INSTALL_SH], { encoding: "utf8", env: { ...f.env, PATH: empty }, timeout: 60000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("needs curl or wget");
    expect(existsSync(join(f.steakHome, "releases"))).toBe(false);
  }, 60000);

  it("Pi absent: the pin is the RESOLVED lockfile version, not the devDependencies range", () => {
    const f = fixture({ piPresent: false, fakeNpm: true });
    const r = runInstall(f);
    expect(r.status, r.stderr).toBe(0);
    const calls = readFileSync(f.npmCalls, "utf8");
    expect(calls).toContain(`@earendil-works/pi-coding-agent@${PI_PIN}`);
    expect(calls).not.toContain("^1.0.0");
  }, 120000);

  it("every shim carries the marker, and the pi shim is written only after steak-pi install succeeded", () => {
    const f = fixture({ piPresent: false, fakeNpm: true });
    expect(runInstall(f).status).toBe(0);
    for (const name of ["pi", "steak-pi"]) expect(readFileSync(join(f.bin, name), "utf8")).toContain("steak-pi-installer-shim");
    // A Pi whose `install` fails: the run fails and no pi shim is left behind.
    const g = fixture({ piPresent: false, fakeNpm: true });
    writeFileSync(join(g.home, "fake-pi-fails"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = runInstall(g, { FAKE_PI: join(g.home, "fake-pi-fails") });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("'steak-pi install' failed");
    expect(existsSync(join(g.bin, "pi"))).toBe(false);
  }, 180000);

  it("never replaces a pi or steak-pi in the bin folder that the installer did not write", () => {
    const f = fixture({ piPresent: false, fakeNpm: true });
    mkdirSync(f.bin, { recursive: true });
    writeFileSync(join(f.bin, "pi"), "#!/bin/sh\necho users-own-pi\n", { mode: 0o755 });
    writeFileSync(join(f.bin, "steak-pi"), "#!/bin/sh\necho users-own-steak-pi\n", { mode: 0o755 });
    const r = runInstall(f);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(f.bin, "pi"), "utf8")).toContain("users-own-pi");
    expect(readFileSync(join(f.bin, "steak-pi"), "utf8")).toContain("users-own-steak-pi");
    expect(r.stdout).toContain("alone: it was not written by this installer");
    expect(settings(f).packages).toEqual([join(f.steakHome, "releases", V1, "package")]);
  }, 120000);

  it("a re-run does not take its own pi shim for a Pi the user already had", () => {
    const f = fixture({ piPresent: false, fakeNpm: true });
    expect(runInstall(f).status).toBe(0);
    const again = runInstall(f, { PATH: `${f.bin}:${f.env.PATH}` }); // our shim is now on PATH
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).not.toContain("Pi is already installed");
    expect(again.stdout).toContain(`Pi ${PI_PIN} was installed too`);
    expect(readFileSync(join(f.bin, "pi"), "utf8")).toContain("steak-pi-installer-shim");
  }, 180000);

  it("replaces a 0.28.0 shim (no marker, names a path inside the Steak Pi home)", () => {
    const f = fixture({ piPresent: true, fakeNpm: false });
    mkdirSync(f.bin, { recursive: true });
    writeFileSync(join(f.bin, "steak-pi"), `#!/bin/sh\nexec "${f.steakHome}/releases/0.27.0/package/bin/steak-pi" "$@"\n`, { mode: 0o755 });
    const r = runInstall(f);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(f.bin, "steak-pi"), "utf8")).toContain("steak-pi-installer-shim");
  }, 120000);
});

describe("scripts/build-release.sh output folder guard", () => {
  const BUILD = resolve(import.meta.dirname, "..", "scripts", "build-release.sh");
  const root = resolve(import.meta.dirname, "..");
  for (const out of [".", "/", ""]) {
    it(`refuses ${JSON.stringify(out)} before deleting anything`, () => {
      const r = spawnSync("/bin/sh", [BUILD, out], { encoding: "utf8", cwd: root });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("refusing output folder");
      expect(existsSync(join(root, "package.json"))).toBe(true);
    });
  }
  it("refuses the repository root given as an absolute path", () => {
    const r = spawnSync("/bin/sh", [BUILD, root], { encoding: "utf8", cwd: root });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refusing output folder");
    expect(existsSync(join(root, "package.json"))).toBe(true);
  });
  it("zips deterministically with gzip -n on the bsdtar branch", () => {
    expect(readFileSync(BUILD, "utf8")).toContain("gzip -n");
  });
});

describe("scripts/install.ps1 static guards (Windows-only patterns that must not return)", () => {
  const ps1 = readFileSync(resolve(import.meta.dirname, "..", "scripts", "install.ps1"), "utf8");
  const code = ps1.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  it("finds Git's own sh and never a bash by name", () => {
    expect(code).not.toMatch(/Get-Command\s+bash/);
    expect(code).toMatch(/Git\\bin\\sh\.exe/);
    expect(code).toContain("$env:SystemRoot");
  });
  it("passes no double quotes inside a node -p argument", () => {
    expect(code).not.toMatch(/-p\s+'[^']*"/);
    expect(code).toContain("read-pi-pin.js");
    expect(code).toContain("node_modules/@earendil-works/pi-coding-agent");
    expect(code).not.toContain("devDependencies");
  });
  it("writes no shim as ASCII; .cmd shims are %~dp0-relative or OEM-encoded", () => {
    expect(code).not.toMatch(/-Encoding\s+Ascii/i);
    expect(code).toContain("%~dp0..");
    expect(code).toContain("OEMCodePage");
  });
  it("unpacks into a staging folder under the Steak Pi home, not %TEMP%", () => {
    expect(code).not.toMatch(/\$src\s*=\s*Join-Path\s+\$tmp/);
    expect(code).not.toMatch(/Move-Item\s+\$pkgSrc\s+\(Join-Path\s+\$stage/);
    expect(code).toMatch(/\$stage\s*=\s*Join-Path\s+\$releases/);
  });
  it("removes an existing node folder before the zip Move-Item", () => {
    expect(code).toMatch(/Remove-Item[^\n]*\$nodeDir[^\n]*\n\s*Move-Item\s+\$inner\.FullName\s+\$nodeDir/);
  });
  it("relaxes ErrorActionPreference around captured native stderr (2>&1)", () => {
    for (const line of code.split("\n").filter((l) => /status 2>&1/.test(l))) expect(line).toBeTruthy();
    expect(code).toMatch(/ErrorActionPreference = 'Continue'[\s\S]*status 2>&1/);
  });
  it("normalises the home and bin paths, opts in to TLS 1.2, and leaves the session alone", () => {
    expect(code).toContain("GetUnresolvedProviderPathFromPSPath($homeDir)");
    expect(code).toContain("GetUnresolvedProviderPathFromPSPath($binDir)");
    expect(code).toContain("SecurityProtocolType]::Tls12");
    expect(code).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(code).not.toMatch(/^\$ErrorActionPreference/m);
    expect(code).not.toMatch(/^\s*exit\b/m);
  });
  it("marks every shim and checks the marker before writing", () => {
    expect(code).toContain("steak-pi-installer-shim");
    expect(code).toContain("Test-OwnShim");
    expect(code).toContain("not written by this installer");
  });
});

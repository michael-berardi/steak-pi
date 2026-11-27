/**
 * Privacy guard: shipped code must not grow a telemetry/analytics SDK or endpoint, and
 * the local state that holds conversation text must stay private to its owner.
 */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { snapFileName, writeSnap, writeSnapEntries } from "../extensions/ultracompress/src/snapshot.ts";
import { rotateServerLog } from "../src/local/runtime.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const codeExt = /\.(?:ts|mjs|js|sh|ps1)$/;
const shippedDirs = ["src", "extensions", "bin", "scripts"];

/** Names and endpoints that would send data outside the operator's configured providers. */
const forbidden = [
  /\bposthog(?:[-_/.]|\b)/i,
  /\bsentry(?:[-_/.]|\b)/i,
  /\bsegment\.io\b/i,
  /\bmixpanel(?:[-_/.]|\b)/i,
  /\bamplitude(?:[-_/.]|\b)/i,
  /\bdatadog(?:[-_/.]|\b)/i,
  /\bbugsnag(?:[-_/.]|\b)/i,
  /\b(?:www\.)?google-analytics\.com\b/i,
  /\bgoogletagmanager\.com\b/i,
  /\bgtag\s*\(/i,
  /\bopentelemetry(?:[-_/.]|\b)/i,
  /\bpi\.dev\/api\/report-install\b/i,
];
const violations = (text: string): string[] => forbidden.filter((pattern) => pattern.test(text)).map(String);
/** Non-blank lines of a Markdown section, excluding its heading and the next section. */
function sectionLines(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const rest = lines.slice(lines.indexOf(heading) + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return rest.slice(0, end < 0 ? rest.length : end).map((line) => line.trim()).filter(Boolean);
}

function shippedFiles(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return shippedFiles(path);
    return entry.isFile() && (codeExt.test(entry.name) || entry.name === "steak-pi") ? [path] : [];
  });
}

describe("privacy guard", () => {
  it("ships no analytics/telemetry SDK, endpoint or dependency", () => {
    const files = shippedDirs.flatMap(shippedFiles);
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) expect(violations(read(file)), file).toEqual([]);
    const pkg = JSON.parse(read("package.json"));
    const manifest = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
    expect(violations(manifest)).toEqual([]);
  });

  it("disables Pi, npm and Homebrew telemetry by default in the launchers and installers", () => {
    const cli = read("bin/steak-pi");
    const runEnv = cli.slice(cli.indexOf("run_env() {"), cli.indexOf("cmd_run()"));
    expect(runEnv).toMatch(/PI_TELEMETRY=0; export PI_TELEMETRY/);
    expect(runEnv).toMatch(/PI_OFFLINE=1; export PI_OFFLINE/);
    expect(cli).toMatch(/DO_NOT_TRACK="\$\{DO_NOT_TRACK:-1\}"/);
    expect(cli).toMatch(/HOMEBREW_NO_ANALYTICS="\$\{HOMEBREW_NO_ANALYTICS:-1\}"; export HOMEBREW_NO_ANALYTICS/);
    const installer = read("scripts/install.sh");
    expect(installer).toMatch(/DO_NOT_TRACK="\$\{DO_NOT_TRACK:-1\}"/);
    expect(installer).toMatch(/npm_config_update_notifier=false/);
    expect(installer).toMatch(/PI_OFFLINE="\$\{PI_OFFLINE:-1\}"/);
    expect(installer).toMatch(/expect "\$TMP\/\$ARCHIVE" "\$ARCHIVE" "\$TMP\/SHA256SUMS"/);
    const windows = read("scripts/install.ps1");
    expect(windows).toMatch(/\$env:PI_TELEMETRY = '0'/);
    expect(windows).toMatch(/\$env:PI_OFFLINE = '1'/);
    expect(windows).toMatch(/\$env:DO_NOT_TRACK = '1'/);
  });

  it("keeps compaction snapshots private even when the paths already exist loosely", () => {
    const cwd = mkdtempSync(join(tmpdir(), "steak-privacy-snap-"));
    try {
      const state = join(cwd, ".steak-pi");
      const dir = join(state, "snaps");
      mkdirSync(dir, { recursive: true });
      chmodSync(state, 0o777);
      chmodSync(dir, 0o777);
      const old = snapFileName(Date.now() - 60_000);
      const file = join(dir, old);
      writeFileSync(file, "{}", { mode: 0o666 });
      chmodSync(file, 0o666);
      writeSnap(cwd, "{}", old);
      expect(lstatSync(state).mode & 0o777).toBe(0o700);
      expect(lstatSync(dir).mode & 0o777).toBe(0o700);
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
      const written = writeSnapEntries(cwd, [{ text: "synthetic conversation" }], "privacy", Date.now());
      expect(lstatSync(join(dir, written.file)).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rotates the local server log past its cap so it stays bounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "steak-privacy-log-"));
    try {
      const log = join(dir, "server.log");
      writeFileSync(log, "x".repeat(10));
      expect(rotateServerLog(log, 64)).toBe(false);
      writeFileSync(join(dir, "server.log.1"), "older");
      writeFileSync(log, "y".repeat(100));
      expect(rotateServerLog(log, 64)).toBe(true);
      expect(readFileSync(join(dir, "server.log.1"), "utf8")).toBe("y".repeat(100));
      expect(rotateServerLog(log, 64)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps README Privacy short and moves the verified fine print into PRIVACY.md", () => {
    const readme = read("README.md"), privacy = read("PRIVACY.md");
    const lines = sectionLines(readme, "## Privacy");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(6);
    for (const line of lines) expect(line.length, line).toBeLessThan(160);
    expect(readme).toContain("[PRIVACY.md](PRIVACY.md)");
    expect(readme).toContain("STEAK_PI_NO_UPDATE_CHECK=1");
    expect(readme.toLowerCase()).not.toContain("no update check");
    expect(privacy).toContain("at most once per six hours");
    expect(privacy).toContain("STEAK_PI_NO_UPDATE_CHECK=1");
    for (const path of ["~/.pi/agent/", "~/.pi/agent/local/", ".steak-pi/snaps/", "~/.cache/steak-pi/verification/", "~/.cache/steak-pi/update-check.json", "~/.ultraterm/ui-streams/"]) {
      expect(privacy).toContain(path);
    }
    for (const detail of ["PI_TELEMETRY=0", "PI_OFFLINE=1", "HF_TOKEN", "24 hours", "14 days", "7 days", "8 MiB", "| Delete it |"]) {
      expect(privacy).toContain(detail);
    }
    expect(JSON.parse(read("package.json")).files).toContain("PRIVACY.md");
  });
});

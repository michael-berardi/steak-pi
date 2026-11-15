import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("refuses checkout ancestors, including normalized and symlink paths, before cleanup", () => {
  const fixture = mkdtempSync(resolve(".release-safety-"));
  fixtures.push(fixture);
  const checkout = join(fixture, "parent", "checkout");
  const scripts = join(checkout, "scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync("scripts/build-release.sh", join(scripts, "build-release.sh"));
  writeFileSync(join(checkout, "package.json"), '{"version":"0.0.0"}\n');
  const sentinel = join(fixture, "sentinel");
  writeFileSync(sentinel, "keep");
  // Stub destructive cleanup so a regression cannot delete even the disposable fixture.
  const bin = join(fixture, "bin");
  mkdirSync(bin);
  const cleanup = join(fixture, "cleanup-called");
  writeFileSync(join(bin, "rm"), `#!/bin/sh\ntouch '${cleanup}'\nexit 99\n`, { mode: 0o755 });
  execFileSync("git", ["init", "-q", checkout]);
  symlinkSync(fixture, join(checkout, "ancestor-link"));
  const run = (out: string) => spawnSync("sh", [join(scripts, "build-release.sh"), out], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  for (const out of [fixture, join(fixture, "parent"), "../..", "../../parent/..", "ancestor-link", "/", "/tmp/..", checkout]) {
    const result = run(out);
    expect(result.status, out).toBe(1);
    expect(result.stderr, out).toContain("refusing output folder");
    expect(existsSync(cleanup)).toBe(false);
    expect(existsSync(sentinel)).toBe(true);
  }
  // A sibling with the checkout's prefix is not an ancestor.
  const sibling = `${checkout}-output`;
  mkdirSync(sibling);
  expect(run(sibling).stderr).not.toContain("refusing output folder");
});

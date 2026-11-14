import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cli = resolve(process.env.STEAK_PI_TEST_CLI ?? "bin/steak-pi");
const commands = [
  "install", "update", "status", "version", "remove", "uninstall", "usap-api", "local", "routing", "routes",
  "env", "lean-args", "finish-guard-hook", "help", "routing check", "usap-api admit", "usap-api dispatch", "usap-api resume",
  "local add", "local start", "local stop", "local status", "local ensure", "local check", "local release", "local _supervise",
  "routes rank", "routes record", "routes verdict", "routes report",
];

describe("launcher help", () => {
  for (const command of commands) for (const flag of ["--help", "-h"]) {
    it(`${command} ${flag} exits without executing the command`, () => {
      const dir = mkdtempSync(join(tmpdir(), "steak-pi-help-"));
      try {
        const home = join(dir, "home"), bin = join(dir, "bin"), marker = join(dir, "marker");
        mkdirSync(home); mkdirSync(bin);
        for (const name of ["node", "pi", "curl", "npm", "git", "brew"]) {
          writeFileSync(join(bin, name), '#!/bin/sh\necho invoked >> "$MARKER"\nexit 42\n', { mode: 0o755 });
        }
        const result = spawnSync("/bin/sh", [cli, ...command.split(" "), flag], {
          encoding: "utf8", env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, MARKER: marker },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(`usage: steak-pi ${command}`);
        expect(existsSync(marker)).toBe(false);
        expect(readdirSync(home)).toEqual([]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
  it("passes run help to pi", () => {
    const dir = mkdtempSync(join(tmpdir(), "steak-pi-run-help-"));
    try {
      writeFileSync(join(dir, "pi"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      for (const flag of ["--help", "-h"]) {
        const result = spawnSync("/bin/sh", [cli, "run", flag], { encoding: "utf8", env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin` } });
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(flag);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "steak-updater-"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "bin", "curl"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ROOT/request"\n[ "${TEST_CURL_FAIL:-0}" = 0 ] || { echo "synthetic network failure" >&2; exit 22; }\nprintf \'{"tag_name":"v99.1.2"}\\n\'\n', { mode: 0o700 });
  fs.writeFileSync(path.join(root, "bin", "pi"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ROOT/install"\n', { mode: 0o700 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function update(fail = false) {
  return spawnSync("/bin/sh", [path.resolve("bin/steak-pi"), "update"], {
    encoding: "utf8",
    env: { PATH: `${root}/bin:/usr/bin:/bin`, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent"), TEST_ROOT: root, TEST_CURL_FAIL: fail ? "1" : "0" },
  });
}
it("synthetic status resolves a Pi-relative Homebrew package from the agent directory", () => {
  const agent = path.join(root, "agent");
  const pkg = path.join(root, "opt", "steak-pi", "libexec");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "steak-pi", version: "9.8.7" }));
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["../opt/steak-pi/libexec"] }));
  const result = spawnSync("/bin/sh", [path.resolve("bin/steak-pi"), "status"], {
    cwd: root, encoding: "utf8", env: { PATH: `${root}/bin:/usr/bin:/bin`, HOME: root, PI_CODING_AGENT_DIR: agent },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("../opt/steak-pi/libexec  (v9.8.7)");
});
it("synthetic CLI update uses the GitHub API owner/repo path but preserves the Pi git spec", () => {
  const result = update();
  expect(result.status).toBe(0);
  expect(fs.readFileSync(path.join(root, "request"), "utf8").trim().split("\n").at(-1)).toBe("https://api.github.com/repos/michael-berardi/steak-pi/releases/latest");
  expect(fs.readFileSync(path.join(root, "install"), "utf8")).toBe("install\ngit:github.com/michael-berardi/steak-pi@v99.1.2\n");
});
it("synthetic CLI update reports a failed request without installing anything", () => {
  const result = update(true);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("synthetic network failure");
  expect(result.stderr).toContain("cannot reach GitHub");
  expect(fs.existsSync(path.join(root, "install"))).toBe(false);
});

it("uninstall removes the update cache, preferences and auto-update log", () => {
  const agent = path.join(root, "agent");
  fs.mkdirSync(agent, { recursive: true });
  const settings = path.join(agent, "steak-pi.json");
  fs.writeFileSync(settings, JSON.stringify({ theme: "keep", updates: { auto: true, skippedVersion: "9.9.9" } }));
  const cacheDir = path.join(root, "cache", "steak-pi");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cache = path.join(cacheDir, "update-check.json");
  const log = path.join(cacheDir, "auto-update.log");
  fs.writeFileSync(cache, JSON.stringify({ checkedAt: 1, latest: "9.9.9" }));
  fs.writeFileSync(log, "old auto install\n");
  const result = spawnSync("/bin/sh", [path.resolve("bin/steak-pi"), "remove"], {
    encoding: "utf8",
    env: { PATH: `${path.dirname(process.execPath)}:${root}/bin:/usr/bin:/bin`, HOME: root, PI_CODING_AGENT_DIR: agent, XDG_CACHE_HOME: path.join(root, "cache"), TEST_ROOT: root },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(fs.existsSync(cache)).toBe(false);
  expect(fs.existsSync(log)).toBe(false);
  expect(JSON.parse(fs.readFileSync(settings, "utf8"))).toEqual({ theme: "keep" });
});

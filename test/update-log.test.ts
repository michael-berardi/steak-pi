import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { boundedAppend, MAX_AUTO_LOG_BYTES } from "../src/update-log.ts";

it("keeps one bounded log file, never growing past the cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-update-log-"));
  const path = join(dir, "auto-update.log");
  expect(MAX_AUTO_LOG_BYTES).toBe(256 * 1024);
  for (let i = 0; i < 40; i++) boundedAppend(path, `line-${i}-${"x".repeat(120)}`, 512);
  expect(statSync(path).size).toBeLessThanOrEqual(512);
  expect(readdirSync(dir)).toEqual(["auto-update.log"]); // no rotated debris
  expect(readFileSync(path, "utf8")).toContain("line-39-");
  expect(readFileSync(path, "utf8").split("\n").filter(Boolean).every((line) => line.startsWith("line-"))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

it("writes a fresh log with private permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-update-log-"));
  const path = join(dir, "nested", "auto-update.log");
  boundedAppend(path, "first");
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  rmSync(dir, { recursive: true, force: true });
});

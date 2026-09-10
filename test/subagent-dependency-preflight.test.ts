import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertWorkerDependencies, WORKER_PI_DEPENDENCIES } from "../src/subagents/dependency-preflight.ts";

// Native ESM resolution only: this process never imports SDK code or launches a worker.
function fixture(healthy: number, check: (entry: string, resolve: (s: string) => string) => void) {
  const root = mkdtempSync(join(import.meta.dirname, ".dependency-fixture-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const entry = pathToFileURL(join(root, "pi-worker.mjs")).href;
    writeFileSync(join(root, "pi-worker.mjs"), 'export const resolve = s => import.meta.resolve(s);');
    WORKER_PI_DEPENDENCIES.forEach((name, index) => {
      const dir = join(root, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, type: "module", exports: { import: "./entry.js", require: "./wrong.cjs" } }));
      if (index < healthy) writeFileSync(join(dir, "entry.js"), 'throw new Error("must not evaluate");');
    });
    const resolve = (s: string) => execFileSync(process.execPath, ["--input-type=module", "--eval",
      `const {resolve} = await import(${JSON.stringify(entry)}); process.stdout.write(resolve(${JSON.stringify(s)}));`,
    ], { encoding: "utf8", timeout: 5000 });
    check(entry, resolve);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("worker dependency preflight", () => {
  it("retains missing-package cause and gives path-scoped repair guidance", () => {
    const cause = Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });
    try {
      assertWorkerDependencies(import.meta.url, () => { throw cause; });
      expect.fail("expected failure");
    } catch (error) {
      expect((error as Error).message).toContain("npm install --no-audit --no-fund");
      expect((error as Error).message).toContain("package root");
      expect((error as Error).message).toContain(import.meta.url);
      const failures = ((error as Error).cause as AggregateError).errors;
      expect(failures).toHaveLength(2);
      expect(failures[0].cause).toBe(cause);
    }
  });
  it("rejects absent export files even if the manager has complete peers", () => {
    fixture(0, (entry, resolve) => expect(() => assertWorkerDependencies(entry, resolve)).toThrow("pi-coding-agent"));
  });
  it("rejects a partial peer set and names the missing peer", () => {
    fixture(1, (entry, resolve) => {
      expect(() => assertWorkerDependencies(entry, resolve)).toThrow("Cannot resolve @earendil-works/pi-tui");
    });
  });
  it("uses the actual entrypoint and ESM import condition, without evaluating code", () => {
    fixture(2, (entry, resolve) => expect(() => assertWorkerDependencies(entry, resolve)).not.toThrow());
  });
});

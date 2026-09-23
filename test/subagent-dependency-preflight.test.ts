import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertWorkerDependencies, resolveWorkerDependency, WORKER_PI_DEPENDENCIES } from "../src/subagents/dependency-preflight.ts";

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

describe("worker dependency ESM host fallback", () => {
  it("resolves import-only Pi SDK and TUI from the real host behind a launcher symlink", () => {
    const root = mkdtempSync(join(import.meta.dirname, ".dependency-host-"));
    try {
      const namespace = join(root, "node_modules", "@earendil-works");
      const sdk = join(namespace, "pi-coding-agent");
      const tui = join(namespace, "pi-tui");
      mkdirSync(join(sdk, "dist"), { recursive: true });
      mkdirSync(join(tui, "dist"), { recursive: true });
      writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.88.0", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
      writeFileSync(join(tui, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.88.0", type: "module", main: "dist/index.js" }));
      for (const dir of [sdk, tui]) writeFileSync(join(dir, "dist/index.js"), "throw Error('must never execute SDK code');");
      const cli = join(sdk, "dist/cli.js");
      writeFileSync(cli, "// inert Pi CLI entrypoint");
      const launcher = join(root, "managed-pi");
      symlinkSync(cli, launcher);
      const missing = Object.assign(new Error("missing extension peer"), { code: "ERR_MODULE_NOT_FOUND" });
      const local = () => { throw missing; };
      expect(resolveWorkerDependency("@earendil-works/pi-coding-agent", local, launcher)).toBe(pathToFileURL(join(sdk, "dist/index.js")).href);
      expect(resolveWorkerDependency("@earendil-works/pi-tui", local, launcher)).toBe(pathToFileURL(join(tui, "dist/index.js")).href);
      expect(() => resolveWorkerDependency("@earendil-works/pi-ai", local, launcher)).toThrow(missing);
      rmSync(join(sdk, "dist/index.js"));
      expect(() => resolveWorkerDependency("@earendil-works/pi-coding-agent", local, launcher)).toThrow(missing);
      // Import-only SDKs lack a CommonJS export; a require() fallback failed
      // before workers started despite an installed host SDK.
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

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

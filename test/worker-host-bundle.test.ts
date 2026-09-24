import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isHostBundleEntry } from "../src/subagents/pi-worker.ts";

describe("worker SDK host-bundle detection", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dist-"));
  const bundle = join(root, "dist", "bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "cli.js"), "");
  writeFileSync(join(root, "dist", "index.js"), "");
  const bin = join(root, "pi");
  symlinkSync(join(bundle, "cli.js"), bin);

  it("accepts the bundled CLI, including through a bin symlink", () => {
    expect(isHostBundleEntry(join(bundle, "cli.js"), bundle)).toBe(true);
    expect(isHostBundleEntry(bin, bundle)).toBe(true);
  });

  it("rejects embedded hosts and missing entries", () => {
    expect(isHostBundleEntry(join(root, "dist", "index.js"), bundle)).toBe(false);
    expect(isHostBundleEntry(undefined, bundle)).toBe(false);
    expect(isHostBundleEntry(join(root, "missing.js"), bundle)).toBe(false);
    expect(isHostBundleEntry(join(bundle, "cli.js"), join(root, "nope"))).toBe(false);
  });
});

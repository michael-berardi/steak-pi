import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostPiBundle, SUPPORTED_HOST_PI_VERSIONS } from "../src/subagents/pi-worker.ts";
import pkg from "../package.json" with { type: "json" };

function fakePi(version: string, withIndex = true) {
  const root = mkdtempSync(join(tmpdir(), "pi-host-"));
  const bundle = join(root, "dist", "bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  writeFileSync(join(bundle, "cli.js"), "");
  if (withIndex) writeFileSync(join(bundle, "index.js"), "");
  const bin = join(root, "pi");
  symlinkSync(join(bundle, "cli.js"), bin);
  return { root, bundle, bin };
}

describe("worker SDK host-bundle detection", () => {
  it("accepts a supported bundled Pi CLI, including through its bin symlink", () => {
    const { bundle, bin } = fakePi("0.86.0");
    expect(hostPiBundle(join(bundle, "cli.js"))).toBeDefined();
    expect(hostPiBundle(bin)).toBe(hostPiBundle(join(bundle, "cli.js")));
  });

  it("rejects unsupported versions, missing SDK entries, embedded hosts and missing paths", () => {
    expect(hostPiBundle(fakePi("0.87.0").bin)).toBeUndefined();
    expect(hostPiBundle(fakePi("0.86.0", false).bin)).toBeUndefined();
    const { root } = fakePi("0.86.0");
    writeFileSync(join(root, "dist", "index.js"), "");
    expect(hostPiBundle(join(root, "dist", "index.js"))).toBeUndefined();
    expect(hostPiBundle(undefined)).toBeUndefined();
    expect(hostPiBundle(join(root, "missing.js"))).toBeUndefined();
  });

  it("tracks the declared Pi peer range", () => {
    const range = pkg.peerDependencies["@earendil-works/pi-coding-agent"].split("||").map((v: string) => v.trim());
    expect([...SUPPORTED_HOST_PI_VERSIONS]).toEqual(range);
  });
});

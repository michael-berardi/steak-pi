import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markReleaseRan, parsePiStarts, pinnedVersions, pruneReleases, ROLLBACK_MAX_AGE_MS } from "../src/update-releases.ts";

const NOW = 2_000_000_000_000;
const HOUR = 60 * 60 * 1000;

/** A releases root with the given versions unpacked; `retired` maps a version to its .retired-at time. */
function releases(versions: string[], retired: Record<string, number> = {}) {
  const root = join(mkdtempSync(join(tmpdir(), "steak-releases-")), "steak-pi", "releases");
  for (const version of versions) {
    mkdirSync(join(root, version, "package"), { recursive: true });
    writeFileSync(join(root, version, "package", "package.json"), JSON.stringify({ version }));
    if (retired[version] !== undefined) writeFileSync(join(root, version, ".retired-at"), String(retired[version]));
  }
  return root;
}
const left = (root: string, versions: string[]) => versions.filter((v) => existsSync(join(root, v)));
const none = { pinned: new Set<string>(), piStarts: [] as number[], now: NOW };

describe("release-folder pruning (no debris, never under a live session)", () => {
  it("keeps one rollback until the new release has run once, and removes older ones", () => {
    const root = releases(["0.1.0", "0.2.0", "0.3.0"], { "0.1.0": NOW - 2 * HOUR, "0.2.0": NOW - HOUR });
    expect(pruneReleases(root, "0.3.0", none).removed).toEqual(["0.1.0"]);
    expect(left(root, ["0.1.0", "0.2.0", "0.3.0"])).toEqual(["0.2.0", "0.3.0"]);
    writeFileSync(join(root, "0.3.0", ".ran-at"), String(NOW));
    expect(pruneReleases(root, "0.3.0", none).removed).toEqual(["0.2.0"]);
    expect(left(root, ["0.2.0", "0.3.0"])).toEqual(["0.3.0"]);
  });

  it("removes the rollback seven days after it was retired even if the new release never ran", () => {
    const root = releases(["0.2.0", "0.3.0"], { "0.2.0": NOW - ROLLBACK_MAX_AGE_MS + 1 });
    expect(pruneReleases(root, "0.3.0", none).removed).toEqual([]);
    expect(pruneReleases(root, "0.3.0", { ...none, now: NOW + 1 }).removed).toEqual(["0.2.0"]);
  });

  it("keeps a release a running Pi session started before its retirement may load (2026-11-03)", () => {
    const root = releases(["0.1.0", "0.3.0"], { "0.1.0": NOW - HOUR });
    writeFileSync(join(root, "0.3.0", ".ran-at"), String(NOW));
    const result = pruneReleases(root, "0.3.0", { ...none, piStarts: [NOW - 2 * HOUR] });
    expect(result.removed).toEqual([]);
    expect(result.kept[0].reason).toMatch(/running Pi session/);
    expect(pruneReleases(root, "0.3.0", { ...none, piStarts: [NOW - HOUR / 2] }).removed).toEqual(["0.1.0"]);
  });

  it("keeps everything when running sessions cannot be listed", () => {
    const root = releases(["0.1.0", "0.3.0"], { "0.1.0": NOW - 30 * 24 * HOUR });
    expect(pruneReleases(root, "0.3.0", { ...none, piStarts: undefined }).removed).toEqual([]);
  });

  it("keeps a release another known agent directory pins, whatever its marker says", () => {
    const root = releases(["0.1.0", "0.3.0"], { "0.1.0": NOW - 30 * 24 * HOUR });
    expect(pruneReleases(root, "0.3.0", { ...none, pinned: new Set(["0.1.0"]) }).removed).toEqual([]);
  });

  it("starts the clock for a release without a usable marker instead of removing it", () => {
    const root = releases(["0.1.0", "0.2.0", "0.3.0"], { "0.1.0": 1_762_300_000 }); // 0.22.x wrote epoch seconds
    writeFileSync(join(root, "0.3.0", ".ran-at"), String(NOW));
    expect(pruneReleases(root, "0.3.0", none).removed).toEqual([]);
    expect(Number(readFileSync(join(root, "0.1.0", ".retired-at"), "utf8"))).toBe(NOW);
    expect(Number(readFileSync(join(root, "0.2.0", ".retired-at"), "utf8"))).toBe(NOW);
    expect(pruneReleases(root, "0.3.0", { ...none, now: NOW + 1 }).removed.sort()).toEqual(["0.1.0", "0.2.0"]);
  });

  it("never touches newer releases or the current one", () => {
    const root = releases(["0.3.0", "0.4.0"], { "0.4.0": NOW - 30 * 24 * HOUR });
    expect(pruneReleases(root, "0.3.0", none).removed).toEqual([]);
    expect(left(root, ["0.3.0", "0.4.0"])).toEqual(["0.3.0", "0.4.0"]);
  });

  it("reads pins from settings files relative to their agent directory, for this releases root only", () => {
    const root = releases(["0.1.0", "0.2.0"]);
    const home = join(root, "..", "..");
    const agent = join(home, "agent");
    mkdirSync(agent);
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: ["../steak-pi/releases/0.1.0/package", { source: "/elsewhere/steak-pi/releases/0.2.0/package" }] }));
    expect([...pinnedVersions(root, [join(agent, "settings.json"), join(home, "missing.json")])]).toEqual(["0.1.0"]);
  });

  it("parses Pi process ages from ps etime output and ignores other processes", () => {
    const output = ["  05:00 pi", "01:00:00 /usr/local/bin/pi", "2-00:00:00 pi-rpc", "00:10 node", "03:00 pipeline"].join("\n");
    expect(parsePiStarts(output, NOW)).toEqual([NOW - 5 * 60_000, NOW - HOUR, NOW - 48 * HOUR]);
  });

  it("marks a release folder as run once and reports whether older folders exist", () => {
    const root = releases(["0.2.0", "0.3.0"]);
    expect(markReleaseRan(join(root, "0.3.0", "package"), NOW)).toMatchObject({ version: "0.3.0" });
    expect(readFileSync(join(root, "0.3.0", ".ran-at"), "utf8").trim()).toBe(String(NOW));
    expect(markReleaseRan(join(root, "0.2.0", "package"), NOW)).toBeUndefined(); // nothing older to prune
    expect(markReleaseRan(join(root, ".."), NOW)).toBeUndefined(); // not a release folder
  });
});

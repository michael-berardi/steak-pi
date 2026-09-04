import { describe, expect, it } from "vitest";
import {
  buildSnap,
  listSnaps,
  snapFileName,
  writeSnap,
} from "../extensions/instant-snap.ts";

const ENTRIES = [
  { type: "message", role: "user", text: "hello" },
  { type: "message", role: "assistant", text: "hi" },
];

describe("instant snap", () => {
  it("builds a snap with metadata and full entries", () => {
    const { meta, payload } = buildSnap(ENTRIES, "threshold", 1_700_000_000_000);
    expect(meta.reason).toBe("threshold");
    expect(meta.entries).toBe(2);
    expect(meta.file).toMatch(/^snap-.*\.json$/);
    const parsed = JSON.parse(payload);
    expect(parsed.snap.createdAt).toBe(1_700_000_000_000);
    expect(parsed.entries).toHaveLength(2);
  });

  it("writes snaps into .steak-pi/snaps and lists newest first", () => {
    
    const cwd = process.cwd();
    
    
    const first = buildSnap(ENTRIES, "manual", 1000);
    const second = buildSnap(ENTRIES, "overflow", 2000);
    writeSnap(cwd, first.payload, first.meta.file);
    writeSnap(cwd, second.payload, second.meta.file);
    const snaps = listSnaps(cwd);
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(snaps[0].createdAt).toBeGreaterThanOrEqual(snaps[1].createdAt);
    expect(snapFileName(1000)).toMatch(/^snap-.*\.json$/);
  });
});

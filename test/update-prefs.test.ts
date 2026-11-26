import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentConfigPath, clearUpdatePrefs, isNoticeDue, markNoticeShown, readUpdatePrefs, recordAutoError, setAutoUpdate, skipVersion } from "../src/update-prefs.ts";

const config = () => join(mkdtempSync(join(tmpdir(), "steak-update-prefs-")), "steak-pi.json");
const state = (latest?: string) => ({ available: !!latest, latest });
const DAY = 24 * 60 * 60 * 1000;

describe("update preferences in steak-pi.json", () => {
  it("defaults to checks on and automatic updates off", () => {
    const path = config();
    expect(readUpdatePrefs(path)).toMatchObject({ checks: true, auto: false });
    expect(isNoticeDue(state("1.2.3"), readUpdatePrefs(path), 1_000)).toBe(true);
    expect(isNoticeDue(state(undefined), readUpdatePrefs(path), 1_000)).toBe(false);
  });

  it("persists auto on/off, remembers the answer and preserves other settings", () => {
    const path = config();
    writeFileSync(path, JSON.stringify({ theme: "keep", unrelated: { a: 1 } }));
    expect(setAutoUpdate(true, path).auto).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ theme: "keep", unrelated: { a: 1 }, updates: { auto: true, autoAsked: true } });
    expect(setAutoUpdate(false, path)).toMatchObject({ auto: false, autoAsked: true }); // "no" is never asked again
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("skips one version until a newer one; a notice is due at most once per 24 hours per version", () => {
    const path = config();
    skipVersion("1.2.3", path);
    expect(isNoticeDue(state("1.2.3"), readUpdatePrefs(path), 1_000)).toBe(false);
    expect(isNoticeDue(state("1.2.4"), readUpdatePrefs(path), 1_000)).toBe(true);
    markNoticeShown("1.2.4", path, 1_000);
    expect(isNoticeDue(state("1.2.4"), readUpdatePrefs(path), 1_000 + DAY - 1)).toBe(false);
    expect(isNoticeDue(state("1.2.4"), readUpdatePrefs(path), 1_000 + DAY)).toBe(true);
    expect(isNoticeDue(state("1.2.5"), readUpdatePrefs(path), 2_000)).toBe(true);
  });

  it("records the cause of a failed automatic install; turning auto on clears it", () => {
    const path = config();
    recordAutoError("download failed", path);
    expect(readUpdatePrefs(path).autoError).toBe("download failed");
    expect(setAutoUpdate(true, path).autoError).toBeUndefined();
  });

  it("never overwrites a malformed settings file and names the cause", () => {
    const path = config();
    writeFileSync(path, "{not json");
    expect(readUpdatePrefs(path)).toMatchObject({ auto: false, error: expect.stringMatching(/is not valid JSON/) });
    expect(() => setAutoUpdate(true, path)).toThrow(/cannot update/);
    expect(readFileSync(path, "utf8")).toBe("{not json");
    writeFileSync(path, JSON.stringify({ updates: [] }));
    expect(readUpdatePrefs(path).error).toMatch(/must be an object/);
  });

  it("uninstall drops the updates section, and the file when nothing else is in it", () => {
    const shared = config();
    writeFileSync(shared, JSON.stringify({ theme: "keep", updates: { auto: true } }));
    clearUpdatePrefs(shared);
    expect(JSON.parse(readFileSync(shared, "utf8"))).toEqual({ theme: "keep" });
    const own = config();
    setAutoUpdate(true, own);
    clearUpdatePrefs(own);
    expect(() => statSync(own)).toThrow();
  });

  it("honours PI_CODING_AGENT_DIR", () => {
    expect(agentConfigPath({ PI_CODING_AGENT_DIR: "/x/agent" })).toBe(join("/x/agent", "steak-pi.json"));
  });
});

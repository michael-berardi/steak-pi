import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkForUpdate, isNewer, updateCheckDisabled } from "../src/update-check.ts";
import { noticeText } from "../extensions/update-notice.ts";

const cachePath = () => join(mkdtempSync(join(tmpdir(), "steak-update-")), "update-check.json");
const reply = (tag: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify({ tag_name: tag }), { status }));

describe("update check", () => {
  it("compares stable x.y.z versions numerically", () => {
    expect(isNewer("0.17.0", "0.16.0")).toBe(true);
    expect(isNewer("v0.16.10", "0.16.9")).toBe(true);
    expect(isNewer("0.16.0", "0.16.0")).toBe(false);
    expect(isNewer("0.15.9", "0.16.0")).toBe(false);
    expect(isNewer("1.0.0-rc.1", "0.16.0")).toBe(false);
    expect(isNewer(undefined, "0.16.0")).toBe(false);
  });

  it("reports a newer release and caches the answer for every session", async () => {
    const path = cachePath(), fetchImpl = reply("v0.17.0");
    const state = await checkForUpdate("0.16.0", { now: 1_000, cachePath: path, fetchImpl });
    expect(state).toMatchObject({ current: "0.16.0", latest: "0.17.0", available: true });
    expect(noticeText(state)).toBe("Steak Pi 0.17.0 available (you have 0.16.0) · /steak-update");
    // A second session inside the interval makes no request.
    await checkForUpdate("0.16.0", { now: 2_000, cachePath: path, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ latest: "0.17.0" });
  });

  it("checks again once the interval has passed, and force skips the cache", async () => {
    const path = cachePath(), fetchImpl = reply("v0.16.0");
    await checkForUpdate("0.16.0", { now: 0, cachePath: path, fetchImpl, intervalMs: 100 });
    await checkForUpdate("0.16.0", { now: 150, cachePath: path, fetchImpl, intervalMs: 100 });
    await checkForUpdate("0.16.0", { now: 160, cachePath: path, fetchImpl, intervalMs: 100, force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("shows nothing when up to date", async () => {
    const state = await checkForUpdate("0.16.0", { cachePath: cachePath(), fetchImpl: reply("v0.16.0") });
    expect(state.available).toBe(false);
    expect(noticeText(state)).toBeUndefined();
  });

  it("names a failed check and keeps an update it already found", async () => {
    const path = cachePath();
    writeFileSync(path, JSON.stringify({ checkedAt: 0, latest: "0.17.0" }));
    const state = await checkForUpdate("0.16.0", { now: 10 ** 12, cachePath: path, fetchImpl: reply(null, 503) });
    expect(state.error).toBe("GitHub releases answered HTTP 503");
    expect(state).toMatchObject({ latest: "0.17.0", available: true });
  });

  it("refuses a tag that is not a stable version", async () => {
    const state = await checkForUpdate("0.16.0", { cachePath: cachePath(), fetchImpl: reply("nightly") });
    expect(state.error).toMatch(/no x\.y\.z tag/);
    expect(state.available).toBe(false);
  });

  it("can be turned off", () => {
    expect(updateCheckDisabled({ STEAK_PI_NO_UPDATE_CHECK: "1" })).toBe(true);
    expect(updateCheckDisabled({ CI: "true" })).toBe(true);
    expect(updateCheckDisabled({})).toBe(false);
  });
});

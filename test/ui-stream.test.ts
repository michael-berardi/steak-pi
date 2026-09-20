import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assistantText, createUiStream } from "../src/ui-stream.ts";
import type { PrimaryHostIdentity } from "../src/primary-host.ts";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const message = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", arguments: { secret: "private" } }, { type: "text", text }] });
function harness() {
  vi.useFakeTimers();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ui-stream-test-"))); roots.push(root);
  const directory = join(root, "streams"), path = join(directory, `${process.pid}.json`);
  let host: PrimaryHostIdentity | undefined = { version: 1, pid: process.pid, sessionId: "s1", generation: "g1", sessionFile: "/s1.jsonl" };
  const entries: unknown[] = [];
  const appendEntry = vi.fn((type: string, data: unknown) => { expect(existsSync(path)).toBe(false); entries.push({ type, data }); });
  const stream = createUiStream({ appendEntry }, () => host, directory);
  const ctx = { sessionManager: {} } as any;
  return { stream, ctx, path, root, directory, entries, appendEntry, revoke: () => { host = undefined; }, read: () => JSON.parse(readFileSync(path, "utf8")) };
}
describe("live assistant sidecar", () => {
  it("publishes before message_end, with a preceding stable marker and private atomic files", () => {
    const h = harness(); h.stream.start(message(""), h.ctx);
    const id = h.read().streamId;
    expect(h.entries).toEqual([{ type: "ultraterm.ui.stream.start", data: { streamId: id } }]);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    h.stream.update(message("live")); vi.advanceTimersByTime(99);
    expect(h.read().text).toBe(""); vi.advanceTimersByTime(1);
    expect(h.read()).toMatchObject({ version: 1, pid: process.pid, sessionId: "s1", generation: "g1", text: "live", final: false, streamId: id, updatedAt: Date.now() });
    h.stream.update(message("complete"), true); h.stream.end(); vi.advanceTimersByTime(100);
    expect(h.read()).toMatchObject({ text: "complete", final: true, streamId: id });
    expect(statSync(h.directory).mode & 0o777).toBe(0o700);
    expect(statSync(h.path).mode & 0o777).toBe(0o600);
    h.stream.reset(); expect(existsSync(h.path)).toBe(false);
  });
  it("expires completed sidecars without deleting a later active stream", () => {
    const h = harness(); h.stream.start(message("done"), h.ctx); h.stream.end();
    vi.advanceTimersByTime(2000); expect(existsSync(h.path)).toBe(false);
    h.stream.start(message("first"), h.ctx); h.stream.end();
    vi.advanceTimersByTime(1000); h.stream.start(message("second"), h.ctx);
    vi.advanceTimersByTime(1100); expect(h.read().text).toBe("second");
    h.stream.reset(); expect(vi.getTimerCount()).toBe(0);
  });
  it("coalesces updates, clears revoked identities and cancels timers", () => {
    const h = harness(); h.stream.start(message(""), h.ctx);
    for (let i = 0; i < 500; i++) h.stream.update(message(String(i)));
    expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(100);
    expect(h.read().text).toBe("499");
    h.stream.update(message("revoked")); h.revoke(); vi.advanceTimersByTime(100);
    expect(existsSync(h.path)).toBe(false); expect(vi.getTimerCount()).toBe(0);
    h.stream.start(message("unmanaged"), h.ctx); expect(h.appendEntry).toHaveBeenCalledTimes(1);
  });
  it("excludes non-text blocks and bounds both UTF-8 text and escaped JSON", () => {
    expect(assistantText({ role: "toolResult", content: [{ type: "text", text: "secret" }] })).toBeUndefined();
    const text = assistantText(message("😀".repeat(100000)))!;
    expect(Buffer.byteLength(text)).toBe(128 * 1024); expect(text.endsWith("😀")).toBe(true);
    const h = harness(); h.stream.start(message("\u0000".repeat(200000)), h.ctx);
    expect(statSync(h.path).size).toBeLessThanOrEqual(256 * 1024);
    expect(Buffer.byteLength(h.read().text)).toBeLessThanOrEqual(128 * 1024);
    expect(readFileSync(h.path, "utf8")).not.toContain("private"); h.stream.reset();
  });
  it("does not delete a replacement stream or follow a sidecar symlink", () => {
    const h = harness(); h.stream.start(message("owned"), h.ctx);
    const other = { ...h.read(), streamId: "replacement" };
    writeFileSync(h.path, JSON.stringify(other)); h.stream.reset();
    expect(h.read().streamId).toBe("replacement");
    rmSync(h.path); const target = join(h.root, "target"); writeFileSync(target, "untouched"); symlinkSync(target, h.path);
    h.appendEntry.mockImplementation(() => {});
    expect(() => h.stream.start(message("unsafe"), h.ctx)).not.toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched"); h.stream.reset();
  });
  it("swallows marker failures and creates no sidecar", () => {
    const h = harness(); h.appendEntry.mockImplementation(() => { throw new Error("disk unavailable"); });
    expect(() => h.stream.start(message("hello"), h.ctx)).not.toThrow();
    expect(existsSync(h.path)).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { verificationTreeHash } from "../verify-after-edit.ts";

test("tree hash includes untracked content, ignores ignored files, and does not follow symlinks", () => {
  const cwd = mkdtempSync(join(tmpdir(), "steak-receipt-"));
  try {
    execFileSync("git", ["init", "--quiet", cwd]);
    writeFileSync(join(cwd, ".gitignore"), "ignored\n");
    writeFileSync(join(cwd, "file"), "a");
    const first = verificationTreeHash(cwd);
    assert.match(first, /^[a-f0-9]{16}$/);
    writeFileSync(join(cwd, "ignored"), "ignored content");
    assert.equal(verificationTreeHash(cwd), first);
    writeFileSync(join(cwd, "file"), "b");
    assert.notEqual(verificationTreeHash(cwd), first);
    symlinkSync("ignored", join(cwd, "link"));
    const linked = verificationTreeHash(cwd);
    writeFileSync(join(cwd, "ignored"), "different ignored content");
    assert.equal(verificationTreeHash(cwd), linked);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("concurrent edits debounce as one batch and append a one-line success receipt", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "steak-receipt-"));
  try {
    mkdirSync(join(cwd, ".steak-pi"));
    writeFileSync(join(cwd, ".steak-pi/config.json"), JSON.stringify({ verify: { command: "printf x >> runs" } }));
    let handler!: (event: any, ctx: any) => Promise<any>;
    extension({ on(name: string, fn: typeof handler) { if (name === "tool_result") handler = fn; } } as unknown as ExtensionAPI);
    const event = { toolName: "edit", isError: false, content: [{ type: "text", text: "edited" }] };
    const ctx = { cwd, isProjectTrusted: () => true };
    const started = performance.now();
    const pending = handler(event, ctx);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await handler({ ...event, toolName: "write" }, ctx), undefined);
    const result = await pending;
    assert.ok(performance.now() - started >= 790);
    assert.equal(readFileSync(join(cwd, "runs"), "utf8"), "x");
    assert.deepEqual(result.content[0], event.content[0]);
    assert.match(result.content[1].text, /^\[steak-pi\] verify passed: printf x >> runs \| tree=unavailable \| \d+ms$/);
    // A sequential edit is a new batch, never skipped by a last-run throttle.
    await handler(event, ctx);
    assert.equal(readFileSync(join(cwd, "runs"), "utf8"), "xx");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

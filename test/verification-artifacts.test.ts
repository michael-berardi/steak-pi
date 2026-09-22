import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { beginVerification, MAX_CONSOLE_BYTES } from "../src/verification-artifacts.ts";
const roots: string[] = [];
const root = () => { const p = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "verification-artifacts-"))); roots.push(p); return p; };
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
it("retains raw bytes privately and rejects oversize output without false completeness", () => {
  const r = beginVerification(root());
  const bytes = Buffer.from([0xff, 0, 0xe2]);
  try {
    r.write("stderr", bytes);
    expect(fs.readFileSync(join(r.directory, "stderr.log"))).toEqual(bytes);
    expect(fs.statSync(join(r.directory, "stderr.log")).mode & 0o777).toBe(0o600);
    expect(() => r.write("stdout", Buffer.alloc(MAX_CONSOLE_BYTES + 1))).toThrow("output limit");
  } finally { r.finish({ failed: true, complete: false, exitCode: null }); }
  expect(JSON.parse(fs.readFileSync(join(r.directory, "result.json"), "utf8"))).toMatchObject({ failed: true, complete: false, finished: true, bytes: 3 });
});
it("evicts completed owned runs, preserves unrelated files, and never evicts active runs", () => {
  const p = root(); fs.writeFileSync(join(p, "keep.txt"), "unrelated");
  const active: ReturnType<typeof beginVerification>[] = [];
  try {
    for (let i = 0; i < 32; i++) active.push(beginVerification(p));
    expect(() => beginVerification(p)).toThrow("capacity");
    active[0].finish({ failed: false, complete: true, exitCode: 0 });
    const replacement = beginVerification(p); active.push(replacement);
    expect(fs.existsSync(active[0].directory)).toBe(false);
    expect(fs.readFileSync(join(p, "keep.txt"), "utf8")).toBe("unrelated");
    expect(fs.readdirSync(p).filter(n => n.startsWith("run-")).length).toBe(32);
  } finally { for (const r of active) r.finish({ failed: false, complete: true, exitCode: 0 }); }
});
it("rejects a symlink root without touching its destination contents", () => {
  const p = root(), target = root(); fs.symlinkSync(target, join(p, "link"));
  expect(() => beginVerification(join(p, "link"))).toThrow("unsafe");
  expect(fs.readdirSync(target)).toEqual([]);
});
it("serializes admission: a live owner fails closed and a dead owner's lock is recovered", () => {
  const p = root(), lock = join(p, ".admission-lock");
  fs.writeFileSync(lock, String(process.pid), { mode: 0o600 });
  expect(() => beginVerification(p)).toThrow("admission busy");
  expect(fs.readFileSync(lock, "utf8")).toBe(String(process.pid));
  fs.rmSync(lock);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  fs.writeFileSync(lock, String(dead.pid), { mode: 0o600 });
  const run = beginVerification(p);
  try {
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(run.directory)).toBe(true);
  } finally { run.finish({ failed: false, complete: true, exitCode: 0 }); }
});
it("rejects an oversized lock and evicts a finished run past its TTL below capacity", () => {
  const p = root();
  fs.writeFileSync(join(p, ".admission-lock"), "x".repeat(129), { mode: 0o600 });
  expect(() => beginVerification(p)).toThrow("invalid verification cache lock");
  fs.rmSync(join(p, ".admission-lock"));
  const stale = beginVerification(p);
  stale.finish({ failed: false, complete: true, exitCode: 0 });
  const past = new Date(Date.now() - 8 * 86400_000);
  fs.utimesSync(stale.directory, past, past);
  const fresh = beginVerification(p);
  try {
    expect(fs.existsSync(stale.directory)).toBe(false);
    expect(fs.existsSync(fresh.directory)).toBe(true);
  } finally { fresh.finish({ failed: false, complete: true, exitCode: 0 }); }
});

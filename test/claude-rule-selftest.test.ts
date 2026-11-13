import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertClaudeEscapesProven, proveClaudeEscapes } from "../src/subagents/claude-rule-selftest.ts";

/** A fake CLI: answers --version, asks the local fake Messages server what to write, applies a permission matcher
 * that either honours backslash escapes or ignores them (reading `[id]` as a character class), and writes the target. */
function fakeCli(mode: "honour" | "ignore" | "hang", version = "9.9.9 (Fake CLI)"): string {
  return `#!/usr/bin/env node
const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
fs.appendFileSync(__filename + ".log", "run\\n");
if (${JSON.stringify(mode)} === "hang") setInterval(() => {}, 1000);
else (async () => {
  const rule = args[args.indexOf("--allowedTools") + 1];
  const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: JSON.stringify({ messages: [] }) });
  const text = await res.text();
  const partial = /"partial_json":("(?:[^"\\\\]|\\\\.)*")/.exec(text);
  const target = JSON.parse(JSON.parse(partial[1])).file_path;
  const rawBody = rule.slice(5, -1).replace(/^\\//, "").replace(/\\/\\*\\*$/, "");
  let re = "";
  const body = ${JSON.stringify(mode)} === "ignore" ? rawBody.replace(/\\\\/g, "") : rawBody;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\\\" && ${JSON.stringify(mode)} === "honour") { re += (body[++i] || "").replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&"); continue; }
    if (c === "\\\\") continue;
    if (c === "[") { const end = body.indexOf("]", i); re += body.slice(i, end + 1); i = end; }
    else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
  }
  if (new RegExp("^" + re + "(/.*)?$").test(target)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "x"); }
  process.exit(0);
})();
`;
}

describe("claude escape self-test", () => {
  const dirs: string[] = [];
  const temp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "selftest-"))); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const install = (mode: "honour" | "ignore" | "hang", version?: string): { exe: string; cache: string } => {
    const dir = temp();
    const exe = join(dir, "fake-cli");
    writeFileSync(exe, fakeCli(mode, version));
    chmodSync(exe, 0o755);
    return { exe, cache: join(dir, "state", "cache.json") };
  };
  const bracket = ["/repo/src/app/[id]/route.ts"];

  it("pass: the dispatch is accepted and the verdict is cached privately", async () => {
    const { exe, cache } = install("honour");
    await expect(assertClaudeEscapesProven(bracket, exe, () => undefined, { workDir: dirname(cache), cachePath: cache })).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(cache, "utf8")).entries).toBeTypeOf("object");
    expect(statSync(cache).mode & 0o777).toBe(0o600);
    expect(statSync(join(cache, "..")).mode & 0o777).toBe(0o700);
    const entries = Object.values(JSON.parse(readFileSync(cache, "utf8")).entries as Record<string, { ok: boolean }>);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ok).toBe(true);
  }, 60_000);

  it("a CLI that reads \\[id\\] as a character class is refused with the named error", async () => {
    const { exe, cache } = install("ignore");
    const error = await assertClaudeEscapesProven(bracket, exe, () => undefined, { workDir: dirname(cache), cachePath: cache }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`claude-code owned path ${JSON.stringify(bracket[0])} needs an escaped permission rule, and this Claude Code CLI (9.9.9 (Fake CLI)) did not pass the escape self-test: `);
    expect(message).toMatch(/allowed a write the escaped rule should deny/);
    const again = await proveClaudeEscapes(exe, { workDir: dirname(cache), cachePath: cache });
    expect(again.ok).toBe(false);
  }, 60_000);

  it("a timeout is refused, and no child is left running", async () => {
    const { exe, cache } = install("hang");
    const started = Date.now();
    const error = await assertClaudeEscapesProven(bracket, exe, () => undefined, { workDir: dirname(cache), cachePath: cache, timeoutMs: 700 }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/did not pass the escape self-test: .*timed out/);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it("a missing CLI is refused", async () => {
    const error = await assertClaudeEscapesProven(bracket, join(temp(), "absent"), () => undefined, { cachePath: join(temp(), "c.json") }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/did not pass the escape self-test/);
  });

  it("a cache hit skips the run; a changed version or mtime reruns; a corrupt cache reruns", async () => {
    const { exe, cache } = install("honour");
    const runs = (path: string): number => (existsSync(`${path}.log`) ? readFileSync(`${path}.log`, "utf8").split("\n").filter(Boolean).length : 0);
    expect((await proveClaudeEscapes(exe, { workDir: dirname(cache), cachePath: cache })).ok).toBe(true);
    const first = runs(exe);
    expect(first).toBeGreaterThan(0);
    expect((await proveClaudeEscapes(exe, { workDir: dirname(cache), cachePath: cache })).ok).toBe(true);
    expect(runs(exe)).toBe(first); // cache hit: the CLI was not run again
    // A changed mtime is a different identity: rerun.
    const later = new Date(statSync(exe).mtimeMs + 5000);
    utimesSync(exe, later, later);
    expect((await proveClaudeEscapes(exe, { workDir: dirname(cache), cachePath: cache })).ok).toBe(true);
    expect(runs(exe)).toBe(first * 2);
    // A changed version is a different identity too.
    const other = install("honour", "10.0.0 (Fake CLI)");
    expect((await proveClaudeEscapes(other.exe, { workDir: dirname(cache), cachePath: cache })).ok).toBe(true);
    expect(runs(other.exe)).toBeGreaterThan(0);
    expect(Object.keys(JSON.parse(readFileSync(cache, "utf8")).entries).length).toBe(3);
    // Corrupt cache: not proven, rerun.
    const beforeCorrupt = runs(other.exe);
    writeFileSync(cache, "{not json");
    expect((await proveClaudeEscapes(other.exe, { workDir: dirname(cache), cachePath: cache })).ok).toBe(true);
    expect(runs(other.exe)).toBe(beforeCorrupt * 2);
  }, 120_000);

  it("a failed verdict is reused for 24 h and then retested", async () => {
    const { exe, cache } = install("ignore");
    let now = 1_000_000;
    expect((await proveClaudeEscapes(exe, { workDir: dirname(cache), cachePath: cache, now: () => now })).ok).toBe(false);
    const before = readFileSync(cache, "utf8");
    now += 23 * 3600_000;
    expect((await proveClaudeEscapes(exe, { workDir: dirname(cache), cachePath: cache, now: () => now })).ok).toBe(false);
    expect(readFileSync(cache, "utf8")).toBe(before);
    now += 2 * 3600_000;
    expect((await proveClaudeEscapes(exe, { workDir: dirname(cache), cachePath: cache, now: () => now })).ok).toBe(false);
    expect(readFileSync(cache, "utf8")).not.toBe(before);
  }, 120_000);

  it("a wave without escaped rules never runs the self-test", async () => {
    let calls = 0;
    const prove = async () => { calls += 1; return { ok: false, version: "x", cause: "should not run" }; };
    await assertClaudeEscapesProven(["/repo/src/a.ts", "/repo/my dir/b.ts"], "/nonexistent", () => undefined, { prove });
    expect(calls).toBe(0);
    await expect(assertClaudeEscapesProven(["/repo/a*b.ts"], "/nonexistent", () => undefined, { prove })).rejects.toThrow(/did not pass the escape self-test: should not run/);
    expect(calls).toBe(1);
  });

  it.skipIf(process.env.STEAK_PI_REAL_CLI_SELFTEST !== "1")("the real CLI honours the escapes (opt-in: STEAK_PI_REAL_CLI_SELFTEST=1, needs `claude` on PATH)", async () => {
    const cache = join(temp(), "cache.json");
    const verdict = await proveClaudeEscapes("claude", { cachePath: cache });
    console.log(`real CLI self-test: ${JSON.stringify(verdict)}`);
    expect(verdict.cause).toBeUndefined();
    expect(verdict.ok).toBe(true);
    expect(existsSync(cache)).toBe(true);
  }, 240_000);
});

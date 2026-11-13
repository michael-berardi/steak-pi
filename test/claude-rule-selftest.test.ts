import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertClaudeEscapesProven, assertClaudeRulesProven, proveClaudeEscapes, resolveClaudeExecutable } from "../src/subagents/claude-rule-selftest.ts";

/** The fake CLI's permission matcher, embedded into the fake CLI's source. `ignore` lists the escaped characters whose
 * backslash is ignored ("all" for every one); an unescaped character then keeps its pattern meaning: `[` opens a class,
 * `*` is a wildcard, `{a,b}` (with a comma) is a brace expansion, `+(a)` is an extglob, `!(a)` is a negation. */
function fakeMatch(rule: string, target: string, ignore: string): boolean {
  const body = rule.slice(5, -1).replace(/^\//, "").replace(/\/\*\*$/, "");
  const tokens: Array<{ ch: string; esc: boolean }> = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") { const n = body[++i] ?? ""; tokens.push({ ch: n, esc: !(ignore === "all" || ignore.includes(n)) }); } else tokens.push({ ch: body[i]!, esc: false });
  }
  const lit = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const find = (from: number, ch: string): number => { for (let j = from; j < tokens.length; j++) if (tokens[j]!.ch === ch && !tokens[j]!.esc) return j; return -1; };
  const text = (from: number, to: number): string => tokens.slice(from, to).map((t) => t.ch).join("");
  let re = "";
  for (let i = 0; i < tokens.length; i++) {
    const { ch, esc } = tokens[i]!;
    if (esc) { re += lit(ch); continue; }
    if (ch === "[" && find(i + 1, "]") > 0) { const end = find(i + 1, "]"); re += text(i, end + 1); i = end; continue; }
    if (ch === "*") { re += "[^/]*"; continue; }
    if (ch === "{" && find(i + 1, "}") > 0 && text(i, find(i + 1, "}")).includes(",")) { const end = find(i + 1, "}"); re += "(?:" + text(i + 1, end).split(",").map(lit).join("|") + ")"; i = end; continue; }
    if ((ch === "+" || ch === "!") && tokens[i + 1]?.ch === "(" && !tokens[i + 1]!.esc && find(i + 2, ")") > 0) {
      const end = find(i + 2, ")");
      re += ch === "+" ? "(?:" + lit(text(i + 2, end)) + ")+" : "(?!" + lit(text(i + 2, end)) + "(?:/|$))[^/]+";
      i = end; continue;
    }
    re += lit(ch);
  }
  return new RegExp("^" + re + "(/.*)?$").test(target);
}

/** A fake CLI: answers --version, asks the local fake Messages server what to write, applies a permission matcher
 * that either honours backslash escapes or ignores them (all, or exactly one kind), and writes the target. `slow`
 * honours them but takes about 0.4 s per run. `requireName` makes it a shim: it exits 1 unless started under that name. */
type Mode = "honour" | "ignore" | "ignore-braces" | "ignore-plus-paren" | "slow" | "hang" | "crash" | "noresult" | "silent" | "grandchild";
const IGNORED: Partial<Record<Mode, string>> = { ignore: "all", "ignore-braces": "{}", "ignore-plus-paren": "()" };
function fakeCli(mode: Mode, version = "9.9.9 (Fake CLI)", requireName?: string): string {
  return `#!/usr/bin/env node
const fs = require("node:fs"); const path = require("node:path");
const args = process.argv.slice(2);
if (${JSON.stringify(requireName ?? null)} !== null && path.basename(process.argv[1]) !== ${JSON.stringify(requireName ?? null)}) { console.error("invoked under the wrong name"); process.exit(1); }
if (args[0] === "--version") { console.log(${JSON.stringify(version)}); process.exit(0); }
fs.appendFileSync(__filename + ".log", "run\\n");
fs.writeFileSync(__filename + ".env", JSON.stringify(["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_AUTOUPDATER", "DISABLE_ERROR_REPORTING", "ANTHROPIC_API_KEY"].map((k) => [k, process.env[k]])));
const fakeMatch = ${fakeMatch.toString()};
if (${JSON.stringify(mode)} === "hang" || ${JSON.stringify(mode)} === "grandchild") {
  fs.writeFileSync(__filename + ".pid", String(process.pid));
  if (${JSON.stringify(mode)} === "grandchild") require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 9000)"], { detached: true, stdio: ["ignore", "inherit", "ignore"] }).unref();
  setInterval(() => {}, 1000);
} else if (${JSON.stringify(mode)} === "silent") process.exit(0);
else (async () => {
  if (${JSON.stringify(mode)} === "slow") await new Promise((r) => setTimeout(r, 400));
  const rule = args[args.indexOf("--allowedTools") + 1];
  fs.appendFileSync(__filename + ".rules", rule + "\\n");
  const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: JSON.stringify({ messages: [] }) });
  const text = await res.text();
  const partial = /"partial_json":("(?:[^"\\\\]|\\\\.)*")/.exec(text);
  const target = JSON.parse(JSON.parse(partial[1])).file_path;
  if (fakeMatch(rule, target, ${JSON.stringify(IGNORED[mode] ?? "")})) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "x"); }
  if (${JSON.stringify(mode)} !== "noresult") await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] }] }) }).then((r) => r.text());
  process.exit(${JSON.stringify(mode)} === "crash" ? 1 : 0);
})();
`;
}

describe("claude escape self-test", () => {
  const dirs: string[] = [];
  const temp = (): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), "selftest-"))); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const install = (mode: Mode, version?: string): { exe: string; cache: string } => {
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

  const prove = (exe: string, cache: string, extra: Record<string, unknown> = {}) => proveClaudeEscapes(exe, { workDir: dirname(cache), cachePath: cache, ...extra });

  it("a CLI that exits 1 (even after honouring the rule) or never reports a tool result is not proven", async () => {
    for (const mode of ["crash", "noresult", "silent"] as const) {
      const { exe, cache } = install(mode);
      const verdict = await prove(exe, cache);
      expect(verdict.ok, mode).toBe(false);
      expect(verdict.cause, mode).toMatch(/could not run/);
      const error = await assertClaudeEscapesProven(bracket, exe, () => undefined, { workDir: dirname(cache), cachePath: cache }).catch((e: Error) => e);
      expect((error as Error).message, mode).toMatch(/did not pass the escape self-test: .*could not run/);
    }
  }, 120_000);

  it("a deny case alone never passes on a crash: the first deny case is refused with a clean exit and a tool result required", async () => {
    const { exe, cache } = install("crash");
    expect((await prove(exe, cache)).cause).toMatch(/exited with code 1/);
    const none = install("noresult");
    expect((await prove(none.exe, none.cache)).cause).toMatch(/never reported a tool result/);
  }, 60_000);

  it("proves each escaped character class on its own (12 cases, brace, paren, exclamation and exact-file included)", async () => {
    const { exe, cache } = install("honour");
    expect((await prove(exe, cache)).ok).toBe(true);
    const runs = readFileSync(`${exe}.log`, "utf8").split("\n").filter(Boolean).length;
    expect(runs).toBe(12);
  }, 120_000);

  it("the self-test environment is quiet and private", async () => {
    const { exe, cache } = install("honour");
    await prove(exe, cache);
    const seen = Object.fromEntries(JSON.parse(readFileSync(`${exe}.env`, "utf8")) as Array<[string, string]>);
    expect(seen).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1", ANTHROPIC_API_KEY: "sk-fake-escape-selftest-key" });
  }, 60_000);

  it("a grandchild holding stdout open cannot hang the self-test; a later call is not blocked", async () => {
    const { exe, cache } = install("grandchild");
    const started = Date.now();
    const verdict = await prove(exe, cache, { timeoutMs: 700 });
    expect(verdict.ok).toBe(false);
    expect(verdict.cause).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(7_000);
    const second = install("honour");
    expect((await prove(second.exe, second.cache)).ok).toBe(true);
  }, 60_000);

  it("an abort stops the run: child killed, temp dirs removed, not proven, nothing cached", async () => {
    const { exe, cache } = install("hang");
    const controller = new AbortController();
    const started = Date.now();
    const pending = prove(exe, cache, { signal: controller.signal });
    await vi.waitFor(() => expect(existsSync(`${exe}.pid`)).toBe(true), { timeout: 15_000 });
    controller.abort();
    const verdict = await pending;
    expect(verdict.ok).toBe(false);
    expect(verdict.cause).toMatch(/cancelled/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(existsSync(cache)).toBe(false);
    expect(readdirSync(dirname(cache)).filter((n) => n.startsWith("escape-selftest-"))).toEqual([]);
    const pid = Number(readFileSync(`${exe}.pid`, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    // The abort was not cached: the same CLI, not aborted, is still tested (and refused for hanging).
    expect((await prove(exe, cache, { timeoutMs: 500 })).cause).toMatch(/timed out/);
    // An already-aborted signal never starts anything.
    const done = new AbortController(); done.abort();
    expect((await prove(exe, cache, { signal: done.signal })).cause).toMatch(/cancelled/);
  }, 90_000);

  it("proveClaudeEscapes never throws", async () => {
    const verdict = await proveClaudeEscapes(join(temp(), "absent"), { cachePath: join(temp(), "x", "\0bad") });
    expect(verdict.ok).toBe(false);
  });

  it("resolves a command to the absolute PATH candidate as found (its real path must be a file) on the given environment's PATH", () => {
    const dir = temp();
    const real = join(dir, "real-cli");
    writeFileSync(real, "#!/bin/sh\n"); chmodSync(real, 0o755);
    mkdirSync(join(dir, "bin"));
    symlinkSync(real, join(dir, "bin", "tool"));
    expect(resolveClaudeExecutable("tool", { PATH: join(dir, "bin") })).toBe(join(dir, "bin", "tool"));
    expect(resolveClaudeExecutable("tool", { PATH: join(dir, "elsewhere") })).toBeUndefined();
    expect(resolveClaudeExecutable("tool", {})).toBeUndefined();
    expect(resolveClaudeExecutable(join(dir, "bin", "tool"))).toBe(join(dir, "bin", "tool"));
    expect(resolveClaudeExecutable(real)).toBe(real);
    mkdirSync(join(dir, "bin", "adir"));
    expect(resolveClaudeExecutable("adir", { PATH: join(dir, "bin") })).toBeUndefined(); // a directory is not an executable file
    symlinkSync(join(dir, "gone"), join(dir, "bin", "dangling"));
    expect(resolveClaudeExecutable("dangling", { PATH: join(dir, "bin") })).toBeUndefined();
    expect(resolveClaudeExecutable(join(dir, "nope"))).toBeUndefined();
  });

  it("is judged from the emitted rules: a backslash requires the proof; none does not; skip is explicit", async () => {
    let calls = 0;
    const proveSeam = async () => { calls += 1; return { ok: false, version: "x", cause: "refused" }; };
    await assertClaudeRulesProven(["Edit(//repo/a)", "Edit(//repo/a/**)"], "/nonexistent", { prove: proveSeam });
    expect(calls).toBe(0);
    await expect(assertClaudeRulesProven(["Edit(//repo/a\\[1\\])"], "/nonexistent", { prove: proveSeam })).rejects.toThrow(/did not pass the escape self-test: refused/);
    await expect(assertClaudeRulesProven(["Edit(//repo/a\\[1\\])"], undefined, { prove: proveSeam })).rejects.toThrow(/not found/);
    expect(calls).toBe(1);
    await expect(assertClaudeRulesProven(["Edit(//repo/a\\[1\\])"], "/nonexistent", { prove: proveSeam, skip: true })).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  const runLog = (exe: string): number => (existsSync(`${exe}.log`) ? readFileSync(`${exe}.log`, "utf8").split("\n").filter(Boolean).length : 0);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("M1: when the first caller aborts, a live joiner still ends with a real verdict (the retry loop)", async () => {
    const { exe, cache } = install("slow");
    const first = new AbortController();
    const owner = prove(exe, cache, { signal: first.signal });
    await vi.waitFor(() => expect(runLog(exe)).toBeGreaterThan(0), { timeout: 15_000 });
    const joiner = prove(exe, cache, { signal: new AbortController().signal });
    await sleep(700);
    first.abort();
    expect((await owner).cause).toMatch(/cancelled/);
    const verdict = await joiner;
    expect(verdict.cause).toBeUndefined();
    expect(verdict.ok).toBe(true);
  }, 120_000);

  it("M1: a joiner that aborts returns cancelled at once while the owner still gets its real verdict, and no listener leaks", async () => {
    const { exe, cache } = install("slow");
    const owner = prove(exe, cache, { signal: new AbortController().signal });
    await vi.waitFor(() => expect(runLog(exe)).toBeGreaterThan(0), { timeout: 15_000 });
    const second = new AbortController();
    const add = vi.spyOn(second.signal, "addEventListener");
    const remove = vi.spyOn(second.signal, "removeEventListener");
    const joined = prove(exe, cache, { signal: second.signal });
    await sleep(700);
    const started = Date.now();
    second.abort();
    const cancelled = await joined;
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(cancelled.ok).toBe(false);
    expect(cancelled.cause).toMatch(/cancelled/);
    const verdict = await owner;
    expect(verdict.cause).toBeUndefined();
    expect(verdict.ok).toBe(true);
    // Every listener the joiner added to its own signal is gone again.
    const added = add.mock.calls.filter((c) => c[0] === "abort").length;
    const removed = remove.mock.calls.filter((c) => c[0] === "abort").length;
    expect(removed).toBeGreaterThanOrEqual(added);
  }, 120_000);

  it("M1: a joiner that finishes normally leaves no abort listener behind", async () => {
    const { exe, cache } = install("slow");
    const owner = prove(exe, cache);
    await vi.waitFor(() => expect(runLog(exe)).toBeGreaterThan(0), { timeout: 15_000 });
    const live = new AbortController();
    const add = vi.spyOn(live.signal, "addEventListener");
    const remove = vi.spyOn(live.signal, "removeEventListener");
    expect((await prove(exe, cache, { signal: live.signal })).ok).toBe(true);
    expect((await owner).ok).toBe(true);
    expect(remove.mock.calls.filter((c) => c[0] === "abort").length).toBeGreaterThanOrEqual(add.mock.calls.filter((c) => c[0] === "abort").length);
  }, 120_000);

  it("M2: a shim that dispatches on its own name is proven through the link and launched by the link path", async () => {
    const dir = temp();
    const real = join(dir, "multiplexer");
    writeFileSync(real, fakeCli("honour", "9.9.9 (Fake CLI)", "claude-shim"));
    chmodSync(real, 0o755);
    mkdirSync(join(dir, "bin"));
    const link = join(dir, "bin", "claude-shim");
    symlinkSync(real, link);
    const env = { PATH: join(dir, "bin") };
    const resolved = resolveClaudeExecutable("claude-shim", env);
    expect(resolved).toBe(link);
    const cache = join(dir, "state", "cache.json");
    const verdict = await prove(resolved!, cache);
    expect(verdict.cause).toBeUndefined();
    expect(verdict.ok).toBe(true);
    expect(runLog(real)).toBe(12);
    // The bare command name goes through the same resolution, and the real path (a different name) is refused by the shim.
    expect((await prove("claude-shim", cache, { env })).ok).toBe(true);
    expect((await prove(real, join(dir, "state", "other.json"))).ok).toBe(false);
    // The cache identity is the real path, its mtime and size, plus the version: two link names share one entry.
    expect(Object.keys(JSON.parse(readFileSync(cache, "utf8")).entries)).toHaveLength(1);
  }, 120_000);

  it("M4: an unresolvable command is not proven, and never falls back to the bare name", async () => {
    const dir = temp();
    const exe = join(dir, "bare-fake-cli");
    writeFileSync(exe, fakeCli("honour")); chmodSync(exe, 0o755);
    vi.stubEnv("PATH", `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`);
    try {
      const cache = join(dir, "state", "cache.json");
      const verdict = await prove("bare-fake-cli", cache, { env: { PATH: join(dir, "elsewhere") } });
      expect(verdict.ok).toBe(false);
      expect(verdict.cause).toBe("the Claude Code CLI was not found");
      expect(runLog(exe)).toBe(0);
      expect(existsSync(cache)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);

  it("M5: an inconclusive failure is reused for 10 minutes and then re-run; a conclusive one for 24 hours", async () => {
    for (const mode of ["crash", "hang"] as const) {
      const { exe, cache } = install(mode);
      let now = 1_000_000;
      const run = () => prove(exe, cache, { now: () => now, timeoutMs: 700 });
      expect((await run()).ok, mode).toBe(false);
      expect(runLog(exe), mode).toBe(1);
      now += 9 * 60_000;
      expect((await run()).ok, mode).toBe(false);
      expect(runLog(exe), `${mode} reused at 9 minutes`).toBe(1);
      now += 2 * 60_000;
      expect((await run()).ok, mode).toBe(false);
      expect(runLog(exe), `${mode} re-run at 11 minutes`).toBe(2);
    }
    const { exe, cache } = install("ignore");
    let now = 1_000_000;
    const run = () => prove(exe, cache, { now: () => now });
    expect((await run()).ok).toBe(false);
    const first = runLog(exe);
    now += 23 * 3600_000;
    expect((await run()).ok).toBe(false);
    expect(runLog(exe), "reused at 23 hours").toBe(first);
    now += 2 * 3600_000;
    expect((await run()).ok).toBe(false);
    expect(runLog(exe), "re-run at 25 hours").toBeGreaterThan(first);
  }, 120_000);

  it("T3: a CLI that ignores exactly one escape is refused naming that case", async () => {
    const braces = install("ignore-braces");
    const b = await prove(braces.exe, braces.cache);
    expect(b.ok).toBe(false);
    expect(b.cause).toMatch(/the check "braces stays denied" failed: the CLI allowed a write/);
    const paren = install("ignore-plus-paren");
    const p = await prove(paren.exe, paren.cache);
    expect(p.ok).toBe(false);
    expect(p.cause).toMatch(/the check "parentheses with a leading plus stays denied" failed: the CLI allowed a write/);
  }, 120_000);

  it("M3: the exclamation pair uses a rule where an unescaped ! would change the match", async () => {
    const { exe, cache } = install("honour");
    expect((await prove(exe, cache)).ok).toBe(true);
    const seen = readFileSync(`${exe}.log`, "utf8").split("\n").filter(Boolean).length;
    expect(seen).toBe(12);
    expect(readFileSync(`${exe}.rules`, "utf8")).toMatch(/Edit\(\/\/.*\/T\/\\!\\\(a\\\)\/\*\*\)/);
    // The fake treats an unescaped `!(a)` as a negation: written as a plain rule it would allow `b/f.txt` and refuse `a/f.txt`.
    const dir = temp();
    const body = `Edit(/${dir}/!(a)/**)`;
    const escaped = `Edit(/${dir}/\\!\\(a\\)/**)`;
    const fn = new Function("rule", "target", "ignore", `return (${fakeMatch.toString()})(rule, target, ignore)`) as (r: string, t: string, i: string) => boolean;
    expect(fn(body, `${dir}/b/f.txt`, "")).toBe(true);
    expect(fn(body, `${dir}/a/f.txt`, "")).toBe(false);
    expect(fn(escaped, `${dir}/b/f.txt`, "")).toBe(false);
    expect(fn(escaped, `${dir}/!(a)/f.txt`, "")).toBe(true);
  }, 120_000);

  it.skipIf(process.env.STEAK_PI_REAL_CLI_SELFTEST !== "1")("the real CLI honours the escapes (opt-in: STEAK_PI_REAL_CLI_SELFTEST=1, needs `claude` on PATH)", async () => {
    const cache = join(temp(), "cache.json");
    const verdict = await proveClaudeEscapes("claude", { cachePath: cache, ...(process.env.STEAK_PI_REAL_CLI_WORKDIR ? { workDir: process.env.STEAK_PI_REAL_CLI_WORKDIR } : {}) });
    console.log(`real CLI self-test: ${JSON.stringify(verdict)}`);
    expect(verdict.cause).toBeUndefined();
    expect(verdict.ok).toBe(true);
    expect(existsSync(cache)).toBe(true);
  }, 240_000);
});

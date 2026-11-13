// steak-dsh worker runner against a FAKE steak-dsh CLI: a script the test writes into a temp dir and
// points the runner at (the STEAK_DSH_BIN seam). The script records argv and environment NAMES (never
// values) and prints canned NDJSON. No network, no real model, no real harness.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createDshWorkerRunner, dshUsage, dshWorkerArgs, dshWorkerEnv, parseDshStreamLine,
  type DshSpawnHandle, type DshWorkerRunnerOptions, dshEffortArgs, dshWritableRoots, classifyDshWorkerState } from "../src/subagents/dsh-worker.ts";
import { DSH_KEY_ENV } from "../src/subagents/dsh-routes.ts";
import { workerJournal } from "../src/subagents/coordinator.ts";
import { isQuotaLaunchFailure } from "../src/subagents/provider-quota.ts";
import { emptyUsage, USAP_VERSION, type RunRecord, type TaskRecord, type WorkerProgress } from "../src/subagents/types.ts";

type Model = NonNullable<ExtensionContext["model"]>;
const dir = mkdtempSync(join(tmpdir(), "steak-pi-dsh-worker-"));
const cwdDir = join(dir, "cwd");
mkdirSync(cwdDir);
let files = 0;
const spawnedPids: number[] = [];
afterAll(() => {
  for (const pid of spawnedPids) { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "sk-test-DO-NOT-LOG-1234567890abcdef";
const testModel = {
  provider: "alpha-p", id: "alpha-model", name: "alpha-model", api: "openai-completions",
  baseUrl: "https://alpha-p.example/v1", input: ["text"], contextWindow: 100_000, maxTokens: 8_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0.6 },
  compat: { supportsDeveloperRole: false },
  reasoning: true,
} as unknown as Model;

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: USAP_VERSION, id: "run-dsh-test", goal: "Inspect the leaf", constraints: ["No writes"],
    cwd: cwdDir, model: "steak-dsh/alpha-p/alpha-model", harness: "steak-dsh", thinkingLevel: "medium",
    concurrency: 1, timeoutMs: 60_000, maxTurns: 8, background: false, state: "running",
    createdAt: 0, tasks: [], usage: emptyUsage(), ...overrides,
  };
}
function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "run-dsh-test-task-1", label: "Inspect", task: "Report the routing entrypoint", role: "scout",
    mayEdit: false, ownedPaths: [], allowBash: false, state: "running", output: "",
    turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, ...overrides,
  };
}

/** Write the fake CLI. The scenario body runs once stdin (the leaf prompt) has been fully read. */
function fakeCli(body: string): { cli: string; record: string } {
  const record = join(dir, `record-${++files}.json`);
  const cli = join(dir, `fake-steak-dsh-${files}.cjs`);
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require("node:fs");
const record = ${JSON.stringify(record)};
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  const key = process.env.STEAK_DSH_ROUTE_KEY;
  fs.writeFileSync(record, JSON.stringify({
    argv: process.argv.slice(2), envNames: Object.keys(process.env),
    keyPresent: typeof key === "string" && key.length > 0,
    stdinHasPrompt: stdin.includes("UltraTerm Subagent Protocol"), pid: process.pid,
  }));
  const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
  ${body}
});
`);
  chmodSync(cli, 0o755);
  return { cli, record };
}

const SUCCESS_BODY = `
out({type:"session",sessionId:"s-1",cwd:process.cwd()});
out({type:"status",phase:"turn_start",turn:1});
out({type:"status",phase:"step_start",turn:1,step:1});
out({type:"thinking",text:"thinking about the leaf"});
out({type:"tool_call",callId:"c1",tool:"edit",input:{file_path:"allowed/a.txt"}});
out({type:"tool_result",callId:"c1",status:"completed",result:"ok"});
out({type:"status",phase:"step_end",turn:1,step:1,usage:{inputTokens:1000,outputTokens:100,cacheReadTokens:200,cacheWriteTokens:50,totalTokens:1350}});
out({type:"status",phase:"step_start",turn:1,step:2});
out({type:"text",text:"interim text"});
out({type:"status",phase:"step_end",turn:1,step:2,usage:{inputTokens:500,outputTokens:50,totalTokens:550}});
out({type:"status",phase:"turn_end",turn:1});
out({type:"final",sessionId:"s-1",reason:{kind:"completed"},text:"Evidence: done\\nChanged paths: allowed/a.txt"});
process.exit(0);
`;

function runnerFor(cli: string, over: Partial<DshWorkerRunnerOptions> = {}) {
  return createDshWorkerRunner({
    executable: cli,
    abortGraceMs: 100,
    resolveRuntime: () => ({
      model: testModel, thinkingLevel: "medium",
      dsh: { resolveAuth: async () => ({ ok: true as const, apiKey: KEY }), isUsingOAuth: () => false },
    }),
    ...over,
  });
}
const readRecord = (record: string) => JSON.parse(readFileSync(record, "utf8")) as {
  argv: string[]; envNames: string[]; keyPresent: boolean; stdinHasPrompt: boolean; pid: number;
};
const argValue = (argv: string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag);
  return at < 0 ? undefined : argv[at + 1];
};

describe("NDJSON parsing", () => {
  it("parses every contract event and fails closed on malformed frames", () => {
    expect(parseDshStreamLine(JSON.stringify({ type: "session", sessionId: "s", cwd: "/x" }))).toMatchObject({ kind: "session" });
    expect(parseDshStreamLine(JSON.stringify({ type: "status", phase: "step_end", turn: 1, step: 2, usage: { inputTokens: 1 } }))).toMatchObject({ kind: "status", phase: "step_end" });
    expect(parseDshStreamLine(JSON.stringify({ type: "final", sessionId: "s", reason: { kind: "completed" }, text: "ok" }))).toMatchObject({ kind: "final", reasonKind: "completed" });
    expect(parseDshStreamLine(JSON.stringify({ type: "tool_result", callId: "c", status: "error", result: "x" }))).toMatchObject({ kind: "tool_result", status: "error" });
    expect(parseDshStreamLine(JSON.stringify({ type: "future_event", x: 1 })).kind).toBe("other");
    for (const line of ["not json", "[]", JSON.stringify({ type: "final", sessionId: "s", reason: {}, text: "ok" }), JSON.stringify({ type: "status", phase: "bogus", turn: 1 }), JSON.stringify({ type: "text" })]) {
      expect(parseDshStreamLine(line).kind, line).toBe("malformed");
    }
  });
});

describe("argv and environment", () => {
  it("builds edit, read-only and allowBash argv; the key is only in the environment", async () => {
    const { cli, record } = fakeCli(SUCCESS_BODY);
    const edits = task({ mayEdit: true, ownedPaths: [`${cwdDir}/allowed`, `${cwdDir}/other`], role: "worker" });
    const result = await runnerFor(cli)({ run: run(), task: edits, signal: new AbortController().signal, onProgress() {} });
    expect(result.state, result.error).toBe("done");
    const rec = readRecord(record);
    spawnedPids.push(rec.pid);
    expect(rec.argv[0]).toBe("run");
    expect(rec.argv).toContain("--json");
    expect(argValue(rec.argv, "--model")).toBe("alpha-p/alpha-model");
    expect(argValue(rec.argv, "--base-url")).toBe("https://alpha-p.example/v1");
    expect(argValue(rec.argv, "--api")).toBe("openai-completions");
    expect(argValue(rec.argv, "--key-env")).toBe(DSH_KEY_ENV);
    expect(argValue(rec.argv, "--context-window")).toBe("100000");
    expect(JSON.parse(argValue(rec.argv, "--compat")!)).toEqual({ supportsDeveloperRole: false });
    expect(argValue(rec.argv, "--effort")).toBe("medium");
    expect(argValue(rec.argv, "--permission")).toBe("workspace-write");
    expect(rec.argv.filter((a) => a === "--owned-path")).toHaveLength(2);
    expect(rec.argv).toContain(`${cwdDir}/allowed`);
    expect(rec.argv).toContain(`${cwdDir}/other`);
    // Owned paths inside the run cwd need no extra sandbox grant.
    expect(rec.argv).not.toContain("--add-dir");
    expect(rec.argv).toContain("--no-shell");
    expect(rec.argv.at(-1)).toBe("-");
    // The key never appears in argv; it is present in the child environment under its fixed name.
    expect(rec.argv.join(" ")).not.toContain(KEY);
    expect(rec.envNames).toContain(DSH_KEY_ENV);
    expect(rec.keyPresent).toBe(true);
    expect(rec.stdinHasPrompt).toBe(true);
    // Read-only leaf: read-only permission, no owned paths, still no shell.
    const ro = fakeCli(SUCCESS_BODY);
    await runnerFor(ro.cli)({ run: run(), task: task(), signal: new AbortController().signal, onProgress() {} });
    const roRec = readRecord(ro.record);
    expect(argValue(roRec.argv, "--permission")).toBe("read-only");
    expect(roRec.argv).not.toContain("--owned-path");
    expect(roRec.argv).toContain("--no-shell");
    // allowBash removes --no-shell.
    const sh = fakeCli(SUCCESS_BODY);
    await runnerFor(sh.cli)({ run: run(), task: task({ mayEdit: true, ownedPaths: [`${cwdDir}/allowed`], allowBash: true }), signal: new AbortController().signal, onProgress() {} });
    expect(readRecord(sh.record).argv).not.toContain("--no-shell");
  });
  it("validates declared read-only artifact roots and never grants them write access", async () => {
    const root = join(homedir(), ".cache", "agent-scratch", "dsh-test-task", "artifacts");
    mkdirSync(root, { recursive: true });
    try {
      const { cli, record } = fakeCli(SUCCESS_BODY);
      // Dispatch stores the physical grant; the launch re-check binds exactly that path.
      const result = await runnerFor(cli)({ run: run(), task: task({ readPaths: [realpathSync(root)] }), signal: new AbortController().signal, onProgress() {} });
      expect(result.state, result.error).toBe("done");
      const argv = readRecord(record).argv;
      // --add-dir grants WRITE access on this harness; reads are not confined, so a read root needs no grant.
      expect(argv).not.toContain("--add-dir");
      expect(argValue(argv, "--permission")).toBe("read-only");
    } finally { rmSync(join(homedir(), ".cache", "agent-scratch", "dsh-test-task"), { recursive: true, force: true }); }
  });
  it("refuses unsupported APIs, relative owned paths and edit leaves without owned paths", () => {
    expect(() => dshWorkerArgs({ ...testModel, api: "pi-virtual" } as Model, {}, "medium")).toThrow(/cannot serve the native API/);
    expect(() => dshWorkerArgs(testModel, { mayEdit: true, ownedPaths: ["relative/path"] }, "medium")).toThrow(/must be absolute/);
    expect(() => dshWorkerArgs(testModel, { mayEdit: true, ownedPaths: [] }, "medium")).toThrow(/at least one owned path/);
    expect(() => dshWorkerArgs(testModel, { ownedPaths: ["/repo/x"] }, "medium")).toThrow(/read-only leaves cannot own/);
  });
  it("strips credential-bearing environment variables from the child", () => {
    const env = dshWorkerEnv({ PATH: "/usr/bin", HOME: "/home/x", OPENAI_API_KEY: "secret", AWS_SECRET_ACCESS_KEY: "secret", STEAK_DSH_ROUTE_KEY: "old" }, KEY);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env[DSH_KEY_ENV]).toBe(KEY);
  });
});

describe("usage and cost", () => {
  it("sums step_end usage and prices it from the registry model's own cost table", async () => {
    const { cli } = fakeCli(SUCCESS_BODY);
    const progress: WorkerProgress[] = [];
    const result = await runnerFor(cli)({ run: run(), task: task(), signal: new AbortController().signal, onProgress: (p) => progress.push(p) });
    expect(result.state, result.error).toBe("done");
    expect(result.usage.input).toBe(1500);
    expect(result.usage.output).toBe(150);
    expect(result.usage.cacheRead).toBe(200);
    expect(result.usage.cacheWrite).toBe(50);
    expect(result.usage.totalTokens).toBe(1900);
    // (3*1500 + 15*150 + 0.3*200 + 0.6*50) / 1e6
    expect(result.usage.cost.total).toBeCloseTo(0.00684, 8);
    expect(result.turns).toBe(2);
    expect(result.toolSuccesses).toBe(1);
    expect(progress.some((p) => p.outputStarted === true)).toBe(true);
    expect(progress.some((p) => p.usage !== undefined)).toBe(true);
  });
  it("prices to zero when the registry cost table is zero", () => {
    const usage = dshUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(usage.cost.total).toBe(0);
    expect(usage.totalTokens).toBe(2_000_000);
  });
  it("journals successful edit paths like the other runners", async () => {
    const { cli } = fakeCli(SUCCESS_BODY);
    const leaf = task({ mayEdit: true, ownedPaths: [`${cwdDir}/allowed`], role: "worker" });
    await runnerFor(cli)({ run: run(), task: leaf, signal: new AbortController().signal, onProgress() {} });
    expect([...workerJournal(leaf).changedPaths]).toContain(`${cwdDir}/allowed/a.txt`);
  });
});

describe("failure classification", () => {
  const caseOf = async (body: string, runOver: Partial<RunRecord> = {}, taskOver: Partial<TaskRecord> = {}) => {
    const { cli, record } = fakeCli(body);
    const result = await runnerFor(cli)({ run: run(runOver), task: task(taskOver), signal: new AbortController().signal, onProgress() {} });
    if (existsSync(record)) spawnedPids.push(readRecord(record).pid);
    return result;
  };
  it("fails on a non-completed final reason", async () => {
    const result = await caseOf(`out({type:"final",sessionId:"s",reason:{kind:"error"},text:"the model stopped"}); process.exit(0);`);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/final reason kind "error" is not completed/);
  });
  it("fails closed on a malformed frame, naming the protocol", async () => {
    const result = await caseOf(`process.stdout.write("this is not json\\n"); process.exit(0);`);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/malformed NDJSON/);
  });
  it("names the missing harness on exit 78, with the install hint", async () => {
    const result = await caseOf(`process.stderr.write("steak-dsh: dsh is not installed\\n"); process.exit(78);`);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/steak-dsh harness not installed.*STEAK_DSH_BIN/s);
  });
  it("classifies 429 / quota / insufficient credits as the provider-quota failure kind", async () => {
    for (const message of ["HTTP 429: too many requests", "402 Insufficient credits", "insufficient_quota: allocated quota exceeded"]) {
      const result = await caseOf(`out({type:"error",message:${JSON.stringify(message)}}); setTimeout(() => process.exit(1), 10000);`);
      expect(result.state).toBe("failed");
      expect(isQuotaLaunchFailure(result.error!), message).toBe(true);
    }
  });
  it("fails with the last stderr line on an ordinary nonzero exit", async () => {
    const result = await caseOf(`process.stderr.write("first line\\nboom: something broke\\n"); process.exit(3);`);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/steak-dsh task failed: CLI exited with code 3: boom: something broke/);
  });
  it("fails when the stream ends without a final event", async () => {
    const result = await caseOf(`out({type:"status",phase:"turn_start",turn:1}); process.exit(0);`);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/no final event/);
  });
  it("redacts the route key from output and diagnostics even if the CLI leaks it", async () => {
    const result = await caseOf(`process.stderr.write("debug " + process.env.STEAK_DSH_ROUTE_KEY + "\\n"); out({type:"final",sessionId:"s",reason:{kind:"completed"},text:"the key is " + process.env.STEAK_DSH_ROUTE_KEY}); process.exit(0);`);
    expect(result.state, result.error).toBe("done");
    expect(result.output).toContain("[redacted]");
    expect(result.output).not.toContain(KEY);
  });
  it("refuses cross-harness resume and foreign runs with named errors", async () => {
    const { cli } = fakeCli(SUCCESS_BODY);
    const runner = runnerFor(cli);
    const resumed = await runner({ run: run(), task: task({ sessionFile: "/tmp/session.jsonl" }), signal: new AbortController().signal, onProgress() {} });
    expect(resumed.state).toBe("failed");
    expect(resumed.error).toMatch(/cannot resume a native Pi worker session/);
    await expect(runner({ run: run({ harness: undefined }), task: task(), signal: new AbortController().signal, onProgress() {} })).rejects.toThrow(/only serves runs with harness 'steak-dsh'/);
    const unknown = await runner({ run: run({ model: "steak-dsh/alpha-p" }), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(unknown.error).toMatch(/steak-dsh\/<provider>\/<model-id>/);
  });
  it("refuses an OAuth-only login or a missing API key at launch", async () => {
    const { cli } = fakeCli(SUCCESS_BODY);
    const oauth = await runnerFor(cli, { resolveRuntime: () => ({ model: testModel, thinkingLevel: "medium", dsh: { resolveAuth: async () => ({ ok: true as const, apiKey: KEY }), isUsingOAuth: () => true } }) })({ run: run(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(oauth.error).toMatch(/OAuth-only login/);
    const keyless = await runnerFor(cli, { resolveRuntime: () => ({ model: testModel, thinkingLevel: "medium", dsh: { resolveAuth: async () => ({ ok: true as const }), isUsingOAuth: () => false } }) })({ run: run(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(keyless.error).toMatch(/no API key the harness can use/);
    const refused = await runnerFor(cli, { resolveRuntime: () => ({ model: testModel, thinkingLevel: "medium", dsh: { resolveAuth: async () => ({ ok: false as const, error: "credential store unavailable" }), isUsingOAuth: () => false } }) })({ run: run(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(refused.error).toMatch(/Pi auth resolution refused: credential store unavailable/);
  });
});

describe("budgets and cancellation", () => {
  it("enforces maxTurns by counting step_start and kills the child with a named budget error", async () => {
    const { cli, record } = fakeCli(`let n = 0; const t = setInterval(() => { n += 1; out({type:"status",phase:"step_start",turn:1,step:n}); if (n > 500) { clearInterval(t); process.exit(0); } }, 5);`);
    const result = await runnerFor(cli)({ run: run({ maxTurns: 3 }), task: task(), signal: new AbortController().signal, onProgress() {} });
    spawnedPids.push(readRecord(record).pid);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/3-turn limit.*turn budget/s);
    expect(result.turns).toBe(4);
  });
  it("kills the whole process group on abort (SIGTERM then SIGKILL grace)", async () => {
    const heartbeat = join(dir, `heartbeat-${++files}.txt`);
    const pidsFile = join(dir, `pids-${files}.json`);
    const heartbeatScript = join(dir, `heartbeat-${files}.cjs`);
    writeFileSync(heartbeat, "");
    writeFileSync(heartbeatScript, `setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(heartbeat)}, "x"), 20);\n`);
    const { cli } = fakeCli(`
const child = require("node:child_process").spawn(process.execPath, [${JSON.stringify(heartbeatScript)}]);
// Written whole, then renamed: the test waits for the file to exist, and a plain write exists (empty) before it has content.
require("node:fs").writeFileSync(${JSON.stringify(pidsFile)} + ".tmp", JSON.stringify({ parent: process.pid, child: child.pid }));
require("node:fs").renameSync(${JSON.stringify(pidsFile)} + ".tmp", ${JSON.stringify(pidsFile)});
setInterval(() => {}, 1000);
`);
    const controller = new AbortController();
    const pending = runnerFor(cli)({ run: run(), task: task(), signal: controller.signal, onProgress() {} });
    // Wait for the child group to exist, then abort.
    for (let i = 0; i < 200 && !existsSync(pidsFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(existsSync(pidsFile)).toBe(true);
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { parent: number; child: number };
    spawnedPids.push(pids.parent, pids.child);
    controller.abort();
    const result = await pending;
    expect(result.state).toBe("aborted");
    // Both the CLI and its child (same process group) are gone; the heartbeat stopped.
    const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    for (let i = 0; i < 100 && (!dead(pids.parent) || !dead(pids.child)); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dead(pids.parent), "CLI process survived the group kill").toBe(true);
    expect(dead(pids.child), "CLI child survived the group kill").toBe(true);
    const before = readFileSync(heartbeat, "utf8").length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(heartbeat, "utf8").length).toBe(before);
  });
  it("escalates SIGTERM to SIGKILL when the child ignores the grace (fake spawn seam)", async () => {
    const signals: string[] = [];
    const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
    const handle: DshSpawnHandle = {
      pid: 999_001,
      onExit(listener) { exitListeners.push(listener); }, onError() {}, onStdout() {}, onStderr() {},
      writeStdin() {}, endStdin() {},
      kill(signal) {
        signals.push(signal ?? "SIGTERM");
        // The child ignores SIGTERM and only dies on SIGKILL, like a wedged CLI.
        if (signal === "SIGKILL") queueMicrotask(() => { for (const listener of exitListeners) listener(null, "SIGKILL"); });
        return true;
      },
    };
    const controller = new AbortController();
    const runner = createDshWorkerRunner({
      executable: "/fake/steak-dsh", spawn: () => handle, abortGraceMs: 20,
      resolveRuntime: () => ({ model: testModel, thinkingLevel: "medium", dsh: { resolveAuth: async () => ({ ok: true as const, apiKey: KEY }), isUsingOAuth: () => false } }),
    });
    const pending = runner({ run: run(), task: task(), signal: controller.signal, onProgress() {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const result = await pending;
    expect(result.state, result.error).toBe("aborted");
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });
  it("reports a timeout as timed_out", async () => {
    const { cli } = fakeCli(`setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const pending = runnerFor(cli)({ run: run(), task: task(), signal: controller.signal, onProgress() {} });
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new DOMException("Run deadline exceeded", "TimeoutError"));
    const result = await pending;
    expect(result.state).toBe("timed_out");
  });
});

describe("steak-dsh effort follows the registry model's own thinking-level map", () => {
  const base = { provider: "acme", id: "m", reasoning: true } as never as Parameters<typeof dshEffortArgs>[0];
  it("passes the level through when the model declares no map", () => {
    expect(dshEffortArgs(base, "medium")).toEqual(["--effort", "medium"]);
  });
  it("sends the mapped wire spelling", () => {
    const model = { ...(base as object), thinkingLevelMap: { high: "max" } } as never as Parameters<typeof dshEffortArgs>[0];
    expect(dshEffortArgs(model, "high")).toEqual(["--effort", "high=max"]);
  });
  it("moves up to the nearest offered level when the asked level is not offered", () => {
    const model = { ...(base as object), thinkingLevelMap: { medium: null, high: "high", xhigh: null } } as never as Parameters<typeof dshEffortArgs>[0];
    expect(dshEffortArgs(model, "medium")).toEqual(["--effort", "high"]);
    expect(dshEffortArgs(model, "xhigh")).toEqual(["--effort", "high"]);
  });
  it("omits the flag for a model that does not reason", () => {
    const model = { ...(base as object), reasoning: false } as never as Parameters<typeof dshEffortArgs>[0];
    expect(dshEffortArgs(model, "high")).toEqual([]);
  });
});

describe("steak-dsh grants the sandbox only what an owned path outside the run cwd needs", () => {
  it("grants nothing inside the cwd, the owned directory itself, or the immediate parent of an owned file", async () => {
    const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-roots-")));
    try {
      const cwd = join(root, "cwd");
      const other = join(root, "other");
      mkdirSync(join(cwd, "src"), { recursive: true });
      mkdirSync(join(other, "sub"), { recursive: true });
      expect(dshWritableRoots([join(cwd, "src"), join(cwd, "new.ts")], cwd)).toEqual([]);
      expect(dshWritableRoots([join(other, "sub")], cwd)).toEqual([join(other, "sub")]);
      expect(dshWritableRoots([join(other, "b.txt"), join(other, "c.txt")], cwd)).toEqual([other]);
      const args = dshWorkerArgs(testModel, { mayEdit: true, ownedPaths: [join(other, "x.txt")] }, "medium", cwd);
      expect(args.slice(args.indexOf("--add-dir"), args.indexOf("--add-dir") + 2)).toEqual(["--add-dir", other]);
      expect(dshWorkerArgs(testModel, { mayEdit: true, ownedPaths: [join(cwd, "src")] }, "medium", cwd)).not.toContain("--add-dir");
      // The grant never widens: a missing parent is refused instead of walking up to whatever exists.
      expect(() => dshWritableRoots([join(other, "deep", "er", "new.txt")], cwd)).toThrow(/parent directory does not exist/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses a grant that would be the home directory, above it, or near the filesystem root", async () => {
    const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-home-")));
    try {
      const home = join(root, "users", "me");
      mkdirSync(join(home, "proj"), { recursive: true });
      const cwd = join(home, "proj");
      expect(() => dshWritableRoots([join(home, "new-proj")], cwd, home)).toThrow(/home directory or above it/);
      expect(() => dshWritableRoots([join(root, "users", "x.txt")], cwd, home)).toThrow(/home directory or above it/);
      expect(() => dshWritableRoots(["/etc/hosts"], cwd, home)).toThrow(/too close to the filesystem root/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("never grants write access for read-only artifact roots", () => {
    expect(dshWorkerArgs(testModel, {}, "medium", "/tmp")).not.toContain("--add-dir");
  });
});

describe("review regressions", () => {
  it("does not read ordinary text as a provider quota refusal", () => {
    const base = { signal: new AbortController().signal, maxTurns: 10, exitCode: 1, exitSignal: null,
      state: { outputParts: [], outputLength: 0, toolErrors: 0, toolSuccesses: 0, turns: 1, turnLimitReached: false, usage: {} as never, sawFinal: false } };
    for (const line of ["AssertionError: test failed at line 402", "added rate limiting to the client", "expected 429 items, got 3"]) {
      expect(classifyDshWorkerState({ ...base, stderrLine: line } as never).error, line).not.toMatch(/quota limit reached/);
    }
    for (const line of ["HTTP 429 Too Many Requests", "error code: 402 insufficient credits", "status 429", "rate_limit_exceeded"]) {
      expect(classifyDshWorkerState({ ...base, stderrLine: line } as never).error, line).toMatch(/quota limit reached/);
    }
  });
  it("reports a timeout as a timeout even when the dying child printed an error", () => {
    const timeout = AbortSignal.abort(Object.assign(new Error("deadline"), { name: "TimeoutError" }));
    const state = { outputParts: [], outputLength: 0, toolErrors: 0, toolSuccesses: 0, turns: 1, turnLimitReached: false, usage: {} as never, sawFinal: false, failure: "steak-dsh reported an error: interrupted" };
    expect(classifyDshWorkerState({ signal: timeout, state, maxTurns: 10, exitCode: null, exitSignal: "SIGTERM" } as never).state).toBe("timed_out");
    expect(classifyDshWorkerState({ signal: timeout, state, maxTurns: 10, exitCode: null, exitSignal: "SIGTERM", failedBeforeAbort: true } as never).state).toBe("failed");
  });
});

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NoopSlots } from "../src/subagents/machine-slots.ts";
import { Scheduler } from "../src/subagents/scheduler.ts";
import { parseWaveSpec, resumeClaudeApiRun, runClaudeApiWave, summarizeRun, type ClaudeApiWaveDeps } from "../src/subagents/claude-api-cli.ts";
import { ClaudeApiAdmissionError } from "../src/subagents/claude-api-route.ts";
import type { ClaudeSpawnHandle } from "../src/subagents/claude-worker.ts";
import { apiFixture, CANARY_HEADER, CANARY_KEY, CANARY_WORKSPACE, type ApiFixture } from "./helpers/claude-api-fixture.ts";

const SONNET = "claude-code-api/claude-sonnet-5-5";
const GOOD_STATUS = { loggedIn: true, authMethod: "api_key_helper", apiProvider: "firstParty", apiKeySource: "apiKeyHelper" };
const dirs: string[] = [];
const fixtures: ApiFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

class Fake implements ClaudeSpawnHandle {
  private static next = 7100;
  pid = Fake.next++;
  exits: Array<(code: number | null, signal: string | null) => void> = [];
  outs: Array<(chunk: string) => void> = [];
  stdin: string[] = [];
  signals: string[] = [];
  onExit(l: (code: number | null, signal: string | null) => void) { this.exits.push(l); }
  onError() {}
  onStdout(l: (chunk: string) => void) { this.outs.push(l); }
  onStderr() {}
  writeStdin(text: string) { this.stdin.push(text); }
  endStdin() {}
  kill(signal?: string) { this.signals.push(signal ?? "SIGTERM"); if (signal === "SIGKILL") queueMicrotask(() => this.exit(null, "SIGKILL")); return true; }
  out(chunk: string) { for (const l of this.outs) l(chunk); }
  exit(code: number | null = 0, signal: string | null = null) { for (const l of this.exits) l(code, signal); }
}
const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
const initFrame = (session = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") => frame({ type: "system", subtype: "init", model: "claude-sonnet-5-5", apiKeySource: "apiKeyHelper", claude_code_version: "2.1.296", session_id: session });
let n = 0;
const reply = (text: string) => frame({ type: "assistant", message: { id: `cli-${++n}`, model: "claude-sonnet-5-5", content: [{ type: "text", text }], usage: { input_tokens: 4, output_tokens: 2 } } });
const result = (text: string, cost = 0.05) => frame({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: cost, num_turns: 1, modelUsage: { "claude-sonnet-5-5": {} } });

function setup(script: (child: Fake, index: number) => void) {
  const f = apiFixture(); fixtures.push(f);
  const root = mkdtempSync(join(tmpdir(), "usap-api-cli-")); dirs.push(root);
  const cwd = mkdtempSync(join(tmpdir(), "usap-api-cli-cwd-")); dirs.push(cwd);
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; child: Fake }> = [];
  let ids = 0;
  const deps: ClaudeApiWaveDeps = {
    checkpointRoot: root, api: f.options, apiAuthStatus: async () => GOOD_STATUS, abortGraceMs: 20,
    scheduler: new Scheduler(3), machineSlots: new NoopSlots(), idFactory: () => `cli-${++ids}`,
    spawn: ({ args, env }) => { const child = new Fake(); calls.push({ args, env, child }); queueMicrotask(() => script(child, calls.length - 1)); return child; },
  };
  const spec = { goal: "Read the entrypoint", route: SONNET, cwd, tasks: [{ label: "Read", task: "Find the entrypoint", role: "scout" as const }] };
  return { f, root, cwd, calls, deps, spec };
}

describe("wave spec", () => {
  it("defaults to the Sonnet API route and rejects unknown keys, relative cwd and non-API routes", () => {
    expect(parseWaveSpec(JSON.stringify({ goal: "g", cwd: "/x", tasks: [] })).route).toBe(SONNET);
    expect(() => parseWaveSpec("{")).toThrow(/not valid JSON/);
    expect(() => parseWaveSpec("[]")).toThrow(/JSON object/);
    expect(() => parseWaveSpec(JSON.stringify({ goal: "g", cwd: "x", tasks: [] }))).toThrow(/absolute cwd/);
    expect(() => parseWaveSpec(JSON.stringify({ goal: "g", cwd: "/x", tasks: [], apiKey: "k" }))).toThrow(/unsupported key\(s\): apiKey/);
    expect(() => parseWaveSpec(JSON.stringify({ goal: "g", cwd: "/x", tasks: [{ label: "a", task: "b", model: "gpt" }] }))).toThrow(/tasks\[0\] has unsupported key/);
    for (const route of ["claude-code/claude-sonnet-5-5", "claude-code-api/other", "openai-codex/gpt-6.1-sol"]) {
      expect(() => parseWaveSpec(JSON.stringify({ goal: "g", cwd: "/x", route, tasks: [] }))).toThrow(/route must be one of/);
    }
  });
});

describe("runClaudeApiWave (native coordinator)", () => {
  it("dispatches through the coordinator, persists a checkpoint, and returns a sanitized summary with the API receipt", async () => {
    const t = setup((child) => { child.out(initFrame()); child.out(reply("entrypoint is bin/steak-pi")); child.out(result("entrypoint is bin/steak-pi")); child.exit(); });
    const outcome = await runClaudeApiWave(t.spec, t.deps);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.run.state).toBe("done");
    expect(outcome.run.model).toBe(SONNET);
    expect(outcome.run.harness).toBe("claude-code");
    expect(outcome.summary.tasks[0]).toMatchObject({ state: "done", costUsd: 0.05, receipt: { route: SONNET, auth: { keySource: "apiKeyHelper" }, attested: { preflight: true, init: true }, servedModels: ["claude-sonnet-5-5"] } });
    expect(outcome.text).toContain("entrypoint is bin/steak-pi");
    expect(outcome.text).toContain("api receipt: auth=api_key_helper");
    const everything = JSON.stringify(outcome) + t.calls[0].child.stdin.join("") + t.calls[0].args.join(" ");
    for (const canary of [CANARY_KEY, CANARY_WORKSPACE, CANARY_HEADER, t.f.helperPath]) expect(everything).not.toContain(canary);
    expect(t.calls[0].args[0]).toBe("--bare");
    expect(t.calls[0].args[t.calls[0].args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    // Durable private checkpoint of the settled run.
    const namespace = readdirSync(t.root).find((name) => /^[0-9a-f]{64}$/.test(name))!;
    const file = join(t.root, namespace, `${outcome.run.id}.json`);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it("a failed leaf exits 1 and names no fallback", async () => {
    const t = setup((child) => {
      child.out(initFrame());
      child.out(frame({ type: "result", subtype: "error_max_budget_usd", is_error: false, total_cost_usd: 1.01, num_turns: 1, modelUsage: { "claude-sonnet-5-5": {} } }));
      child.exit();
    });
    const outcome = await runClaudeApiWave(t.spec, t.deps);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.summary.tasks[0].error).toMatch(/session budget ceiling reached/);
    expect(outcome.run.model).toBe(SONNET);
    expect(t.calls).toHaveLength(1);
  });

  it("refuses before any checkpoint or child when the approval is missing or the route is not approved", async () => {
    const t = setup(() => {});
    const missing = { ...t.deps, api: { configPath: join(t.f.dir, "none.json"), now: t.f.options.now } };
    await expect(runClaudeApiWave(t.spec, missing)).rejects.toBeInstanceOf(ClaudeApiAdmissionError);
    await expect(runClaudeApiWave(t.spec, missing)).rejects.toThrow(/approval-missing/);
    t.f.writeConfig({ routes: ["claude-code-api/claude-opus-5-5"] });
    await expect(runClaudeApiWave(t.spec, t.deps)).rejects.toThrow(/route-not-approved/);
    expect(t.calls).toHaveLength(0);
    expect(readdirSync(t.root)).toEqual([]);
  });

  it("caps width at three and shares the run ceiling across leaves", async () => {
    const t = setup((child) => { child.out(initFrame()); child.out(reply("x")); child.out(result("x")); child.exit(); });
    const tasks = Array.from({ length: 4 }, (_, i) => ({ label: `Read ${i}`, task: "read", role: "scout" as const }));
    const outcome = await runClaudeApiWave({ ...t.spec, tasks, concurrency: 8 }, t.deps);
    expect(outcome.run.concurrency).toBe(3);
    for (const call of t.calls) expect(call.args[call.args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
    expect(outcome.run.tasks.every((task) => task.apiLeafCapUsd === 0.5)).toBe(true);
  });

  it("cancellation settles aborted (exit 130), signals only the owned child and keeps a resumable checkpoint", async () => {
    const controller = new AbortController();
    const t = setup((child, index) => { if (index === 0) { child.out(initFrame()); queueMicrotask(() => setTimeout(() => controller.abort(), 20)); } });
    const outcome = await runClaudeApiWave(t.spec, { ...t.deps, signal: controller.signal });
    expect(outcome.exitCode).toBe(130);
    expect(outcome.run.tasks[0].state).toBe("aborted");
    expect(t.calls[0].child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome.run.tasks[0].claudeSessionId).toBeDefined();
  });

  it("an aborted API run resumes ONCE on the same route and session, with the booked spend, and cannot resume again", async () => {
    const controller = new AbortController();
    const t = setup((child, index) => {
      if (index === 0) { child.out(initFrame()); child.out(frame({ type: "assistant", message: { id: "cut-1", model: "claude-sonnet-5-5", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 4, output_tokens: 2 } } })); setTimeout(() => controller.abort(), 20); }
      else { child.out(initFrame()); child.out(reply("finished after resume")); child.out(result("finished after resume", 0.04)); child.exit(); }
    });
    const first = await runClaudeApiWave(t.spec, { ...t.deps, signal: controller.signal });
    expect(first.exitCode).toBe(130);
    const sessionId = first.run.tasks[0].claudeSessionId!;
    const resumed = await resumeClaudeApiRun(first.run.id, t.deps);
    expect(resumed.exitCode).toBe(0);
    expect(resumed.run.resumedFrom).toBe(first.run.id);
    expect(resumed.run.model).toBe(SONNET);
    const call = t.calls[1];
    expect(call.args[call.args.indexOf("--resume") + 1]).toBe(sessionId);
    expect(call.args).not.toContain("--session-id");
    expect(call.args[0]).toBe("--bare");
    expect(call.child.stdin.join("")).toContain("Continue the exact assigned leaf");
    expect(resumed.run.tasks[0].apiLeafCapUsd).toBe(1);
    expect(resumed.run.tasks[0].priorSpendUsd).toBe(first.run.tasks[0].usage.cost.total);
    await expect(resumeClaudeApiRun(first.run.id, t.deps)).rejects.toThrow(/Already resumed as/);
    await expect(resumeClaudeApiRun(resumed.run.id, t.deps)).rejects.toThrow(/No unfinished tasks/);
  });

  it("resume re-admits: a revoked approval or spent budget stops the one resume before it is consumed", async () => {
    const controller = new AbortController();
    const t = setup((child, index) => { if (index === 0) { child.out(initFrame()); setTimeout(() => controller.abort(), 20); } });
    const first = await runClaudeApiWave(t.spec, { ...t.deps, signal: controller.signal });
    t.f.writeConfig({ routes: ["claude-code-api/claude-opus-5-5"] });
    await expect(resumeClaudeApiRun(first.run.id, t.deps)).rejects.toThrow(/route-not-approved/);
    t.f.writeConfig();
    // The failed attempt did not consume the resume.
    await expect(resumeClaudeApiRun(first.run.id, { ...t.deps, spawn: ({ args }) => { const c = new Fake(); t.calls.push({ args, env: {}, child: c }); queueMicrotask(() => { c.out(initFrame()); c.out(reply("ok")); c.out(result("ok")); c.exit(); }); return c; } })).resolves.toMatchObject({ exitCode: 0 });
  });

  it("refuses to resume an unknown run", async () => {
    const t = setup(() => {});
    await expect(resumeClaudeApiRun("run-missing", t.deps)).rejects.toThrow(/Unknown checkpoint/);
  });

  it("summaries carry ids, states and receipts only", () => {
    const summary = summarizeRun({ version: "1.3", id: "run-x", goal: "SECRET GOAL TEXT", constraints: [], cwd: "/r", model: SONNET, harness: "claude-code", thinkingLevel: "xhigh", concurrency: 1, timeoutMs: 1, maxTurns: 1,
      background: false, state: "done", createdAt: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1234567 } },
      tasks: [{ id: "t", label: "L", task: "SECRET TASK TEXT", role: "scout", mayEdit: false, ownedPaths: [], allowBash: false, state: "done", output: "SECRET OUTPUT", turns: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } }, relaySent: 0, relayReceived: 0, truncated: false }] } as never);
    expect(JSON.stringify(summary)).not.toMatch(/SECRET/);
    expect(summary.totalCostUsd).toBe(0.123457);
  });
});

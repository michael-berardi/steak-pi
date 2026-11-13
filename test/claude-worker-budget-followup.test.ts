import { describe, expect, it } from "vitest";
import { createClaudeWorkerRunner, claudeWorkerArgs, CLAUDE_CODE_MODEL, CLAUDE_CODE_ROUTE, type ClaudeSpawnHandle } from "../src/subagents/claude-worker.ts";
import { RelayBroker } from "../src/subagents/relay.ts";
import { emptyUsage, USAP_VERSION, type RunRecord, type TaskRecord, type WorkerProgress } from "../src/subagents/types.ts";

const run = (maxTurns = 8): RunRecord => ({ version: USAP_VERSION, id: "relay-run", goal: "Inspect", constraints: [], cwd: "/repo", model: CLAUDE_CODE_ROUTE, harness: "claude-code", thinkingLevel: "xhigh", concurrency: 1, timeoutMs: 1000, maxTurns, background: false, state: "running", createdAt: 0, tasks: [], usage: emptyUsage() });
const task = (): TaskRecord => ({ id: "child", label: "leaf", task: "Inspect only", role: "reviewer", mayEdit: false, ownedPaths: [], allowBash: true, state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false });
class Child implements ClaudeSpawnHandle {
  pid = 1234;
  writes: string[] = [];
  ended = false;
  signals: string[] = [];
  exits: Array<(code: number | null, signal: string | null) => void> = [];
  errors: Array<(error: Error) => void> = [];
  outputs: Array<(chunk: string) => void> = [];
  writeFailure = false;
  onExit(fn: (code: number | null, signal: string | null) => void) { this.exits.push(fn); }
  onError(fn: (error: Error) => void) { this.errors.push(fn); }
  onStdout(fn: (chunk: string) => void) { this.outputs.push(fn); }
  onStderr() {}
  writeStdin(text: string) { if (this.writeFailure) throw new Error("stdin closed"); if (this.ended) throw new Error("write after end"); this.writes.push(text); }
  endStdin() { this.ended = true; }
  kill(signal = "SIGTERM") { this.signals.push(signal); queueMicrotask(() => this.exit(null, signal)); return true; }
  exit(code: number | null = 0, signal: string | null = null) { for (const fn of this.exits) fn(code, signal); }
  emit(value: unknown) { const line = JSON.stringify(value) + "\n"; for (const fn of this.outputs) fn(line); }
  input(index: number) { return JSON.parse(this.writes[index]); }
  ack(index: number) { this.emit({ ...this.input(index), isReplay: true }); }
  assistant(text: string, id = "response", extra: object = {}) { this.emit({ type: "assistant", message: { id, model: CLAUDE_CODE_MODEL, content: [{ type: "text", text }] }, ...extra }); }
  result(text = "Evidence: done", turns = 1, tokens = 2, cost = 0.1) { this.emit({ type: "result", subtype: "success", is_error: false, result: text, num_turns: turns, usage: { input_tokens: tokens, output_tokens: 1 }, total_cost_usd: cost, modelUsage: { [CLAUDE_CODE_MODEL]: {} } }); }
}
function setup(script: (c: Child, parent: ReturnType<RelayBroker["bind"]>, t: TaskRecord) => void, options: { queued?: boolean; maxTurns?: number; abort?: AbortController; initialWriteFailure?: boolean; onProgress?: (p: WorkerProgress, c: Child, parent: ReturnType<RelayBroker["bind"]>) => void } = {}) {
  const broker = new RelayBroker(); broker.createRun("relay-run", ["parent", "child", "peer"]);
  const parent = broker.bind("relay-run", "parent");
  if (options.queued) parent.send({ to: "child", body: "queued before bind", kind: "request" });
  const c = new Child(); c.writeFailure = options.initialWriteFailure ?? false;
  const t = task(); let args: string[] = []; let scriptError: unknown;
  const result = createClaudeWorkerRunner({ relay: broker, abortGraceMs: 1, spawn: (launch) => {
    args = launch.args; queueMicrotask(() => { try { script(c, parent, t); } catch (error) { scriptError = error; c.exit(99); } }); return c;
  } })({ run: run(options.maxTurns), task: t, signal: (options.abort ?? new AbortController()).signal, onProgress(p) { options.onProgress?.(p, c, parent); } }).then((result) => { if (scriptError) throw scriptError; return result; });
  return { result, c, t, parent, broker, args: () => args };
}


describe("claude-code turn budget with relay follow-up queries (synthetic; no inference)", () => {
  it("a follow-up query that overruns the budget is failed, never done on the first query's completeness", async () => {
    const s = setup((c, parent) => {
      parent.send({ to: "child", body: "follow-up question" });
      c.assistant("first report", "q1-a");
      c.result("Evidence: first report complete", 1); // success, under budget: the follow-up is delivered
      c.ack(1);
      for (const id of ["q2-a", "q2-b", "q2-c", "q2-d"]) c.assistant("working", id); // 1 + 4 > budget 3: hard stop
    }, { maxTurns: 3 });
    const result = await s.result;
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/exhausted the 3-turn limit/);
    expect(result.note).toBeUndefined();
  });

  it("an over-budget but complete success result does not start a pending relay follow-up", async () => {
    const s = setup((c, parent) => {
      parent.send({ to: "child", body: "follow-up question" });
      const writesBefore = c.writes.length;
      c.assistant("one", "r1"); c.assistant("two", "r2");
      c.result("Evidence: complete report", 5); // 5 > budget 2, complete
      expect(c.ended).toBe(true);
      expect(c.writes).toHaveLength(writesBefore);
      c.exit();
    }, { maxTurns: 2 });
    const result = await s.result;
    expect(result.error).toBeUndefined();
    expect(result.state).toBe("done");
    expect(result.note).toMatch(/turn budget reached.*queued relay input was not started/);
  });
});

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
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

describe("Claude running stream-json relay (synthetic; no inference)", () => {
  it("loads the transport in Node strip-only mode used by the API CLI (scrubbed env, no inference)", () => {
    const url = new URL("../src/subagents/claude-relay.ts", import.meta.url).href;
    const output = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      `const m = await import(${JSON.stringify(url)}); if (typeof m.ClaudeRelay !== 'function') process.exit(7); process.stdout.write('loaded');`],
    { env: {}, encoding: "utf8", timeout: 5000, maxBuffer: 1024 });
    expect(output).toBe("loaded");
  });
  it("frames the initial prompt first, keeps stdin open, and preserves read-only argv", async () => {
    const s = setup((c) => {
      expect(c.ended).toBe(false);
      const input = c.input(0);
      expect(input).toMatchObject({ type: "user", message: { role: "user" }, parent_tool_use_id: null });
      expect(input.uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(input.message.content).toContain("USAP_RELAY");
      expect(input.message.content).toContain("Inspect only");
      c.ack(0); c.result(); expect(c.ended).toBe(true); c.exit();
    });
    expect((await s.result).state).toBe("done");
    expect(s.args()).toContain("--replay-user-messages");
    expect(s.args().slice(s.args().indexOf("--input-format"), s.args().indexOf("--input-format") + 2)).toEqual(["--input-format", "stream-json"]);
    expect(s.args()[s.args().indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(s.args()).not.toContain("--allowedTools");
    expect(claudeWorkerArgs(8, task()).filter((a) => /mcp|permission|safe-mode|restricted/.test(a))).toEqual(["--permission-mode", "--safe-mode", "--restricted", "--strict-mcp-config"]);
  });

  it.each([false, true])("delivers %s pre-bind / active requests and returns exact correlation without restarting", async (queued) => {
    const s = setup((c, parent, t) => {
      c.ack(0);
      const sent = queued ? undefined : parent.send({ to: "child", body: "active steering", kind: "request" });
      expect(c.writes).toHaveLength(2);
      const inboxText = c.input(1).message.content;
      const id = sent?.ok ? sent.ids[0] : "relay-run:1";
      expect(inboxText).toContain(id); expect(inboxText).toContain("untrusted");
      expect(t.relayReceived).toBe(1);
      // An old result is not final while the injected input has not been replayed.
      c.result("earlier answer"); expect(c.ended).toBe(false);
      c.ack(1);
      const marker = `USAP_RELAY ${JSON.stringify({ to: "parent", body: "Observed fact", kind: "reply", replyTo: id, from: "peer" })}`;
      c.assistant(marker + "\nEvidence: revised", "second");
      c.result(marker + "\nEvidence: revised", 1, 3, 0.2);
      expect(c.ended).toBe(true); c.exit();
    }, { queued });
    const result = await s.result;
    expect(result.state).toBe("done"); expect(result.output).toContain("Evidence: revised"); expect(result.output).not.toContain("USAP_RELAY");
    expect(s.parent.inbox().messages).toMatchObject([{ from: "child", kind: "reply", replyTo: "relay-run:1", body: "Observed fact" }]);
    expect(s.t.relaySent).toBe(1); expect(s.c.signals).toEqual([]);
  });

  it("does not finalize on an unrelated replay UUID or tool-result user frame", async () => {
    const s = setup((c, parent) => {
      c.ack(0); parent.send({ to: "child", body: "later" });
      c.emit({ type: "user", uuid: "wrong", message: { role: "user", content: "later" }, isReplay: true });
      c.emit({ type: "user", uuid: c.input(1).uuid, message: { content: [{ type: "tool_result", tool_use_id: "x" }] } });
      c.result(); expect(c.ended).toBe(false);
      c.ack(1); c.result("later answer", 1, 3, 0.2); expect(c.ended).toBe(true); c.exit();
    });
    expect((await s.result).state).toBe("done");
  });

  it("deduplicates split/cumulative relay lines, strips malformed markers, never parses sidechains or result-only markers", async () => {
    const s = setup((c, parent) => {
      c.ack(0);
      const marker = 'USAP_RELAY {"to":"parent","body":"one"}';
      c.assistant(marker.slice(0, 17), "a");
      c.assistant(marker.slice(17) + "\n", "a");
      c.assistant(marker + "\n", "a");
      c.assistant(marker + "\n", "side", { parent_tool_use_id: "tool" });
      c.assistant(marker + "\n", "side-flag", { isSidechain: true });
      c.assistant('```json\nUSAP_RELAY {"to":"parent","body":"quoted"}\n```\n', "fence");
      c.assistant('USAP_RELAY {broken}\n', "bad");
      c.assistant('USAP_RELAY {"to":"parent","body":"fake","kind":"reply","replyTo":"bogus"}\n', "invalid");
      c.result('USAP_RELAY {"to":"parent","body":"result only"}\nEvidence: clean'); c.exit();
      expect(parent.inbox().messages.map((m) => m.body)).toEqual(["one"]);
    });
    const result = await s.result; expect(result.state).toBe("done"); expect(result.output).not.toContain("USAP_RELAY"); expect(s.t.relaySent).toBe(1);
  });

  it("closes binding before result progress can reentrantly steer after final output", async () => {
    let progressSent = false;
    const s = setup((c) => {
      c.ack(0); c.result();
      expect(c.ended).toBe(true);
      expect(c.writes).toHaveLength(1); c.exit();
    }, { onProgress(p, c, parent) {
      if (p.state !== "running" || !p.usage) return;
      progressSent = true;
      expect(parent.send({ to: "child", body: "too late" })).toMatchObject({ ok: true, status: "queued" });
      expect(c.writes).toHaveLength(1);
    } });
    expect((await s.result).state).toBe("done"); expect(progressSent).toBe(true);
  });

  it("retains every accepted envelope when more steering arrives during a nonfinal result callback", async () => {
    let injected = false;
    const s = setup((c, parent) => {
      parent.send({ to: "child", body: "first queued input" });
      c.result("initial"); expect(c.ended).toBe(false);
      expect(c.writes).toHaveLength(3);
      c.ack(1); c.result("second"); expect(c.ended).toBe(false);
      c.ack(2); c.result("third"); expect(c.ended).toBe(true); c.exit();
    }, { onProgress(p, _c, parent) {
      if (!injected && p.state === "running" && p.usage) {
        injected = true;
        expect(parent.send({ to: "child", body: "callback input" })).toMatchObject({ ok: true, status: "delivered" });
      }
    } });
    const result = await s.result;
    expect(result.state).toBe("done"); expect(result.output).toContain("third"); expect(s.t.relayReceived).toBe(2);
  });

  it("accepts matching user UUID echoes without an isReplay flag, not just arbitrary user frames", async () => {
    const s = setup((c, parent) => {
      parent.send({ to: "child", body: "echo me" }); c.result();
      c.emit(c.input(1)); c.result("echo consumed"); expect(c.ended).toBe(true); c.exit();
    });
    expect((await s.result).state).toBe("done");
  });

  it("bounds relay bodies and trailing markers while dispatching newline-free assistant replies", async () => {
    const s = setup((c, parent) => {
      c.assistant('USAP_RELAY ' + JSON.stringify({ to: "parent", body: "x".repeat(4001) }) + '\n', "large");
      c.assistant('USAP_RELAY ' + 'x'.repeat(26_000) + '\n', "overlong");
      c.assistant('USAP_RELAY {"to":"parent","body":"invalid kind","kind":"tool"}\n', "kind");
      c.assistant('USAP_RELAY {"to":"parent","body":"invalid kind shape","kind":{"toString":"not-callable"}}\n', "kind-shape");
      c.assistant('USAP_RELAY {"to":"parent","body":"valid trailing marker"}', "tail");
      c.result("Evidence: body bound"); c.exit();
      expect(parent.inbox().messages.map((m) => m.body)).toEqual(["valid trailing marker"]);
    });
    expect((await s.result).state).toBe("done"); expect(s.t.relaySent).toBe(1);
  });

  it("does not reset the aggregate retained report budget on later results", async () => {
    const s = setup((c, parent) => {
      parent.send({ to: "child", body: "next" }); c.result("a".repeat(19_000));
      c.ack(1); c.assistant("b".repeat(2000), "later"); c.result("b".repeat(2000)); c.exit();
    });
    const result = await s.result;
    expect(result.state).toBe("done"); expect(result.truncated).toBe(true);
    expect(result.output.endsWith("b".repeat(1000))).toBe(true);
    expect(result.output).not.toContain("b".repeat(1001));
  });

  it("keeps the raw stream byte ceiling across all results", async () => {
    const s = setup((c, parent) => {
      parent.send({ to: "child", body: "next" });
      c.emit({ type: "system", padding: "x".repeat(5 * 1024 * 1024) }); c.result();
      c.ack(1); c.emit({ type: "system", padding: "x".repeat(4 * 1024 * 1024) });
    });
    const result = await s.result;
    expect(result.state).toBe("failed"); expect(result.error).toMatch(/8 MiB bound/);
  });

  it("does not double-count cumulative assistant usage updates between results", async () => {
    const s = setup((c, parent) => {
      parent.send({ to: "child", body: "next" }); c.result("first", 1, 10, 0.2); c.ack(1);
      for (const output of [1, 2, 3]) c.emit({ type: "assistant", message: { id: "streamed", model: CLAUDE_CODE_MODEL, usage: { input_tokens: 20, output_tokens: output }, content: [{ type: "text", text: "more" }] } });
      c.result("second", 1, 20, 0.5); c.exit();
    });
    const result = await s.result;
    expect(result.usage.input).toBe(30); expect(result.usage.output).toBe(2); expect(result.usage.cost.total).toBe(0.5);
  });

  it("keeps aggregate turns, tokens, cumulative session cost across multiple results", async () => {
    const s = setup((c, parent) => {
      c.ack(0); parent.send({ to: "child", body: "next" });
      c.assistant("first", "a"); c.result("first", 2, 10, 0.2);
      c.ack(1); c.assistant("second", "b"); c.result("second", 3, 20, 0.5); c.exit();
    });
    const result = await s.result;
    expect(result.state).toBe("done"); expect(result.turns).toBe(5);
    expect(result.usage).toMatchObject({ input: 30, output: 2, totalTokens: 32, cost: { total: 0.5 } });
  });

  it("enforces aggregate turn budget instead of resetting at each result", async () => {
    const s = setup((c, parent) => {
      c.ack(0); parent.send({ to: "child", body: "next" }); c.result("first", 2);
      c.ack(1); c.result("second", 2);
    }, { maxTurns: 3 });
    const result = await s.result; expect(result.state).toBe("failed"); expect(result.error).toMatch(/3-turn limit/); expect(result.turns).toBe(4);
  });

  it.each(["cancel", "timeout", "stdin", "initial-stdin", "async-stdin", "exit-pending"])("cleans up binding/process on %s", async (mode) => {
    const abort = new AbortController();
    const s = setup((c, parent) => {
      if (mode === "initial-stdin") return;
      c.ack(0);
      if (mode === "cancel") abort.abort(new Error("cancelled"));
      else if (mode === "timeout") abort.abort(Object.assign(new Error("deadline"), { name: "TimeoutError" }));
      else if (mode === "async-stdin") for (const fn of c.errors) fn(new Error("EPIPE"));
      else {
        c.writeFailure = mode === "stdin";
        parent.send({ to: "child", body: "pending" });
        if (mode === "exit-pending") { c.result(); c.exit(); }
      }
    }, { abort, initialWriteFailure: mode === "initial-stdin" });
    const result = await s.result;
    expect(result.state).toBe(mode === "cancel" ? "aborted" : mode === "timeout" ? "timed_out" : "failed");
    const before = s.c.writes.length;
    expect(s.parent.send({ to: "child", body: "after cleanup" })).toMatchObject({ ok: true, status: "queued" });
    expect(s.c.writes).toHaveLength(before);
    if (mode !== "exit-pending") expect(s.c.signals.length).toBeGreaterThan(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  assertClaudeSubscriptionStatus,
  buildClaudeWorkerPrompt,
  claudeUsage,
  claudeWorkerArgs,
  claudeWorkerEnv,
  CLAUDE_CODE_ALLOWED_TOOLS,
  CLAUDE_CODE_MODEL,
  CLAUDE_CODE_ROUTE,
  createClaudeWorkerRunner,
  parseClaudeStreamLine,
  type ClaudeSpawnHandle,
} from "../src/subagents/claude-worker.ts";
import { emptyUsage, USAP_VERSION, type RunRecord, type TaskRecord, type WorkerRunner } from "../src/subagents/types.ts";

const OUTPUT_LIMIT = 20_000;

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: USAP_VERSION, id: "run-claude-test", goal: "Inspect the leaf", constraints: ["No writes"],
    cwd: "/repo", model: CLAUDE_CODE_ROUTE, harness: "claude-code", thinkingLevel: "xhigh",
    concurrency: 1, timeoutMs: 60_000, maxTurns: 8, background: false, state: "running",
    createdAt: 0, tasks: [], usage: emptyUsage(), ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "run-claude-test-task-1", label: "Inspect", task: "Report the routing entrypoint", role: "scout",
    mayEdit: false, ownedPaths: [], allowBash: false, state: "running", output: "",
    turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, ...overrides,
  };
}

class FakeClaudeProcess implements ClaudeSpawnHandle {
  private static nextPid = 4200;
  pid = FakeClaudeProcess.nextPid++;
  exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  errorListeners: Array<(error: Error) => void> = [];
  stdoutListeners: Array<(chunk: string) => void> = [];
  stderrListeners: Array<(chunk: string) => void> = [];
  stdinChunks: string[] = [];
  stdinEnded = false;
  signals: string[] = [];

  onExit(listener: (code: number | null, signal: string | null) => void) { this.exitListeners.push(listener); }
  onError(listener: (error: Error) => void) { this.errorListeners.push(listener); }
  onStdout(listener: (chunk: string) => void) { this.stdoutListeners.push(listener); }
  onStderr(listener: (chunk: string) => void) { this.stderrListeners.push(listener); }
  writeStdin(text: string) { this.stdinChunks.push(text); }
  endStdin() { this.stdinEnded = true; }
  kill(signal?: string) {
    this.signals.push(signal ?? "SIGTERM");
    if (signal === "SIGKILL") queueMicrotask(() => this.exit(null, "SIGKILL"));
    return true;
  }

  stdout(chunk: string) { for (const listener of this.stdoutListeners) listener(chunk); }
  stderr(chunk: string) { for (const listener of this.stderrListeners) listener(chunk); }
  exit(code: number | null = 0, signal: string | null = null) { for (const listener of this.exitListeners) listener(code, signal); }
  fail(error: Error) { for (const listener of this.errorListeners) listener(error); }
}

let messageSequence = 0;
function line(value: unknown): string {
  const record = value as { type?: string; message?: object };
  if (record?.type === "assistant" && record.message) {
    value = { ...record, message: { id: `test-message-${++messageSequence}`, model: CLAUDE_CODE_MODEL, ...record.message } };
  }
  return `${JSON.stringify(value)}\n`;
}

function successResult(text: string, usage: Record<string, number>, cost = 0.42): string {
  return line({
    type: "result", subtype: "success", is_error: false, result: text,
    usage: { input_tokens: usage.input ?? 0, output_tokens: usage.output ?? 0,
      cache_read_input_tokens: usage.cacheRead ?? 0, cache_creation_input_tokens: usage.cacheWrite ?? 0 },
    total_cost_usd: cost, num_turns: 1, modelUsage: { [CLAUDE_CODE_MODEL]: {} },
  });
}

interface SpawnRecord { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; child: FakeClaudeProcess }

/** Injected fake harness: scripts the synthetic process events. Never real inference. */
function fakeSpawn(script: (child: FakeClaudeProcess) => void): { spawn: NonNullable<Parameters<typeof createClaudeWorkerRunner>[0]>["spawn"]; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  return {
    calls,
    spawn: ({ command, args, env, cwd }) => {
      const child = new FakeClaudeProcess();
      calls.push({ command, args, env, cwd, child });
      queueMicrotask(() => script(child));
      return child;
    },
  };
}

const runnerOptions = (spawn: unknown, abortGraceMs = 20) =>
  ({ spawn: spawn as NonNullable<Parameters<typeof createClaudeWorkerRunner>[0]>["spawn"], abortGraceMs }) as Parameters<typeof createClaudeWorkerRunner>[0];

describe("claude-code worker CLI surface", () => {
  it("admits only an existing first-party subscription login", () => {
    const status = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" };
    expect(() => assertClaudeSubscriptionStatus(status)).not.toThrow();
    for (const bad of [null, {}, { ...status, loggedIn: false }, { ...status, authMethod: "api_key" }, { ...status, apiProvider: "bedrock" }, { ...status, subscriptionType: null }]) {
      expect(() => assertClaudeSubscriptionStatus(bad)).toThrow(/subscription/);
    }
  });

  it("never reports success after a result followed by a failed exit or incomplete frame", async () => {
    for (const tail of ["failed-exit", "incomplete"]) {
      const { spawn } = fakeSpawn((child) => {
        child.stdout(successResult("report", { input: 1 }));
        if (tail === "incomplete") child.stdout('{"type":');
        child.exit(tail === "failed-exit" ? 9 : 0);
      });
      const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
      expect(result.state).toBe("failed");
    }
  });

  it("does not duplicate final text and carries explicit truncation", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(line({ type: "assistant", message: { content: [{ type: "text", text: "report" }] } }));
      child.stdout(successResult("z".repeat(OUTPUT_LIMIT + 1), {})); child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(result.state).toBe("done"); expect(result.truncated).toBe(true);
    expect(result.output).not.toContain("report"); expect(result.output.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
  });

  it("pre-cancelled and mismatched routes never launch a process", async () => {
    const { spawn, calls } = fakeSpawn((child) => child.exit());
    const runner = createClaudeWorkerRunner(runnerOptions(spawn));
    const signal = new AbortController(); signal.abort();
    expect((await runner({ run: run(), task: task(), signal: signal.signal, onProgress: () => {} })).state).toBe("aborted");
    expect((await runner({ run: run({ model: "anthropic/other" }), task: task(), signal: new AbortController().signal, onProgress: () => {} })).state).toBe("failed");
    expect(calls).toHaveLength(0);
  });
  it("pins the exact operator-confirmed headless flags with the manifest model spelling", () => {
    expect(claudeWorkerArgs()).toEqual([
      "--print", "--output-format", "stream-json", "--verbose",
      "--model", "claude-opus-5-5", "--effort", "xhigh",
      "--no-session-persistence", "--permission-mode", "dontAsk",
      "--safe-mode", "--restricted", "--setting-sources", "", "--strict-mcp-config", "--tools", CLAUDE_CODE_ALLOWED_TOOLS,
    ]);
    // The read-only allowlist can never contain delegation, write or shell tools.
    for (const denied of ["Bash", "Write", "Edit", "NotebookEdit", "Task", "Agent", "WebFetch"]) {
      expect(CLAUDE_CODE_ALLOWED_TOOLS.split(",")).not.toContain(denied);
    }
    expect(CLAUDE_CODE_MODEL).toBe("claude-opus-5-5");
    expect(CLAUDE_CODE_ROUTE).toBe("claude-code/claude-opus-5-5");
  });

  it("passes the leaf prompt on stdin and never inherits API-key/billing override env", async () => {
    const { spawn, calls } = fakeSpawn((child) => child.exit(0));
    const runner = createClaudeWorkerRunner(runnerOptions(spawn));
    await runner({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(calls).toHaveLength(1);
    const { command, args, env, cwd, child } = calls[0];
    expect(command).toBe("claude");
    expect(cwd).toBe("/repo");
    const joined = args.join(" ");
    expect(joined).toContain("--no-session-persistence");
    expect(joined).toContain("--strict-mcp-config");
    expect(joined).toContain("--permission-mode dontAsk");
    expect(joined).not.toContain("bypassPermissions");
    // Prompt arrives on stdin, so task text can never be parsed as CLI flags.
    expect(child.stdinEnded).toBe(true);
    const prompt = child.stdinChunks.join("");
    expect(prompt).toContain("Report the routing entrypoint");
    expect(prompt).toContain("Read, Grep, Glob only");
    expect(prompt).toContain("No writes");
    // Explicit env allowlist: OAuth credentials ride HOME; billing overrides die.
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(Object.keys(env).some((key) => key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE"))).toBe(false);
  });

  it("claudeWorkerEnv strips every ANTHROPIC_/CLAUDE* override without mutating its input", () => {
    const base = { PATH: "/usr/bin", HOME: "/home/op", ANTHROPIC_API_KEY: "sk-leak",
      ANTHROPIC_BASE_URL: "https://evil.example", CLAUDE_CODE_USE_BEDROCK: "1", WEATHER: "rain" };
    const env = claudeWorkerEnv(base);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/op" });
    expect(base.ANTHROPIC_API_KEY).toBe("sk-leak");
  });
});

describe("claude-code worker stream handling", () => {
  it("counts streamed blocks from one response once and preserves cumulative usage", async () => {
    const { spawn, calls: records } = fakeSpawn((child) => {
      for (const usage of [{ input_tokens: 10, output_tokens: 1 }, { input_tokens: 10, output_tokens: 2 }, { output_tokens: 3 }]) {
        child.stdout(line({ type: "assistant", message: { id: "one-response", content: [{ type: "text", text: "fragment" }], usage } }));
      }
      child.stdout(successResult("final", { input: 10, output: 3 }));
      child.exit(0);
    });
    const progress: any[] = [];
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run({ maxTurns: 1 }), task: task(), signal: new AbortController().signal, onProgress: (p) => progress.push(p) });
    expect(result.state).toBe("done");
    expect(result.turns).toBe(1);
    expect(progress.filter((p) => p.usage).slice(0, 3).map((p) => [p.usage.input, p.usage.output])).toEqual([[10, 1], [10, 2], [10, 3]]);
    expect(records[0].args).toContain("--max-turns");
    expect(records[0].args[records[0].args.indexOf("--max-turns") + 1]).toBe("1");
  });

  it("retains observed tokens when a terminal result omits usage", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(line({ type: "assistant", message: { content: [], usage: { input_tokens: 10, output_tokens: 3 } } }));
      const final = JSON.parse(successResult("final", {}, 0.25));
      delete final.usage;
      child.stdout(line(final)); child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("done");
    expect(result.usage).toMatchObject({ input: 10, output: 3, totalTokens: 13, cost: { total: 0.25 } });
  });

  it("uses the authoritative result turn count", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(line({ ...JSON.parse(successResult("final", {})), num_turns: 3 }));
      child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run({ maxTurns: 4 }), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("done");
    expect(result.turns).toBe(3);
  });

  it.each(["init", "assistant", "result"])("refuses a different served model in %s metadata", async (kind) => {
    const { spawn } = fakeSpawn((child) => {
      const wrong = "claude-fable-5-1";
      child.stdout(line(kind === "init" ? { type: "system", subtype: "init", model: wrong }
        : kind === "assistant" ? { type: "assistant", message: { model: wrong, content: [] } }
        : { ...JSON.parse(successResult("untrusted", {})), modelUsage: { [wrong]: {} } }));
      child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/other than the pinned/);
  });

  it("refuses success with no served-model evidence", async () => {
    const { spawn } = fakeSpawn((child) => {
      const final = JSON.parse(successResult("unattested", {}));
      delete final.modelUsage;
      child.stdout(line(final)); child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/did not attest/);
  });

  it("classifies a success run, maps real result usage, and counts tools", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(line({ type: "system", subtype: "init" }));
      child.stdout(line({ type: "assistant", message: { content: [
        { type: "text", text: "Looking." }, { type: "tool_use", name: "Read", id: "t1" },
      ], usage: { input_tokens: 5, output_tokens: 2 } } }));
      child.stdout(line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } }));
      child.stdout(successResult("Evidence: done\nChanged paths: none", { input: 11, output: 7, cacheRead: 3, cacheWrite: 1 }));
      child.exit(0);
    });
    const progress: unknown[] = [];
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: (p) => progress.push(p) });
    expect(result.state).toBe("done");
    expect(result.output).toBe("Evidence: done\nChanged paths: none");
    expect(result.turns).toBe(1);
    expect(result.toolSuccesses).toBe(1);
    expect(result.toolErrors).toBe(0);
    expect(result.usage).toMatchObject({ input: 11, output: 7, cacheRead: 3, cacheWrite: 1, totalTokens: 22 });
    expect(result.usage.cost.total).toBeCloseTo(0.42, 6);
  });

  it("lets the terminal result usage replace accumulated assistant usage", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(line({ type: "assistant", message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 100, output_tokens: 50 } } }));
      child.stdout(line({ type: "assistant", message: { content: [{ type: "text", text: "b" }], usage: { input_tokens: 100, output_tokens: 50 } } }));
      child.stdout(successResult("final", { input: 7, output: 3 }, 0.05));
      child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(result.usage.input).toBe(7);
    expect(result.usage.totalTokens).toBe(10);
    expect(result.usage.cost.total).toBeCloseTo(0.05, 6);
  });

  it("fails closed on malformed stream output, kills the child, and never respawns", async () => {
    const { spawn, calls } = fakeSpawn((child) => {
      child.stdout("not json at all\n");
      child.stdout(successResult("never", {}));
      child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/malformed stream-json/);
    expect(calls[0].child.signals.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
  });

  it("fails on a nonzero exit without a result and on a silent zero exit", async () => {
    const crash = fakeSpawn((child) => { child.stderr("boom"); child.exit(3); });
    const crashed = await createClaudeWorkerRunner(runnerOptions(crash.spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(crashed.state).toBe("failed");
    expect(crashed.error).toContain("exited with code 3");

    const silent = fakeSpawn((child) => child.exit(0));
    const quiet = await createClaudeWorkerRunner(runnerOptions(silent.spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(quiet.state).toBe("failed");
    expect(quiet.error).toContain("no result event");
  });

  it("fails on an is_error result and on spawn failure", async () => {
    const errored = fakeSpawn((child) => {
      child.stdout(line({ type: "result", subtype: "error_max_turns", is_error: true }));
      child.exit(0);
    });
    const failed = await createClaudeWorkerRunner(runnerOptions(errored.spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("error_max_turns");

    const spawnFailure = fakeSpawn((child) => child.fail(new Error("spawn claude ENOENT")));
    const missing = await createClaudeWorkerRunner(runnerOptions(spawnFailure.spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(missing.state).toBe("failed");
    expect(missing.error).toContain("could not start");
  });

  it("reports cancel as aborted and deadline as timed_out, retaining bounded partial output", async () => {
    const cancelledByOperator = fakeSpawn((child) => {
      child.stdout(line({ type: "assistant", message: { content: [{ type: "text", text: "partial " }] } }));
    });
    const operator = new AbortController();
    const cancelled = createClaudeWorkerRunner(runnerOptions(cancelledByOperator.spawn))({ run: run(), task: task(), signal: operator.signal, onProgress: () => {} });
    await vi.waitFor(() => expect(cancelledByOperator.calls.length ? cancelledByOperator.calls[0].child.stdoutListeners.length : 0).toBeGreaterThan(0));
    operator.abort(new Error("Task aborted"));
    const cancelledResult = await cancelled;
    expect(cancelledResult.state).toBe("aborted");
    expect(cancelledResult.output).toContain("partial");

    const deadline = fakeSpawn(() => { /* never exits on its own */ });
    const timed = new AbortController();
    const timeoutRun = createClaudeWorkerRunner(runnerOptions(deadline.spawn, 5))({ run: run(), task: task(), signal: timed.signal, onProgress: () => {} });
    await vi.waitFor(() => expect(deadline.calls[0].child.exitListeners.length).toBeGreaterThan(0));
    timed.abort(Object.assign(new Error("Run deadline exceeded"), { name: "TimeoutError" }));
    const timedResult = await timeoutRun;
    expect(timedResult.state).toBe("timed_out");
    expect(deadline.calls[0].child.signals).toContain("SIGTERM");
    expect(deadline.calls[0].child.signals).toContain("SIGKILL");
  });

  it("enforces the run turn budget as a stable failed condition even if a success result follows", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(line({ type: "assistant", message: { content: [{ type: "text", text: "t1" }] } }));
      child.stdout(line({ type: "assistant", message: { content: [{ type: "text", text: "t2" }] } }));
      child.stdout(successResult("pretend done", {}));
      child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run({ maxTurns: 1 }), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(result.state).toBe("failed");
    expect(result.error).toContain("1-turn limit");
    expect(result.output).toContain("t1");
  });

  it("truncates oversized final output at the USAP 20,000-character limit", async () => {
    const long = "x".repeat(OUTPUT_LIMIT + 500);
    const { spawn } = fakeSpawn((child) => {
      child.stdout(successResult(long, {}));
      child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(OUTPUT_LIMIT);
  });

  it("refuses write-capable or bash tasks without spawning anything", async () => {
    const { spawn, calls } = fakeSpawn((child) => child.exit(0));
    const runner: WorkerRunner = createClaudeWorkerRunner(runnerOptions(spawn));
    for (const hostile of [task({ mayEdit: true, ownedPaths: ["/repo/a"] }), task({ allowBash: true })]) {
      const result = await runner({ run: run(), task: hostile, signal: new AbortController().signal, onProgress: () => {} });
      expect(result.state).toBe("failed");
      expect(result.error).toMatch(/read-only leaves only/);
    }
    for (const foreign of [run({ harness: undefined }), run({ harness: "pi" })]) {
      await expect(runner({ run: foreign, task: task(), signal: new AbortController().signal, onProgress: () => {} }))
        .rejects.toThrow(/harness 'claude-code'/);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses to signal a process whose captured identity changed", async () => {
    const rebinding = fakeSpawn((child) => {
      child.stdout(line({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }));
      // Simulate a handle rebinding to another process after launch.
      child.pid = 999_999;
    });
    const operator = new AbortController();
    const pending = createClaudeWorkerRunner(runnerOptions(rebinding.spawn, 5))({ run: run(), task: task(), signal: operator.signal, onProgress: () => {} });
    await vi.waitFor(() => expect(rebinding.calls[0].child.pid).toBe(999_999));
    operator.abort(new Error("Task aborted"));
    const result = await pending;
    expect(result.state).toBe("failed");
    expect(result.error).toContain("process identity");
    expect(rebinding.calls[0].child.signals).toHaveLength(0);
  });
});

describe("claude-code stream-json parsing", () => {
  it("maps assistant, tool_result, result and foreign events", () => {
    const assistant = parseClaudeStreamLine(line({ type: "assistant", message: { content: [{ type: "text", text: "a" }, { type: "tool_use", name: "Grep" }], usage: { input_tokens: 1 } } }));
    expect(assistant).toMatchObject({ kind: "assistant", text: "a", toolUses: ["Grep"] });
    const toolResult = parseClaudeStreamLine(line({ type: "user", message: { content: [{ type: "tool_result", is_error: true }] } }));
    expect(toolResult).toEqual({ kind: "tool_result", isError: true });
    const result = parseClaudeStreamLine(line({ type: "result", subtype: "success", is_error: false, result: "r", total_cost_usd: 1, num_turns: 2 }));
    expect(result).toMatchObject({ kind: "result", subtype: "success", isError: false, result: "r", totalCostUsd: 1, numTurns: 2 });
    expect(parseClaudeStreamLine(line({ type: "stream_event" }))).toEqual({ kind: "other" });
    expect(parseClaudeStreamLine("}}{{")).toEqual({ kind: "malformed" });
    expect(parseClaudeStreamLine("[1,2]")).toEqual({ kind: "malformed" });
  });

  it("collapses unknown usage fields to zero instead of inventing numbers", () => {
    expect(claudeUsage({ input_tokens: -5, output_tokens: "x" })).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(claudeUsage(undefined, 1.5).cost.total).toBe(1.5);
  });

  it("keeps the leaf prompt bounded and role-complete", () => {
    const prompt = buildClaudeWorkerPrompt(run(), task());
    expect(prompt).toContain("Run ID: run-claude-test");
    expect(prompt).toContain("Role: scout");
    expect(prompt).toContain("no relay tool");
    expect(prompt).toContain("Required final report");
  });
});

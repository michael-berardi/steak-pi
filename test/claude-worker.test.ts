import { Coordinator, workerJournal } from "../src/subagents/coordinator.ts";
import { Scheduler } from "../src/subagents/scheduler.ts";
import { NoopSlots } from "../src/subagents/machine-slots.ts";
import { describe, expect, it, vi } from "vitest";
import {
  assertClaudeSubscriptionStatus,
  buildClaudeWorkerContinuationPrompt,
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
import { diagnoseRun } from "../src/subagents/checkpoints.ts";
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
  it("synthetic: native image prompt names the staged Read contract, not inline attachments", () => {
    const selected = run({ selection: { provider: "claude-code", modelId: CLAUDE_CODE_MODEL, source: "override", harness: "claude-code", images: true, tools: true } });
    expect(buildClaudeWorkerPrompt(selected, task())).toContain("Image inspection uses native Read on image files staged under the run cwd");
    expect(buildClaudeWorkerPrompt(selected, task())).toContain("inline attachments and image relay are unsupported");
  });

  it.each(["stdout", "stderr"])("synthetic: %s diagnostic bound terminates the owned child", async (stream) => {
    const { spawn, calls } = fakeSpawn((child) => {
      if (stream === "stdout") child.stdout("x".repeat(8 * 1024 * 1024 + 1));
      else child.stderr("x".repeat(64_001));
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(stream === "stdout" ? /8 MiB bound/ : /bounded diagnostic limit/);
    expect(calls[0].child.signals).toContain("SIGKILL");
    expect(result.output).toBe("");
  });

  it.each([
    ["You have hit your session limit; resets 11pm (America/Port-au-Prince) secret-token", undefined, /quota limit reached; resets 11pm \(America\/Port-au-Prince\)/],
    ["resets 1pm (Etc/GMT+3) secret-token", "usage_limit_reached", /quota limit reached; resets 1pm \(Etc\/GMT\+3\)/],
    ["fetch failed secret-token", undefined, /transport failure/],
    ["unrecognized secret-token", undefined, /unrecognized CLI error/],
  ])("synthetic: error results retain only bounded safe cause for %s", async (text, error, expected) => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(line({ type: "result", subtype: "error_during_execution", is_error: true, result: text, error, modelUsage: { [CLAUDE_CODE_MODEL]: {} } }));
      child.exit();
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed"); expect(result.error).toMatch(expected);
    expect(result.error).not.toContain("secret-token"); expect(result.output).toBe("");
    const diagnosed = diagnoseRun(run({ tasks: [task({ state: "failed", error: result.error })] })).tasks[0];
    expect(diagnosed.reason).toBe(text.includes("fetch failed") ? "transport" : text.includes("unrecognized") ? "worker_failure" : "provider_quota");
  });

  it("synthetic: read-only reviewers never get Bash even when requested, including resumed sessions", async () => {
    const reviewer = task({ role: "reviewer", allowBash: true });
    for (const resumed of [false, true]) {
      const leaf = { ...reviewer, ...(resumed ? { claudeSessionId: "0b5e1c2a-1111-4222-8333-944455556666" } : {}) };
      const { spawn, calls } = fakeSpawn((child) => { child.stdout(successResult("review complete", {})); child.exit(); });
      const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: leaf, signal: new AbortController().signal, onProgress: () => {} });
      expect(calls[0].args[calls[0].args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
      expect(calls[0].args).not.toContain("--allowedTools");
      expect(calls[0].child.stdinChunks.join("")).toContain("claude-review-shell-suppressed");
      expect(result.output).toContain("claude-review-shell-suppressed");
      expect(result.output).toContain("review complete");
      expect(result.state).toBe("done");
    }
    expect(claudeWorkerArgs(8, { role: "worker", allowBash: true })).toContain("Bash");
    expect(claudeWorkerArgs(8, { role: "reviewer", mayEdit: true, ownedPaths: ["/repo/owned"], allowBash: true })).toContain("Bash");
  });

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

  it("resumes a cut-off worker's own Claude session with a continuation prompt, never the leaf prompt", async () => {
    const id = "0b5e1c2a-1111-4222-8333-944455556666";
    const progress: Array<{ claudeSessionId?: string }> = [];
    const { spawn, calls } = fakeSpawn((child) => child.exit(0));
    await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: { ...task(), claudeSessionId: id }, signal: new AbortController().signal, onProgress: (p) => progress.push(p) });
    const joined = calls[0].args.join(" ");
    expect(joined).toContain(`--resume ${id}`);
    expect(joined).not.toContain("--session-id");
    const prompt = calls[0].child.stdinChunks.join("");
    expect(prompt).toContain("was resumed from its history");
    expect(prompt).not.toContain("Report the routing entrypoint");
    // A shell-only leaf owns no paths; the resume must not tell it to stop writing (live test 2026-10-04).
    expect(prompt).not.toMatch(/read-only/i);
    expect(prompt).toContain("permissions are exactly those of the original assignment");
    expect(progress[0]).toEqual({ claudeSessionId: id });
    expect(() => claudeWorkerArgs(undefined, {}, undefined, "claude-sonnet-5-5", { id: "../../etc", resume: true })).toThrow(/lowercase UUID/);
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
    expect(joined).toMatch(/--session-id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} /);
    expect(joined).not.toContain("--resume");
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

describe("claude-code synthetic CLI failures (offline stream envelopes)", () => {
  const sonnet = "claude-sonnet-5-5";
  const sonnetRun = () => run({ model: `claude-code/${sonnet}` });
  const synthetic = (text: string, extra: Record<string, unknown> = {}) => line({
    type: "assistant", session_id: "fixture-session", parent_tool_use_id: null, ...extra,
    message: { id: "synthetic-message", type: "message", role: "assistant", model: "<synthetic>",
      content: [{ type: "text", text }], stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 } },
  });
  const final = (model?: string) => line({ type: "result", subtype: "success", is_error: false,
    result: "review", num_turns: 1, ...(model ? { modelUsage: { [model]: {} } } : {}) });

  it.each([
    ["You've hit your weekly limit · resets Oct 7 at 5pm (America/New_York)", /quota limit reached; resets Oct 7 at 5pm \(America\/New_York\)/],
    ["You've hit your session limit · resets 1pm (America/New_York)", /quota limit reached; resets 1pm \(America\/New_York\); check Claude usage/],
    ["You've hit your session limit · resets 11pm", /quota limit reached; resets 11pm; check Claude usage/],
    ["Session limit reached · resets 11:30pm (Europe/London)", /quota limit reached; resets 11:30pm \(Europe\/London\); check Claude usage/],
    ["You've hit your 5-hour limit", /quota limit reached; check Claude usage and retry the same route only after reset/],
    ["Session limit reached", /quota limit reached; check Claude usage and retry the same route only after reset/],
    ["API Error: 429 rate limit https://private.invalid?token=secret", /rate limit reached; retry with bounded backoff/],
    ["Invalid API key · Please run /login sk-ant-secret https://private.invalid?token=secret", /authentication failed/],
    ["API Error: Connection error. ECONNRESET https://private.invalid?token=secret", /transport failure/],
    ["Unexpected local failure sk-ant-secret https://private.invalid?token=secret", /unrecognized synthetic error \(fail closed\)/],
  ])("reports bounded sanitized cause without treating %s as inference", async (text, cause) => {
    const { spawn, calls } = fakeSpawn((child) => {
      child.stdout(line({ type: "system", subtype: "init", model: sonnet }));
      child.stdout(synthetic(text)); child.exit(1);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: sonnetRun(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed"); expect(result.error).toMatch(cause);
    expect(result.error).toContain("synthetic frame is not a model response or approval");
    expect(result.error).not.toMatch(/sk-ant-secret|private\.invalid|token=secret|not the pinned/);
    expect(result.error!.length).toBeLessThan(400);
    expect(result.output).toBe(""); expect(result.turns).toBe(0);
    expect(result.usage).toEqual(emptyUsage()); expect(calls).toHaveLength(1);
    expect(calls[0].args.join(" ")).toContain("--model claude-sonnet-5-5 --effort xhigh");
  });

  it("keeps transient rate limits distinct from subscription quota exhaustion", async () => {
    const { spawn } = fakeSpawn((child) => { child.stdout(synthetic("Rate limit exceeded 429")); child.exit(1); });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: sonnetRun(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed");
    expect(result.error).toContain("rate limit reached; retry with bounded backoff");
    expect(result.error).not.toMatch(/quota|after reset/);
    expect(result.turns).toBe(0); expect(result.output).toBe("");
  });

  it("gives a usage-check action for unknown errors and a reset-only retry for quota", async () => {
    for (const [text, action] of [
      ["You've hit your weekly limit", "check Claude usage and retry the same route only after reset"],
      ["Unexpected local failure", "check Claude usage before debugging"],
    ]) {
      const { spawn } = fakeSpawn((child) => { child.stdout(synthetic(text)); child.exit(1); });
      const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: sonnetRun(), task: task(), signal: new AbortController().signal, onProgress() {} });
      expect(result.state).toBe("failed"); expect(result.error).toContain(action);
      expect(result.error).not.toContain("resets");
    }
  });

  it("does not echo controls, arbitrary diagnostic suffixes or oversized text", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(synthetic("You've hit your weekly limit · resets Oct 7 at 5pm (America/New_York)\u001b[31m " + "secret".repeat(2000)));
      child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: sonnetRun(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed"); expect(result.error).toContain("resets Oct 7 at 5pm (America/New_York)");
    expect(result.error).not.toMatch(/secret|\u001b/); expect(result.error!.length).toBeLessThan(400);
  });

  it.each(["same-chunk", "later-chunk"])("synthetic then genuine remains terminal FAILED (%s)", async (delivery) => {
    const genuine = line({ type: "assistant", message: { id: "genuine-message", model: sonnet, content: [{ type: "text", text: "approved" }] } }) + final(sonnet);
    const { spawn } = fakeSpawn((child) => {
      if (delivery === "same-chunk") child.stdout(synthetic("You've hit your weekly limit") + genuine);
      else { child.stdout(synthetic("You've hit your weekly limit")); child.stdout(genuine); }
      child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: sonnetRun(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed"); expect(result.error).toContain("quota limit reached");
    expect(result.output).toBe(""); expect(result.turns).toBe(0); expect(result.usage).toEqual(emptyUsage());
  });

  const quotaError = (reset = "") =>
    `Claude CLI synthetic error: quota limit reached${reset}; check Claude usage and retry the same route only after reset; synthetic frame is not a model response or approval`;
  const apiErrorMarker = { error: { type: "api_error", error: { type: "usage_limit_reached", message: "sk-ant-secret https://private.invalid?token=secret" } } };
  const failedSynthetic = async (frame: string, tail = "") => {
    const { spawn } = fakeSpawn((child) => { child.stdout(frame + tail); child.exit(1); });
    return createClaudeWorkerRunner(runnerOptions(spawn))({ run: sonnetRun(), task: task(), signal: new AbortController().signal, onProgress() {} });
  };

  it("parses usage-limit error metadata into a boolean marker without retaining raw error text", () => {
    const assistant = (extra: object, message: object = {}) => parseClaudeStreamLine(line({ type: "assistant", ...extra, message: { content: [], ...message } }));
    for (const marked of [
      assistant({ error: "usage_limit_reached" }),
      assistant({ error: "api_error usage_limit_reached" }),
      assistant(apiErrorMarker),
      assistant({}, { error: { type: "usage_limit_reached" } }),
    ]) {
      expect(marked).toMatchObject({ kind: "assistant", usageLimit: true });
      expect(JSON.stringify(marked)).not.toMatch(/sk-ant-secret|private\.invalid/);
    }
    for (const unmarked of [assistant({}), assistant({ error: "rate_limit" }), assistant({ error: { type: "api_error" } }),
      assistant({ error: "xusage_limit_reachedx" }), assistant({ error: ["usage_limit_reached"] }),
      assistant({ error: { error: { error: { error: { error: "usage_limit_reached" } } } } }), assistant({ error: `${"x ".repeat(200)}usage_limit_reached` })]) {
      expect(unmarked).not.toHaveProperty("usageLimit");
    }
  });

  it.each([
    ["string error", { error: "usage_limit_reached" }],
    ["api_error token", { error: "api_error usage_limit_reached" }],
    ["nested api_error object", apiErrorMarker],
  ])("reports a fixed quota cause from %s metadata when the text lacks limit words", async (_shape, extra) => {
    const result = await failedSynthetic(synthetic("Unexpected local failure sk-ant-secret https://private.invalid?token=secret", extra));
    expect(result.state).toBe("failed"); expect(result.error).toBe(quotaError());
    expect(result.error).not.toMatch(/secret|private\.invalid|unrecognized/);
    expect(result.output).toBe(""); expect(result.turns).toBe(0); expect(result.usage).toEqual(emptyUsage());
  });

  it("combines marker-only quota cause with a bounded reset in time-only or dated text", async () => {
    for (const [text, reset] of [
      ["resets 1pm (America/New_York)", "; resets 1pm (America/New_York)"],
      ["resets 11pm", "; resets 11pm"],
      ["resets Oct 7 at 5pm (America/New_York)", "; resets Oct 7 at 5pm (America/New_York)"],
    ]) {
      const result = await failedSynthetic(synthetic(text, { error: "usage_limit_reached" }));
      expect(result.state).toBe("failed"); expect(result.error).toBe(quotaError(reset));
    }
  });

  it.each([
    ["rate_limit", { error: "rate_limit" }],
    ["api_error without a limit token", { error: { type: "api_error", message: "overloaded" } }],
    ["near-miss token", { error: "xusage_limit_reachedx" }],
    ["array-wrapped token", { error: ["usage_limit_reached"] }],
  ])("does not claim quota exhaustion for unrelated %s metadata", async (_shape, extra) => {
    const result = await failedSynthetic(synthetic("Unexpected local failure", extra));
    expect(result.state).toBe("failed"); expect(result.error).toMatch(/unrecognized synthetic error \(fail closed\)/);
    expect(result.error).not.toMatch(/quota|after reset/);
  });

  it.each([
    ["trailing secrets after a zone", "resets 1pm (America/New_York) sk-ant-secret https://private.invalid?token=secret", "; resets 1pm (America/New_York)"],
    ["trailing secrets after a bare time", "resets 11pm sk-ant-secret https://private.invalid?token=secret", "; resets 11pm"],
    ["a non-zone parenthetical", "resets 11pm (Evil/Zone;curl https://private.invalid?token=secret)", ""],
    ["a path-traversal zone", "resets Oct 7 at 5pm (America/New_York/../../etc/passwd)", ""],
    ["a glued suffix", "resets 11pmsk-ant-secret", ""],
    ["an impossible hour", "resets 25pm (America/New_York)", ""],
    ["a control-character split", "resets\u001b[31m 1pm (America/New_York)", ""],
  ])("never echoes malicious reset text: %s", async (_shape, suffix, reset) => {
    const result = await failedSynthetic(synthetic(`You've hit your session limit · ${suffix}`));
    expect(result.state).toBe("failed"); expect(result.error).toBe(quotaError(reset));
    expect(result.error).not.toMatch(/secret|private\.invalid|token=|curl|passwd|\u001b/);
    expect(result.output).toBe(""); expect(result.turns).toBe(0); expect(result.usage).toEqual(emptyUsage());
  });

  it.each([
    ["marker-only", synthetic("Unexpected local failure", { error: "usage_limit_reached" }), ""],
    ["time-only reset", synthetic("You've hit your session limit · resets 1pm (America/New_York)"), "; resets 1pm (America/New_York)"],
    ["bare time reset", synthetic("You've hit your session limit · resets 11pm"), "; resets 11pm"],
    ["marker with reset", synthetic("resets 11pm (America/New_York)", apiErrorMarker), "; resets 11pm (America/New_York)"],
  ].flatMap(([name, frame, reset]) => ["same-chunk", "later-chunk"].map((delivery) => [`${name} ${delivery}`, delivery, frame, reset] as const)))(
    "quota synthetic then genuine success remains terminal FAILED (%s)", async (_name, delivery, frame, reset) => {
      const genuine = line({ type: "assistant", message: { id: "genuine-message", model: sonnet, content: [{ type: "text", text: "approved" }] } }) + final(sonnet);
      const { spawn } = fakeSpawn((child) => {
        if (delivery === "same-chunk") child.stdout(frame + genuine);
        else { child.stdout(frame); child.stdout(genuine); }
        child.exit(0);
      });
      const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: sonnetRun(), task: task(), signal: new AbortController().signal, onProgress() {} });
      expect(result.state).toBe("failed"); expect(result.error).toBe(quotaError(reset));
      expect(result.output).toBe(""); expect(result.turns).toBe(0); expect(result.usage).toEqual(emptyUsage());
    });

  it.each(["init-only", "init-and-success", "no-model-success", "synthetic-usage"])("never approves %s", async (shape) => {
    const { spawn } = fakeSpawn((child) => {
      if (shape.startsWith("init")) child.stdout(line({ type: "system", subtype: "init", model: sonnet }));
      if (shape !== "init-only") child.stdout(final(shape === "synthetic-usage" ? "<synthetic>" : undefined));
      child.exit(0);
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: sonnetRun(), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed");
  });

  it("accepts a genuine pinned assistant plus success but rejects a real different model", async () => {
    for (const servedModel of [sonnet, "claude-opus-5-5"]) {
      const { spawn } = fakeSpawn((child) => {
        child.stdout(line({ type: "assistant", message: { id: "real-message", model: servedModel, content: [{ type: "text", text: "review" }] } }));
        child.stdout(final()); child.exit(0);
      });
      const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: sonnetRun(), task: task(), signal: new AbortController().signal, onProgress() {} });
      expect(result.state).toBe(servedModel === sonnet ? "done" : "failed");
      if (servedModel !== sonnet) expect(result.error).toMatch(/claude-opus-5-5, not the pinned Sonnet 5.5 route/);
    }
  });
});

describe("claude-code worker automatic resume safety", () => {
  it.each(["wrong model", "missing ID", "turn limit", "error result"])("synthetic: later complete lines/chunks cannot replace terminal %s cause", async (kind) => {
    const { spawn } = fakeSpawn((child) => {
      const first = kind === "wrong model" ? line({ type: "system", subtype: "init", model: "claude-fable-5-1" })
        : kind === "missing ID" ? JSON.stringify({ type: "assistant", message: { model: CLAUDE_CODE_MODEL, content: [] } }) + "\n"
        : kind === "turn limit" ? line({ type: "assistant", message: { content: [] } }) + line({ type: "assistant", message: { content: [] } })
        : line({ type: "result", subtype: "error_during_execution", is_error: true, result: "fetch failed" });
      // An early terminal return leaves complete lines in the buffered tail.
      child.stdout(first + successResult("ignored-success-1", {}));
      child.stdout(successResult("ignored-success-2", {}));
      child.exit();
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run({ maxTurns: 1 }), task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(kind === "wrong model" ? /not the pinned/ : kind === "missing ID" ? /stable message ID/ : kind === "turn limit" ? /exhausted the 1-turn limit/ : /transport failure/);
    expect(result.error).not.toContain("malformed stream-json");
    expect(result.output).not.toContain("ignored-success");
  });

  it("gives the resumed CLI only remaining --max-turns and retains the original run budget", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const { spawn, calls } = fakeSpawn((child) => {
        if (++attempt === 1) {
          for (let turn = 0; turn < 3; turn += 1) child.stdout(line({ type: "assistant", message: { content: [] } }));
          child.stdout('{"type":'); child.exit(0);
        } else {
          child.stdout(successResult("finished", {})); child.exit(0);
        }
      });
      const coordinator = new Coordinator(createClaudeWorkerRunner(runnerOptions(spawn)), { scheduler: new Scheduler(1), machineSlots: new NoopSlots() });
      const record = run({ maxTurns: 4, timeoutMs: 30 * 60_000, tasks: [task({ state: "queued" })] });
      coordinator.start(record);
      await vi.advanceTimersByTimeAsync(10_000);
      const settled = await coordinator.wait(record.id, "all");
      expect(calls.map(({ args }) => args[args.indexOf("--max-turns") + 1])).toEqual(["4", "1"]);
      expect(calls[1].args).toContain("--resume");
      expect(settled.tasks[0].turns).toBe(4);
      expect(settled.tasks[0].state).toBe("done");
      expect(settled.maxTurns).toBe(4);
      expect(record.maxTurns).toBe(4);
      await coordinator.shutdown();
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ["wrong model", line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }), /pinned Opus/],
    ["malformed", "{bad-json}\n", /malformed stream-json/],
    ["missing message ID", JSON.stringify({ type: "assistant", message: { model: CLAUDE_CODE_MODEL, content: [] } }) + "\n", /stable message ID/],
  ])("never respawns after %s followed by a partial frame", async (_name, frame, error) => {
    vi.useFakeTimers();
    try {
      const { spawn, calls } = fakeSpawn((child) => {
        child.stdout(frame + '{"type":'); child.exit(null, "SIGTERM");
      });
      const coordinator = new Coordinator(createClaudeWorkerRunner(runnerOptions(spawn)), { scheduler: new Scheduler(1), machineSlots: new NoopSlots() });
      const record = run({ timeoutMs: 30 * 60_000, tasks: [task({ state: "queued" })] });
      coordinator.start(record);
      await vi.advanceTimersByTimeAsync(60_000);
      const settled = await coordinator.wait(record.id, "all");
      expect(calls).toHaveLength(1);
      expect(settled.tasks[0].state).toBe("failed");
      expect(settled.tasks[0].error).toMatch(error);
      expect(settled.tasks[0].autoResumes).toBeUndefined();
      await coordinator.shutdown();
    } finally { vi.useRealTimers(); }
  });

  it("reports explicit turn exhaustion instead of a kill-induced partial tail", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(line({ type: "assistant", message: { content: [] } }));
      child.stdout(line({ type: "assistant", message: { content: [] } }) + '{"type":');
      child.exit(null, "SIGTERM");
    });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run({ maxTurns: 1 }), task: task(), signal: new AbortController().signal, onProgress: () => {} });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/exhausted the 1-turn limit/);
    expect(result.error).not.toMatch(/incomplete stream-json/);
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
    expect(result.error).toMatch(/claude-fable-5-1, not the pinned/);
  });

  it("spawns Sonnet 5.5 for a Sonnet route and refuses an Opus-attested stream on it", async () => {
    expect(claudeWorkerArgs(undefined, {}, undefined, "claude-sonnet-5-5")).toContain("claude-sonnet-5-5");
    const sonnet = run({ model: "claude-code/claude-sonnet-5-5" });
    const served = fakeSpawn((child) => {
      child.stdout(line({ ...JSON.parse(successResult("sonnet report", {})), modelUsage: { "claude-sonnet-5-5": {} } }));
      child.exit(0);
    });
    const ok = await createClaudeWorkerRunner(runnerOptions(served.spawn))({ run: sonnet, task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(ok.state).toBe("done");
    expect(served.calls[0].args.join(" ")).toContain("--model claude-sonnet-5-5 --effort xhigh");
    const swapped = fakeSpawn((child) => {
      child.stdout(line({ ...JSON.parse(successResult("opus report", {})), modelUsage: { "claude-opus-5-5": {} } }));
      child.exit(0);
    });
    const refused = await createClaudeWorkerRunner(runnerOptions(swapped.spawn))({ run: sonnet, task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(refused.state).toBe("failed");
    expect(refused.error).toMatch(/claude-opus-5-5, not the pinned Sonnet 5.5 route/);
  });

  it("accepts Claude's Haiku helper in the result usage and sidechain frames, never as the worker's own turn", async () => {
    const sonnet = run({ model: "claude-code/claude-sonnet-5-5" });
    const helper = "claude-haiku-4-5-20251001";
    // Real stream from a WebFetch run (2026-10-04): the summary call adds Haiku to modelUsage.
    const served = fakeSpawn((child) => {
      child.stdout(line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }));
      child.stdout(line({ type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "m-side", model: helper, content: [] } }));
      child.stdout(line({ ...JSON.parse(successResult("title", {})), modelUsage: { "claude-sonnet-5-5": {}, [helper]: {} } }));
      child.exit(0);
    });
    const ok = await createClaudeWorkerRunner(runnerOptions(served.spawn))({ run: sonnet, task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(ok.state).toBe("done");
    const ownTurn = fakeSpawn((child) => {
      child.stdout(line({ type: "assistant", message: { id: "m1", model: helper, content: [] } }));
      child.exit(0);
    });
    const refused = await createClaudeWorkerRunner(runnerOptions(ownTurn.spawn))({ run: sonnet, task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(refused.state).toBe("failed");
    expect(refused.error).toMatch(/claude-haiku-4-5-20251001, not the pinned Sonnet 5.5 route/);
    const helperOnly = fakeSpawn((child) => {
      child.stdout(line({ ...JSON.parse(successResult("x", {})), modelUsage: { [helper]: {} } }));
      child.exit(0);
    });
    const noPinned = await createClaudeWorkerRunner(runnerOptions(helperOnly.spawn))({ run: sonnet, task: task(), signal: new AbortController().signal, onProgress() {} });
    expect(noPinned.state).toBe("failed");
    expect(noPinned.error).toMatch(/usage shows no turn on the pinned Sonnet 5.5 route/);
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

  it("grants write and shell tools only with CLI-enforced ownership rules", async () => {
    const { spawn, calls } = fakeSpawn((child) => child.exit(0));
    const runner: WorkerRunner = createClaudeWorkerRunner(runnerOptions(spawn));
    await runner({ run: run(), task: task({ mayEdit: true, ownedPaths: ["/repo/a"] }), signal: new AbortController().signal, onProgress: () => {} });
    await runner({ run: run(), task: task({ allowBash: true }), signal: new AbortController().signal, onProgress: () => {} });
    expect(calls).toHaveLength(2);
    const [edit, bash] = calls.map((call) => call.args);
    expect(edit.slice(edit.indexOf("--tools") + 1, edit.indexOf("--tools") + 2)).toEqual(["Read,Grep,Glob,Edit,Write,NotebookEdit"]);
    expect(edit).toContain("Edit(//repo/a)");
    expect(edit).toContain("Edit(//repo/a/**)");
    expect(edit).not.toContain("Bash");
    expect(edit).toContain("dontAsk");
    expect(bash.slice(bash.indexOf("--tools") + 1, bash.indexOf("--tools") + 2)).toEqual(["Read,Grep,Glob,Bash"]);
    expect(bash.slice(bash.indexOf("--allowedTools") + 1)).toEqual(["Bash"]);
    expect(calls[0].child.stdinChunks.join("")).toContain("May edit: yes");
    expect(calls[0].child.stdinChunks.join("")).toContain("- /repo/a");
  });

  it("journals successful edits as changed paths and skips denied ones", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(line({ type: "assistant", message: { content: [
        { type: "tool_use", id: "t-ok", name: "Write", input: { file_path: "/repo/a/out.txt", content: "x" } },
        { type: "tool_use", id: "t-denied", name: "Write", input: { file_path: "/repo/other.txt", content: "y" } },
        { type: "tool_use", id: "t-read", name: "Read", input: { file_path: "/repo/seed.txt" } },
      ] } }));
      child.stdout(line({ type: "user", message: { content: [
        { type: "tool_result", tool_use_id: "t-ok", is_error: false },
        { type: "tool_result", tool_use_id: "t-denied", is_error: true },
        { type: "tool_result", tool_use_id: "t-read", is_error: false },
      ] } }));
      child.stdout(successResult("report", {}));
      child.exit(0);
    });
    const leaf = task({ mayEdit: true, ownedPaths: ["/repo/a"] });
    const result = await createClaudeWorkerRunner(runnerOptions(spawn))({ run: run(), task: leaf, signal: new AbortController().signal, onProgress: () => {} });
    expect(result.state).toBe("done");
    expect([...workerJournal(leaf).changedPaths]).toEqual(["/repo/a/out.txt"]);
    expect(result.toolErrors).toBe(1);
  });

  it("refuses ownership it cannot express exactly, without spawning anything", async () => {
    const { spawn, calls } = fakeSpawn((child) => child.exit(0));
    const runner: WorkerRunner = createClaudeWorkerRunner(runnerOptions(spawn));
    for (const hostile of [task({ mayEdit: true, ownedPaths: ["/repo/a*"] }), task({ mayEdit: true, ownedPaths: ["relative"] }),
      task({ mayEdit: true, ownedPaths: [] }), task({ ownedPaths: ["/repo/a"] }), task({ sessionFile: "/x.jsonl" })]) {
      const result = await runner({ run: run(), task: hostile, signal: new AbortController().signal, onProgress: () => {} });
      expect(result.state).toBe("failed");
    }
    expect(calls).toHaveLength(0);
    const { spawn: spawn2, calls: calls2 } = fakeSpawn((child) => child.exit(0));
    const runner2: WorkerRunner = createClaudeWorkerRunner(runnerOptions(spawn2));
    for (const foreign of [run({ harness: undefined }), run({ harness: "pi" })]) {
      await expect(runner2({ run: foreign, task: task(), signal: new AbortController().signal, onProgress: () => {} }))
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
    expect(toolResult).toEqual({ kind: "tool_result", isError: true, results: [] });
    const result = parseClaudeStreamLine(line({ type: "result", subtype: "success", is_error: false, result: "r", total_cost_usd: 1, num_turns: 2 }));
    expect(result).toMatchObject({ kind: "result", subtype: "success", isError: false, result: "r", totalCostUsd: 1, numTurns: 2 });
    expect(parseClaudeStreamLine(line({ type: "stream_event" }))).toEqual({ kind: "other" });
    expect(parseClaudeStreamLine("}}{{")).toEqual({ kind: "malformed" });
    expect(parseClaudeStreamLine("[1,2]")).toEqual({ kind: "malformed" });
    // Synthetic malformed shape: missing subtype never reaches classification.
    expect(parseClaudeStreamLine(JSON.stringify({ type: "result", is_error: false, result: "unattested" }))).toEqual({ kind: "malformed" });
  });

  it("collapses unknown usage fields to zero instead of inventing numbers", () => {
    expect(claudeUsage({ input_tokens: -5, output_tokens: "x" })).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(claudeUsage(undefined, 1.5).cost.total).toBe(1.5);
  });

  it("tells a Claude child its request budget up front, since stdin closes after the prompt", () => {
    const budgeted = { ...run(), maxTurns: 9 };
    const prompt = buildClaudeWorkerPrompt(budgeted, task());
    expect(prompt).toContain("at most 9 assistant requests");
    expect(prompt).toMatch(/when about 2 remain, stop gathering evidence and write your findings so far plus a precise remaining-work list/);
    expect(prompt).toContain("cannot interrupt you mid-run");
    expect(buildClaudeWorkerContinuationPrompt(task(), 9)).toContain("at most 9 assistant requests");
    expect(buildClaudeWorkerContinuationPrompt(task())).not.toContain("assistant requests");
  });

  it("keeps the leaf prompt bounded and role-complete", () => {
    const prompt = buildClaudeWorkerPrompt(run(), task());
    expect(prompt).toContain("Run ID: run-claude-test");
    expect(prompt).toContain("Role: scout");
    expect(prompt).toContain("no relay tool");
    expect(prompt).toContain("Required final report");
  });
});

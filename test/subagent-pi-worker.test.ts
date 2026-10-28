import { isQuotaLaunchFailure } from "../src/subagents/provider-quota.ts";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PI_WORKER_TURNS,
  buildPiWorkerContinuationPrompt,
  buildPiWorkerSystemPrompt,
  isFinalAnswer,
  mergeFinalReport,
  classifyPiWorkerState,
  compactionOrRetryPhase,
  createChainFallbackReporter,
  createGuardedPiWorkerTools,
  createIsolatedResourceLoader,
  createPiWorkerRunner,
  piWorkerTurnWarningAt,
  truncatePiWorkerOutput,
  workerChainFallback,
  workerTurnBudget,
  type PiWorkerSession,
} from "../src/subagents/pi-worker.ts";
import {
  AUTOMATIC_CHAIN_APPROVAL,
  DEFAULT_MULTIMODAL_WORKER_CHAIN,
  DEFAULT_TEXT_WORKER_CHAIN,
} from "../src/model-route-policy.ts";
import { isolatedCodexAgentDir, isolatedAgentPaths } from "../src/subagents/provider-accounts.ts";
import { RelayBroker } from "../src/subagents/relay.ts";
import { TURN_BUDGET_NOTICE_REMAINING, turnBudgetNotice } from "../src/subagents/turn-budget.ts";
import {
  DEFAULT_MAX_TURNS,
  MAX_MAX_TURNS,
  MAX_WORKER_TURNS,
  OUTPUT_LIMIT,
  USAP_VERSION,
  emptyUsage,
  type RunRecord,
  type TaskRecord,
  type UsageTotals,
  type WorkerProgress,
} from "../src/subagents/types.ts";

function usage(seed = 1): UsageTotals {
  return {
    input: seed,
    output: seed * 2,
    cacheRead: seed * 3,
    cacheWrite: seed * 4,
    totalTokens: seed * 10,
    cost: {
      input: seed / 100,
      output: seed / 50,
      cacheRead: seed / 200,
      cacheWrite: seed / 100,
      total: seed * 0.045,
    },
  };
}

function task(runId = "run-test", overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: `${runId}-task-1`,
    label: "worker leaf",
    task: "Inspect the target and make the bounded change.",
    role: "worker",
    mayEdit: false,
    ownedPaths: [],
    allowBash: false,
    state: "running",
    output: "",
    turns: 0,
    usage: emptyUsage(),
    relaySent: 0,
    relayReceived: 0,
    truncated: false,
    ...overrides,
  };
}

function run(cwd: string, recordTask: TaskRecord, maxTurns = DEFAULT_MAX_TURNS): RunRecord {
  return {
    version: USAP_VERSION,
    id: "run-test",
    goal: "Ship one bounded worker implementation",
    constraints: ["Do not edit tests owned by peers"],
    contract: "Return exact changed paths and focused checks",
    cwd,
    model: "fake/model",
    thinkingLevel: "low",
    concurrency: 1,
    timeoutMs: 10_000,
    maxTurns,
    background: false,
    state: "running",
    createdAt: 1,
    tasks: [recordTask],
    usage: emptyUsage(),
  };
}

function assistant(text: string, stopReason = "stop", value = usage()) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: value,
    stopReason,
    timestamp: Date.now(),
  };
}

class FakeSession implements PiWorkerSession {
  isStreaming = false;
  disposed = false;
  abortCalls = 0;
  prompts: Array<{ text: string; options?: { expandPromptTemplates?: boolean } }> = [];
  steers: string[] = [];
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  onPrompt: (session: FakeSession) => Promise<void> = async () => {};

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void> {
    this.prompts.push({ text, options });
    this.isStreaming = true;
    await this.onPrompt(this);
    this.isStreaming = false;
  }

  async steer(text: string): Promise<void> {
    this.steers.push(text);
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.isStreaming = false;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

function setupBroker(taskIds = ["run-test-task-1"]): RelayBroker {
  const relay = new RelayBroker();
  relay.createRun("run-test", taskIds);
  return relay;
}

const fakeModel = { provider: "test", id: "model" } as never;

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("Pi USAP worker helpers", () => {
  it("builds a complete bounded parent/child contract prompt", () => {
    const recordTask = task("run-test", {
      mayEdit: true,
      allowBash: true,
      ownedPaths: ["/repo/src/owned.ts"],
    });
    const prompt = buildPiWorkerSystemPrompt(run("/repo", recordTask), recordTask);

    expect(prompt).toContain("parent is the only orchestrator");
    expect(prompt).toContain("Ship one bounded worker implementation");
    expect(prompt).toContain("Do not edit tests owned by peers");
    expect(prompt).toContain("Return exact changed paths and focused checks");
    expect(prompt).toContain(recordTask.task);
    expect(prompt).toContain("May edit: yes");
    expect(prompt).toContain("May use bash: yes");
    expect(prompt).toContain("Bash is not path-sandboxed");
    expect(prompt).toContain("/repo/src/owned.ts");
    expect(prompt).toContain("Never delegate or launch another agent");
    expect(prompt).toContain("Changed paths:");
  });

  it("exposes an inert loader with no ambient resources", async () => {
    const loader = createIsolatedResourceLoader("only this prompt");
    await loader.reload();

    expect(loader.getSystemPrompt()).toBe("only this prompt");
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  });

  it("limits retained output and reports truncation", () => {
    expect(truncatePiWorkerOutput("short")).toEqual({ output: "short", truncated: false });
    const bounded = truncatePiWorkerOutput("x".repeat(OUTPUT_LIMIT + 50));
    expect(bounded.truncated).toBe(true);
    expect(bounded.output).toHaveLength(OUTPUT_LIMIT);
    expect(bounded.output).toContain("Output truncated");
  });

  it("classifies terminal states deterministically", () => {
    const live = new AbortController();
    expect(classifyPiWorkerState({
      signal: live.signal,
      turnLimitReached: false,
      finalAssistant: { text: "ok", stopReason: "stop" },
    })).toEqual({ state: "done" });
    expect(classifyPiWorkerState({
      signal: live.signal,
      turnLimitReached: true,
      finalAssistant: { text: "partial", stopReason: "aborted" },
    }).state).toBe("failed");
    expect(classifyPiWorkerState({
      signal: live.signal,
      turnLimitReached: false,
      finalAssistant: { text: "", stopReason: "error", errorMessage: "provider failed" },
    })).toEqual({ state: "failed", error: "provider failed" });

    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));
    expect(classifyPiWorkerState({ signal: aborted.signal, turnLimitReached: false }).state).toBe("aborted");
    const timedOut = new AbortController();
    timedOut.abort(new DOMException("deadline", "TimeoutError"));
    expect(classifyPiWorkerState({ signal: timedOut.signal, turnLimitReached: false }).state).toBe("timed_out");
  });
});

describe("Pi USAP worker tools", () => {
  it("executes every real SDK filesystem/shell factory, not just mocked session lifecycle", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-native-tools-"));
    try {
      const relay = setupBroker();
      const record = task("run-test", { mayEdit: true, allowBash: true, ownedPaths: [cwd] });
      const tools = createGuardedPiWorkerTools({ cwd, task: record, relay: relay.bind("run-test", record.id) });
      const invoke = (name: string, args: unknown) => tools.find((tool) => tool.name === name)!
        .execute(name, args, undefined, undefined, {} as never);
      await invoke("write", { path: "fixture.txt", content: "before-token\n" });
      await invoke("edit", { path: "fixture.txt", edits: [{ oldText: "before-token", newText: "after-token" }] });
      expect(await readFile(join(cwd, "fixture.txt"), "utf8")).toBe("after-token\n");
      for (const [name, args, expected] of [
        ["read", { path: "fixture.txt" }, "after-token"],
        ["grep", { pattern: "after-token", path: "." }, "fixture.txt"],
        ["find", { pattern: "*.txt", path: "." }, "fixture.txt"],
        ["ls", { path: "." }, "fixture.txt"],
        ["bash", { command: "printf native-shell-ok", timeout: 3 }, "native-shell-ok"],
      ] as const) {
        expect(JSON.stringify(await invoke(name, args))).toContain(expected);
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("filters capabilities and rejects filesystem paths outside cwd or ownership", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-worker-"));
    await writeFile(join(cwd, "inside.txt"), "inside", "utf8");
    const relay = setupBroker();
    const readonlyTask = task();
    const readonlyTools = createGuardedPiWorkerTools({
      cwd,
      task: readonlyTask,
      relay: relay.bind("run-test", readonlyTask.id),
    });

    expect(readonlyTools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "ultraterm_relay",
    ]);
    const read = readonlyTools.find((tool) => tool.name === "read")!;
    const readResult = await read.execute("read", { path: "inside.txt" }, undefined, undefined, {} as never);
    expect(readResult.content).toEqual([{ type: "text", text: "inside" }]);
    await expect(read.execute("read", { path: join(cwd, "..", "outside.txt") }, undefined, undefined, {} as never))
      .rejects.toThrow("outside cwd");

    const editableTask = task("run-test", {
      mayEdit: true,
      allowBash: true,
      ownedPaths: [join(cwd, "inside.txt")],
    });
    const editableTools = createGuardedPiWorkerTools({
      cwd,
      task: editableTask,
      relay: relay.bind("run-test", editableTask.id),
    });
    expect(editableTools.map((tool) => tool.name)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      "bash",
      "ultraterm_relay",
    ]);
    const write = editableTools.find((tool) => tool.name === "write")!;
    await expect(write.execute("write", { path: join(cwd, "other.txt"), content: "no" }, undefined, undefined, {} as never))
      .rejects.toThrow("outside the task's ownership");
  });

  it("binds relay operations to the child identity", async () => {
    const relay = setupBroker(["run-test-task-1", "peer"]);
    const recordTask = task();
    const childPeer = relay.bind("run-test", recordTask.id);
    const peer = relay.bind("run-test", "peer");
    const relayTool = createGuardedPiWorkerTools({ cwd: "/tmp", task: recordTask, relay: childPeer })
      .find((tool) => tool.name === "ultraterm_relay")!;

    await relayTool.execute("send", { operation: "request", to: "peer", body: "review" }, undefined, undefined, {} as never);
    const request = peer.inbox().messages[0];
    expect(request).toMatchObject({ from: recordTask.id, kind: "request", body: "review" });
    peer.send({ to: recordTask.id, kind: "reply", replyTo: request.id, body: "approved" });
    const received = await relayTool.execute("receive", { operation: "receive" }, undefined, undefined, {} as never);
    expect(received.details.messages[0]).toMatchObject({ from: "peer", kind: "reply", body: "approved" });
    const listed = await relayTool.execute("list", { operation: "list" }, undefined, undefined, {} as never);
    expect(listed.details).toEqual({ peers: ["peer"] });
    expect(recordTask.relaySent).toBe(1);
    expect(recordTask.relayReceived).toBe(1);
  });
});

describe("native in-process Pi worker runner", () => {
  it.each(["frozen-runtime", "run-model", "run-profile"])("rejects retired Sol at child launch (%s) before session creation", async boundary => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-retired-child-"));
    try {
      const recordTask = task(), recordRun = run(cwd, recordTask);
      if (boundary === "run-model") recordRun.model = "openai-codex/gpt-6-sol";
      if (boundary === "run-profile") recordRun.selection = { provider: "fake", modelId: "model", profile: "steak-pi/gpt-6-sol", source: "override", images: false, tools: true };
      const sessionFactory = vi.fn(async () => ({ session: new FakeSession() }));
      const model = boundary === "frozen-runtime" ? ({ provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" } as never) : fakeModel;
      const runner = createPiWorkerRunner({ relay: setupBroker(), resolveRuntime: () => ({ model, thinkingLevel: "off" }), sessionFactory });
      const result = await runner({ run: recordRun, task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
      expect(result.state).toBe("failed");
      expect(result.error).toContain("RetiredModelSelectionError");
      expect(sessionFactory).not.toHaveBeenCalled();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it.each([0, 1])("preserves tool failure evidence with %s subsequent successes", async (successes) => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-tool-evidence-"));
    const recordTask = task(), fake = new FakeSession();
    fake.onPrompt = async (session) => {
      session.emit({ type: "tool_execution_end", toolName: "read", isError: true } as AgentSessionEvent);
      if (successes) session.emit({ type: "tool_execution_end", toolName: "read", isError: false } as AgentSessionEvent);
      session.emit({ type: "message_end", message: assistant("Claimed completion", "stop", usage(1)) } as AgentSessionEvent);
    };
    const runner = createPiWorkerRunner({ relay: setupBroker(), resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }), sessionFactory: async () => ({ session: fake }) });
    const result = await runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result).toMatchObject({ state: successes ? "done" : "failed", toolErrors: 1, toolSuccesses: successes, output: expect.stringContaining("Claimed completion") });
    expect(result.output).toMatch(/^FINAL REPORT\n/);
    if (!successes) expect(result.error).toContain("Every attempted native tool call failed");
  });
  it("uses explicit isolated runtime options, final assistant text, and message_end usage once", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-runner-"));
    const recordTask = task();
    const recordRun = run(cwd, recordTask);
    const relay = setupBroker();
    const fake = new FakeSession();
    const captured: CreateAgentSessionOptions[] = [];
    const message = assistant("Evidence: done", "stop", usage(2));
    fake.onPrompt = async (session) => {
      session.emit({ type: "message_update", message, assistantMessageEvent: { type: "done", reason: "stop", message } } as never);
      session.emit({ type: "turn_start" } as AgentSessionEvent);
      session.emit({ type: "message_end", message } as AgentSessionEvent);
      session.emit({ type: "message_end", message } as AgentSessionEvent);
      session.emit({ type: "turn_end", message, toolResults: [] } as AgentSessionEvent);
    };
    const runner = createPiWorkerRunner({
      relay,
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "low" }),
      sessionFactory: async (options) => {
        captured.push(options);
        return { session: fake };
      },
    });

    const result = await runner({ run: recordRun, task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });

    expect(result).toMatchObject({ state: "done", output: expect.stringContaining("Evidence: done"), turns: 1, truncated: false });
    expect(result.output).toMatch(/^FINAL REPORT\n/);
    expect(result.usage).toEqual(usage(2));
    expect(fake.disposed).toBe(true);
    expect(fake.prompts[0].options).toEqual({ expandPromptTemplates: false });
    expect(captured).toHaveLength(1);
    expect(captured[0].cwd).toBe(cwd);
    expect(captured[0].model).toBe(fakeModel);
    expect(captured[0].thinkingLevel).toBe("low");
    expect(captured[0].tools).toEqual(["read", "grep", "find", "ls", "ultraterm_relay"]);
    expect(captured[0].sessionManager?.getSessionFile()).toBeUndefined();
    expect(captured[0].settingsManager?.getGlobalSettings()).toMatchObject({ cacheWarming: "off" });
    expect(captured[0].resourceLoader?.getAgentsFiles().agentsFiles).toEqual([]);
    expect(captured[0].resourceLoader?.getSystemPrompt()).toContain(recordTask.task);
  });

  it.each(["runtime", "session"])("bounds cancellation during pending %s initialization and safely settles late resources", async (stage) => {
    const recordTask = task();
    const fake = new FakeSession();
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const factory = vi.fn(async () => {
      if (stage === "session") { entered(); await gate; }
      return { session: fake };
    });
    const runner = createPiWorkerRunner({
      relay: setupBroker(), abortGraceMs: 1,
      resolveRuntime: async () => {
        if (stage === "runtime") { entered(); await gate; }
        return { model: fakeModel, thinkingLevel: "off" };
      },
      sessionFactory: factory,
    });
    const pending = runner({ run: run("/tmp", recordTask), task: recordTask, signal: controller.signal, onProgress: vi.fn() });
    await ready;
    controller.abort();
    const result = await pending;
    expect(result.state).toBe("aborted");
    expect(result.cleanup).toBeDefined();
    expect(fake.prompts).toHaveLength(0);
    release();
    await result.cleanup;
    expect(fake.disposed).toBe(stage === "session");
    expect(factory).toHaveBeenCalledTimes(stage === "session" ? 1 : 0);
    expect(fake.prompts).toHaveLength(0);
  });

  it("awaits delayed abort and disposal while retaining final usage events", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-abort-"));
    const recordTask = task();
    const relay = setupBroker();
    const fake = new FakeSession();
    let releasePrompt!: () => void;
    let releaseAbort!: () => void;
    fake.onPrompt = () => new Promise<void>((resolve) => { releasePrompt = resolve; });
    fake.abort = async () => {
      fake.abortCalls += 1;
      await new Promise<void>((resolve) => { releaseAbort = resolve; });
      const final = assistant("partial after abort", "aborted", usage(5));
      fake.emit({ type: "message_end", message: final } as AgentSessionEvent);
      fake.isStreaming = false;
    };
    const controller = new AbortController();
    const runner = createPiWorkerRunner({
      relay,
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });
    const pending = runner({ run: run(cwd, recordTask), task: recordTask, signal: controller.signal, onProgress: vi.fn() });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));

    controller.abort(new DOMException("cancelled", "AbortError"));
    releasePrompt();
    await flush();
    expect(fake.abortCalls).toBe(1);
    expect(fake.disposed).toBe(false);

    releaseAbort();
    const result = await pending;
    expect(result).toMatchObject({ state: "aborted", output: expect.stringContaining("partial after abort") });
    expect(result.output).toMatch(/^FINAL REPORT\n/);
    expect(result.usage).toEqual(usage(5));
    expect(fake.disposed).toBe(true);
  });

  it("bounds a hung session abort and still releases the worker", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-hung-abort-"));
    const recordTask = task();
    const relay = setupBroker();
    const fake = new FakeSession();
    fake.onPrompt = () => new Promise<void>(() => {});
    fake.abort = async () => {
      fake.abortCalls += 1;
      await new Promise<void>(() => {});
    };
    const controller = new AbortController();
    const runner = createPiWorkerRunner({
      relay,
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
      abortGraceMs: 5,
    });
    const pending = runner({ run: run(cwd, recordTask), task: recordTask, signal: controller.signal, onProgress: vi.fn() });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));

    controller.abort(new DOMException("cancelled", "AbortError"));
    const result = await pending;

    expect(result.state).toBe("aborted");
    expect(fake.abortCalls).toBe(1);
    expect(fake.disposed).toBe(true);
  });

  it("fails a worker whose provider stream went silent, freeing its slot", async () => {
    // Live 2026-09-27: after "Codex SSE response headers timed out" the retry
    // hung on a half-closed socket; the task stayed "running" for good.
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-stall-"));
    const recordTask = task();
    const fake = new FakeSession();
    fake.onPrompt = () => new Promise<void>(() => {});
    const runner = createPiWorkerRunner({
      relay: setupBroker(),
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
      abortGraceMs: 5,
      stallMs: 40,
    });
    const result = await runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/No model or tool activity for 1 min: the provider stream stopped responding/);
    expect(fake.abortCalls).toBe(1);
    expect(fake.disposed).toBe(true);
  });

  it("never counts a long-running tool or a streaming model as a stall", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-no-stall-"));
    const recordTask = task();
    const fake = new FakeSession();
    fake.onPrompt = async (session) => {
      // A tool that runs silently for well past the stall window.
      session.emit({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: {} } as never);
      await new Promise((resolve) => setTimeout(resolve, 120));
      session.emit({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", result: {}, isError: false } as never);
      // Then a model reply that keeps streaming updates under the window.
      for (let index = 0; index < 4; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        session.emit({ type: "message_update", message: assistant("partial"), assistantMessageEvent: { type: "text_delta" } } as never);
      }
      session.emit({ type: "message_end", message: assistant("report") } as never);
    };
    const runner = createPiWorkerRunner({
      relay: setupBroker(),
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
      abortGraceMs: 5,
      stallMs: 40,
    });
    const result = await runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("done");
    expect(fake.abortCalls).toBe(0);
  });

  it("enforces the run turn budget and gives one findings-and-remaining-work notice when two requests remain", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-turns-"));
    const recordTask = task();
    const relay = setupBroker();
    const budget = 6;
    const fake = new FakeSession();
    fake.onPrompt = async (session) => {
      for (let index = 0; index < budget + 2; index += 1) {
        const message = assistant(`turn ${index}`, index === budget ? "aborted" : "toolUse");
        session.emit({ type: "turn_start" } as AgentSessionEvent);
        session.emit({ type: "message_end", message } as AgentSessionEvent);
        session.emit({ type: "turn_end", message, toolResults: [] } as AgentSessionEvent);
      }
    };
    const runner = createPiWorkerRunner({
      relay,
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });

    const result = await runner({ run: run(cwd, recordTask, budget), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("failed");
    expect(result.error).toContain(`${budget}-turn limit`);
    expect(result.turns).toBe(budget);
    // The fake provider emits two late billed messages after abort; retain
    // their accounting even though execution turns stay frozen at the limit.
    expect(result.usage.input).toBe(budget + 2);
    expect(budget - piWorkerTurnWarningAt(budget)).toBe(TURN_BUDGET_NOTICE_REMAINING);
    expect(TURN_BUDGET_NOTICE_REMAINING).toBe(2);
    // Turns 5 and 6 are still tool turns past the threshold: the notice is never repeated.
    expect(fake.steers).toEqual([
      turnBudgetNotice(2),
      "Execution budget ended. Stop tool use and flush your partial report, changed paths and remaining work.",
    ]);
    expect(fake.steers.filter((text) => text.startsWith("Turn budget notice")).length).toBe(1);
    expect(fake.steers[0]).toMatch(/only 2 assistant requests remain/);
    expect(fake.steers[0]).toMatch(/findings so far/);
    expect(fake.steers[0]).toMatch(/remaining-work list/);
    expect(fake.abortCalls).toBe(1);
  });

  it("keeps the default 64-turn budget and the exported 2048 schema ceiling", () => {
    expect(MAX_PI_WORKER_TURNS).toBe(DEFAULT_MAX_TURNS);
    expect(DEFAULT_MAX_TURNS).toBe(64);
    expect(MAX_WORKER_TURNS).toBe(2048);
    expect(MAX_MAX_TURNS).toBe(MAX_WORKER_TURNS);
    expect(workerTurnBudget({ maxTurns: 128 })).toBe(128);
    expect(workerTurnBudget({ maxTurns: 5000 })).toBe(MAX_MAX_TURNS);
    expect(workerTurnBudget({ maxTurns: 0 })).toBe(DEFAULT_MAX_TURNS);
    expect(workerTurnBudget(undefined)).toBe(DEFAULT_MAX_TURNS);
    expect(piWorkerTurnWarningAt(64)).toBe(62);
    expect(piWorkerTurnWarningAt(1)).toBe(1);
    expect(compactionOrRetryPhase("compaction_end")).toBe("compaction");
    expect(compactionOrRetryPhase("retry_start")).toBe("retry");
    expect(compactionOrRetryPhase("message_end")).toBeUndefined();
    expect(compactionOrRetryPhase(7)).toBeUndefined();
  });

  it("sends no budget notice when no request is left to act on it or the child is already answering", async () => {
    for (const [budget, stopReason] of [[1, "toolUse"], [6, "stop"]] as const) {
      const cwd = await mkdtemp(join(tmpdir(), "steak-pi-notice-"));
      const recordTask = task();
      const fake = new FakeSession();
      fake.onPrompt = async (session) => {
        for (let index = 0; index < Math.min(budget, 5); index += 1) {
          const message = assistant(`turn ${index}`, stopReason);
          session.emit({ type: "turn_start" } as AgentSessionEvent);
          session.emit({ type: "message_end", message } as AgentSessionEvent);
          session.emit({ type: "turn_end", message, toolResults: [] } as AgentSessionEvent);
        }
      };
      const runner = createPiWorkerRunner({
        relay: setupBroker(),
        resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
        sessionFactory: async () => ({ session: fake }),
      });
      await runner({ run: run(cwd, recordTask, budget), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
      expect(fake.steers.filter((text) => text.startsWith("Turn budget notice"))).toEqual([]);
    }
  });

  it("reports compaction phases and journals the last step for the final report", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-progress-"));
    const recordTask = task();
    const progress: WorkerProgress[] = [];
    const fake = new FakeSession();
    fake.onPrompt = async (session) => {
      session.emit({ type: "compaction_start" } as AgentSessionEvent);
      const compacted = { summary: "Earlier work", firstKeptEntryId: "test", tokensBefore: 128, usage: usage(3) };
      const compactedEvent = { type: "compaction_end", result: compacted, aborted: false, willRetry: false } as AgentSessionEvent;
      session.emit(compactedEvent);
      session.emit(compactedEvent); // Duplicate notifications must not inflate billing.
      session.emit({ type: "tool_execution_start", toolName: "edit" } as AgentSessionEvent);
      const final = assistant("Evidence: journaled");
      session.emit({ type: "turn_start" } as AgentSessionEvent);
      session.emit({ type: "message_end", message: final } as AgentSessionEvent);
      session.emit({ type: "turn_end", message: final, toolResults: [] } as AgentSessionEvent);
    };
    const runner = createPiWorkerRunner({
      relay: setupBroker(),
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });

    const result = await runner({
      run: run(cwd, recordTask),
      task: recordTask,
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value),
    });

    expect(result.state).toBe("done");
    expect(progress.some((value) => value.currentTool === "compaction")).toBe(true);
    expect(progress.some((value) => value.currentTool === "edit")).toBe(true);
    expect(recordTask.lastStep).toBe("edit");
    expect(result.output).toContain("last step: edit");
    expect(progress.filter((value) => value.compactions).map((value) => value.compactions)).toEqual([1]);
    expect(result.usage.totalTokens).toBe(usage(4).totalTokens);
    expect(result.usage.cost.total).toBeCloseTo(usage(4).cost.total);
  });

  it("reports first model output the moment it streams, not at turn start, so a dispatch can tell a launched worker from a dead one", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-first-output-"));
    const recordTask = task();
    const progress: WorkerProgress[] = [];
    const fake = new FakeSession();
    let seenAtTurnStart: WorkerProgress[] = [];
    let seenAtFirstDelta: WorkerProgress[] = [];
    fake.onPrompt = async (session) => {
      const final = assistant("Evidence: first output");
      session.emit({ type: "turn_start" } as AgentSessionEvent);
      seenAtTurnStart = progress.filter((value) => value.outputStarted !== undefined);
      session.emit({ type: "message_update", message: final } as unknown as AgentSessionEvent);
      seenAtFirstDelta = progress.filter((value) => value.outputStarted !== undefined);
      session.emit({ type: "message_update", message: final } as unknown as AgentSessionEvent);
      session.emit({ type: "message_end", message: final } as AgentSessionEvent);
      session.emit({ type: "turn_end", message: final, toolResults: [] } as AgentSessionEvent);
    };
    const runner = createPiWorkerRunner({
      relay: setupBroker(),
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });
    const result = await runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: (value) => progress.push(value) });
    expect(result.state).toBe("done");
    expect(seenAtTurnStart).toEqual([]);
    expect(seenAtFirstDelta).toEqual([{ outputStarted: true, turns: 1 }]);
    expect(progress.filter((value) => value.outputStarted !== undefined)).toHaveLength(1);
  });

  it("never reports output for a first request that fails with none, even though its turn started (429, expired OAuth)", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-first-request-failed-"));
    const recordTask = task();
    const progress: WorkerProgress[] = [];
    const fake = new FakeSession();
    fake.onPrompt = async (session) => {
      // What Pi emits for a request refused before any token: a turn that starts and an errored, empty message.
      const failed = { role: "assistant" as const, content: [], api: "test", provider: "test", model: "test", usage: usage(0), stopReason: "error", errorMessage: "429 usage_limit_reached", timestamp: Date.now() };
      session.emit({ type: "turn_start" } as AgentSessionEvent);
      session.emit({ type: "message_start", message: failed } as AgentSessionEvent);
      session.emit({ type: "message_end", message: failed } as AgentSessionEvent);
      session.emit({ type: "turn_end", message: failed, toolResults: [] } as AgentSessionEvent);
    };
    const runner = createPiWorkerRunner({
      relay: setupBroker(),
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });
    const result = await runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: (value) => progress.push(value) });
    expect(result.state).toBe("failed");
    expect(result.error).toContain("429 usage_limit_reached");
    expect(result.turns).toBe(1); // the turn counter is unchanged: it cannot tell a dead launch from a live one
    expect(progress.some((value) => value.outputStarted !== undefined)).toBe(false);
  });

  it("reports no output for a worker whose session cannot even be created", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-no-turn-"));
    const recordTask = task();
    const progress: WorkerProgress[] = [];
    const runner = createPiWorkerRunner({
      relay: setupBroker(),
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => { throw new Error("synthetic session creation failure"); },
    });
    const result = await runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: (value) => progress.push(value) });
    expect(result.state).toBe("failed");
    expect(result.turns).toBe(0);
    expect(progress.some((value) => value.outputStarted !== undefined || value.turns !== undefined)).toBe(false);
  });

  it("resumes a persisted session without replaying the original prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-resume-"));
    try {
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const saved = SessionManager.create(cwd, join(cwd, "sessions"));
      saved.appendMessage({ role: "user", content: "Original assignment", timestamp: Date.now() });
      saved.appendMessage({ ...assistant("Partial evidence"), stopReason: "stop" });
      const sessionFile = saved.getSessionFile();
      expect(typeof sessionFile).toBe("string");
      const recordTask = task("run-test", { sessionFile: sessionFile as string, changedPaths: [], lastStep: "edit" });
      const captured: CreateAgentSessionOptions[] = [];
      const progress: WorkerProgress[] = [];
      const fake = new FakeSession();
      fake.onPrompt = async (session) => {
        const final = assistant("Evidence: resumed without replay");
        session.emit({ type: "turn_start" } as AgentSessionEvent);
        session.emit({ type: "message_end", message: final } as AgentSessionEvent);
        session.emit({ type: "turn_end", message: final, toolResults: [] } as AgentSessionEvent);
      };
      const runner = createPiWorkerRunner({
        relay: setupBroker(),
        resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
        sessionFactory: async (options) => {
          captured.push(options);
          return { session: fake };
        },
      });

      const result = await runner({
        run: run(cwd, recordTask),
        task: recordTask,
        signal: new AbortController().signal,
        onProgress: (value) => progress.push(value),
        sessionDir: join(cwd, "worker-sessions"),
      });

      expect(result.state).toBe("done");
      expect(fake.prompts).toHaveLength(1);
      expect(fake.prompts[0].text).toBe(buildPiWorkerContinuationPrompt(recordTask));
      expect(fake.prompts[0].text).toContain("original prompt is not replayed");
      expect(fake.prompts[0].text).not.toMatch(/read-only/i);
      expect(fake.prompts[0].text).toContain("permissions are exactly those of the original assignment");
      expect(fake.prompts[0].text).not.toContain("Execute the exact assigned leaf and return the required concise report.");
      expect(fake.prompts[0].text).not.toContain(recordTask.task);
      expect(captured[0].sessionManager?.getSessionFile()).toBe(sessionFile);
      expect(progress.some((value) => value.sessionFile === sessionFile)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates a durable per-worker session in the supplied session directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-session-dir-"));
    try {
      const recordTask = task();
      const captured: CreateAgentSessionOptions[] = [];
      const progress: WorkerProgress[] = [];
      const fake = new FakeSession();
      fake.onPrompt = async (session) => {
        const final = assistant("Evidence: durable");
        // FakeSession does not own the SDK journal; emulate the native append boundary.
        captured[0].sessionManager!.appendMessage({ role: "user", content: "Run the assigned leaf", timestamp: Date.now() });
        captured[0].sessionManager!.appendMessage({ ...final, stopReason: "stop" });
        session.emit({ type: "turn_start" } as AgentSessionEvent);
        session.emit({ type: "message_end", message: final } as AgentSessionEvent);
        session.emit({ type: "turn_end", message: final, toolResults: [] } as AgentSessionEvent);
      };
      const runner = createPiWorkerRunner({
        relay: setupBroker(),
        resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
        sessionFactory: async (options) => {
          captured.push(options);
          return { session: fake };
        },
      });

      const result = await runner({
        run: run(cwd, recordTask),
        task: recordTask,
        signal: new AbortController().signal,
        onProgress: (value) => progress.push(value),
        sessionDir: join(cwd, "worker-sessions"),
      });

      expect(result.state).toBe("done");
      const checkpoint = captured[0].sessionManager?.getSessionFile();
      expect(typeof checkpoint).toBe("string");
      expect(checkpoint).toContain("worker-sessions");
      expect(existsSync(checkpoint as string)).toBe(true);
      expect(progress.some((value) => value.sessionFile === checkpoint)).toBe(true);
      expect(recordTask.sessionFile).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("steers active peer delivery and leaves idle delivery in the mailbox", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-relay-steer-"));
    const recordTask = task();
    const relay = setupBroker([recordTask.id, "peer"]);
    const sender = relay.bind("run-test", "peer");
    const fake = new FakeSession();
    let release!: () => void;
    fake.onPrompt = () => new Promise<void>((resolve) => { release = resolve; });
    const runner = createPiWorkerRunner({
      relay,
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });
    const pending = runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));

    expect(sender.send({ to: recordTask.id, body: "live fact" })).toMatchObject({
      status: "queued",
      delivered: 0,
      queued: 1,
    });
    await flush();
    expect(fake.steers[0]).toContain("live fact");
    fake.isStreaming = false;
    expect(sender.send({ to: recordTask.id, body: "idle fact" })).toMatchObject({ status: "queued" });

    const final = assistant("Evidence: complete");
    fake.emit({ type: "turn_start" } as AgentSessionEvent);
    fake.emit({ type: "message_end", message: final } as AgentSessionEvent);
    fake.emit({ type: "turn_end", message: final, toolResults: [] } as AgentSessionEvent);
    release();
    await pending;
    const mailbox = relay.bind("run-test", recordTask.id).inbox().messages;
    expect(mailbox.map((message) => message.body)).toEqual(["idle fact"]);
  });

  it("queues active relay delivery when steering rejects without counting receipt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-relay-reject-"));
    const recordTask = task();
    const relay = setupBroker([recordTask.id, "peer"]);
    const sender = relay.bind("run-test", "peer");
    const fake = new FakeSession();
    let release!: () => void;
    fake.onPrompt = () => new Promise<void>((resolve) => { release = resolve; });
    fake.steer = async () => { throw new Error("steering rejected"); };
    const runner = createPiWorkerRunner({
      relay,
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });
    const pending = runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));

    expect(sender.send({ to: recordTask.id, body: "retain me" })).toMatchObject({
      status: "queued",
      delivered: 0,
      queued: 1,
    });
    await flush();
    expect(recordTask.relayReceived).toBe(0);

    fake.isStreaming = false;
    const final = assistant("Evidence: complete");
    fake.emit({ type: "turn_start" } as AgentSessionEvent);
    fake.emit({ type: "message_end", message: final } as AgentSessionEvent);
    fake.emit({ type: "turn_end", message: final, toolResults: [] } as AgentSessionEvent);
    release();
    await pending;
    expect(relay.bind("run-test", recordTask.id).inbox().messages.map((message) => message.body))
      .toEqual(["retain me"]);
  });
});

describe("final report survives late relay wakeups", () => {
  it("keeps the first final answer when a peer message wakes the child again", async () => {
    // Regression for a measured failure: a read-only scout wrote its findings,
    // a peer's #run broadcast then steered it into another turn, and the run
    // reported only "A-Q1 complete; no new relevant evidence."
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-relay-final-"));
    const recordTask = task();
    const relay = setupBroker([recordTask.id, "peer"]);
    const sender = relay.bind("run-test", "peer");
    const fake = new FakeSession();
    let release!: () => void;
    fake.onPrompt = () => new Promise<void>((resolve) => { release = resolve; });
    const runner = createPiWorkerRunner({
      relay,
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });
    const pending = runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));

    const findings = assistant("Evidence: limit is 20,000 chars (src/subagents/types.ts:42)");
    fake.emit({ type: "turn_start" } as AgentSessionEvent);
    fake.emit({ type: "message_end", message: findings } as AgentSessionEvent);
    fake.emit({ type: "turn_end", message: findings, toolResults: [] } as AgentSessionEvent);

    // A peer broadcast arrives after the final answer: it is not steered into the child.
    expect(sender.send({ to: recordTask.id, body: "peer done" })).toMatchObject({ status: "queued" });
    await flush();
    expect(fake.steers).toEqual([]);

    // Even if the harness still runs another turn, its acknowledgement cannot erase the findings.
    const ack = assistant("Already reported; leaf complete.");
    fake.emit({ type: "turn_start" } as AgentSessionEvent);
    fake.emit({ type: "message_end", message: ack } as AgentSessionEvent);
    fake.emit({ type: "turn_end", message: ack, toolResults: [] } as AgentSessionEvent);
    release();
    const result = await pending;

    expect(result.state).toBe("done");
    expect(result.output).toContain("src/subagents/types.ts:42");
    expect(result.output).toContain("Already reported; leaf complete.");
    expect(result.output.indexOf("types.ts:42")).toBeLessThan(result.output.indexOf("Already reported"));
    expect(relay.bind("run-test", recordTask.id).inbox().messages.map((message) => message.body)).toEqual(["peer done"]);
  });

  it("steers a child that was woken for another turn after its answer", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-relay-rewake-"));
    const recordTask = task();
    const relay = setupBroker([recordTask.id, "peer"]);
    const sender = relay.bind("run-test", "peer");
    const fake = new FakeSession();
    let release!: () => void;
    fake.onPrompt = () => new Promise<void>((resolve) => { release = resolve; });
    const runner = createPiWorkerRunner({
      relay,
      resolveRuntime: () => ({ model: fakeModel, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });
    const pending = runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
    await vi.waitFor(() => expect(fake.prompts).toHaveLength(1));
    const first = assistant("Evidence: first findings");
    fake.emit({ type: "turn_start" } as AgentSessionEvent);
    fake.emit({ type: "message_end", message: first } as AgentSessionEvent);
    fake.emit({ type: "turn_end", message: first, toolResults: [] } as AgentSessionEvent);
    // Woken anyway (e.g. a message that landed while the answer streamed): a new turn starts.
    fake.emit({ type: "turn_start" } as AgentSessionEvent);
    sender.send({ to: recordTask.id, body: "interface changed" });
    await flush();
    expect(fake.steers.some((text) => text.includes("interface changed"))).toBe(true);
    const tool = { ...assistant("checking", "stop"), content: [{ type: "text" as const, text: "checking" }, { type: "toolCall" as const, id: "t1", name: "read", arguments: {} }] };
    fake.emit({ type: "message_end", message: tool } as AgentSessionEvent);
    fake.emit({ type: "turn_end", message: tool, toolResults: [] } as AgentSessionEvent);
    const second = assistant("Evidence: updated findings");
    fake.emit({ type: "turn_start" } as AgentSessionEvent);
    fake.emit({ type: "message_end", message: second } as AgentSessionEvent);
    fake.emit({ type: "turn_end", message: second, toolResults: [] } as AgentSessionEvent);
    release();
    const result = await pending;
    expect(result.output).toContain("first findings");
    expect(result.output).toContain("updated findings");
    expect(result.output).not.toContain("checking");
  });

  it("treats only completed text answers as final", () => {
    expect(isFinalAnswer({ text: "done", stopReason: "stop" })).toBe(true);
    expect(isFinalAnswer({ text: "preamble", stopReason: "stop", toolCalls: true })).toBe(false);
    expect(isFinalAnswer({ text: "cut off", stopReason: "length" })).toBe(false);
    expect(isFinalAnswer({ text: "done" })).toBe(true);
    expect(isFinalAnswer({ text: "calling a tool", stopReason: "toolUse" })).toBe(false);
    expect(isFinalAnswer({ text: "  ", stopReason: "stop" })).toBe(false);
    expect(isFinalAnswer({ text: "partial", stopReason: "error" })).toBe(false);
    expect(isFinalAnswer({ text: "partial", stopReason: "aborted" })).toBe(false);
  });

  it("merges later answers as bounded, deduplicated notes", () => {
    expect(mergeFinalReport(undefined, " findings ")).toBe("findings");
    expect(mergeFinalReport("findings", "findings")).toBe("findings");
    expect(mergeFinalReport("findings", "")).toBe("findings");
    const once = mergeFinalReport("findings", "ack 1");
    expect(once).toContain("findings");
    expect(once).toContain("[Later answer from this child after its first final answer]\nack 1");
    let report = once;
    for (let index = 0; index < 50; index += 1) report = mergeFinalReport(report, `ack ${index + 2} ${"x".repeat(300)}`, 2_000);
    expect(report.startsWith("findings")).toBe(true);
    expect(report.length - "findings".length).toBeLessThanOrEqual(2_000);
    expect(report).not.toContain("]\n…");
  });

  it("tells children to keep findings and review requests in the final report, not the relay", () => {
    const recordTask = task();
    const prompt = buildPiWorkerSystemPrompt(run("/repo", recordTask), recordTask);
    expect(prompt).toContain("The parent reads your final answer, not the relay");
    expect(prompt).toContain("never relay findings, completion notices or review requests");
    expect(prompt).toContain("write your complete report again");
  });
});

const chainStep = (provider: string, id: string) => ({ provider, id } as never);

describe("worker automatic-chain selection gate", () => {
  it("installs the pre-output hop only for an automatic chain selection", () => {
    const hop = workerChainFallback({ source: "chain", images: false }, chainStep("opencode-go", "deepseek-v4.1-flash"));
    expect(hop).toMatchObject({ chain: DEFAULT_TEXT_WORKER_CHAIN, requireImages: false });
    expect(hop!.approvePaidRoute).toBe(AUTOMATIC_CHAIN_APPROVAL);
    expect(workerChainFallback({ source: "chain", images: true }, chainStep("xiaomi", "mimo-v2.6-flash")))
      .toMatchObject({ chain: DEFAULT_MULTIMODAL_WORKER_CHAIN, requireImages: true });
  });

  it("gives an explicit or defaulted selection no cross-provider fallback, even on a chain step", () => {
    // The crucial regression: an explicit model/profile that names a chain step is
    // still an exact operator choice and must not acquire spending fallback.
    for (const source of ["override", "profile-default", "legacy-default"] as const) {
      expect(workerChainFallback({ source, images: false }, chainStep("xiaomi", "mimo-v2.6-flash"))).toBeUndefined();
      expect(workerChainFallback({ source, images: true }, chainStep("xiaomi", "mimo-v2.6-flash"))).toBeUndefined();
    }
    // A chain selection whose frozen route is not a step of its chain never hops.
    expect(workerChainFallback({ source: "chain", images: false }, chainStep("openai-codex", "gpt-6-astra"))).toBeUndefined();
    expect(workerChainFallback(undefined, chainStep("opencode-go", "deepseek-v4.1-flash"))).toBeUndefined();
  });

  it("records each real hop as route provenance for receipts and progress", () => {
    const recordTask = task();
    const progress: WorkerProgress[] = [];
    const report = createChainFallbackReporter(recordTask, (update) => progress.push(update));
    report(chainStep("opencode-go", "deepseek-v4.1-flash"), chainStep("xiaomi", "mimo-v2.6-flash"));
    report(chainStep("xiaomi", "mimo-v2.6-flash"), chainStep("zai", "glm-5.3-flash"));
    expect(recordTask.routeFallbacks).toEqual([
      "opencode-go/deepseek-v4.1-flash->xiaomi/mimo-v2.6-flash",
      "xiaomi/mimo-v2.6-flash->zai/glm-5.3-flash",
    ]);
    expect(recordTask.lastStep).toBe("model-fallback:xiaomi/mimo-v2.6-flash->zai/glm-5.3-flash");
    expect(progress.map((update) => update.currentTool))
      .toEqual(["model-fallback:xiaomi/mimo-v2.6-flash", "model-fallback:zai/glm-5.3-flash"]);
    expect(progress.every((update) => update.state === "running")).toBe(true);
  });
});

describe("Go account-isolated worker lifecycle", () => {
  const model = { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1" } as never;
  const agentDir = (id: string) => join(homedir(), ".ultraterm/provider-accounts/opencode-go", id, "agent");
  it("balances concurrent children into isolated SDK dirs and releases both leases", async () => {
    const records = [task(), task("run-test", { id: "run-test-task-2" })];
    let next = 0;
    const command = vi.fn(async (args: string[]) => {
      if (args[0] !== "select") return { ok: true };
      const id = next++ === 0 ? "primary" : "b";
      return { ok: true, account: { id, agentDir: agentDir(id) }, lease: `lease-${id}` };
    });
    const captured: CreateAgentSessionOptions[] = [];
    const runner = createPiWorkerRunner({ relay: setupBroker(records.map(record => record.id)), accountCommand: command,
      resolveRuntime: () => ({ model, thinkingLevel: "off" }), sessionFactory: async options => {
        captured.push(options);
        const fake = new FakeSession();
        fake.onPrompt = async () => { fake.emit({ type: "message_end", message: assistant("done") } as AgentSessionEvent); };
        return { session: fake };
      } });
    const original = process.env.PI_CODING_AGENT_DIR;
    const results = await Promise.all(records.map(record => runner({ run: run("/tmp", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() })));
    expect(results.map(result => result.state)).toEqual(["done", "done"]);
    expect(captured.map(options => options.agentDir).sort()).toEqual([agentDir("primary"), agentDir("b")].sort());
    expect(command.mock.calls.filter(([args]) => args[0] === "release")).toHaveLength(2);
    expect(records.map(record => record.providerAccount?.label)).toEqual(["Go 1", "Go 2"]);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(original);
  });
  it.each(["factory-failure", "late-abort"])("releases after %s without leaking an initializing session", async stage => {
    const record = task(); const controller = new AbortController();
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const fake = new FakeSession();
    const command = vi.fn(async (args: string[]) => args[0] === "select" ? { ok: true, account: { id: "b", agentDir: agentDir("b") }, lease: "lease-b" } : { ok: true });
    const runner = createPiWorkerRunner({ relay: setupBroker(), accountCommand: command, resolveRuntime: () => ({ model, thinkingLevel: "off" }), sessionFactory: async () => {
      if (stage === "factory-failure") throw new Error("fixture failure");
      enter(); await gate; return { session: fake };
    } });
    const pending = runner({ run: run("/tmp", record), task: record, signal: controller.signal, onProgress: vi.fn() });
    if (stage === "late-abort") {
      await entered; controller.abort();
      const result = await pending;
      expect(command.mock.calls.filter(([args]) => args[0] === "release")).toHaveLength(0);
      finish(); await result.cleanup;
      expect(fake.disposed).toBe(true);
      expect(result.state).toBe("aborted");
    } else expect((await pending).state).toBe("failed");
    expect(command).toHaveBeenLastCalledWith(["release", "--lease", "lease-b"]);
  });
});

describe("Go account lease renewal in the native worker", () => {
  const model = { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1" } as never;
  const goAgentDir = (id: string) => join(homedir(), ".ultraterm/provider-accounts/opencode-go", id, "agent");
  const wait = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const until = async (predicate: () => boolean, deadlineMs = 3_000): Promise<void> => {
    const deadline = Date.now() + deadlineMs;
    while (!predicate() && Date.now() < deadline) await wait(5);
  };
  const calls = (command: { mock: { calls: unknown[][] } }, verb: string) =>
    command.mock.calls.map(([args]) => args as string[]).filter((args) => args[0] === verb);
  const goCommand = (onRenew: () => any) => vi.fn(async (args: string[]) => {
    if (args[0] === "select") return { ok: true, account: { id: "b", agentDir: goAgentDir("b") }, lease: "lease-b" };
    if (args[0] === "renew") return onRenew();
    return { ok: true };
  });
  const runnerFor = (command: ReturnType<typeof goCommand>, fake: FakeSession, leaseRenewIntervalMs: number) =>
    createPiWorkerRunner({
      relay: setupBroker(), accountCommand: command, leaseRenewIntervalMs,
      resolveRuntime: () => ({ model, thinkingLevel: "off" }),
      sessionFactory: async () => ({ session: fake }),
    });

  it("keeps a long ownership renewed every cadence and releases exactly once at the end", async () => {
    let renews = 0;
    const command = goCommand(() => { renews += 1; return { ok: true, renewed: true, leaseExpiresAt: 1 }; });
    const record = task();
    const fake = new FakeSession();
    const runner = runnerFor(command, fake, 5);
    fake.onPrompt = async () => {
      // A long leaf: the child outlives the one-hour reservation TTL many times over.
      await until(() => renews >= 3);
      fake.emit({ type: "message_end", message: assistant("done") } as AgentSessionEvent);
    };
    const result = await runner({ run: run("/tmp", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("done");
    expect(renews).toBeGreaterThanOrEqual(3);
    expect(calls(command, "renew").every((args) => args.join(" ") === "renew --lease lease-b --ttl 3600")).toBe(true);
    expect(calls(command, "release")).toEqual([["release", "--lease", "lease-b"]]);
    expect(command.mock.calls.at(-1)![0]).toEqual(["release", "--lease", "lease-b"]);
    const settled = command.mock.calls.length;
    await wait(40);
    expect(command.mock.calls.length).toBe(settled); // the timer stopped before the release
    expect(record.providerAccount?.lease).toBe("lease-b");
  });

  it("aborts and fails closed with a named reason once the lease is gone", async () => {
    const command = goCommand(() => ({ ok: true, renewed: false }));
    const record = task();
    let finish!: () => void;
    const fake = new FakeSession();
    fake.onPrompt = () => new Promise<void>((resolve) => { finish = resolve; });
    const runner = runnerFor(command, fake, 5);
    const result = await runner({ run: run("/tmp", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/Go account lease renewal failed \(lease-lost\)/);
    expect(fake.abortCalls).toBeGreaterThanOrEqual(1);
    expect(calls(command, "renew")).toHaveLength(1); // fail closed, no renewal retry storm
    expect(command.mock.calls.at(-1)![0]).toEqual(["release", "--lease", "lease-b"]);
    finish();
    await flush();
  });

  it("cancellation releases once, disposes the session, and never renews after release", async () => {
    let renews = 0;
    const command = goCommand(() => { renews += 1; return { ok: true, renewed: true, leaseExpiresAt: 1 }; });
    const record = task();
    const controller = new AbortController();
    const fake = new FakeSession();
    fake.onPrompt = async () => { await until(() => renews >= 1); controller.abort(); };
    const runner = runnerFor(command, fake, 5);
    const result = await runner({ run: run("/tmp", record), task: record, signal: controller.signal, onProgress: vi.fn() });
    expect(result.state).toBe("aborted");
    expect(renews).toBeGreaterThanOrEqual(1);
    expect(fake.disposed).toBe(true);
    expect(calls(command, "release")).toHaveLength(1);
    expect(command.mock.calls.at(-1)![0]).toEqual(["release", "--lease", "lease-b"]);
    const settled = command.mock.calls.length;
    await wait(40);
    expect(command.mock.calls.length).toBe(settled);
  });

  it("rejects a renewal cadence that cannot keep the reservation TTL alive", () => {
    expect(() => createPiWorkerRunner({ relay: setupBroker(), leaseRenewIntervalMs: 3_600_001, resolveRuntime: () => ({ model, thinkingLevel: "off" }) }))
      .toThrow(/leaseRenewIntervalMs/);
    expect(() => createPiWorkerRunner({ relay: setupBroker(), leaseRenewIntervalMs: 0, resolveRuntime: () => ({ model, thinkingLevel: "off" }) }))
      .toThrow(/leaseRenewIntervalMs/);
  });
});


describe("sticky Go continuation and pre-prompt lease failure", () => {
  const model = { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1" } as never;
  const agentDir = join(homedir(), ".ultraterm/provider-accounts/opencode-go/b/agent");
  it("pins prior task account on resume rather than remapping the new run", async () => {
    await mkdir(join(process.cwd(), ".leaf-check"), { recursive: true });
    const root = await mkdtemp(join(process.cwd(), ".leaf-check", "go-resume-"));
    try {
      const sessionFile = join(root, "prior.jsonl");
      await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "prior", timestamp: new Date().toISOString(), cwd: root })}\n`);
      const record = task("run-test", { sessionFile, providerAccount: { provider: "opencode-go", id: "b", label: "Go 2", lease: "old-lease" } });
      const command = vi.fn(async (args: string[]) => args[0] === "select" ? { ok: true, account: { id: "b", agentDir }, lease: "new-lease" } : { ok: true });
      const fake = new FakeSession();
      const runner = createPiWorkerRunner({ relay: setupBroker(), accountCommand: command,
        resolveRuntime: () => ({ model, thinkingLevel: "off" }), sessionFactory: async () => ({ session: fake }) });
      await runner({ run: run(root, record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
      expect(command.mock.calls[0][0]).toContain("--account");
      expect(command.mock.calls[0][0].at(-1)).toBe("b");
      expect(record.providerAccount?.id).toBe("b");
      expect(command).toHaveBeenLastCalledWith(["release", "--lease", "new-lease"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("never starts inference when renewal fails during slow session initialization", async () => {
    const record = task();
    const command = vi.fn(async (args: string[]) => args[0] === "select" ? { ok: true, account: { id: "b", agentDir }, lease: "lease-b" }
      : args[0] === "renew" ? { ok: true, renewed: false } : { ok: true });
    const fake = new FakeSession();
    const prompt = vi.spyOn(fake, "prompt");
    const runner = createPiWorkerRunner({ relay: setupBroker(), accountCommand: command, leaseRenewIntervalMs: 5,
      resolveRuntime: () => ({ model, thinkingLevel: "off" }), sessionFactory: async () => {
        await new Promise(resolve => setTimeout(resolve, 30)); return { session: fake };
      } });
    const result = await runner({ run: run("/tmp", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/lease-lost/);
    expect(prompt).not.toHaveBeenCalled();
    expect(fake.disposed).toBe(true);
    expect(command).toHaveBeenLastCalledWith(["release", "--lease", "lease-b"]);
  });
});


describe("Sol account-isolated SDK lifecycle", () => {
  const model = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text"] } as any;
  const fixtureRuntime = () => ({ isUsingOAuth: () => true, hasConfiguredAuth: () => true,
    getModels: () => [model], getModel: () => model, getProvider: () => undefined, getRegisteredNativeProvider: () => undefined } as unknown as ModelRuntime);
  it("reserves both accounts concurrently and supplies the reserved agent paths/runtime without environment races", async () => {
    const environment = { ...process.env };
    const records = [task(), task("run-test", { id: "run-test-task-2" })];
    let next = 0;
    const command = vi.fn(async (args: string[]) => {
      if (args[0] !== "select") return { ok: true };
      const id = next++ === 0 ? "primary" : "fallback";
      return { ok: true, account: { id, agentDir: isolatedCodexAgentDir(id) }, lease: `sol-${id}` };
    });
    const createdRuntimes: ModelRuntime[] = [];
    const createRuntime = vi.fn(async (_options: any) => { const runtime = fixtureRuntime(); createdRuntimes.push(runtime); return runtime; });
    const captured: CreateAgentSessionOptions[] = [];
    const runner = createPiWorkerRunner({ relay: setupBroker(records.map(record => record.id)), accountCommand: command,
      resolveRuntime: () => ({ model, thinkingLevel: "high" }), createModelRuntime: createRuntime,
      sessionFactory: async options => {
        captured.push(options); const fake = new FakeSession();
        fake.onPrompt = async () => fake.emit({ type: "message_end", message: assistant("Sol review") } as AgentSessionEvent);
        return { session: fake };
      } });
    const results = await Promise.all(records.map(record => runner({ run: run("/tmp", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() })));
    expect(results.map(result => result.state)).toEqual(["done", "done"]);
    expect(records.map(record => record.providerAccount?.label)).toEqual(["GPT1", "GPT2"]);
    expect(captured.map(options => options.agentDir).sort()).toEqual([isolatedCodexAgentDir("primary"), isolatedCodexAgentDir("fallback")].sort());
    expect(captured.map(options => options.modelRuntime)).toEqual(createdRuntimes);
    for (const id of ["primary", "fallback"] as const) {
      expect(createRuntime.mock.calls.some(([options]) => options.authPath === isolatedAgentPaths(isolatedCodexAgentDir(id)).authPath && options.modelsPath === isolatedAgentPaths(isolatedCodexAgentDir(id)).modelsPath)).toBe(true);
      expect(command).toHaveBeenCalledWith(["release", "--lease", `sol-${id}`]);
    }
    expect(command.mock.calls.filter(([args]) => args[0] === "bind")).toHaveLength(2);
    expect(process.env).toEqual(environment);
  });
  it.each(["cancel", "factory-failure", "oauth-unconfigured"])("releases the actual Codex lease on %s", async stage => {
    const record = task(); const controller = new AbortController(); const fake = new FakeSession();
    const command = vi.fn(async (args: string[]) => args[0] === "select" ? { ok: true, account: { id: "fallback", agentDir: isolatedCodexAgentDir("fallback") }, lease: "sol-fallback" } : { ok: true });
    const runner = createPiWorkerRunner({ relay: setupBroker(), accountCommand: command,
      resolveRuntime: () => ({ model, thinkingLevel: "high" }), createModelRuntime: async () => {
        const runtime = fixtureRuntime(); if (stage === "oauth-unconfigured") runtime.hasConfiguredAuth = () => false; return runtime;
      }, sessionFactory: async () => {
        if (stage === "factory-failure") throw new Error("fixture initialization failure");
        fake.onPrompt = async () => { controller.abort(); }; return { session: fake };
      } });
    const result = await runner({ run: run("/tmp", record), task: record, signal: controller.signal, onProgress: vi.fn() });
    expect(result.state).toBe(stage === "cancel" ? "aborted" : "failed");
    expect(record.providerAccount?.id).toBe("fallback");
    expect(command).toHaveBeenLastCalledWith(["release", "--lease", "sol-fallback"]);
    expect(command.mock.calls.filter(([args]) => args[0] === "release")).toHaveLength(1);
  });
});

describe("preferred-free normal-return account ownership", () => {
  it("propagates named return without selecting or borrowing a Codex lease", async () => {
    const { TemporaryFreeRouteReturnToNormalError, RETURN_TO_NORMAL } = await import("../src/temporary-free-route.ts");
    const cwd = await mkdtemp(join(tmpdir(), "steak-free-return-"));
    try {
      const record = task(); const fake = new FakeSession();
      fake.onPrompt = async () => { throw new TemporaryFreeRouteReturnToNormalError(); };
      const accountCommand = vi.fn(async () => { throw new Error("Virtual workers must not borrow a Codex lease"); });
      const model = { provider: "steak-pi", id: "preferred-free", api: "pi-virtual" } as never;
      const runner = createPiWorkerRunner({ relay: setupBroker(), accountCommand,
        resolveRuntime: () => ({ model, thinkingLevel: "high" }), sessionFactory: async () => ({ session: fake }) });
      const result = await runner({ run: run(cwd, record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
      expect(result.state).toBe("failed"); expect(result.error).toContain(RETURN_TO_NORMAL);
      expect(accountCommand).not.toHaveBeenCalled(); expect(record.providerAccount).toBeUndefined();
      expect(fake.disposed).toBe(true);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
});

// A spent plan is `usage`, not `rate`: the router holds the account out, so the next dispatch's preflight skips it.
// Go reports its plan exhaustion as an HTTP 429 whose body is `GoUsageLimitError`; it used to be recorded as a
// transient `rate` limit, which no preflight reads as exhaustion.
describe("worker plan exhaustion is reported to the account router as usage", () => {
  const goModel = { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1" } as never;
  const solModel = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text"] } as any;
  const solRuntime = () => ({ isUsingOAuth: () => true, hasConfiguredAuth: () => true,
    getModels: () => [solModel], getModel: () => solModel, getProvider: () => undefined, getRegisteredNativeProvider: () => undefined } as unknown as ModelRuntime);
  const goAgentDir = join(homedir(), ".ultraterm/provider-accounts/opencode-go/primary/agent");

  /** Run one account-bound worker whose very first request is refused with `errorMessage`; return the router `limit` calls. */
  it("an unproven lease release is the headline failure even after a quota-worded refusal, so it never falls through", async () => {
    const record = task(); const fake = new FakeSession();
    fake.onPrompt = async (session) => {
      const failed = { role: "assistant" as const, content: [], api: "test", provider: "test", model: "test", usage: usage(0), stopReason: "error",
        errorMessage: '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}', timestamp: Date.now() };
      session.emit({ type: "turn_start" } as AgentSessionEvent);
      session.emit({ type: "message_end", message: failed } as AgentSessionEvent);
      session.emit({ type: "turn_end", message: failed, toolResults: [] } as AgentSessionEvent);
    };
    const command = vi.fn(async (args: string[]) => {
      if (args[0] === "release") throw new Error("router unavailable");
      return args[0] !== "select" ? { ok: true } : { ok: true, account: { id: "primary", agentDir: goAgentDir }, lease: "lease-go" };
    });
    const runner = createPiWorkerRunner({ relay: setupBroker(), accountCommand: command,
      resolveRuntime: () => ({ model: goModel, thinkingLevel: "off" }), sessionFactory: async () => ({ session: fake }) });
    const result = await runner({ run: run("/tmp", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/^Go account lease release failed; router TTL retains a bounded lease; earlier failure: .*GoUsageLimitError/);
    expect(isQuotaLaunchFailure(result.error ?? "")).toBe(false);
  });

  async function refusedLimitCalls(kind: "go" | "sol", errorMessage: string): Promise<string[][]> {
    const record = task(); const fake = new FakeSession();
    fake.onPrompt = async (session) => {
      const failed = { role: "assistant" as const, content: [], api: "test", provider: "test", model: "test", usage: usage(0), stopReason: "error", errorMessage, timestamp: Date.now() };
      session.emit({ type: "turn_start" } as AgentSessionEvent);
      session.emit({ type: "message_end", message: failed } as AgentSessionEvent);
      session.emit({ type: "turn_end", message: failed, toolResults: [] } as AgentSessionEvent);
    };
    const command = vi.fn(async (args: string[]) => args[0] !== "select" ? { ok: true }
      : kind === "go" ? { ok: true, account: { id: "primary", agentDir: goAgentDir }, lease: "lease-go" }
        : { ok: true, account: { id: "primary", agentDir: isolatedCodexAgentDir("primary") }, lease: "lease-sol" });
    const runner = createPiWorkerRunner({ relay: setupBroker(), accountCommand: command,
      resolveRuntime: () => ({ model: kind === "go" ? goModel : solModel, thinkingLevel: "off" }),
      ...(kind === "sol" ? { createModelRuntime: async () => solRuntime() } : {}),
      sessionFactory: async () => ({ session: fake }) });
    const result = await runner({ run: run("/tmp", record), task: record, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("failed");
    return command.mock.calls.map(([args]) => args as string[]).filter((args) => args[0] === "limit");
  }

  it("reports Pi's ChatGPT sentence without a reset time as --kind rate, never as a spent plan", async () => {
    const limits = await refusedLimitCalls("sol", "You have hit your ChatGPT usage limit (pro plan).");
    expect(limits).toEqual([["limit", "--provider", "codex", "--account", expect.any(String), "--kind", "rate", "--reason", "worker HTTP 429"]]);
  });

  it("reports Go's 429 GoUsageLimitError as --kind usage, naming the plan limit", async () => {
    const limits = await refusedLimitCalls("go", '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}');
    expect(limits).toEqual([["limit", "--provider", "opencode-go", "--account", "primary", "--kind", "usage", "--reason", "worker Go usage limit exceeded"]]);
  });

  it.each([
    ["Go usage limit exceeded without the error type", "go", "Go usage limit exceeded", "opencode-go", "worker Go usage limit exceeded"],
    ["Codex usage limit has been reached", "sol", "The usage limit has been reached", "codex", "worker usage limit reached"],
    ["Codex usage_limit_reached with a 429", "sol", "429 usage_limit_reached: weekly window", "codex", "worker usage limit reached"],
    ["Codex subscription_quota_exceeded", "sol", "subscription_quota_exceeded", "codex", "worker subscription_quota_exceeded"],
    // Pi's own rewrite of every real Codex 429 / usage_limit_reached.
    ["Pi's ChatGPT usage-limit sentence", "sol", "You have hit your ChatGPT usage limit (pro plan). Try again in ~120 min.", "codex", "worker ChatGPT usage limit reached"],
  ] as const)("reports %s as --kind usage", async (_name, kind, message, provider, reason) => {
    const limits = await refusedLimitCalls(kind, message);
    expect(limits).toEqual([["limit", "--provider", provider, "--account", "primary", "--kind", "usage", "--reason", reason]]);
  });

  it.each([["go", "429 Too Many Requests"], ["sol", "429 rate_limit_exceeded: slow down"]] as const)("keeps a bare 429 on %s a transient rate limit", async (kind, message) => {
    const limits = await refusedLimitCalls(kind, message);
    expect(limits).toEqual([["limit", "--provider", kind === "go" ? "opencode-go" : "codex", "--account", "primary", "--kind", "rate", "--reason", "worker HTTP 429"]]);
  });

  it("reports nothing for a failure that is neither a usage limit nor a 429", async () => {
    expect(await refusedLimitCalls("go", "connection reset by peer")).toEqual([]);
  });
});

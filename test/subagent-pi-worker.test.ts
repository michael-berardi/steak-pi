import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSessionEvent,
  CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PI_WORKER_TURNS,
  PI_WORKER_TURN_WARNING_AT,
  buildPiWorkerSystemPrompt,
  classifyPiWorkerState,
  createGuardedPiWorkerTools,
  createIsolatedResourceLoader,
  createPiWorkerRunner,
  truncatePiWorkerOutput,
  type PiWorkerSession,
} from "../src/subagents/pi-worker.ts";
import { RelayBroker } from "../src/subagents/relay.ts";
import {
  OUTPUT_LIMIT,
  USAP_VERSION,
  emptyUsage,
  type RunRecord,
  type TaskRecord,
  type UsageTotals,
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

function run(cwd: string, recordTask: TaskRecord): RunRecord {
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
    expect(result).toMatchObject({ state: successes ? "done" : "failed", toolErrors: 1, toolSuccesses: successes, output: "Claimed completion" });
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

    expect(result).toMatchObject({ state: "done", output: "Evidence: done", turns: 1, truncated: false });
    expect(result.usage).toEqual(usage(2));
    expect(fake.disposed).toBe(true);
    expect(fake.prompts[0].options).toEqual({ expandPromptTemplates: false });
    expect(captured).toHaveLength(1);
    expect(captured[0].cwd).toBe(cwd);
    expect(captured[0].model).toBe(fakeModel);
    expect(captured[0].thinkingLevel).toBe("low");
    expect(captured[0].tools).toEqual(["read", "grep", "find", "ls", "ultraterm_relay"]);
    expect(captured[0].sessionManager?.getSessionFile()).toBeUndefined();
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
    expect(result).toMatchObject({ state: "aborted", output: "partial after abort" });
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

  it("enforces the twelve-turn cap without counting usage from other event types", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-pi-turns-"));
    const recordTask = task();
    const relay = setupBroker();
    const fake = new FakeSession();
    fake.onPrompt = async (session) => {
      for (let index = 0; index < MAX_PI_WORKER_TURNS + 2; index += 1) {
        const message = assistant(`turn ${index}`, index === MAX_PI_WORKER_TURNS ? "aborted" : "toolUse");
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

    const result = await runner({ run: run(cwd, recordTask), task: recordTask, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(result.state).toBe("failed");
    expect(result.error).toContain("12-turn limit");
    expect(result.turns).toBe(MAX_PI_WORKER_TURNS);
    expect(result.usage.input).toBe(MAX_PI_WORKER_TURNS);
    expect(fake.steers).toEqual([
      `Only ${MAX_PI_WORKER_TURNS - PI_WORKER_TURN_WARNING_AT} assistant turns remain. Stop gathering new evidence and return the required concise report now.`,
    ]);
    expect(fake.abortCalls).toBe(1);
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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { RetiredModelSelectionError } from "../src/retired-model-selection.ts";
import { CheckpointStore } from "../src/subagents/checkpoints.ts";
import { normalizeDispatch } from "../src/subagents/policy.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUltratermSubagentsExtension,
  renderRunProgress,
  renderRunResult,
  renderSessionStatus,
  toRunView,
  ultratermSubagentsSchema,
  usapTelemetrySnapshot,
} from "../extensions/ultraterm-subagents.ts";
import type { RelayBroker } from "../src/subagents/relay.ts";
import { emptyUsage, type UsageTotals, type WorkerRunner } from "../src/subagents/types.ts";

const dirs: string[] = [];

function usage(seed: number): UsageTotals {
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

function harness(runnerFactory: (relay: RelayBroker) => WorkerRunner, durable?: { root: string; parent: string; prefix: string }) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const messages: any[] = [];
  const entries: any[] = [];
  const statuses: Array<string | undefined> = [];
  const pi = {
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
    sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
  } as unknown as ExtensionAPI;
  let id = 0;
  createUltratermSubagentsExtension({
    createRunner: (_pi, relay) => runnerFactory(relay),
    idFactory: () => `${durable?.prefix ?? "fixed"}-${++id}`,
    profiles: [],
    checkpointRoot: durable?.root,
  })(pi);
  const cwd = mkdtempSync(join(tmpdir(), "steak-usap-extension-"));
  dirs.push(cwd);
  const model = { provider: "zai", id: "glm-5.3-flash", input: ["text", "image"] };
  const ctx = {
    cwd,
    model,
    modelRegistry: {
      isUsingOAuth: () => false,
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
      getProvider: () => ({ streamSimple() {} }),
      find: () => model,
    },
    thinkingLevel: "high",
    ...(durable ? { sessionManager: { getSessionFile: () => durable.parent } } : {}),
    ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
  } as any;
  return { tools, handlers, messages, statuses, entries, ctx };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("UltraTerm Subagent Protocol Pi extension", () => {
  it("emits bounded assignment labels and genuine lifecycle, never prompts or fake progress", () => {
    const run = {
      id: "run-1", state: "done", goal: "PRIVATE GOAL",
      tasks: [{ id: "task-1", label: "Review\nsidebar", state: "done", startedAt: 1000, endedAt: 2400,
        task: "PRIVATE PROMPT", output: "PRIVATE OUTPUT", currentTool: "read" }],
    } as unknown as Parameters<typeof usapTelemetrySnapshot>[0];
    const snapshot = usapTelemetrySnapshot(run);
    expect(snapshot.tasks[0]).toEqual({ taskId: "task-1", label: "Review sidebar", state: "done", detail: "Finished — ready for parent verification", startedAt: 1000, endedAt: 2400, currentTool: "read", toolErrors: 0, toolSuccesses: 0 });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
    expect(snapshot.tasks[0]).not.toHaveProperty("totalSteps");
    run.tasks[0].label = "a".repeat(200);
    run.tasks[0].startedAt = Number.NaN;
    delete run.tasks[0].endedAt;
    const pending = usapTelemetrySnapshot(run).tasks[0];
    expect(pending.label).toHaveLength(80);
    expect(pending).not.toHaveProperty("startedAt");
    expect(pending).not.toHaveProperty("endedAt");
  });
  it("registers only the canonical parent tools", () => {
    const h = harness(() => async () => ({ state: "done", output: "ok", turns: 1, usage: usage(1) }));
    expect([...h.tools.keys()]).toEqual(["ultraterm_subagents", "ultraterm_hub"]);
    const guidelines = h.tools.get("ultraterm_subagents").promptGuidelines.join(" ");
    expect(guidelines).toContain("Fan out by default");
    expect(guidelines).toContain("Parent owns decomposition");
    expect(guidelines).toContain("Delegation must buy completion speed");
    expect(guidelines).toContain("dispatch in the first tool turn");
    expect(guidelines).toContain("do not duplicate child discovery");
    expect(guidelines).toContain("Never start a background run merely to wait immediately");
    expect(guidelines).toContain("For read-only tasks omit ownedPaths");
    expect(guidelines).toContain("allowBash bypasses ownedPaths");
    const taskProperties = (ultratermSubagentsSchema as any).properties.tasks.items.properties;
    expect(taskProperties.ownedPaths.description).toContain("omit for read-only tasks");
    expect(taskProperties.allowBash.description).toContain("unsandboxed shell access");
  });

  it("returns ordered all-settled foreground evidence and nested usage without throwing on a leaf failure", async () => {
    const h = harness(() => async ({ task }) => task.label === "bad"
      ? { state: "failed", output: "partial", error: "synthetic", turns: 1, usage: usage(2) }
      : { state: "done", output: task.label, turns: 1, usage: usage(1) });
    const result = await h.tools.get("ultraterm_subagents").execute("call", {
      goal: "check two leaves",
      tasks: [{ label: "good", task: "good" }, { label: "bad", task: "bad" }],
    }, undefined, vi.fn(), h.ctx);

    expect(result.details.run.state).toBe("failed");
    expect(result.details.run.tasks.map((task: any) => [task.label, task.state]))
      .toEqual([["good", "done"], ["bad", "failed"]]);
    expect(result.content[0].text).toContain("[bad] failed");
    expect(result.usage.totalTokens).toBe(30);
  });

  it("starts background work, delivers one passive completion, and attributes usage on the first terminal wait only", async () => {
    const h = harness(() => async ({ task }) => ({ state: "done", output: task.label, turns: 1, usage: usage(1) }));
    const started = await h.tools.get("ultraterm_subagents").execute("call", {
      goal: "background",
      background: true,
      tasks: [{ label: "one", task: "one" }],
    }, undefined, undefined, h.ctx);
    expect(started.details.mode).toBe("background");
    expect(started.usage).toBeUndefined();
    await flush();
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: false });

    const runId = started.details.run.runId;
    const first = await h.tools.get("ultraterm_hub").execute("hub", {
      action: "wait", runId, mode: "all", timeoutMs: 100,
    }, undefined, undefined, h.ctx);
    const second = await h.tools.get("ultraterm_hub").execute("hub", {
      action: "wait", runId, mode: "all", timeoutMs: 100,
    }, undefined, undefined, h.ctx);
    expect(first.usage.totalTokens).toBe(10);
    expect(second.usage).toBeUndefined();
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  it("keeps explicit cross-model provenance and tool evidence through dispatch, hub and telemetry", async () => {
    const h = harness(() => async () => ({ state: "done", output: "verified", turns: 1, usage: usage(1), toolErrors: 0, toolSuccesses: 4 }));
    h.ctx.model = { provider: "openai-codex", id: "gpt-6-astra" };
    const receipt = await h.tools.get("ultraterm_subagents").execute("call", {
      goal: "explicit GLM reviewer", model: "zai/glm-5.3-flash", requireImages: true,
      tasks: [{ label: "review", task: "review", role: "reviewer" }], background: true,
    }, undefined, undefined, h.ctx);
    const runId = receipt.details.run.runId;
    const result = await h.tools.get("ultraterm_hub").execute("hub", { action: "wait", runId, mode: "all", timeoutMs: 100 }, undefined, undefined, h.ctx);
    expect(result.details.run.model).toBe("zai/glm-5.3-flash");
    expect(result.details.run.selection).toMatchObject({ provider: "zai", modelId: "glm-5.3-flash", source: "override", images: true, tools: true });
    expect(result.details.run.tasks[0]).toMatchObject({ toolErrors: 0, toolSuccesses: 4 });
    expect(h.entries.at(-1).data.selection.source).toBe("override");
    expect(h.entries.at(-1).data.tasks[0].toolSuccesses).toBe(4);
    expect(result.usage.totalTokens).toBe(10);
  });

  it("rejects conflicting selectors before invoking any worker", async () => {
    const runner = vi.fn(async () => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner);
    await expect(h.tools.get("ultraterm_subagents").execute("call", {
      goal: "conflict", model: "zai/glm-5.3-flash", profile: "steak-pi/glm-5-3-flash", tasks: [{ label: "one", task: "one" }],
    }, undefined, undefined, h.ctx)).rejects.toThrow(/conflict/);
    expect(runner).not.toHaveBeenCalled();
    const listed = await h.tools.get("ultraterm_hub").execute("hub", { action: "list" }, undefined, undefined, h.ctx);
    expect(listed.details.runs).toEqual([]);
  });

  it("binds parent relay identity for send and inbox", async () => {
    let release!: () => void;
    let childMessage: unknown;
    const h = harness((relay) => async ({ run, task, signal }) => {
      const peer = relay.bind(run.id, task.id);
      const pending = new Promise<void>((resolve) => { release = resolve; });
      signal.addEventListener("abort", release, { once: true });
      await pending;
      childMessage = peer.inbox().messages[0];
      peer.send({
        to: "parent",
        body: "child reply",
        kind: "reply",
        replyTo: (childMessage as { id: string }).id,
      });
      return { state: signal.aborted ? "aborted" : "done", output: "done", turns: 1, usage: emptyUsage() };
    });
    const started = await h.tools.get("ultraterm_subagents").execute("call", {
      goal: "relay",
      background: true,
      tasks: [{ label: "one", task: "one" }],
    }, undefined, undefined, h.ctx);
    await flush();
    const runId = started.details.run.runId;
    const taskId = started.details.run.tasks[0].taskId;
    const sent = await h.tools.get("ultraterm_hub").execute("hub", {
      action: "send", runId, to: taskId, body: "parent fact", kind: "request",
    }, undefined, undefined, h.ctx);
    expect(sent.details.relay.ok).toBe(true);
    release();
    await flush();
    expect(childMessage).toMatchObject({ from: "parent", body: "parent fact" });
    const inbox = await h.tools.get("ultraterm_hub").execute("hub", {
      action: "inbox", runId,
    }, undefined, undefined, h.ctx);
    expect(inbox.details.relay.messages[0]).toMatchObject({ from: taskId, body: "child reply" });
  });

  it("cancels live work and shuts down without launching replacement work", async () => {
    const launched: string[] = [];
    const h = harness(() => async ({ task, signal }) => new Promise((resolve) => {
      launched.push(task.id);
      signal.addEventListener("abort", () => resolve({
        state: "aborted", output: "", turns: 0, usage: emptyUsage(),
      }), { once: true });
    }));
    const started = await h.tools.get("ultraterm_subagents").execute("call", {
      goal: "cancel",
      background: true,
      concurrency: 1,
      tasks: [{ label: "one", task: "one" }, { label: "two", task: "two" }],
    }, undefined, undefined, h.ctx);
    await flush();
    await h.tools.get("ultraterm_hub").execute("hub", {
      action: "cancel", runId: started.details.run.runId,
    }, undefined, undefined, h.ctx);
    await flush();
    expect(launched).toHaveLength(1);
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    expect(h.statuses.at(-1)).toBeUndefined();
  });

  it("awaits real shutdown before persisting terminal telemetry, without completion chatter", async () => {
    let release!: () => void;
    const h = harness(() => async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { release = resolve; }, { once: true });
      });
      return { state: "aborted", output: "", turns: 0, usage: emptyUsage() };
    });
    await h.tools.get("ultraterm_subagents").execute("call", {
      goal: "shutdown", background: true, tasks: [{ label: "one", task: "one" }],
    }, undefined, undefined, h.ctx);
    await flush();
    let closed = false;
    const shutdown = Promise.resolve(h.handlers.get("session_shutdown")!({}, h.ctx)).then(() => { closed = true; });
    await flush();
    expect(closed).toBe(false);
    expect(h.entries.at(-1).data.runState).toBe("running");
    release();
    await shutdown;
    expect(h.entries.at(-1).data).toMatchObject({ runState: "aborted", tasks: [{ state: "aborted" }] });
    expect(h.messages).toHaveLength(0);
    await h.handlers.get("session_start")!({}, h.ctx);
    const count = h.entries.length;
    await flush();
    expect(h.entries).toHaveLength(count);
  });

  it("evicts coordinator, binding, runtime, and relay state beyond the terminal retention bound", async () => {
    let broker!: RelayBroker;
    const h = harness((relay) => {
      broker = relay;
      return async () => ({ state: "done", output: "ok", turns: 1, usage: usage(1) });
    });
    let firstRunId = "";
    for (let index = 0; index < 51; index += 1) {
      const result = await h.tools.get("ultraterm_subagents").execute("call", {
        goal: `retention-${index}`,
        tasks: [{ label: "one", task: "one" }],
      }, undefined, undefined, h.ctx);
      if (index === 0) firstRunId = result.details.run.runId;
    }
    await flush();

    const listed = await h.tools.get("ultraterm_hub").execute("hub", {
      action: "list",
    }, undefined, undefined, h.ctx);
    expect(listed.details.runs).toHaveLength(50);
    expect(() => broker.bind(firstRunId, "parent")).toThrow(/unknown relay run/i);
  });

  it("retries a transient SDK idle boundary without another user turn", async () => {
    vi.useFakeTimers();
    const h = harness(() => async () => ({ state: "done", output: "ready", turns: 1, usage: emptyUsage() }));
    let idle = false;
    h.ctx.isIdle = () => idle;
    await h.handlers.get("session_start")!({}, h.ctx);
    await h.tools.get("ultraterm_subagents").execute("call", { goal: "idle edge", background: true, tasks: [{ label: "one", task: "one" }] }, undefined, undefined, h.ctx);
    await flush();
    expect(h.messages).toHaveLength(0);
    idle = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].options.triggerTurn).toBe(false);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resend a submission while its native receipt is delayed", async () => {
    vi.useFakeTimers();
    const h = harness(() => async () => ({ state: "done", output: "ready", turns: 1, usage: emptyUsage() }));
    const receipts: any[] = [];
    h.ctx.sessionManager = { getEntries: () => receipts };
    await h.tools.get("ultraterm_subagents").execute("call", { goal: "receipt edge", background: true, tasks: [{ label: "one", task: "one" }] }, undefined, undefined, h.ctx);
    await flush();
    expect(h.messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(300);
    await h.handlers.get("agent_settled")!({}, h.ctx);
    expect(h.messages).toHaveLength(1);
    receipts.push({ type: "custom_message", ...h.messages[0].message });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.messages).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("bounds unconfirmed receipt checks and surfaces the retained result", async () => {
    vi.useFakeTimers();
    const h = harness(() => async () => ({ state: "done", output: "ready", turns: 1, usage: emptyUsage() }));
    h.ctx.sessionManager = { getEntries: () => [] };
    await h.tools.get("ultraterm_subagents").execute("call", { goal: "unconfirmed", background: true, tasks: [{ label: "one", task: "one" }] }, undefined, undefined, h.ctx);
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.messages).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.statuses.some((text) => text?.includes("delivery unconfirmed"))).toBe(true);
    await h.handlers.get("agent_settled")!({}, h.ctx);
    expect(h.messages).toHaveLength(1);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("delivers busy-parent completions at settlement, once, without waiting for user input", async () => {
    const h = harness(() => async () => ({ state: "done", output: "ready", turns: 1, usage: emptyUsage() }));
    await h.handlers.get("session_start")!({}, h.ctx);
    await h.handlers.get("agent_start")!({}, h.ctx);
    for (let index = 0; index < 3; index++) {
      await h.tools.get("ultraterm_subagents").execute("call", { goal: "busy", background: true, tasks: [{ label: "one", task: "one" }] }, undefined, undefined, h.ctx);
    }
    await flush();
    expect(h.messages).toHaveLength(0);
    await h.handlers.get("agent_settled")!({}, h.ctx);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].message.details.coalesced).toBe(3);
    expect(h.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: false });
    await h.handlers.get("agent_start")!({}, h.ctx);
    await h.handlers.get("agent_settled")!({}, h.ctx);
    expect(h.messages).toHaveLength(1);
  });

  it("recovers completed history and diagnoses it without replaying completed work", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-recovery-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "first" };
    const h = harness(() => async () => ({ state: "done", output: "finished", turns: 1, usage: emptyUsage() }), durable);
    const result = await h.tools.get("ultraterm_subagents").execute("call", { goal: "durable", tasks: [{ label: "done", task: "done" }] }, undefined, undefined, h.ctx);
    const runId = result.details.run.runId;
    await h.handlers.get("session_shutdown")!({}, h.ctx);
    const runner = vi.fn(async () => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }));
    const next = harness(() => runner, { ...durable, prefix: "second" });
    await next.handlers.get("session_start")!({}, next.ctx);
    const status = await next.tools.get("ultraterm_hub").execute("hub", { action: "status", runId }, undefined, undefined, next.ctx);
    expect(status.details.run.state).toBe("done");
    expect(runner).not.toHaveBeenCalled();
    await expect(next.tools.get("ultraterm_hub").execute("hub", { action: "resume", runId }, undefined, undefined, next.ctx)).rejects.toThrow(/No unfinished/);
    const diagnostics = await next.tools.get("ultraterm_hub").execute("hub", { action: "diagnose", runId }, undefined, undefined, next.ctx);
    expect(diagnostics.details.diagnostics.persistence).toBe("checkpointed");
    await next.handlers.get("session_shutdown")!({}, next.ctx);
  });

  it.each(["model", "profile"])("rejects retired Sol %s again after restart without rewriting its checkpoint", async boundary => {
    const root = mkdtempSync(join(tmpdir(), "usap-retired-restart-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "retired" };
    const store = new CheckpointStore(durable.parent, durable.root);
    const run = normalizeDispatch({ goal: "continue", background: true, tasks: [{ label: "unfinished", task: "continue" }] }, root, "openai-codex/gpt-6.1-sol", "medium", Date.now(), () => "retired-checkpoint");
    // Model an already-persisted pre-retirement record: never migrate history.
    if (boundary === "model") run.model = "openai-codex/gpt-6-sol";
    else run.selection = { provider: "openai-codex", modelId: "gpt-6.1-sol", profile: "steak-pi/gpt-6-sol", source: "override", images: false, tools: true };
    store.save(run, true); store.close();
    const runner = vi.fn(async () => ({ state: "done" as const, output: "unexpected", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner, durable);
    await h.handlers.get("session_start")!({}, h.ctx);
    try {
      await expect(h.tools.get("ultraterm_hub").execute("hub", { action: "resume", runId: run.id }, undefined, undefined, h.ctx)).rejects.toThrow(RetiredModelSelectionError);
      expect(runner).not.toHaveBeenCalled();
      const status = await h.tools.get("ultraterm_hub").execute("hub", { action: "status", runId: run.id }, undefined, undefined, h.ctx);
      expect(status.details.run.model).toBe(run.model);
    } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    const reopened = new CheckpointStore(durable.parent, durable.root);
    try {
      expect(reopened.get(run.id)?.run.model).toBe(run.model);
      expect(reopened.get(run.id)?.resumedAs).toBeUndefined();
      expect(reopened.get(run.id)?.pendingResume).toBeUndefined();
    } finally { reopened.close(); }
  });

  it("resumes an interrupted native checkpoint once and excludes completed siblings", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-resume-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "resumed" };
    const store = new CheckpointStore(durable.parent, durable.root);
    const run = normalizeDispatch({ goal: "continue", background: true, tasks: [{ label: "complete", task: "complete" }, { label: "unfinished", task: "continue" }] }, root, "zai/glm-5.3-flash", "medium", Date.now(), () => "interrupted");
    run.tasks[0].state = "done";
    run.tasks[1].state = "running"; run.tasks[1].startedAt = Date.now();
    const sessionFile = join(store.sessionsDirectory, "native.jsonl"); writeFileSync(sessionFile, "checkpoint", { mode: 0o600 });
    run.tasks[1].sessionFile = sessionFile;
    store.save(run, true); store.close();
    const launched: string[] = [];
    const h = harness(() => async ({ task }) => {
      launched.push(task.label);
      expect(task.sessionFile).toBe(sessionFile);
      return { state: "done", output: "continued", turns: 1, usage: emptyUsage() };
    }, durable);
    await h.handlers.get("session_start")!({}, h.ctx);
    const diagnose = await h.tools.get("ultraterm_hub").execute("hub", { action: "diagnose", runId: run.id }, undefined, undefined, h.ctx);
    expect(diagnose.details.diagnostics.tasks[1].reason).toBe("host_interrupted");
    const resumed = await h.tools.get("ultraterm_hub").execute("hub", { action: "resume", runId: run.id }, undefined, undefined, h.ctx);
    expect(resumed.details.run.tasks).toHaveLength(1);
    await flush();
    expect(launched).toEqual(["unfinished"]);
    await expect(h.tools.get("ultraterm_hub").execute("hub", { action: "resume", runId: run.id }, undefined, undefined, h.ctx)).rejects.toThrow(/Already resumed/);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("keeps compact public views deterministic", () => {
    const run = {
      id: "run-a", goal: "g", state: "running", model: "zai/glm-5.3-flash",
      thinkingLevel: "high", background: true, createdAt: 1, constraints: [], cwd: "/tmp",
      concurrency: 1, timeoutMs: 1000, version: "1.0", usage: emptyUsage(),
      tasks: [{ id: "t", label: "l", task: "x", role: "scout", mayEdit: false,
        ownedPaths: [], allowBash: false, state: "running", output: "", turns: 0,
        usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false }],
    } as any;
    expect(renderRunProgress(run)).toBe("USAP run-a: 0/1 settled · running");
    expect(renderSessionStatus([run])).toBe("USAP 1 run · 0/1 settled");
    expect(toRunView(run).tasks[0].taskId).toBe("t");
    expect(renderRunResult(run)).toContain("model zai/glm-5.3-flash · thinking high");
    expect(renderRunResult(run)).toContain("zai/");
    expect(toRunView(run).model).toBe("zai/glm-5.3-flash");
  });
});

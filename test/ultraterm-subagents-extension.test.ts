import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function harness(runnerFactory: (relay: RelayBroker) => WorkerRunner, durable?: { root: string; parent: string; prefix: string }, shutdownGraceMs?: number) {
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
    shutdownGraceMs,
  })(pi);
  const cwd = mkdtempSync(join(tmpdir(), "steak-usap-extension-"));
  dirs.push(cwd);
  const model = { provider: "zai", id: "glm-5.3-flash", baseUrl: "https://api.z.ai/api/coding/paas/v4", input: ["text", "image"] };
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
    sessionManager: { getSessionFile: () => durable?.parent, getSessionId: () => durable?.parent ?? cwd, getEntries: () => messages.map(({ message }) => ({ type: "custom_message", ...message })) },
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
  it("refuses every foreign-session hub action and dispatch before exposing a run", async () => {
    const runner = vi.fn(async () => ({ state: "done" as const, output: "owner-only evidence", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner);
    const dispatched = await h.tools.get("ultraterm_subagents").execute("a", { goal: "owner A", tasks: [{ label: "A", task: "A" }] }, undefined, undefined, h.ctx);
    const runId = dispatched.details.run.runId;
    const foreign = { ...h.ctx, sessionManager: { getSessionId: () => "foreign-session" } };
    for (const action of ["list", "status", "wait", "cancel", "send", "inbox", "resume", "diagnose"]) {
      await expect(h.tools.get("ultraterm_hub").execute("b", { action, runId, ...(action === "send" ? { to: "#run", body: "foreign" } : {}) }, undefined, undefined, foreign)).rejects.toThrow(/ownership mismatch/);
    }
    await expect(h.tools.get("ultraterm_subagents").execute("b", { goal: "foreign", tasks: [{ label: "B", task: "B" }] }, undefined, undefined, foreign)).rejects.toThrow(/ownership mismatch/);
    expect(runner).toHaveBeenCalledTimes(1);
    await h.handlers.get("session_shutdown")!({}, foreign);
    expect((await h.tools.get("ultraterm_hub").execute("a", { action: "status", runId }, undefined, undefined, h.ctx)).details.run.runId).toBe(runId);
    await h.handlers.get("session_start")!({}, foreign);
    expect((await h.tools.get("ultraterm_hub").execute("b", { action: "list" }, undefined, undefined, foreign)).details.runs).toEqual([]);
    await expect(h.tools.get("ultraterm_hub").execute("b", { action: "status", runId }, undefined, undefined, foreign)).rejects.toThrow(/Unknown USAP run/);
    await h.handlers.get("session_shutdown")!({}, foreign);
  });

  it("blocks late telemetry, stream updates and completion delivery after a captured context changes owner", async () => {
    let finish!: () => void;
    let progress: ((value: any) => void) | undefined;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const h = harness(() => async ({ onProgress }) => {
      progress = onProgress;
      await pending;
      return { state: "done", output: "ONLY_OWNER_A", turns: 1, usage: emptyUsage() };
    });
    const updates = vi.fn();
    await h.tools.get("ultraterm_subagents").execute("a", { goal: "private A", background: true, tasks: [{ label: "A", task: "A" }] }, undefined, updates, h.ctx);
    await vi.waitFor(() => expect(progress).toBeDefined());
    const originalId = h.ctx.sessionManager.getSessionId;
    h.ctx.sessionManager.getSessionId = () => "foreign-session";
    const entriesBefore = h.entries.length, updatesBefore = updates.mock.calls.length;
    progress!({ currentTool: "read", turns: 1 });
    finish();
    await new Promise(resolve => setTimeout(resolve, 20));
    await h.handlers.get("agent_settled")!({}, h.ctx);
    expect(h.entries).toHaveLength(entriesBefore);
    expect(updates).toHaveBeenCalledTimes(updatesBefore);
    expect(h.messages).toHaveLength(0);
    h.ctx.sessionManager.getSessionId = originalId;
    await h.handlers.get("agent_settled")!({}, h.ctx);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].message.details.runs[0].ownerSessionId).toBe(originalId());
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it.each(["foreground", "wait", "timeout"])("rechecks ownership after an asynchronous %s", async (mode) => {
    let finish: (() => void) | undefined;
    const h = harness(() => async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      return { state: "done", output: "private", turns: 1, usage: emptyUsage() };
    });
    const original = h.ctx.sessionManager.getSessionId;
    const dispatch = h.tools.get("ultraterm_subagents").execute("a", { goal: "private A", background: mode !== "foreground", tasks: [{ label: "A", task: "A" }] }, undefined, undefined, h.ctx);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const result = mode === "foreground" ? dispatch : h.tools.get("ultraterm_hub").execute("wait", {
      action: "wait", runId: (await dispatch).details.run.runId, mode: "all", timeoutMs: mode === "timeout" ? 1 : 1000,
    }, undefined, undefined, h.ctx);
    const rejected = expect(result).rejects.toThrow(/ownership mismatch/);
    h.ctx.sessionManager.getSessionId = () => "foreign-session";
    if (mode !== "timeout") finish!();
    await rejected;
    finish!();
    h.ctx.sessionManager.getSessionId = original;
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("keeps two simultaneous sessions private even with the same workspace and checkpoint root", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-two-sessions-")); dirs.push(root);
    const runner = () => async () => ({ state: "done" as const, output: "private", turns: 1, usage: emptyUsage() });
    const a = harness(runner, { root: join(root, "checkpoints"), parent: join(root, "A.jsonl"), prefix: "alpha" });
    const b = harness(runner, { root: join(root, "checkpoints"), parent: join(root, "B.jsonl"), prefix: "beta" });
    a.ctx.cwd = b.ctx.cwd = root;
    const [ar, br] = await Promise.all([a, b].map((h, i) => h.tools.get("ultraterm_subagents").execute("start", { goal: i === 0 ? "private A" : "private B", tasks: [{ label: "one", task: "one" }] }, undefined, undefined, h.ctx)));
    for (const [owner, own, foreign] of [[a, ar, br], [b, br, ar]]) {
      const list = await owner.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, owner.ctx);
      expect(list.details.runs.map((run: any) => run.runId)).toEqual([own.details.run.runId]);
      for (const action of ["status", "wait", "cancel", "send", "inbox", "resume", "diagnose"]) {
        await expect(owner.tools.get("ultraterm_hub").execute("foreign", { action, runId: foreign.details.run.runId }, undefined, undefined, owner.ctx)).rejects.toThrow(/Unknown USAP run/);
      }
      expect(own.details.run.ownerSessionId).toBe(owner.ctx.sessionManager.getSessionId());
      await owner.handlers.get("session_shutdown")!({}, owner.ctx);
    }
  });

  it("fails closed without a native session identity", async () => {
    const h = harness(() => async () => ({ state: "done", output: "done", turns: 1, usage: emptyUsage() }));
    h.ctx.sessionManager = {};
    await expect(h.tools.get("ultraterm_hub").execute("missing", { action: "list" }, undefined, undefined, h.ctx)).rejects.toThrow(/native session identity/);
  });
  it.each([false, true])("removes cancelled live work from the pinned panel (background=%s)", async (background) => {
    let started = false;
    const h = harness(() => async ({ signal }) => {
      started = true;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { state: "aborted", output: "cancelled", turns: 0, usage: emptyUsage() };
    });
    const widgets = vi.fn(); h.ctx.ui.setWidget = widgets;
    const dispatch = h.tools.get("ultraterm_subagents").execute("start", { goal: "cancel proof", background,
      tasks: [{ label: "worker", task: "wait" }] }, undefined, undefined, h.ctx);
    await vi.waitFor(() => expect(started).toBe(true));
    const factory = widgets.mock.calls.filter(([key]) => key === "steak-pinned-panels").at(-1)?.[1];
    expect(typeof factory).toBe("function");
    const panel = factory({ requestRender() {} }, undefined);
    expect(panel.render(100).join("\n")).toContain("worker");
    const list = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
    await h.tools.get("ultraterm_hub").execute("cancel", { action: "cancel", runId: list.details.runs[0].runId }, undefined, undefined, h.ctx);
    await vi.waitFor(() => expect(widgets.mock.calls.filter(([key]) => key === "steak-pinned-panels").at(-1)?.[1]).toBeUndefined());
    const settled = await h.tools.get("ultraterm_hub").execute("status", { action: "status", runId: list.details.runs[0].runId }, undefined, undefined, h.ctx);
    expect(settled.details.run.tasks.every((task: any) => task.state === "aborted")).toBe(true);
    await dispatch;
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("shows background progress in the panel without duplicating it below the composer", async () => {
    const h = harness(() => async () => ({ state: "done", output: "done", turns: 1, usage: emptyUsage() }));
    const status = vi.fn(), widget = vi.fn();
    h.ctx.ui.setStatus = status;
    h.ctx.ui.setWidget = widget;
    await h.tools.get("ultraterm_subagents").execute("dispatch", {
      goal: "Panel-only progress", background: true, tasks: [{ label: "worker", task: "Finish" }],
    }, undefined, undefined, h.ctx);
    await vi.waitFor(() => expect(widget.mock.calls.some(([key, value]) => key === "steak-pinned-panels" && typeof value === "function")).toBe(true));
    expect(status.mock.calls.filter(([key]) => key === "usap").every(([, value]) => value === undefined)).toBe(true);
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  });
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
    h.ctx.sessionManager = { ...h.ctx.sessionManager, getEntries: () => receipts };
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
    h.ctx.sessionManager = { ...h.ctx.sessionManager, getEntries: () => [] };
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

  it("resumes an interrupted native checkpoint once and excludes completed siblings", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-resume-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "resumed" };
    const store = new CheckpointStore(durable.parent, durable.root, durable.parent);
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

  it("retains the checkpoint lease while a dispatched worker cannot settle, then releases and adopts it", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-retained-lease-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "retained" };
    const probe = new CheckpointStore(durable.parent, durable.root, durable.parent);
    const directory = probe.directory;
    probe.close();
    let started = false;
    let settleWorker!: () => void;
    const h = harness(() => async () => {
      started = true;
      // A real worker whose SDK stream never terminates: abort is best effort only.
      return new Promise((resolve) => {
        settleWorker = () => resolve({ state: "aborted" as const, output: "late flush", turns: 1, usage: emptyUsage() });
      });
    }, durable, 50);
    await h.handlers.get("session_start")!({}, h.ctx);
    const dispatched = await h.tools.get("ultraterm_subagents").execute("start", { goal: "hung worker", background: true, timeoutMs: 1_000, tasks: [{ label: "stuck", task: "stuck" }] }, undefined, undefined, h.ctx);
    const runId = dispatched.details.run.runId;
    await vi.waitFor(() => expect(started).toBe(true));
    expect(existsSync(join(directory, "owner.json"))).toBe(true);
    // The host replaces the session while the worker is still running. The bounded
    // wait may return the UI, but an unsettled worker can still write, so the lease
    // and live state are retained until the real shutdown settles.
    await h.handlers.get("session_shutdown")!({}, h.ctx);
    expect(existsSync(join(directory, "owner.json"))).toBe(true);
    // Chat is not bricked: read-only diagnostics still explain the live lease.
    const listed = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
    expect(listed.details.runs.map((run: any) => run.runId)).toContain(runId);
    expect(listed.details.readOnly).toBe(true);
    expect(listed.details.persistence).toBe("memory-only");
    expect(listed.details.shutdownWarning).toMatch(/lease retained/);
    const diagnostics = await h.tools.get("ultraterm_hub").execute("diag", { action: "diagnose", runId }, undefined, undefined, h.ctx);
    expect(diagnostics.details.diagnostics.readOnly).toBe(true);
    expect(diagnostics.details.diagnostics.persistence).toBe("memory-only");
    expect(diagnostics.details.diagnostics.shutdownWarning).toMatch(/lease retained/);
    expect(diagnostics.details.diagnostics.tasks[0].reason).toBe("host_interrupted");
    // New work is refused loudly instead of silently launching memory-only.
    await expect(h.tools.get("ultraterm_subagents").execute("blocked", { goal: "blocked", tasks: [{ label: "x", task: "x" }] }, undefined, undefined, h.ctx)).rejects.toThrow(/refused: .*lease retained/);
    await expect(h.tools.get("ultraterm_hub").execute("blocked", { action: "resume", runId }, undefined, undefined, h.ctx)).rejects.toThrow(/refused/);
    // Real settlement closes the captured store; the next tool call adopts it.
    settleWorker();
    await vi.waitFor(() => expect(existsSync(join(directory, "owner.json"))).toBe(false));
    const recovered = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
    expect(recovered.details.runs.map((run: any) => run.runId)).toContain(runId);
    expect(recovered.details.persistence).toBe("checkpointed");
    expect(recovered.details.readOnly).toBe(false);
    expect(recovered.details.shutdownWarning).toBeNull();
    const healthy = await h.tools.get("ultraterm_hub").execute("diag", { action: "diagnose", runId }, undefined, undefined, h.ctx);
    expect(healthy.details.diagnostics.persistence).toBe("checkpointed");
    expect(healthy.details.diagnostics.tasks[0].reason).toBe("host_interrupted");
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("adopts a released lease with recovery reconciliation and never replays a delivered completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-adopt-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "adopt" };
    const runner = vi.fn(async () => ({ state: "done" as const, output: "finished", turns: 1, usage: emptyUsage() }));
    const owner = harness(() => runner, durable);
    await owner.handlers.get("session_start")!({}, owner.ctx);
    const dispatched = await owner.tools.get("ultraterm_subagents").execute("a", { goal: "durable", background: true, tasks: [{ label: "done", task: "done" }] }, undefined, undefined, owner.ctx);
    const runId = dispatched.details.run.runId;
    await flush();
    expect(owner.messages).toHaveLength(1);
    // A duplicate instance starts degraded while the live owner holds the lease.
    const duplicate = harness(() => runner, durable);
    await duplicate.handlers.get("session_start")!({}, duplicate.ctx);
    const degraded = await duplicate.tools.get("ultraterm_hub").execute("b", { action: "list" }, undefined, undefined, duplicate.ctx);
    expect(degraded.details.persistence).toBe("memory-only");
    // The owner departs and its workers settle, so the lease is released.
    await owner.handlers.get("session_shutdown")!({}, owner.ctx);
    const listed = await duplicate.tools.get("ultraterm_hub").execute("c", { action: "list" }, undefined, undefined, duplicate.ctx);
    expect(listed.details.persistence).toBe("checkpointed");
    expect(listed.details.runs.map((run: any) => run.runId)).toContain(runId);
    expect(listed.details.runs[0].state).toBe("done");
    expect((await duplicate.tools.get("ultraterm_hub").execute("d", { action: "diagnose", runId }, undefined, undefined, duplicate.ctx)).details.diagnostics.persistence).toBe("checkpointed");
    // Adoption reconciles delivery: a completed, already-delivered run is never replayed.
    expect(duplicate.messages).toHaveLength(0);
    await duplicate.handlers.get("agent_settled")!({}, duplicate.ctx);
    expect(duplicate.messages).toHaveLength(0);
    await duplicate.handlers.get("session_shutdown")!({}, duplicate.ctx);
  });

  it.each([Number.NaN, -1, Number.POSITIVE_INFINITY, 1.5])("rejects an unsafe shutdownGraceMs (%s)", (grace) => {
    expect(() => createUltratermSubagentsExtension({ shutdownGraceMs: grace })).toThrow(RangeError);
  });

  it("accepts a zero shutdown grace and never launches memory-only work from a degraded session", async () => {
    expect(() => createUltratermSubagentsExtension({ shutdownGraceMs: 0 })).not.toThrow();
    const h = harness(() => async () => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }));
    const result = await h.tools.get("ultraterm_subagents").execute("call", { goal: "memory-only", tasks: [{ label: "one", task: "one" }] }, undefined, undefined, h.ctx);
    expect(result.details.persistence).toBe("memory-only");
    expect(result.content[0].text).toContain("memory-only");
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("degrades a duplicate extension instance instead of colliding with the live checkpoint owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-duplicate-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "dup" };
    const runner = vi.fn(async () => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }));
    const owner = harness(() => runner, durable);
    const probe = new CheckpointStore(durable.parent, durable.root, durable.parent);
    const directory = probe.directory;
    probe.close();
    await owner.handlers.get("session_start")!({}, owner.ctx);
    const owned = await owner.tools.get("ultraterm_subagents").execute("a", { goal: "owner", background: true, tasks: [{ label: "one", task: "one" }] }, undefined, undefined, owner.ctx);
    const duplicate = harness(() => runner, durable);
    await expect(duplicate.handlers.get("session_start")!({}, duplicate.ctx)).resolves.toBeUndefined();
    const listed = await duplicate.tools.get("ultraterm_hub").execute("b", { action: "list" }, undefined, undefined, duplicate.ctx);
    expect(listed.details.runs).toEqual([]);
    expect(listed.details.readOnly).toBe(true);
    // A degraded session must never silently launch memory-only work.
    await expect(duplicate.tools.get("ultraterm_subagents").execute("c", { goal: "duplicate", tasks: [{ label: "two", task: "two" }] }, undefined, undefined, duplicate.ctx)).rejects.toThrow(/refused: .*duplicate extension resources/);
    expect(runner).toHaveBeenCalledTimes(1);
    // Diagnose stays available read-only so the chat is never bricked.
    const diagnostics = await duplicate.tools.get("ultraterm_hub").execute("d", { action: "diagnose", runId: owned.details.run.runId }, undefined, undefined, duplicate.ctx);
    expect(diagnostics.details.diagnostics.persistence).toBe("memory-only");
    expect(diagnostics.details.diagnostics.readOnly).toBe(true);
    expect(diagnostics.details.diagnostics.reason).toBe("run-unreadable");
    expect(diagnostics.details.diagnostics.checkpointError).toMatch(/duplicate/i);
    // The live owner keeps its lock, its lease, and its durable resume state.
    expect(existsSync(join(directory, "owner.json"))).toBe(true);
    const status = await owner.tools.get("ultraterm_hub").execute("e", { action: "status", runId: owned.details.run.runId }, undefined, undefined, owner.ctx);
    expect(status.details.run.state).toBe("done");
    await duplicate.handlers.get("session_shutdown")!({}, duplicate.ctx);
    await owner.handlers.get("session_shutdown")!({}, owner.ctx);
  });

  it("fails closed on a live cross-host checkpoint lock and never rewrites or removes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-crosshost-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "cross" };
    const probe = new CheckpointStore(durable.parent, durable.root, durable.parent);
    const lock = join(probe.directory, "owner.json");
    probe.close();
    // A different live pid is never this process's own collision: it belongs to
    // another host or isolate, so the extension must refuse, never steal.
    const foreign = JSON.stringify({ pid: 1, token: "foreign-host-token" });
    writeFileSync(lock, foreign, { mode: 0o600 });
    const h = harness(() => async () => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }), durable);
    await expect(h.tools.get("ultraterm_subagents").execute("a", { goal: "cross-host", tasks: [{ label: "one", task: "one" }] }, undefined, undefined, h.ctx)).rejects.toThrow(/owned by a live host; resume is blocked/);
    await expect(h.tools.get("ultraterm_hub").execute("b", { action: "list" }, undefined, undefined, h.ctx)).rejects.toThrow(/owned by a live host/);
    expect(readFileSync(lock, "utf8")).toBe(foreign);
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
    const clock = vi.spyOn(Date, "now").mockReturnValue(123456);
    const persisted = JSON.stringify(toRunView(run));
    clock.mockReturnValue(234567);
    expect(JSON.parse(persisted).observedAt).toBe(123456);
    expect(toRunView(run).observedAt).toBe(234567);
    clock.mockRestore();
    expect(toRunView(run).tasks[0].taskId).toBe("t");
    expect(renderRunResult(run)).toContain("model zai/glm-5.3-flash · thinking high");
    expect(renderRunResult(run)).toContain("zai/");
    expect(toRunView(run).model).toBe("zai/glm-5.3-flash");
  });
});

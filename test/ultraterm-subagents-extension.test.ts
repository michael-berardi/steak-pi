import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUltratermSubagentsExtension,
  renderRunProgress,
  renderSessionStatus,
  toRunView,
  ultratermSubagentsSchema,
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

function harness(runnerFactory: (relay: RelayBroker) => WorkerRunner) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const messages: any[] = [];
  const statuses: Array<string | undefined> = [];
  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
    sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
  } as unknown as ExtensionAPI;
  let id = 0;
  createUltratermSubagentsExtension({
    createRunner: (_pi, relay) => runnerFactory(relay),
    idFactory: () => `fixed-${++id}`,
  })(pi);
  const cwd = mkdtempSync(join(tmpdir(), "steak-usap-extension-"));
  dirs.push(cwd);
  const ctx = {
    cwd,
    model: { provider: "zai", id: "glm-5.3-flash" },
    thinkingLevel: "high",
    ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
  } as any;
  return { tools, handlers, messages, statuses, ctx };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("UltraTerm Subagent Protocol Pi extension", () => {
  it("registers only the canonical parent tools", () => {
    const h = harness(() => async () => ({ state: "done", output: "ok", turns: 1, usage: usage(1) }));
    expect([...h.tools.keys()]).toEqual(["ultraterm_subagents", "ultraterm_hub"]);
    const guidelines = h.tools.get("ultraterm_subagents").promptGuidelines.join(" ");
    expect(guidelines).toContain("parent retains decomposition");
    expect(guidelines).toContain("Independence is necessary but not sufficient");
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
    expect(h.messages[0].options).toEqual({ deliverAs: "nextTurn", triggerTurn: false });

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
  });
});

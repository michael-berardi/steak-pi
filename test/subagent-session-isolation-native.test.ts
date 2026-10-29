import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionRuntime, type CreateAgentSessionRuntimeFactory, type ExtensionContext, type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createUltratermSubagentsExtension, type RunView } from "../extensions/ultraterm-subagents.ts";
import { canonicalSessionFile } from "../src/subagents/checkpoints.ts";
import { SessionScheduler } from "../src/subagents/scheduler.ts";
import { emptyUsage, type WorkerRunContext, type WorkerResult } from "../src/subagents/types.ts";

import { sdkPiAiUrl } from "./helpers/pi-sdk-dependencies.ts";

// Resolve the SDK's own dependency; never import another test (which registers tests).
const { AssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } = await import(/* @vite-ignore */ sdkPiAiUrl);
const model = {
  id: "mimo-v2.6-flash", name: "Offline MiMo fixture", provider: "xiaomi",
  api: "openai-completions" as const, baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
  reasoning: false, input: ["text" as const], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

type Capture = { ctx: ExtensionContext; hub: ToolDefinition; dispatch: ToolDefinition; reason: string };
const actions = ["status", "wait", "cancel", "send", "inbox", "resume", "diagnose"] as const;
const invoke = (capture: Capture, tool: "hub" | "dispatch", params: object, ctx = capture.ctx) =>
  capture[tool].execute("offline-captured-call", params, AbortSignal.timeout(5000), undefined, ctx as ExtensionToolContext);
const list = async (capture: Capture) => (await invoke(capture, "hub", { action: "list" })).details as { runs: RunView[] };

/** Native SDK runtime/resource loading/contexts/checkpoints; workers and optional
 * parent model responses are synthetic. Isolation-only cases forbid model dispatch.
 * All persistent sessions here are synthetic fixtures in one private temporary directory.
 */
async function fixture(wakeParent = false, holdFirstTurn = false) {
  const cwd = await mkdtemp(join(tmpdir(), "usap-native-isolation-"));
  const root = join(cwd, "checkpoints");
  const sessions: AgentSessionRuntime[] = [];
  const errors: unknown[] = [];
  const workers = new Map<string, { context: WorkerRunContext; finish: () => void }>();
  const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden"); });
  vi.stubEnv("STEAK_PI_USAP_MACHINE", "off");
  vi.stubEnv("STEAK_PI_USAP_CAPS", "off");
  vi.stubEnv("STEAK_USAP_WAKE_PARENT", wakeParent ? "1" : "0");
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const parentContexts: unknown[] = [];
  const turnGate: { release?: () => void } = {};
  const lifecycle = { starts: 0, settled: 0 };
  const transport = vi.fn((_model: unknown, context: unknown) => {
    if (!wakeParent) throw new Error("Model transport forbidden: captured handlers only");
    parentContexts.push(structuredClone(context));
    const message = { role: "assistant", content: [{ type: "text", text: "Synthetic parent turn completed." }],
      api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
    const events = new AssistantMessageEventStream();
    const finish = () => {
      events.push({ type: "start", partial: message });
      events.push({ type: "done", reason: "stop", message });
      events.end();
    };
    if (holdFirstTurn && parentContexts.length === 1) turnGate.release = finish;
    else finish();
    return events;
  });
  modelRuntime.registerNativeProvider({ id: model.provider, name: "Offline isolation",
    getModels: () => [model], auth: { apiKey: { name: "Keyless", resolve: async () => ({ auth: {}, source: "offline" }) } },
    stream: transport, streamSimple: transport });
  async function host() {
    const transitions = { cancel: false };
    const captures: Capture[] = [];
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      let ctx!: ExtensionContext;
      let reason = "";
      const extension = createUltratermSubagentsExtension({ checkpointRoot: root,
        // These test-controlled workers never report a turn; the startup window has its own tests.
        startupWindowMs: 0,
        createScheduler: () => new SessionScheduler(2, { session: { providers: {}, global: 2 }, machine: { providers: {}, global: 2 } }),
        createRunner: () => async (context) => new Promise<WorkerResult>((resolve) => {
          const finish = (aborted = false) => {
            context.signal.removeEventListener("abort", abort);
            resolve({ state: aborted ? "aborted" : "done", output: `PRIVATE:${context.run.goal}`, turns: 1, usage: emptyUsage() });
          };
          const abort = () => finish(true);
          workers.set(context.run.id, { context, finish });
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        }),
      });
      const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          systemPrompt: "Offline session-isolation fixture. Never call a provider.",
          extensionFactories: [extension, pi => {
            pi.on("session_start", (event, context) => { ctx = context; reason = event.reason; });
            pi.on("agent_start", () => { lifecycle.starts++; });
            pi.on("agent_settled", () => { lifecycle.settled++; });
            // Registered after USAP: cancellation must not undo live worker state.
            pi.on("session_before_switch", () => ({ cancel: transitions.cancel }));
            pi.on("session_before_fork", () => ({ cancel: transitions.cancel }));
          }],
        },
      });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", noTools: "builtin" });
      expect(result.extensionsResult.errors).toEqual([]);
      await result.session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
      const runner = result.session.extensionRunner;
      captures.push({ ctx, reason, hub: runner.getToolDefinition("ultraterm_hub")!, dispatch: runner.getToolDefinition("ultraterm_subagents")! });
      expect(ctx.cwd).toBe(cwd);
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir: join(cwd, "agent"), sessionManager: SessionManager.create(cwd, join(cwd, "native-sessions")) });
    sessions.push(runtime);
    return { runtime, transitions, get current() { return captures.at(-1)!; }, captures };
  }
  async function dispatch(capture: Capture, goal: string) {
    const result = await invoke(capture, "dispatch", { goal, model: `${model.provider}/${model.id}`, background: true, timeoutMs: 10000, tasks: [{ label: goal, task: "Return deterministic local evidence." }] });
    const run = (result.details as { run: RunView }).run;
    await vi.waitFor(() => expect(workers.has(run.runId)).toBe(true), { timeout: 2000 });
    return run;
  }
  return { cwd, root, host, dispatch, workers, errors, transport, parentContexts, lifecycle, turnGate, async close() {
    try {
      for (const session of sessions) await session.dispose();
      expect(errors).toEqual([]);
      if (!wakeParent) expect(transport).not.toHaveBeenCalled();
      expect(fetchGuard).not.toHaveBeenCalled();
    } finally { fetchGuard.mockRestore(); vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); }
  } };
}

async function rejectForeign(capture: Capture, run: RunView) {
  for (const action of actions) {
    await expect(invoke(capture, "hub", { action, runId: run.runId, timeoutMs: 0, to: run.tasks[0].taskId, body: "foreign-control" })).rejects.toThrow(/Unknown USAP run|ownership/i);
  }
  expect(JSON.stringify(await list(capture))).not.toContain(run.runId);
}

// Bounded real Pi 0.86 replacement flows, not synthetic lifecycle event emission.
describe("native SDK session ownership isolation (offline)", () => {
  it("synthetic: settled background work wakes its idle native parent exactly once without human input", async () => {
    const f = await fixture(true);
    try {
      const parent = await f.host();
      const run = await f.dispatch(parent.current, "synthetic-native-wake");
      await parent.runtime.session.prompt("Synthetic parent task: integrate the background result when it finishes.");
      expect(f.lifecycle).toEqual({ starts: 1, settled: 1 });
      expect(parent.current.ctx.isIdle()).toBe(true);
      expect(f.transport).toHaveBeenCalledTimes(1);
      f.workers.get(run.runId)!.finish();
      await vi.waitFor(() => expect(f.lifecycle).toEqual({ starts: 2, settled: 2 }));
      expect(f.transport).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(f.parentContexts[1])).toContain(`Background run ${run.runId} finished: continue the parent task (integrate results, verify, release) before ending the turn.`);
      const entries = parent.current.ctx.sessionManager.getEntries();
      expect(entries.filter(e => e.type === "custom_message" && e.customType === "ultraterm-subagents-complete")).toHaveLength(1);
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(f.lifecycle).toEqual({ starts: 2, settled: 2 });
      expect(f.transport).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  }, 10000);
  it("synthetic: busy native parent integrates a steered completion in the same agent run", async () => {
    const f = await fixture(true, true);
    try {
      const parent = await f.host();
      const run = await f.dispatch(parent.current, "synthetic-native-busy");
      const prompt = parent.runtime.session.prompt("Synthetic parent task: keep working and integrate the background result.");
      await vi.waitFor(() => expect(f.turnGate.release).toBeTypeOf("function"));
      f.workers.get(run.runId)!.finish();
      // The native model request stays held until its real steer queue receives the completion.
      await vi.waitFor(() => expect(parent.runtime.session.agent.hasQueuedMessages()).toBe(true));
      expect(f.lifecycle).toEqual({ starts: 1, settled: 0 });
      expect(f.transport).toHaveBeenCalledTimes(1);
      f.turnGate.release!();
      await prompt;
      expect(f.lifecycle).toEqual({ starts: 1, settled: 1 });
      expect(f.transport).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(f.parentContexts[1])).toContain(`Background run ${run.runId} finished:`);
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(f.lifecycle).toEqual({ starts: 1, settled: 1 });
    } finally { f.turnGate.release?.(); await f.close(); }
  }, 10000);

  it("preserves work on cancelled and invalid transitions, then checkpoints a committed switch", async () => {
    const f = await fixture();
    try {
      const a = await f.host();
      const sm = a.runtime.session.sessionManager;
      sm.appendMessage({ role: "user", content: "transition seed", timestamp: Date.now() });
      const leaf = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "offline" }], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() });
      const originalFile = a.runtime.session.sessionFile!;
      const run = await f.dispatch(a.current, "transition-survivor");
      const old = a.current;
      const worker = f.workers.get(run.runId)!;
      const assertLive = async () => {
        expect(a.current).toBe(old);
        expect(old.ctx.sessionManager.getSessionId()).toBe(run.ownerSessionId);
        expect(worker.context.signal.aborted).toBe(false);
        expect((await list(old)).runs[0].state).toBe("running");
      };
      a.transitions.cancel = true;
      expect((await a.runtime.switchSession(originalFile)).cancelled).toBe(true);
      await assertLive();
      expect((await a.runtime.newSession()).cancelled).toBe(true);
      await assertLive();
      expect((await a.runtime.fork(leaf, { position: "at" })).cancelled).toBe(true);
      await assertLive();
      a.transitions.cancel = false;
      await expect(a.runtime.fork("missing-entry")).rejects.toThrow(/Invalid entry/);
      await assertLive();
      await expect(a.runtime.switchSession(originalFile, { cwdOverride: join(f.cwd, "missing-cwd") })).rejects.toThrow();
      await assertLive();
      expect((await a.runtime.newSession()).cancelled).toBe(false);
      a.runtime.session.sessionManager.appendMessage({ role: "user", content: "replacement seed", timestamp: Date.now() });
      a.runtime.session.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "offline" }], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() });
      const replacementFile = a.runtime.session.sessionFile!;
      expect(worker.context.signal.aborted).toBe(true);
      expect(() => old.ctx.sessionManager).toThrow();
      worker.context.onProgress({ currentTool: "LATE-TRANSITION-PRIVATE", turns: 3 });
      worker.finish();
      expect(JSON.stringify(a.current.ctx.sessionManager.getEntries())).not.toContain(run.runId);
      expect((await a.runtime.switchSession(originalFile)).cancelled).toBe(false);
      const restored = (await list(a.current)).runs[0];
      expect(restored.runId).toBe(run.runId);
      expect(restored.state).not.toBe("running");
      expect(restored.tasks[0].error).toMatch(/Host interrupted/);
      expect(JSON.stringify(restored)).not.toContain("LATE-TRANSITION-PRIVATE");
      // A live run on a real resume transition is interrupted too.
      const switched = await f.dispatch(a.current, "committed-switch");
      expect((await a.runtime.switchSession(replacementFile)).cancelled).toBe(false);
      expect(f.workers.get(switched.runId)!.context.signal.aborted).toBe(true);
      expect((await list(a.current)).runs).toEqual([]);
      expect((await a.runtime.switchSession(originalFile)).cancelled).toBe(false);
      expect((await list(a.current)).runs.find(r => r.runId === switched.runId)?.tasks[0].error).toMatch(/Host interrupted/);
    } finally { await f.close(); }
  }, 15000);
  it("shuts down only the departing owner's live work and rejects late callbacks after native invalidation", async () => {
    const f = await fixture();
    try {
      const a = await f.host();
      const b = await f.host();
      const ra = await f.dispatch(a.current, "departing-A");
      const rb = await f.dispatch(b.current, "surviving-B");
      const old = a.current;
      const departing = f.workers.get(ra.runId)!;
      // Observer is already awaiting coordinator settlement when the real SDK tears down A.
      const pending = invoke(old, "hub", { action: "wait", runId: ra.runId, mode: "all", timeoutMs: 2000 })
        .then(result => ({ result }), error => ({ error }));
      expect((await a.runtime.newSession()).cancelled).toBe(false);
      expect(departing.context.signal.aborted).toBe(true);
      expect(f.workers.get(rb.runId)!.context.signal.aborted).toBe(false);
      const observed = await pending;
      expect(JSON.stringify(observed)).not.toContain(rb.runId);
      expect(() => old.ctx.sessionManager).toThrow();
      // A deliberately misbehaving worker retains its progress callback after shutdown.
      departing.context.onProgress({ currentTool: "LATE-PRIVATE-A", turns: 2 });
      departing.finish();
      await new Promise(resolve => setTimeout(resolve, 25));
      expect((await list(a.current)).runs).toEqual([]);
      const replacementEntries = JSON.stringify(a.current.ctx.sessionManager.getEntries());
      expect(replacementEntries).not.toContain(ra.runId);
      expect(replacementEntries).not.toContain("LATE-PRIVATE-A");
      expect(JSON.stringify(b.current.ctx.sessionManager.getEntries())).not.toContain(ra.runId);
      for (const action of ["list", ...actions]) {
        await expect(invoke(old, "hub", { action, runId: ra.runId, timeoutMs: 0 })).rejects.toThrow();
      }
      expect((await list(b.current)).runs[0].state).toBe("running");
      f.workers.get(rb.runId)!.finish();
      await invoke(b.current, "hub", { action: "wait", runId: rb.runId, mode: "all", timeoutMs: 2000 });
    } finally { await f.close(); }
  }, 15000);
  it("isolates two same-cwd native sessions and every hub action, including persisted ownership", async () => {
    const f = await fixture();
    try {
      const a = await f.host();
      const b = await f.host();
      expect(a.runtime.session.sessionId).not.toBe(b.runtime.session.sessionId);
      const ra = await f.dispatch(a.current, "A-secret");
      const rb = await f.dispatch(b.current, "B-secret");
      for (const [host, run] of [[a, ra], [b, rb]] as const) {
        expect(run.ownerSessionId).toBe(host.runtime.session.sessionId);
        expect(run.ownerSessionFile).toBe(canonicalSessionFile(host.runtime.session.sessionFile!));
      }
      await rejectForeign(a.current, rb);
      await rejectForeign(b.current, ra);
      // A real context from another SDK session must not rebind an existing extension.
      await expect(invoke(a.current, "hub", { action: "list" }, b.current.ctx)).rejects.toThrow(/ownership/i);
      await expect(invoke(a.current, "dispatch", { goal: "foreign", tasks: [{ label: "x", task: "x" }] }, b.current.ctx)).rejects.toThrow(/ownership/i);
      expect(f.workers.get(ra.runId)!.context.signal.aborted).toBe(false);
      expect(f.workers.get(rb.runId)!.context.signal.aborted).toBe(false);
      f.workers.get(ra.runId)!.finish();
      f.workers.get(rb.runId)!.finish();
      for (const [host, run, foreign] of [[a, ra, rb], [b, rb, ra]] as const) {
        // Observe the unsolicited native receipt before hub wait acknowledges it.
        await vi.waitFor(() => expect(JSON.stringify(host.current.ctx.sessionManager.getEntries())).toContain("ultraterm-subagents-complete"));
        const result = await invoke(host.current, "hub", { action: "wait", runId: run.runId, mode: "all", timeoutMs: 2000 });
        expect(JSON.stringify(result)).toContain(`PRIVATE:${run.goal}`);
        expect(JSON.stringify(result)).not.toContain(`PRIVATE:${foreign.goal}`);
        const receipts = host.current.ctx.sessionManager.getEntries().filter(e => e.type === "custom_message" && e.customType === "ultraterm-subagents-complete");
        expect(JSON.stringify(receipts)).toContain(run.ownerSessionId);
        expect(JSON.stringify(receipts)).not.toContain(foreign.runId);
      }
      const files = await readdir(f.root, { recursive: true });
      const checkpoints = await Promise.all(files.filter(p => p.endsWith(".json")).map(p => readFile(join(f.root, p), "utf8")));
      for (const run of [ra, rb]) {
        const checkpoint = checkpoints.map(text => JSON.parse(text)).find(item => item.run?.id === run.runId);
        expect(checkpoint.run.ownerSessionId).toBe(run.ownerSessionId);
        expect(checkpoint.run.ownerSessionFile).toBe(run.ownerSessionFile);
      }
    } finally { await f.close(); }
  }, 15000);

  it("invalidates captured contexts on real fork/new/switch and reopens only the original owner's checkpoints", async () => {
    const f = await fixture();
    try {
      const a = await f.host();
      const b = await f.host();
      const ra = await f.dispatch(a.current, "original-A");
      const rb = await f.dispatch(b.current, "still-B");
      f.workers.get(ra.runId)!.finish();
      await invoke(a.current, "hub", { action: "wait", runId: ra.runId, mode: "all", timeoutMs: 2000 });
      // Persist a native conversation seed, with no model call, for SDK fork validation.
      const sm = a.runtime.session.sessionManager;
      sm.appendMessage({ role: "user", content: "private fork seed", timestamp: Date.now() });
      const leaf = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "offline seed" }], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() });
      const originalFile = a.runtime.session.sessionFile!;
      const old = a.current;
      expect((await a.runtime.fork(leaf, { position: "at" })).cancelled).toBe(false);
      expect(a.current.reason).toBe("fork");
      expect(a.runtime.session.sessionId).not.toBe(ra.ownerSessionId);
      expect(a.runtime.session.sessionManager.getHeader()?.parentSession).toBe(originalFile);
      expect(() => old.ctx.sessionManager).toThrow(/stale|no longer|invalid/i);
      await expect(invoke(old, "hub", { action: "list" })).rejects.toThrow();
      await rejectForeign(a.current, ra);
      await rejectForeign(a.current, rb);
      const fork = a.current;
      expect((await a.runtime.newSession()).cancelled).toBe(false);
      expect(a.current.reason).toBe("new");
      expect(() => fork.ctx.sessionManager).toThrow();
      expect((await list(a.current)).runs).toEqual([]);
      expect((await a.runtime.switchSession(originalFile)).cancelled).toBe(false);
      expect(a.current.reason).toBe("resume");
      expect(a.runtime.session.sessionId).toBe(ra.ownerSessionId);
      expect((await list(a.current)).runs.map(r => r.runId)).toEqual([ra.runId]);
      const restored = await invoke(a.current, "hub", { action: "status", runId: ra.runId });
      expect(JSON.stringify(restored)).toContain("PRIVATE:original-A");
      await rejectForeign(a.current, rb);
      // A copied native transcript retains its header ID, but is not the same owner file.
      const copiedFile = join(f.cwd, "copied-native-session.jsonl");
      await copyFile(originalFile, copiedFile);
      const reopened = a.current;
      expect((await a.runtime.switchSession(copiedFile)).cancelled).toBe(false);
      expect(a.runtime.session.sessionId).toBe(ra.ownerSessionId);
      expect(canonicalSessionFile(a.runtime.session.sessionFile!)).not.toBe(ra.ownerSessionFile);
      expect(() => reopened.ctx.sessionManager).toThrow();
      await rejectForeign(a.current, ra);
      const copiedRun = await f.dispatch(a.current, "copied-file-owner");
      expect(copiedRun.ownerSessionId).toBe(ra.ownerSessionId);
      expect(copiedRun.ownerSessionFile).toBe(canonicalSessionFile(copiedFile));
      f.workers.get(copiedRun.runId)!.finish();
      await invoke(a.current, "hub", { action: "wait", runId: copiedRun.runId, mode: "all", timeoutMs: 2000 });
      expect((await a.runtime.switchSession(originalFile)).cancelled).toBe(false);
      await rejectForeign(a.current, copiedRun);
      expect((await list(a.current)).runs.map(r => r.runId)).toEqual([ra.runId]);
      expect(f.workers.get(rb.runId)!.context.signal.aborted).toBe(false);
      expect((await list(b.current)).runs.map(r => r.runId)).toEqual([rb.runId]);
      f.workers.get(rb.runId)!.finish();
      await invoke(b.current, "hub", { action: "wait", runId: rb.runId, mode: "all", timeoutMs: 2000 });
    } finally { await f.close(); }
  }, 15000);
});

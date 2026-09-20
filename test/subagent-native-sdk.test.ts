import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime, SettingsManager, createAgentSession, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { buildPiWorkerContinuationPrompt, createIsolatedResourceLoader, createPiWorkerRunner } from "../src/subagents/pi-worker.ts";
import { RelayBroker } from "../src/subagents/relay.ts";
import { SubagentCoordinator } from "../src/subagents/coordinator.ts";
import { CheckpointStore } from "../src/subagents/checkpoints.ts";
import { MachineSlots } from "../src/subagents/machine-slots.ts";
import { normalizeDispatch } from "../src/subagents/policy.ts";
import { emptyUsage, USAP_VERSION, type RunRecord, type TaskRecord, type WorkerProgress } from "../src/subagents/types.ts";

// Resolve the SDK's own pi-ai, rather than assuming a hoisted dependency.
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { AssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore, getCurrentSystemPrompt, getCurrentTools } = await import(/* @vite-ignore */ new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", sdkEntry).href);
export const SENTINEL = "NATIVE_OFFLINE_SENTINEL_7291";
export const localModel = {
  id: "scripted-local", name: "Scripted local", provider: "usap-offline-proof",
  api: "openai-completions" as const, baseUrl: "http://offline.invalid",
  reasoning: false, input: ["text" as const], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** Real runtime; only the provider transport is deterministic. No credential files. */
export async function createScriptedLocalRuntime(toolTurns = 1, pressure = false, delayMs = 0) {
  const contexts: any[] = [];
  const model = { ...localModel, contextWindow: pressure ? 4096 : localModel.contextWindow };
  let taskRequests = 0;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const stream = (_model: unknown, context: any, options?: { signal?: AbortSignal }) => {
    // Pi 0.86 normalizes declarations into transcript system messages; 0.85.1 keeps fields.
    const systemPrompt = typeof getCurrentSystemPrompt === "function" ? getCurrentSystemPrompt(context.messages) : context.systemPrompt;
    const tools = typeof getCurrentTools === "function" ? getCurrentTools(context.messages) : context.tools;
    contexts.push({ systemPrompt, messages: structuredClone(context.messages) });
    const summarizing = !tools?.length;
    if (summarizing && !JSON.stringify(context.messages).includes(SENTINEL)) throw new Error("Compaction lost the required evidence before summarization");
    if (!summarizing) taskRequests++;
    const first = !summarizing && taskRequests <= toolTurns;
    const content = first
      ? [{ type: "toolCall", id: `offline-read-${contexts.length}`, name: "read", arguments: { path: "sentinel.txt" } }]
      : [{ type: "text", text: `Evidence: ${SENTINEL}; native history retained.\nChanged paths: none\nFocused checks: native read\nRisks: none` }];
    const usage = emptyUsage();
    if (pressure && !summarizing && taskRequests === 2) usage.input = usage.totalTokens = 3800;
    const message = { role: "assistant", content, api: model.api, provider: model.provider,
      model: model.id, usage, stopReason: first ? "toolUse" : "stop", timestamp: Date.now() };
    const events = new AssistantMessageEventStream();
    const finish = () => {
      options?.signal?.removeEventListener("abort", abort);
      events.push({ type: "start", partial: message });
      events.push({ type: "done", reason: message.stopReason, message });
      events.end();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); events.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted" } }); events.end(); };
    if (options?.signal?.aborted) abort();
    else if (delayMs) { options?.signal?.addEventListener("abort", abort, { once: true }); timer = setTimeout(finish, delayMs); }
    else finish();
    return events;
  };
  runtime.registerNativeProvider({ id: localModel.provider, name: "Offline proof", getModels: () => [model],
    auth: { apiKey: { name: "Keyless local", resolve: async () => ({ auth: {}, source: "local deterministic transport" }) } },
    stream, streamSimple: stream });
  return { runtime, contexts, model };
}

export async function nativeToolWorkload(factory = createPiWorkerRunner, toolTurns = 16, pressure = false) {
  const cwd = await mkdtemp(join(tmpdir(), "usap-native-workload-"));
  try {
    await writeFile(join(cwd, "sentinel.txt"), SENTINEL + (pressure ? "\nRecorded fixture evidence.".repeat(400) : ""));
    const { runtime, contexts, model } = await createScriptedLocalRuntime(toolTurns, pressure);
    const task: TaskRecord = { id: "workload-task", label: "native workload", task: "Read assigned fixture evidence and report.", role: "worker", mayEdit: false, ownedPaths: [], allowBash: false, state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false };
    const run: RunRecord = { version: USAP_VERSION, id: "workload-run", goal: "Matched offline workload", constraints: [], cwd, model: "usap-offline-proof/scripted-local", thinkingLevel: "off", concurrency: 1, timeoutMs: 10000, maxTurns: 64, background: false, state: "running", createdAt: Date.now(), tasks: [task], usage: emptyUsage() };
    const relay = new RelayBroker();
    relay.createRun(run.id, [task.id]);
    const progress: WorkerProgress[] = [];
    const runner = factory({ relay, resolveRuntime: () => ({ model, thinkingLevel: "off" }), sessionFactory: opts => createAgentSession({ ...opts, agentDir: join(cwd, "agent"), modelRuntime: runtime,
      ...(pressure ? { settingsManager: SettingsManager.inMemory({ compaction: { enabled: opts.settingsManager!.getCompactionEnabled(), reserveTokens: 512, keepRecentTokens: 512 }, retry: { enabled: false } }) } : {}),
      resourceLoader: createIsolatedResourceLoader(opts.resourceLoader!.getSystemPrompt()!, createExtensionRuntime()) }) });
    const start = performance.now();
    const result = await runner({ run, task, signal: AbortSignal.timeout(10000), sessionDir: join(cwd, "sessions"), onProgress(update) { progress.push(update); } });
    const elapsedMs = performance.now() - start;
    const sessionFile = progress.find(p => p.sessionFile)?.sessionFile;
    const transcript = sessionFile ? await readFile(sessionFile, "utf8") : "";
    return { result, requests: contexts.length, elapsedMs, progress, transcript, contexts };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

const soakSeconds = Math.min(10800, Math.max(0, Number(process.env.USAP_REAL_SOAK_SECONDS) || 0));
describe("real Pi SDK offline worker lifecycle", () => {
  it.runIf(soakSeconds > 0)("holds real native execution, checkpoints and machine leases through a wall-clock soak", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "usap-real-soak-"));
    const store = new CheckpointStore(join(cwd, "parent.jsonl"), join(cwd, "checkpoints"));
    const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in offline soak"); });
    const requests = Math.max(2, Math.ceil(soakSeconds / 30));
    const { runtime, model } = await createScriptedLocalRuntime(requests - 1, false, soakSeconds * 1000 / requests);
    const slots = new MachineSlots({ dir: join(cwd, "slots"), config: { session: { providers: {}, global: 1 }, machine: { providers: { [model.provider]: 1 }, global: 1 } } });
    const relay = new RelayBroker();
    const runner = createPiWorkerRunner({ relay, resolveRuntime: () => ({ model, thinkingLevel: "off" }), sessionFactory: opts => createAgentSession({ ...opts, agentDir: join(cwd, "agent"), modelRuntime: runtime, resourceLoader: createIsolatedResourceLoader(opts.resourceLoader!.getSystemPrompt()!, createExtensionRuntime()) }) });
    const coordinator = new SubagentCoordinator(runner, { machineSlots: slots, sessionDir: () => store.sessionsDirectory, onChange(run) { store.save(run, run.state !== "running"); } });
    const started = performance.now();
    try {
      await writeFile(join(cwd, "sentinel.txt"), SENTINEL);
      const run = normalizeDispatch({ goal: "Real wall-clock lifecycle soak, local scripted transport", timeoutMs: soakSeconds * 1000 + 30000, maxTurns: requests + 3, tasks: [{ label: "paced native reads", task: "Read fixture evidence and report." }] }, cwd, `${model.provider}/${model.id}`, "off");
      relay.createRun(run.id, run.tasks.map(task => task.id));
      coordinator.start(run);
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(slots.heldCount(model.provider, 1)).toBe(1);
      const result = await coordinator.wait(run.id, "all");
      expect(result.state).toBe("done");
      expect(result.tasks[0].toolSuccesses).toBe(requests - 1);
      expect(performance.now() - started).toBeGreaterThanOrEqual(soakSeconds * 1000);
      expect(store.get(run.id)?.run.state).toBe("done");
      await coordinator.shutdown(); // settlement precedes the final lease-release microtask
      expect(slots.heldCount(model.provider, 1)).toBe(0);
      expect(fetchGuard).not.toHaveBeenCalled();
      if (process.env.USAP_SOAK_OUT) await writeFile(process.env.USAP_SOAK_OUT, JSON.stringify({ scope: "real wall-clock native SDK and coordinator, isolated machine leases/checkpoints, local scripted provider; no remote-model soak", requestedSeconds: soakSeconds, actualSeconds: (performance.now() - started) / 1000, turns: result.tasks[0].turns, successfulTools: result.tasks[0].toolSuccesses, state: result.state, machineLeasesAfter: slots.heldCount(model.provider, 1) }, null, 2));
    } finally { await coordinator.shutdown(); store.close(); fetchGuard.mockRestore(); await rm(cwd, { recursive: true, force: true }); }
  }, soakSeconds * 1000 + 45000);
  it("automatically compacts a scaled native context and retains required evidence", async () => {
    const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in offline proof"); });
    try {
      const proof = await nativeToolWorkload(createPiWorkerRunner, 4, true);
      expect(proof.result.state, JSON.stringify(proof.result)).toBe("done");
      expect(proof.result.toolSuccesses).toBe(4);
      expect(proof.progress.some(p => (p.compactions ?? 0) > 0)).toBe(true);
      expect(proof.transcript).toContain('"type":"compaction"');
      expect(JSON.stringify(proof.contexts.at(-1).messages)).toContain(SENTINEL);
      expect(fetchGuard).not.toHaveBeenCalled();
    } finally { fetchGuard.mockRestore(); }
  }, 20000);
  it("completes a native 16-tool workload that exceeds the old turn ceiling", async () => {
    const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in offline proof"); });
    try {
      const after = await nativeToolWorkload();
      expect(after.result.state, JSON.stringify(after.result)).toBe("done");
      expect(after.result.toolSuccesses).toBe(16);
      expect(after.result.turns).toBe(17);
      const baseline = process.env.USAP_BASELINE_ROOT;
      if (baseline) {
        const beforeModule = await import(/* @vite-ignore */ pathToFileURL(join(baseline, "src/subagents/pi-worker.ts")).href);
        const before = await nativeToolWorkload(beforeModule.createPiWorkerRunner);
        expect(before.result.state).toBe("failed");
        expect(before.result.error).toMatch(/12.turn limit/i);
        const measurement = { benchmark: "same real SDK, local scripted provider, 16 tools; no network", before: { state: before.result.state, turns: before.result.turns, tools: before.result.toolSuccesses, elapsedMs: before.elapsedMs }, after: { state: after.result.state, turns: after.result.turns, tools: after.result.toolSuccesses, elapsedMs: after.elapsedMs } };
        if (process.env.USAP_BENCHMARK_OUT) await writeFile(process.env.USAP_BENCHMARK_OUT, JSON.stringify(measurement, null, 2));
        console.info(JSON.stringify(measurement));
      }
      expect(fetchGuard).not.toHaveBeenCalled();
    } finally { fetchGuard.mockRestore(); }
  }, 20000);
  it("executes a native tool, persists its transcript and explicitly continues without replay", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "steak-native-sdk-"));
    const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in offline proof"); });
    try {
      await writeFile(join(cwd, "sentinel.txt"), SENTINEL);
      const { runtime, contexts } = await createScriptedLocalRuntime();
      const task: TaskRecord = { id: "native-task", label: "native proof", task: "Read sentinel.txt and report the exact sentinel.", role: "worker", mayEdit: false, ownedPaths: [], allowBash: false, state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false };
      const run: RunRecord = { version: USAP_VERSION, id: "native-run", goal: "Offline native lifecycle", constraints: [], contract: "Read only", cwd, model: "usap-offline-proof/scripted-local", thinkingLevel: "off", concurrency: 1, timeoutMs: 10000, maxTurns: 8, background: false, state: "running", createdAt: Date.now(), tasks: [task], usage: emptyUsage() };
      const relay = new RelayBroker();
      relay.createRun(run.id, [task.id]);
      const progress: WorkerProgress[] = [];
      const runner = createPiWorkerRunner({ relay, resolveRuntime: () => ({ model: localModel, thinkingLevel: "off" }),
        sessionFactory: async (opts) => createAgentSession({ ...opts, agentDir: join(cwd, "isolated-agent"), modelRuntime: runtime,
          resourceLoader: createIsolatedResourceLoader(opts.resourceLoader!.getSystemPrompt()!, createExtensionRuntime()) }) });
      const execute = () => runner({ run, task, signal: new AbortController().signal, sessionDir: join(cwd, "sessions"), onProgress: (p) => progress.push(p) });
      const first = await execute();
      expect(first.state, JSON.stringify(first)).toBe("done");
      expect(progress.some((p) => p.currentTool === "read")).toBe(true);
      expect(progress.some((p) => p.toolSuccesses === 1)).toBe(true);
      expect(contexts).toHaveLength(2);
      expect(contexts[1].messages.some((m: any) => m.role === "toolResult" && JSON.stringify(m).includes(SENTINEL))).toBe(true);
      const checkpoint = progress.find((p) => p.sessionFile)?.sessionFile;
      expect(checkpoint).toBeTypeOf("string");
      const before = (await readFile(checkpoint!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(before.some((e) => e.message?.role === "toolResult" && JSON.stringify(e).includes(SENTINEL))).toBe(true);
      const usersBefore = before.filter((e) => e.message?.role === "user");
      expect(usersBefore).toHaveLength(1);
      task.sessionFile = checkpoint;
      const continued = await execute();
      expect(continued.state, JSON.stringify(continued)).toBe("done");
      expect(contexts).toHaveLength(3);
      const users = contexts[2].messages.filter((m: any) => m.role === "user");
      expect(users).toHaveLength(2);
      expect(users.at(-1).content.map((part: { text?: string }) => part.text ?? "").join("\n")).toBe(buildPiWorkerContinuationPrompt(task));
      expect(JSON.stringify(users.at(-1))).not.toContain(task.task);
      expect(JSON.stringify(contexts[2].messages)).toContain(SENTINEL);
      const after = (await readFile(checkpoint!, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(after.filter((e) => e.message?.role === "user")).toHaveLength(2);
      expect(fetchGuard).not.toHaveBeenCalled();
    } finally {
      fetchGuard.mockRestore();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);
});

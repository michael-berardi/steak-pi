// Spec 01 probe: does Pi 1.0.4 route() see quota / plan-limit / content-filter
// failures as reason:"retry", and does the existing pre-output chain wrapper
// still hop beneath a virtual selection? Test-only; no behaviour ships.
// In-process Pi SDK, deterministic local transports, no network. All provider
// and model names are test-local placeholders.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager, SettingsManager, createAgentSession, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { guardModelRuntime, type WorkerRouteStep } from "../src/model-route-policy.ts";
import { createIsolatedResourceLoader } from "../src/subagents/pi-worker.ts";
import { sdkPiAiUrl } from "./helpers/pi-sdk-dependencies.ts";

// Resolve the SDK's own pi-ai, whether nested or hoisted.
const { AssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore } = await import(/* @vite-ignore */ sdkPiAiUrl);

const SLOT_ID = "slot-model";
const CHAIN_STEP_A: WorkerRouteStep = { provider: "probe-a", id: SLOT_ID };
const CHAIN_STEP_B: WorkerRouteStep = { provider: "probe-b", id: SLOT_ID };

/** One physical placeholder model per fake provider. Loopback base URL keeps the
 * route subscription/local by construction; the transport never opens a socket. */
const physicalModel = (provider: string) => ({
  id: SLOT_ID, name: "Probe slot model", provider,
  api: "openai-completions" as const, baseUrl: "http://127.0.0.1:9/v1",
  reasoning: false, input: ["text" as const], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});

const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

type RouteCall = { reason: string; failedModel?: string; failedError?: string };

interface ProbeCase {
  calls: RouteCall[];
  fallbacks: { from: string; to: string; cause?: string }[];
  assistants: { provider: string; model: string; stopReason: string; errorMessage?: string }[];
  modelChanges: { provider: string; modelId: string }[];
}

/** One prompt against probe/chain. `probe-a` fails pre-output with `errorMessage`;
 * `probe-b` answers with one short text block. With `wrapperChain`, the existing
 * guard chain is installed beneath the virtual model and route() always returns probe-a. */
async function runProbeCase(errorMessage: string, wrapperChain = false): Promise<ProbeCase> {
  const cwd = await mkdtemp(join(tmpdir(), "virtual-chain-probe-"));
  const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network forbidden in virtual-chain probe"); });
  try {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const modelA = physicalModel("probe-a");
    const modelB = physicalModel("probe-b");
    const failStream = () => {
      const message = { role: "assistant" as const, content: [], api: modelA.api, provider: modelA.provider,
        model: modelA.id, usage: zeroUsage(), stopReason: "error" as const, errorMessage, timestamp: Date.now() };
      const events = new AssistantMessageEventStream();
      events.push({ type: "error", reason: "error", error: message });
      events.end();
      return events;
    };
    const answerStream = () => {
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "Probe answer." }],
        api: modelB.api, provider: modelB.provider, model: modelB.id, usage: zeroUsage(), stopReason: "stop" as const, timestamp: Date.now() };
      const events = new AssistantMessageEventStream();
      events.push({ type: "start", partial: message });
      events.push({ type: "done", reason: "stop", message });
      events.end();
      return events;
    };
    runtime.registerNativeProvider({ id: "probe-a", name: "Probe A", getModels: () => [modelA],
      auth: { apiKey: { name: "Stub key", resolve: async () => ({ auth: {}, source: "test-local stub credential" }) } },
      stream: failStream, streamSimple: failStream });
    runtime.registerNativeProvider({ id: "probe-b", name: "Probe B", getModels: () => [modelB],
      auth: { apiKey: { name: "Stub key", resolve: async () => ({ auth: {}, source: "test-local stub credential" }) } },
      stream: answerStream, streamSimple: answerStream });
    // Stub credentials so both physical routes pass the configured-auth checks.
    await runtime.setRuntimeApiKey("probe-a", "test-local-stub-not-a-secret");
    await runtime.setRuntimeApiKey("probe-b", "test-local-stub-not-a-secret");
    // Availability is refreshed asynchronously; settle it so both routes are
    // proven configured before routing (resolveModel refuses unconfigured targets).
    await runtime.refresh({ allowNetwork: false });

    const calls: RouteCall[] = [];
    runtime.registerVirtualModel({
      provider: "probe", id: "chain", name: "Probe chain",
      route(request) {
        calls.push({
          reason: request.reason,
          failedModel: request.failed ? `${request.failed.model.provider}/${request.failed.model.id}` : undefined,
          failedError: request.failed?.message.errorMessage,
        });
        const target = wrapperChain || request.reason !== "retry" ? "probe-a" : "probe-b";
        return { model: runtime.getModel(target, SLOT_ID)!, thinkingLevel: "off" };
      },
    });

    const fallbacks: ProbeCase["fallbacks"] = [];
    if (wrapperChain) {
      guardModelRuntime(runtime, {
        chain: [CHAIN_STEP_A, CHAIN_STEP_B],
        onFallback(from, to, cause) { fallbacks.push({ from: `${from.provider}/${from.id}`, to: `${to.provider}/${to.id}`, cause }); },
      });
    }

    const sessionManager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime,
      model: runtime.getModel("probe", "chain"), thinkingLevel: "off", noTools: "all",
      sessionManager,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }),
      resourceLoader: createIsolatedResourceLoader("Offline virtual-chain probe fixture. Answer with one short sentence.", createExtensionRuntime()),
    });
    await session.prompt("Reply with one short sentence.");

    const assistants = session.messages
      .filter((message): message is Extract<typeof message, { role: "assistant" }> => message.role === "assistant")
      .map(message => ({ provider: String(message.provider), model: String(message.model), stopReason: String(message.stopReason), errorMessage: message.errorMessage }));
    const modelChanges = sessionManager.getBranch()
      .filter(entry => entry.type === "model_change")
      .map(entry => ({ provider: (entry as { provider: string }).provider, modelId: (entry as { modelId: string }).modelId }));
    expect(fetchGuard).not.toHaveBeenCalled();
    return { calls, fallbacks, assistants, modelChanges };
  } finally {
    fetchGuard.mockRestore();
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Every case that hopped must keep the virtual selection and name the physical answerer. */
function assertHopInvariants(result: ProbeCase) {
  const last = result.assistants.at(-1);
  if (last?.provider === "probe-b") {
    expect(last.model).toBe(SLOT_ID);
    expect(result.modelChanges.at(-1)).toEqual({ provider: "probe", modelId: "chain" });
  }
}

const snapshotOf = (result: ProbeCase) => ({
  routeCalls: result.calls,
  answeredBy: result.assistants.at(-1) ? `${result.assistants.at(-1)!.provider}/${result.assistants.at(-1)!.model}` : undefined,
  stopReason: result.assistants.at(-1)?.stopReason,
  errorMessage: result.assistants.at(-1)?.errorMessage,
});

describe("virtual chain probe (spec 01, records outcomes; controls gate the fixture)", () => {
  it("transient control: 503 overloaded retries through route() and probe-b answers", async () => {
    const result = await runProbeCase("503 overloaded");
    expect(result.calls.some(call => call.reason === "retry")).toBe(true);
    const retry = result.calls.find(call => call.reason === "retry");
    expect(retry?.failedModel).toBe("probe-a/slot-model");
    expect(retry?.failedError).toBe("503 overloaded");
    expect(result.assistants.at(-1)?.provider).toBe("probe-b");
    expect(result.assistants.at(-1)?.stopReason).toBe("stop");
    assertHopInvariants(result);
  }, 30000);

  it("hard-stop control: 401 invalid api key never retries", async () => {
    const result = await runProbeCase("401 invalid api key");
    expect(result.calls.some(call => call.reason === "retry")).toBe(false);
    expect(result.assistants.at(-1)?.provider).toBe("probe-a");
    expect(result.assistants.at(-1)?.stopReason).toBe("error");
    expect(result.assistants.at(-1)?.errorMessage).toContain("401");
    assertHopInvariants(result);
  }, 30000);

  it("records the quota case: 429 subscription_quota_exceeded", async () => {
    const result = await runProbeCase("429 subscription_quota_exceeded");
    expect(snapshotOf(result)).toMatchSnapshot();
    assertHopInvariants(result);
  }, 30000);

  it("records the plan-limit case: GoUsageLimitError: usage limit reached", async () => {
    const result = await runProbeCase("GoUsageLimitError: usage limit reached");
    expect(snapshotOf(result)).toMatchSnapshot();
    assertHopInvariants(result);
  }, 30000);

  it("records the content-filter case: 400 data_inspection_failed", async () => {
    const result = await runProbeCase("400 data_inspection_failed");
    expect(snapshotOf(result)).toMatchSnapshot();
    assertHopInvariants(result);
  }, 30000);

  it("combined: the existing chain wrapper hops beneath the virtual model on quota", async () => {
    const result = await runProbeCase("429 subscription_quota_exceeded", true);
    expect(result.fallbacks).toHaveLength(1);
    expect(result.fallbacks[0].from).toBe("probe-a/slot-model");
    expect(result.fallbacks[0].to).toBe("probe-b/slot-model");
    expect(result.fallbacks[0].cause).toContain("subscription_quota_exceeded");
    const last = result.assistants.at(-1);
    expect(last?.provider).toBe("probe-b");
    expect(last?.model).toBe(SLOT_ID);
    expect(last?.stopReason).toBe("stop");
    expect(result.modelChanges.at(-1)).toEqual({ provider: "probe", modelId: "chain" });
  }, 30000);
});
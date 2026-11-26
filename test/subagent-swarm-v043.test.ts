// Comprehensive tests for Steak Pi v0.43.0 automatic swarm capabilities (B1–B6).
// 100% provider-neutral synthetic models/providers; no network, no real model calls.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { setRoutingConfigOverride } from "../src/routing-config.ts";
import { transientFailure } from "../src/subagents/auto-resume.ts";
import { CheckpointStore, diagnoseRun, forkWorkerSessionFile } from "../src/subagents/checkpoints.ts";
import { SubagentCoordinator } from "../src/subagents/coordinator.ts";
import { createDshWorkerRunner, dshWorkerArgs, type DshSpawn } from "../src/subagents/dsh-worker.ts";
import { resolveWorkerSelection } from "../src/subagents/model-selection.ts";
import { buildPiWorkerContinuationPrompt, buildPiWorkerForkPrompt, createUltratermRelayTool } from "../src/subagents/pi-worker.ts";
import { normalizeDispatch } from "../src/subagents/policy.ts";
import { RelayBroker, RUN_BROADCAST_TARGET } from "../src/subagents/relay.ts";
import { renderSubagentResult } from "../src/subagents/render.ts";
import { classifyFailure } from "../src/subagents/route-evidence.ts";
import { emptyUsage, USAP_VERSION, type RunRecord, type TaskRecord } from "../src/subagents/types.ts";
import { finalizeTaskWorktree, prepareRunWorktrees, resolveGitRepo, shouldIsolateWorktrees, sweepOrphanWorktrees } from "../src/subagents/worktree.ts";
import { createUltratermSubagentsExtension, renderRunProgress, ultratermHubSchema, ultratermSubagentsSchema } from "../extensions/ultraterm-subagents.ts";

const rootTmp = realpathSync(mkdtempSync(join(tmpdir(), "steak-pi-v043-test-")));
afterAll(() => {
  setRoutingConfigOverride(undefined);
  vi.unstubAllEnvs();
  rmSync(rootTmp, { recursive: true, force: true });
});
afterEach(() => {
  setRoutingConfigOverride(undefined);
  vi.unstubAllEnvs();
});

type RegistryModel = Parameters<typeof resolveWorkerSelection>[0];

function makeModel(provider: string, id: string, opts: { images?: boolean; baseUrl?: string; api?: string } = {}): RegistryModel {
  return {
    provider,
    id,
    name: `${provider}/${id}`,
    api: opts.api ?? "openai-completions",
    baseUrl: opts.baseUrl ?? `https://${provider}.example/v1`,
    input: opts.images ? ["text", "image"] : ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as RegistryModel;
}

function makeRegistry(models: RegistryModel[]) {
  return {
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => models,
    getAll: () => models,
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
    getProvider: () => ({ streamSimple() {} }),
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-synthetic-key" }),
  };
}

function makeRun(overrides: Partial<RunRecord> = {}, tasks?: TaskRecord[]): RunRecord {
  const id = overrides.id ?? "run-test-1";
  const cwd = overrides.cwd ?? rootTmp;
  return {
    version: USAP_VERSION,
    id,
    goal: "Test v0.43.0 swarm capabilities",
    constraints: [],
    cwd,
    model: "provider-a/model-1",
    thinkingLevel: "medium",
    concurrency: 4,
    timeoutMs: 120_000,
    maxTurns: 8,
    background: false,
    state: "running",
    createdAt: 1_000,
    usage: emptyUsage(),
    tasks: tasks ?? [
      {
        id: `${id}-task-1`,
        label: "task-1",
        task: "Do work",
        role: "worker",
        mayEdit: false,
        ownedPaths: [],
        allowBash: false,
        state: "queued",
        output: "",
        turns: 0,
        usage: emptyUsage(),
        relaySent: 0,
        relayReceived: 0,
        truncated: false,
      },
    ],
    ...overrides,
  };
}

function initGitRepo(name: string): string {
  const dir = join(rootTmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
  execFileSync("git", ["add", "a.ts", "b.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

function writeValidSessionJsonl(path: string, cwd: string, messages: string[] = ["hello"]): void {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "sess-src-1", timestamp: "2026-11-25T00:00:00.000Z", cwd }),
    ...messages.map((text, idx) => JSON.stringify({
      type: "message",
      id: `m-${idx + 1}`,
      parentId: idx === 0 ? null : `m-${idx}`,
      timestamp: "2026-11-25T00:00:01.000Z",
      message: { role: idx % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
    })),
  ];
  writeFileSync(path, lines.join("\n") + "\n", { mode: 0o600 });
}

function createFakeExtensionHarness(opts: {
  cwd: string;
  models?: RegistryModel[];
  runner?: NonNullable<Parameters<typeof createUltratermSubagentsExtension>[0]>["createRunner"];
  accountCommand?: NonNullable<Parameters<typeof createUltratermSubagentsExtension>[0]>["accountCommand"];
  checkpointRoot?: string;
  worktreeRoot?: string;
  now?: () => number;
  sessionId?: string;
}) {
  const models = opts.models ?? [
    makeModel("provider-a", "model-1"),
    makeModel("provider-b", "model-2"),
    makeModel("provider-c", "model-3"),
    makeModel("provider-paid", "paid-model"),
  ];
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, fn: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: () => [...tools.keys()],
    setActiveTools: vi.fn(),
    getFlag: () => undefined,
  };
  let seq = 0;
  const sessionId = opts.sessionId ?? "00000000-0000-4000-8000-000000000001";
  const cpRoot = opts.checkpointRoot ?? join(rootTmp, `cp-${Math.random().toString(36).slice(2)}`);
  const ext = createUltratermSubagentsExtension({
    createRunner: opts.runner,
    accountCommand: opts.accountCommand,
    checkpointRoot: cpRoot,
    worktreeRoot: opts.worktreeRoot ?? join(rootTmp, `wt-${Math.random().toString(36).slice(2)}`),
    startupWindowMs: 0,
    now: opts.now,
    idFactory: () => `id-${++seq}`,
    profiles: [],
  });
  ext(pi as any);
  const sessionFile = join(rootTmp, `parent-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n", { mode: 0o600 });
  const ctx = {
    cwd: opts.cwd,
    model: models[0],
    thinkingLevel: "medium" as const,
    modelRegistry: makeRegistry(models),
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
      getEntries: () => [],
    },
    ui: { setStatus: vi.fn(), setWidget: vi.fn() },
  };
  return {
    tools,
    ctx,
    cpRoot,
    dispatch: (params: Record<string, unknown>) => tools.get("ultraterm_subagents").execute("call-d", params, undefined, undefined, ctx),
    hub: (params: Record<string, unknown>) => tools.get("ultraterm_hub").execute("call-h", params, undefined, undefined, ctx),
    shutdown: async () => {
      for (const fn of handlers.get("session_shutdown") ?? []) await fn({}, ctx);
    },
  };
}

describe("B1: automatic in-place model failover and hub resume model override", () => {
  it("populates alternates for implicit chain waves honoring skipRoute, requireImages, profile thinking, and ensure exclusions", () => {
    const m1 = makeModel("provider-a", "model-1", { images: true });
    const m2 = makeModel("provider-b", "model-2", { images: false });
    const m3 = makeModel("provider-c", "model-3", { images: true });
    const m4 = makeModel("provider-d", "model-4", { images: true });
    const mSkipped = makeModel("provider-skip", "skip-model", { images: true });
    const reg = makeRegistry([m1, m2, m3, m4, mSkipped]);

    setRoutingConfigOverride({
      textWorkerChain: [
        "provider-a/model-1",
        "provider-skip/skip-model",
        "provider-b/model-2",
        "provider-c/model-3",
        "provider-d/model-4",
      ],
      multimodalWorkerChain: [
        "provider-a/model-1",
        "provider-b/model-2",
        "provider-c/model-3",
      ],
      subscriptionRouteChecks: [
        { provider: "provider-a", host: "provider-a.example", pathPattern: "^/v1/?$" },
        { provider: "provider-b", host: "provider-b.example", pathPattern: "^/v1/?$" },
        { provider: "provider-c", host: "provider-c.example", pathPattern: "^/v1/?$" },
        { provider: "provider-d", host: "provider-d.example", pathPattern: "^/v1/?$" },
        { provider: "provider-skip", host: "provider-skip.example", pathPattern: "^/v1/?$" },
      ],
      workerProfiles: [
        { id: "steak-pi/profile-b", model: "provider-b/model-2", thinking: "low" },
        { id: "steak-pi/hooked-d", model: "provider-d/model-4", ensure: { command: ["/bin/true"] } },
      ],
    });

    const implicit = resolveWorkerSelection(
      m1,
      "medium",
      { tasks: [{ label: "a", task: "t" }] },
      reg as never,
      [{ id: "steak-pi/profile-b", model: "provider-b/model-2", thinking: "low" }],
      undefined,
      { skipRoute: (step) => step.provider === "provider-skip" },
      {},
    );
    expect(implicit.selection.source).toBe("chain");
    // Skips provider-skip (skipRoute) and provider-d/model-4 (ensure hook), and honors profile-b thinking.
    expect(implicit.alternates?.map((a) => `${a.model.provider}/${a.model.id}`)).toEqual([
      "provider-b/model-2",
      "provider-c/model-3",
    ]);
    expect(implicit.alternates?.[0].thinkingLevel).toBe("low");

    // Image wave filters out non-vision model-2.
    const vision = resolveWorkerSelection(
      m1,
      "medium",
      { requireImages: true, tasks: [{ label: "a", task: "t" }] },
      reg as never,
      [],
      undefined,
      {},
      {},
    );
    expect(vision.alternates?.map((a) => `${a.model.provider}/${a.model.id}`)).toEqual(["provider-c/model-3"]);

    // Explicit override remains strictly fail-closed with zero alternates.
    const explicit = resolveWorkerSelection(
      m1,
      "medium",
      { model: "provider-a/model-1", tasks: [{ label: "a", task: "t" }] },
      reg as never,
      [],
      undefined,
      {},
      {},
    );
    expect(explicit.selection.source).toBe("override");
    expect(explicit.alternates).toBeUndefined();
  });

  it("switches to nextAlternate in place on mid-run quota/5xx, skips already-visited pre-output hops, and refuses replay without sessionFile", async () => {
    const sessDir = join(rootTmp, "b1-failover-sessions");
    mkdirSync(sessDir, { recursive: true });
    const sessionFile = join(sessDir, "worker-1.jsonl");
    writeValidSessionJsonl(sessionFile, rootTmp, ["initial prompt", "partial work"]);

    // Simulate an in-worker pre-output hop from model-1 -> model-2 before mid-run 503:
    // coordinator must sync currentRoute to model-2 and skip model-2 in alternates, jumping to model-3!
    const seenAttempts: Array<{ alternate?: number; prompt: string }> = [];
    const coordinator = new SubagentCoordinator(
      async ({ task, onProgress, reply }) => {
        onProgress({ state: "running", outputStarted: true, sessionFile });
        seenAttempts.push({ alternate: reply?.alternate, prompt: buildPiWorkerContinuationPrompt(task) });
        if (reply?.alternate === undefined) {
          task.routeFallbacks = ["provider-a/model-1->provider-b/model-2"];
          return { state: "failed", output: "", error: "HTTP 503 service unavailable", turns: 2, usage: emptyUsage() };
        }
        return { state: "done", output: "Completed on model-3", turns: 1, usage: emptyUsage() };
      },
      {
        replyPolicy: (run) =>
          run.selection?.source === "chain"
            ? { alternates: ["provider-b/model-2", "provider-c/model-3"], emptyReplyRetry: false }
            : undefined,
      },
    );

    const run = makeRun({
      id: "run-b1-sync-hop",
      selection: { provider: "provider-a", modelId: "model-1", source: "chain", images: false, tools: true },
    });
    coordinator.start(run);
    const settled = await coordinator.wait("run-b1-sync-hop", "all");
    expect(settled.state).toBe("done");
    expect(seenAttempts.map((a) => a.alternate)).toEqual([undefined, 1]);
    expect(settled.tasks[0].routeFallbacks).toEqual([
      "provider-a/model-1->provider-b/model-2",
      "provider-b/model-2->provider-c/model-3",
    ]);
    expect(seenAttempts[1].prompt).toContain("fallback model route");

    // Without a sessionFile when persistence is wired (e.g. degraded/ephemeral host), mid-run failure MUST NOT replay!
    let callsWithoutSession = 0;
    const noReplayCoord = new SubagentCoordinator(
      async ({ onProgress }) => {
        callsWithoutSession += 1;
        onProgress({ state: "running", outputStarted: true });
        return { state: "failed", output: "", error: "HTTP 402 insufficient_credits", turns: 2, usage: emptyUsage() };
      },
      {
        sessionDir: () => undefined,
        replyPolicy: () => ({ alternates: ["provider-b/model-2"], emptyReplyRetry: false, requireSession: true }),
      },
    );
    noReplayCoord.start(makeRun({
      id: "run-b1-no-replay",
      selection: { provider: "provider-a", modelId: "model-1", source: "chain", images: false, tools: true },
    }));
    const noReplaySettled = await noReplayCoord.wait("run-b1-no-replay", "all");
    expect(noReplaySettled.state).toBe("failed");
    expect(callsWithoutSession).toBe(1);
  });

  it("exercises real extension replyPolicy: implicit mid-run hops with sessionFile while explicit override stays fail-closed", async () => {
    const workDir = join(rootTmp, "b1-real-policy-cwd");
    mkdirSync(workDir, { recursive: true });
    setRoutingConfigOverride({
      textWorkerChain: ["provider-a/model-1", "provider-b/model-2"],
      subscriptionRouteChecks: [
        { provider: "provider-a", host: "provider-a.example", pathPattern: "^/v1/?$" },
        { provider: "provider-b", host: "provider-b.example", pathPattern: "^/v1/?$" },
      ],
    });

    const implicitAttempts: Array<number | undefined> = [];
    const explicitAttempts: Array<number | undefined> = [];
    const h = createFakeExtensionHarness({
      cwd: workDir,
      runner: () => async ({ run, task, sessionDir, onProgress, reply }) => {
        const isExplicit = run.selection?.source === "override";
        (isExplicit ? explicitAttempts : implicitAttempts).push(reply?.alternate);
        if (!task.sessionFile && sessionDir) {
          const sf = join(sessionDir, `${task.id}.jsonl`);
          writeValidSessionJsonl(sf, workDir);
          onProgress({ state: "running", outputStarted: true, sessionFile: sf });
        } else {
          onProgress({ state: "running", outputStarted: true });
        }
        if (reply?.alternate === undefined) {
          return { state: "failed", output: "", error: "HTTP 402 insufficient_credits mid-run", turns: 1, usage: emptyUsage() };
        }
        return { state: "done", output: "Recovered mid-run", turns: 1, usage: emptyUsage() };
      },
    });

    try {
      const implicitRes = await h.dispatch({
        goal: "Implicit chain mid-run recovery",
        tasks: [{ label: "leaf", task: "Work" }],
      });
      expect(implicitRes.details.run.state).toBe("done");
      expect(implicitAttempts).toEqual([undefined, 0]);
      expect(implicitRes.details.run.tasks[0].routeFallbacks).toEqual(["provider-a/model-1->provider-b/model-2"]);

      const explicitRes = await h.dispatch({
        goal: "Explicit route fail-closed",
        model: "provider-a/model-1",
        routeReason: "Explicit override test proving no silent failover",
        tasks: [{ label: "leaf", task: "Work" }],
      });
      expect(explicitRes.details.run.state).toBe("failed");
      expect(explicitAttempts).toEqual([undefined]);
      expect(explicitRes.details.run.tasks[0].routeFallbacks).toBeUndefined();
    } finally {
      await h.shutdown();
    }
  });

  it("reads quota and filters metered quota-blocked alternates even when the winning route is unmetered", async () => {
    const workDir = join(rootTmp, "b1-metered-alt-quota-cwd");
    mkdirSync(workDir, { recursive: true });
    const nowMs = 1_700_000_000_000;
    setRoutingConfigOverride({
      textWorkerChain: ["provider-a/model-1", "provider-b/model-2", "provider-c/model-3"],
      providerQuotaFallback: [
        { quota: "tier-b", label: "Tier B", metered: true, provider: "provider-b" },
      ],
      subscriptionRouteChecks: [
        { provider: "provider-a", host: "provider-a.example", pathPattern: "^/v1/?$" },
        { provider: "provider-b", host: "provider-b.example", pathPattern: "^/v1/?$" },
        { provider: "provider-c", host: "provider-c.example", pathPattern: "^/v1/?$" },
      ],
    });

    let quotaReads = 0;
    const accountCommand = vi.fn(async (args: readonly string[]) => {
      if (args[0] === "status") {
        quotaReads += 1;
        return {
          time: nowMs / 1000,
          providers: {
            "tier-b": {
              accounts: [
                {
                  id: "acct-b1",
                  label: "acct-b1",
                  eligible: false,
                  cooldown: { until: nowMs / 1000 + 3600, reason: "usage limit reached" },
                },
              ],
            },
          },
        };
      }
      return {};
    });

    const h = createFakeExtensionHarness({
      cwd: workDir,
      now: () => nowMs,
      accountCommand,
      runner: () => async ({ task, sessionDir, onProgress, reply }) => {
        if (!task.sessionFile && sessionDir) {
          const sf = join(sessionDir, `${task.id}.jsonl`);
          writeValidSessionJsonl(sf, workDir);
          onProgress({ state: "running", outputStarted: true, sessionFile: sf });
        } else {
          onProgress({ state: "running", outputStarted: true });
        }
        if (reply?.alternate === undefined) {
          return { state: "failed", output: "", error: "HTTP 503 upstream overload mid-run", turns: 1, usage: emptyUsage() };
        }
        return { state: "done", output: `Hopped to alternate ${reply.alternate}`, turns: 1, usage: emptyUsage() };
      },
    });
    try {
      const res = await h.dispatch({
        goal: "Unmetered winner with quota-blocked metered alternate",
        tasks: [{ label: "leaf", task: "Work" }],
      });
      expect(quotaReads).toBeGreaterThanOrEqual(1);
      expect(res.details.run.state).toBe("done");
      // provider-b/model-2 was filtered out by quota, so alternate 0 is provider-c/model-3!
      expect(res.details.run.tasks[0].routeFallbacks).toEqual(["provider-a/model-1->provider-c/model-3"]);

      // Same rule holds for implicit all-reviewer waves resolved through the native reviewer chain!
      const reviewRes = await h.dispatch({
        goal: "Implicit all-reviewer wave with quota-blocked metered alternate",
        tasks: [{ label: "rev", task: "Review", role: "reviewer" }],
      });
      expect(reviewRes.details.run.state).toBe("done");
      expect(reviewRes.details.run.tasks[0].routeFallbacks).toEqual(["provider-a/model-1->provider-c/model-3"]);
    } finally {
      await h.shutdown();
    }
  });

  it("enforces subscription/local admission and thinkingLevel on hub resume --model and rejects paid/non-Pi overrides", async () => {
    const workDir = join(rootTmp, "b1-resume-cwd");
    mkdirSync(workDir, { recursive: true });
    setRoutingConfigOverride({
      subscriptionRouteChecks: [
        { provider: "provider-a", host: "provider-a.example", pathPattern: "^/v1/?$" },
        { provider: "provider-b", host: "provider-b.example", pathPattern: "^/v1/?$" },
      ],
    });

    const resumedModels: string[] = [];
    const seenSessionFiles: Array<string | undefined> = [];
    const h = createFakeExtensionHarness({
      cwd: workDir,
      runner: () => async ({ run, task, sessionDir, onProgress }) => {
        resumedModels.push(run.model);
        if (!task.sessionFile && sessionDir) {
          const sf = join(sessionDir, `${task.id}.jsonl`);
          writeValidSessionJsonl(sf, workDir);
          onProgress({ state: "running", outputStarted: true, sessionFile: sf });
          return { state: "failed", output: "", error: "HTTP 402 quota exhausted", turns: 1, usage: emptyUsage() };
        }
        seenSessionFiles.push(task.sessionFile);
        onProgress({ state: "running", outputStarted: true });
        return { state: "done", output: "Recovered on override model", turns: 1, usage: emptyUsage() };
      },
    });

    try {
      const dispatched = await h.dispatch({
        goal: "Recover quota failure",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for quota recovery test",
        tasks: [{ label: "leaf", task: "Do work" }],
      });
      const runId = dispatched.details.run.runId as string;
      expect(dispatched.details.run.state).toBe("failed");

      // Paid / non-subscription override model MUST be refused before spending the one resume!
      await expect(h.hub({ action: "resume", runId, model: "provider-paid/paid-model" }))
        .rejects.toThrow(/no longer a subscription route|paid or API-key billing/);

      // Subscription override model succeeds cleanly preserving sessionFile.
      const resumed = await h.hub({ action: "resume", runId, model: "provider-b/model-2" });
      const resumedRunId = resumed.details.run.runId as string;
      const waited = await h.hub({ action: "wait", runId: resumedRunId, mode: "all" });
      expect(waited.details.run.state).toBe("done");
      expect(waited.details.run.model).toBe("provider-b/model-2");
      expect(waited.details.run.tasks[0].routeFallbacks).toContain("provider-a/model-1->provider-b/model-2");
      expect(resumedModels).toEqual(["provider-a/model-1", "provider-b/model-2"]);
      expect(seenSessionFiles[0]).toBeTruthy();

      // CheckpointStore.prepareResume stays fail-closed on route change without opt-in AND on thinkingLevel change even with opt-in!
      const store = new CheckpointStore(join(workDir, "direct-parent.jsonl"), join(rootTmp, "cp-strict"));
      try {
        const orig = makeRun({ id: "run-strict-1", cwd: workDir, state: "failed", thinkingLevel: "medium" });
        store.save(orig, true);
        const badRoute = makeRun({ id: "run-strict-2", cwd: workDir, model: "provider-b/model-2", thinkingLevel: "medium", resumedFrom: "run-strict-1" });
        expect(() => store.prepareResume("run-strict-1", badRoute)).toThrow(/stays on the original route/);
        const badThinking = makeRun({ id: "run-strict-3", cwd: workDir, model: "provider-b/model-2", thinkingLevel: "high", resumedFrom: "run-strict-1" });
        expect(() => store.prepareResume("run-strict-1", badThinking, { allowModelOverride: true })).toThrow(/stays on the original route/);
      } finally {
        store.close();
      }
    } finally {
      await h.shutdown();
    }
  });
});

describe("B2: non-destructive run board log, peer visibility scoping, and seqs zero-copy citations", () => {
  it("keeps bounded append-only history, scopes child reads to broadcasts/own/addressed messages, and cleans up on cleanupRun", async () => {
    const broker = new RelayBroker({ runLimit: 10 });
    broker.createRun("run-b2", ["parent", "t1", "t2"]);
    const p1 = broker.bind("run-b2", "t1");
    const p2 = broker.bind("run-b2", "t2");
    const parent = broker.bind("run-b2", "parent");

    const r1 = p1.send({ to: "t2", body: "finding alpha" });
    const r2 = p2.send({ to: "parent", body: "private t2 to parent", kind: "request" });
    const r3 = p1.send({ to: RUN_BROADCAST_TARGET, body: "broadcast gamma" });
    expect(r1.ok && r1.seqs).toEqual([1]);
    expect(r2.ok && r2.seqs).toEqual([2]);
    expect(r3.ok && r3.seqs).toEqual([3, 4]);

    // Parent sees the entire board non-destructively.
    const parentCited = parent.read({ seqs: [1, 2, 3, 999] });
    expect(parentCited.messages.map((m) => [m.seq, m.body])).toEqual([
      [1, "finding alpha"],
      [2, "private t2 to parent"],
      [3, "broadcast gamma"],
    ]);

    // Child peer t1 CANNOT read direct t2 -> parent (#2), CAN read its own (#1) and broadcasts (#3, #4)!
    expect(p1.read({ seqs: [2] }).messages).toEqual([]);
    expect(p1.read({ seqs: [1, 2, 3] }).messages.map((m) => m.seq)).toEqual([1, 3]);

    // Child peer t2 sees #1 (to t2), #2 (from t2), and broadcasts; inbox() remains intact!
    expect(p2.read({ afterSeq: 0 }).messages.map((m) => m.seq)).toContain(1);
    expect(p2.read({ afterSeq: 0 }).messages.map((m) => m.seq)).toContain(2);
    expect(p2.inbox().messages.map((m) => m.seq)).toEqual([1, 4]);
    expect(p2.inbox().messages).toEqual([]);
    // Even after destructive inbox() drain, non-destructive read() still has #1!
    expect(p2.read({ seqs: [1] }).messages.map((m) => m.body)).toEqual(["finding alpha"]);

    // Relay tool exposes operation: "read" with seqs (respecting child visibility).
    const task = makeRun().tasks[0];
    const tool = createUltratermRelayTool(p2, task);
    const toolRes = await tool.execute("c1", { operation: "read", seqs: [2] }, undefined as any, undefined as any, undefined as any);
    expect((toolRes.details as any).messages[0].body).toBe("private t2 to parent");

    // Unanswered request tracking & viewer-scoped seqsBySender.
    expect(broker.unansweredRequests("run-b2").map((req) => req.seq)).toEqual([2]);
    expect(broker.seqsBySender("run-b2", "t2", "t1")).toEqual([]);
    expect(broker.seqsBySender("run-b2", "t1", "t2")).toEqual([1, 3, 4]);

    expect(broker.cleanupRun("run-b2")).toBe(true);
    expect(broker.readRun("run-b2").messages).toEqual([]);
    expect(p1.read({ seqs: [1] }).messages).toEqual([]);
  });

  it("exposes non-destructive seqs read on ultraterm_hub{action:'inbox'} while keeping default inbox backwards-compatible", async () => {
    const workDir = join(rootTmp, "b2-hub-cwd");
    mkdirSync(workDir, { recursive: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const h = createFakeExtensionHarness({
      cwd: workDir,
      runner: (_pi, relay) => async ({ run, task, onProgress }) => {
        onProgress({ state: "running", outputStarted: true });
        const peer = relay.bind(run.id, task.id);
        peer.send({ to: "parent", body: "peer report #1" });
        peer.send({ to: "parent", body: "peer report #2" });
        await gate;
        peer.close();
        return { state: "done", output: "done", turns: 1, usage: emptyUsage() };
      },
    });

    try {
      const started = await h.dispatch({
        goal: "Relay seqs test",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for relay seqs test",
        background: true,
        tasks: [{ label: "worker", task: "Send two messages" }],
      });
      const runId = started.details.run.runId as string;
      await vi.waitFor(async () => {
        const res = await h.hub({ action: "inbox", runId, seqs: [1, 2] });
        expect(res.details.relay.messages).toHaveLength(2);
      });
      const secondRead = await h.hub({ action: "inbox", runId, seqs: [2] });
      expect(secondRead.content[0].text).toContain("#2");
      expect(secondRead.content[0].text).toContain("peer report #2");

      const drained = await h.hub({ action: "inbox", runId });
      expect(drained.details.relay.messages).toHaveLength(2);
      const empty = await h.hub({ action: "inbox", runId });
      expect(empty.details.relay.messages).toHaveLength(0);
      const stillThere = await h.hub({ action: "inbox", runId, seqs: [1] });
      expect(stillThere.details.relay.messages).toHaveLength(1);
    } finally {
      release();
      await h.shutdown();
    }
  });
});

describe("B3: intra-wave bounded DAG dependsOn", () => {
  it("validates dependsOn fail-closed on unknown refs, self-refs, and cycles, and resolves by taskId as well as label", () => {
    expect(() => normalizeDispatch({
      goal: "Unknown dep",
      tasks: [{ label: "a", task: "x", dependsOn: ["missing"] }],
    }, rootTmp, "provider-a/model-1", "medium")).toThrow(/unknown sibling/);

    expect(() => normalizeDispatch({
      goal: "Self dep",
      tasks: [{ label: "a", task: "x", dependsOn: ["a"] }],
    }, rootTmp, "provider-a/model-1", "medium")).toThrow(/cannot reference itself/);

    expect(() => normalizeDispatch({
      goal: "Cycle",
      tasks: [
        { label: "a", task: "x", dependsOn: ["b"] },
        { label: "b", task: "y", dependsOn: ["a"] },
      ],
    }, rootTmp, "provider-a/model-1", "medium")).toThrow(/dependency cycle/);

    // Reference by taskId resolves cleanly.
    const byId = normalizeDispatch({
      goal: "By ID",
      tasks: [
        { label: "first", task: "x" },
        { label: "second", task: "y", dependsOn: ["run-fixed-task-1"] },
      ],
    }, rootTmp, "provider-a/model-1", "medium", 1_000, () => "fixed");
    expect(byId.tasks[1].dependsOn).toEqual(["run-fixed-task-1"]);
  });

  it("holds dependents queued until predecessors finish, injects Pi-only visible #seq pointers, and omits #seq on foreign harnesses", async () => {
    const order: string[] = [];
    let piVerifierPrompt = "";
    const relay = new RelayBroker();
    const run = normalizeDispatch({
      goal: "Author then verify",
      tasks: [
        { label: "author", task: "Write code" },
        { label: "verifier", task: "Verify code", role: "reviewer", dependsOn: ["author"] },
      ],
    }, rootTmp, "provider-a/model-1", "medium");
    relay.createRun(run.id, ["parent", ...run.tasks.map((t) => t.id)]);

    const coordinator = new SubagentCoordinator(
      async ({ run: r, task }) => {
        order.push(task.label);
        if (task.label === "author") {
          const peer = relay.bind(r.id, task.id);
          peer.send({ to: "parent", body: "private to parent" });
          peer.send({ to: RUN_BROADCAST_TARGET, body: "broadcast for peers" });
          peer.close();
          await new Promise((res) => setTimeout(res, 20));
          return { state: "done", output: "Implemented parser cleanly.", turns: 1, usage: emptyUsage() };
        }
        piVerifierPrompt = task.task;
        return { state: "done", output: "Verified OK.", turns: 1, usage: emptyUsage() };
      },
      { predecessorRelaySeqs: (runId, senderId, viewerId) => relay.seqsBySender(runId, senderId, viewerId) },
    );

    coordinator.start(run);
    const settled = await coordinator.wait(run.id, "all");
    expect(settled.state).toBe("done");
    expect(order).toEqual(["author", "verifier"]);
    expect(piVerifierPrompt).toContain("[Predecessor outputs");
    // Only visible broadcast #seq (not private #1 to parent) is cited!
    expect(piVerifierPrompt).not.toContain("#1");
    expect(piVerifierPrompt).toContain("#2");
    expect(piVerifierPrompt).toContain("Implemented parser cleanly.");

    // Foreign harness (steak-dsh) omits `relay=#seq` because it has no relay read tool.
    let dshVerifierPrompt = "";
    const dshRun = normalizeDispatch({
      goal: "DSH DAG",
      harness: "steak-dsh",
      tasks: [
        { label: "author", task: "Write" },
        { label: "verifier", task: "Verify", role: "reviewer", dependsOn: ["author"] },
      ],
    }, rootTmp, "steak-dsh/provider-a/model-1", "medium");
    const dshCoord = new SubagentCoordinator(
      async ({ task }) => {
        if (task.label === "author") return { state: "done", output: "Author done", turns: 1, usage: emptyUsage() };
        dshVerifierPrompt = task.task;
        return { state: "done", output: "Verified", turns: 1, usage: emptyUsage() };
      },
      { predecessorRelaySeqs: () => [1, 2] },
    );
    dshCoord.start(dshRun);
    await dshCoord.wait(dshRun.id, "all");
    expect(dshVerifierPrompt).not.toContain("relay=#");
    expect(dshVerifierPrompt).toContain("Author done");
  });

  it("cascades clean abort on failed, aborted, and timed-out predecessors, and preserves unfinished dependsOn on hub resume", async () => {
    for (const terminalState of ["failed", "aborted", "timed_out"] as const) {
      const run = normalizeDispatch({
        goal: `Cascade ${terminalState}`,
        tasks: [
          { label: "step-1", task: "Stop here" },
          { label: "step-2", task: "Wait on step-1", dependsOn: ["step-1"] },
          { label: "step-3", task: "Wait on step-2", dependsOn: ["step-2"] },
        ],
      }, rootTmp, "provider-a/model-1", "medium");
      const dispatched: string[] = [];
      const coordinator = new SubagentCoordinator(async ({ task }) => {
        dispatched.push(task.label);
        return { state: terminalState, output: "", error: `stopped:${terminalState}`, turns: 1, usage: emptyUsage() };
      });
      coordinator.start(run);
      const settled = await coordinator.wait(run.id, "all");
      expect(dispatched).toEqual(["step-1"]);
      expect(settled.tasks[1].state).toBe("aborted");
      expect(settled.tasks[1].error).toBe("Dependency step-1 failed");
      expect(settled.tasks[2].state).toBe("aborted");
      expect(settled.tasks[2].error).toBe("Dependency step-2 failed");
    }

    // Bounded hub resume preserves unfinished dependsOn ordering!
    const workDir = join(rootTmp, "b3-resume-dag-cwd");
    mkdirSync(workDir, { recursive: true });
    setRoutingConfigOverride({
      subscriptionRouteChecks: [{ provider: "provider-a", host: "provider-a.example", pathPattern: "^/v1/?$" }],
    });
    const resumeOrder: string[] = [];
    let attempt = 0;
    const h = createFakeExtensionHarness({
      cwd: workDir,
      runner: () => async ({ task, sessionDir, onProgress }) => {
        if (!task.sessionFile && sessionDir) {
          const sf = join(sessionDir, `${task.id}.jsonl`);
          writeValidSessionJsonl(sf, workDir);
          onProgress({ state: "running", outputStarted: true, sessionFile: sf });
        } else {
          onProgress({ state: "running", outputStarted: true });
        }
        if (attempt === 0) {
          attempt += 1;
          return { state: "failed", output: "", error: "step-a failed first time", turns: 1, usage: emptyUsage() };
        }
        resumeOrder.push(task.label);
        if (task.label === "step-a") await new Promise((r) => setTimeout(r, 20));
        return { state: "done", output: `${task.label} ok`, turns: 1, usage: emptyUsage() };
      },
    });
    try {
      const first = await h.dispatch({
        goal: "Resume DAG",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for DAG resume preservation",
        tasks: [
          { label: "step-a", task: "First" },
          { label: "step-b", task: "Second", dependsOn: ["step-a"] },
        ],
      });
      const resumed = await h.hub({ action: "resume", runId: first.details.run.runId });
      const waited = await h.hub({ action: "wait", runId: resumed.details.run.runId, mode: "all" });
      expect(waited.details.run.state).toBe("done");
      expect(resumeOrder).toEqual(["step-a", "step-b"]);
    } finally {
      await h.shutdown();
    }
  });
});

describe("B4: automatic isolated git worktrees", () => {
  it("handles auto/shared/worktree modes, dirty parent fallback, sequential writers, safety bounds, and session-scoped orphan sweep", () => {
    const repo = initGitRepo("b4-repo-auto");
    const wtRoot = join(rootTmp, "b4-wt-root");

    // Single writer stays shared under auto.
    const singleRun = normalizeDispatch({
      goal: "Single writer",
      tasks: [{ label: "w1", task: "edit a", mayEdit: true, ownedPaths: ["a.ts"] }],
    }, repo, "provider-a/model-1", "medium");
    expect(shouldIsolateWorktrees(singleRun)).toBe(false);
    expect(prepareRunWorktrees(singleRun, { worktreeRoot: wtRoot }).active).toBe(false);

    // Sequential writers (direct or transitive via read-only step) stay shared under auto so w2 sees w1's edits.
    const seqWriters = normalizeDispatch({
      goal: "Sequential writers",
      tasks: [
        { label: "w1", task: "edit a", mayEdit: true, ownedPaths: ["a.ts"] },
        { label: "w2", task: "edit b", mayEdit: true, ownedPaths: ["b.ts"], dependsOn: ["w1"] },
      ],
    }, repo, "provider-a/model-1", "medium");
    expect(shouldIsolateWorktrees(seqWriters)).toBe(false);
    expect(prepareRunWorktrees(seqWriters, { worktreeRoot: wtRoot }).skippedReason).toBe("dependent-writers");

    const transitiveWriters = normalizeDispatch({
      goal: "Transitive writers",
      tasks: [
        { label: "w1", task: "edit a", mayEdit: true, ownedPaths: ["a.ts"] },
        { label: "scout", task: "inspect a", dependsOn: ["w1"] },
        { label: "w2", task: "edit b", mayEdit: true, ownedPaths: ["b.ts"], dependsOn: ["scout"] },
      ],
    }, repo, "provider-a/model-1", "medium");
    expect(shouldIsolateWorktrees(transitiveWriters)).toBe(false);
    expect(prepareRunWorktrees(transitiveWriters, { worktreeRoot: wtRoot }).skippedReason).toBe("dependent-writers");

    // Dirty parent repo falls back to shared under auto (never silently drops uncommitted edits!).
    writeFileSync(join(repo, "a.ts"), "export const a = 999;\n");
    const dirtyParentRun = normalizeDispatch({
      goal: "Dirty parent",
      tasks: [
        { label: "w1", task: "edit a", mayEdit: true, ownedPaths: ["a.ts"] },
        { label: "w2", task: "edit b", mayEdit: true, ownedPaths: ["b.ts"] },
      ],
    }, repo, "provider-a/model-1", "medium");
    expect(prepareRunWorktrees(dirtyParentRun, { worktreeRoot: wtRoot }).skippedReason).toBe("dirty-parent");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");

    // Explicit worktree fails closed outside a git repo.
    const nonGit = join(rootTmp, "b4-nongit");
    mkdirSync(nonGit, { recursive: true });
    const nonGitRun = normalizeDispatch({
      goal: "Outside git",
      workspace: "worktree",
      tasks: [{ label: "w1", task: "edit", mayEdit: true, ownedPaths: ["x.ts"] }],
    }, nonGit, "provider-a/model-1", "medium");
    expect(() => prepareRunWorktrees(nonGitRun, { worktreeRoot: wtRoot })).toThrow(/requires a git repository/);

    // Refuses worktreeRoot inside the repo tree.
    const multiRun = normalizeDispatch({
      goal: "Multi writer",
      tasks: [
        { label: "w1", task: "edit a", mayEdit: true, ownedPaths: ["a.ts"] },
        { label: "w2", task: "edit b", mayEdit: true, ownedPaths: ["b.ts"] },
      ],
    }, repo, "provider-a/model-1", "medium");
    multiRun.ownerSessionId = "session-owner-1";
    expect(() => prepareRunWorktrees(multiRun, { worktreeRoot: join(repo, ".worktrees") })).toThrow(/inside the repository tree/);

    // Clean multi-writer wave under auto creates isolated worktrees outside repo and saves originalOwnedPaths.
    const prepared = prepareRunWorktrees(multiRun, { worktreeRoot: wtRoot });
    expect(prepared.active).toBe(true);
    const [t1, t2] = multiRun.tasks;
    expect(t1.originalOwnedPaths).toEqual([join(repo, "a.ts")]);
    expect(t1.ownedPaths[0]).toBe(join(t1.cwd!, "a.ts"));

    // Dirty aborted worktree is RETAINED (never destroys user edits on cancel!); clean worktree is auto-cleaned!
    writeFileSync(join(t1.cwd!, "a.ts"), "export const a = 42;\n");
    t1.state = "aborted";
    t2.state = "done";
    const r1 = finalizeTaskWorktree(prepared.repoRoot!, t1, { worktreeRoot: wtRoot, runId: multiRun.id })!;
    const r2 = finalizeTaskWorktree(prepared.repoRoot!, t2, { worktreeRoot: wtRoot, runId: multiRun.id })!;
    expect(r1.dirty).toBe(true);
    expect(r1.cleaned).toBe(false);
    expect(existsSync(r1.worktreePath)).toBe(true);
    expect(r2.dirty).toBe(false);
    expect(r2.cleaned).toBe(true);
    expect(existsSync(r2.worktreePath)).toBe(false);

    // Clean working tree WITH commits is ALWAYS retained by both finalizeTaskWorktree and sweepOrphanWorktrees!
    const committedRun = normalizeDispatch({
      goal: "Committed only",
      workspace: "worktree",
      tasks: [
        { label: "c1", task: "commit and keep folder", mayEdit: true, ownedPaths: ["a.ts"] },
        { label: "c2", task: "commit then remove folder", mayEdit: true, ownedPaths: ["b.ts"] },
      ],
    }, repo, "provider-a/model-1", "medium");
    committedRun.ownerSessionId = "session-owner-1";
    const commPrep = prepareRunWorktrees(committedRun, { worktreeRoot: wtRoot });
    expect(commPrep.active).toBe(true);
    const [ct1, ct2] = committedRun.tasks;
    writeFileSync(join(ct1.cwd!, "a.ts"), "export const a = 100;\n");
    execFileSync("git", ["add", "a.ts"], { cwd: ct1.cwd!, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "commit ct1"], { cwd: ct1.cwd!, stdio: "ignore" });
    writeFileSync(join(ct2.cwd!, "b.ts"), "export const b = 200;\n");
    execFileSync("git", ["add", "b.ts"], { cwd: ct2.cwd!, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "commit ct2"], { cwd: ct2.cwd!, stdio: "ignore" });
    // Manually remove ct2's worktree folder so only its committed branch remains.
    execFileSync("git", ["worktree", "remove", ct2.worktree!.worktreePath], { cwd: repo, stdio: "ignore" });

    const rc1 = finalizeTaskWorktree(commPrep.repoRoot!, ct1, { worktreeRoot: wtRoot, runId: committedRun.id })!;
    const rc2 = finalizeTaskWorktree(commPrep.repoRoot!, ct2, { worktreeRoot: wtRoot, runId: committedRun.id })!;
    expect(rc1.dirty).toBe(false);
    expect(rc1.committed).toBe(true);
    expect(rc1.cleaned).toBe(false);
    expect(existsSync(rc1.worktreePath)).toBe(true);
    expect(rc2.dirty).toBe(false);
    expect(rc2.committed).toBe(true);
    expect(rc2.cleaned).toBe(false);
    const branchExists = (br: string) => {
      try { execFileSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${br}`], { cwd: repo, stdio: "ignore" }); return true; }
      catch { return false; }
    };
    expect(branchExists(rc1.branch)).toBe(true);
    expect(branchExists(rc2.branch)).toBe(true);

    // Tampered receipt pointing finalizeTaskWorktree at repoRoot (main checkout) MUST be refused and leave repo intact!
    const tamperedTask = {
      ...t2,
      worktree: {
        worktreePath: repo,
        branch: `usap/${multiRun.id}/tampered`,
        baseCommit: prepared.baseCommit!,
        dirty: false,
        committed: false,
        cleaned: false,
      },
    };
    const tamperedResult = finalizeTaskWorktree(prepared.repoRoot!, tamperedTask, { worktreeRoot: wtRoot, runId: multiRun.id })!;
    expect(tamperedResult.cleaned).toBe(false);
    expect(existsSync(repo)).toBe(true);

    // Cross-session orphan sweep NEVER deletes another session's worktree OR any dirty/committed worktree/branch!
    const cleanOrphanRun = normalizeDispatch({
      goal: "Clean orphan",
      workspace: "worktree",
      tasks: [{ label: "w1", task: "noop", mayEdit: true, ownedPaths: ["a.ts"] }],
    }, repo, "provider-a/model-1", "medium");
    cleanOrphanRun.ownerSessionId = "session-owner-1";
    const orphanPrep = prepareRunWorktrees(cleanOrphanRun, { worktreeRoot: wtRoot });
    expect(orphanPrep.active).toBe(true);
    const orphanWt = cleanOrphanRun.tasks[0].worktree!.worktreePath;

    // Different session sweeps NOTHING!
    expect(sweepOrphanWorktrees(wtRoot, { ownerSessionId: "session-owner-2" })).toBe(0);
    expect(existsSync(orphanWt)).toBe(true);

    // Tampered metadata pointing outside runDir or non-usap branch is refused!
    const badRunDir = join(wtRoot, "run-tampered");
    mkdirSync(badRunDir, { recursive: true });
    writeFileSync(join(badRunDir, ".meta-t1.json"), JSON.stringify({
      version: 1, runId: "run-tampered", taskId: "t1", ownerSessionId: "session-owner-1",
      repoRoot: repo, worktreePath: repo, branch: "main", baseCommit: prepared.baseCommit, createdAt: 1,
    }));
    expect(sweepOrphanWorktrees(wtRoot, { ownerSessionId: "session-owner-1" })).toBe(1); // Only the real clean orphan!
    expect(existsSync(orphanWt)).toBe(false);
    expect(existsSync(repo)).toBe(true); // Untouched!
    expect(existsSync(r1.worktreePath)).toBe(true); // Dirty worktree NEVER auto-deleted by sweep!
    expect(existsSync(rc1.worktreePath)).toBe(true); // Committed worktree NEVER auto-deleted by sweep!
    expect(branchExists(rc1.branch)).toBe(true); // Committed branch NEVER deleted by sweep!
    expect(branchExists(rc2.branch)).toBe(true); // Missing-folder committed branch NEVER deleted by sweep!
  });

  it("lets a read-only verifier see its isolated writer's edits and lets hub resume reuse a retained dirty worktree", async () => {
    const repo = initGitRepo("b4-repo-verify-resume");
    const wtRoot = join(rootTmp, "b4-wt-verify-resume");
    setRoutingConfigOverride({
      subscriptionRouteChecks: [{ provider: "provider-a", host: "provider-a.example", pathPattern: "^/v1/?$" }],
    });

    // 1. Writer-a + writer-b + read-only verifier depending on writer-a: verifier inspects writer-a's edited a.ts!
    const verifyRun = normalizeDispatch({
      goal: "Parallel writers + verifier",
      tasks: [
        { label: "writer-a", task: "edit a", mayEdit: true, ownedPaths: ["a.ts"] },
        { label: "writer-b", task: "edit b", mayEdit: true, ownedPaths: ["b.ts"] },
        { label: "verifier", task: "verify a", role: "reviewer", dependsOn: ["writer-a"] },
      ],
    }, repo, "provider-a/model-1", "medium");
    let verifierReadContent = "";
    const coord = new SubagentCoordinator(
      async ({ task }) => {
        if (task.label === "writer-a") {
          writeFileSync(join(task.cwd!, "a.ts"), "export const a = 777;\n");
          return { state: "done", output: "Updated a=777", turns: 1, usage: emptyUsage() };
        }
        if (task.label === "writer-b") {
          return { state: "done", output: "No changes", turns: 1, usage: emptyUsage() };
        }
        verifierReadContent = readFileSync(join(task.cwd!, "a.ts"), "utf8");
        return { state: "done", output: "Verified a=777", turns: 1, usage: emptyUsage() };
      },
      { worktreeRoot: wtRoot },
    );
    coord.start(verifyRun);
    const settled = await coord.wait(verifyRun.id, "all");
    expect(settled.state).toBe("done");
    expect(verifierReadContent).toBe("export const a = 777;\n");
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("export const a = 1;\n");

    // 2. Hub resume on a failed worktree-isolated writer reuses the retained dirty worktree!
    const repo2 = initGitRepo("b4-repo-resume");
    const wtRoot2 = join(rootTmp, "b4-wt-resume");
    const seenCwds: string[] = [];
    const h = createFakeExtensionHarness({
      cwd: repo2,
      worktreeRoot: wtRoot2,
      runner: () => async ({ task, sessionDir, onProgress }) => {
        seenCwds.push(task.cwd ?? "");
        if (!task.sessionFile && sessionDir) {
          const sf = join(sessionDir, `${task.id}.jsonl`);
          writeValidSessionJsonl(sf, task.cwd ?? repo2);
          onProgress({ state: "running", outputStarted: true, sessionFile: sf });
          if (task.label === "w1") {
            writeFileSync(join(task.cwd!, "a.ts"), "export const a = 555;\n");
            return { state: "failed", output: "", error: "partial edit before failure", turns: 1, usage: emptyUsage() };
          }
          return { state: "done", output: "w2 done", turns: 1, usage: emptyUsage() };
        }
        onProgress({ state: "running", outputStarted: true });
        const preserved = readFileSync(join(task.cwd!, "a.ts"), "utf8");
        return { state: "done", output: `Resumed saw: ${preserved.trim()}`, turns: 1, usage: emptyUsage() };
      },
    });
    try {
      const first = await h.dispatch({
        goal: "Worktree resume",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for worktree resume reuse",
        tasks: [
          { label: "w1", task: "edit a", mayEdit: true, ownedPaths: ["a.ts"] },
          { label: "w2", task: "edit b", mayEdit: true, ownedPaths: ["b.ts"] },
        ],
      });
      const firstW1Wt = first.details.run.tasks[0].worktree.worktreePath as string;
      const resumed = await h.hub({ action: "resume", runId: first.details.run.runId });
      const waited = await h.hub({ action: "wait", runId: resumed.details.run.runId, mode: "all" });
      expect(waited.details.run.state).toBe("done");
      expect(waited.details.run.tasks[0].output).toContain("Resumed saw: export const a = 555;");
      expect(waited.details.run.tasks[0].worktree.worktreePath).toBe(firstW1Wt);
      expect(resolveGitRepo(repo2)?.dirty).toBe(false);
    } finally {
      await h.shutdown();
    }
  });

  it("preserves done-writer worktree cwd and predecessor block for read-only verifiers across hub resume", async () => {
    setRoutingConfigOverride({
      subscriptionRouteChecks: [{ provider: "provider-a", host: "provider-a.example", pathPattern: "^/v1/?$" }],
    });
    // Both when the verifier failed after starting inside the worktree AND when it never started before cancel.
    const repo3 = initGitRepo("b4-repo-resume-verifier");
    const wtRoot3 = join(rootTmp, "b4-wt-resume-verifier");
    let writerAWt = "";
    let resumedVerifierCwd = "";
    let resumedVerifierContent = "";
    let resumedVerifierPrompt = "";
    let verifierAttempt = 0;
    const h3 = createFakeExtensionHarness({
      cwd: repo3,
      worktreeRoot: wtRoot3,
      runner: () => async ({ task, sessionDir, onProgress }) => {
        if (task.label === "writer-a") {
          writerAWt = task.cwd ?? "";
          writeFileSync(join(task.cwd!, "a.ts"), "export const a = 888;\n");
          onProgress({ state: "running", outputStarted: true });
          return { state: "done", output: "Updated a=888 in writer-a", turns: 1, usage: emptyUsage() };
        }
        if (task.label === "writer-b") {
          onProgress({ state: "running", outputStarted: true });
          return { state: "done", output: "writer-b done", turns: 1, usage: emptyUsage() };
        }
        // Verifier fails on first run (after starting inside writer-a's worktree), then succeeds on resume!
        verifierAttempt += 1;
        if (verifierAttempt === 1) {
          const sf = join(sessionDir!, `${task.id}.jsonl`);
          writeValidSessionJsonl(sf, task.cwd ?? repo3);
          onProgress({ state: "running", outputStarted: true, sessionFile: sf });
          return { state: "failed", output: "", error: "verifier interrupted", turns: 1, usage: emptyUsage() };
        }
        resumedVerifierCwd = task.cwd ?? "";
        resumedVerifierPrompt = task.task;
        resumedVerifierContent = readFileSync(join(task.cwd!, "a.ts"), "utf8");
        onProgress({ state: "running", outputStarted: true });
        return { state: "done", output: "Verified resumed edits", turns: 1, usage: emptyUsage() };
      },
    });
    try {
      const run3 = await h3.dispatch({
        goal: "Resume started verifier in writer worktree",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for resumed verifier worktree preservation",
        tasks: [
          { label: "writer-a", task: "edit a", mayEdit: true, ownedPaths: ["a.ts"] },
          { label: "writer-b", task: "edit b", mayEdit: true, ownedPaths: ["b.ts"] },
          { label: "verifier", task: "verify a", role: "reviewer", dependsOn: ["writer-a"] },
        ],
      });
      const res3 = await h3.hub({ action: "resume", runId: run3.details.run.runId });
      const wait3 = await h3.hub({ action: "wait", runId: res3.details.run.runId, mode: "all" });
      expect(wait3.details.run.state).toBe("done");
      expect(resumedVerifierCwd).toBe(writerAWt);
      expect(resumedVerifierContent).toBe("export const a = 888;\n");
      expect(resumedVerifierPrompt.match(/\[Predecessor outputs \(completed dependencies;/g)).toHaveLength(1);
    } finally {
      await h3.shutdown();
    }

    // 4. Same scenario when verifier NEVER started (cancelled/aborted after writer-a finished):
    // hub resume must still point verifier at writer-a's worktree and inject the predecessor block!
    const repo4 = initGitRepo("b4-repo-resume-queued-verifier");
    const wtRoot4 = join(rootTmp, "b4-wt-resume-queued-verifier");
    let writerA4Wt = "";
    let resumedQueuedCwd = "";
    let resumedQueuedContent = "";
    let resumedQueuedPrompt = "";
    let releaseWriterB!: () => void;
    const writerBGate = new Promise<void>((r) => { releaseWriterB = r; });
    let writerADone!: () => void;
    const writerADoneP = new Promise<void>((r) => { writerADone = r; });
    const h4 = createFakeExtensionHarness({
      cwd: repo4,
      worktreeRoot: wtRoot4,
      runner: () => async ({ task, sessionDir, signal, onProgress }) => {
        if (task.label === "writer-a") {
          writerA4Wt = task.cwd ?? "";
          writeFileSync(join(task.cwd!, "a.ts"), "export const a = 999;\n");
          onProgress({ state: "running", outputStarted: true });
          writerADone();
          return { state: "done", output: "Updated a=999 in writer-a", turns: 1, usage: emptyUsage() };
        }
        if (task.label === "writer-b") {
          if (!task.sessionFile && sessionDir) {
            const sf = join(sessionDir, `${task.id}.jsonl`);
            writeValidSessionJsonl(sf, task.cwd ?? repo4);
            onProgress({ state: "running", outputStarted: true, sessionFile: sf });
          } else {
            onProgress({ state: "running", outputStarted: true });
          }
          await Promise.race([
            writerBGate,
            new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
          ]);
          if (signal.aborted) return { state: "aborted", output: "", error: "cancelled while waiting", turns: 1, usage: emptyUsage() };
          return { state: "done", output: "writer-b done", turns: 1, usage: emptyUsage() };
        }
        resumedQueuedCwd = task.cwd ?? "";
        resumedQueuedPrompt = task.task;
        resumedQueuedContent = readFileSync(join(task.cwd!, "a.ts"), "utf8");
        onProgress({ state: "running", outputStarted: true });
        return { state: "done", output: "Verified queued-then-resumed edits", turns: 1, usage: emptyUsage() };
      },
    });
    try {
      const bg = await h4.dispatch({
        goal: "Resume never-started verifier in writer worktree",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for queued verifier resume",
        background: true,
        concurrency: 2,
        tasks: [
          { label: "writer-a", task: "edit a", mayEdit: true, ownedPaths: ["a.ts"] },
          { label: "writer-b", task: "edit b", mayEdit: true, ownedPaths: ["b.ts"] },
          // Depends on BOTH writer-a and writer-b so it stays queued until writer-b finishes (cancelled first).
          { label: "verifier", task: "verify a", role: "reviewer", dependsOn: ["writer-a", "writer-b"] },
        ],
      });
      await writerADoneP;
      await new Promise((r) => setTimeout(r, 15));
      await h4.hub({ action: "cancel", runId: bg.details.run.runId });
      releaseWriterB();
      await h4.hub({ action: "wait", runId: bg.details.run.runId, mode: "all" });

      const res4 = await h4.hub({ action: "resume", runId: bg.details.run.runId });
      const wait4 = await h4.hub({ action: "wait", runId: res4.details.run.runId, mode: "all" });
      expect(wait4.details.run.state).toBe("done");
      expect(resumedQueuedCwd).toBe(writerA4Wt);
      expect(resumedQueuedContent).toBe("export const a = 999;\n");
      expect(resumedQueuedPrompt).toContain("[Predecessor outputs (completed dependencies;");
      expect(resumedQueuedPrompt.match(/\[Predecessor outputs \(completed dependencies;/g)).toHaveLength(1);
      expect(resumedQueuedPrompt).toContain("Updated a=999 in writer-a");
      expect(resumedQueuedPrompt).toContain("writer-b done");
      expect(resumedQueuedPrompt).toContain("worktreeBranch=");
    } finally {
      await h4.shutdown();
    }
  });
});

describe("B5: warm context-preserving forkFrom", () => {
  it("copies ONLY the validated JSONL session file with mode 0600 and rejects symlinks/non-Pi harnesses", () => {
    const sessDir = join(rootTmp, "b5-sessions");
    mkdirSync(sessDir, { recursive: true });
    const src = join(sessDir, "src.jsonl");
    const scratch = join(sessDir, "heavy-scratch-dir");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "big.bin"), "ignored");
    writeValidSessionJsonl(src, rootTmp, ["prior question", "prior answer"]);

    const forked = forkWorkerSessionFile(src, sessDir, rootTmp);
    expect(forked).not.toBe(src);
    expect(statSync(forked).mode & 0o777).toBe(0o600);
    const lines = readFileSync(forked, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].type).toBe("session");
    expect(lines[0].id).not.toBe("sess-src-1");
    expect(lines[0].parentSession).toBe(src);
    expect(lines.slice(1)).toHaveLength(2);

    const link = join(sessDir, "link.jsonl");
    symlinkSync(src, link);
    expect(() => forkWorkerSessionFile(link, sessDir, rootTmp)).toThrow();

    // Non-Pi harness fails closed in normalizeDispatch.
    expect(() => normalizeDispatch({
      goal: "Fork on dsh",
      harness: "steak-dsh",
      tasks: [{ label: "a", task: "x", forkFrom: { runId: "run-1", taskId: "run-1-task-1" } }],
    }, rootTmp, "steak-dsh/provider-a/model-1", "medium")).toThrow(/only on the native pi harness/);

    const task = makeRun().tasks[0];
    task.forkFrom = { runId: "run-0", taskId: "run-0-task-1" };
    expect(buildPiWorkerForkPrompt(task)).toContain("forked from run-0/run-0-task-1");
  });

  it("forks settled same-session tasks, refuses live/cross-session/escaped sources, and cleans up forked files if start throws", async () => {
    const workDir = join(rootTmp, "b5-ext-cwd");
    mkdirSync(workDir, { recursive: true });
    const seenSessionFiles: string[] = [];
    let releaseLive!: () => void;
    const liveGate = new Promise<void>((r) => { releaseLive = r; });

    const h = createFakeExtensionHarness({
      cwd: workDir,
      runner: () => async ({ task, sessionDir, onProgress }) => {
        if (task.label === "live-scout") {
          const sf = join(sessionDir!, `${task.id}.jsonl`);
          writeValidSessionJsonl(sf, workDir);
          onProgress({ state: "running", outputStarted: true, sessionFile: sf });
          await liveGate;
          return { state: "done", output: "Live done", turns: 1, usage: emptyUsage() };
        }
        if (!task.sessionFile && sessionDir) {
          const sf = join(sessionDir, `${task.id}.jsonl`);
          writeValidSessionJsonl(sf, workDir, ["scout prompt", "scout findings"]);
          onProgress({ state: "running", outputStarted: true, sessionFile: sf });
          seenSessionFiles.push(sf);
          return { state: "done", output: "Scout complete", turns: 1, usage: emptyUsage() };
        }
        seenSessionFiles.push(task.sessionFile ?? "");
        onProgress({ state: "running", outputStarted: true });
        return { state: "done", output: "Forked follow-up complete", turns: 1, usage: emptyUsage() };
      },
    });

    try {
      const first = await h.dispatch({
        goal: "Scout first",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for forkFrom source run",
        tasks: [{ label: "scout", task: "Investigate" }],
      });
      const srcRunId = first.details.run.runId as string;
      const srcTaskId = first.details.run.tasks[0].taskId as string;

      const second = await h.dispatch({
        goal: "Forked follow-up",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for forkFrom child run",
        tasks: [{ label: "followup", task: "Act on findings", forkFrom: { runId: srcRunId, taskId: srcTaskId } }],
      });
      expect(second.details.run.state).toBe("done");
      expect(second.details.run.tasks[0].forkFrom).toEqual({ runId: srcRunId, taskId: srcTaskId });
      expect(seenSessionFiles).toHaveLength(2);
      expect(seenSessionFiles[1]).not.toBe(seenSessionFiles[0]);
      expect(existsSync(seenSessionFiles[1])).toBe(true);

      // Refuses forking a still-running task!
      const liveRun = await h.dispatch({
        goal: "Live scout",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for live fork refusal",
        background: true,
        tasks: [{ label: "live-scout", task: "Still running" }],
      });
      await expect(h.dispatch({
        goal: "Fork live",
        model: "provider-a/model-1",
        routeReason: "Explicit test route for live fork refusal",
        tasks: [{ label: "bad-live", task: "Act", forkFrom: { runId: liveRun.details.run.runId, taskId: liveRun.details.run.tasks[0].taskId } }],
      })).rejects.toThrow(/wait for it to settle before forking/);
      releaseLive();
      await h.hub({ action: "wait", runId: liveRun.details.run.runId, mode: "all" });

      // Cleans up forked JSONL file if coordinator.start throws (workspace: "worktree" outside git).
      const sessDirPath = join(seenSessionFiles[0], "..");
      const beforeCount = readdirSync(sessDirPath).length;
      await expect(h.dispatch({
        goal: "Fork then fail start",
        model: "provider-a/model-1",
        workspace: "worktree",
        routeReason: "Explicit test route for fork cleanup on start error",
        tasks: [{ label: "fail-start", task: "Act", forkFrom: { runId: srcRunId, taskId: srcTaskId } }],
      })).rejects.toThrow(/requires a git repository/);
      expect(readdirSync(sessDirPath).length).toBe(beforeCount);

      // Cross-session isolation: a second session cannot see or fork first session's run.
      const otherSession = createFakeExtensionHarness({
        cwd: workDir,
        checkpointRoot: h.cpRoot,
        sessionId: "00000000-0000-4000-8000-000000000002",
      });
      try {
        await expect(otherSession.dispatch({
          goal: "Cross session fork",
          model: "provider-a/model-1",
          routeReason: "Explicit test route for cross-session fork refusal",
          tasks: [{ label: "steal", task: "Act", forkFrom: { runId: srcRunId, taskId: srcTaskId } }],
        })).rejects.toThrow(/was not found in this session/);
      } finally {
        await otherSession.shutdown();
      }
    } finally {
      await h.shutdown();
    }
  });
});

describe("B6: dsh-worker session continuity, stall watchdog, deterministic diagnoseRun and render", () => {
  it("passes --session-id, captures/resumes dshSessionId with stall watchdog, and fails closed on mismatched resumed sessionId", async () => {
    const model = makeModel("provider-a", "model-1");
    expect(dshWorkerArgs(model, {}, "medium", rootTmp, "dsh-sess-42")).toContain("--session-id");
    expect(dshWorkerArgs(model, {}, "medium", rootTmp, "dsh-sess-42")).toContain("dsh-sess-42");
    expect(() => dshWorkerArgs(model, {}, "medium", rootTmp, "--bad")).toThrow(/safe non-empty identifier/);

    const fakeSpawn: DshSpawn = ({ args }) => {
      const sidIdx = args.indexOf("--session-id");
      const resumedSid = sidIdx >= 0 ? args[sidIdx + 1] : null;
      let stdoutCb: ((chunk: string) => void) | undefined;
      let exitCb: ((code: number | null, sig: string | null) => void) | undefined;
      let stdin = "";
      let exited = false;
      const emit = (obj: unknown) => stdoutCb?.(JSON.stringify(obj) + "\n");
      const exitNow = (code: number | null, sig: string | null) => {
        if (exited) return;
        exited = true;
        exitCb?.(code, sig);
      };
      return {
        pid: 4242,
        onStdout(cb) { stdoutCb = cb; },
        onStderr() {},
        onError() {},
        onExit(cb) { exitCb = cb; },
        writeStdin(chunk) { stdin += chunk; },
        endStdin() {
          queueMicrotask(() => {
            if (resumedSid === "mismatch-trigger") {
              emit({ type: "session", sessionId: "brand-new-sid", cwd: rootTmp });
              return;
            }
            if (!resumedSid) {
              emit({ type: "session", sessionId: "dsh-sess-99", cwd: rootTmp });
              emit({ type: "status", phase: "step_start", turn: 1, step: 1 });
              // Remain silent so the idle-stream stall watchdog fires cleanly.
              return;
            }
            const hasObjective = stdin.includes("Do work");
            emit({ type: "session", sessionId: resumedSid, cwd: rootTmp });
            emit({ type: "status", phase: "step_start", turn: 1, step: 1 });
            emit({ type: "text", text: `Resumed ${resumedSid} objective=${hasObjective}` });
            emit({ type: "final", sessionId: resumedSid, reason: { kind: "completed" }, text: `Resumed ${resumedSid} objective=${hasObjective}` });
            exitNow(0, null);
          });
        },
        kill(sig) {
          exitNow(null, sig ?? "SIGTERM");
          return true;
        },
      };
    };

    const dshRunner = createDshWorkerRunner({
      executable: "/fake/steak-dsh",
      spawn: fakeSpawn,
      stallMs: 60,
      abortGraceMs: 30,
      resolveRuntime: () => ({
        model,
        thinkingLevel: "medium",
        dsh: { resolveAuth: async () => ({ ok: true as const, apiKey: "test-key" }), isUsingOAuth: () => false },
      }),
    });

    const dshRun = makeRun({ id: "run-dsh-b6", harness: "steak-dsh", model: "steak-dsh/provider-a/model-1" });
    const observedSids: string[] = [];
    const firstResult = await dshRunner({
      run: dshRun,
      task: dshRun.tasks[0],
      signal: new AbortController().signal,
      onProgress: (p) => { if (p.dshSessionId) observedSids.push(p.dshSessionId); },
    });
    expect(firstResult.state).toBe("failed");
    expect(firstResult.error).toMatch(/No model or tool activity/);
    expect(classifyFailure(firstResult.error)).toBe("stalled-stream");
    expect(transientFailure(firstResult.error, 0)?.reason).toBe("provider stream stalled");
    expect(observedSids).toEqual(["dsh-sess-99"]);
    expect(dshRun.tasks[0].dshSessionId).toBe("dsh-sess-99");

    // Resuming with matching dshSessionId completes and includes leaf objective reminder.
    const resumedResult = await dshRunner({
      run: dshRun,
      task: dshRun.tasks[0],
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    expect(resumedResult.state).toBe("done");
    expect(resumedResult.output).toContain("Resumed dsh-sess-99 objective=true");

    // Resuming when CLI reports a mismatched sessionId fails closed!
    const mismatchRun = makeRun({ id: "run-dsh-mismatch", harness: "steak-dsh", model: "steak-dsh/provider-a/model-1" });
    mismatchRun.tasks[0].dshSessionId = "mismatch-trigger";
    const mismatchRes = await dshRunner({
      run: mismatchRun,
      task: mismatchRun.tasks[0],
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    expect(mismatchRes.state).toBe("failed");
    expect(mismatchRes.error).toMatch(/did not resume requested session mismatch-trigger/);
  });

  it("supports end-to-end hub resume for steak-dsh when dshSessionId was captured", async () => {
    const workDir = join(rootTmp, "b6-dsh-hub-resume-cwd");
    mkdirSync(workDir, { recursive: true });
    const fakeBin = join(rootTmp, "fake-dsh-bin-resume");
    writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeBin, 0o755);
    vi.stubEnv("STEAK_DSH_BIN", fakeBin);
    setRoutingConfigOverride({
      subscriptionRouteChecks: [{ provider: "provider-a", host: "provider-a.example", pathPattern: "^/v1/?$" }],
    });

    const seenDshSids: Array<string | undefined> = [];
    const h = createFakeExtensionHarness({
      cwd: workDir,
      runner: () => async ({ task, onProgress }) => {
        seenDshSids.push(task.dshSessionId);
        if (!task.dshSessionId) {
          onProgress({ state: "running", outputStarted: true, dshSessionId: "dsh-hub-77" });
          return { state: "failed", output: "", error: "interrupted after partial work", turns: 1, usage: emptyUsage() };
        }
        onProgress({ state: "running", outputStarted: true });
        return { state: "done", output: `DSH hub resumed ${task.dshSessionId}`, turns: 1, usage: emptyUsage() };
      },
    });
    try {
      const first = await h.dispatch({
        goal: "DSH hub resume test",
        harness: "steak-dsh",
        model: "steak-dsh/provider-a/model-1",
        routeReason: "Explicit test route for steak-dsh hub resume",
        tasks: [{ label: "dsh-leaf", task: "Inspect" }],
      });
      const runId = first.details.run.runId as string;
      // Model override on steak-dsh resume is still refused (Pi-only)!
      await expect(h.hub({ action: "resume", runId, model: "provider-b/model-2" }))
        .rejects.toThrow(/supported only for native Pi checkpoints/);

      const resumed = await h.hub({ action: "resume", runId });
      const waited = await h.hub({ action: "wait", runId: resumed.details.run.runId, mode: "all" });
      expect(waited.details.run.state).toBe("done");
      expect(waited.details.run.tasks[0].output).toContain("DSH hub resumed dsh-hub-77");
      expect(seenDshSids).toEqual([undefined, "dsh-hub-77"]);
    } finally {
      await h.shutdown();
    }
  });

  it("pauses dsh stall watchdog while an active tool_call is executing", async () => {
    const model = makeModel("provider-a", "model-1");
    const fakeToolSpawn: DshSpawn = () => {
      let stdoutCb: ((chunk: string) => void) | undefined;
      let exitCb: ((code: number | null, sig: string | null) => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const emit = (obj: unknown) => stdoutCb?.(JSON.stringify(obj) + "\n");
      return {
        pid: 4243,
        onStdout(cb) { stdoutCb = cb; },
        onStderr() {},
        onError() {},
        onExit(cb) { exitCb = cb; },
        writeStdin() {},
        endStdin() {
          queueMicrotask(() => {
            emit({ type: "session", sessionId: "dsh-tool-1", cwd: rootTmp });
            emit({ type: "tool_call", callId: "c1", tool: "bash", input: { command: "sleep" } });
            timer = setTimeout(() => {
              emit({ type: "tool_result", callId: "c1", status: "completed", result: "ok" });
              emit({ type: "final", sessionId: "dsh-tool-1", reason: { kind: "completed" }, text: "Finished slow tool" });
              exitCb?.(0, null);
            }, 150);
          });
        },
        kill(sig) {
          if (timer) clearTimeout(timer);
          exitCb?.(null, sig ?? "SIGTERM");
          return true;
        },
      };
    };

    const dshRunner = createDshWorkerRunner({
      executable: "/fake/steak-dsh",
      spawn: fakeToolSpawn,
      stallMs: 50,
      abortGraceMs: 30,
      resolveRuntime: () => ({
        model,
        thinkingLevel: "medium",
        dsh: { resolveAuth: async () => ({ ok: true as const, apiKey: "test-key" }), isUsingOAuth: () => false },
      }),
    });
    const dshRun = makeRun({ id: "run-dsh-tool", harness: "steak-dsh", model: "steak-dsh/provider-a/model-1" });
    const result = await dshRunner({ run: dshRun, task: dshRun.tasks[0], signal: new AbortController().signal, onProgress: () => {} });
    expect(result.state).toBe("done");
    expect(result.output).toContain("Finished slow tool");
  });

  it("reports deterministic stall diagnostics in diagnoseRun and renders latest hop (>4 hops), worktrees, and DAG compactly", () => {
    const run = makeRun({ id: "run-diag-1", createdAt: 1_000 }, [
      {
        id: "run-diag-1-task-1",
        label: "author",
        task: "write",
        role: "worker",
        mayEdit: true,
        ownedPaths: [join(rootTmp, "a.ts")],
        allowBash: false,
        state: "running",
        startedAt: 1_000,
        lastProgressAt: 1_000,
        output: "",
        turns: 2,
        usage: emptyUsage(),
        relaySent: 0,
        relayReceived: 0,
        truncated: false,
        dshSessionId: "dsh-123",
        routeFallbacks: [
          "provider-a/m1->provider-b/m2",
          "provider-b/m2->provider-c/m3",
          "provider-c/m3->provider-d/m4",
          "provider-d/m4->provider-e/m5",
          "provider-e/m5->provider-f/m6",
        ],
        worktree: { worktreePath: "/cache/wt/1", branch: "usap/run-diag-1/task-1", baseCommit: "abc1234", dirty: true, committed: false, cleaned: false },
      },
      {
        id: "run-diag-1-task-2",
        label: "verifier",
        task: "verify",
        role: "reviewer",
        mayEdit: false,
        ownedPaths: [],
        allowBash: false,
        dependsOn: ["run-diag-1-task-1"],
        state: "queued",
        output: "",
        turns: 0,
        usage: emptyUsage(),
        relaySent: 0,
        relayReceived: 0,
        truncated: false,
      },
    ]);

    const diag = diagnoseRun(run, 200_000, {
      staleThresholdMs: 60_000,
      unansweredRequests: [{ id: "run-diag-1:4", seq: 4, from: "run-diag-1-task-1", to: "parent", ageMs: 30_000 }],
    });
    expect(diag.stalledTasks).toHaveLength(1);
    expect(diag.stalledTasks[0]).toMatchObject({ taskId: "run-diag-1-task-1", label: "author", silentMs: 199_000 });
    expect(diag.unansweredRequests).toHaveLength(1);
    expect(diag.unansweredRequests[0].seq).toBe(4);
    expect(diag.awaitingDependencies).toHaveLength(1);
    expect(diag.awaitingDependencies[0].waitingOn[0].label).toBe("author");
    expect(diag.tasks[0].checkpoint).toBe(true);
    expect(diag.tasks[1].reason).toBe("awaiting_dependencies");

    const progress = renderRunProgress(run);
    expect(progress).toContain("5 route hops");
    expect(progress).toContain("1 worktree");
    expect(progress).toContain("1 awaiting deps");

    // Shows LATEST hop (>4 hops)!
    const rendered = renderSubagentResult({ details: { run } }, { expanded: false }).render(100).join("\n");
    expect(rendered).toContain("hop provider-e/m5->provider-f/m6");
    expect(rendered).toContain("wt usap/run-diag-1/task-1 (dirty)");
    expect(rendered).toContain("awaiting author");

    const subagentProps = (ultratermSubagentsSchema as any).properties;
    expect(subagentProps.workspace).toBeDefined();
    expect(subagentProps.tasks.items.properties.dependsOn).toBeDefined();
    expect(subagentProps.tasks.items.properties.forkFrom).toBeDefined();
    const hubProps = (ultratermHubSchema as any).properties;
    expect(hubProps.seqs).toBeDefined();
    expect(hubProps.model).toBeDefined();
  });
});

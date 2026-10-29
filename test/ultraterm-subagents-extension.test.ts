import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { RetiredModelSelectionError } from "../src/retired-model-selection.ts";
import { CheckpointStore } from "../src/subagents/checkpoints.ts";
import { normalizeDispatch } from "../src/subagents/policy.ts";
import { BUILTIN_WORKER_PROFILES, claudeCodeModelOf, resolveClaudeCodeSelection, retiredRouteError } from "../src/subagents/model-selection.ts";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GO_ACCOUNT_ROUTER_TIMEOUT_MS, isolatedCodexAgentDir, isolatedAgentPaths } from "../src/subagents/provider-accounts.ts";
import { createPiWorkerRunner } from "../src/subagents/pi-worker.ts";
import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STARTUP_WINDOW_MS,
  createUltratermSubagentsExtension,
  renderRunProgress,
  renderRunResult,
  renderSessionStatus,
  toRunView,
  ultratermSubagentsSchema,
  usapTelemetrySnapshot,
  type UltratermSubagentsDependencies,
} from "../extensions/ultraterm-subagents.ts";
import type { RelayBroker } from "../src/subagents/relay.ts";
import { emptyUsage, type UsageTotals, type WorkerRunner, type TaskRecord } from "../src/subagents/types.ts";

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

function harness(runnerFactory: (relay: RelayBroker) => WorkerRunner, durable?: { root: string; parent: string; prefix: string }, shutdownGraceMs?: number, overrides: Partial<UltratermSubagentsDependencies> = {}) {
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
    // Legacy runners here hang without ever reporting a first turn; the startup window has its own tests.
    startupWindowMs: 0,
    ...overrides,
  })(pi);
  const cwd = mkdtempSync(join(tmpdir(), "steak-usap-extension-"));
  dirs.push(cwd);
  const model = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] };
  const ctx = {
    cwd,
    model,
    modelRegistry: {
      isUsingOAuth: (candidate: { provider: string }) => candidate.provider === "openai-codex",
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
      getProvider: () => ({ streamSimple() {} }),
      find: () => model,
    },
    thinkingLevel: "high",
    sessionManager: { getSessionFile: () => durable?.parent, getSessionId: () => durable?.parent ?? cwd, getEntries: () => messages.map(({ message }) => ({ type: "custom_message", ...message })) },
    ui: { setStatus(_key: string, value: string | undefined) { statuses.push(value); } },
  } as any;
  return { tools, handlers, messages, statuses, entries, ctx, pi };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function syntheticClaudeSelection(account: "primary" | "b") {
  const configDir = join(homedir(), account === "primary" ? ".claude" : ".claude-b");
  return {
    ok: true,
    provider: "claude",
    account: {
      id: account, label: account === "primary" ? "Claude 1" : "Claude 2", eligible: true, configDir,
      launchEnv: account === "primary" ? { unset: ["CLAUDE_CONFIG_DIR"] } : { set: { CLAUDE_CONFIG_DIR: configDir } },
      // Synthetic private fields must never leak into the public run/result.
      email: "synthetic-claude@example.invalid", orgId: "synthetic-private-org", accessToken: "synthetic-private-token",
    },
  };
}

function syntheticClaudeReceipt(account: "primary" | "b"): NonNullable<TaskRecord["subscriptionReceipt"]> {
  return {
    kind: "claude-subscription", account, configMode: account === "primary" ? "default" : "explicit",
    ...(account === "b" ? { configDir: join(homedir(), ".claude-b") } : {}),
    identityHash: (account === "primary" ? "a" : "b").repeat(64), subscriptionType: "max",
    attested: { preflight: true, init: true },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("UltraTerm Subagent Protocol Pi extension", () => {
  describe("synthetic task-scoped Claude account dispatch", () => {
    it("exposes only the primary and b account IDs as an optional schema enum", () => {
      expect(ultratermSubagentsSchema.properties.claudeAccount).toMatchObject({ type: "string", enum: ["primary", "b"] });
      expect(ultratermSubagentsSchema.required ?? []).not.toContain("claudeAccount");
    });

    describe.each(["primary", "b"] as const)("selected account %s", (account) => {
      it.each([
        { selector: { harness: "claude-code" }, role: "worker", model: "claude-code/claude-sonnet-5-5" },
        { selector: { harness: "claude-code" }, role: "reviewer", model: "claude-code/claude-opus-5-5" },
        { selector: { model: "claude-code/claude-sonnet-5-5" }, role: "reviewer", model: "claude-code/claude-sonnet-5-5" },
        { selector: { model: "claude-code/claude-opus-5-5" }, role: "reviewer", model: "claude-code/claude-opus-5-5" },
        { selector: { harness: "claude-code", model: "claude-code/claude-opus-5-5" }, role: "worker", model: "claude-code/claude-opus-5-5" },
      ])("propagates through the coordinator and public receipt without automatic fallback: %j", async ({ selector, role, model }) => {
        const receipt = syntheticClaudeReceipt(account);
        const runner = vi.fn(async (_context: Parameters<WorkerRunner>[0]) => ({ state: "done" as const, output: "synthetic review", turns: 1, usage: emptyUsage(), subscriptionReceipt: receipt }));
        const accountCommand = vi.fn(async (args: string[]) => args[0] === "status"
          ? { ok: true, providers: { claude: { accounts: [{ eligible: false }] } } }
          : syntheticClaudeSelection(account));
        const h = harness(() => runner, undefined, undefined, { accountCommand });
        const find = vi.fn(() => { throw new Error("selected Claude must not consult the Pi registry"); });
        h.ctx.modelRegistry.find = find;
        try {
          const result = await h.tools.get("ultraterm_subagents").execute("account", {
            goal: "Synthetic account selection", claudeAccount: account, ...selector,
            tasks: [{ label: "Selected leaf", task: "Inspect synthetic evidence", role }],
          }, undefined, undefined, h.ctx);
          expect(result.isError).not.toBe(true);
          expect(runner).toHaveBeenCalledTimes(1);
          expect(runner.mock.calls[0][0].run).toMatchObject({ claudeAccount: account, harness: "claude-code", model, thinkingLevel: "xhigh" });
          expect(result.details.run).toMatchObject({ claudeAccount: account, harness: "claude-code", model, thinkingLevel: "xhigh", tasks: [{ subscriptionReceipt: receipt }] });
          expect(result.details.run.tasks[0].reviewFallback).toBeUndefined();
          expect(result.details.run.selection.source).not.toBe("automatic-review-fallback");
          // A status response proving no eligible accounts must not override an explicit selection.
          expect(accountCommand.mock.calls).toEqual([[["select", "--provider", "claude", "--account", account]]]);
          expect(find).not.toHaveBeenCalled();
          expect(result.content[0].text).toContain(`Claude subscription: ${account}; namespace=${receipt.configMode}; identity=${receipt.identityHash}; preflight=verified; init=verified`);
          for (const raw of ["synthetic-claude@example.invalid", "synthetic-private-org", "synthetic-private-token"]) {
            expect(JSON.stringify(result)).not.toContain(raw);
          }
          result.details.run.tasks[0].subscriptionReceipt.attested.init = false;
          const status = await h.tools.get("ultraterm_hub").execute("status", { action: "status", runId: result.details.run.runId }, undefined, undefined, h.ctx);
          expect(status.details.run).toMatchObject({ claudeAccount: account, tasks: [{ subscriptionReceipt: receipt }] });
          expect(status.details.run.tasks[0].subscriptionReceipt.attested.init).toBe(true);
        } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
      });
    });

    it.each([
      { claudeAccount: "unknown", harness: "claude-code" },
      { claudeAccount: "../b", harness: "claude-code" },
      { claudeAccount: "~/.claude-b", harness: "claude-code" },
      { claudeAccount: join(homedir(), ".claude-b"), harness: "claude-code" },
      { claudeAccount: "", harness: "claude-code" },
      { claudeAccount: "PRIMARY", harness: "claude-code" },
      { claudeAccount: "b" },
      { claudeAccount: "b", harness: "pi" },
      { claudeAccount: "b", model: "openai-codex/gpt-6.1-sol" },
      { claudeAccount: "b", harness: "claude-code", model: "openai-codex/gpt-6.1-sol" },
      { claudeAccount: "b", model: "claude-code-api/claude-sonnet-5-5" },
      { claudeAccount: "b", harness: "claude-code", model: "claude-code-api/claude-opus-5-5" },
      { claudeAccount: "b", model: "anthropic/claude-opus-5-5" },
      { claudeAccount: "b", harness: "claude-code", profile: "steak-claude-code/claude-opus-5-5" },
      { claudeAccount: "b", profile: "steak-pi/gpt-6-1-sol" },
      { claudeAccount: "b", model: "claude-opus-5-5" },
      { claudeAccount: "b", model: "claude-code/claude-opus-5-5/" },
      { claudeAccount: "b", model: "CLAUDE-CODE/claude-sonnet-5-5" },
    ])("rejects invalid account/route inputs before checkpoints or start: %j", async (selector) => {
      const root = mkdtempSync(join(tmpdir(), "usap-account-input-")); dirs.push(root);
      const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "account-input" };
      const runner = vi.fn(async () => ({ state: "done" as const, output: "unexpected", turns: 1, usage: emptyUsage() }));
      const accountCommand = vi.fn(async () => syntheticClaudeSelection("b"));
      const h = harness(() => runner, durable, undefined, { accountCommand });
      const save = vi.spyOn(CheckpointStore.prototype, "save");
      try {
        await expect(h.tools.get("ultraterm_subagents").execute("invalid", {
          goal: "Refuse before startup", ...selector, tasks: [{ label: "Read review", task: "Inspect", role: "reviewer" }],
        }, undefined, undefined, h.ctx)).rejects.toThrow(/Unknown Claude account ID|claudeAccount requires an explicit Claude subscription/);
        expect(accountCommand).not.toHaveBeenCalled();
        expect(runner).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        const list = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
        expect(list.details.runs).toEqual([]);
        expect(h.entries).toEqual([]);
        expect(h.messages).toEqual([]);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); save.mockRestore(); }
    });

    it.each(["refused", "unavailable", "malformed"] as const)("router %s fails closed with no checkpoint, default-account start or Sol fallback", async (failure) => {
      const root = mkdtempSync(join(tmpdir(), "usap-account-router-")); dirs.push(root);
      const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "account-router" };
      const runner = vi.fn(async () => ({ state: "done" as const, output: "unexpected", turns: 1, usage: emptyUsage() }));
      const accountCommand = vi.fn(async (_args: string[]) => {
        if (failure === "unavailable") throw new Error("synthetic router unavailable");
        if (failure === "refused") return { ok: false, reason: "unavailable" };
        return { ...syntheticClaudeSelection("b"), account: { ...syntheticClaudeSelection("b").account, launchEnv: { set: { CLAUDE_CONFIG_DIR: join(homedir(), ".claude") } } } };
      });
      const h = harness(() => runner, durable, undefined, { accountCommand });
      const save = vi.spyOn(CheckpointStore.prototype, "save");
      try {
        await expect(h.tools.get("ultraterm_subagents").execute("refused", {
          goal: "No selected account fallback", claudeAccount: "b", harness: "claude-code",
          tasks: [{ label: "Read review", task: "Inspect", role: "reviewer" }],
        }, undefined, undefined, h.ctx)).rejects.toThrow(/Unsafe Claude provider account selection|synthetic router unavailable/);
        expect(accountCommand.mock.calls).toEqual([[["select", "--provider", "claude", "--account", "b"]]]);
        expect(runner).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
        const list = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
        expect(list.details.runs).toEqual([]);
        expect(h.entries).toEqual([]);
        expect(h.messages).toEqual([]);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); save.mockRestore(); }
    });

    it("exposes a selected subscription receipt from worker progress before final settlement", async () => {
      const receipt = syntheticClaudeReceipt("b");
      let finish!: () => void;
      let progress!: Parameters<WorkerRunner>[0]["onProgress"];
      const pending = new Promise<void>((resolve) => { finish = resolve; });
      const accountCommand = vi.fn(async () => syntheticClaudeSelection("b"));
      const h = harness(() => async ({ onProgress }) => {
        progress = onProgress;
        onProgress({ subscriptionReceipt: { ...receipt, attested: { preflight: true, init: false } } });
        await pending;
        return { state: "done", output: "synthetic attested report", turns: 1, usage: emptyUsage(), subscriptionReceipt: receipt };
      }, undefined, undefined, { accountCommand });
      try {
        const started = await h.tools.get("ultraterm_subagents").execute("background", {
          goal: "Expose preflight evidence", claudeAccount: "b", harness: "claude-code", background: true,
          tasks: [{ label: "Progress leaf", task: "Inspect", role: "reviewer" }],
        }, undefined, undefined, h.ctx);
        await vi.waitFor(() => expect(progress).toBeDefined());
        const runId = started.details.run.runId;
        const status = await h.tools.get("ultraterm_hub").execute("status", { action: "status", runId }, undefined, undefined, h.ctx);
        expect(status.details.run).toMatchObject({ claudeAccount: "b", tasks: [{ subscriptionReceipt: { ...receipt, attested: { preflight: true, init: false } } }] });
        expect(status.content[0].text).toContain("preflight=verified; init=unverified");
        finish();
        const done = await h.tools.get("ultraterm_hub").execute("wait", { action: "wait", runId, mode: "all", timeoutMs: 1000 }, undefined, undefined, h.ctx);
        expect(done.details.run.tasks[0].subscriptionReceipt).toEqual(receipt);
        expect(done.content[0].text).toContain("preflight=verified; init=verified");
        expect(JSON.stringify(done)).not.toMatch(/synthetic-claude@example\.invalid|synthetic-private-org|synthetic-private-token/);
      } finally { finish(); await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });
  });

  it.each([false, true])("synthetic: rejects a later Claude bracket path before any startup (background=%s)", async (background) => {
    const root = mkdtempSync(join(tmpdir(), "usap-owned-path-preflight-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "owned-path-preflight" };
    const runner = vi.fn(async () => ({ state: "done" as const, output: "unexpected", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner, durable);
    const save = vi.spyOn(CheckpointStore.prototype, "save");
    try {
      const result = await h.tools.get("ultraterm_subagents").execute("invalid", {
        goal: "Validate the whole wave", harness: "claude-code", background,
        tasks: [
          { label: "Safe leaf", task: "Edit safe file", mayEdit: true, ownedPaths: ["safe.ts"] },
          { label: "Astro leaf", task: "Edit route", mayEdit: true, ownedPaths: ["src/pages/[slug].astro"] },
        ],
      }, undefined, undefined, h.ctx);
      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain("Dispatch validation failed");
      expect(text).toContain("tasks[1].ownedPaths[0]");
      expect(text).toContain("Astro leaf");
      expect(text).toContain('metacharacter "["');
      expect(text).not.toContain("Started USAP run");
      expect(runner).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      const listed = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
      expect(listed.details.runs).toEqual([]);
      expect(h.messages).toEqual([]);
      expect(h.entries).toEqual([]);
    } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); save.mockRestore(); }
  });

  const claudeUnavailable = () => vi.fn(async () => ({ ok: true, providers: { claude: { accounts: [{ eligible: false }] } } }));

  it.each([false, true])("synthetic: unavailable Claude cannot reroute an implicit mutating bracket review (background=%s)", async (background) => {
    const root = mkdtempSync(join(tmpdir(), "usap-review-owned-path-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "review-owned-path" };
    const runner = vi.fn(async () => ({ state: "done" as const, output: "unexpected", turns: 1, usage: emptyUsage() }));
    const accountCommand = claudeUnavailable();
    const h = harness(() => runner, durable, undefined, { accountCommand });
    const save = vi.spyOn(CheckpointStore.prototype, "save");
    try {
      const result = await h.tools.get("ultraterm_subagents").execute("invalid", {
        goal: "Keep exact ownership", background,
        tasks: [{ label: "Mutating review", task: "Edit route", role: "reviewer", mayEdit: true, ownedPaths: ["src/pages/[slug].astro"] }],
      }, undefined, undefined, h.ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('metacharacter "["');
      expect(result.content[0].text).not.toContain("Started USAP run");
      expect(accountCommand).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(h.entries).toEqual([]);
      expect(h.messages).toEqual([]);
    } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); save.mockRestore(); }
  });

  it.each([
    { mayEdit: true, ownedPaths: ["safe.ts"] },
    { allowBash: true },
  ])("synthetic: an implicit privileged reviewer keeps its Claude route when no account is eligible: %j", async (permissions) => {
    const runner = vi.fn(async () => ({ state: "done" as const, output: "fixture", turns: 1, usage: emptyUsage() }));
    const accountCommand = claudeUnavailable();
    const h = harness(() => runner, undefined, undefined, { accountCommand });
    try {
      const result = await h.tools.get("ultraterm_subagents").execute("privileged", {
        goal: "Keep harness enforcement", tasks: [{ label: "Privileged review", task: "Review", role: "reviewer", ...permissions }],
      }, undefined, undefined, h.ctx);
      expect(result.details.run.harness).toBe("claude-code");
      expect(claudeCodeModelOf(result.details.run.model)).toBeDefined();
      expect(result.details.run.selection).toMatchObject({ provider: "claude-code", source: "automatic-review" });
      expect(result.details.run.tasks[0].reviewFallback).toBeUndefined();
      expect(accountCommand).not.toHaveBeenCalled();
      expect(runner).toHaveBeenCalledTimes(1);
    } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
  });

  it("synthetic: an implicit read-only review still falls back to Sol when no Claude account is eligible", async () => {
    const runner = vi.fn(async () => ({ state: "done" as const, output: "fixture", turns: 1, usage: emptyUsage() }));
    const accountCommand = claudeUnavailable();
    const h = harness(() => runner, undefined, undefined, { accountCommand });
    try {
      const result = await h.tools.get("ultraterm_subagents").execute("readonly", {
        goal: "Read-only fallback", tasks: [{ label: "Read review", task: "Inspect", role: "reviewer" }],
      }, undefined, undefined, h.ctx);
      expect(result.details.run.model).toBe("openai-codex/gpt-6.1-sol");
      expect(result.details.run.harness ?? "pi").toBe("pi");
      expect(result.details.run.selection.source).toBe("automatic-review-fallback");
      expect(accountCommand).toHaveBeenCalled();
      expect(runner).toHaveBeenCalledTimes(1);
    } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
  });

  it("exposes independent current and last launch queue snapshots in run/status views", () => {
    const run = normalizeDispatch({ goal: "queue metadata", tasks: [{ label: "review", task: "bounded review", role: "reviewer" }] }, process.cwd(), "claude-code/claude-opus-5-5", "xhigh", 1_000, () => "queue-view");
    expect(toRunView(run).tasks[0]).not.toHaveProperty("launchQueue");
    expect(toRunView(run).tasks[0]).not.toHaveProperty("lastLaunchQueue");
    run.tasks[0].state = "starting";
    run.tasks[0].launchQueue = { tier: "machine", provider: "anthropic", reason: "provider_capacity", since: 1_000, deadlineAt: 5_000,
      capacity: { provider: "anthropic", providerBucket: { cap: 1, held: 1, owners: [{ index: 0, pid: 123, kind: "lease", status: "live" }] }, globalBucket: { cap: 2, held: 0, owners: [] } } };
    run.tasks[0].lastLaunchQueue = { tier: "session", provider: "anthropic", reason: "session_capacity", since: 500, deadlineAt: 4_500 };
    const task = toRunView(run).tasks[0];
    expect(task).toMatchObject({ launchQueue: run.tasks[0].launchQueue, lastLaunchQueue: run.tasks[0].lastLaunchQueue });
    task.launchQueue!.capacity!.providerBucket.owners[0].pid = 999;
    task.lastLaunchQueue!.reason = "changed";
    expect(run.tasks[0].launchQueue.capacity!.providerBucket.owners[0].pid).toBe(123);
    expect(run.tasks[0].lastLaunchQueue.reason).toBe("session_capacity");
    expect(toRunView(run).tasks[0].launchQueue!.capacity!.providerBucket.owners[0].pid).toBe(123);
  });

  it("renders active launch queue status without worker output and preserves the aggregate bound", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000);
    try {
      const run = normalizeDispatch({ goal: "queue status", tasks: [{ label: "review", task: "bounded review", role: "reviewer" }] }, process.cwd(), "claude-code/claude-opus-5-5", "xhigh", 1_000, () => "queue-status");
      const task = run.tasks[0];
      task.state = "starting";
      task.lastLaunchQueue = { tier: "session", provider: "anthropic", reason: "previous wait", since: 500, deadlineAt: 4_500 };
      expect(renderRunResult(run)).not.toContain("launch queue:");

      task.launchQueue = { tier: "machine", provider: "anthropic", reason: "provider slots unavailable", since: 1_000, deadlineAt: 5_000 };
      const text = renderRunResult(run);
      expect(text).toContain("launch queue: machine/anthropic · provider slots unavailable · 1000ms elapsed");
      expect(text).toContain("(no output)");

      task.launchQueue.since = 3_000;
      expect(renderRunResult(run)).toContain("launch queue: machine/anthropic · provider slots unavailable · 0ms elapsed");
      task.launchQueue.reason = "provider slots unavailable ".repeat(100);
      for (const limit of [0, 1, 64, 256]) {
        expect(renderRunResult(run, limit).length).toBeLessThanOrEqual(limit);
      }
      expect(renderRunResult(run, 256)).toContain("[Aggregate content truncated; complete bounded task outputs remain in details.]");
    } finally {
      clock.mockRestore();
    }
  });

  it("refuses an initial checkpoint failure before worker execution and retries snapshots only", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-initial-health-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "initial-health" };
    const runner = vi.fn(async () => ({ state: "done" as const, output: "fresh", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner, durable);
    const spy = vi.spyOn(CheckpointStore.prototype, "save").mockImplementationOnce(() => { throw Object.assign(new Error("private payload"), { code: "ENOSPC", syscall: "open" }); });
    const dispatch = () => h.tools.get("ultraterm_subagents").execute("d", { goal: "bounded", tasks: [{ label: "fresh", task: "bounded" }] }, undefined, undefined, h.ctx);
    try {
      await expect(dispatch()).rejects.toThrow(/Checkpoint initial failed \(ENOSPC\/open\)/);
      expect(runner).not.toHaveBeenCalled();
      await dispatch();
      const list = await h.tools.get("ultraterm_hub").execute("l", { action: "list" }, undefined, undefined, h.ctx);
      expect(list.details.runs[0].tasks[0]).toMatchObject({ state: "aborted" });
      expect(list.details.checkpointHealth.retainedFailure.first.code).toBe("ENOSPC");
      expect(runner).toHaveBeenCalledTimes(1);
    } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); spy.mockRestore(); }
  });

  it.each(["ENOSPC", "EACCES", "UNKNOWN"])("stops producers on %s, retains done evidence, and validates recovery without replay", async (code) => {
    const root = mkdtempSync(join(tmpdir(), "usap-persistence-health-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: `health-${code}` };
    const originalSave = CheckpointStore.prototype.save;
    let failing = false;
    let directory = "";
    const save = vi.spyOn(CheckpointStore.prototype, "save").mockImplementation(function (this: CheckpointStore, run, force) {
      directory = this.directory;
      if (failing) throw Object.assign(new Error("private-session-payload /secret/token"), { code, syscall: "write" });
      return originalSave.call(this, run, force);
    });
    const runner = vi.fn(async ({ task, onProgress, signal }: Parameters<WorkerRunner>[0]) => {
      if (task.label === "loss") {
        failing = true;
        onProgress({ turns: 1 });
        expect(signal.aborted).toBe(true);
        return { state: "aborted" as const, output: "retained partial", turns: 1, usage: emptyUsage() };
      }
      return { state: "done" as const, output: "retained success", turns: 1, usage: emptyUsage() };
    });
    const h = harness(() => runner, durable);
    const dispatch = (tasks: any[]) => h.tools.get("ultraterm_subagents").execute("d", {
      goal: "checkpoint loss", concurrency: 1, tasks,
    }, undefined, undefined, h.ctx);
    try {
      const result = await dispatch(["done", "loss", "never"].map(label => ({ label, task: "bounded" })));
      const id = result.details.run.runId;
      expect(result.details.run.tasks.map((task: any) => task.state)).toEqual(["done", "aborted", "aborted"]);
      expect(runner.mock.calls.map(([context]) => context.task.label)).toEqual(["done", "loss"]);
      const diagnose = async () => (await h.tools.get("ultraterm_hub").execute("diag", { action: "diagnose", runId: id }, undefined, undefined, h.ctx)).details.diagnostics;
      const failed = await diagnose();
      expect(failed.checkpointHealth.state).toBe("failed");
      expect(failed.checkpointHealth.retainedFailure.first).toMatchObject({ code, syscall: "write", stage: "lifecycle", name: "Error" });
      expect(JSON.stringify(failed.checkpointHealth)).not.toMatch(/private-session-payload|secret|token/);
      await expect(dispatch([{ label: "refused", task: "not launched" }])).rejects.toThrow(/Checkpoint retry failed/);
      expect(runner).toHaveBeenCalledTimes(2);
      failing = false;
      await dispatch([{ label: "fresh", task: "new exact leaf" }]);
      const repaired = await diagnose();
      expect(repaired.checkpointError).toBeNull();
      expect(repaired.checkpointHealth.state).toBe("validated-save");
      expect(repaired.checkpointHealth.retainedFailure.first.code).toBe(code);
      const terminal = JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"));
      expect(terminal.run.state).toBe("aborted");
      expect(terminal.run.tasks[0]).toMatchObject({ state: "done" });
      expect(terminal.run.tasks[0].output).toContain("retained success");
      for (const stopped of terminal.run.tasks.slice(1)) {
        expect(stopped.error).toContain(`Checkpoint lifecycle failed (${code}/write)`);
        expect(stopped.error).not.toMatch(/private-session-payload|secret|token/);
      }
      expect(runner.mock.calls.map(([context]) => context.task.label)).toEqual(["done", "loss", "fresh"]);
      await expect(h.tools.get("ultraterm_hub").execute("resume", { action: "resume", runId: id }, undefined, undefined, h.ctx)).rejects.toThrow(/No native checkpoint/);
      expect(runner).toHaveBeenCalledTimes(3);
    } finally {
      failing = false;
      await h.handlers.get("session_shutdown")!({}, h.ctx);
      save.mockRestore();
    }
  });

  it("synthetic: admits staged native Read-image on both exact Claude routes without consulting Pi", async () => {
    const runner = vi.fn(async (_context: Parameters<WorkerRunner>[0]) => ({ state: "done" as const, output: "fixture review", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner);
    h.ctx.modelRegistry.find = () => { throw new Error("must not query Pi models"); };
    h.ctx.modelRegistry.getAvailable = () => { throw new Error("must not query Pi models"); };
    for (const model of ["claude-code/claude-sonnet-5-5", "claude-code/claude-opus-5-5"]) {
      const result = await h.tools.get("ultraterm_subagents").execute("image", {
        goal: "Inspect staged image", harness: "claude-code", model, requireImages: true,
        tasks: [{ label: "image", task: "Read staged.png", role: "reviewer" }],
      }, undefined, undefined, h.ctx);
      expect(result.details.run.model).toBe(model);
      expect(result.details.run.selection.images).toBe(true);
      expect(runner.mock.calls.at(-1)?.[0].run.selection?.images).toBe(true);
    }
    await expect(h.tools.get("ultraterm_subagents").execute("wrong", {
      goal: "Wrong route", harness: "claude-code", model: "claude-code/claude-sonnet-5-5-other", requireImages: true,
      tasks: [{ label: "image", task: "Read staged.png" }],
    }, undefined, undefined, h.ctx)).rejects.toThrow(/runs only/);
    expect(runner).toHaveBeenCalledTimes(2);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("routes explicit headless Claude and default reviewer waves through the same coordinator without the Pi registry", async () => {
    const runner = vi.fn(async (_context: Parameters<WorkerRunner>[0]) => ({ state: "done" as const, output: "reviewed", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner);
    h.ctx.modelRegistry.find = () => { throw new Error("must not query Pi models"); };
    h.ctx.modelRegistry.getAvailable = () => { throw new Error("must not query Pi models"); };
    for (const route of [{ harness: "claude-code" }, { model: "claude-code/claude-opus-5-5" }, {}]) {
      const result = await h.tools.get("ultraterm_subagents").execute("review", {
        goal: "Opus Pass", ...route, tasks: [{ label: "Review", task: "Read only", role: "reviewer" }],
      }, undefined, undefined, h.ctx);
      expect(result.details.run.harness).toBe("claude-code");
      expect(result.details.run.model).toBe("claude-code/claude-opus-5-5");
      // Only a requested route is `override`; the implicit review wave's route was chosen automatically.
      expect(result.details.run.selection.automaticReview).toBe(Object.keys(route).length === 0 ? true : undefined);
      expect(result.details.run.selection.source).toBe(Object.keys(route).length === 0 ? "automatic-review" : "override");
      expect(runner.mock.calls.at(-1)?.[0].run.thinkingLevel).toBe("xhigh");
      const relay = await h.tools.get("ultraterm_hub").execute("send", { action: "send", runId: result.details.run.runId, to: "#run", body: "not delivered" }, undefined, undefined, h.ctx);
      expect(relay.details.relay.ok).toBe(true);
      const inbox = await h.tools.get("ultraterm_hub").execute("inbox", { action: "inbox", runId: result.details.run.runId }, undefined, undefined, h.ctx);
      expect(inbox.details.relay.messages).toEqual([]);
    }
    expect(runner).toHaveBeenCalledTimes(3);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("requires an explicit route for mixed reviewer waves instead of silently substituting an expert", async () => {
    const runnerFactory = vi.fn((_relay: RelayBroker): WorkerRunner => async () => ({ state: "done" as const, output: "checked", usage: emptyUsage(), turns: 1 }));
    const h = harness(runnerFactory);
    const tasks = [{ label: "Work", task: "Inspect", role: "worker" }, { label: "Review", task: "Review", role: "reviewer" }];
    await expect(h.tools.get("ultraterm_subagents").execute("mixed", { goal: "Mixed", tasks }, undefined, undefined, h.ctx))
      .rejects.toThrow(/split routine workers from the Opus review wave/);
    expect(runnerFactory).not.toHaveBeenCalled();
    for (const route of [{ harness: "pi" }, { model: "openai-codex/gpt-6.1-sol" }]) {
      const result = await h.tools.get("ultraterm_subagents").execute("explicit-mixed", { goal: "Explicit native review", ...route, tasks }, undefined, undefined, h.ctx);
      expect(result.details.run.model).toBe("openai-codex/gpt-6.1-sol");
      expect(result.details.run.harness).not.toBe("claude-code");
      expect(result.details.run.tasks.every((task: any) => task.state === "done")).toBe(true);
    }
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("fails closed for alternate Claude models and effort, and admits owned Claude writes", async () => {
    const runner = vi.fn(async (_context: Parameters<WorkerRunner>[0]) => ({ state: "done" as const, output: "unexpected", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner);
    const base = { goal: "review", harness: "claude-code", tasks: [{ label: "Review", task: "read" }] };
    await expect(h.tools.get("ultraterm_subagents").execute("bad", { ...base, thinking: "medium" }, undefined, undefined, h.ctx)).rejects.toThrow(/xhigh/);
    await expect(h.tools.get("ultraterm_subagents").execute("bad", { ...base, model: "anthropic/claude-opus-5-5" }, undefined, undefined, h.ctx)).rejects.toThrow(/runs only claude-code\/claude-sonnet-5-5 or claude-code\/claude-opus-5-5/);
    expect(runner).not.toHaveBeenCalled();
    const writer = await h.tools.get("ultraterm_subagents").execute("ok", { ...base, tasks: [{ label: "write", task: "write", role: "worker", mayEdit: true, allowBash: true, ownedPaths: [h.ctx.cwd] }] }, undefined, undefined, h.ctx);
    expect(writer.isError).not.toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    const leaf = runner.mock.calls[0][0].task;
    expect(leaf.mayEdit).toBe(true);
    expect(leaf.allowBash).toBe(true);
    expect(leaf.ownedPaths).toHaveLength(1);
    expect(runner.mock.calls[0][0].run.harness).toBe("claude-code");
    // Routine Claude work defaults to Sonnet 5.5 xhigh, which preserves Opus quota.
    expect(writer.details.run.model).toBe("claude-code/claude-sonnet-5-5");
    expect(writer.details.run.selection.modelId).toBe("claude-sonnet-5-5");
    expect(runner.mock.calls[0][0].run.thinkingLevel).toBe("xhigh");
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("runs Sonnet 5.5 for claude-code workers and escalates to Opus 5.5 only for reviews or an explicit Opus route", async () => {
    const runner = vi.fn(async (_context: Parameters<WorkerRunner>[0]) => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner);
    const work = [{ label: "Work", task: "Inspect", role: "worker" }];
    const review = [{ label: "Review", task: "Review", role: "reviewer" }];
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ harness: "claude-code", tasks: work }, "claude-code/claude-sonnet-5-5"],
      [{ model: "claude-code/claude-sonnet-5-5", tasks: work }, "claude-code/claude-sonnet-5-5"],
      [{ harness: "claude-code", tasks: review }, "claude-code/claude-opus-5-5"],
      [{ tasks: review }, "claude-code/claude-opus-5-5"],
      [{ model: "claude-code/claude-opus-5-5", tasks: work }, "claude-code/claude-opus-5-5"],
      [{ harness: "claude-code", model: "claude-code/claude-sonnet-5-5", tasks: review }, "claude-code/claude-sonnet-5-5"],
    ];
    for (const [route, expected] of cases) {
      const result = await h.tools.get("ultraterm_subagents").execute("route", { goal: "route", ...route }, undefined, undefined, h.ctx);
      expect(result.details.run.harness).toBe("claude-code");
      expect(result.details.run.model).toBe(expected);
      expect(runner.mock.calls.at(-1)?.[0].run.model).toBe(expected);
      expect(runner.mock.calls.at(-1)?.[0].run.thinkingLevel).toBe("xhigh");
    }
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });
  it("refuses every foreign-session hub action and dispatch before exposing a run", async () => {
    const runner = vi.fn(async () => ({ state: "done" as const, output: "owner-only evidence", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner);
    const dispatched = await h.tools.get("ultraterm_subagents").execute("a", { goal: "owner A", tasks: [{ label: "A", task: "A" }] }, undefined, undefined, h.ctx);
    const runId = dispatched.details.run.runId;
    const foreign = { ...h.ctx, sessionManager: { getSessionId: () => "foreign-session" } };
    for (const action of ["list", "status", "wait", "cancel", "send", "redirect", "inbox", "resume", "diagnose"]) {
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
      for (const action of ["status", "wait", "cancel", "send", "redirect", "inbox", "resume", "diagnose"]) {
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
      tasks: [{ id: "task-1", label: "Review\nsidebar", role: "reviewer", state: "done", startedAt: 1000, endedAt: 2400,
        task: "PRIVATE PROMPT", output: "PRIVATE OUTPUT", currentTool: "read" }],
    } as unknown as Parameters<typeof usapTelemetrySnapshot>[0];
    const snapshot = usapTelemetrySnapshot(run);
    expect(snapshot.tasks[0]).toEqual({ taskId: "task-1", label: "Review sidebar", role: "reviewer", state: "done", detail: "Finished — ready for parent verification", startedAt: 1000, endedAt: 2400, currentTool: "read", toolErrors: 0, toolSuccesses: 0 });
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

  it("synthetic: starts background work, wakes once, and attributes usage on the first terminal wait only", async () => {
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
    expect(h.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });

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
    const workerModel = { provider: "xiaomi", id: "mimo-v2.6-flash", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", input: ["text", "image"] };
    h.ctx.modelRegistry.find = (provider: string, id: string) => provider === workerModel.provider && id === workerModel.id ? workerModel : undefined;
    h.ctx.modelRegistry.getAvailable = () => [h.ctx.model, workerModel];
    const receipt = await h.tools.get("ultraterm_subagents").execute("call", {
      goal: "explicit MiMo reviewer", model: "xiaomi/mimo-v2.6-flash", requireImages: true,
      tasks: [{ label: "review", task: "review", role: "reviewer" }], background: true,
    }, undefined, undefined, h.ctx);
    const runId = receipt.details.run.runId;
    const result = await h.tools.get("ultraterm_hub").execute("hub", { action: "wait", runId, mode: "all", timeoutMs: 100 }, undefined, undefined, h.ctx);
    expect(result.details.run.model).toBe("xiaomi/mimo-v2.6-flash");
    expect(result.details.run.selection).toMatchObject({ provider: "xiaomi", modelId: "mimo-v2.6-flash", source: "override", images: true, tools: true });
    expect(result.details.run.tasks[0]).toMatchObject({ toolErrors: 0, toolSuccesses: 4 });
    expect(h.entries.at(-1).data.selection.source).toBe("override");
    expect(h.entries.at(-1).data.tasks[0].toolSuccesses).toBe(4);
    expect(result.usage.totalTokens).toBe(10);
  });

  it.each([
    { model: "zai/glm-5.3-flash" },
    { model: "z-ai/glm-5.3" },
    { model: "glm-5.3-flash" },
    { model: "opencode-go/glm-5.3" },
    { profile: "steak-pi/glm-5-3-flash" },
    { profile: "glm-5-3-flash" },
  ])("rejects retired selector %j before invoking any worker", async (selector) => {
    const runner = vi.fn(async () => ({ state: "done" as const, output: "unexpected", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner);
    const route = selector.model ?? selector.profile!;
    await expect(h.tools.get("ultraterm_subagents").execute("retired", {
      goal: "retired route", ...selector, tasks: [{ label: "one", task: "one" }],
    }, undefined, undefined, h.ctx)).rejects.toThrow(retiredRouteError(route));
    expect(runner).not.toHaveBeenCalled();
    const listed = await h.tools.get("ultraterm_hub").execute("hub", { action: "list" }, undefined, undefined, h.ctx);
    expect(listed.details.runs).toEqual([]);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("rejects conflicting selectors before invoking any worker", async () => {
    const runner = vi.fn(async () => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner);
    await expect(h.tools.get("ultraterm_subagents").execute("call", {
      goal: "conflict", model: "openai-codex/gpt-6.1-sol", profile: "steak-pi/mimo-v2-6-flash", tasks: [{ label: "one", task: "one" }],
    }, undefined, undefined, h.ctx)).rejects.toThrow(/conflict/);
    expect(runner).not.toHaveBeenCalled();
    const listed = await h.tools.get("ultraterm_hub").execute("hub", { action: "list" }, undefined, undefined, h.ctx);
    expect(listed.details.runs).toEqual([]);
  });

  it.each([["pi", "send"], ["claude-code", "send"], ["pi", "redirect"], ["claude-code", "redirect"]])("synthetic: binds parent relay identity and correlated replies on %s %s", async (harnessRoute, action) => {
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
      harness: harnessRoute,
      model: harnessRoute === "claude-code" ? "claude-code/claude-sonnet-5-5" : "openai-codex/gpt-6.1-sol",
      background: true,
      tasks: [{ label: "one", task: "one" }],
    }, undefined, undefined, h.ctx);
    await flush();
    const runId = started.details.run.runId;
    const taskId = started.details.run.tasks[0].taskId;
    const sent = await h.tools.get("ultraterm_hub").execute("hub", {
      action, runId, to: taskId, body: "parent fact", kind: "request",
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

  it("synthetic: retries a transient SDK idle boundary without another user turn", async () => {
    vi.useFakeTimers();
    const h = harness(() => async () => ({ state: "done", output: "ready", turns: 1, usage: emptyUsage() }));
    let idle = false;
    await h.handlers.get("session_start")!({}, h.ctx);
    h.ctx.isIdle = () => idle;
    await h.tools.get("ultraterm_subagents").execute("call", { goal: "idle edge", background: true, tasks: [{ label: "one", task: "one" }] }, undefined, undefined, h.ctx);
    await flush();
    expect(h.messages).toHaveLength(0);
    idle = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0].options.triggerTurn).toBe(true);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["admission", "shutdown"])("retains failed durable receipts until both commits recover via %s, without replay", async (recovery) => {
    const root = mkdtempSync(join(tmpdir(), "usap-receipt-health-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: `receipt-${recovery}` };
    const runner = vi.fn<WorkerRunner>(async () => ({ state: "done" as const, output: "retained completion", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner, durable);
    const originalMark = CheckpointStore.prototype.markDelivered;
    let failing = true;
    let directory = "";
    const mark = vi.spyOn(CheckpointStore.prototype, "markDelivered").mockImplementation(function (this: CheckpointStore, id) {
      directory = this.directory;
      if (failing) throw Object.assign(new Error("private-session-payload /secret/token"), { code: "ENOSPC", syscall: "write" });
      return originalMark.call(this, id);
    });
    const dispatch = (label: string, background = false) => h.tools.get("ultraterm_subagents").execute("d", {
      goal: "receipt persistence", background, tasks: [{ label, task: "bounded" }],
    }, undefined, undefined, h.ctx);
    let next: ReturnType<typeof harness> | undefined;
    try {
      const result = await dispatch("completed", true);
      const id = result.details.run.runId;
      await flush();
      const diagnose = async () => (await h.tools.get("ultraterm_hub").execute("diag", { action: "diagnose", runId: id }, undefined, undefined, h.ctx)).details.diagnostics;
      const disk = () => JSON.parse(readFileSync(join(directory, `${id}.json`), "utf8"));
      expect(h.messages).toHaveLength(1);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(disk()).toMatchObject({ delivered: false, run: { state: "done" } });
      const failed = await diagnose();
      expect(failed.checkpointHealth).toMatchObject({ state: "failed", pendingRuns: 1, retainedFailure: {
        first: { code: "ENOSPC", syscall: "write", stage: "receipt" }, count: 1,
      } });
      expect(JSON.stringify(failed.checkpointHealth)).not.toMatch(/private-session-payload|secret|token/);
      await expect(dispatch("refused")).rejects.toThrow(/Checkpoint receipt failed/);
      expect(mark).toHaveBeenCalledTimes(2);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(h.messages).toHaveLength(1);
      const stillFailed = await diagnose();
      expect(stillFailed.checkpointHealth).toMatchObject({ state: "failed", pendingRuns: 1, retainedFailure: { count: 2, latest: { stage: "receipt" } } });
      expect(stillFailed.checkpointError).toMatch(/ENOSPC/);
      expect(disk().delivered).toBe(false);
      failing = false;
      if (recovery === "admission") {
        await dispatch("fresh");
        const repaired = await diagnose();
        expect(repaired.checkpointError).toBeNull();
        expect(repaired.checkpointHealth).toMatchObject({ state: "validated-save", pendingRuns: 0, retainedFailure: {
          first: { code: "ENOSPC", stage: "receipt" }, latest: { code: "ENOSPC", stage: "receipt" }, count: 2,
        } });
        expect(runner.mock.calls.map(([context]) => context.task.label)).toEqual(["completed", "fresh"]);
      }
      await h.handlers.get("session_shutdown")!({}, h.ctx);
      expect(disk()).toMatchObject({ delivered: true, run: { state: "done" } });
      expect(mark).toHaveBeenCalledTimes(3);
      const reopenRunner = vi.fn(async () => ({ state: "done" as const, output: "must not run", turns: 1, usage: emptyUsage() }));
      next = harness(() => reopenRunner, { ...durable, prefix: "reopened" });
      // No old native receipt is supplied: only the committed delivered bit prevents redelivery.
      await next.handlers.get("session_start")!({}, next.ctx);
      await next.handlers.get("agent_settled")!({}, next.ctx);
      await flush();
      expect(next.messages).toHaveLength(0);
      expect(reopenRunner).not.toHaveBeenCalled();
      const status = await next.tools.get("ultraterm_hub").execute("s", { action: "status", runId: id }, undefined, undefined, next.ctx);
      expect(status.details.run.tasks[0]).toMatchObject({ state: "done" });
    } finally {
      failing = false;
      try {
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        if (next) await next.handlers.get("session_shutdown")!({}, next.ctx);
      } finally { mark.mockRestore(); }
    }
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

  describe("synthetic background parent wake", () => {
    const done = () => ({ state: "done" as const, output: "synthetic result", turns: 1, usage: emptyUsage() });
    function controlled() {
      const finish = new Map<string, () => void>();
      const h = harness(() => async ({ run }) => {
        await new Promise<void>((resolve) => finish.set(run.id, resolve));
        return done();
      });
      const start = async (background = true) => {
        const result = await h.tools.get("ultraterm_subagents").execute("dispatch", {
          goal: "Synthetic wake regression", background, tasks: [{ label: "leaf", task: "Finish" }],
        }, undefined, undefined, h.ctx);
        return result.details.run.runId as string;
      };
      return { ...h, start, finish };
    }

    it("idle background completion starts exactly one turn with an actionable first line", async () => {
      const h = controlled();
      try {
        const id = await h.start();
        h.finish.get(id)!();
        await flush();
        expect(h.messages).toHaveLength(1);
        expect(h.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
        expect(h.messages[0].message.content.split("\n")[0]).toBe(`Background run ${id} finished: continue the parent task (integrate results, verify, release) before ending the turn.`);
        await h.handlers.get("agent_start")!({}, h.ctx);
        await h.handlers.get("agent_settled")!({}, h.ctx);
        expect(h.messages).toHaveLength(1);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("busy parent steers into its current turn without a trigger or a later wake", async () => {
      const h = controlled();
      try {
        await h.handlers.get("session_start")!({}, h.ctx);
        await h.handlers.get("agent_start")!({}, h.ctx);
        h.ctx.isIdle = () => false;
        const id = await h.start();
        h.finish.get(id)!();
        await flush();
        expect(h.messages).toHaveLength(1);
        expect(h.messages[0].options).toEqual({ deliverAs: "steer" });
        h.ctx.isIdle = () => true;
        await h.handlers.get("agent_settled")!({}, h.ctx);
        expect(h.messages).toHaveLength(1);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("runtime initialized by a mid-turn dispatch still steers without a trigger", async () => {
      const h = controlled();
      try {
        await h.handlers.get("agent_start")!({}, h.ctx);
        h.ctx.isIdle = () => false;
        const id = await h.start();
        h.finish.get(id)!();
        await flush();
        expect(h.messages).toHaveLength(1);
        expect(h.messages[0].options).toEqual({ deliverAs: "steer" });
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("two runs settling together coalesce into one triggered send", async () => {
      const h = controlled();
      try {
        const ids = [await h.start(), await h.start()];
        ids.forEach((id) => h.finish.get(id)!());
        await flush();
        expect(h.messages).toHaveLength(1);
        expect(h.messages[0].message.details).toMatchObject({ coalesced: 2, runIds: ids });
        expect(h.messages[0].options.triggerTurn).toBe(true);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it.each(["status", "wait"])("terminal hub %s acknowledges a completion before idle delivery", async (action) => {
      vi.useFakeTimers();
      const h = controlled();
      await h.handlers.get("session_start")!({}, h.ctx);
      h.ctx.isIdle = () => false;
      try {
        const id = await h.start();
        h.finish.get(id)!();
        await flush();
        const result = await h.tools.get("ultraterm_hub").execute("observe", { action, runId: id, mode: "all", timeoutMs: 100 }, undefined, undefined, h.ctx);
        expect(result.details.run.state).toBe("done");
        h.ctx.isIdle = () => true;
        await h.handlers.get("agent_settled")!({}, h.ctx);
        await vi.advanceTimersByTimeAsync(300);
        expect(h.messages).toHaveLength(0);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("a terminal wait already in flight acknowledges before delivery", async () => {
      const h = controlled();
      try {
        const id = await h.start();
        const observed = h.tools.get("ultraterm_hub").execute("observe", { action: "wait", runId: id, mode: "all", timeoutMs: 100 }, undefined, undefined, h.ctx);
        h.finish.get(id)!();
        await observed;
        await flush();
        expect(h.messages).toHaveLength(0);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("a running status does not acknowledge the eventual completion", async () => {
      const h = controlled();
      try {
        const id = await h.start();
        const observed = await h.tools.get("ultraterm_hub").execute("observe", { action: "status", runId: id }, undefined, undefined, h.ctx);
        expect(observed.details.run.state).toBe("running");
        h.finish.get(id)!();
        await flush();
        expect(h.messages).toHaveLength(1);
        expect(h.messages[0].options.triggerTurn).toBe(true);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("a pending native wake prevents a second trigger before agent_start", async () => {
      vi.useFakeTimers();
      const h = controlled();
      h.ctx.sessionManager.getEntries = () => [];
      try {
        for (let index = 0; index < 2; index++) {
          const id = await h.start();
          h.finish.get(id)!();
          await flush();
        }
        await vi.advanceTimersByTimeAsync(3000);
        expect(h.messages.map(({ options }) => options.triggerTurn)).toEqual([true, false]);
        expect(vi.getTimerCount()).toBe(0);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("permanent host rejection bounds passive retries and never retries the trigger", async () => {
      vi.useFakeTimers();
      const h = controlled();
      const send = vi.spyOn(h.pi, "sendMessage").mockImplementation(() => { throw new Error("synthetic host rejection"); });
      try {
        const id = await h.start();
        h.finish.get(id)!();
        await flush();
        await vi.advanceTimersByTimeAsync(3000);
        expect(send.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(1);
        expect(send).toHaveBeenCalledTimes(22); // one wake, one fallback, 20 passive retries
        expect(vi.getTimerCount()).toBe(0);
        expect(h.statuses.some((text) => text?.includes("delivery unconfirmed"))).toBe(true);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it.each(["0", "false", "off"])("disabled env (%s) delivers passively", async (value) => {
      vi.stubEnv("STEAK_USAP_WAKE_PARENT", value);
      const h = controlled();
      try {
        const id = await h.start();
        h.finish.get(id)!();
        await flush();
        expect(h.messages).toHaveLength(1);
        expect(h.messages[0].options).toEqual({ deliverAs: "steer", triggerTurn: false });
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it.each([false, true])("trigger rejection falls back passively without a trigger retry (passive rejects once=%s)", async (rejectPassive) => {
      vi.useFakeTimers();
      const h = controlled();
      const original = h.pi.sendMessage.bind(h.pi);
      let passiveRejected = false;
      const send = vi.spyOn(h.pi, "sendMessage").mockImplementation((message, options) => {
        if (options?.triggerTurn) throw new Error("synthetic host rejects continuation");
        if (rejectPassive && !passiveRejected) { passiveRejected = true; throw new Error("synthetic transient passive rejection"); }
        original(message, options);
      });
      try {
        const id = await h.start();
        h.finish.get(id)!();
        await flush();
        await vi.advanceTimersByTimeAsync(3000);
        await h.handlers.get("agent_settled")!({}, h.ctx);
        expect(send.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(1);
        expect(send).toHaveBeenCalledTimes(rejectPassive ? 3 : 2);
        expect(h.messages).toHaveLength(1);
        expect(h.messages[0].options.triggerTurn).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("foreground work never emits a completion wake", async () => {
      const h = harness(() => async () => done());
      try {
        await h.tools.get("ultraterm_subagents").execute("foreground", {
          goal: "Synthetic foreground", background: false, tasks: [{ label: "leaf", task: "Finish" }],
        }, undefined, undefined, h.ctx);
        await h.handlers.get("agent_settled")!({}, h.ctx);
        expect(h.messages).toHaveLength(0);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });
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
    const store = new CheckpointStore(durable.parent, durable.root, durable.parent);
    const run = normalizeDispatch({ goal: "continue", background: true, tasks: [{ label: "unfinished", task: "continue" }] }, root, "openai-codex/gpt-6.1-sol", "medium", Date.now(), () => "retired-checkpoint");
    run.tasks[0].state = "running"; run.tasks[0].startedAt = Date.now();
    const sessionFile = join(store.sessionsDirectory, "native.jsonl"); writeFileSync(sessionFile, "checkpoint", { mode: 0o600 });
    run.tasks[0].sessionFile = sessionFile;
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
    const reopened = new CheckpointStore(durable.parent, durable.root, durable.parent);
    try {
      expect(reopened.get(run.id)?.run.model).toBe(run.model);
      expect(reopened.get(run.id)?.resumedAs).toBeUndefined();
      expect(reopened.get(run.id)?.pendingResume).toBeUndefined();
    } finally { reopened.close(); }
  });

  it("resumes an interrupted native checkpoint once and excludes completed siblings", async () => {
    const root = mkdtempSync(join(tmpdir(), "usap-resume-")); dirs.push(root);
    const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: "resumed" };
    const store = new CheckpointStore(durable.parent, durable.root, durable.parent);
    const run = normalizeDispatch({ goal: "continue", background: true, tasks: [{ label: "complete", task: "complete" }, { label: "unfinished", task: "continue" }] }, root, "openai-codex/gpt-6.1-sol", "medium", Date.now(), () => "interrupted");
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
      id: "run-a", goal: "g", state: "running", model: "openai-codex/gpt-6.1-sol",
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
    expect(renderRunResult(run)).toContain("model openai-codex/gpt-6.1-sol · thinking high");
    expect(renderRunResult(run)).toContain("openai-codex/");
    expect(toRunView(run).model).toBe("openai-codex/gpt-6.1-sol");
  });
  describe("explicit partial outcome and bounded resume", () => {
    const turnLimit = (turns: number) => `Child exceeded the ${turns}-turn limit; the partial report above is evidence, not acceptance`;
    const telemetryFor = (h: ReturnType<typeof harness>, runId: string) =>
      h.entries.filter((entry) => entry.type === "ultraterm-usap-telemetry" && entry.data.runId === runId).map((entry) => entry.data);

    /** A settled checkpoint whose reviewer stopped on its turn budget with a resumable native session. */
    function partialCheckpoint(name: string, overrides: { model?: string; thinkingLevel?: string; selection?: any; claude?: boolean; account?: TaskRecord["providerAccount"]; reviewFallback?: TaskRecord["reviewFallback"]; privilege?: "write" | "shell" } = {}) {
      const root = mkdtempSync(join(tmpdir(), `usap-${name}-`)); dirs.push(root);
      const durable = { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix: name };
      const store = new CheckpointStore(durable.parent, durable.root, durable.parent);
      const run = normalizeDispatch({ goal: "review", background: true, maxTurns: 12, tasks: [{ label: "Metadata signoff", task: "Review the metadata", role: "reviewer" }, { label: "Impl", task: "Done already", role: "worker" }] }, root, overrides.model ?? "openai-codex/gpt-6.1-sol", overrides.thinkingLevel ?? "medium", Date.now(), () => `${name}-origin`);
      if (overrides.selection) run.selection = overrides.selection;
      if (overrides.account) run.tasks[0].providerAccount = overrides.account;
      if (overrides.reviewFallback) run.tasks[0].reviewFallback = overrides.reviewFallback;
      if (overrides.privilege) Object.assign(run.tasks[0], overrides.privilege === "write" ? { mayEdit: true, ownedPaths: [join(root, "safe.ts")] } : { allowBash: true });
      if (overrides.claude) { run.harness = "claude-code"; run.selection = overrides.selection ?? { ...resolveClaudeCodeSelection("claude-opus-5-5") }; }
      run.tasks[1].state = "done";
      Object.assign(run.tasks[0], { state: "failed", startedAt: Date.now(), turns: 12, error: turnLimit(12), outcome: "partial", partialReason: "turn_budget", partialSummary: "Turn budget reached after 12/12 turns" });
      run.state = "failed";
      const sessionFile = join(store.sessionsDirectory, "native.jsonl"); writeFileSync(sessionFile, "checkpoint", { mode: 0o600 });
      if (overrides.claude) {
        run.tasks[0].claudeSessionId = "5b1d6a56-3a4c-4f0e-9a9e-0d6f4c6f2a11";
        run.tasks[0].subscriptionReceipt = { ...syntheticClaudeReceipt("primary"), account: undefined };
      }
      else run.tasks[0].sessionFile = sessionFile;
      store.save(run, true); store.close();
      return { durable, run, sessionFile };
    }
    const resume = (h: ReturnType<typeof harness>, runId: string) => h.tools.get("ultraterm_hub").execute("hub", { action: "resume", runId }, undefined, undefined, h.ctx);

    it("synthetic: legacy Claude history without an account receipt refuses before spending its resume", async () => {
      const checkpoint = partialCheckpoint("claude-legacy-identity", { model: "claude-code/claude-opus-5-5", thinkingLevel: "xhigh", claude: true });
      const store = new CheckpointStore(checkpoint.durable.parent, checkpoint.durable.root, checkpoint.durable.parent);
      const old = store.get(checkpoint.run.id)!.run; delete old.tasks[0].subscriptionReceipt;
      store.save(old, true); store.close();
      const runner = vi.fn(async () => ({ state: "done" as const, output: "unexpected", turns: 1, usage: emptyUsage() }));
      const h = harness(() => runner, checkpoint.durable);
      await h.handlers.get("session_start")!({}, h.ctx);
      const prepare = vi.spyOn(CheckpointStore.prototype, "prepareResume");
      try {
        await expect(resume(h, checkpoint.run.id)).rejects.toThrow(/no authenticated Claude account receipt/);
        expect(prepare).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
      } finally { prepare.mockRestore(); await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it.each(["primary", "b"] as const)("synthetic: carries selected Claude account %s and its identity receipt across durable resume", async (account) => {
      const checkpoint = partialCheckpoint(`claude-account-${account}`, { model: "claude-code/claude-opus-5-5", thinkingLevel: "xhigh", claude: true });
      const receipt = syntheticClaudeReceipt(account);
      const store = new CheckpointStore(checkpoint.durable.parent, checkpoint.durable.root, checkpoint.durable.parent);
      try {
        const record = store.get(checkpoint.run.id)!.run;
        record.claudeAccount = account;
        record.tasks[0].subscriptionReceipt = receipt;
        store.save(record, true);
      } finally { store.close(); }
      const seen: Array<{ account?: string; receipt?: TaskRecord["subscriptionReceipt"]; sessionId?: string; model: string }> = [];
      const accountCommand = vi.fn(async (args: string[]) => {
        if (args[0] !== "select") throw new Error("resume must only use read-only account selection");
        return syntheticClaudeSelection(account);
      });
      const h = harness(() => async ({ run, task }) => {
        seen.push({ account: run.claudeAccount, receipt: structuredClone(task.subscriptionReceipt), sessionId: task.claudeSessionId, model: run.model });
        return { state: "done", output: "synthetic continued report", turns: 1, usage: emptyUsage(), subscriptionReceipt: receipt };
      }, checkpoint.durable, undefined, { accountCommand });
      h.ctx.modelRegistry.find = () => { throw new Error("must not query Pi for a selected Claude resume"); };
      await h.handlers.get("session_start")!({}, h.ctx);
      try {
        const resumed = await resume(h, checkpoint.run.id);
        expect(resumed.details.run).toMatchObject({ claudeAccount: account, harness: "claude-code", model: "claude-code/claude-opus-5-5", resumedFrom: checkpoint.run.id, tasks: [{ subscriptionReceipt: receipt }] });
        expect(resumed.details.run.tasks).toHaveLength(1);
        await vi.waitFor(() => expect(seen).toHaveLength(1));
        expect(seen[0]).toEqual({ account, receipt, sessionId: checkpoint.run.tasks[0].claudeSessionId, model: checkpoint.run.model });
        expect(accountCommand.mock.calls).toEqual([[["select", "--provider", "claude", "--account", account]]]);
        const done = await h.tools.get("ultraterm_hub").execute("wait", { action: "wait", runId: resumed.details.run.runId, mode: "all", timeoutMs: 1000 }, undefined, undefined, h.ctx);
        expect(done.details.run).toMatchObject({ claudeAccount: account, tasks: [{ subscriptionReceipt: receipt }] });
        expect(done.content[0].text).toContain(`Claude subscription: ${account}; namespace=${receipt.configMode}; identity=${receipt.identityHash}`);
        expect(JSON.stringify(done)).not.toMatch(/synthetic-claude@example\.invalid|synthetic-private-org|synthetic-private-token/);
        await expect(resume(h, checkpoint.run.id)).rejects.toThrow(/Already resumed/);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("synthetic: router refusal on a selected Claude resume cannot reserve a successor or launch the default account", async () => {
      const checkpoint = partialCheckpoint("claude-account-resume-refused", { model: "claude-code/claude-opus-5-5", thinkingLevel: "xhigh", claude: true });
      const receipt = syntheticClaudeReceipt("b");
      const store = new CheckpointStore(checkpoint.durable.parent, checkpoint.durable.root, checkpoint.durable.parent);
      try {
        const record = store.get(checkpoint.run.id)!.run;
        record.claudeAccount = "b";
        record.tasks[0].subscriptionReceipt = receipt;
        store.save(record, true);
      } finally { store.close(); }
      const runner = vi.fn(async () => ({ state: "done" as const, output: "unexpected", turns: 1, usage: emptyUsage() }));
      const accountCommand = vi.fn(async (_args: string[]) => ({ ok: false, reason: "unavailable" }));
      const h = harness(() => runner, checkpoint.durable, undefined, { accountCommand });
      await h.handlers.get("session_start")!({}, h.ctx);
      const prepare = vi.spyOn(CheckpointStore.prototype, "prepareResume");
      try {
        await expect(resume(h, checkpoint.run.id)).rejects.toThrow("Unsafe Claude provider account selection");
        expect(accountCommand.mock.calls).toEqual([[["select", "--provider", "claude", "--account", "b"]]]);
        expect(prepare).not.toHaveBeenCalled();
        expect(runner).not.toHaveBeenCalled();
        const list = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
        expect(list.details.runs).toHaveLength(1);
        expect(list.details.runs[0]).toMatchObject({ runId: checkpoint.run.id, claudeAccount: "b", tasks: [{ subscriptionReceipt: receipt }, {}] });
      } finally { prepare.mockRestore(); await h.handlers.get("session_shutdown")!({}, h.ctx); }
      const reopened = new CheckpointStore(checkpoint.durable.parent, checkpoint.durable.root, checkpoint.durable.parent);
      try {
        expect(reopened.get(checkpoint.run.id)?.resumedAs).toBeUndefined();
        expect(reopened.get(checkpoint.run.id)?.pendingResume).toBeUndefined();
      } finally { reopened.close(); }
    });

    it("marks a turn- or time-budget stop partial with role and label in the result, receipt and telemetry", async () => {
      const h = harness(() => async ({ task }) => task.label === "Metadata signoff"
        ? { state: "failed" as const, output: "findings so far", error: turnLimit(5), turns: 5, usage: emptyUsage() }
        : task.label === "Slow"
          ? { state: "timed_out" as const, output: "", error: "Run deadline exceeded", turns: 2, usage: emptyUsage() }
          : { state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() });
      await h.handlers.get("session_start")!({}, h.ctx);
      const tasks = [{ label: "Metadata signoff", task: "Review", role: "reviewer" }, { label: "Slow", task: "Wait", role: "worker" }, { label: "Impl", task: "Build", role: "worker" }];
      const dispatched = await h.tools.get("ultraterm_subagents").execute("d", { goal: "partial", harness: "pi", background: true, tasks }, undefined, undefined, h.ctx);
      const runId = dispatched.details.run.runId;
      await flush();
      // Run result: explicit outcome, role, retained-work summary, and a visible partial count.
      const status = await h.tools.get("ultraterm_hub").execute("s", { action: "status", runId }, undefined, undefined, h.ctx);
      const [review, slow, impl] = status.details.run.tasks;
      expect(review).toMatchObject({ label: "Metadata signoff", role: "reviewer", state: "failed", outcome: "partial", partialReason: "turn_budget" });
      expect(review.partialSummary).toMatch(/^Turn budget reached after 5\/64 turns/);
      expect(slow).toMatchObject({ role: "worker", state: "timed_out", outcome: "partial", partialReason: "time_budget" });
      expect(impl).toMatchObject({ state: "done" });
      expect(impl.outcome).toBeUndefined();
      expect(status.content[0].text).toContain("2 partial");
      expect(status.content[0].text).toContain("[Metadata signoff] failed · PARTIAL turn_budget (reviewer; not complete)");
      expect(status.content[0].text).toMatch(/retained: Turn budget reached after 5\/64 turns/);
      // Receipt: the completion message names the partial leaf, its role and label.
      expect(h.messages).toHaveLength(1);
      expect(h.messages[0].message.content).toContain("/PARTIAL(turn_budget, reviewer \"Metadata signoff\")");
      expect(h.messages[0].message.content).toContain("/PARTIAL(time_budget, worker \"Slow\")");
      expect(h.messages[0].message.details.runs[0].tasks[0]).toMatchObject({ role: "reviewer", outcome: "partial", partialReason: "turn_budget" });
      // Telemetry: the latest record carries role, label, outcome and the bounded summary, never output.
      const latest = telemetryFor(h, runId).at(-1);
      expect(latest.runState).toBe("failed");
      expect(latest.tasks[0]).toMatchObject({ label: "Metadata signoff", role: "reviewer", state: "failed", outcome: "partial", partialReason: "turn_budget", detail: "Turn budget reached — partial work retained" });
      expect(latest.tasks[1]).toMatchObject({ role: "worker", state: "timed_out", outcome: "partial", partialReason: "time_budget" });
      expect(latest.tasks[2].outcome).toBeUndefined();
      expect(JSON.stringify(latest)).not.toContain("findings so far");
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });

    it("copies the prior Go account identity into a resumed task with a new run id", async () => {
      const account = { provider: "opencode-go" as const, id: "b" as const, label: "Go 2", lease: "prior-lease" };
      const checkpoint = partialCheckpoint("go-resume-account", { model: "opencode-go/deepseek-v4.1-flash", thinkingLevel: "high", account });
      const seen: TaskRecord[] = [];
      const h = harness(() => async ({ task }) => { seen.push(task); return { state: "done", output: "continued", turns: 1, usage: emptyUsage() }; }, checkpoint.durable);
      const go = { provider: "opencode-go", id: "deepseek-v4.1-flash", baseUrl: "https://opencode.ai/zen/go/v1", input: ["text"] };
      h.ctx.model = go;
      h.ctx.modelRegistry = { find: () => go, getAll: () => [go], getAvailable: () => [go], hasConfiguredAuth: () => true, isUsingOAuth: () => false, getProvider: () => ({ streamSimple() {} }) };
      await h.handlers.get("session_start")!({}, h.ctx);
      await resume(h, checkpoint.run.id);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0].providerAccount).toEqual(account);
      expect(seen[0].sessionFile).toBe(checkpoint.sessionFile);
      expect(seen[0].id).not.toBe(checkpoint.run.tasks[0].id);
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });

    it("resumes a partial task once on the same budget and route, and the success supersedes it in telemetry", async () => {
      const { durable, run, sessionFile } = partialCheckpoint("resume-once");
      const seen: Array<{ sessionFile?: string; maxTurns: number; timeoutMs: number; model: string; source?: string; resumedFrom?: string; taskResumedFrom?: string }> = [];
      const h = harness(() => async ({ run: context, task }) => {
        seen.push({ sessionFile: task.sessionFile, maxTurns: context.maxTurns, timeoutMs: context.timeoutMs, model: context.model, source: context.selection?.source, resumedFrom: context.resumedFrom, taskResumedFrom: task.resumedFrom });
        return { state: "done", output: "finished", turns: 3, usage: emptyUsage() };
      }, durable);
      await h.handlers.get("session_start")!({}, h.ctx);
      const resumed = await resume(h, run.id);
      const successorId = resumed.details.run.runId;
      expect(resumed.content[0].text).toMatch(/the one bounded resume; no second resume is possible/);
      expect(resumed.content[0].text).toContain("maxTurns 12");
      expect(resumed.details.run).toMatchObject({ resumedFrom: run.id, model: run.model });
      expect(resumed.details.run.tasks).toHaveLength(1);
      expect(resumed.details.run.tasks[0]).toMatchObject({ role: "reviewer", label: "Metadata signoff", resumedFrom: run.tasks[0].id });
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      // Continues the checkpointed session, with the original budget (never larger) and route, pinned (no chain hop).
      expect(seen[0]).toEqual({ sessionFile, maxTurns: 12, timeoutMs: run.timeoutMs, model: run.model, source: "override", resumedFrom: run.id, taskResumedFrom: run.tasks[0].id });
      await flush();
      // Telemetry lineage: predecessor names its successor, then is superseded once the successor finishes.
      const successor = telemetryFor(h, successorId).at(-1);
      expect(successor).toMatchObject({ runState: "done", resumedFrom: run.id });
      expect(successor.tasks[0]).toMatchObject({ role: "reviewer", label: "Metadata signoff", state: "done", resumedFrom: run.tasks[0].id, supersedes: run.tasks[0].id });
      const records = telemetryFor(h, run.id);
      expect(records.length).toBeGreaterThanOrEqual(2);
      expect(records[0]).toMatchObject({ resumedAs: successorId });
      expect(records[0].supersededBy).toBeUndefined();
      expect(records.at(-1)).toMatchObject({ resumedAs: successorId, supersededBy: successorId });
      expect(records.at(-1).tasks[0]).toMatchObject({ role: "reviewer", outcome: "partial" });
      // Hub views expose the same lineage.
      const status = await h.tools.get("ultraterm_hub").execute("s", { action: "status", runId: run.id }, undefined, undefined, h.ctx);
      expect(status.details.run).toMatchObject({ resumedAs: successorId, supersededBy: successorId });
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });

    it("refuses a second resume of the same run and of a resumed attempt that stopped partial again", async () => {
      const { durable, run } = partialCheckpoint("resume-twice");
      const launches: string[] = [];
      const h = harness(() => async ({ task }) => {
        launches.push(task.id);
        return { state: "failed", output: "second attempt notes", error: turnLimit(12), turns: 12, usage: emptyUsage() };
      }, durable);
      await h.handlers.get("session_start")!({}, h.ctx);
      const first = await resume(h, run.id);
      const successorId = first.details.run.runId;
      await vi.waitFor(() => expect(h.entries.some((entry) => entry.data.runId === successorId && entry.data.runState === "failed")).toBe(true));
      await flush();
      expect(launches).toHaveLength(1);
      // The predecessor cannot be resumed again.
      await expect(resume(h, run.id)).rejects.toThrow(/Already resumed as .*; a task is resumed at most once/);
      // The resumed attempt stopped partial again; it keeps the explicit marker and cannot be resumed.
      const status = await h.tools.get("ultraterm_hub").execute("s", { action: "status", runId: successorId }, undefined, undefined, h.ctx);
      expect(status.details.run.tasks[0]).toMatchObject({ state: "failed", outcome: "partial", resumedFrom: run.tasks[0].id });
      expect(status.details.run.tasks[0].partialSummary).toContain("its one resume is used");
      const refusal = await resume(h, successorId).then(() => undefined, (error: Error) => error.message);
      expect(refusal).toMatch(/Resume refused: "Metadata signoff" already used the one bounded resume \(continuing .*\)\. A task is resumed at most once/);
      expect(refusal).toMatch(/dispatch a new, explicitly scoped task/);
      expect(launches).toHaveLength(1);
      // Never superseded: the second partial stays visible.
      expect(telemetryFor(h, run.id).at(-1).supersededBy).toBeUndefined();
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });

    it("resumes a Claude Code partial once on its pinned Opus route, and refuses a changed Claude route", async () => {
      const claude = partialCheckpoint("claude-resume", { model: "claude-code/claude-opus-5-5", thinkingLevel: "xhigh", claude: true });
      const seen: Array<{ harness?: string; model: string; maxTurns: number; claudeSessionId?: string }> = [];
      const h = harness(() => async ({ run: context, task }) => {
        seen.push({ harness: context.harness, model: context.model, maxTurns: context.maxTurns, claudeSessionId: task.claudeSessionId });
        return { state: "done", output: "finished", turns: 2, usage: emptyUsage() };
      }, claude.durable);
      h.ctx.modelRegistry.find = () => { throw new Error("must not query Pi models"); };
      await h.handlers.get("session_start")!({}, h.ctx);
      const resumed = await resume(h, claude.run.id);
      expect(resumed.details.run).toMatchObject({ harness: "claude-code", model: "claude-code/claude-opus-5-5", resumedFrom: claude.run.id });
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]).toEqual({ harness: "claude-code", model: "claude-code/claude-opus-5-5", maxTurns: 12, claudeSessionId: claude.run.tasks[0].claudeSessionId });
      await expect(resume(h, claude.run.id)).rejects.toThrow(/Already resumed/);
      await h.handlers.get("session_shutdown")!({}, h.ctx);

      // A checkpoint whose recorded selection names another Claude route is a changed route.
      const other = { ...resolveClaudeCodeSelection("claude-sonnet-5-5") };
      const stale = partialCheckpoint("claude-stale", { model: "claude-code/claude-opus-5-5", thinkingLevel: "xhigh", claude: true });
      const store = new CheckpointStore(stale.durable.parent, stale.durable.root, stale.durable.parent);
      const record = store.get(stale.run.id)!.run; record.selection = other; store.save(record, true); store.close();
      const k = harness(() => async () => { throw new Error("must not launch"); }, stale.durable);
      await k.handlers.get("session_start")!({}, k.ctx);
      await expect(resume(k, stale.run.id)).rejects.toThrow(/Resume refused: the route changed \(checkpoint claude-code\/claude-sonnet-5-5, run claude-code\/claude-opus-5-5/);
      await k.handlers.get("session_shutdown")!({}, k.ctx);
    });

    it("keeps automatic review provenance on a resumed Sol fallback review instead of recording an override", async () => {
      const reviewFallback = { from: "claude-code/claude-opus-5-5", to: "openai-codex/gpt-6.1-sol", reason: "no-eligible-claude" } as const;
      const selection = { provider: "openai-codex", modelId: "gpt-6.1-sol", source: "automatic-review-fallback", automaticReview: true, harness: "pi", images: false, tools: true };
      const { durable, run } = partialCheckpoint("resume-review-fallback", { selection, reviewFallback });
      const seen: Array<{ source?: string; fallback?: TaskRecord["reviewFallback"] }> = [];
      const h = harness(() => async ({ run: context, task }) => {
        seen.push({ source: context.selection?.source, fallback: task.reviewFallback && { ...task.reviewFallback } });
        return { state: "done", output: "finished", turns: 1, usage: emptyUsage() };
      }, durable);
      await h.handlers.get("session_start")!({}, h.ctx);
      const resumed = await resume(h, run.id);
      expect(resumed.details.run.selection).toMatchObject({ provider: "openai-codex", modelId: "gpt-6.1-sol", source: "automatic-review-fallback" });
      // Resume pins the route, so the automatic Claude -> Sol fallback is not re-armed.
      expect(resumed.details.run.selection.automaticReview).toBeUndefined();
      await vi.waitFor(() => expect(seen).toEqual([{ source: "automatic-review-fallback", fallback: reviewFallback }]));
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });

    it.each([
      { privilege: "write", source: "automatic-review-fallback" },
      { privilege: "shell", source: "automatic-review-fallback" },
      { privilege: "write", source: "override" },
      { privilege: "shell", source: "override" },
    ] as const)("refuses a legacy automatic-fallback checkpoint with an unfinished privileged reviewer (%j) before any resume state changes", async ({ privilege, source }) => {
      const reviewFallback = { from: "claude-code/claude-opus-5-5", to: "openai-codex/gpt-6.1-sol", reason: "no-eligible-claude" } as const;
      const selection = { provider: "openai-codex", modelId: "gpt-6.1-sol", source, automaticReview: true, harness: "pi", images: false, tools: true };
      const { durable, run } = partialCheckpoint(`legacy-fallback-${source}-${privilege}`, { selection, reviewFallback, privilege });
      const launches: string[] = [];
      const h = harness(() => async ({ task }) => { launches.push(task.id); return { state: "done", output: "finished", turns: 1, usage: emptyUsage() }; }, durable);
      await h.handlers.get("session_start")!({}, h.ctx);
      await expect(resume(h, run.id)).rejects.toThrow(/Resume refused: "Metadata signoff" reached Sol only through the automatic review fallback/);
      const listed = await h.tools.get("ultraterm_hub").execute("l", { action: "list" }, undefined, undefined, h.ctx);
      expect(listed.details.runs.every((view: any) => view.resumedAs === undefined)).toBe(true);
      expect(launches).toEqual([]);
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });

    it.each(["write", "shell"] as const)("keeps explicitly Pi-selected %s ownership resumable on its pinned route", async privilege => {
      const selection = { provider: "openai-codex", modelId: "gpt-6.1-sol", source: "override", harness: "pi", images: false, tools: true };
      const { durable, run } = partialCheckpoint(`explicit-pi-${privilege}`, { selection, privilege });
      const seen: Array<{ mayEdit: boolean; allowBash: boolean; owned: number }> = [];
      const h = harness(() => async ({ task }) => { seen.push({ mayEdit: task.mayEdit, allowBash: task.allowBash, owned: task.ownedPaths.length }); return { state: "done", output: "finished", turns: 1, usage: emptyUsage() }; }, durable);
      await h.handlers.get("session_start")!({}, h.ctx);
      const resumed = await resume(h, run.id);
      expect(resumed.details.run.selection.source).toBe("override");
      await vi.waitFor(() => expect(seen).toEqual([privilege === "write" ? { mayEdit: true, allowBash: false, owned: 1 } : { mayEdit: false, allowBash: true, owned: 0 }]));
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });

    it("keeps automatic review provenance on a resumed implicit Claude review, without carrying a mid-run Sol fallback onto Claude", async () => {
      const selection = { ...resolveClaudeCodeSelection("claude-opus-5-5"), source: "automatic-review" as const, automaticReview: true };
      const reviewFallback = { from: "claude-code/claude-opus-5-5", to: "openai-codex/gpt-6.1-sol", reason: "quota" } as const;
      const review = partialCheckpoint("resume-automatic-review", { model: "claude-code/claude-opus-5-5", thinkingLevel: "xhigh", claude: true, selection, reviewFallback });
      const seen: Array<{ source?: string; fallback?: TaskRecord["reviewFallback"] }> = [];
      const h = harness(() => async ({ run: context, task }) => {
        seen.push({ source: context.selection?.source, fallback: task.reviewFallback });
        return { state: "done", output: "finished", turns: 1, usage: emptyUsage() };
      }, review.durable);
      h.ctx.modelRegistry.find = () => { throw new Error("must not query Pi models"); };
      await h.handlers.get("session_start")!({}, h.ctx);
      const resumed = await resume(h, review.run.id);
      expect(resumed.details.run.selection).toMatchObject({ provider: "claude-code", modelId: "claude-opus-5-5", source: "automatic-review" });
      expect(resumed.details.run.selection.automaticReview).toBeUndefined();
      await vi.waitFor(() => expect(seen).toEqual([{ source: "automatic-review", fallback: undefined }]));
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });

    it("keeps an explicit route as `override` when a checkpoint without automatic provenance is resumed", async () => {
      const { durable, run } = partialCheckpoint("resume-explicit-override", { selection: { provider: "openai-codex", modelId: "gpt-6.1-sol", source: "override", harness: "pi", images: false, tools: true } });
      const h = harness(() => async () => ({ state: "done", output: "finished", turns: 1, usage: emptyUsage() }), durable);
      await h.handlers.get("session_start")!({}, h.ctx);
      const resumed = await resume(h, run.id);
      expect(resumed.details.run.selection.source).toBe("override");
      await flush();
      await h.handlers.get("session_shutdown")!({}, h.ctx);
    });

    it("refuses a changed or paid route before spending the one resume", async () => {
      const staleSelection = { provider: "xiaomi", modelId: "mimo-v2.6-flash", source: "override", harness: "pi", images: false, tools: true };
      const stale = partialCheckpoint("route-stale", { selection: staleSelection });
      const launches: string[] = [];
      const runnerFactory = () => async ({ task }: { task: { id: string } }) => { launches.push(task.id); return { state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }; };
      const h = harness(runnerFactory, stale.durable);
      await h.handlers.get("session_start")!({}, h.ctx);
      await expect(resume(h, stale.run.id)).rejects.toThrow(/Resume refused: the route changed \(checkpoint xiaomi\/mimo-v2\.6-flash, run openai-codex\/gpt-6\.1-sol, now openai-codex\/gpt-6\.1-sol\)\. A resume continues only on the original subscription route/);
      const listed = await h.tools.get("ultraterm_hub").execute("l", { action: "list" }, undefined, undefined, h.ctx);
      expect(listed.details.runs.every((view: any) => view.resumedAs === undefined)).toBe(true);
      expect(launches).toEqual([]);
      await h.handlers.get("session_shutdown")!({}, h.ctx);

      // A route that now bills as paid/API-key is refused; restoring the subscription route then succeeds, so the refusal did not burn the resume.
      const paid = partialCheckpoint("route-paid", { model: "xiaomi/mimo-v2.6-flash" });
      const subscription = { provider: "xiaomi", id: "mimo-v2.6-flash", api: "openai-completions", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", input: ["text"], reasoning: false };
      const payg = { ...subscription, baseUrl: "https://api.xiaomimimo.com/v1" };
      const g = harness(runnerFactory, paid.durable);
      g.ctx.modelRegistry.find = () => payg;
      g.ctx.modelRegistry.getAvailable = () => [payg];
      await g.handlers.get("session_start")!({}, g.ctx);
      await expect(resume(g, paid.run.id)).rejects.toThrow(/Resume refused: xiaomi\/mimo-v2\.6-flash is no longer a subscription route \(paid or API-key billing\)/);
      expect(launches).toEqual([]);
      g.ctx.modelRegistry.find = () => subscription;
      g.ctx.modelRegistry.getAvailable = () => [subscription];
      const resumed = await resume(g, paid.run.id);
      expect(resumed.details.run.resumedFrom).toBe(paid.run.id);
      await vi.waitFor(() => expect(launches).toHaveLength(1));
      await g.handlers.get("session_shutdown")!({}, g.ctx);
    });
  });
});


describe("fresh Go parent dispatch to isolated authenticated Sol", () => {
  it.each(["explicit-model", "explicit-profile", "claude-unavailable", "opus-first"])("bridges %s without registering Codex auth into the Go registry", async kind => {
    const sol = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text"] } as any;
    const isolatedRuntime = { getModel: () => sol, getModels: () => [sol], getAvailableSnapshot: () => [sol], hasConfiguredAuth: () => true,
      isUsingOAuth: () => true, getProvider: () => ({ streamSimple() {} }) } as unknown as ModelRuntime;
    const createRuntime = vi.fn(async () => isolatedRuntime);
    const accountCommand = vi.fn(async (args: string[]) => args[0] === "status"
      ? { providers: { claude: { accounts: [{ eligible: kind !== "claude-unavailable" }] } } }
      : { ok: true, account: { id: "fallback", agentDir: isolatedCodexAgentDir("fallback") } });
    const runner = vi.fn(async () => ({ state: "done" as const, output: "review evidence", turns: 1, usage: emptyUsage() }));
    const h = harness(() => runner, undefined, undefined, { createModelRuntime: createRuntime, accountCommand, profiles: BUILTIN_WORKER_PROFILES });
    const go = { provider: "opencode-go", id: "deepseek-v4.1-flash", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1", input: ["text"] };
    h.ctx.model = go;
    const registry = { find: (provider: string) => provider === "opencode-go" ? go : undefined,
      getAll: () => [go], getAvailable: () => [go], hasConfiguredAuth: (model: any) => model.provider === "opencode-go",
      isUsingOAuth: () => false, getProvider: () => ({ streamSimple() {} }) };
    h.ctx.modelRegistry = registry;
    const selector = kind === "explicit-model" ? { model: "openai-codex/gpt-6.1-sol" }
      : kind === "explicit-profile" ? { profile: "steak-pi/gpt-6-1-sol" } : {};
    const result = await h.tools.get("ultraterm_subagents").execute("go-sol", { goal: "bounded review", ...selector,
      tasks: [{ label: "Review", task: "Inspect only", role: "reviewer" }] }, undefined, undefined, h.ctx);
    expect(result.details.run.model).toBe(kind === "opus-first" ? "claude-code/claude-opus-5-5" : "openai-codex/gpt-6.1-sol");
    // A no-Claude fallback is automatic, never an operator-requested `override`; explicit routes stay `override`.
    expect(result.details.run.selection.source).toBe(kind === "claude-unavailable" ? "automatic-review-fallback" : kind === "opus-first" ? "automatic-review" : "override");
    expect(createRuntime).toHaveBeenCalledWith(isolatedAgentPaths(isolatedCodexAgentDir("fallback")));
    expect(registry.getAll()).toEqual([go]);
    expect(registry.isUsingOAuth()).toBe(false);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });
});

// Quota routing: an implicit wave used to resolve Go or Sol without asking the account router, the worker's
// router refusal surfaced only at launch (turns=0) and the parent was told `Started`. Every fixture below is a
// router `status` shape; nothing is credential-bearing.
describe("quota-aware implicit routing and synchronous launch failure", () => {
  const NOW = 1_793_164_649;
  const SOL_ROUTE = "openai-codex/gpt-6.1-sol";
  const GO_ROUTE = "opencode-go/deepseek-v4.1-flash";
  const OPUS_ROUTE = "claude-code/claude-opus-5-5";
  const solModel = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] };
  const goModel = { provider: "opencode-go", id: "deepseek-v4.1-flash", api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1", input: ["text"] };
  // A profile default that names the exact Sol profile instead of the automatic Go -> Sol chain.
  const solFirstProfiles = BUILTIN_WORKER_PROFILES.map(profile => profile.model === SOL_ROUTE ? { ...profile, workerDefault: { profile: profile.id } } : profile);
  const cooling = (id: string, label: string) => ({
    configured: true, eligible: false, id, label, state: "cooling-down", stateText: "cooling down until Mon 02:59", ineligibleReason: "cooling down",
    cooldown: { kind: "usage", reason: "a plan usage window is at 100%", source: "usage", until: NOW + 434_000 }, resetAt: NOW + 434_000,
    usedPercent: 100, windows: [{ name: "Weekly", resetAt: NOW + 434_000, usedPercent: 100 }],
  });
  const usable = (id: string, label: string) => ({ configured: true, eligible: true, id, label, state: "balancing", usageKnown: true, usedPercent: 10, windows: [] });
  const busy = (id: string, label: string) => ({ configured: true, eligible: false, id, label, state: "balancing", leases: 64, limit: 64, ineligibleReason: "all slots busy", windows: [] });
  const proven = (id: string, label: string) => ({ configured: true, eligible: false, id, label, ineligibleReason: "signed out", windows: [] });
  const status = (providers: { codex?: unknown[]; go?: unknown[]; claude?: unknown[] }) => ({
    ok: true, time: NOW,
    providers: {
      ...(providers.codex ? { codex: { accounts: providers.codex } } : {}),
      ...(providers.go ? { "opencode-go": { accounts: providers.go } } : {}),
      ...(providers.claude ? { claude: { accounts: providers.claude } } : {}),
    },
  });
  const solOut = [cooling("primary", "GPT 1"), cooling("fallback", "GPT 2")];
  const solUp = [usable("primary", "GPT 1")];
  const goOut = [cooling("primary", "Go 1"), cooling("b", "Go 2")];
  const goUp = [usable("primary", "Go 1"), usable("b", "Go 2")];
  const claudeUp = [usable("primary", "Claude 1"), usable("b", "Claude 2")];
  const claudeOut = [proven("primary", "Claude 1"), proven("b", "Claude 2")];
  const done = () => vi.fn(async (_context: Parameters<WorkerRunner>[0]): ReturnType<WorkerRunner> => ({ state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() }));

  function quotaHarness(answer: unknown, runner: ReturnType<typeof done>, overrides: Partial<UltratermSubagentsDependencies> = {}, durable?: { root: string; parent: string; prefix: string }) {
    // Claude accounts the dispatch asked the router to select (`select --provider claude --account <id>`).
    const selected: string[] = [];
    const accountCommand = vi.fn(async (args: string[]) => {
      if (args[0] === "select" && args[2] === "claude") {
        selected.push(args[4]);
        return syntheticClaudeSelection(args[4] as "primary" | "b");
      }
      if (args[0] !== "status") throw new Error(`unexpected router command ${args[0]}`);
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const h = harness(() => runner, durable, undefined, { accountCommand: accountCommand as never, profiles: BUILTIN_WORKER_PROFILES, ...overrides });
    const models = [solModel, goModel];
    h.ctx.modelRegistry = {
      find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
      getAll: () => models, getAvailable: () => models, hasConfiguredAuth: () => true,
      isUsingOAuth: (candidate: { provider: string }) => candidate.provider === "openai-codex",
      getProvider: () => ({ streamSimple() {} }),
    };
    return { h, accountCommand, selected };
  }
  const dispatch = (h: ReturnType<typeof harness>, params: Record<string, unknown>) =>
    h.tools.get("ultraterm_subagents").execute("quota", { goal: "Quota routing", ...params }, undefined, undefined, h.ctx);
  const plain = [{ label: "scout", task: "Read the routing module and report", role: "scout" }];
  const shutdown = (h: ReturnType<typeof harness>) => h.handlers.get("session_shutdown")!({}, h.ctx);

  describe("quota preflight for an implicit route", () => {
    it("does not select an exhausted Go: the default chain continues to Sol", async () => {
      const runner = done();
      const { h, accountCommand } = quotaHarness(status({ codex: solUp, go: goOut, claude: claudeUp }), runner);
      try {
        const result = await dispatch(h, { tasks: [{ label: "leaf", task: "Implement the leaf" }] });
        expect(result.details.run.model).toBe(SOL_ROUTE);
        expect(result.details.run.selection).toMatchObject({ provider: "openai-codex", source: "chain", chainRoutes: [GO_ROUTE, SOL_ROUTE] });
        expect(result.details.run.selection.fallbackReason).toMatch(/OpenCode Go: every Go account is unavailable \(Go 1: cooling down until Mon 02:59; Go 2: cooling down until Mon 02:59\)/);
        expect(result.content[0].text).toMatch(/Route note: OpenCode Go: every Go account is unavailable.*continues down the default chain on openai-codex\/gpt-6\.1-sol/);
        expect(runner.mock.calls[0][0].run.model).toBe(SOL_ROUTE);
        expect(accountCommand.mock.calls).toEqual([[["status"]]]);
      } finally { await shutdown(h); }
    });

    it("does not select an exhausted Sol named by the profile default: the default chain continues to Go", async () => {
      const runner = done();
      const { h, accountCommand } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeUp }), runner, { profiles: solFirstProfiles as never });
      try {
        const result = await dispatch(h, { tasks: [{ label: "leaf", task: "Implement the leaf" }] });
        expect(result.details.run.model).toBe(GO_ROUTE);
        expect(result.details.run.selection).toMatchObject({ provider: "opencode-go", source: "chain", chainRoutes: [GO_ROUTE, SOL_ROUTE] });
        expect(result.details.run.selection.fallbackReason).toMatch(/GPT-6\.1 Sol: every GPT account is unavailable \(GPT 1: cooling down until Mon 02:59; GPT 2: cooling down until Mon 02:59\)/);
        expect(result.content[0].text).toMatch(/Route note: GPT-6\.1 Sol: every GPT account is unavailable.*continues down the default chain on opencode-go\/deepseek-v4\.1-flash/);
        expect(accountCommand.mock.calls).toEqual([[["status"]]]);
      } finally { await shutdown(h); }
    });

    it.each([
      ["a plain read/scout leaf", { tasks: plain }, "claude-code/claude-haiku-5-5", /^Haiku 5\.5: ordinary leaves/],
      ["a worker leaf that edits without a shell", { tasks: [{ label: "doc", task: "Edit the doc", role: "worker", mayEdit: true, ownedPaths: ["docs/x.md"] }] }, "claude-code/claude-haiku-5-5", /ordinary leaves/],
      ["a mayEdit + allowBash leaf", { tasks: [{ label: "build", task: "Implement and test", role: "worker", mayEdit: true, ownedPaths: ["src/x.ts"], allowBash: true }] }, "claude-code/claude-sonnet-5-5", /^Sonnet 5\.5: substantial code work/],
      ["a requested xhigh effort", { tasks: plain, thinking: "xhigh", thinkingReason: "Cross-module reasoning is required here" }, "claude-code/claude-sonnet-5-5", /thinking xhigh was requested/],
    ])("falls to the claude-code subscription route for %s when Go and Sol are both exhausted", async (_name, wave, expected, tierText) => {
      const runner = done();
      const { h, selected } = quotaHarness(status({ codex: solOut, go: goOut, claude: claudeUp }), runner);
      try {
        const result = await dispatch(h, wave);
        const run = result.details.run;
        expect(run).toMatchObject({ model: expected, harness: "claude-code", thinkingLevel: "xhigh", claudeAccount: "primary" });
        expect(runner.mock.calls[0][0].run.claudeAccount).toBe("primary"); // pinned on an account the snapshot shows eligible
        expect(selected).toEqual(["primary"]);
        expect(run.model.startsWith("claude-code/")).toBe(true); // never the paid claude-code-api route
        expect(run.selection).toMatchObject({ provider: "claude-code", source: "chain", independence: "requires-opus", chainRoutes: [GO_ROUTE, SOL_ROUTE, expected] });
        expect(run.selection.fallbackReason).toMatch(tierText);
        expect(run.selection.fallbackReason).toMatch(/OpenCode Go: every Go account is unavailable.*GPT-6\.1 Sol: every GPT account is unavailable/);
        expect(result.content[0].text).toMatch(/Route note: neither OpenCode Go nor GPT-6\.1 Sol could launch/);
        expect(result.content[0].text).toContain(`work needs verification: review it with an Opus 5.5 reviewer wave (all-reviewer waves default to model ${OPUS_ROUTE})`);
        expect(result.content[0].text).toContain(`${expected.endsWith("haiku-5-5") ? "Haiku" : "Sonnet"} 5.5 work needs verification`);
        expect(renderRunResult(run)).toContain("tier: requires Opus 5.5 verification");
        expect(runner.mock.calls[0][0].run).toMatchObject({ model: expected, harness: "claude-code", thinkingLevel: "xhigh" });
        expect(run.tasks[0].apiReceipt).toBeUndefined();
      } finally { await shutdown(h); }
    });

    it("treats an unconfigured Go like an exhausted one", async () => {
      const runner = done();
      const { h } = quotaHarness(status({ codex: solOut, go: [], claude: claudeUp }), runner);
      try {
        const result = await dispatch(h, { tasks: plain });
        expect(result.details.run.model).toBe("claude-code/claude-haiku-5-5");
        expect(result.details.run.selection.fallbackReason).toMatch(/OpenCode Go: Go has no configured account in the provider account router/);
      } finally { await shutdown(h); }
    });

    it.each([
      ["Go with one usable account", status({ codex: solOut, go: [cooling("primary", "Go 1"), usable("b", "Go 2")] })],
      ["Go busy at its session limit", status({ codex: solOut, go: [busy("primary", "Go 1"), busy("b", "Go 2")] })],
      ["an unreadable router", new Error("spawn ut-provider-accounts ENOENT")],
      ["a router that omits Go", status({ codex: solOut })],
    ])("keeps Go for %s: busy and unknown are not exhaustion", async (_name, answer) => {
      const runner = done();
      const { h } = quotaHarness(answer, runner);
      try {
        const result = await dispatch(h, { tasks: plain });
        expect(result.details.run.model).toBe(GO_ROUTE);
        expect(result.details.run.selection).toMatchObject({ source: "chain", provider: "opencode-go" });
        expect(result.details.run.selection.fallbackReason).toBeUndefined();
        expect(result.content[0].text).not.toContain("Route note");
      } finally { await shutdown(h); }
    });

    it("refuses synchronously, naming every cause, when no route can launch", async () => {
      const runner = done();
      const { h } = quotaHarness(status({ codex: solOut, go: goOut, claude: claudeOut }), runner);
      try {
        await expect(dispatch(h, { tasks: plain })).rejects.toThrow(
          /no route that can launch this wave \(OpenCode Go: every Go account is unavailable \(Go 1: cooling down until Mon 02:59; Go 2: cooling down until Mon 02:59\).*\| GPT-6\.1 Sol: every GPT account is unavailable \(GPT 1: cooling down.*\| Claude subscription tier: every Claude account is ineligible \(Claude 1: signed out; Claude 2: signed out\)\)\. No route was started and no fallback was selected/);
        expect(runner).not.toHaveBeenCalled();
        const list = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
        expect(list.details.runs).toEqual([]);
        expect(h.messages).toEqual([]);
      } finally { await shutdown(h); }
    });

    it("serves from Sol without touching Claude when Sol still launches, even if every Claude account is out", async () => {
      const runner = done();
      const { h, selected } = quotaHarness(status({ codex: solUp, go: goOut, claude: claudeOut }), runner);
      try {
        const result = await dispatch(h, { tasks: plain });
        expect(result.details.run.model).toBe(SOL_ROUTE);
        expect(runner.mock.calls[0][0].run.claudeAccount).toBeUndefined();
        expect(selected).toEqual([]); // Claude is not consulted for the route
      } finally { await shutdown(h); }
    });

    it.each([
      ["Claude 1 cooling down, Claude 2 eligible", [cooling("primary", "Claude 1"), usable("b", "Claude 2")], "b", "primary", "Claude 2"],
      ["Claude 1 eligible, Claude 2 cooling down", [usable("primary", "Claude 1"), cooling("b", "Claude 2")], "primary", "b", "Claude 1"],
      ["Claude 1 busy, Claude 2 eligible", [busy("primary", "Claude 1"), usable("b", "Claude 2")], "b", "primary", "Claude 2"],
      ["Claude 1 signed out, Claude 2 eligible", [proven("primary", "Claude 1"), usable("b", "Claude 2")], "b", "primary", "Claude 2"],
    ])("never passes a proven-ineligible Claude account: %s -> the worker runs on the eligible one", async (_name, claude, account, skipped, label) => {
      const runner = done();
      const { h, selected } = quotaHarness(status({ codex: solOut, go: goOut, claude }), runner);
      try {
        const result = await dispatch(h, { tasks: plain });
        // The account the worker actually launched with, not just the route.
        expect(runner.mock.calls[0][0].run).toMatchObject({ harness: "claude-code", model: "claude-code/claude-haiku-5-5", claudeAccount: account });
        expect(result.details.run.claudeAccount).toBe(account);
        expect(selected).toEqual([account]);
        expect(selected).not.toContain(skipped);
        expect(result.content[0].text).toContain(`Claude account: ${label}`);
        expect(result.details.run.selection.fallbackReason).toContain(`Claude account ${label}`);
      } finally { await shutdown(h); }
    });

    it.each([
      ["Claude 2 has the lighter window", 60, 20, "b"],
      ["Claude 1 has the lighter window", 15, 70, "primary"],
      ["equal windows keep router order", 30, 30, "primary"],
    ])("balances across eligible Claude accounts by the least-used window: %s", async (_name, primaryUsed, bUsed, account) => {
      const runner = done();
      const claude = [{ ...usable("primary", "Claude 1"), usedPercent: primaryUsed }, { ...usable("b", "Claude 2"), usedPercent: bUsed }];
      const { h, selected } = quotaHarness(status({ codex: solOut, go: goOut, claude }), runner);
      try {
        await dispatch(h, { tasks: plain });
        expect(runner.mock.calls[0][0].run.claudeAccount).toBe(account);
        expect(selected).toEqual([account]);
      } finally { await shutdown(h); }
    });

    it("refuses with the cause when the router lists Claude accounts but none is reported eligible", async () => {
      const runner = done();
      const unreported = [{ configured: true, id: "primary", label: "Claude 1", windows: [] }, cooling("b", "Claude 2")];
      const { h, selected } = quotaHarness(status({ codex: solOut, go: goOut, claude: unreported }), runner);
      try {
        await expect(dispatch(h, { tasks: plain })).rejects.toThrow(
          /Claude subscription tier: the router shows no eligible Claude account \(Claude 1: the router did not report it eligible; Claude 2: cooling down until Mon 02:59\)\)\. No route was started and no fallback was selected/);
        expect(runner).not.toHaveBeenCalled();
        expect(selected).toEqual([]);
      } finally { await shutdown(h); }
    });

    it("names the account and the router's refusal when the router will not select the picked account", async () => {
      const runner = done();
      const { h, accountCommand } = quotaHarness(status({ codex: solOut, go: goOut, claude: claudeUp }), runner);
      const answer = accountCommand.getMockImplementation()!;
      accountCommand.mockImplementation(async (args: string[]) => {
        if (args[0] === "select") throw new Error("Claude 1 is cooling down");
        return answer(args);
      });
      try {
        await expect(dispatch(h, { tasks: plain })).rejects.toThrow(
          /picked Claude 1 for the Haiku 5\.5 tier, but the router would not select it now \(Claude 1 is cooling down\)\. No worker was started and no fallback was selected/);
        expect(runner).not.toHaveBeenCalled();
      } finally { await shutdown(h); }
    });

    it("refuses, naming the effort, when the Claude tier is needed but a non-xhigh effort was requested", async () => {
      const runner = done();
      const { h } = quotaHarness(status({ codex: solOut, go: goOut, claude: claudeUp }), runner);
      try {
        await expect(dispatch(h, { tasks: plain, thinking: "high", thinkingReason: "Careful reasoning is needed for this leaf" }))
          .rejects.toThrow(/Claude subscription tier: the Claude subscription tier runs only at xhigh effort and thinking high is not silently overridden/);
        expect(runner).not.toHaveBeenCalled();
      } finally { await shutdown(h); }
    });

    it("refuses an implicit review synchronously when Claude is ineligible and the Sol review fallback is exhausted", async () => {
      const runner = done();
      const { h } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeOut }), runner);
      try {
        await expect(dispatch(h, { tasks: [{ label: "review", task: "Review", role: "reviewer" }] }))
          .rejects.toThrow(/implicit review cannot run: Claude subscription tier: every Claude account is ineligible.*GPT-6\.1 Sol review fallback: every GPT account is unavailable/);
        expect(runner).not.toHaveBeenCalled();
      } finally { await shutdown(h); }
    });

    it("keeps Haiku an internal tier: an explicit Haiku route is refused like any unlisted model", async () => {
      const runner = done();
      const { h } = quotaHarness(status({ codex: solOut }), runner);
      try {
        await expect(dispatch(h, { harness: "claude-code", model: "claude-code/claude-haiku-5-5", tasks: plain }))
          .rejects.toThrow(/runs only claude-code\/claude-sonnet-5-5 or claude-code\/claude-opus-5-5/);
        expect(runner).not.toHaveBeenCalled();
      } finally { await shutdown(h); }
    });

    describe("a Go parent whose own store has no Codex login", () => {
      const sol = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text"] } as any;
      const isolatedRuntime = () => ({ getModel: (provider: string) => provider === "openai-codex" ? sol : undefined, getModels: () => [sol], getAvailableSnapshot: () => [sol],
        hasConfiguredAuth: () => true, isUsingOAuth: () => true, getProvider: () => ({ streamSimple() {} }) }) as unknown as ModelRuntime;
      function goParent(answer: unknown) {
        const createRuntime = vi.fn(async () => isolatedRuntime());
        const runner = done();
        const base = quotaHarness(answer, runner, { createModelRuntime: createRuntime });
        const status = base.accountCommand.getMockImplementation()!;
        base.accountCommand.mockImplementation(async (args: string[]) => args[0] === "select" && args[2] === "codex"
          ? { ok: true, account: { id: "fallback", agentDir: isolatedCodexAgentDir("fallback") } } : status(args));
        base.h.ctx.model = goModel;
        const registry = { find: (provider: string) => provider === "opencode-go" ? goModel : undefined, getAll: () => [goModel], getAvailable: () => [goModel],
          hasConfiguredAuth: (model: any) => model.provider === "opencode-go", isUsingOAuth: () => false, getProvider: () => ({ streamSimple() {} }) };
        base.h.ctx.modelRegistry = registry;
        return { ...base, createRuntime, runner, registry };
      }

      it("continues from an exhausted Go to Sol on the isolated Codex store, without registering Codex auth in the Go registry", async () => {
        const { h, createRuntime, runner, registry } = goParent(status({ codex: solUp, go: goOut, claude: claudeUp }));
        try {
          const result = await dispatch(h, { tasks: plain });
          expect(result.details.run.model).toBe(SOL_ROUTE);
          expect(result.details.run.selection).toMatchObject({ source: "chain", chainRoutes: [GO_ROUTE, SOL_ROUTE] });
          expect(result.details.run.selection.fallbackReason).toMatch(/OpenCode Go: every Go account is unavailable/);
          expect(createRuntime).toHaveBeenCalledWith(isolatedAgentPaths(isolatedCodexAgentDir("fallback")));
          expect(runner.mock.calls[0][0].run.model).toBe(SOL_ROUTE);
          expect(registry.getAll()).toEqual([goModel]);
        } finally { await shutdown(h); }
      });

      it("goes straight to the Claude tier, never opening the Codex store, when Sol is exhausted too", async () => {
        const { h, createRuntime } = goParent(status({ codex: solOut, go: goOut, claude: claudeUp }));
        try {
          const result = await dispatch(h, { tasks: plain });
          expect(result.details.run.model).toBe("claude-code/claude-haiku-5-5");
          expect(createRuntime).not.toHaveBeenCalled();
        } finally { await shutdown(h); }
      });

      it("keeps Go, and never opens the Codex store, while Go can launch", async () => {
        const { h, createRuntime } = goParent(status({ codex: solUp, go: goUp, claude: claudeUp }));
        try {
          const result = await dispatch(h, { tasks: plain });
          expect(result.details.run.model).toBe(GO_ROUTE);
          expect(createRuntime).not.toHaveBeenCalled();
        } finally { await shutdown(h); }
      });
    });
  });

  describe("explicit routes stay exact", () => {
    it.each([
      ["Sol by model", { model: SOL_ROUTE }, status({ codex: solOut, go: goUp, claude: claudeUp }), SOL_ROUTE, /every GPT account is unavailable \(GPT 1: cooling down until Mon 02:59; GPT 2: cooling down until Mon 02:59\)/],
      ["Sol by profile", { profile: "steak-pi/gpt-6-1-sol" }, status({ codex: solOut, go: goUp, claude: claudeUp }), SOL_ROUTE, /every GPT account is unavailable/],
      ["Go by model", { model: GO_ROUTE }, status({ codex: solUp, go: goOut, claude: claudeUp }), GO_ROUTE, /every Go account is unavailable/],
      ["the chain head, named only by harness", { harness: "pi" }, status({ codex: solUp, go: goOut, claude: claudeUp }), GO_ROUTE, /every Go account is unavailable/],
    ])("refuses an exhausted provider synchronously with the router cause and never reroutes (%s)", async (_name, selector, answer, route, cause) => {
      const runner = done();
      const { h, accountCommand } = quotaHarness(answer, runner);
      try {
        const attempt = dispatch(h, { ...selector, tasks: plain });
        await expect(attempt).rejects.toThrow(new RegExp(`USAP explicit route ${route.replace(/[./]/g, "\\$&")} cannot launch: `));
        await expect(attempt).rejects.toThrow(cause);
        await expect(attempt).rejects.toThrow(/Explicit routes are never rerouted, so no worker was started and no fallback was selected/);
        expect(runner).not.toHaveBeenCalled();
        expect(accountCommand.mock.calls.every(([args]) => args[0] === "status")).toBe(true);
        const list = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
        expect(list.details.runs).toEqual([]);
      } finally { await shutdown(h); }
    });

    it("still launches an explicit route whose provider is merely busy or unreadable", async () => {
      const runner = done();
      const busyGo = quotaHarness(status({ go: [busy("primary", "Go 1"), busy("b", "Go 2")] }), runner);
      try {
        const result = await dispatch(busyGo.h, { model: GO_ROUTE, tasks: plain });
        expect(result.details.run).toMatchObject({ model: GO_ROUTE });
        expect(result.details.run.selection.source).toBe("override");
      } finally { await shutdown(busyGo.h); }
      const unreadable = quotaHarness(new Error("router offline"), runner);
      try {
        const result = await dispatch(unreadable.h, { model: SOL_ROUTE, tasks: plain });
        expect(result.details.run).toMatchObject({ model: SOL_ROUTE });
      } finally { await shutdown(unreadable.h); }
    });
  });

  describe("a worker that fails before its first model output fails the dispatch", () => {
    // A plain route failure, not a quota cause: these tests are about the startup gate itself (cancel, durable
    // delivery, the window), so the failure must be one the gate surfaces and never falls through on.
    const cause = "Reserved Codex account has no exact Sol model with configured OAuth authentication";
    const refused = () => vi.fn(async (_context: Parameters<WorkerRunner>[0]) => ({ state: "failed" as const, output: "", turns: 0, usage: emptyUsage(), error: cause }));
    const two = [{ label: "one", task: "First leaf" }, { label: "two", task: "Second leaf" }];
    type Settled = Awaited<ReturnType<WorkerRunner>>;
    const idleUntilAborted = (signal: AbortSignal, turns = 0) =>
      new Promise<Settled>((resolve) => signal.addEventListener("abort", () => resolve({ state: "aborted", output: "", turns, usage: emptyUsage(), error: String(signal.reason?.message ?? "cancelled") }), { once: true }));
    // What both real workers report once the model has answered: the launch-proof a dispatch waits for.
    const streaming = () => vi.fn(async ({ onProgress, signal }: Parameters<WorkerRunner>[0]) => {
      onProgress({ turns: 1, outputStarted: true });
      return await idleUntilAborted(signal, 1);
    });
    const startupMessage = (promise: Promise<unknown>) => promise.then(() => "", (error: Error) => error.message);
    const runIdOf = (message: string) => /\(run (\S+) · /.exec(message)![1];
    const durableAt = (prefix: string) => {
      const root = mkdtempSync(join(tmpdir(), "usap-startup-")); dirs.push(root);
      return { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix };
    };

    it.each([true, false])("rejects with the named cause and records it on the run (background=%s)", async (background) => {
      const runner = refused();
      const h = harness(() => runner, undefined, undefined, { startupWindowMs: 2_000 });
      try {
        const attempt = dispatch(h, { background, tasks: two });
        await expect(attempt).rejects.toThrow(/USAP dispatch failed before any worker produced model output \(run run-fixed-\d+ · /);
        await expect(attempt).rejects.toThrow(new RegExp(`\\[one\\] ${cause.replace(/[()]/g, "\\$&")}`));
        await expect(attempt).rejects.toThrow(/The run record is failed with these causes and no worker is left running\. No fallback was selected/);
        const runId = runIdOf(String(await attempt.catch((error: Error) => error.message)));
        const recorded = await h.tools.get("ultraterm_hub").execute("status", { action: "status", runId }, undefined, undefined, h.ctx);
        expect(recorded.details.run.state).toBe("failed");
        expect(recorded.details.run.tasks.some((task: any) => task.state === "failed" && String(task.error).includes(cause))).toBe(true);
        await flush();
        expect(h.messages).toEqual([]); // the thrown error is the one notification: no completion chatter follows
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("cancels a healthy sibling instead of leaving half a wave running, and says why", async () => {
      const runner = vi.fn(async ({ task, signal }: Parameters<WorkerRunner>[0]) => task.label === "bad"
        ? { state: "failed" as const, output: "", turns: 0, usage: emptyUsage(), error: cause }
        : await idleUntilAborted(signal));
      const h = harness(() => runner, undefined, undefined, { startupWindowMs: 2_000 });
      try {
        const message = await startupMessage(dispatch(h, { background: true, tasks: [{ label: "ok", task: "Healthy leaf" }, { label: "bad", task: "Doomed leaf" }] }));
        expect(message).toContain("[bad]");
        expect(message).toContain("no worker is left running");
        const recorded = await h.tools.get("ultraterm_hub").execute("status", { action: "status", runId: runIdOf(message) }, undefined, undefined, h.ctx);
        const byLabel = Object.fromEntries(recorded.details.run.tasks.map((task: any) => [task.label, task]));
        expect(byLabel.bad.state).toBe("failed");
        expect(byLabel.ok.state).toBe("aborted");
        expect(String(byLabel.ok.error)).toMatch(/Run cancelled: worker .* failed before its first model output/);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("does not claim a sibling was cancelled when it had not stopped inside the settle wait, and names it", async () => {
      vi.useFakeTimers();
      let release = () => {};
      const runner = vi.fn(async ({ task }: Parameters<WorkerRunner>[0]) => task.label === "bad"
        ? { state: "failed" as const, output: "", turns: 0, usage: emptyUsage(), error: cause }
        // A worker that ignores the cancel until the test releases it: it cannot settle inside the wait.
        : await new Promise<Settled>((resolve) => { release = () => resolve({ state: "aborted", output: "", turns: 0, usage: emptyUsage(), error: "released late" }); }));
      const h = harness(() => runner, undefined, undefined, { startupWindowMs: 2_000 });
      try {
        const attempt = startupMessage(dispatch(h, { background: true, tasks: [{ label: "stuck", task: "Ignores cancel" }, { label: "bad", task: "Doomed leaf" }] }));
        await vi.advanceTimersByTimeAsync(5_100);
        const message = await attempt;
        expect(message).toContain("[bad]");
        expect(message).toMatch(/Cancellation was requested for the whole run, but \[stuck\] had not stopped within 5000 ms and may still be shutting down; the run record is still running \(inspect it with ultraterm_hub status /);
        expect(message).not.toMatch(/no worker is left running|every sibling|nothing was left running/);
        // Its late settlement queues no completion either: the thrown error was the one notification.
        release();
        await vi.advanceTimersByTimeAsync(50);
        await flush();
        expect(h.messages).toEqual([]);
      } finally { release(); await vi.advanceTimersByTimeAsync(50); await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("reports Started once every launched worker produced output, without waiting out the window", async () => {
      const runner = streaming();
      const h = harness(() => runner, undefined, undefined, { startupWindowMs: 5_000 });
      const began = Date.now();
      try {
        const started = await dispatch(h, { background: true, tasks: two });
        expect(Date.now() - began).toBeLessThan(2_500);
        expect(started.content[0].text).toMatch(/Started USAP run run-fixed-\d+/);
        expect(started.details.run.state).toBe("running");
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("stops waiting at the bounded window for a worker that is still launching, and reports Started", async () => {
      const runner = vi.fn(async ({ signal }: Parameters<WorkerRunner>[0]) => await idleUntilAborted(signal));
      const h = harness(() => runner, undefined, undefined, { startupWindowMs: 60 });
      const began = Date.now();
      try {
        const started = await dispatch(h, { background: true, tasks: [{ label: "slow", task: "Slow leaf" }] });
        expect(Date.now() - began).toBeGreaterThanOrEqual(50);
        expect(started.content[0].text).toMatch(/Started USAP run run-fixed-\d+/);
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("does not treat a failure after model output as a launch failure", async () => {
      const failedLater = vi.fn(async ({ onProgress }: Parameters<WorkerRunner>[0]) => {
        onProgress({ turns: 2, outputStarted: true });
        return { state: "failed" as const, output: "partial", turns: 2, usage: emptyUsage(), error: "tests failed" };
      });
      const h = harness(() => failedLater, undefined, undefined, { startupWindowMs: 2_000 });
      try {
        const result = await dispatch(h, { tasks: [{ label: "late", task: "Fails on turn two" }] });
        expect(result.details.run.state).toBe("failed");
        expect(result.content[0].text).toContain("[late] failed");
      } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
    });

    it("rejects an invalid startup window at construction", () => {
      for (const startupWindowMs of [-1, 1.5, 30_001, Number.NaN]) {
        expect(() => harness(() => done(), undefined, undefined, { startupWindowMs })).toThrow(/startupWindowMs must be a safe integer from 0 to 30000/);
      }
    });

    describe("a real, nonzero startup window", () => {
      // Fake timers drive the window itself; the worker settles `failed` with no output after `delayMs`.
      const failsAfter = (delayMs: number) => vi.fn(async (_context: Parameters<WorkerRunner>[0]) => {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        return { state: "failed" as const, output: "", turns: 0, usage: emptyUsage(), error: cause };
      });

      it("rejects with the cause for a failure just inside the window", async () => {
        vi.useFakeTimers();
        const h = harness(() => failsAfter(900), undefined, undefined, { startupWindowMs: 1_000 });
        try {
          const attempt = startupMessage(dispatch(h, { background: true, tasks: [{ label: "late", task: "Fails just inside" }] }));
          await vi.advanceTimersByTimeAsync(950);
          expect(await attempt).toContain(`[late] ${cause}`);
          await flush();
          expect(h.messages).toEqual([]);
        } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
      });

      it("reports Started for a failure just past the window, then delivers it once as the ordinary completion", async () => {
        vi.useFakeTimers();
        const h = harness(() => failsAfter(1_100), undefined, undefined, { startupWindowMs: 1_000 });
        try {
          const attempt = dispatch(h, { background: true, tasks: [{ label: "late", task: "Fails just past" }] });
          await vi.advanceTimersByTimeAsync(1_050);
          const started = await attempt; // resolved, not rejected: the window closed first
          expect(started.content[0].text).toMatch(/Started USAP run run-fixed-\d+/);
          expect(h.messages).toEqual([]);
          await vi.advanceTimersByTimeAsync(100);
          await flush();
          expect(h.messages).toHaveLength(1);
          expect(h.messages[0].message.content).toMatch(/1\/1 settled · failed/);
          const runId = /Started USAP run (\S+) /.exec(started.content[0].text)![1];
          const recorded = await h.tools.get("ultraterm_hub").execute("status", { action: "status", runId }, undefined, undefined, h.ctx);
          expect(recorded.details.run.tasks[0]).toMatchObject({ state: "failed", error: cause });
        } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
      });

      it("outlasts a slow router: the default window exceeds the router timeout plus the bind call, so the refusal still names its cause", async () => {
        expect(DEFAULT_STARTUP_WINDOW_MS).toBeGreaterThan(2 * GO_ACCOUNT_ROUTER_TIMEOUT_MS);
        vi.useFakeTimers();
        // A Sol worker's account phase: `reserve` answers at the router timeout, `bind` just under it,
        // and only then does the router's refusal fail the leaf: well past the old 8 s window.
        const accountPhaseMs = 2 * GO_ACCOUNT_ROUTER_TIMEOUT_MS - 1_000;
        const h = harness(() => failsAfter(accountPhaseMs), undefined, undefined, { startupWindowMs: undefined });
        try {
          let outcome: string | undefined;
          const attempt = startupMessage(dispatch(h, { background: true, tasks: [{ label: "sol", task: "Waits on a slow router" }] })).then((message) => { outcome = message || "started"; });
          await vi.advanceTimersByTimeAsync(accountPhaseMs - 500);
          expect(outcome).toBeUndefined(); // still inside its account phase: no `Started` has been reported
          await vi.advanceTimersByTimeAsync(1_000);
          await attempt;
          expect(outcome).toContain(`[sol] ${cause}`);
        } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
      });
    });

    describe("a failed background startup is delivered durably", () => {
      it("is not queued again after the session reloads its checkpoint store", async () => {
        const durable = durableAt("startup-fail");
        const mark = vi.spyOn(CheckpointStore.prototype, "markDelivered");
        const h = harness(() => refused(), durable, undefined, { startupWindowMs: 2_000 });
        let next: ReturnType<typeof harness> | undefined;
        try {
          const message = await startupMessage(dispatch(h, { background: true, tasks: two }));
          expect(message).toMatch(/failed before any worker produced model output/);
          const runId = runIdOf(message);
          await flush();
          expect(h.messages).toEqual([]);
          expect(mark).toHaveBeenCalledWith(runId);
          await h.handlers.get("session_shutdown")!({}, h.ctx);
          const reopened = vi.fn(async () => ({ state: "done" as const, output: "must not run", turns: 1, usage: emptyUsage() }));
          // No native receipt is supplied: only the committed delivered bit can stop the replay.
          next = harness(() => reopened, { ...durable, prefix: "reopened" });
          await next.handlers.get("session_start")!({}, next.ctx);
          await next.handlers.get("agent_settled")!({}, next.ctx);
          await flush();
          expect(next.messages).toEqual([]);
          expect(reopened).not.toHaveBeenCalled();
          const status = await next.tools.get("ultraterm_hub").execute("s", { action: "status", runId }, undefined, undefined, next.ctx);
          expect(status.details.run.state).toBe("failed"); // the run was adopted, so the silence is not vacuous
        } finally {
          mark.mockRestore();
          await h.handlers.get("session_shutdown")!({}, h.ctx);
          if (next) await next.handlers.get("session_shutdown")!({}, next.ctx);
        }
      });

      it("holds even when a sibling had not stopped inside the settle wait", async () => {
        vi.useFakeTimers();
        const durable = durableAt("startup-stuck");
        let release = () => {};
        const runner = vi.fn(async ({ task }: Parameters<WorkerRunner>[0]) => task.label === "bad"
          ? { state: "failed" as const, output: "", turns: 0, usage: emptyUsage(), error: cause }
          : await new Promise<Settled>((resolve) => { release = () => resolve({ state: "aborted", output: "", turns: 0, usage: emptyUsage(), error: "released late" }); }));
        const h = harness(() => runner, durable, undefined, { startupWindowMs: 2_000 });
        let next: ReturnType<typeof harness> | undefined;
        try {
          const attempt = startupMessage(dispatch(h, { background: true, tasks: [{ label: "stuck", task: "Ignores cancel" }, { label: "bad", task: "Doomed leaf" }] }));
          await vi.advanceTimersByTimeAsync(5_100);
          expect(await attempt).toContain("had not stopped within 5000 ms");
          release();
          await vi.advanceTimersByTimeAsync(50);
          await h.handlers.get("session_shutdown")!({}, h.ctx);
          next = harness(() => runner, { ...durable, prefix: "reopened" });
          await next.handlers.get("session_start")!({}, next.ctx);
          await next.handlers.get("agent_settled")!({}, next.ctx);
          await flush();
          expect(next.messages).toEqual([]);
        } finally {
          release();
          await h.handlers.get("session_shutdown")!({}, h.ctx);
          if (next) await next.handlers.get("session_shutdown")!({}, next.ctx);
        }
      });

      it("retries a failed delivered-mark write with the next save instead of losing it", async () => {
        const durable = durableAt("startup-retry");
        const originalMark = CheckpointStore.prototype.markDelivered;
        let failing = true;
        const mark = vi.spyOn(CheckpointStore.prototype, "markDelivered").mockImplementation(function (this: CheckpointStore, id) {
          if (failing) throw Object.assign(new Error("synthetic write failure"), { code: "ENOSPC", syscall: "write" });
          return originalMark.call(this, id);
        });
        const h = harness(() => refused(), durable, undefined, { startupWindowMs: 2_000 });
        let next: ReturnType<typeof harness> | undefined;
        try {
          const message = await startupMessage(dispatch(h, { background: true, tasks: [{ label: "one", task: "First leaf" }] }));
          expect(message).toMatch(/failed before any worker produced model output/);
          failing = false;
          await h.handlers.get("session_shutdown")!({}, h.ctx);
          next = harness(() => refused(), { ...durable, prefix: "reopened" });
          await next.handlers.get("session_start")!({}, next.ctx);
          await next.handlers.get("agent_settled")!({}, next.ctx);
          await flush();
          expect(next.messages).toEqual([]);
        } finally {
          failing = false;
          mark.mockRestore();
          await h.handlers.get("session_shutdown")!({}, h.ctx);
          if (next) await next.handlers.get("session_shutdown")!({}, next.ctx);
        }
      });
    });

    describe("a real Pi worker whose first request fails with no output", () => {
      const failedMessage = { role: "assistant", content: [], api: "test", provider: "test", model: "test", usage: emptyUsage(), stopReason: "error", errorMessage: "429 rate_limit_exceeded: too many requests", timestamp: Date.now() };
      /** The session Pi hands a worker: a turn starts, then the provider refuses the request. */
      function refusedSession() {
        const listeners = new Set<(event: any) => void>();
        const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
        return {
          isStreaming: false,
          subscribe(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
          async prompt() {
            emit({ type: "turn_start" });
            emit({ type: "message_start", message: failedMessage });
            emit({ type: "message_end", message: failedMessage });
            emit({ type: "turn_end", message: failedMessage, toolResults: [] });
          },
          async steer() {}, async abort() {}, dispose() {},
        };
      }
      /** A session that answers (first delta) and then keeps working until aborted. */
      function answeringSession() {
        const listeners = new Set<(event: any) => void>();
        let finish = () => {};
        return {
          isStreaming: false,
          subscribe(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
          async prompt() {
            const partial = { role: "assistant", content: [{ type: "text", text: "working" }], api: "test", provider: "test", model: "test", usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
            for (const event of [{ type: "turn_start" }, { type: "message_update", message: partial }]) for (const listener of listeners) listener(event);
            await new Promise<void>((resolve) => { finish = resolve; });
          },
          async steer() {}, async abort() { finish(); }, dispose() {},
        };
      }
      const piHarness = (session: () => unknown) => harness((relay) => createPiWorkerRunner({
        relay,
        resolveRuntime: () => ({ model: { provider: "test", id: "model" } as never, thinkingLevel: "off" }),
        sessionFactory: async () => ({ session: session() as never }),
      }), undefined, undefined, { startupWindowMs: 3_000 });

      it.each([true, false])("rejects the dispatch with the provider's cause, though its turn had started (background=%s)", async (background) => {
        const h = piHarness(refusedSession);
        try {
          const attempt = dispatch(h, { background, tasks: [{ label: "sol", task: "First request is refused" }] });
          await expect(attempt).rejects.toThrow(/USAP dispatch failed before any worker produced model output \(run run-fixed-\d+ · .*\[sol\] .*429 rate_limit_exceeded: too many requests/);
          const message = String(await attempt.catch((error: Error) => error.message));
          const recorded = await h.tools.get("ultraterm_hub").execute("status", { action: "status", runId: runIdOf(message) }, undefined, undefined, h.ctx);
          const [task] = recorded.details.run.tasks;
          expect(task).toMatchObject({ state: "failed" });
          expect(task.turns).toBeGreaterThanOrEqual(1); // the very case a turn counter cannot see
          await flush();
          expect(h.messages).toEqual([]);
        } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
      });

      it("reports Started as soon as the real worker streams its first output", async () => {
        const h = piHarness(answeringSession);
        const began = Date.now();
        try {
          const started = await dispatch(h, { background: true, tasks: [{ label: "sol", task: "Answers" }] });
          expect(Date.now() - began).toBeLessThan(2_500);
          expect(started.content[0].text).toMatch(/Started USAP run run-fixed-\d+/);
          expect(started.details.run.tasks[0].state).not.toBe("failed");
        } finally { await h.handlers.get("session_shutdown")!({}, h.ctx); }
      });
    });
  });

  // Go has no usage API, so a spent Go plan reads as an eligible account until its first request answers 429
  // GoUsageLimitError. An implicit wave must then re-run on the next tier by itself instead of failing with
  // "No fallback was selected".
  describe("an implicit wave refused on a usage limit before any output falls through to the next tier", () => {
    const HAIKU = "claude-code/claude-haiku-5-5";
    const SONNET = "claude-code/claude-sonnet-5-5";
    const GO_LIMIT = '429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}';
    const SOL_LIMIT = "The usage limit has been reached";
    const CLAUDE_LIMIT = "quota limit reached; resets Oct 29 at 5pm (UTC); check Claude usage and retry the same route only after reset";
    const build = [{ label: "build", task: "Implement and test", role: "worker", mayEdit: true, ownedPaths: ["src/x.ts"], allowBash: true }];
    type Context = Parameters<WorkerRunner>[0];
    const refusal = (error: string) => ({ state: "failed" as const, output: "", turns: 0, usage: emptyUsage(), error });
    /** A worker per route: a route in `refused` dies before any output with its text, every other route answers. */
    const routed = (refused: Record<string, string>) => vi.fn(async ({ run }: Context): ReturnType<WorkerRunner> => run.model in refused
      ? refusal(refused[run.model]) : { state: "done" as const, output: "ok", turns: 1, usage: emptyUsage() });
    const open = { startupWindowMs: 2_000 };
    const statusCalls = (accountCommand: { mock: { calls: unknown[][] } }) => accountCommand.mock.calls.filter(([args]) => (args as string[])[0] === "status").length;
    const recordOf = async (h: ReturnType<typeof harness>, runId: string) =>
      (await h.tools.get("ultraterm_hub").execute("status", { action: "status", runId }, undefined, undefined, h.ctx)).details.run;
    const durableRoot = (prefix: string) => {
      const root = mkdtempSync(join(tmpdir(), "usap-fall-through-")); dirs.push(root);
      return { root: join(root, "checkpoints"), parent: join(root, "parent.jsonl"), prefix };
    };
    const messageOf = (promise: Promise<unknown>) => promise.then(() => "", (error: Error) => error.message);

    it("an Esc during the next tier's router reads never launches it", async () => {
      const runner = routed({ [GO_ROUTE]: GO_LIMIT });
      const controller = new AbortController();
      const { h, accountCommand } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeUp }), runner, open);
      // Abort the moment the second tier asks the router for status, before it selects or launches anything.
      const real = accountCommand.getMockImplementation()!;
      let statuses = 0;
      accountCommand.mockImplementation(async (args: string[]) => {
        if (args[0] === "status" && ++statuses === 2) controller.abort();
        return real(args);
      });
      try {
        const message = await messageOf(h.tools.get("ultraterm_subagents").execute("t", { goal: "g", background: true, tasks: plain }, controller.signal, undefined, h.ctx));
        expect(message).toMatch(/cancelled before the fall-through to the next tier launched/);
        expect(runner.mock.calls.map(([context]) => context.run.model)).toEqual([GO_ROUTE]);
      } finally { await shutdown(h); }
    });

    describe.each([false, true])("Go refuses at its first request with GoUsageLimitError and Sol is out (background=%s)", (background) => {
      it.each([
        ["a plain scout leaf", plain, HAIKU, /^automatic fall-through after a usage-limit refusal before any output; Haiku 5\.5: ordinary leaves/],
        ["a mayEdit + allowBash leaf", build, SONNET, /^automatic fall-through after a usage-limit refusal before any output; Sonnet 5\.5: substantial code work/],
      ])("re-runs %s on its Claude tier with no parent re-dispatch", async (_name, wave, tier, reason) => {
        const runner = routed({ [GO_ROUTE]: GO_LIMIT });
        const { h, accountCommand, selected } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeUp }), runner, open);
        try {
          const result = await dispatch(h, { background, tasks: wave });
          // Exactly two launches from ONE tool call: Go (refused), then the Claude tier on the same tasks.
          expect(runner.mock.calls.map(([context]) => context.run.model)).toEqual([GO_ROUTE, tier]);
          expect(runner.mock.calls[1][0].run).toMatchObject({ harness: "claude-code", thinkingLevel: "xhigh", claudeAccount: "primary" });
          expect(runner.mock.calls[1][0].run.tasks.map((task) => [task.label, task.task])).toEqual(runner.mock.calls[0][0].run.tasks.map((task) => [task.label, task.task]));
          expect(selected).toEqual(["primary"]); // pinned to a router-eligible account
          expect(statusCalls(accountCommand)).toBe(2); // the second tier decided on a fresh router read
          // The failed first run is recorded failed, with its cause named, and its completion is not delivered.
          const first = await recordOf(h, "run-fixed-1");
          expect(first.state).toBe("failed");
          expect(first.model).toBe(GO_ROUTE);
          expect(first.tasks[0]).toMatchObject({ state: "failed" });
          expect(String(first.tasks[0].error)).toContain("GoUsageLimitError");
          // The second run's receipt names the fall-through and why.
          const second = background ? await recordOf(h, "run-fixed-2") : result.details.run;
          expect(second).toMatchObject({ model: tier, harness: "claude-code" });
          expect(second.selection).toMatchObject({ provider: "claude-code", source: "chain", independence: "requires-opus", chainRoutes: [GO_ROUTE, SOL_ROUTE, tier] });
          expect(second.selection.fallbackReason).toMatch(reason);
          expect(second.selection.fallbackReason).toMatch(/OpenCode Go: run run-fixed-1 was refused on a usage limit before any output \(\[[a-z]+\] 429: .*GoUsageLimitError.*Go usage limit exceeded/);
          expect(second.selection.fallbackReason).toMatch(/GPT-6\.1 Sol: every GPT account is unavailable/);
          const text = result.content[0].text;
          expect(text).toMatch(/Fall-through: run run-fixed-1 · opencode-go\/deepseek-v4\.1-flash was refused on a provider usage limit before any worker produced output \(\[[a-z]+\] 429: .*GoUsageLimitError.*\)\. The same tasks were re-run here on the next tier, with no parent re-dispatch\./);
          expect(text).toMatch(/Route note: neither OpenCode Go nor GPT-6\.1 Sol could launch/);
          if (background) {
            expect(text).toMatch(new RegExp(`Started USAP run run-fixed-2 · ${tier}`));
            await flush();
          } else {
            expect(result.details.run.state).toBe("done");
          }
          // One completion for the whole dispatch, never one for the refused first run.
          await expect.poll(() => h.messages.length).toBe(background ? 1 : 0);
          if (background) {
            expect(String(h.messages[0].message.content)).toContain("run-fixed-2");
            expect(String(h.messages[0].message.content)).not.toContain("run-fixed-1");
          }
          const list = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
          expect(list.details.runs.map((run: any) => [run.runId, run.state])).toEqual([["run-fixed-1", "failed"], ["run-fixed-2", "done"]]);
        } finally { await shutdown(h); }
      });

      it("fails synchronously naming both causes when the Claude tier is refused too, without claiming no fallback was tried", async () => {
        const runner = routed({ [GO_ROUTE]: GO_LIMIT, [HAIKU]: CLAUDE_LIMIT });
        const { h } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeUp }), runner, open);
        try {
          const message = await messageOf(dispatch(h, { background, tasks: plain }));
          expect(message).toMatch(/^USAP dispatch failed before any worker produced model output \(run run-fixed-2 · claude-code\/claude-haiku-5-5\): \[scout\] quota limit reached; resets Oct 29 at 5pm/);
          expect(message).toMatch(/This was the automatic fall-through after run run-fixed-1 · opencode-go\/deepseek-v4\.1-flash was refused on a provider usage limit before any worker produced output \(\[scout\] 429: .*GoUsageLimitError.*\): no further fall-through applies, so the dispatch fails with both causes\./);
          expect(message).not.toContain("No fallback was selected");
          expect(runner).toHaveBeenCalledTimes(2); // each tier once, never a loop
          const list = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
          expect(list.details.runs.map((run: any) => [run.runId, run.state])).toEqual([["run-fixed-1", "failed"], ["run-fixed-2", "failed"]]);
          await flush();
          expect(h.messages).toEqual([]); // the thrown error is the one notification
        } finally { await shutdown(h); }
      });

      it("fails synchronously naming both causes when no Claude account can take the next tier", async () => {
        const runner = routed({ [GO_ROUTE]: GO_LIMIT });
        const { h } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeOut }), runner, open);
        try {
          const message = await messageOf(dispatch(h, { background, tasks: plain }));
          expect(message).toMatch(/no route that can launch this wave \(OpenCode Go: run run-fixed-1 was refused on a usage limit before any output \(\[scout\] 429: .*GoUsageLimitError.*\) \| GPT-6\.1 Sol: every GPT account is unavailable.*\| Claude subscription tier: every Claude account is ineligible \(Claude 1: signed out; Claude 2: signed out\)\)\./);
          expect(message).toContain("The tier that launched was refused before any output (run run-fixed-1) and no further route was started");
          expect(message).not.toContain("no fallback was selected");
          expect(runner).toHaveBeenCalledTimes(1);
          expect((await recordOf(h, "run-fixed-1")).state).toBe("failed");
        } finally { await shutdown(h); }
      });
    });

    it("falls through when the router reads a spent Go plan as usable: GPT cooling down, Go usage unknown, Go answers GoUsageLimitError", async () => {
      // Go has no usage API: its accounts are eligible with no measured window, so the preflight selects it.
      const unknown = (id: string, label: string) => ({ configured: true, eligible: true, id, label, state: "balancing", usageKnown: false, windows: [] });
      const runner = routed({ [GO_ROUTE]: GO_LIMIT });
      const { h } = quotaHarness(status({ codex: solOut, go: [unknown("primary", "Go 1"), unknown("b", "Go 2")], claude: claudeUp }), runner, open);
      try {
        const result = await dispatch(h, { tasks: [{ label: "echo", task: "Reply pong", role: "scout" }] });
        expect(runner.mock.calls.map(([context]) => context.run.model)).toEqual([GO_ROUTE, HAIKU]);
        expect(result.details.run).toMatchObject({ model: HAIKU, state: "done" });
        expect(result.content[0].text).toContain("with no parent re-dispatch");
        expect(result.content[0].text).not.toContain("No fallback was selected");
      } finally { await shutdown(h); }
    });

    describe("the chain is walked once, in order", () => {
      it("Go refused with GoUsageLimitError falls through to Sol, not to the parent", async () => {
        const runner = routed({ [GO_ROUTE]: GO_LIMIT });
        const { h, selected } = quotaHarness(status({ codex: solUp, go: goUp, claude: claudeUp }), runner, open);
        try {
          const result = await dispatch(h, { tasks: plain });
          expect(runner.mock.calls.map(([context]) => context.run.model)).toEqual([GO_ROUTE, SOL_ROUTE]);
          expect(result.details.run).toMatchObject({ model: SOL_ROUTE, state: "done" });
          expect(result.details.run.selection).toMatchObject({ provider: "openai-codex", source: "chain", chainRoutes: [GO_ROUTE, SOL_ROUTE] });
          expect(result.details.run.selection.fallbackReason).toMatch(/^automatic fall-through after a usage-limit refusal before any output; OpenCode Go: run run-fixed-1 was refused on a usage limit before any output \(\[scout\] /);
          expect(result.content[0].text).toMatch(/Fall-through: run run-fixed-1 · opencode-go\/deepseek-v4\.1-flash was refused/);
          expect(result.content[0].text).toMatch(/this implicit wave continues down the default chain on openai-codex\/gpt-6\.1-sol/);
          expect(selected).toEqual([]); // Claude is never consulted while Sol can launch
          expect((await recordOf(h, "run-fixed-1")).state).toBe("failed");
        } finally { await shutdown(h); }
      });

      it.each([
        ["the Codex usage-limit wording", SOL_LIMIT],
        ["subscription_quota_exceeded", "subscription_quota_exceeded"],
        ["a router refusal that says cooling down", "Provider account router refused: every GPT account is cooling down (GPT 1, GPT 2); the earliest returns at Mon 02:59"],
      ])("Sol refused with %s falls through to the Claude tier, not back to Go", async (_name, error) => {
        // Go is exhausted by the snapshot, so Sol is the route; its refusal leaves nothing but Claude.
        const runner = routed({ [SOL_ROUTE]: error });
        const { h } = quotaHarness(status({ codex: solUp, go: goOut, claude: claudeUp }), runner, open);
        try {
          const result = await dispatch(h, { tasks: plain });
          expect(runner.mock.calls.map(([context]) => context.run.model)).toEqual([SOL_ROUTE, HAIKU]);
          expect(result.details.run.selection).toMatchObject({ source: "chain", chainRoutes: [GO_ROUTE, SOL_ROUTE, HAIKU] });
          expect(result.details.run.selection.fallbackReason).toMatch(/GPT-6\.1 Sol: run run-fixed-1 was refused on a usage limit before any output/);
          expect((await recordOf(h, "run-fixed-1")).state).toBe("failed");
        } finally { await shutdown(h); }
      });

      it("Go, then Sol, then Claude: each tier once, one completion", async () => {
        const runner = routed({ [GO_ROUTE]: GO_LIMIT, [SOL_ROUTE]: SOL_LIMIT });
        const { h, accountCommand } = quotaHarness(status({ codex: solUp, go: goUp, claude: claudeUp }), runner, open);
        try {
          const result = await dispatch(h, { tasks: plain });
          expect(runner.mock.calls.map(([context]) => context.run.model)).toEqual([GO_ROUTE, SOL_ROUTE, HAIKU]);
          expect(result.details.run.selection).toMatchObject({ source: "chain", chainRoutes: [GO_ROUTE, SOL_ROUTE, HAIKU] });
          expect(result.details.run.selection.fallbackReason).toMatch(/^automatic fall-through after a usage-limit refusal before any output; Haiku 5\.5: .*OpenCode Go: run run-fixed-1 was refused on a usage limit .*GPT-6\.1 Sol: run run-fixed-2 was refused on a usage limit/);
          expect(result.content[0].text).toMatch(/Fall-through: run run-fixed-1 · opencode-go\/deepseek-v4\.1-flash was refused .*; run run-fixed-2 · openai-codex\/gpt-6\.1-sol was refused/);
          expect(statusCalls(accountCommand)).toBe(3);
          expect(h.messages).toEqual([]);
        } finally { await shutdown(h); }
      });

      it("Go, Sol and Claude all refused: three runs, one error naming all three causes, no fourth launch", async () => {
        const runner = routed({ [GO_ROUTE]: GO_LIMIT, [SOL_ROUTE]: SOL_LIMIT, [HAIKU]: CLAUDE_LIMIT });
        const { h } = quotaHarness(status({ codex: solUp, go: goUp, claude: claudeUp }), runner, open);
        try {
          const message = await messageOf(dispatch(h, { tasks: plain }));
          expect(runner).toHaveBeenCalledTimes(3);
          expect(message).toMatch(/\(run run-fixed-3 · claude-code\/claude-haiku-5-5\): \[scout\] quota limit reached/);
          expect(message).toMatch(/after run run-fixed-1 · opencode-go\/deepseek-v4\.1-flash was refused on a provider usage limit.*GoUsageLimitError.*; run run-fixed-2 · openai-codex\/gpt-6\.1-sol was refused on a provider usage limit.*The usage limit has been reached/);
          expect(message).not.toContain("No fallback was selected");
        } finally { await shutdown(h); }
      });
    });

    describe("what does not fall through", () => {
      it.each([
        ["an explicit Go model", { model: GO_ROUTE }, status({ go: goUp }), { [GO_ROUTE]: GO_LIMIT }],
        ["an explicit Sol model", { model: SOL_ROUTE }, status({ codex: solUp, go: goUp }), { [SOL_ROUTE]: SOL_LIMIT }],
        ["an explicit Sol profile", { profile: "steak-pi/gpt-6-1-sol" }, status({ codex: solUp, go: goUp }), { [SOL_ROUTE]: SOL_LIMIT }],
      ])("%s with a usage-limit refusal fails as it always did: explicit routes never fall back", async (_name, selector, answer, refused) => {
        const runner = routed(refused);
        const { h, accountCommand } = quotaHarness(answer, runner, open);
        try {
          const message = await messageOf(dispatch(h, { ...selector, tasks: plain }));
          expect(message).toMatch(/^USAP dispatch failed before any worker produced model output \(run run-fixed-1 · /);
          expect(message).toMatch(/The run record is failed with these causes and no worker is left running\. No fallback was selected\.$/);
          expect(message).not.toContain("fall-through");
          expect(runner).toHaveBeenCalledTimes(1);
          expect(statusCalls(accountCommand)).toBe(1); // only the explicit-route preflight read
          const list = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
          expect(list.details.runs.map((run: any) => run.runId)).toEqual(["run-fixed-1"]);
        } finally { await shutdown(h); }
      });

      it.each([
        ["a route failure", "Reserved Codex account has no exact Sol model with configured OAuth authentication"],
        ["an expired login", "OAuth access token expired; sign in again"],
        ["a spawn failure", "spawn ut-provider-accounts ENOENT"],
        ["a bare 429 rate limit", "429 Too Many Requests"],
        ["a router that is merely unavailable", "Provider account router unavailable or no account eligible (exit 1)"],
      ])("an implicit launch failure that is %s is not a quota cause and still fails synchronously", async (_name, error) => {
        const runner = routed({ [GO_ROUTE]: error });
        const { h, selected } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeUp }), runner, open);
        try {
          const message = await messageOf(dispatch(h, { tasks: plain }));
          expect(message).toContain(`[scout] ${error}`);
          expect(message).toMatch(/No fallback was selected\.$/);
          expect(message).not.toContain("fall-through");
          expect(runner).toHaveBeenCalledTimes(1);
          expect(selected).toEqual([]);
        } finally { await shutdown(h); }
      });

      it("a wave where one leaf hit the usage limit but another failed for a plain cause fails synchronously", async () => {
        const runner = vi.fn(async ({ task }: Context): ReturnType<WorkerRunner> => refusal(task.label === "quota" ? GO_LIMIT : "OAuth access token expired; sign in again"));
        const { h } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeUp }), runner, open);
        try {
          const message = await messageOf(dispatch(h, { tasks: [{ label: "quota", task: "First leaf" }, { label: "auth", task: "Second leaf" }] }));
          expect(message).toMatch(/\[quota\] 429: .*GoUsageLimitError/);
          expect(message).toContain("[auth] OAuth access token expired");
          expect(message).toMatch(/No fallback was selected\.$/);
          expect(runner).toHaveBeenCalledTimes(2); // both leaves of the one run, no second run
        } finally { await shutdown(h); }
      });

      it("a lease release that could not be proven never falls through, whatever quota wording it quotes", async () => {
        const runner = routed({ [GO_ROUTE]: `Go account lease release failed (Go 1, lease=abc); router TTL retains a bounded lease; earlier failure: ${GO_LIMIT}` });
        const { h } = quotaHarness(status({ codex: solUp, go: goUp, claude: claudeUp }), runner, open);
        try {
          const message = await messageOf(dispatch(h, { tasks: plain }));
          expect(message).toMatch(/lease release failed/);
          expect(message).not.toContain("fall-through");
          expect(runner).toHaveBeenCalledTimes(1);
        } finally { await shutdown(h); }
      });

      it("a wave where a sibling already produced output is never re-run", async () => {
        const runner = vi.fn(async ({ task, onProgress, signal }: Context): ReturnType<WorkerRunner> => {
          if (task.label === "quota") return refusal(GO_LIMIT);
          onProgress({ turns: 1, outputStarted: true });
          return await new Promise<Awaited<ReturnType<WorkerRunner>>>((resolve) => signal.addEventListener("abort", () => resolve({ state: "aborted", output: "", turns: 1, usage: emptyUsage(), error: "cancelled" }), { once: true }));
        });
        const { h } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeUp }), runner, open);
        try {
          const message = await messageOf(dispatch(h, { tasks: [{ label: "writer", task: "Streams output" }, { label: "quota", task: "Refused" }] }));
          expect(message).toMatch(/\[quota\] 429: .*GoUsageLimitError/);
          expect(message).toMatch(/No fallback was selected\.$/);
          expect(runner).toHaveBeenCalledTimes(2);
        } finally { await shutdown(h); }
      });

      it("an implicit reviewer wave refused on Claude's quota keeps its exact route and never falls through to Go, Sol or Haiku", async () => {
        const runner = routed({ [OPUS_ROUTE]: CLAUDE_LIMIT });
        const { h } = quotaHarness(status({ codex: solUp, go: goUp, claude: claudeUp }), runner, open);
        try {
          const message = await messageOf(dispatch(h, { tasks: [{ label: "review", task: "Review the diff", role: "reviewer" }] }));
          expect(message).toMatch(/^USAP dispatch failed before any worker produced model output \(run run-fixed-1 · claude-code\/claude-opus-5-5\): \[review\] quota limit reached/);
          expect(message).toMatch(/No fallback was selected\.$/);
          expect(runner).toHaveBeenCalledTimes(1);
        } finally { await shutdown(h); }
      });
    });

    it("marks the refused first run delivered durably, so a reload never queues it", async () => {
      const durable = durableRoot("fall-through");
      const mark = vi.spyOn(CheckpointStore.prototype, "markDelivered");
      const runner = routed({ [GO_ROUTE]: GO_LIMIT });
      const { h } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeUp }), runner, open, durable);
      let next: ReturnType<typeof harness> | undefined;
      try {
        const started = await dispatch(h, { background: true, tasks: plain });
        expect(started.content[0].text).toMatch(/Started USAP run run-fall-through-2 · claude-code\/claude-haiku-5-5/);
        expect(mark).toHaveBeenCalledWith("run-fall-through-1");
        await flush();
        expect(h.messages).toHaveLength(1);
        expect(String(h.messages[0].message.content)).not.toContain("run-fall-through-1");
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        const reopened = vi.fn(async () => ({ state: "done" as const, output: "must not run", turns: 1, usage: emptyUsage() }));
        next = harness(() => reopened, { ...durable, prefix: "reopened" });
        await next.handlers.get("session_start")!({}, next.ctx);
        await next.handlers.get("agent_settled")!({}, next.ctx);
        await flush();
        expect(next.messages.every((entry) => !String(entry.message.content).includes("run-fall-through-1"))).toBe(true);
        expect(reopened).not.toHaveBeenCalled();
        const first = await next.tools.get("ultraterm_hub").execute("s", { action: "status", runId: "run-fall-through-1" }, undefined, undefined, next.ctx);
        expect(first.details.run.state).toBe("failed"); // adopted, so the silence is not vacuous
      } finally {
        mark.mockRestore();
        await h.handlers.get("session_shutdown")!({}, h.ctx);
        if (next) await next.handlers.get("session_shutdown")!({}, next.ctx);
      }
    });
  });

  describe("implicit review, Claude-tier work and the Sol review fallback", () => {
    const review = [{ label: "review", task: "Review the diff", role: "reviewer" }];

    it.each([
      ["Haiku-tier work", { tasks: plain }, "claude-code/claude-haiku-5-5"],
      ["Sonnet-tier work", { tasks: [{ label: "build", task: "Implement and test", role: "worker", mayEdit: true, ownedPaths: ["src/x.ts"], allowBash: true }] }, "claude-code/claude-sonnet-5-5"],
    ])("an implicit review in a session that ran %s goes to Opus 5.5, the verification that work requires", async (_name, wave, workModel) => {
      const runner = done();
      const { h } = quotaHarness(status({ codex: solOut, go: goOut, claude: claudeUp }), runner);
      try {
        const work = await dispatch(h, wave);
        expect(work.details.run).toMatchObject({ model: workModel });
        expect(work.details.run.selection.independence).toBe("requires-opus");
        const verdict = await dispatch(h, { tasks: review });
        expect(verdict.details.run).toMatchObject({ model: OPUS_ROUTE, harness: "claude-code" });
        expect(verdict.details.run.selection).toMatchObject({ source: "automatic-review" });
        expect(verdict.details.run.selection.independence).toBeUndefined();
      } finally { await shutdown(h); }
    });

    it("installs no Sol review fallback when every GPT account is unavailable, and says why", async () => {
      let relay!: RelayBroker;
      const runner = done();
      const { h } = quotaHarness(status({ codex: solOut, go: goUp, claude: claudeUp }), runner, { createRunner: (_pi: unknown, broker: RelayBroker) => { relay = broker; return runner; } });
      try {
        const result = await dispatch(h, { tasks: review });
        expect(result.details.run).toMatchObject({ model: OPUS_ROUTE, harness: "claude-code" });
        expect(result.content[0].text).toMatch(/Review note: the GPT-6\.1 Sol review fallback is unavailable \(every GPT account is unavailable \(GPT 1: cooling down until Mon 02:59; GPT 2: cooling down until Mon 02:59\).*\); a Claude quota or auth failure ends this review without falling back/);
        // The Claude worker has its own relay peer even without a Sol fallback runtime.
        expect(relay.listPeers(result.details.run.runId)).toEqual(["parent", result.details.run.tasks[0].taskId]);
      } finally { await shutdown(h); }
    });

    it("keeps the Sol review fallback when GPT can launch", async () => {
      let relay!: RelayBroker;
      const runner = done();
      const { h } = quotaHarness(status({ codex: solUp, go: goUp, claude: claudeUp }), runner, { createRunner: (_pi: unknown, broker: RelayBroker) => { relay = broker; return runner; } });
      try {
        const result = await dispatch(h, { tasks: review });
        expect(result.content[0].text).not.toContain("Sol review fallback is unavailable");
        expect(relay.listPeers(result.details.run.runId)).toEqual(["parent", expect.stringContaining("task")]);
      } finally { await shutdown(h); }
    });

    it("switches an implicit review to the Sol fallback when the router shows every Claude account cooling down", async () => {
      const runner = done();
      const { h } = quotaHarness(status({ codex: solUp, go: goUp, claude: [cooling("primary", "Claude 1"), cooling("b", "Claude 2")] }), runner);
      try {
        const result = await dispatch(h, { tasks: review });
        expect(result.details.run).toMatchObject({ model: SOL_ROUTE });
        expect(result.details.run.selection).toMatchObject({ source: "automatic-review-fallback" });
      } finally { await shutdown(h); }
    });
  });
});

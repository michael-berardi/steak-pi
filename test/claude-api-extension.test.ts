import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUltratermSubagentsExtension, renderRunResult } from "../extensions/ultraterm-subagents.ts";
import { CLAUDE_API_CONFIG_ENV } from "../src/subagents/claude-api-route.ts";
import { claudeApiReceipt, admitClaudeApiRoute } from "../src/subagents/claude-api-route.ts";
import { emptyUsage, type WorkerRunner } from "../src/subagents/types.ts";
import { apiFixture, CANARY_KEY, CANARY_WORKSPACE, NOW, type ApiFixture } from "./helpers/claude-api-fixture.ts";

const SONNET = "claude-code-api/claude-sonnet-5-5";
const OPUS = "claude-code-api/claude-opus-5-5";
const dirs: string[] = [];
let fixture: ApiFixture;
const saved = process.env[CLAUDE_API_CONFIG_ENV];

beforeEach(() => {
  fixture = apiFixture();
  process.env[CLAUDE_API_CONFIG_ENV] = fixture.configPath;
});
afterEach(() => {
  if (saved === undefined) delete process.env[CLAUDE_API_CONFIG_ENV]; else process.env[CLAUDE_API_CONFIG_ENV] = saved;
  fixture.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function harness(runner: WorkerRunner) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    appendEntry() {}, registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); }, sendMessage() {},
  } as unknown as ExtensionAPI;
  let id = 0;
  createUltratermSubagentsExtension({ createRunner: () => runner, idFactory: () => `api-ext-${++id}`, profiles: [], now: () => NOW })(pi);
  const cwd = mkdtempSync(join(tmpdir(), "usap-api-extension-")); dirs.push(cwd);
  const model = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text", "image"] };
  const ctx = {
    cwd, model, thinkingLevel: "high",
    modelRegistry: { isUsingOAuth: () => true, hasConfiguredAuth: () => true, getAvailable: () => [model], getProvider: () => ({ streamSimple() {} }), find: () => model },
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => cwd, getEntries: () => [] },
    ui: { setStatus() {} },
  } as any;
  return { tools, handlers, ctx };
}

const done: WorkerRunner = async () => ({ state: "done", output: "ok", turns: 1, usage: emptyUsage() });
const wave = (extra: Record<string, unknown> = {}) => ({ goal: "api wave", tasks: [{ label: "Read", task: "read the entrypoint", role: "scout" }], ...extra });

describe("ultraterm_subagents explicit Claude API route", () => {
  it("dispatches an exact API model on the claude-code harness with an override selection and a stamped ceiling", async () => {
    const runner = vi.fn(done);
    const h = harness(runner);
    const result = await h.tools.get("ultraterm_subagents").execute("api", wave({ model: SONNET }), undefined, undefined, h.ctx);
    expect(result.isError).not.toBe(true);
    const seen = runner.mock.calls[0][0];
    expect(seen.run.harness).toBe("claude-code");
    expect(seen.run.model).toBe(SONNET);
    expect(seen.run.thinkingLevel).toBe("xhigh");
    expect(seen.run.selection).toMatchObject({ provider: "claude-code-api", modelId: "claude-sonnet-5-5", source: "override", harness: "claude-code", images: false });
    expect(seen.task.apiLeafCapUsd).toBe(1);
    expect(result.details.run.model).toBe(SONNET);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("with harness claude-code alone, or an implicit route, never selects the API route even when approved", async () => {
    const runner = vi.fn(done);
    const h = harness(runner);
    await h.tools.get("ultraterm_subagents").execute("sub", wave({ harness: "claude-code" }), undefined, undefined, h.ctx);
    expect(runner.mock.calls[0][0].run.model).toBe("claude-code/claude-sonnet-5-5");
    expect(runner.mock.calls[0][0].task.apiLeafCapUsd).toBeUndefined();
    await h.tools.get("ultraterm_subagents").execute("opus", wave({ model: "claude-code/claude-opus-5-5" }), undefined, undefined, h.ctx);
    expect(runner.mock.calls[1][0].run.model).toBe("claude-code/claude-opus-5-5");
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("fails closed before any checkpoint, relay peer or worker when the approval is missing, with no fallback", async () => {
    fixture.cleanup();
    process.env[CLAUDE_API_CONFIG_ENV] = join(tmpdir(), "usap-api-missing-approval.json");
    const runner = vi.fn(done);
    const h = harness(runner);
    await expect(h.tools.get("ultraterm_subagents").execute("api", wave({ model: SONNET }), undefined, undefined, h.ctx))
      .rejects.toThrow(/ClaudeApiAdmissionError\[approval-missing\].*no subscription, Sol or other fallback was selected/s);
    expect(runner).not.toHaveBeenCalled();
    const listed = await h.tools.get("ultraterm_hub").execute("list", { action: "list" }, undefined, undefined, h.ctx);
    expect(listed.details.runs).toEqual([]);
    fixture = apiFixture();
  });

  it.each([
    ["an unapproved model", () => fixture.writeConfig({ routes: [OPUS] }), SONNET, /route-not-approved/],
    ["an expired approval", () => fixture.writeConfig({ approval: { approvedBy: "operator", source: "brief", task: "t", approvedAt: "2026-09-01T00:00:00Z", expiresAt: "2026-09-02T00:00:00Z" } }), SONNET, /approval-expired/],
    ["a settings file that carries a base URL", () => fixture.writeSettings({ apiKeyHelper: fixture.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: `anthropic-workspace-id: ${CANARY_WORKSPACE}`, ANTHROPIC_BASE_URL: "https://example.invalid" } }), SONNET, /settings-invalid/],
  ])("rejects %s with a named error", async (_name, arrange, model, pattern) => {
    arrange();
    const runner = vi.fn(done);
    const h = harness(runner);
    const error = await h.tools.get("ultraterm_subagents").execute("api", wave({ model }), undefined, undefined, h.ctx).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(pattern);
    expect((error as Error).message).not.toContain("example.invalid");
    expect(runner).not.toHaveBeenCalled();
  });

  it("refuses image review, a non-xhigh effort and foreign selectors on the API route", async () => {
    const runner = vi.fn(done);
    const h = harness(runner);
    const exec = (extra: Record<string, unknown>) => h.tools.get("ultraterm_subagents").execute("api", wave({ model: SONNET, ...extra }), undefined, undefined, h.ctx);
    await expect(exec({ requireImages: true })).rejects.toThrow(/unsupported-feature/);
    await expect(exec({ thinking: "medium" })).rejects.toThrow(/xhigh/);
    await expect(h.tools.get("ultraterm_subagents").execute("api", wave({ model: `${SONNET}-other` }), undefined, undefined, h.ctx)).rejects.toThrow();
    await expect(h.tools.get("ultraterm_subagents").execute("api", wave({ harness: "claude-code", model: SONNET, profile: "steak-pi/gpt-6-1-sol" }), undefined, undefined, h.ctx)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("caps API waves at three wide whatever the dispatch asks", async () => {
    const runner = vi.fn(done);
    const h = harness(runner);
    const tasks = Array.from({ length: 6 }, (_, index) => ({ label: `Read ${index}`, task: "read", role: "scout" }));
    const result = await h.tools.get("ultraterm_subagents").execute("api", wave({ model: SONNET, tasks, concurrency: 8 }), undefined, undefined, h.ctx);
    expect(runner.mock.calls[0][0].run.concurrency).toBe(3);
    expect(runner.mock.calls[0][0].task.apiLeafCapUsd).toBe(0.33);
    expect(result.details.run.tasks).toHaveLength(6);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("an API-route failure settles failed with no automatic route change", async () => {
    const runner = vi.fn<WorkerRunner>(async () => ({ state: "failed", output: "", turns: 0, usage: emptyUsage(), error: "quota limit reached (API credit balance exhausted); no fallback, purchase or top-up was attempted" }));
    const h = harness(runner);
    const result = await h.tools.get("ultraterm_subagents").execute("api", wave({ model: SONNET }), undefined, undefined, h.ctx);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.details.run.model).toBe(SONNET);
    expect(result.details.run.tasks[0].state).toBe("failed");
    expect(result.content[0].text).not.toMatch(/Sol fallback|model-fallback/);
    await h.handlers.get("session_shutdown")!({}, h.ctx);
  });

  it("renders the sanitized receipt in the result text without any secret", () => {
    const admission = admitClaudeApiRoute({ route: SONNET, taskCount: 1 }, fixture.options);
    const receipt = claudeApiReceipt({ admission, sessionId: "s-1", servedModels: ["claude-sonnet-5-5"], preflight: true, init: true, spentUsd: 0.05 });
    const text = renderRunResult({
      version: "1.3", id: "run-render", goal: "g", constraints: [], cwd: "/repo", model: SONNET, harness: "claude-code", thinkingLevel: "xhigh", concurrency: 1, timeoutMs: 1000, maxTurns: 4,
      background: false, state: "done", createdAt: 0, usage: emptyUsage(),
      tasks: [{ id: "t1", label: "Read", task: "x", role: "scout", mayEdit: false, ownedPaths: [], allowBash: false, state: "done", output: "report", turns: 1, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, apiReceipt: receipt }],
    } as never);
    expect(text).toContain("api receipt: auth=api_key_helper (firstParty, key source apiKeyHelper)");
    expect(text).toContain("spent $0.0500 of $1.00 leaf cap");
    for (const canary of [CANARY_KEY, CANARY_WORKSPACE, fixture.helperPath, fixture.settingsPath]) expect(text).not.toContain(canary);
  });
});

import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitClaudeApiRoute, anyClaudeRouteModelOf, assertClaudeApiStatus, claudeApiConcurrency, claudeApiLeafCapUsd, claudeApiModelOf, claudeApiReceipt,
  ClaudeApiAdmissionError, CLAUDE_API_CONFIG_ENV, CLAUDE_API_MAX_CONCURRENCY, CLAUDE_API_ROUTES, formatClaudeApiReceipt, isClaudeApiRoute,
  loadClaudeApiConfig, receiptText, resolveClaudeApiSelection, stampClaudeApiRun,
} from "../src/subagents/claude-api-route.ts";
import { CLAUDE_CODE_OPUS_ROUTE, CLAUDE_CODE_ROUTES, CLAUDE_CODE_SONNET_ROUTE, claudeCodeModelOf, defaultClaudeCodeRoute } from "../src/subagents/model-selection.ts";
import { apiFixture, approvalRecord, CANARY_HEADER, CANARY_KEY, CANARY_WORKSPACE, NOW, type ApiFixture } from "./helpers/claude-api-fixture.ts";

const fixtures: ApiFixture[] = [];
const fresh = () => { const fixture = apiFixture(); fixtures.push(fixture); return fixture; };
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const SONNET = "claude-code-api/claude-sonnet-5-5";
const OPUS = "claude-code-api/claude-opus-5-5";

function failure(run: () => unknown): ClaudeApiAdmissionError {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(ClaudeApiAdmissionError); return error as ClaudeApiAdmissionError; }
  throw new Error("expected a ClaudeApiAdmissionError");
}

describe("claude API route identity", () => {
  it("is an exact, distinct namespace that the subscription helpers never resolve", () => {
    expect(CLAUDE_API_ROUTES).toEqual([SONNET, OPUS]);
    expect(claudeApiModelOf(SONNET)).toBe("claude-sonnet-5-5");
    expect(claudeApiModelOf(OPUS)).toBe("claude-opus-5-5");
    for (const route of CLAUDE_CODE_ROUTES) {
      expect(claudeApiModelOf(route)).toBeUndefined();
      expect(isClaudeApiRoute(route)).toBe(false);
    }
    for (const route of CLAUDE_API_ROUTES) expect(claudeCodeModelOf(route)).toBeUndefined();
    expect(anyClaudeRouteModelOf(SONNET)).toBe("claude-sonnet-5-5");
    expect(anyClaudeRouteModelOf(CLAUDE_CODE_OPUS_ROUTE)).toBe("claude-opus-5-5");
  });

  it.each([`${SONNET}/`, ` ${SONNET}`, SONNET.toUpperCase(), "claude-code-api/claude-sonnet-5-5-other", "claude-code-api", "claude-api/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5", "", undefined])(
    "never fuzzy-matches %j", (route) => {
      expect(claudeApiModelOf(route as string | undefined)).toBeUndefined();
      expect(failure(() => admitClaudeApiRoute({ route: route as string | undefined, taskCount: 1 }, fresh().options)).code).toBe("route-not-api");
    });

  it("is never the automatic default: Claude defaults stay on the subscription routes", () => {
    expect(defaultClaudeCodeRoute([{ role: "worker" }])).toBe(CLAUDE_CODE_SONNET_ROUTE);
    expect(defaultClaudeCodeRoute([{ role: "reviewer" }])).toBe(CLAUDE_CODE_OPUS_ROUTE);
  });

  it("selection is an explicit override on the claude-code harness with no image capability", () => {
    expect(resolveClaudeApiSelection("claude-sonnet-5-5")).toEqual({ provider: "claude-code-api", modelId: "claude-sonnet-5-5", source: "override", harness: "claude-code", images: false, tools: true });
  });
});

describe("approval record contract", () => {
  it("admits a valid record and reports structure only", () => {
    const f = fresh();
    const config = loadClaudeApiConfig(f.options);
    expect(config.routes).toEqual([SONNET, OPUS]);
    expect(config.budget).toEqual({ maxLeafUsd: 1, maxRunUsd: 2 });
    expect(config.approvalId).toMatch(/^[0-9a-f]{12}$/);
    expect(config.settingsDigest).toMatch(/^[0-9a-f]{12}$/);
    const admission = admitClaudeApiRoute({ route: SONNET, taskCount: 1 }, f.options);
    expect(admission).toMatchObject({ route: SONNET, model: "claude-sonnet-5-5", leafBudgetUsd: 1, leafCapUsd: 1, runCapUsd: 2, priorSpendUsd: 0 });
  });

  it("resolves the path from the environment variable and refuses a relative one", () => {
    const f = fresh();
    expect(loadClaudeApiConfig({ env: { [CLAUDE_API_CONFIG_ENV]: f.configPath }, now: f.options.now }).path).toBe(f.configPath);
    expect(failure(() => loadClaudeApiConfig({ env: { [CLAUDE_API_CONFIG_ENV]: "relative.json" }, now: f.options.now })).code).toBe("approval-invalid");
  });

  it("missing approval is the exact blocker: names the path, the env var, no fallback, and never writes", () => {
    const f = fresh();
    const missing = join(f.dir, "absent.json");
    const error = failure(() => admitClaudeApiRoute({ route: SONNET, taskCount: 1 }, { configPath: missing, now: f.options.now }));
    expect(error.code).toBe("approval-missing");
    expect(error.message).toContain(missing);
    expect(error.message).toContain(CLAUDE_API_CONFIG_ENV);
    expect(error.message).toContain("never writes");
    expect(error.message).toContain("no subscription, Sol or other fallback was selected");
    expect(existsSync(missing)).toBe(false);
  });

  it("refuses unsafe record files: group/world readable, symlink, foreign owner, oversize, bad JSON, non-object", () => {
    const f = fresh();
    chmodSync(f.configPath, 0o644);
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/chmod 600/);
    chmodSync(f.configPath, 0o600);
    const link = join(f.dir, "link.json");
    symlinkSync(f.configPath, link);
    expect(failure(() => loadClaudeApiConfig({ ...f.options, configPath: link })).message).toMatch(/symbolic link/);
    expect(failure(() => loadClaudeApiConfig({ ...f.options, uid: (process.getuid?.() ?? 0) + 1 })).message).toMatch(/owned by the current user/);
    writeFileSync(f.configPath, "x".repeat(20_000), { mode: 0o600 });
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/exceeds/);
    writeFileSync(f.configPath, "{not json", { mode: 0o600 });
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/not valid JSON/);
    writeFileSync(f.configPath, "[]", { mode: 0o600 });
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/JSON object/);
  });

  it.each([
    ["unknown top-level key", { apiKey: "x" }, /unsupported key/],
    ["wrong version", { version: 2 }, /version must be 1/],
    ["no routes", { routes: [] }, /routes must list/],
    ["unknown route", { routes: ["claude-code/claude-sonnet-5-5"] }, /routes must list/],
    ["duplicate route", { routes: [SONNET, SONNET] }, /routes must list/],
    ["leaf above run", { budget: { maxLeafUsd: 2, maxRunUsd: 1 } }, /cannot exceed/],
    ["leaf above hard ceiling", { budget: { maxLeafUsd: 11, maxRunUsd: 12 } }, /maxLeafUsd must be a number/],
    ["run above hard ceiling", { budget: { maxLeafUsd: 1, maxRunUsd: 26 } }, /maxRunUsd must be a number/],
    ["zero budget", { budget: { maxLeafUsd: 0, maxRunUsd: 1 } }, /maxLeafUsd must be a number/],
    ["string budget", { budget: { maxLeafUsd: "1", maxRunUsd: 2 } }, /maxLeafUsd must be a number/],
    ["extra budget key", { budget: { maxLeafUsd: 1, maxRunUsd: 2, monthlyUsd: 200 } }, /unsupported key/],
    ["missing budget", { budget: undefined }, /budget object/],
  ])("rejects %s", (_name, overrides, pattern) => {
    const f = fresh();
    f.writeConfig(overrides as Record<string, unknown>);
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(pattern);
  });

  it("time-boxes approval: expired, future-dated, inverted and over-long records fail", () => {
    const f = fresh();
    const approval = (patch: Record<string, string>) => ({ approval: { approvedBy: "operator", source: "brief", task: "t", approvedAt: "2026-10-13T00:00:00Z", expiresAt: "2026-10-20T00:00:00Z", ...patch } });
    f.writeConfig(approval({ expiresAt: "2026-10-13T11:59:59Z" }));
    expect(failure(() => loadClaudeApiConfig(f.options)).code).toBe("approval-expired");
    f.writeConfig(approval({ approvedAt: "2026-10-14T00:00:00Z", expiresAt: "2026-10-15T00:00:00Z" }));
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/in the future/);
    f.writeConfig(approval({ expiresAt: "2026-10-12T00:00:00Z" }));
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/after approval.approvedAt/);
    f.writeConfig(approval({ expiresAt: "2026-12-30T00:00:00Z" }));
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/at most 31 days/);
    f.writeConfig(approval({ expiresAt: "tomorrow" }));
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/UTC ISO-8601/);
    f.writeConfig(approval({ approvedBy: "" }));
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/plain characters/);
  });

  it("re-reads the record on every admission: revocation and expiry take effect immediately", () => {
    const f = fresh();
    expect(admitClaudeApiRoute({ route: SONNET, taskCount: 1 }, f.options).route).toBe(SONNET);
    f.writeConfig({ routes: [OPUS] });
    expect(failure(() => admitClaudeApiRoute({ route: SONNET, taskCount: 1 }, f.options)).code).toBe("route-not-approved");
    expect(admitClaudeApiRoute({ route: OPUS, taskCount: 1 }, f.options).model).toBe("claude-opus-5-5");
    expect(failure(() => admitClaudeApiRoute({ route: OPUS, taskCount: 1 }, { ...f.options, now: () => NOW + 30 * 86_400_000 })).code).toBe("approval-expired");
  });

  it("refuses image review on the API route", () => {
    const f = fresh();
    expect(failure(() => admitClaudeApiRoute({ route: SONNET, taskCount: 1, requireImages: true }, f.options)).code).toBe("unsupported-feature");
  });
});

describe("settings contract and secret handling", () => {
  it.each([
    ["extra top-level key (provider switch)", (f: ApiFixture) => ({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER }, apiBaseUrl: "https://example.invalid" })],
    ["hooks", (f: ApiFixture) => ({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER }, hooks: {} })],
    ["permissions widening", (f: ApiFixture) => ({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER }, permissions: { allow: ["Bash"] } })],
    ["inline key in env", (f: ApiFixture) => ({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER, ANTHROPIC_API_KEY: CANARY_KEY } })],
    ["base url in env", (f: ApiFixture) => ({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER, ANTHROPIC_BASE_URL: "https://example.invalid" } })],
    ["bedrock switch in env", (f: ApiFixture) => ({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER, CLAUDE_CODE_USE_BEDROCK: "1" } })],
    ["missing helper key", () => ({ env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } })],
    ["relative helper", () => ({ apiKeyHelper: "key-helper", env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } })],
    ["helper with arguments", (f: ApiFixture) => ({ apiKeyHelper: `${f.helperPath} --print`, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } })],
    ["helper with shell syntax", (f: ApiFixture) => ({ apiKeyHelper: `${f.helperPath};echo`, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } })],
    ["helper traversal", (f: ApiFixture) => ({ apiKeyHelper: `${f.dir}/../x/key-helper`, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } })],
    ["helper missing on disk", (f: ApiFixture) => ({ apiKeyHelper: `${f.dir}/nope`, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } })],
    ["no env", (f: ApiFixture) => ({ apiKeyHelper: f.helperPath })],
    ["wrong header", (f: ApiFixture) => ({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: `x-other: ${CANARY_WORKSPACE}` } })],
    ["two headers", (f: ApiFixture) => ({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: `${CANARY_HEADER}\nx-extra: 1` } })],
  ])("rejects settings with %s and never echoes a value", (_name, build) => {
    const f = fresh();
    f.writeSettings(build(f));
    const error = failure(() => admitClaudeApiRoute({ route: SONNET, taskCount: 1 }, f.options));
    expect(error.code).toBe("settings-invalid");
    for (const canary of [CANARY_KEY, CANARY_WORKSPACE, CANARY_HEADER, "example.invalid"]) expect(error.message).not.toContain(canary);
  });

  it("rejects an unsafe helper (group-writable, non-executable, symlink, foreign owner) and unsafe settings files", () => {
    const f = fresh();
    chmodSync(f.helperPath, 0o770);
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/not be writable by group or others/);
    chmodSync(f.helperPath, 0o600);
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/must be executable/);
    chmodSync(f.helperPath, 0o700);
    expect(failure(() => loadClaudeApiConfig({ ...f.options, uid: (process.getuid?.() ?? 0) + 1 })).message).toMatch(/owned by the current user/);
    const link = join(f.dir, "helper-link");
    symlinkSync(f.helperPath, link);
    f.writeSettings({ apiKeyHelper: link, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } });
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/non-symlink/);
    f.writeSettings({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } });
    chmodSync(f.settingsPath, 0o644);
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/chmod 600/);
    chmodSync(f.settingsPath, 0o600);
    f.writeConfig({ settingsPath: "relative.json" });
    expect(failure(() => loadClaudeApiConfig(f.options)).code).toBe("settings-invalid");
  });

  it("refuses trusted files whose directory others could rewrite", () => {
    const f = fresh();
    chmodSync(f.dir, 0o777);
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/directory of the API route approval record must not be writable by group or others/);
    chmodSync(f.dir, 0o700);
    const other = join(f.dir, "helpers");
    mkdirSync(other, { mode: 0o700 });
    const helper = join(other, "key-helper");
    writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    f.writeSettings({ apiKeyHelper: helper, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } });
    expect(admitClaudeApiRoute({ route: SONNET, taskCount: 1 }, f.options).route).toBe(SONNET);
    chmodSync(other, 0o770);
    expect(failure(() => loadClaudeApiConfig(f.options)).message).toMatch(/directory of the settings.apiKeyHelper must not be writable/);
  });

  it("does not execute the helper or read its output: approval succeeds even when the helper would fail", () => {
    const f = fresh();
    writeFileSync(f.helperPath, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    expect(admitClaudeApiRoute({ route: SONNET, taskCount: 1 }, f.options).route).toBe(SONNET);
  });

  it("the settings digest changes when the settings change, without exposing content", () => {
    const f = fresh();
    const before = loadClaudeApiConfig(f.options).settingsDigest;
    f.writeSettings({ apiKeyHelper: f.helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: "anthropic-workspace-id: wrkspc_OTHERWORKSPACE9876543210" } });
    const after = loadClaudeApiConfig(f.options).settingsDigest;
    expect(after).not.toBe(before);
    expect(JSON.stringify([before, after])).not.toContain("wrkspc");
  });
});

describe("API session budget ceiling", () => {
  it("caps each leaf by the leaf ceiling and its share of the run ceiling", () => {
    const f = fresh();
    f.writeConfig({ budget: { maxLeafUsd: 1, maxRunUsd: 2 } });
    const config = loadClaudeApiConfig(f.options);
    expect(claudeApiLeafCapUsd(config, 1)).toBe(1);
    expect(claudeApiLeafCapUsd(config, 2)).toBe(1);
    expect(claudeApiLeafCapUsd(config, 3)).toBe(0.66);
    expect(claudeApiLeafCapUsd(config, 8)).toBe(0.25);
    for (const tasks of [1, 2, 3, 4, 5, 6, 7, 8]) expect(claudeApiLeafCapUsd(config, tasks) * tasks).toBeLessThanOrEqual(2 + 1e-9);
  });

  it("refuses a wave whose per-task share is below the minimum useful budget", () => {
    const f = fresh();
    f.writeConfig({ budget: { maxLeafUsd: 1, maxRunUsd: 0.2 } });
    expect(failure(() => admitClaudeApiRoute({ route: SONNET, taskCount: 8 }, f.options)).code).toBe("budget-invalid");
    expect(failure(() => admitClaudeApiRoute({ route: SONNET, taskCount: 0 }, f.options)).code).toBe("budget-invalid");
  });

  it("subtracts spend already booked and refuses an exhausted leaf", () => {
    const f = fresh();
    expect(admitClaudeApiRoute({ route: SONNET, taskCount: 1, priorSpendUsd: 0.4 }, f.options).leafBudgetUsd).toBe(0.6);
    expect(failure(() => admitClaudeApiRoute({ route: SONNET, taskCount: 1, priorSpendUsd: 0.97 }, f.options)).code).toBe("budget-exhausted");
    expect(failure(() => admitClaudeApiRoute({ route: SONNET, taskCount: 1, priorSpendUsd: 5 }, f.options)).code).toBe("budget-exhausted");
  });

  it("a resume can lower but never raise the ceiling fixed at the original dispatch", () => {
    const f = fresh();
    expect(admitClaudeApiRoute({ route: SONNET, taskCount: 1, leafCapLimitUsd: 0.3 }, f.options).leafCapUsd).toBe(0.3);
    expect(admitClaudeApiRoute({ route: SONNET, taskCount: 1, leafCapLimitUsd: 9 }, f.options).leafCapUsd).toBe(1);
    expect(admitClaudeApiRoute({ route: SONNET, taskCount: 4, leafCapLimitUsd: 0.4 }, f.options).leafCapUsd).toBe(0.4);
  });

  it("stamps every task with the admitted ceiling", () => {
    const run = { tasks: [{}, {}] as Array<{ apiLeafCapUsd?: number }> };
    stampClaudeApiRun(run, { leafCapUsd: 0.75 });
    expect(run.tasks.map((task) => task.apiLeafCapUsd)).toEqual([0.75, 0.75]);
  });

  it("keeps API waves narrow regardless of requested width", () => {
    expect(CLAUDE_API_MAX_CONCURRENCY).toBe(3);
    expect(claudeApiConcurrency(undefined, 8)).toBe(3);
    expect(claudeApiConcurrency(8, 8)).toBe(3);
    expect(claudeApiConcurrency(2, 8)).toBe(2);
    expect(claudeApiConcurrency(5, 1)).toBe(1);
    expect(claudeApiConcurrency(0, 2)).toBe(2);
  });
});

describe("CLI-reported authentication and receipts", () => {
  const good = { loggedIn: true, authMethod: "api_key_helper", apiProvider: "firstParty", apiKeySource: "apiKeyHelper" };

  it("accepts only apiKeyHelper first-party API auth", () => {
    expect(() => assertClaudeApiStatus(good)).not.toThrow();
    for (const bad of [
      { ...good, loggedIn: false }, { ...good, authMethod: "claude.ai" }, { ...good, apiProvider: "bedrock" }, { ...good, apiKeySource: "none" },
      { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" }, {}, null, "ok",
    ]) expect(() => assertClaudeApiStatus(bad)).toThrow(/requires the approved apiKeyHelper credential/);
  });

  it("builds a bounded receipt that drops anything identifier-unsafe", () => {
    const f = fresh();
    const admission = admitClaudeApiRoute({ route: SONNET, taskCount: 1 }, f.options);
    const receipt = claudeApiReceipt({ admission, sessionId: "11111111-2222-4333-8444-555555555555", servedModels: ["claude-sonnet-5-5", "claude-sonnet-5-5", `bad ${CANARY_KEY}`, "x".repeat(200)],
      cliVersion: "2.1.296 (Claude Code) secret", preflight: true, init: true, spentUsd: 0.123456789 });
    expect(receipt).toMatchObject({ kind: "claude-code-api", route: SONNET, model: "claude-sonnet-5-5", auth: { method: "api_key_helper", provider: "firstParty", keySource: "apiKeyHelper" },
      attested: { preflight: true, init: true }, servedModels: ["claude-sonnet-5-5"], budget: { leafCapUsd: 1, runCapUsd: 2, priorSpendUsd: 0, spentUsd: 0.123457 } });
    expect(receipt.cliVersion).toBeUndefined();
    const text = JSON.stringify(receipt) + formatClaudeApiReceipt(receipt);
    for (const canary of [CANARY_KEY, CANARY_WORKSPACE, f.helperPath, f.settingsPath, f.configPath]) expect(text).not.toContain(canary);
    expect(receiptText("2.1.296")).toBe("2.1.296");
    expect(receiptText("has space")).toBeUndefined();
  });

  it("formats an honest receipt when spend is unreported", () => {
    const f = fresh();
    const admission = admitClaudeApiRoute({ route: OPUS, taskCount: 1 }, f.options);
    const receipt = claudeApiReceipt({ admission, sessionId: "s1", servedModels: [], preflight: false, init: true });
    expect(formatClaudeApiReceipt(receipt)).toMatch(/model unattested; spend unreported/);
    expect(formatClaudeApiReceipt(receipt)).toMatch(/preflight=false init=true/);
  });
});

it("example record in the docs matches the contract", () => {
  const f = fresh();
  const doc = readFileSync(new URL("../docs/CLAUDE-API-ROUTE.md", import.meta.url), "utf8");
  const block = /```json\n(\{[\s\S]*?\})\n```/.exec(doc)?.[1];
  expect(block).toBeDefined();
  const example = JSON.parse(block!);
  f.writeConfig({ ...example, settingsPath: f.settingsPath, approval: { ...example.approval, approvedAt: "2026-10-13T00:00:00Z", expiresAt: "2026-10-20T00:00:00Z" } });
  expect(loadClaudeApiConfig(f.options).routes.length).toBeGreaterThan(0);
  expect(Object.keys(approvalRecord("/x")).sort()).toEqual(Object.keys(example).sort());
});

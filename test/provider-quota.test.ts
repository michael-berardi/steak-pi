import { describe, expect, it, vi } from "vitest";
import { claudeQuotaBlock, isQuotaLaunchFailure, pickClaudeAccount, providerUsageLimit, quotaProviderOf, readProviderQuota, reportsSpentPlan, routeQuotaBlock } from "../src/subagents/provider-quota.ts";

// Shapes mirror a live router `status` answer: every field below is one the router itself emits, and
// nothing here is credential-bearing.
const NOW = 1_793_164_649;
const SOL = { provider: "openai-codex", id: "gpt-6.1-sol" };
const GO = { provider: "opencode-go", id: "deepseek-v4.1-flash" };

const coolingDown = (id: string, label: string, until = NOW + 434_000) => ({
  configured: true, eligible: false, id, label, state: "cooling-down", stateText: "cooling down until Mon 02:59",
  ineligibleReason: "cooling down", cooldown: { at: NOW - 27, hits: 0, kind: "usage", reason: "a plan usage window is at 100%", source: "usage", until },
  resetAt: until, usageKnown: true, usedPercent: 100, windows: [{ name: "Weekly", resetAt: until, usedPercent: 100 }],
});
const eligible = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  configured: true, eligible: true, id, label, state: "balancing", stateText: "balancing", usageKnown: true, usedPercent: 12,
  windows: [{ name: "five_hour", resetAt: NOW + 3_000, usedPercent: 12 }], ...extra,
});
const status = (providers: Record<string, unknown[]>) => ({
  ok: true, time: NOW,
  providers: Object.fromEntries(Object.entries(providers).map(([key, accounts]) => [key, { accounts, accountsConfigured: accounts.length, balancing: true, mode: "together" }])),
});
const read = (value: unknown) => readProviderQuota(vi.fn(async () => value) as never, NOW * 1000);

describe("provider quota (router status) exhaustion", () => {
  it("treats a provider as exhausted only when every configured account is cooling down, naming the router's cause", async () => {
    const quota = await read(status({ codex: [coolingDown("primary", "GPT 1"), coolingDown("fallback", "GPT 2")], claude: [eligible("primary", "Claude 1")] }));
    expect(quota.known).toBe(true);
    expect(quota.providers.codex).toMatchObject({ exhausted: true, unconfigured: false, accounts: 2 });
    expect(quota.providers.codex?.cause).toMatch(/every GPT account is unavailable \(GPT 1: cooling down until Mon 02:59; GPT 2: cooling down until Mon 02:59\); the earliest returns at/);
    expect(quota.providers.codex?.earliestReturn).toBe(NOW + 434_000);
    expect(routeQuotaBlock(quota, SOL)).toBe(quota.providers.codex?.cause);
    expect(routeQuotaBlock(quota, GO)).toBeUndefined(); // Go absent from the answer: unknown, not exhausted
    expect(claudeQuotaBlock(quota)).toBeUndefined();
  });

  it("one usable account keeps the provider usable", async () => {
    const quota = await read(status({ codex: [coolingDown("primary", "GPT 1"), eligible("fallback", "GPT 2")] }));
    expect(quota.providers.codex?.exhausted).toBe(false);
    expect(routeQuotaBlock(quota, SOL)).toBeUndefined();
  });

  it("counts a signed-out account and a 100% window as unavailable, and a stale 100% window as nothing", async () => {
    const full = { configured: true, eligible: false, id: "primary", label: "Go 1", state: "balancing", windows: [{ name: "five_hour", resetAt: NOW + 600, usedPercent: 100 }] };
    const signedOut = { configured: true, eligible: false, id: "b", label: "Go 2", signedOut: true };
    const quota = await read(status({ "opencode-go": [full, signedOut] }));
    expect(quota.providers["opencode-go"]?.exhausted).toBe(true);
    expect(quota.providers["opencode-go"]?.cause).toMatch(/Go 1: a usage window is at 100%; Go 2: signed out/);
    const stale = await read(status({ "opencode-go": [{ ...full, windows: [{ name: "five_hour", resetAt: NOW - 5, usedPercent: 100 }] }] }));
    expect(stale.providers["opencode-go"]?.exhausted).toBe(false);
  });

  it.each([
    ["busy at the session limit", { configured: true, eligible: false, id: "primary", label: "GPT 1", state: "balancing", leases: 64, limit: 64, ineligibleReason: "all slots busy" }],
    ["usage not measured", { configured: true, eligible: false, id: "primary", label: "GPT 1", usageKnown: false, usageNote: "no usage snapshot", windows: [] }],
    ["eligible with a stale cooldown record", { ...coolingDown("primary", "GPT 1"), eligible: true, state: "balancing" }],
  ])("never treats %s as exhaustion", async (_name, account) => {
    const quota = await read(status({ codex: [account] }));
    expect(quota.providers.codex?.exhausted).toBe(false);
    expect(routeQuotaBlock(quota, SOL)).toBeUndefined();
  });

  it("treats a provider with no configured account as blocked (nothing can launch), and unlisted ones as unknown", async () => {
    const quota = await read(status({ "opencode-go": [{ configured: false, id: "primary", label: "Go 1" }], codex: [] }));
    expect(quota.providers["opencode-go"]).toMatchObject({ unconfigured: true, exhausted: false });
    expect(routeQuotaBlock(quota, GO)).toMatch(/Go has no configured account/);
    expect(routeQuotaBlock(quota, SOL)).toMatch(/GPT has no configured account/);
    expect(routeQuotaBlock(quota, { provider: "xiaomi", id: "mimo-v2.6-flash" })).toBeUndefined();
  });

  it.each([
    ["a router that throws", () => { throw new Error("spawn ut-provider-accounts ENOENT"); }],
    ["a router that answers nothing usable", () => ({ ok: true })],
    ["a router answering null", () => null],
  ])("treats %s as unknown, never as exhaustion", async (_name, answer) => {
    const quota = await readProviderQuota((async () => answer()) as never, NOW * 1000);
    expect(quota.known).toBe(false);
    expect(quota.providers).toEqual({});
    expect(routeQuotaBlock(quota, SOL)).toBeUndefined();
    expect(claudeQuotaBlock(quota)).toBeUndefined();
  });

  it("asks the router with the nonsecret status command only", async () => {
    const command = vi.fn(async () => status({ codex: [eligible("primary", "GPT 1")] }));
    await readProviderQuota(command as never, NOW * 1000);
    expect(command.mock.calls).toEqual([[["status"]]]);
  });

  it("proves Claude ineligible only when the router marked every configured account ineligible", async () => {
    const both = await read(status({ claude: [{ configured: true, eligible: false, id: "primary", label: "Claude 1", ineligibleReason: "signed out" }, { configured: true, eligible: false, id: "b", label: "Claude 2", ineligibleReason: "signed out" }] }));
    expect(claudeQuotaBlock(both)).toMatch(/every Claude account is ineligible \(Claude 1: signed out; Claude 2: signed out\)/);
    const one = await read(status({ claude: [{ configured: true, eligible: false, id: "primary", label: "Claude 1" }, eligible("b", "Claude 2")] }));
    expect(claudeQuotaBlock(one)).toBeUndefined();
    const none = await read(status({ claude: [] }));
    expect(claudeQuotaBlock(none)).toBeUndefined();
  });

  it("gates only the routes that launch on a router reservation", () => {
    expect(quotaProviderOf(SOL)).toBe("codex");
    expect(quotaProviderOf(GO)).toBe("opencode-go");
    expect(quotaProviderOf({ provider: "openai-codex", id: "gpt-6-astra" })).toBeUndefined();
    expect(quotaProviderOf({ provider: "xiaomi", id: "mimo-v2.6-flash" })).toBeUndefined();
  });
});

describe("picking the Claude account an automatic fallback worker is pinned on", () => {
  const busy = (id: string, label: string) => ({ configured: true, eligible: false, id, label, state: "balancing", leases: 64, limit: 64, ineligibleReason: "all slots busy", windows: [] });

  it("never picks an account the router marks ineligible, whichever side it is on", async () => {
    const first = pickClaudeAccount(await read(status({ claude: [coolingDown("primary", "Claude 1"), eligible("b", "Claude 2")] })));
    expect(first).toEqual({ account: { id: "b", label: "Claude 2" } });
    const second = pickClaudeAccount(await read(status({ claude: [eligible("primary", "Claude 1"), busy("b", "Claude 2")] })));
    expect(second).toEqual({ account: { id: "primary", label: "Claude 1" } });
  });

  it("balances across eligible accounts: least-used window, then fewest leases, then router order", async () => {
    const pick = async (...accounts: Array<Record<string, unknown>>) => pickClaudeAccount(await read(status({ claude: accounts }))).account?.id;
    expect(await pick(eligible("primary", "Claude 1", { usedPercent: 70 }), eligible("b", "Claude 2", { usedPercent: 25 }))).toBe("b");
    expect(await pick(eligible("primary", "Claude 1", { usedPercent: 5 }), eligible("b", "Claude 2", { usedPercent: 25 }))).toBe("primary");
    expect(await pick(eligible("primary", "Claude 1", { usedPercent: 25, leases: 3 }), eligible("b", "Claude 2", { usedPercent: 25, leases: 1 }))).toBe("b");
    expect(await pick(eligible("primary", "Claude 1", { usedPercent: 25 }), eligible("b", "Claude 2", { usedPercent: 25 }))).toBe("primary");
    // An unmeasured account is chosen only when nothing measured is eligible.
    expect(await pick(eligible("primary", "Claude 1", { usedPercent: undefined }), eligible("b", "Claude 2", { usedPercent: 90 }))).toBe("b");
    expect(await pick(eligible("primary", "Claude 1", { usedPercent: undefined }), coolingDown("b", "Claude 2"))).toBe("primary");
  });

  it("names the cause when the router lists Claude accounts but none is eligible", async () => {
    const none = pickClaudeAccount(await read(status({ claude: [coolingDown("primary", "Claude 1"), busy("b", "Claude 2")] })));
    expect(none.account).toBeUndefined();
    expect(none.cause).toBe("the router shows no eligible Claude account (Claude 1: cooling down until Mon 02:59; Claude 2: all slots busy)");
    const unreported = pickClaudeAccount(await read(status({ claude: [{ configured: true, id: "primary", label: "Claude 1", windows: [] }] })));
    expect(unreported.cause).toBe("the router shows no eligible Claude account (Claude 1: the router did not report it eligible)");
  });

  it("only ever picks an account the dispatch can pin (primary or b)", async () => {
    const pick = pickClaudeAccount(await read(status({ claude: [eligible("third", "Claude 3")] })));
    expect(pick.account).toBeUndefined();
    expect(pick.cause).toContain("no eligible Claude account");
  });

  it("proves nothing from an unreadable router or one that lists no Claude account: no account, no cause", async () => {
    expect(pickClaudeAccount(await readProviderQuota((async () => { throw new Error("spawn ut-provider-accounts ENOENT"); }) as never, NOW * 1000))).toEqual({});
    expect(pickClaudeAccount(await read(status({ codex: [eligible("primary", "GPT 1")] })))).toEqual({});
    expect(pickClaudeAccount(await read(status({ claude: [] })))).toEqual({});
  });
});

describe("provider usage-limit wording", () => {
  it.each([
    ['429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}', "Go usage limit exceeded"],
    ["Go usage limit exceeded", "Go usage limit exceeded"],
    ["The usage limit has been reached", "usage limit reached"],
    ["429 usage_limit_reached: weekly window", "usage limit reached"],
    ["subscription_quota_exceeded", "subscription_quota_exceeded"],
    // The exact sentence Pi turns every Codex usage_limit_reached / 429 into.
    ["You have hit your ChatGPT usage limit (pro plan). Try again in ~120 min.", "ChatGPT usage limit reached"],
  ])("recognises plan exhaustion in %s", (text, label) => {
    expect(providerUsageLimit(text)).toBe(label);
    expect(isQuotaLaunchFailure(text)).toBe(true);
  });

  it.each([
    "Provider account router refused: every GPT account is cooling down (GPT 1, GPT 2); the earliest returns at Mon 02:59",
    "Provider account router refused: every Go account is cooling down",
    "quota exhausted",
  ])("treats %s as a quota launch failure", (text) => {
    expect(isQuotaLaunchFailure(text)).toBe(true);
  });

  it.each([
    "429 Too Many Requests",
    "429 rate_limit_exceeded: slow down",
    "Provider account router unavailable or no account eligible (exit 1)",
    "Provider account router refused: signed out",
    "Reserved Codex account has no exact Sol model with configured OAuth authentication",
    "OAuth access token expired; sign in again",
    "spawn ut-provider-accounts ENOENT",
    "401 invalid_api_key",
    "cooling down",
  ])("does not treat %s as a quota cause", (text) => {
    expect(providerUsageLimit(text)).toBeUndefined();
    expect(isQuotaLaunchFailure(text)).toBe(false);
  });

  it("reports Pi's ChatGPT sentence as a spent plan only when it names a reset time", () => {
    expect(reportsSpentPlan("You have hit your ChatGPT usage limit (pro plan). Try again in ~120 min.")).toBe(true);
    // Pi gives a short burst rate_limit_exceeded the same sentence without a reset: that is a rate limit.
    expect(reportsSpentPlan("You have hit your ChatGPT usage limit (pro plan).")).toBe(false);
    expect(isQuotaLaunchFailure("You have hit your ChatGPT usage limit (pro plan).")).toBe(true);
    expect(reportsSpentPlan('429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}')).toBe(true);
    expect(reportsSpentPlan("429 Too Many Requests")).toBe(false);
  });

  it("never falls through on an unproven lease release, whatever quota wording it quotes", () => {
    const text = 'Go account lease release failed (Go 1, lease=abc); router TTL retains a bounded lease; earlier failure: 429: {"type":"GoUsageLimitError","message":"Go usage limit exceeded"}';
    expect(isQuotaLaunchFailure(text)).toBe(false);
  });
});

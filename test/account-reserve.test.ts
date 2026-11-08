import { describe, expect, it } from "vitest";
import { AccountReserveError, assertAccountReserve, rateLimitIngestPayload, reportRateLimit, type RouterCall } from "../extensions/claude-code/account-reserve.ts";
import { parseClaudeStreamLine } from "../src/subagents/claude-worker.ts";

function router(reserve: unknown, calls: Array<{ args: string[]; stdin?: string }> = []): RouterCall {
  return async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === "status") return { providers: { claude: { accounts: [{ id: "lent", label: "Claude (Lent)", reserve }, { id: "own" }] } } };
    return { ok: true, accepted: true };
  };
}

const info = { status: "allowed", isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.81, resetsAt: 1_900_000_000 } } };

describe("owner reserve on a lent Claude account", () => {
  it("refuses a request once the router says the reserve is reached, naming why", async () => {
    const run = assertAccountReserve({ ULTRATERM_PROVIDER_ACCOUNT: "lent" },
      router({ ok: false, floor: 20, remaining: 19, why: "keeps the last 20% of its five-hour window (19% left until 17:30)" }));
    await expect(run).rejects.toBeInstanceOf(AccountReserveError);
    await expect(run).rejects.toThrow(/Claude \(Lent\) keeps the last 20% of its five-hour window/);
  });

  it("is never retried by Pi's provider-limit classifier", async () => {
    const error = await assertAccountReserve({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, router({ ok: false, why: "x" })).catch((e) => e);
    expect(String(error.message)).toMatch(/quota exceeded/);
  });

  it("lets requests through while the reserve holds, and for accounts with no reserve", async () => {
    await expect(assertAccountReserve({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, router({ ok: true }))).resolves.toBeUndefined();
    await expect(assertAccountReserve({ ULTRATERM_PROVIDER_ACCOUNT: "own" }, router({ ok: false }))).resolves.toBeUndefined();
    await expect(assertAccountReserve({}, router({ ok: false }))).resolves.toBeUndefined();
  });

  it("fails closed with the cause when a reserved account's verdict cannot be read", async () => {
    const broken: RouterCall = async () => { throw new Error("router timed out"); };
    await expect(assertAccountReserve({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, broken)).rejects.toThrow(/could not be checked for lent: router timed out/);
  });

  it("feeds every turn's official reading to the router under the session's account", async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    expect(await reportRateLimit({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, info, undefined, router({ ok: true }, calls))).toBeUndefined();
    expect(calls[0].args).toEqual(["ingest", "--provider", "claude", "--account", "lent"]);
    const sent = JSON.parse(calls[0].stdin!);
    expect(sent).toMatchObject({ account: "lent", type: "rate_limit_event", rate_limit_info: info });
  });

  it("carries the CLI session id, so the router also refreshes the dial's snapshot", async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    await reportRateLimit({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, info, "0b8a2f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b", router({ ok: true }, calls));
    expect(JSON.parse(calls[0].stdin!).session_id).toBe("0b8a2f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b");
  });

  it("sends nothing for a reading without usage windows or without an account", () => {
    expect(rateLimitIngestPayload("lent", { status: "allowed" })).toBeUndefined();
  });

  it("the headless worker parses the CLI's rate_limit_event", () => {
    const event = parseClaudeStreamLine(JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, session_id: "0b8a2f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b" }));
    expect(event).toMatchObject({ kind: "rate_limit", info, sessionId: "0b8a2f8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b" });
  });
});

import { buildPiWorkerSystemPrompt, WORKER_CHECK_SCOPE } from "../src/subagents/pi-worker.ts";
import { buildClaudeWorkerPrompt } from "../src/subagents/claude-worker.ts";

describe("worker check scope (2026-11-03: Terra workers refused builds and tests their task required)", () => {
  it("never forbids a build, linter or test suite the task asks for", () => {
    expect(WORKER_CHECK_SCOPE).toMatch(/ask for a build, linter or full test suite, run exactly what they ask/);
    expect(WORKER_CHECK_SCOPE).toMatch(/without an AGENTS\.md is not a reason to stop/);
    expect(WORKER_CHECK_SCOPE).not.toMatch(/^Do not run project-wide/);
  });

  it("both worker prompts carry it and neither keeps the unconditional ban", () => {
    const run = { id: "r", goal: "g", constraints: [], contract: undefined, maxTurns: 8, model: "x/y" } as any;
    const task = { id: "t", label: "l", task: "Run npm test", ownedPaths: ["/tmp/x"], mayEdit: true } as any;
    for (const prompt of [buildPiWorkerSystemPrompt(run, task), buildClaudeWorkerPrompt(run, task)]) {
      expect(prompt).toContain(WORKER_CHECK_SCOPE);
      expect(prompt).not.toMatch(/Do not run project-wide builds, linters, or test suites\./);
    }
  });
});

// --- A session on a refused reserve account moves to the router's next eligible Claude account ---
import { resolveRequestAccount, forgetSessionAccount } from "../extensions/claude-code/account-reserve.ts";

type Call = { args: string[]; stdin?: string };
const own = { id: "primary", label: "Claude 1", launchEnv: { unset: ["CLAUDE_CONFIG_DIR"] } };
const second = { id: "b", label: "Claude 2", launchEnv: { set: { CLAUDE_CONFIG_DIR: "/home/x/.claude-b" } } };

function fleet(opts: { lentReserve: unknown; select?: unknown; calls?: Call[]; reserveOf?: Record<string, unknown> }): RouterCall {
  return async (args, stdin) => {
    opts.calls?.push({ args, stdin });
    if (args[0] === "status") {
      return { providers: { claude: { accounts: [
        { id: "lent", label: "Claude (Lent)", reserve: opts.lentReserve },
        { ...own, reserve: opts.reserveOf?.primary }, { ...second, reserve: opts.reserveOf?.b },
      ] } } };
    }
    if (args[0] === "select") return opts.select ?? { ok: true, account: own, reason: "most headroom" };
    return { ok: true };
  };
}

describe("a reserve refusal moves the session instead of stalling it", () => {
  it("keeps the account untouched while its reserve holds", async () => {
    const out = await resolveRequestAccount({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, "s-ok", fleet({ lentReserve: { ok: true } }));
    expect(out.overrides).toBeUndefined();
    expect(out.notice).toBeUndefined();
  });

  it("moves to the account the router selects, excluding the refused one, with a one-line notice", async () => {
    const calls: Call[] = [];
    const out = await resolveRequestAccount(
      { ULTRATERM_PROVIDER_ACCOUNT: "lent", CLAUDE_CONFIG_DIR: "/home/x/.claude-lent" }, "s-move",
      fleet({ lentReserve: { ok: false, why: "keeps 35% of its week for its owner (35% left, green)" }, calls }));
    expect(calls.find((c) => c.args[0] === "select")!.args).toEqual(["select", "--provider", "claude", "--exclude", "lent"]);
    expect(out.overrides).toEqual({ ULTRATERM_PROVIDER_ACCOUNT: "primary", CLAUDE_CONFIG_DIR: undefined, PI_CLAUDE_CODE_CONFIG_DIR: undefined });
    expect(out.notice).toBe("Claude (Lent) keeps 35% of its week for its owner (35% left, green); this session continues on Claude 1.");
    expect(out.notice).not.toMatch(/\n/);
  });

  it("points the session at the selected account's own config folder", async () => {
    const out = await resolveRequestAccount({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, "s-folder",
      fleet({ lentReserve: { ok: false, why: "x" }, select: { ok: true, account: second } }));
    expect(out.overrides).toEqual({ ULTRATERM_PROVIDER_ACCOUNT: "b", CLAUDE_CONFIG_DIR: "/home/x/.claude-b", PI_CLAUDE_CODE_CONFIG_DIR: undefined });
  });

  it("treats an unreadable usage the same way", async () => {
    const out = await resolveRequestAccount({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, "s-unknown",
      fleet({ lentReserve: { ok: false, remaining: null, why: "no current weekly usage reading, so its owner's reserve cannot be checked" } }));
    expect(out.overrides?.ULTRATERM_PROVIDER_ACCOUNT).toBe("primary");
    expect(out.notice).toMatch(/no current weekly usage reading/);
  });

  it("stays on the new account for the rest of the session without asking to leave it again", async () => {
    const calls: Call[] = [];
    const router = fleet({ lentReserve: { ok: false, why: "x" }, calls });
    await resolveRequestAccount({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, "s-sticky", router);
    calls.length = 0;
    const again = await resolveRequestAccount({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, "s-sticky", router);
    expect(again.overrides?.ULTRATERM_PROVIDER_ACCOUNT).toBe("primary");
    expect(again.notice).toBeUndefined();
    expect(calls.some((c) => c.args[0] === "select")).toBe(false);
    forgetSessionAccount("s-sticky");
  });

  it("skips a selected account whose own reserve is also reached, then names every cause when none is left", async () => {
    let picks = 0;
    const router: RouterCall = async (args) => {
      if (args[0] === "status") return { providers: { claude: { accounts: [
        { id: "lent", label: "Claude (Lent)", reserve: { ok: false, why: "keeps 35%" } },
        { ...own, label: "Claude 1", reserve: { ok: false, why: "keeps 10% for another owner" } } ] } } };
      picks++;
      return picks === 1 ? { ok: true, account: own }
        : { ok: false, error: "no Claude account can take a launch now (Claude 2: cooling down); queued, not failed" };
    };
    const error = await resolveRequestAccount({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, "s-none", router).catch((e) => e);
    expect(error).toBeInstanceOf(AccountReserveError);
    expect(error.message).toMatch(/Claude \(Lent\) keeps 35%/);
    expect(error.message).toMatch(/Claude 1 keeps 10% for another owner/);
    expect(error.message).toMatch(/Claude 2: cooling down/);
    expect(error.message).toMatch(/quota exceeded/);
  });

  it("does nothing for sessions without a named account, and fails closed when the router cannot answer", async () => {
    expect((await resolveRequestAccount({}, "s-none2", fleet({ lentReserve: { ok: false } }))).overrides).toBeUndefined();
    const broken: RouterCall = async () => { throw new Error("router timed out"); };
    await expect(resolveRequestAccount({ ULTRATERM_PROVIDER_ACCOUNT: "lent" }, "s-broken", broken)).rejects.toThrow(/could not be checked for lent/);
  });
});

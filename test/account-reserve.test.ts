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

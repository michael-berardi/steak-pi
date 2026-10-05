import { afterEach, describe, expect, it, vi } from "vitest";
// Pi's own retry classifier, the one that resent J-0022's request every 15 minutes.
import { isRetryableAssistantError } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/retry.js";
import codexReplyLimitExtension from "../extensions/codex-reply-limit.ts";
import {
  CODEX_REPLY_LIMIT_MS,
  codexReplyLimitError,
  isCodexReplyLimit,
  SMALLER_STEP_INSTRUCTION,
} from "../src/codex-reply-limit.ts";
import { CODEX_REPLY_LIMIT_REASON, transientFailure } from "../src/subagents/auto-resume.ts";
import { buildPiWorkerContinuationPrompt } from "../src/subagents/pi-worker.ts";

const cut = (over: Record<string, unknown> = {}) => ({
  role: "assistant", stopReason: "error", errorMessage: "terminated", provider: "openai-codex",
  api: "openai-codex-responses", model: "gpt-6.1-sol", content: [], ...over,
});
const FIFTEEN_MIN = 15 * 60_000;

describe("recognising a reply Codex ended at its limit", () => {
  it("names the failure, keeps the model and reasoning level, and asks for smaller steps", () => {
    const text = codexReplyLimitError(cut(), FIFTEEN_MIN, "high")!;
    expect(text).toMatch(/^Codex reply limit: Codex ended this reply after 15 minutes/);
    expect(text).toContain("(gpt-6.1-sol, high)");
    expect(text).toContain("not sent again");
    expect(text).toContain("smaller steps");
    expect(isCodexReplyLimit(text)).toBe(true);
  });

  it("leaves every other failure to its normal handling", () => {
    expect(codexReplyLimitError(cut(), CODEX_REPLY_LIMIT_MS - 1)).toBeUndefined(); // a quick drop is a real network fault
    expect(codexReplyLimitError(cut({ provider: "xiaomi", api: "openai-completions" }), FIFTEEN_MIN)).toBeUndefined();
    expect(codexReplyLimitError(cut({ errorMessage: "fetch failed" }), FIFTEEN_MIN)).toBeUndefined();
    expect(codexReplyLimitError(cut({ stopReason: "stop", errorMessage: undefined }), FIFTEEN_MIN)).toBeUndefined();
    expect(codexReplyLimitError(cut({ role: "user" }), FIFTEEN_MIN)).toBeUndefined();
  });

  it("is not retried by Pi, while the bare cut still is", () => {
    expect(isRetryableAssistantError(cut() as never)).toBe(true);
    expect(isRetryableAssistantError(cut({ errorMessage: codexReplyLimitError(cut(), FIFTEEN_MIN, "high") }) as never)).toBe(false);
  });

  it("is resumed by USAP once, never the same way twice", () => {
    expect(transientFailure("terminated", 0)?.reason).toBe("provider stream cut");
    const text = codexReplyLimitError(cut(), FIFTEEN_MIN, "high");
    expect(transientFailure(text, 0)?.reason).toBe(CODEX_REPLY_LIMIT_REASON);
    expect(transientFailure(text, 1)).toBeUndefined();
  });

  it("resumes a worker with the smaller-step instruction and without replaying or trusting earlier work", () => {
    const task = { id: "t1", label: "analytics repair", ownedPaths: [] as string[], autoResumes: [`${CODEX_REPLY_LIMIT_REASON}: Codex reply limit: ...`] };
    const prompt = buildPiWorkerContinuationPrompt(task as never);
    expect(prompt).toContain(SMALLER_STEP_INSTRUCTION);
    expect(prompt).toContain("the original prompt is not replayed");
    expect(prompt).toContain("never assume a previously attempted edit, write, or command completed");
    const network = buildPiWorkerContinuationPrompt({ ...task, autoResumes: ["network drop: fetch failed"] } as never);
    expect(network).not.toContain(SMALLER_STEP_INSTRUCTION);
  });
});

describe("the extension in a live session", () => {
  afterEach(() => vi.useRealTimers());

  function session() {
    const handlers: Record<string, (event: any, ctx: any) => any> = {};
    const sent: Array<{ content: unknown; options: unknown }> = [];
    codexReplyLimitExtension({
      on: (name: string, handler: (event: any, ctx: any) => any) => { handlers[name] = handler; return () => undefined; },
      sendUserMessage: (content: unknown, options: unknown) => { sent.push({ content, options }); },
    } as never);
    const ctx = { thinkingLevel: "high" };
    const turn = (message: Record<string, unknown>, minutes: number) => {
      handlers.turn_start({ type: "turn_start" }, ctx);
      vi.advanceTimersByTime(minutes * 60_000);
      const replaced = handlers.message_end({ type: "message_end", message }, ctx);
      handlers.agent_settled({ type: "agent_settled" }, ctx);
      return replaced;
    };
    return { turn, sent };
  }

  it("replaces the cut, then sends exactly one smaller-step follow-up per failure chain", () => {
    vi.useFakeTimers();
    const { turn, sent } = session();
    const first = turn(cut(), 15);
    expect(first.message.errorMessage).toMatch(/^Codex reply limit:/);
    expect(first.message.content).toEqual([]); // nothing from the cut reply is kept as if it ran
    expect(sent).toEqual([{ content: SMALLER_STEP_INSTRUCTION, options: { deliverAs: "followUp" } }]);

    const again = turn(cut(), 15); // the smaller step was cut too: explicit error, no further automatic turn
    expect(again.message.errorMessage).toMatch(/^Codex reply limit:/);
    expect(sent).toHaveLength(1);

    turn({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "checked one file" }] }, 2);
    turn(cut(), 15); // progress was made, so a later cut gets its own follow-up
    expect(sent).toHaveLength(2);
  });

  it("does nothing for a quick drop, another provider, or a finished reply", () => {
    vi.useFakeTimers();
    const { turn, sent } = session();
    expect(turn(cut(), 3)).toBeUndefined();
    expect(turn(cut({ provider: "xiaomi", api: "openai-completions" }), 20)).toBeUndefined();
    expect(turn({ role: "assistant", stopReason: "stop", content: [] }, 20)).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

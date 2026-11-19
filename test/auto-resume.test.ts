import { describe, expect, it } from "vitest";
import { MAX_AUTO_RESUMES, transientFailure } from "../src/subagents/auto-resume.ts";

describe("transient worker failures", () => {
  it.each([
    ["fetch failed", "network drop"],
    ["Connection error.", "network drop"],
    ["Connection reset by peer", "network drop"],
    ["Claude CLI synthetic error: transport failure; connection or request did not complete; synthetic frame is not a model response or approval", "network drop"],
    ["Claude CLI error result: transport failure; connection or request did not complete; error result is not model approval", "network drop"],
    ["terminated", "provider stream cut"],
    ["Codex SSE response headers timed out after 300000ms", "provider stream cut"],
    ["Request timed out.", "provider stream cut"],
    ["No model or tool activity for 5 min: the provider stream stopped responding, so the worker was stopped to free its slot.", "provider stream stalled"],
    ['Claude Code stream idle limit exceeded (no bytes or events): silent for 7 min 0 s partway through the reply; last event: ping; 2 automatic recoveries tried and each went quiet again. The conversation is intact: send "resume" to try again', "provider stream stalled"],
    [`Claude Code stream idle limit exceeded (no bytes or events): silent for 7 min 0 s partway through the reply; last event: ping; the Claude Code process was alive and the API had sent data this attempt; part of the reply had already been shown and cannot be taken back, and asking again would show it twice. The conversation is intact: send "resume" to try again`, "provider stream stalled"],
    [`Claude Code stream idle limit exceeded (no bytes or events): silent for 7 min 0 s partway through the reply; last event: ping; the Claude Code process was alive and the API had sent nothing this attempt; no further recovery because the request was already sent 3 times, the most one request is ever sent (3). The conversation is intact: send "resume" to try again`, "provider stream stalled"],
    ["claude-code ended with an incomplete stream-json frame", "Claude Code stream cut"],
    ["Request rate limited", "rate limited"],
    ["Claude CLI synthetic error: rate limit reached; retry with bounded backoff; synthetic frame is not a model response or approval", "rate limited"],
    ["claude-code CLI exited with code null (signal SIGKILL) without a result", "Claude Code process died"],
    ["claude-code CLI produced no result event", "Claude Code stream cut"],
    ["529 overloaded_error", "provider overloaded"],
  ])("resumes %s", (error, reason) => {
    expect(transientFailure(error, 0)?.reason).toBe(reason);
  });

  it.each([
    "Run deadline exceeded",
    "Child exceeded the 32-turn limit; the partial report above is evidence, not acceptance",
    "Provider finish_reason: content_filter",
    "Claude CLI reported claude-opus-5-5, not the pinned Sonnet 5.5 route",
    "Codex error: This content was flagged for possible cybersecurity risk.",
    "401 Unauthorized: fetch failed",
    "quota exhausted (429)",
    "Claude CLI synthetic error: quota limit reached; resets Oct 7 at 5pm (America/New_York); check Claude usage and retry the same route only after reset",
    "usage limit reached (429)",
    "Claude CLI synthetic error: unrecognized synthetic error (fail closed); check Claude usage before debugging",
    `Claude Code stream idle limit exceeded (no bytes or events): silent for 7 min 0 s partway through the reply; last event: ping; the Claude Code process was already gone; no automatic recovery because the process had already exited, which is a crash and not a quiet model. The conversation is intact: send "resume" to try again`,
    `Claude Code stream idle limit exceeded (no bytes or events): silent for 7 min 0 s partway through the reply; last event: ping; the Claude Code process was alive and the API had sent nothing this attempt; automatic recovery is off (PI_CLAUDE_CODE_MAX_RECOVERIES=0). The conversation is intact: send "resume" to try again`,
    `Claude Code stream idle limit exceeded (no bytes or events): silent for 7 min 0 s partway through the reply; last event: ping; the Claude Code process was alive and the API had sent data this attempt; no automatic recovery because the API had already sent the whole reply, and asking again would pay for it twice. The conversation is intact: send "resume" to try again`,
    "Task aborted",
    "claude-code CLI exited with code 1 without a result",
    undefined,
  ])("never resumes %s", (error) => {
    expect(transientFailure(error, 0)).toBeUndefined();
  });

  it("backs off and stops after the cap", () => {
    expect(transientFailure("fetch failed", 0)?.delayMs).toBe(10_000);
    expect(transientFailure("fetch failed", 1)?.delayMs).toBe(30_000);
    expect(transientFailure("fetch failed", MAX_AUTO_RESUMES)).toBeUndefined();
  });
});

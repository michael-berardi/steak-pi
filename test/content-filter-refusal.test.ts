import { describe, expect, it } from "vitest";
import { isContentFilterRefusal } from "../src/content-filter-refusal.ts";
import { classifyFailure } from "../src/subagents/route-evidence.ts";
import { transientFailure } from "../src/subagents/auto-resume.ts";

const DATA_INSPECTION = '400: {"code":"data_inspection_failed","message":"Input text data may contain inappropriate content.","type":"data_inspection_failed"}';

describe("provider content-filter refusal shape", () => {
  it("matches an HTTP 400 that names a content-inspection, moderation or safety-filter code or type", () => {
    for (const message of [
      DATA_INSPECTION,
      '400 {"error":{"code":"content_filter","message":"blocked"}}',
      'HTTP 400: {"error":{"type":"content_policy_violation"}}',
      "400 moderation_blocked: input flagged",
      '400 {"type":"safety_violation"}',
    ]) {
      expect(isContentFilterRefusal(message), message).toBe(true);
    }
  });

  it("never matches without the 400 status or without a named code, whatever the provider", () => {
    for (const message of [
      "data_inspection_failed",
      '500: {"code":"data_inspection_failed"}',
      "400 bad request: malformed JSON",
      "400 context length exceeded",
      "402 Insufficient credits",
      "Input text data may contain inappropriate content.",
      undefined,
      "",
    ]) {
      expect(isContentFilterRefusal(message), String(message)).toBe(false);
    }
  });

  it("classifies it as its own failure kind, not a quota, route or generic 4xx", () => {
    expect(classifyFailure(DATA_INSPECTION)).toBe("content-filter");
  });

  it("is not a transient failure, so auto-resume never replays it", () => {
    expect(transientFailure(DATA_INSPECTION, 0)).toBeUndefined();
  });
});

describe("quota and rate-limit classification of HTTP 429 bodies", () => {
  it("names a 429 whose body says insufficient_quota a quota refusal, not a transient rate limit", () => {
    expect(classifyFailure('429 Too Many Requests: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}')).toBe("quota");
    expect(classifyFailure('429 {"error":{"message":"Allocated quota exceeded, please increase your quota limit"}}')).toBe("quota");
  });

  it("keeps a plain 429 throttle as a rate limit that is never a quota refusal", () => {
    expect(classifyFailure("429 Too Many Requests: slow down")).toBe("rate-limit");
    expect(classifyFailure("429 rate limit reached for requests per minute")).toBe("rate-limit");
  });

  it("does not read a content-filter 400 as a quota refusal", () => {
    expect(classifyFailure(DATA_INSPECTION)).toBe("content-filter");
  });
});

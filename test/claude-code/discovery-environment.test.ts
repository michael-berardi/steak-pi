import assert from "node:assert/strict";
import { test } from "vitest";
import { discoveryEnvironment, processEnvironment } from "../../extensions/claude-code/claude-cli.ts";

// With CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC or DISABLE_TELEMETRY set, Claude Code answers the initialize request from a stale
// built-in model list: the newest model the login could use was missing from /model (2026-11-12). Discovery runs without
// those two switches; every request keeps them.
test("model discovery lets the CLI fetch its live model catalog; requests stay quiet", () => {
  const discovery = discoveryEnvironment({});
  assert.equal(discovery.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  assert.equal(discovery.DISABLE_TELEMETRY, undefined);
  // Everything else that keeps the run on the plan and off the network stays.
  assert.equal(discovery.CLAUDE_CODE_MAX_RETRIES, "0");
  assert.equal(discovery.ENABLE_TOOL_SEARCH, "false");
  const request = processEnvironment({}, {});
  assert.equal(request.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(request.DISABLE_TELEMETRY, "1");
});

test("discovery still refuses an inherited API key or backend override", () => {
  assert.throws(() => discoveryEnvironment({ ANTHROPIC_API_KEY: "x" }), /refuses conflicting auth/);
});

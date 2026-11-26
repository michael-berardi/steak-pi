import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { discoverClaudeModels, discoveryEnvironment, processEnvironment } from "../../extensions/claude-code/claude-cli.ts";
import { FALLBACK_DISCOVERY, modelFromDiscovery } from "../../extensions/claude-code/model-catalog.ts";

// With CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC or DISABLE_TELEMETRY set, Claude Code answers the initialize request from its
// built-in model catalog instead of fetching a live one. Discovery therefore keeps every telemetry switch on exactly like a
// request: deleting either one would put a network catalog fetch back into Pi's startup (2026-11-26 privacy audit).
test("model discovery keeps every telemetry switch on, like a request", () => {
  const cases = [
    discoveryEnvironment({}),
    discoveryEnvironment({ DISABLE_TELEMETRY: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" }),
    discoveryEnvironment(process.env),
  ];
  for (const discovery of cases) {
    assert.equal(discovery.DISABLE_TELEMETRY, "1");
    assert.equal(discovery.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(discovery.DISABLE_ERROR_REPORTING, "1");
    assert.equal(discovery.CLAUDE_CODE_MAX_RETRIES, "0");
    assert.equal(discovery.ENABLE_TOOL_SEARCH, "false");
  }
  const request = processEnvironment({}, {});
  assert.equal(request.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  assert.equal(request.DISABLE_TELEMETRY, "1");
});

// The real probe path, end to end: the spawned Claude Code process must be started quiet, and a quiet CLI answers from its
// built-in catalog. The stand-in records the switches it was started with and, if either is missing, records the live-catalog
// fetch it would make and exits 1 — so deleting a switch from the discovery environment fails this test as a network call.
test("the discovery probe starts Claude Code quiet and lists its built-in catalog", async () => {
  const dir = mkdtempSync(join(tmpdir(), "steak-pi-discovery-env-"));
  const executable = join(dir, "claude");
  const log = join(dir, "probe.log");
  const models = [
    { value: "default", displayName: "Default (recommended)", description: "built-in catalog row" },
    { value: "sonnet", displayName: "Sonnet", description: "built-in catalog row" },
  ];
  const script = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const quiet = process.env.DISABLE_TELEMETRY === "1" && process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1";
appendFileSync(process.env.PROBE_LOG, JSON.stringify({
  telemetry: process.env.DISABLE_TELEMETRY ?? null,
  nonessential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
  errorReporting: process.env.DISABLE_ERROR_REPORTING ?? null,
  builtin: quiet,
}) + "\\n");
if (!quiet) {
  appendFileSync(process.env.PROBE_LOG, JSON.stringify({ network: "live model catalog fetch" }) + "\\n");
  process.exit(1);
}
(async () => {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
      console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { models: ${JSON.stringify(models)} } } }));
    } else if (frame.shouldQuery === false) {
      console.log(JSON.stringify({ type: "result", num_turns: 0 }));
    }
  }
})();
`;
  const staged = `${executable}.tmp`;
  writeFileSync(staged, script);
  chmodSync(staged, 0o755);
  try {
    writeFileSync(executable, readFileSync(staged), { mode: 0o755 });
    const discovered = await discoverClaudeModels(
      { ...process.env, PI_CLAUDE_CODE_COMMAND: executable, PROBE_LOG: log },
      undefined,
      10_000,
    );
    assert.deepEqual(discovered.map((row) => row.value), ["default", "sonnet"]);
    const lines = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 1, "the probe started the CLI once and made no second (network) attempt");
    assert.deepEqual(lines[0], { telemetry: "1", nonessential: "1", errorReporting: "1", builtin: true });
    assert.equal(lines.some((line) => line.network), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovery still refuses an inherited API key or backend override", () => {
  assert.throws(() => discoveryEnvironment({ ANTHROPIC_API_KEY: "x" }), /refuses conflicting auth/);
});

test("a live row without a stated window keeps the shipped row's window for the same model", () => {
  for (const shipped of FALLBACK_DISCOVERY.filter((row) => row.contextWindow !== undefined)) {
    const live = modelFromDiscovery({ value: shipped.value.replace(/\[1m\]$/u, ""), resolvedModel: shipped.resolvedModel, displayName: shipped.displayName, description: "no window stated" });
    assert.equal(live.contextWindow, shipped.contextWindow, shipped.value);
    assert.equal(live.maxTokens, shipped.maxTokens, shipped.value);
  }
  // A model the shipped catalog does not know keeps the plain default.
  assert.equal(modelFromDiscovery({ value: "some-future-model", displayName: "Future", description: "x" }).contextWindow, 200_000);
});

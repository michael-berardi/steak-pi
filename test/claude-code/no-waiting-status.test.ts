import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import * as cli from "../../extensions/claude-code/claude-cli.ts";
import { idleLimits } from "../../extensions/claude-code/idle-policy.ts";

// The operator never asked for a live "waiting on the model" line at the bottom. A silent turn shows nothing; only a
// real recovery or failure is named (as a notice or in the error).
const root = join(import.meta.dirname, "../../extensions/claude-code");

test("no status-line sink, ticker or waiting text exists in the Claude Code extension", () => {
  for (const file of readdirSync(root).filter((name) => /\.(ts|mjs)$/.test(name))) {
    const source = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(source, /waiting on the model: /, `${file} prints a waiting line`);
    assert.doesNotMatch(source, /setStatus\(/, `${file} writes the status line`);
    assert.doesNotMatch(source, /StatusReporter|statusAfterMs/, `${file} has status plumbing`);
  }
  assert.equal("setClaudeCodeStatusReporter" in cli, false);
  assert.equal("statusAfterMs" in idleLimits(300_000), false);
});

test("the docs do not promise a waiting line", () => {
  const docs = readFileSync(join(root, "../../docs/CLAUDE-CODE.md"), "utf8");
  assert.doesNotMatch(docs, /waiting on the model: N s/);
});

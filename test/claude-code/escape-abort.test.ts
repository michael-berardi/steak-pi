import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { closeClaudeProcesses, runClaudeRequest } from "../../extensions/claude-code/claude-cli.ts";

// Escape while Claude is thinking: a process Claude Code started in its own session (an MCP server, a hook)
// keeps the stdout pipe open after the process group is killed. The interrupted turn must still settle at
// once, and the next message must run, instead of the session sitting at "thinking" forever.
const FAKE = `#!/usr/bin/env node
import readline from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
if (process.argv.includes("auth")) { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
if (process.env.NEVER_READ) { setInterval(() => {}, 1000); await new Promise(() => {}); }
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
appendFileSync(process.env.HOLDERS, holder.pid + "\\n");
holder.unref();
const usage = { input_tokens: 1, output_tokens: 1 };
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  const text = frame.message.content[0].text;
  if (text === "think") continue; // never answers, like a long thinking turn
  for (const event of [
    { type: "message_start", message: { id: "m", role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
    { type: "message_stop" },
  ]) console.log(JSON.stringify({ type: "stream_event", event }));
  console.log(JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, usage }));
}
`;

test("Escape during a thinking turn settles at once and the next message runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-escape-"));
  const executable = join(root, "fake-claude.mjs");
  const holders = join(root, "holders");
  await writeFile(executable, FAKE, "utf8");
  await writeFile(holders, "", "utf8");
  await chmod(executable, 0o755);
  const request = (text: string, signal?: AbortSignal) =>
    runClaudeRequest({
      model: "sonnet", cwd: root, systemPrompt: "s", manifest: [], extraBody: { tools: [] }, toolNames: new Set(),
      frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text }] } }],
      env: { PI_CLAUDE_CODE_COMMAND: executable, HOLDERS: holders }, timeoutMs: 60_000, signal, sessionId: "escape-session",
    });
  try {
    const controller = new AbortController();
    const thinking = request("think", controller.signal);
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    const outcome = await Promise.race([
      thinking.then(() => "resolved", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("stuck"), 8_000)),
    ]);
    assert.equal(outcome, "rejected", "the interrupted turn never settled");
    assert.ok(Date.now() - started < 3_000, `Escape took ${Date.now() - started} ms`);

    const next = await Promise.race([
      request("hello").then((output) => output.message.content),
      new Promise((resolve) => setTimeout(() => resolve("stuck"), 10_000)),
    ]);
    assert.deepEqual(next, [{ type: "text", text: "ok" }], "the next message stayed queued");
  } finally {
    await Promise.race([closeClaudeProcesses(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    for (const pid of (await readFile(holders, "utf8")).split("\n").filter(Boolean)) {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("Escape while a long history is still being written settles at once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-escape-pipe-"));
  const executable = join(root, "fake-claude.mjs");
  const holders = join(root, "holders");
  await writeFile(executable, FAKE, "utf8");
  await writeFile(holders, "", "utf8");
  await chmod(executable, 0o755);
  try {
    const controller = new AbortController();
    const big = "x".repeat(4 * 1024 * 1024); // far beyond the pipe buffer, and nobody reads it
    const run = runClaudeRequest({
      model: "sonnet", cwd: root, systemPrompt: "s", manifest: [], extraBody: { tools: [] }, toolNames: new Set(),
      frames: [{ type: "user", message: { role: "user", content: [{ type: "text", text: big }] } }],
      env: { PI_CLAUDE_CODE_COMMAND: executable, HOLDERS: holders, NEVER_READ: "1" }, timeoutMs: 60_000,
      signal: controller.signal, sessionId: "escape-pipe-session",
    });
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    const outcome = await Promise.race([
      run.then(() => "resolved", () => "rejected"),
      new Promise((resolve) => setTimeout(() => resolve("stuck"), 8_000)),
    ]);
    assert.equal(outcome, "rejected", "the interrupted turn never settled");
    assert.ok(Date.now() - started < 3_000, `Escape took ${Date.now() - started} ms`);
  } finally {
    await Promise.race([closeClaudeProcesses(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

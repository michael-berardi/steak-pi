import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { closeClaudeProcesses, discoverClaudeModels, runClaudeRequest } from "../../extensions/claude-code/claude-cli.ts";
import { transportTimeout, waitForOperation } from "../../extensions/claude-code/wait.ts";

const FAKE = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
if (process.argv.includes("auth")) {
  if (process.env.MODE === "auth-wait") { setInterval(() => {}, 1000); await new Promise(() => {}); }
  console.log(JSON.stringify({ loggedIn: true })); process.exit(0);
}
if (process.env.MODE === "discovery-holder") {
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  appendFileSync(process.env.HOLDERS, JSON.stringify({ pid: holder.pid, started: Date.now(), cwd: process.cwd(), ports: [] }) + "\\n");
  holder.unref();
  process.exit(0);
}
if (["discovery-models-holder", "discovery-models-signalled-holder"].includes(process.env.MODE)) {
  const readline = await import("node:readline");
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    if (frame.type !== "control_request") continue;
    console.log(JSON.stringify({ type: "control_response", response: { request_id: frame.request_id, subtype: "success", response: { models: [{ value: "sonnet", displayName: "Sonnet", description: "fixture" }] } } }));
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] });
    appendFileSync(process.env.HOLDERS, JSON.stringify({ pid: holder.pid, leader: process.pid, started: Date.now(), cwd: process.cwd(), ports: [] }) + "\\n");
    holder.unref();
    if (process.env.MODE === "discovery-models-signalled-holder") process.kill(process.pid, "SIGTERM");
    else process.exit(0);
  }
}
if (process.env.MODE === "closed-stdout") process.stdout.end();
if (process.env.MODE === "chatter") setInterval(() => console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: {} })), 25);
// Never read stdin, acknowledge a replay, or exit voluntarily.
setInterval(() => {}, 1000);
`;

async function fixture(run: (executable: string, root: string, holders: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "claude-deadline-"));
  const executable = join(root, "claude.mjs");
  const holders = join(root, "holders");
  await writeFile(executable, FAKE);
  await chmod(executable, 0o755);
  await writeFile(holders, "");
  try { await run(executable, root, holders); }
  finally {
    for (const line of (await readFile(holders, "utf8")).trim().split("\n").filter(Boolean)) {
      try { process.kill(JSON.parse(line).pid, "SIGKILL"); } catch { /* fixture exited */ }
    }
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
}

for (const mode of ["unread-history", "closed-stdout", "chatter", "auth-wait"]) {
  test(`${mode} ends on a bounded non-streaming wait without operator abort`, async () => fixture(async (executable, root) => {
    const started = Date.now();
    await assert.rejects(runClaudeRequest({
      model: "sonnet", cwd: root, systemPrompt: "s", manifest: [], extraBody: {}, toolNames: new Set(),
      frames: [{ type: "user", ...(mode === "chatter" ? { shouldQuery: false as const } : {}), message: { role: "user", content: [{ type: "text", text: mode === "unread-history" ? "x".repeat(4 * 1024 * 1024) : "hello" }] } }],
      env: { PI_CLAUDE_CODE_COMMAND: executable, MODE: mode }, timeoutMs: 400,
    }), /exceeded/);
    assert.ok(Date.now() - started < 2_000);
  }));
}

test("model discovery drops inherited stdout on timeout even after its parent exited", async () => fixture(async (executable, root, holders) => {
  const started = Date.now();
  await assert.rejects(discoverClaudeModels({ PI_CLAUDE_CODE_COMMAND: executable, MODE: "discovery-holder", HOLDERS: holders }, undefined, 300), /model discovery exceeded its wait limit/);
  assert.ok(Date.now() - started < 1_500);
  assert.ok((await readFile(holders, "utf8")).trim());
}));

test("model discovery handles stdout closing before the still-live process exits", async () => fixture(async executable => {
  await assert.rejects(discoverClaudeModels({ PI_CLAUDE_CODE_COMMAND: executable, MODE: "closed-stdout" }, undefined, 300), /model discovery exceeded its wait limit/);
}));

test("a queued process acquisition can abort while another auth probe owns the manager", async () => fixture(async (executable, root) => {
  const first = new AbortController();
  const second = new AbortController();
  const input = {
    model: "sonnet", cwd: root, systemPrompt: "s", manifest: [], extraBody: {}, toolNames: new Set<string>(),
    frames: [], env: { PI_CLAUDE_CODE_COMMAND: executable, MODE: "auth-wait" }, timeoutMs: 5_000,
  };
  const blocker = runClaudeRequest({ ...input, signal: first.signal }).catch(() => {});
  const queued = runClaudeRequest({ ...input, signal: second.signal });
  second.abort(new Error("queued acquisition cancelled"));
  try { await assert.rejects(queued, /queued acquisition cancelled/); }
  finally { first.abort(); await blocker; }
}));

test("transport wait handles an already-aborted signal and validates finite deadlines", async () => {
  for (const value of [0, -1, Infinity, NaN, 2_147_483_648]) assert.throws(() => transportTimeout(value), /positive finite/);
  const controller = new AbortController();
  controller.abort(new Error("already stopped"));
  let stopped = 0;
  await assert.rejects(waitForOperation(new Promise(() => {}), 200, "fixture", controller.signal, () => stopped++), /already stopped/);
  assert.equal(stopped, 1);
});


test("discovery returns received models after Claude exits despite inherited stdout", async () => fixture(async (executable, _root, holders) => {
  const models = await discoverClaudeModels({ PI_CLAUDE_CODE_COMMAND: executable, MODE: "discovery-models-holder", HOLDERS: holders }, undefined, 700);
  assert.equal(models[0]?.value, "sonnet");
}));

test("a signalled Claude leader still has its MCP process group killed", async () => {
  if (process.platform === "win32") return;
  await fixture(async (executable, _root, holders) => {
    const kill = vi.spyOn(process, "kill");
    try {
      await assert.rejects(discoverClaudeModels({ PI_CLAUDE_CODE_COMMAND: executable, MODE: "discovery-models-signalled-holder", HOLDERS: holders }, undefined, 700), /exited from signal SIGTERM/);
      const { leader } = JSON.parse((await readFile(holders, "utf8")).trim());
      assert.ok(kill.mock.calls.some(([pid, signal]) => pid === -leader && signal === "SIGKILL"));
    } finally { kill.mockRestore(); }
  });
});

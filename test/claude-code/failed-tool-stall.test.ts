import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { test } from "vitest";
import { CLAUDE_CODE_MODELS } from "../../extensions/claude-code/model-catalog.ts";
import type * as Cli from "../../extensions/claude-code/claude-cli.ts";
import type * as Stream from "../../extensions/claude-code/stream.ts";

// Optional offline baseline: point at a COPY, never load/edit the live pin in place.
const extensionRoot = process.env.CLAUDE_CODE_TEST_EXTENSION_ROOT;
const { closeClaudeProcesses } = await import(extensionRoot
  ? pathToFileURL(join(resolve(extensionRoot), "claude-cli.ts")).href
  : "../../extensions/claude-code/claude-cli.ts") as typeof Cli;
const { streamClaudeCode } = await import(extensionRoot
  ? pathToFileURL(join(resolve(extensionRoot), "stream.ts")).href
  : "../../extensions/claude-code/stream.ts") as typeof Stream;

const FAKE = `#!/usr/bin/env node
import readline from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
if (process.argv.includes("auth")) { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
const usage = { input_tokens: 1, output_tokens: 1 };
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.shouldQuery === false) { console.log(JSON.stringify({ type: "result", num_turns: 0 })); continue; }
  if (frame.type !== "user") continue;
  const blocks = frame.message.content;
  const steering = blocks.some(b => b.text?.includes("Apple Mail"));
  const failed = blocks.some(b => b.type === "tool_result" && b.is_error === true && b.content.includes("exit 1"));
  if (failed && !steering) {
    // Unlike a normal child, this separate session survives Claude's process-group kill.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
    appendFileSync(process.env.HOLDERS, JSON.stringify({ pid: holder.pid, started: Date.now(), cwd: process.cwd(), ports: [] }) + "\\n");
    holder.unref();
    if (process.env.STALL_MODE === "abort") continue;
    if (process.env.STALL_MODE === "exit") process.exit(1);
    console.log(JSON.stringify({ type: "assistant", error: "api_error", message: { role: "assistant", content: [{ type: "text", text: "fixture API error after bash exit 1" }] } }));
    console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, usage }));
    process.exit(1);
  }
  const content = steering ? [{ type: "text", text: "Apple Mail steering delivered" }]
    : [{ type: "tool_use", id: "bash-1", name: "mcp__pi__bash", input: { command: "false" } }];
  console.log(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));
  console.log(JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content, stop_reason: steering ? "end_turn" : "tool_use", usage } }));
  console.log(JSON.stringify({ type: "result", subtype: steering ? "success" : "error_max_turns", is_error: !steering, usage }));
}
`;

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("turn never ended; steering remains queued")), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

for (const mode of ["error", "abort", "exit"] as const) {
  test(`failed bash then ${mode}: inherited stdout cannot wedge the turn or queued steering`, async () => {
    const root = await mkdtemp(join(tmpdir(), "failed-tool-stall-"));
    const executable = join(root, "claude.mjs");
    const holders = join(root, "holders.jsonl");
    await writeFile(executable, FAKE);
    await chmod(executable, 0o755);
    await writeFile(holders, "");
    const controller = new AbortController();
    let queued = false;
    const errors: string[] = [];
    const starts: string[] = [];
    let abortTask: Promise<void> | undefined;
    const agent = new Agent({
      initialState: {
        model: CLAUDE_CODE_MODELS.find(m => m.id.includes("sonnet"))!,
        tools: [{
          name: "bash", label: "bash", description: "fixture failed bash", parameters: Type.Object({ command: Type.String() }),
          execute: async () => { throw new Error("bash failed: exit 1"); },
        }],
      },
      streamFn: (model, context, options) => {
        const failed = context.messages.at(-1)?.role === "toolResult";
        const stream = streamClaudeCode(model, context, {
          ...options,
          signal: AbortSignal.any([options!.signal!, controller.signal]),
          timeoutMs: mode === "exit" ? 700 : 10_000,
          env: { PI_CLAUDE_CODE_COMMAND: executable, HOLDERS: holders, STALL_MODE: mode },
        });
        if (failed && !queued) {
          queued = true;
          agent.steer({ role: "user", content: "It's not Gmail. I use Apple Mail.", timestamp: Date.now() });
          if (mode === "abort") abortTask = within((async () => {
            while (!(await readFile(holders, "utf8")).trim()) await new Promise(r => setTimeout(r, 10));
            controller.abort(new Error("fixture stopped after bash exit 1"));
          })(), 3_000);
        }
        return stream;
      },
    });
    agent.subscribe(event => {
      if (event.type === "message_start" && event.message.role === "assistant") starts.push("start");
      if (event.type === "message_end" && event.message.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason)) {
        errors.push(event.message.errorMessage ?? "");
      }
    });
    const running = agent.prompt("Run the fixture bash command");
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    try {
      await within(running, 5_000);
      await abortTask;
      assert.equal(queued, true);
      assert.ok(starts.length >= 2, "failed tool must be followed by a new stream start");
      assert.equal(errors.length, 1, "the stalled stream must end with a visible error");
      assert.match(errors[0]!, /fixture API error|fixture stopped|idle limit exceeded/);
      assert.ok((await readFile(holders, "utf8")).trim(), "fake must actually start its stdout-holding grandchild");
      assert.equal(agent.hasQueuedMessages(), true);
      // Pi resumes its existing steering queue after the error; no replacement text is injected.
      controller.signal.aborted && assert.equal(mode, "abort");
      agent.streamFunction = (model, context, options) => streamClaudeCode(model, context, {
        ...options, timeoutMs: 2_000, env: { PI_CLAUDE_CODE_COMMAND: executable, HOLDERS: holders, STALL_MODE: mode },
      });
      await within(agent.continue(), 4_000);
      assert.equal(agent.hasQueuedMessages(), false);
      const final = agent.state.messages.at(-1);
      assert.equal(final?.role, "assistant");
      assert.deepEqual(final && "content" in final ? final.content : [], [{ type: "text", text: "Apple Mail steering delivered" }]);
    } catch (error) {
      if (extensionRoot && error instanceof Error && /turn never ended/.test(error.message)) {
        assert.equal(settled, false);
        assert.equal(agent.state.isStreaming, true);
        assert.equal(agent.hasQueuedMessages(), true);
        assert.equal(errors.length, 0, "legacy close must block before the stream error is published");
        console.info(`legacy ${mode}: still streaming, no terminal error, steering queued until inherited stdout is released`);
      }
      throw error;
    } finally {
      controller.abort();
      agent.abort();
      // Kill only PIDs recorded by this fixture, then let the baseline's blocked close unwind.
      for (const line of (await readFile(holders, "utf8")).trim().split("\n").filter(Boolean)) {
        try { process.kill(JSON.parse(line).pid, "SIGKILL"); } catch { /* fixture already exited */ }
      }
      await within(running, 4_000);
      if (extensionRoot) assert.equal(settled, true, "releasing the inherited pipe must unblock legacy close");
      await within(closeClaudeProcesses(), 4_000);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
}

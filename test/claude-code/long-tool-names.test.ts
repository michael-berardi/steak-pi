import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { test } from "vitest";
import { closeClaudeProcesses } from "../../extensions/claude-code/claude-cli.ts";
import { CLAUDE_CODE_MODELS } from "../../extensions/claude-code/model-catalog.ts";
import { streamClaudeCode } from "../../extensions/claude-code/stream.ts";
import {
  claudeToolName,
  MAX_CLAUDE_TOOL_NAME,
  piToolName,
  prepareFrames,
  prepareNativeTranscript,
  prepareTools,
  TOOL_PREFIX,
} from "../../extensions/claude-code/transcript.ts";

// The real name that broke UltraBot's Claude route on 2026-10-26: 52 characters.
const LONG = "mcp__overseer__overseer_coordinator_note_disposition";
const WIRE_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

const tool = (name: string): Tool =>
  ({ name, description: name, parameters: { type: "object", properties: {} } }) as unknown as Tool;

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("a long MCP tool name gets a stable alias that fits the Claude API", () => {
  assert.equal(LONG.length, 52);
  const alias = claudeToolName(LONG);
  assert.notEqual(alias, LONG);
  assert.ok(alias.length <= MAX_CLAUDE_TOOL_NAME, alias);
  assert.ok(`${TOOL_PREFIX}${alias}`.length <= 64);
  assert.match(`${TOOL_PREFIX}${alias}`, WIRE_NAME);
  assert.equal(claudeToolName(LONG), alias, "alias is stable across turns");
  assert.ok(alias.startsWith("mcp__overseer__overseer_coordinator"), "alias keeps a readable head");
});

test("short ASCII names are unchanged, so existing sessions and tool names stay compatible", () => {
  for (const name of ["bash", "read", "ultraterm_subagents", "a".repeat(50), "x-y_z"]) {
    assert.equal(claudeToolName(name), name);
  }
  const prepared = prepareTools([tool("bash")]);
  assert.equal(prepared.nativeTools[0]?.name, "mcp__pi__bash");
  assert.equal(prepared.manifest[0]?.name, "bash");
});

test("non-ASCII and 51-character names are aliased too", () => {
  for (const name of ["résumé_tool", "a".repeat(51), "has space", "dots.in.name"]) {
    const alias = claudeToolName(name);
    assert.notEqual(alias, name);
    assert.match(alias, /^[A-Za-z0-9_-]{1,50}$/u);
  }
});

test("prepareTools offers the alias and maps a tool_use back to the real Pi tool", () => {
  const prepared = prepareTools([tool("bash"), tool(LONG)]);
  const alias = claudeToolName(LONG);
  assert.deepEqual(prepared.manifest.map((entry) => entry.name), ["bash", alias]);
  assert.deepEqual(prepared.nativeTools.map((entry) => entry.name), ["mcp__pi__bash", `${TOOL_PREFIX}${alias}`]);
  assert.equal(piToolName(`${TOOL_PREFIX}${alias}`, prepared.names), LONG);
  assert.equal(piToolName(alias, prepared.names), LONG, "a bare alias is the same call");
  assert.equal(piToolName("mcp__pi__bash", prepared.names), "bash");
  assert.throws(() => piToolName(`${TOOL_PREFIX}${LONG}`, prepared.names), /unavailable tool/u, "the unaliased long name was never offered");
  assert.throws(() => piToolName("Edit", prepared.names), /unexpected tool Edit/u);
});

test("duplicate real names and two names that share an alias are refused by name", () => {
  assert.throws(() => prepareTools([tool("bash"), tool("bash")]), /"bash" is offered twice/u);
  const alias = claudeToolName(LONG);
  // A short tool that happens to be named exactly like another tool's alias would make calls ambiguous.
  assert.throws(() => prepareTools([tool(LONG), tool(alias)]), new RegExp(`"${LONG}" and "${alias}" map to the same Claude tool name`, "u"));
});

test("replayed tool calls, tool changes and the native transcript all use the alias", () => {
  const initial = { role: "system", content: "sys", toolsAdded: [tool("bash")], timestamp: 1 } as unknown as Message;
  const added = { role: "system", content: "", toolsAdded: [tool(LONG)], timestamp: 2 } as unknown as Message;
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "toolCall", id: "t1", name: LONG, arguments: { note: 1 } }],
    api: "anthropic-messages",
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    usage,
    stopReason: "toolUse",
    timestamp: 3,
  } as AssistantMessage;
  const result = { role: "toolResult", toolCallId: "t1", toolName: LONG, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 4 } as unknown as Message;
  const messages = [initial, { role: "user", content: "go", timestamp: 1 } as Message, added, assistant, result];
  const alias = `${TOOL_PREFIX}${claudeToolName(LONG)}`;

  const frames = prepareFrames(messages);
  const toolUse = frames.flatMap((frame) => frame.message.content as Array<Record<string, unknown>>).find((block) => block.type === "tool_use");
  assert.equal(toolUse?.name, alias);

  const plan = prepareNativeTranscript(messages, true);
  assert.ok(plan, "native transcript plan is built with a long-named tool");
  const offered = plan.requestTools.map((entry) => String(entry.name));
  assert.ok(offered.includes(alias), offered.join(","));
  for (const name of offered) assert.match(name, WIRE_NAME);
  const references = plan.systemInjections.flatMap((injection) => injection.content)
    .filter((block) => block.type === "tool_addition")
    .map((block) => (block.tool as { name: string }).name);
  assert.deepEqual(references, [alias]);
});

// A fake Claude Code CLI on the real runtime path: it reads the tool inventory Pi offered through the
// inert MCP manifest (as the real CLI does) and calls the long tool by the name it was offered.
const FAKE = `#!/usr/bin/env node
import readline from "node:readline";
import { readFileSync, appendFileSync } from "node:fs";
if (process.argv.includes("auth")) { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })); process.exit(0); }
const config = JSON.parse(process.argv[process.argv.indexOf("--mcp-config") + 1]);
const manifest = JSON.parse(readFileSync(config.mcpServers.pi.args[1], "utf8"));
appendFileSync(process.env.OFFERED, JSON.stringify(manifest.map(t => t.name)) + "\\n");
const usage = { input_tokens: 1, output_tokens: 1 };
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.shouldQuery === false) { console.log(JSON.stringify({ type: "result", num_turns: 0 })); continue; }
  if (frame.type !== "user") continue;
  const answered = frame.message.content.some(b => b.type === "tool_result");
  const target = manifest.find(t => t.name.startsWith("mcp__overseer__"));
  const content = answered ? [{ type: "text", text: "noted" }]
    : [{ type: "tool_use", id: "note-1", name: "mcp__pi__" + target.name, input: { note: 17 } }];
  console.log(JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }));
  console.log(JSON.stringify({ type: "assistant", message: { id: "m", role: "assistant", content, stop_reason: answered ? "end_turn" : "tool_use", usage } }));
  console.log(JSON.stringify({ type: "result", subtype: answered ? "success" : "error_max_turns", is_error: !answered, usage }));
}
`;

test("runtime route: an agent turn on the Claude provider calls a 52-character MCP tool and finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "long-tool-names-"));
  const executable = join(root, "claude.mjs");
  const offered = join(root, "offered.jsonl");
  await writeFile(executable, FAKE);
  await chmod(executable, 0o755);
  await writeFile(offered, "");
  const calls: unknown[] = [];
  const agent = new Agent({
    initialState: {
      model: CLAUDE_CODE_MODELS.find((model) => model.id.includes("haiku")) ?? CLAUDE_CODE_MODELS[0]!,
      tools: [{
        name: LONG,
        label: "note disposition",
        description: "fixture coordinator note disposition",
        parameters: Type.Object({ note: Type.Number() }),
        execute: async (_id, args) => {
          calls.push(args);
          return { content: [{ type: "text", text: "recorded" }], details: {} };
        },
      }],
    },
    streamFn: (model, context, options) => streamClaudeCode(model, context, {
      ...options,
      timeoutMs: 10_000,
      env: { PI_CLAUDE_CODE_COMMAND: executable, OFFERED: offered },
    }),
  });
  try {
    await agent.prompt("Record the disposition of note 17");
    assert.deepEqual(calls, [{ note: 17 }], "Pi executed the real long-named tool");
    const final = agent.state.messages.at(-1);
    assert.equal(final?.role, "assistant");
    assert.equal((final as AssistantMessage).stopReason, "stop", (final as AssistantMessage).errorMessage ?? "");
    const toolCall = agent.state.messages.flatMap((message) => (message.role === "assistant" ? message.content : []))
      .find((block) => block.type === "toolCall");
    assert.equal(toolCall && "name" in toolCall ? toolCall.name : undefined, LONG, "the transcript keeps the real name");
    const lists = (await readFile(offered, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.ok(lists.length >= 1);
    for (const list of lists) {
      assert.deepEqual(list, [claudeToolName(LONG)]);
      for (const name of list) assert.ok(`${TOOL_PREFIX}${name}`.length <= 64);
    }
  } finally {
    agent.abort();
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

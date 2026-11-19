#!/usr/bin/env node
// A fake `agy`: prints recorded stream-json shaped like Google's headless docs. Scenario comes from FAKE_AGY_SCENARIO;
// every invocation's argv is appended to FAKE_AGY_LOG (one JSON array per line); FAKE_AGY_PIDS gets pids to check cleanup.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(args) + "\n");
const scenario = process.env.FAKE_AGY_SCENARIO || "success";
const C = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const step = (s) => out({ event: "step_update", step_update: { conversation_id: C, ...s } });
const usage = { input_tokens: 10302, output_tokens: 582, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 10884 };
const result = (status, extra = {}) => out({ event: "result", result: { conversation_id: C, status, response: "", duration_seconds: 1, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, ...extra } });
const init = () => out({ event: "init", conversation_id: C, init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: "request-review" } });

if (args[0] === "models") {
  if (scenario === "signed-out") { process.stderr.write("Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n"); process.exit(1); }
  process.stdout.write("gemini-x-high Gemini X (High)\ngemini-x-low Gemini X (Low)\nother-model Other (Medium)\n");
  process.exit(0);
}
if (process.env.FAKE_AGY_PIDS) appendFileSync(process.env.FAKE_AGY_PIDS, `${process.pid}\n`);
switch (scenario) {
  case "success":
    init();
    step({ step_index: 0, state: "DONE", step_type: "user_input" });
    step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "Git rebase " });
    step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "rewrites history." });
    step({ step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "\n", duration_seconds: 6.28, usage });
    step({ step_index: 4, state: "DONE", step_type: "checkpoint", usage: { input_tokens: 116, output_tokens: 7, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 123 } });
    result("SUCCESS", { response: "Git rebase rewrites history.\n", usage: { input_tokens: 10418, output_tokens: 589, thinking_tokens: 551, cache_read_tokens: 8113, total_tokens: 11007 } });
    break;
  case "tool":
    init();
    step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command" });
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", duration_seconds: 0.07, tool_info: { name: "run_command", parameters: { CommandLine: "echo hello_headless_demo" }, output: "hello_headless_demo\r\n" } });
    step({ step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "It printed hello_headless_demo.\n", usage });
    result("SUCCESS", { response: "It printed hello_headless_demo.\n" });
    break;
  case "done-only":
    init();
    step({ step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "whole answer\n" });
    result("SUCCESS", { response: "whole answer\n" });
    break;
  case "auth-error": // real unauthenticated output of agy 1.5.12: exit 1 with an ERROR result
    out({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out", duration_seconds: 0, num_turns: 0, usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }, finished_reason: "error" } });
    process.stderr.write("Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?secret=1\nerror: authentication failed or timed out\n");
    process.exit(1);
  case "model-error":
    out({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error: `invalid model selection (--model "x" --effort ""): model x is not recognized as a known model or custom model in settings\nAvailable models:\n Gemini X (High)`, duration_seconds: 0, num_turns: 0, usage: {} } });
    process.exit(1);
  case "canceled": init(); result("CANCELED"); break;
  case "interrupted": init(); result("INTERRUPTED"); break;
  case "waiting": init(); result("WAITING"); break;
  case "hang": case "stubborn": {
    init();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); // a grandchild in the same group
    if (process.env.FAKE_AGY_PIDS) appendFileSync(process.env.FAKE_AGY_PIDS, `${child.pid}\n`);
    if (scenario === "stubborn") { process.on("SIGINT", () => {}); process.on("SIGTERM", () => {}); }
    else process.on("SIGINT", () => { result("INTERRUPTED"); process.exit(130); });
    process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: C, step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "working" } }) + "\n");
    setInterval(() => {}, 1000);
    break;
  }
  default: process.stderr.write(`unknown scenario ${scenario}\n`); process.exit(3);
}

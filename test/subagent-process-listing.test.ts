import { describe, expect, it } from "vitest";
import { buildPiWorkerSystemPrompt } from "../src/subagents/pi-worker.ts";
import { buildClaudeWorkerPrompt, buildClaudeWorkerContinuationPrompt } from "../src/subagents/claude-worker.ts";
import { USAP_VERSION, emptyUsage, type RunRecord, type TaskRecord } from "../src/subagents/types.ts";

function fixture(role: TaskRecord["role"], allowBash: boolean, model: string): RunRecord {
  const task: TaskRecord = {
    id: "leaf", label: "inspect", task: "Inspect the assigned file.", role,
    mayEdit: false, ownedPaths: [], allowBash, state: "queued", output: "",
    turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false,
  };
  return {
    version: USAP_VERSION, id: "run", goal: "Inspect a file", constraints: [], cwd: "/repo",
    model, thinkingLevel: "low", concurrency: 1, timeoutMs: 10_000, maxTurns: 64,
    background: false, state: "running", createdAt: 1, tasks: [task], usage: emptyUsage(),
  };
}

function assertGuidance(prompt: string): void {
  expect(prompt).toContain("Treat any full process command line as if it contained credentials");
  expect(prompt).toContain("List processes by PID and name only");
  expect(prompt).toContain('`pgrep -f "pattern"` (PIDs only)');
  expect(prompt).toContain("`ps -o pid,ppid,etime,comm -p <pid>`");
  expect(prompt).toContain("Never print a full command line and never print an environment listing");
}

describe("harness-owned process-listing guidance (synthetic prompt tests)", () => {
  for (const role of ["scout", "worker", "reviewer"] as const) {
    for (const allowBash of [false, true]) {
      for (const model of ["test/model", "claude-code/claude-sonnet-5-5", "claude-code-api/claude-sonnet-5-5"]) {
        it(`${model} ${role} bash=${allowBash}: does not depend on parent instructions`, () => {
          const run = fixture(role, allowBash, model);
          const task = run.tasks[0];
          const prompt = model === "test/model"
            ? buildPiWorkerSystemPrompt(run, task) : buildClaudeWorkerPrompt(run, task);
          assertGuidance(prompt.split("## Shared run contract")[0]);
        });
      }
      it(`Claude continuation ${role} bash=${allowBash}: repeats the safety rule`, () => {
        const run = fixture(role, allowBash, "claude-code/claude-sonnet-5-5");
        assertGuidance(buildClaudeWorkerContinuationPrompt(run.tasks[0], 12));
      });
    }
  }
});

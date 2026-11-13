import { describe, expect, it } from "vitest";
import { classifyPiWorkerState } from "../src/subagents/pi-worker.ts";
import { finalWorkerReport } from "../src/subagents/coordinator.ts";
import { emptyUsage, type TaskRecord } from "../src/subagents/types.ts";

const signal = new AbortController().signal;
function record(): TaskRecord {
  return {
    id: "t-1", label: "Scout", task: "Report", role: "scout", mayEdit: false, ownedPaths: [], allowBash: false,
    state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false,
  };
}

describe("native worker turn budget", () => {
  it("synthetic: a budget stop after a complete final report is done with a note", () => {
    const result = classifyPiWorkerState({
      signal, turnLimitReached: true, maxTurns: 64, turns: 64, finalReportComplete: true,
      finalAssistant: { text: "complete report", toolCalls: false, stopReason: "stop" },
    });
    expect(result).toEqual({ state: "done", note: "turn budget reached (64 of 64); final report complete" });
  });

  it("synthetic: a budget stop with no complete report stays failed and names the budget", () => {
    const result = classifyPiWorkerState({
      signal, turnLimitReached: true, maxTurns: 64, turns: 64, finalReportComplete: false,
      finalAssistant: { text: "", toolCalls: true, stopReason: "toolUse" },
    });
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/64-turn limit/);
  });

  it("synthetic: the host report header shows the note for a done task", () => {
    const text = finalWorkerReport(record(), "done", "body", undefined, "turn budget reached (64 of 64); final report complete");
    expect(text).toContain("Status: done: turn budget reached (64 of 64); final report complete");
  });
});

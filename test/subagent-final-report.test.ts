import { describe, expect, it } from "vitest";
import { buildPiWorkerSystemPrompt } from "../src/subagents/pi-worker.ts";
import { SubagentCoordinator, workerJournal } from "../src/subagents/coordinator.ts";
import { USAP_VERSION, emptyUsage, type RunRecord, type TaskRecord } from "../src/subagents/types.ts";
import { NoopSlots } from "../src/subagents/machine-slots.ts";

function fixture(): RunRecord {
  const task: TaskRecord = {
    id: "report-task", label: "report", task: "Edit owned file", role: "worker",
    mayEdit: true, ownedPaths: ["/repo/owned.ts"], allowBash: false,
    state: "queued", output: "", turns: 0, usage: emptyUsage(),
    relaySent: 0, relayReceived: 0, truncated: false,
  };
  return {
    version: USAP_VERSION, id: "report-run", goal: "report", constraints: [], cwd: "/repo",
    model: "test/model", thinkingLevel: "low", concurrency: 1, timeoutMs: 10_000,
    background: false, state: "running", createdAt: 1, tasks: [task], usage: emptyUsage(),
  };
}

describe("guaranteed final reports", () => {
  it("settles turn exhaustion with incomplete status and the worker edit journal", async () => {
    const coordinator = new SubagentCoordinator(async ({ task }) => {
      const journal = workerJournal(task);
      journal.changedPaths.add("/repo/owned.ts");
      journal.lastStep = "edit";
      return { state: "failed", error: "Child exceeded the 12-turn limit", output: "", turns: 12, usage: emptyUsage() };
    }, { machineSlots: new NoopSlots() });
    coordinator.start(fixture());
    const result = (await coordinator.wait("report-run", "all")).tasks[0];
    expect(result.output).toContain("Status: incomplete: turn budget exhausted");
    expect(result.output).toContain('Changed paths: ["/repo/owned.ts"]');
    expect(result.output).toContain("last step: edit");
    await coordinator.shutdown();
  });

  it("synthesizes cancellation output even when the worker throws", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const coordinator = new SubagentCoordinator(async ({ task, signal }) => {
      workerJournal(task).changedPaths.add("/repo/owned.ts");
      workerJournal(task).lastStep = "write";
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      throw new Error("unreachable");
    }, { machineSlots: new NoopSlots() });
    coordinator.start(fixture());
    await ready;
    coordinator.cancel("report-run");
    const result = (await coordinator.wait("report-run", "all")).tasks[0];
    expect(result.output).toContain("Status: incomplete:");
    expect(result.output).toContain("cancelled");
    expect(result.output).toContain('Changed paths: ["/repo/owned.ts"]');
    expect(result.output).not.toContain("(no output)");
    await coordinator.shutdown();
  });

  it.each([false, true])("states the exact toolset for allowBash=%s", (allowBash) => {
    const run = fixture();
    run.tasks[0].allowBash = allowBash;
    expect(buildPiWorkerSystemPrompt(run, run.tasks[0])).toContain(allowBash
      ? "Toolset: bash available (unsandboxed); stay within owned paths."
      : "Toolset: no shell tool; run tests/typechecks only if the task grants bash — otherwise report and let the parent validate.");
  });
});

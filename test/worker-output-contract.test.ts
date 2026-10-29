import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPiWorkerSystemPrompt, createGuardedPiWorkerTools } from "../src/subagents/pi-worker.ts";
import { buildClaudeWorkerPrompt, classifyClaudeWorkerState } from "../src/subagents/claude-worker.ts";
import { Coordinator, finalWorkerReport } from "../src/subagents/coordinator.ts";
import { Scheduler } from "../src/subagents/scheduler.ts";
import { RelayBroker } from "../src/subagents/relay.ts";
import { USAP_VERSION, emptyUsage, type RunRecord, type TaskRecord } from "../src/subagents/types.ts";

function leaf(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "output-contract-task", label: "bounded leaf", task: "Inspect the assigned input.", role: "worker",
    mayEdit: false, allowBash: false, ownedPaths: [], state: "queued", output: "", turns: 0,
    usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, ...overrides,
  };
}
function run(task: TaskRecord, model = "openai-codex/gpt-6.1-sol"): RunRecord {
  return {
    version: USAP_VERSION, id: "output-contract", goal: "Synthetic worker contract regression", constraints: [],
    cwd: process.cwd(), model, thinkingLevel: "high", concurrency: 1, timeoutMs: 10_000, maxTurns: 64,
    background: false, state: "running", createdAt: 1, tasks: [task], usage: emptyUsage(),
  };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// These are synthetic test fixtures only, inside the test runner's isolated
// HOME. Never use the operator's cache or read real overseer evidence.
describe("synthetic: assigned staged input Read", () => {
  it("reads exactly assigned regular files natively, without directory, sibling, write, or symlink grants", async () => {
    const staging = join(homedir(), ".cache", "ut-overseer");
    await mkdir(staging, { recursive: true });
    const job = await mkdtemp(join(staging, "synthetic-worker-contract-"));
    cleanups.push(() => rm(job, { recursive: true, force: true }));
    const assigned = join(job, "assigned input.txt"), unassigned = join(job, "unassigned.txt");
    const outside = join(homedir(), "synthetic-worker-outside.txt");
    cleanups.push(() => rm(outside, { force: true }));
    await writeFile(assigned, "synthetic staged input\n");
    await writeFile(unassigned, "synthetic unassigned input\n");
    await writeFile(outside, "synthetic outside input\n");
    const escape = join(job, "escape.txt"), internalLink = join(job, "internal-link.txt");
    await symlink(outside, escape);
    await symlink(assigned, internalLink);
    const task = leaf({ mayEdit: true, ownedPaths: [join(process.cwd(), "synthetic-owned.txt")],
      task: `Read \`${assigned}\`. Also inspect \`${escape}\`, \`${internalLink}\`, and \`${job}\` if permitted.` });
    const broker = new RelayBroker(); broker.createRun("output-contract", [task.id]);
    const peer = broker.bind("output-contract", task.id);
    cleanups.push(async () => peer.close());
    const tools = createGuardedPiWorkerTools({ cwd: process.cwd(), task, relay: peer });
    const execute = (name: string, params: unknown) => tools.find(tool => tool.name === name)!.execute("synthetic", params as never, undefined, undefined, {} as never);
    const result = await execute("read", { path: assigned });
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("synthetic staged input") }));
    const tilde = assigned.replace(homedir(), "~");
    task.task = `Read \`${tilde}\`.`;
    expect((await execute("read", { path: `@${tilde}` })).content).toEqual(result.content);
    task.task = `Read \`${assigned}\`, \`${escape}\`, \`${internalLink}\`, and \`${job}\`.`;
    for (const path of [unassigned, job, staging, escape, internalLink, join(job, "..", "elsewhere.txt")]) {
      await expect(execute("read", { path })).rejects.toThrow();
    }
    // A prefix mention is not an exact file assignment.
    task.task = `Read \`${assigned}.other\`.`;
    await expect(execute("read", { path: assigned })).rejects.toThrow();
    task.task = `Read \`${assigned}\`.`;
    for (const name of ["grep", "find", "ls"]) await expect(execute(name, { path: job, pattern: ".*" })).rejects.toThrow();
    await expect(execute("write", { path: assigned, content: "not permitted" })).rejects.toThrow();
    await expect(execute("edit", { path: assigned, edits: [{ oldText: "synthetic", newText: "denied" }] })).rejects.toThrow();
    // Replacing an admitted file with a symlink must revoke the read admission.
    await rm(assigned); await symlink(outside, assigned);
    await expect(execute("read", { path: assigned })).rejects.toThrow();
  });
});

describe("synthetic: worker output contract", () => {
  const routes = [
    ["opencode-go/deepseek-v4.1-flash", "Sonnet"],
    ["anthropic/claude-haiku-4-5", "Opus"],
    ["claude-code/haiku-5-5", "Opus"],
    ["openai-codex/gpt-6.1-sol", undefined],
    ["openai-codex/gpt-6.1-terra", "Opus"],
    ["claude-code/claude-sonnet-5-5", undefined],
    ["claude-code/claude-opus-5-5", undefined],
  ] as const;
  for (const build of [buildPiWorkerSystemPrompt, buildClaudeWorkerPrompt]) {
    describe(build.name, () => {
      it.each(routes.flatMap(([model, reviewer]) => [false, true].map(mayEdit => ({ model, reviewer, mayEdit }))))(
        "synthetic: gates only implementation routes: $model mayEdit=$mayEdit", ({ model, reviewer, mayEdit }) => {
          const task = leaf({ mayEdit, ownedPaths: mayEdit ? [join(process.cwd(), "synthetic-owned.txt")] : [] });
          const prompt = build(run(task, model), task);
          if (mayEdit && reviewer) {
            expect(prompt).toContain(`official Claude Code CLI ${reviewer} 5.5 at xhigh effort via the USAP claude-code route`);
            expect(prompt).toContain("GPT-6.1 Terra fallback review");
            expect(prompt).toContain("if you produced implementation");
          } else {
            expect(prompt).not.toContain("End-gate:");
            expect(prompt).not.toContain("needs exactly one bounded expert review");
          }
        },
      );
      it.each(["task", "contract"])("honors an explicit JSON %s format over default prose headings", source => {
        const task = leaf(), record = run(task);
        const format = 'Return exactly JSON matching {"accepted": boolean, "reason": string}, with no prose.';
        if (source === "task") task.task = format; else record.contract = format;
        const prompt = build(record, task);
        expect(prompt).toContain(format);
        expect(prompt).toContain("Follow any explicit output format or schema in the exact leaf or shared run contract instead of the default headings");
        expect(prompt).toContain("return only that format: no Markdown fences, headings, or surrounding prose");
        expect(prompt).not.toContain("Return only a concise report with these headings");
      });
    });
  }

  it.each(["", " \n\t", "(no output)"])("rejects an attested successful Claude result with no output (%s)", output => {
    expect(classifyClaudeWorkerState({ signal: new AbortController().signal, exitCode: 0, exitSignal: null, maxTurns: 64,
      state: { outputParts: [output], outputLength: output.length, turns: 1, toolErrors: 0, toolSuccesses: 0,
        turnLimitReached: false, usage: emptyUsage(), sawResult: true, modelVerified: true,
        result: { kind: "result", isError: false, subtype: "success" } },
    })).toMatchObject({ state: "failed", error: expect.stringContaining("no final output") });
  });

  it.each(["empty", "whitespace", "placeholder", "host-header"])("coordinator cannot complete a no-output worker (%s)", async kind => {
    const task = leaf(), record = run(task);
    const output = kind === "empty" ? "" : kind === "whitespace" ? " \n\t" : kind === "placeholder" ? "(no output)" : finalWorkerReport(task, "done", "");
    const coordinator = new Coordinator(async () => ({ state: "done", output, turns: 1, usage: emptyUsage() }), { scheduler: new Scheduler(1) });
    cleanups.push(() => coordinator.shutdown());
    coordinator.start(record);
    const settled = await coordinator.wait(record.id, "all");
    expect(settled.state).toBe("failed");
    expect(settled.tasks[0]).toMatchObject({ state: "failed", error: "Child produced no final output" });
    expect(settled.tasks[0].output).not.toContain("Status: done");
  });
});

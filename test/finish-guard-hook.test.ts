import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FINISH_GUARD_DEFAULT_MESSAGE } from "../src/finish-guard.ts";
import { scanTranscript, stopHookOutput, tailLines, TAIL_BYTES } from "../src/finish-guard-hook.ts";

const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "steak-pi");
const settings = { enabled: true, maxPushes: 3, message: FINISH_GUARD_DEFAULT_MESSAGE };

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "steak-pi-finish-guard-hook-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const line = (value: unknown) => JSON.stringify(value);
const operator = (text: string, extra: object = {}) => line({ type: "user", message: { role: "user", content: text }, ...extra });
const assistant = (text: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const todoWrite = (todos: Array<{ content: string; status: string }>) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "TodoWrite", input: { todos } }] } });
const toolResult = (size = 10) =>
  line({ type: "user", message: { role: "user", content: [{ tool_use_id: "t", type: "tool_result", content: "x".repeat(size) }] } });
const push = () => operator("Stop hook feedback:\nFINISH GUARD: you are about to end the turn with requested work still open.");
const write = (lines: string[], name = "transcript.jsonl", trailingNewline = true) => {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return path;
};

describe("tailLines", () => {
  it.each([1, 3, 7, 16, 64, 1024])("yields non-empty lines newest first across %i-byte windows", (windowBytes) => {
    const lines = ["first", "", "日本語の行", "é", "z", "a".repeat(200), "{\"k\":\"€€€\"}", "last"];
    for (const trailingNewline of [true, false]) {
      const path = write(lines, `w${windowBytes}-${trailingNewline}.jsonl`, trailingNewline);
      expect([...tailLines(path, windowBytes)]).toEqual(lines.filter(Boolean).reverse());
    }
  });

  it("handles an empty file, a single line and blank-only files", () => {
    expect([...tailLines(write([], "empty.jsonl", false))]).toEqual([]);
    expect([...tailLines(write(["only"], "one.jsonl", false), 2)]).toEqual(["only"]);
    expect([...tailLines(write(["", "", ""], "blank.jsonl", false), 2)]).toEqual([]);
  });

  it("joins a line longer than several windows", () => {
    const long = "é".repeat(5000);
    expect([...tailLines(write(["head", long, "tail"]), 64)]).toEqual(["tail", long, "head"]);
  });

  it("stops reading when the consumer stops", () => {
    const path = write(Array.from({ length: 50 }, (_, i) => `line ${i}`));
    const lines = tailLines(path, 16);
    expect(lines.next().value).toBe("line 49");
    expect(lines.return(undefined as never).done).toBe(true);
  });

  it("throws for a missing file (callers handle it)", () => {
    expect(() => [...tailLines(join(dir, "missing.jsonl"))]).toThrow();
  });
});

describe("scanTranscript", () => {
  it("takes the operator message, the final reply and the newest TodoWrite after it", () => {
    const scan = scanTranscript([
      assistant("Done, all green."),
      toolResult(),
      todoWrite([{ content: "b", status: "in_progress" }]),
      assistant("Working on it."),
      todoWrite([{ content: "a", status: "pending" }]),
      operator("fix the tests"),
      assistant("An older reply."),
    ]);
    expect(scan).toEqual({ foundOperator: true, lastUser: "fix the tests", finalText: "Done, all green.", todos: [{ content: "b", status: "in_progress" }], pushes: 0 });
  });

  it("skips tool results, meta, sidechain, interrupt markers, command output and reminder-only messages", () => {
    const scan = scanTranscript([
      operator("[Request interrupted by user for tool use]"),
      operator("<local-command-stdout>ok</local-command-stdout>"),
      operator("<system-reminder>only a reminder</system-reminder>"),
      operator("harness note", { isMeta: true }),
      line({ type: "user", isSidechain: true, message: { role: "user", content: "subagent task" } }),
      line({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "side reply" }] } }),
      toolResult(),
      line({ type: "user", message: { role: "user", content: [{ type: "text", text: "with parts" }, { type: "image" }] } }),
      "not json",
      line({ type: "summary", summary: "x" }),
    ]);
    expect(scan.lastUser).toBe("with parts");
    expect(scan.finalText).toBe("");
    expect(scan.foundOperator).toBe(true);
  });

  it("counts guard pushes after the operator message and keeps only the reply to the newest push", () => {
    const scan = scanTranscript([
      assistant("Newest reply."),
      push(),
      assistant("Older reply: still not done."),
      push(),
      assistant("First reply."),
      operator("fix it"),
      push(),
    ]);
    expect(scan.pushes).toBe(2);
    expect(scan.finalText).toBe("Newest reply.");
    const empty = scanTranscript([push(), assistant("Reply before the push."), operator("fix it")]);
    expect(empty.pushes).toBe(1);
    expect(empty.finalText).toBe("");
  });

  it("reads a TodoWrite from before the operator message only within the lookback", () => {
    const lines = [assistant("ok"), operator("continue"), toolResult(2000), todoWrite([{ content: "open", status: "pending" }])];
    expect(scanTranscript(lines, 10_000).todos).toEqual([{ content: "open", status: "pending" }]);
    expect(scanTranscript(lines, 500).todos).toEqual([]);
    expect(scanTranscript([...lines.slice(0, 2), todoWrite([{ content: "after", status: "pending" }]), operator("x")], 0).todos).toEqual([]);
  });

  it("reports no operator when the transcript has none", () => {
    expect(scanTranscript([assistant("hello"), toolResult()]).foundOperator).toBe(false);
    expect(scanTranscript([]).foundOperator).toBe(false);
  });

  it("stops pulling lines once it has what it needs", () => {
    let pulled = 0;
    function* lines() {
      for (const text of [assistant("reply"), operator("ask"), ...Array.from({ length: 1000 }, () => assistant("old"))]) { pulled += 1; yield text; }
    }
    scanTranscript(lines(), 0);
    expect(pulled).toBeLessThan(10);
  });
});

describe("stopHookOutput", () => {
  const run = (lines: string[], input: object = {}, config = settings) =>
    stopHookOutput(JSON.stringify({ transcript_path: write(lines), ...input }), config);
  const reasonOf = (output: string) => JSON.parse(output).reason as string;

  it("blocks with the open todo list", () => {
    const output = run([operator("fix it"), todoWrite([{ content: "Ship it", status: "in_progress" }]), assistant("Almost.")]);
    expect(JSON.parse(output)).toMatchObject({ decision: "block" });
    expect(reasonOf(output)).toContain("[in_progress] Ship it");
  });

  it("blocks on a reply that reports unfinished work and prints nothing when done", () => {
    expect(reasonOf(run([operator("fix it"), assistant("Shipped.\n\nStill not done: docs.")]))).toContain("Still not done");
    expect(run([operator("fix it"), todoWrite([{ content: "a", status: "completed" }]), assistant("All done and verified.")])).toBe("");
  });

  it("lets a real external blocker remain", () => {
    expect(run([operator("deploy"), line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Deploy", status: "blocked", reason: "needs 2FA" }] } }] } }), assistant("Waiting.")])).toBe("");
  });

  it("prefers the reply in the hook payload over the transcript", () => {
    const lines = [operator("fix it"), assistant("All done.")];
    expect(reasonOf(run(lines, { last_assistant_message: "Next step: run the suite." }))).toContain("Next step");
    expect(run(lines, { last_assistant_message: "  " })).toBe("");
  });

  it("never pushes when the operator asked to stop, and honors the cap", () => {
    expect(run([operator("HOLD everything"), assistant("still open")])).toBe("");
    const pushed = (count: number) => [operator("fix it"), ...Array.from({ length: count }, () => [assistant("still open"), push()]).flat(), assistant("still open")];
    expect(run(pushed(2))).not.toBe("");
    expect(run(pushed(3))).toBe("");
    expect(run(pushed(1), {}, { ...settings, maxPushes: 1 })).toBe("");
  });

  it("ends rather than loops when a stop hook is active yet no earlier push is visible", () => {
    const lines = [operator("fix it"), assistant("still open")];
    expect(run(lines, { stop_hook_active: false })).not.toBe("");
    expect(run(lines, { stop_hook_active: true })).toBe("");
    expect(run([operator("fix it"), push(), assistant("still open")], { stop_hook_active: true })).not.toBe("");
  });

  it("prints nothing when disabled, without a transcript, or without an operator message", () => {
    const lines = [operator("fix it"), assistant("still open")];
    expect(run(lines, {}, { ...settings, enabled: false })).toBe("");
    expect(stopHookOutput("{}", settings)).toBe("");
    expect(stopHookOutput("", settings)).toBe("");
    expect(run([assistant("still open")])).toBe("");
  });

  it("uses the configured message", () => {
    expect(reasonOf(run([operator("fix it"), assistant("still open")], {}, { ...settings, message: "Finish the plan." }))).toContain("FINISH GUARD: Finish the plan.");
  });

  it("throws for bad input so the entry point can swallow it", () => {
    expect(() => stopHookOutput("not json", settings)).toThrow();
    expect(() => stopHookOutput(JSON.stringify({ transcript_path: join(dir, "missing.jsonl") }), settings)).toThrow();
  });

  it("reads a large transcript from the tail only", () => {
    // 24 MB of lines that are not JSON sit before the last operator message: a head read would choke or crawl.
    const head = Array.from({ length: 3 }, () => "g".repeat(8 * 1024 * 1024));
    const tailPart = [operator("fix it"), toolResult(TAIL_BYTES), assistant("Still not done: docs.")];
    const started = performance.now();
    const output = run([...head, ...tailPart]);
    expect(reasonOf(output)).toContain("Still not done");
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("steak-pi finish-guard-hook", () => {
  const env = { ...process.env, PI_CODING_AGENT_DIR: "", STEAK_PI_FINISH_GUARD: "" };
  const hook = (stdin: string, extraEnv: Record<string, string> = {}) =>
    spawnSync("sh", [bin, "finish-guard-hook"], { input: stdin, encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 20_000 });

  it("prints the block JSON for an open todo list and exits 0", () => {
    const path = write([operator("fix it"), todoWrite([{ content: "Ship it", status: "pending" }]), assistant("Almost.")]);
    const result = hook(JSON.stringify({ transcript_path: path }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block", reason: expect.stringContaining("[pending] Ship it") });
  });

  it("prints nothing for a finished turn, for STEAK_PI_FINISH_GUARD=0, and for a settings opt-out", () => {
    const done = write([operator("fix it"), assistant("All done and verified.")], "done.jsonl");
    expect(hook(JSON.stringify({ transcript_path: done }))).toMatchObject({ status: 0, stdout: "" });
    const open = write([operator("fix it"), assistant("Still not done: docs.")], "open.jsonl");
    expect(hook(JSON.stringify({ transcript_path: open }), { STEAK_PI_FINISH_GUARD: "0" })).toMatchObject({ status: 0, stdout: "" });
    writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ finishGuard: false }));
    expect(hook(JSON.stringify({ transcript_path: open }), { PI_CODING_AGENT_DIR: dir })).toMatchObject({ status: 0, stdout: "" });
    writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ finishGuard: { message: "Configured text." } }));
    expect(JSON.parse(hook(JSON.stringify({ transcript_path: open }), { PI_CODING_AGENT_DIR: dir }).stdout).reason).toContain("FINISH GUARD: Configured text.");
  });

  it("still runs when the install path is a symlink", () => {
    const link = join(dir, "libexec");
    symlinkSync(join(dirname(bin), ".."), link);
    const path = write([operator("fix it"), assistant("Still not done: docs.")]);
    const result = hook(JSON.stringify({ transcript_path: path }), { STEAK_PI_LIBEXEC: link });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block" });
  });

  it("exits 0 with no output for garbage, an empty stdin or a missing transcript", () => {
    for (const stdin of ["garbage", "", "{}", JSON.stringify({ transcript_path: join(dir, "missing.jsonl") })]) {
      expect(hook(stdin), stdin).toMatchObject({ status: 0, stdout: "" });
    }
  });
});

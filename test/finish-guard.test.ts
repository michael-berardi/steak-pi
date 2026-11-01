import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FINISH_GUARD_DEFAULT_MESSAGE,
  FINISH_GUARD_MARK,
  finishGuardSettings,
  finishVerdict,
  openTodos,
  openWorkPhrases,
  operatorText,
  textOf,
  todosOfPhases,
} from "../src/finish-guard.ts";

const base = { todos: [], finalText: "All done and verified.", lastUserText: "fix it", continuations: 0 };

describe("finish guard decision", () => {
  it("lets a finished turn end", () => {
    expect(finishVerdict(base)).toMatchObject({ block: false, reason: "nothing open" });
  });

  it("keeps the turn going for an open todo item and lists it", () => {
    const verdict = finishVerdict({ ...base, todos: [{ content: "Disk to 70%", status: "in_progress" }] });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain(FINISH_GUARD_MARK);
    expect(verdict.reason).toContain("[in_progress] Disk to 70%");
  });

  it("treats a self-declared 'blocked' item as open", () => {
    const todos = [{ content: "Disk to 70%", status: "blocked", reason: "What remains is live job work" }];
    expect(openTodos(todos)).toHaveLength(1);
    const verdict = finishVerdict({ ...base, todos });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("(blocked: What remains is live job work)");
  });

  it.each([
    "needs the 2FA code",
    "waiting for a credential",
    "payment approval required",
    "legal sign-off pending",
    "needs the operator approval",
    "blocked on a hardware token",
  ])("lets a real external blocker remain: %s", (reason) => {
    expect(finishVerdict({ ...base, todos: [{ content: "Deploy", status: "blocked", reason }] }).block).toBe(false);
    expect(finishVerdict({ ...base, todos: [{ content: "Deploy", status: "blocked", blockedReason: reason }] }).block).toBe(false);
  });

  it("ignores finished statuses in any case", () => {
    const todos = ["done", "Completed", "DROPPED", "cancelled"].map((status) => ({ content: status, status }));
    expect(openTodos(todos)).toEqual([]);
  });

  it.each([
    "Shipped 4.2.15.\n\n**Still not done:**\n1. Disk is at 85%",
    "One bug I found but haven't fixed yet.",
    "The fix is not verified yet.",
    "Remaining items: docs",
    "Next step: run the suite.",
    "Here is what's left.",
    "That is not yet addressed.",
  ])("treats a reply that reports unfinished work as open: %s", (finalText) => {
    const verdict = finishVerdict({ ...base, finalText });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("reports unfinished work");
  });

  it("scans only the tail of a very long reply", () => {
    const long = `${"x".repeat(100_000)} Still not done: a thing.`;
    expect(openWorkPhrases(long)).toEqual(["Still not done"]);
    expect(openWorkPhrases(`Still not done ${"x".repeat(100_000)}`)).toEqual([]);
    expect(openWorkPhrases("")).toEqual([]);
  });

  it("stops at the push cap and honors a configured cap", () => {
    expect(finishVerdict({ ...base, finalText: "still open", continuations: 3 })).toMatchObject({ block: false, reason: "push cap reached" });
    expect(finishVerdict({ ...base, finalText: "still open", continuations: 2 }).block).toBe(true);
    expect(finishVerdict({ ...base, finalText: "still open", continuations: 1, maxPushes: 1 }).block).toBe(false);
    expect(finishVerdict({ ...base, finalText: "still open", continuations: 5, maxPushes: 6 }).block).toBe(true);
    expect(finishVerdict({ ...base, finalText: "still open", continuations: 0, maxPushes: 0 }).block).toBe(false);
  });

  it.each([
    "HOLD everything",
    "stop",
    "  Pause here",
    "just answer: why did it fail?",
    "only answer the question",
    "don't touch anything",
    "no changes please",
  ])("never pushes on when the operator asked to stop or only answer: %s", (lastUserText) => {
    expect(finishVerdict({ ...base, finalText: "still open", lastUserText }).block).toBe(false);
    expect(finishVerdict({ ...base, todos: [{ content: "x", status: "pending" }], lastUserText }).block).toBe(false);
  });

  it("does not read harness reminders as the operator speaking", () => {
    const user = "fix the rest\n<system-reminder>send/HOLD/redrive gotchas; wait with finite timeouts</system-reminder>";
    expect(operatorText(user)).toBe("fix the rest");
    expect(finishVerdict({ ...base, finalText: "Still not done: disk", lastUserText: user }).block).toBe(true);
  });

  it("uses the configured message and keeps the guard mark", () => {
    const verdict = finishVerdict({ ...base, finalText: "still open", message: "Finish the list first." });
    expect(verdict.reason.split("\n")[0]).toBe(`${FINISH_GUARD_MARK}: Finish the list first.`);
    expect(finishVerdict({ ...base, finalText: "still open" }).reason).toContain(FINISH_GUARD_DEFAULT_MESSAGE);
  });
});

describe("finish guard helpers", () => {
  it("reads text parts of string and part-list content", () => {
    expect(textOf("hi")).toBe("hi");
    expect(textOf([{ type: "thinking", thinking: "no" }, { type: "text", text: "a" }, { type: "toolCall" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(textOf(undefined)).toBe("");
    expect(textOf([null, { type: "text" }])).toBe("");
  });

  it("flattens todo phases and ignores anything else", () => {
    expect(todosOfPhases([{ name: "a", items: [{ content: "x", status: "pending" }] }, { name: "b", items: [{ content: "y", status: "blocked", reason: "why" }, null] }, null, { name: "c" }]))
      .toEqual([{ content: "x", status: "pending", reason: undefined }, { content: "y", status: "blocked", reason: "why" }]);
    expect(todosOfPhases(undefined)).toBeUndefined();
    expect(todosOfPhases({})).toBeUndefined();
  });
});

describe("finish guard settings", () => {
  const dirs: string[] = [];
  const saved = { env: process.env.STEAK_PI_FINISH_GUARD, dir: process.env.PI_CODING_AGENT_DIR };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (saved.env === undefined) delete process.env.STEAK_PI_FINISH_GUARD; else process.env.STEAK_PI_FINISH_GUARD = saved.env;
    if (saved.dir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.dir;
  });
  const file = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), "steak-pi-finish-guard-"));
    dirs.push(dir);
    const path = join(dir, "steak-pi.json");
    writeFileSync(path, content);
    return path;
  };

  it("is on with the defaults when nothing is configured", () => {
    delete process.env.STEAK_PI_FINISH_GUARD;
    expect(finishGuardSettings(join(tmpdir(), "steak-pi-no-such-settings.json"))).toEqual({ enabled: true, maxPushes: 3, message: FINISH_GUARD_DEFAULT_MESSAGE });
    expect(finishGuardSettings(file("{not json"))).toMatchObject({ enabled: true, maxPushes: 3 });
    expect(finishGuardSettings(file(JSON.stringify({ holdDeleteClearsInput: false })))).toMatchObject({ enabled: true });
  });

  it("reads enabled, maxPushes and message from finishGuard", () => {
    delete process.env.STEAK_PI_FINISH_GUARD;
    expect(finishGuardSettings(file(JSON.stringify({ finishGuard: false })))).toMatchObject({ enabled: false });
    expect(finishGuardSettings(file(JSON.stringify({ finishGuard: { enabled: false } })))).toMatchObject({ enabled: false });
    expect(finishGuardSettings(file(JSON.stringify({ finishGuard: { maxPushes: 1, message: "  Keep going.  " } }))))
      .toEqual({ enabled: true, maxPushes: 1, message: "Keep going." });
    expect(finishGuardSettings(file(JSON.stringify({ finishGuard: { maxPushes: 0 } }))).maxPushes).toBe(0);
  });

  it("ignores invalid values and bounds the cap and the message", () => {
    delete process.env.STEAK_PI_FINISH_GUARD;
    const invalid = finishGuardSettings(file(JSON.stringify({ finishGuard: { enabled: "no", maxPushes: -1, message: 7 } })));
    expect(invalid).toEqual({ enabled: true, maxPushes: 3, message: FINISH_GUARD_DEFAULT_MESSAGE });
    expect(finishGuardSettings(file(JSON.stringify({ finishGuard: { maxPushes: 1000, message: "m".repeat(5000) } })))).toMatchObject({ maxPushes: 20, message: "m".repeat(2000) });
    expect(finishGuardSettings(file(JSON.stringify({ finishGuard: { maxPushes: 1.5, message: "  " } })))).toMatchObject({ maxPushes: 3, message: FINISH_GUARD_DEFAULT_MESSAGE });
  });

  it("STEAK_PI_FINISH_GUARD=0 turns it off whatever the file says", () => {
    const path = file(JSON.stringify({ finishGuard: { enabled: true } }));
    for (const value of ["0", "false", "OFF", " no "]) {
      process.env.STEAK_PI_FINISH_GUARD = value;
      expect(finishGuardSettings(path).enabled, value).toBe(false);
    }
    process.env.STEAK_PI_FINISH_GUARD = "1";
    expect(finishGuardSettings(path).enabled).toBe(true);
  });

  it("finds steak-pi.json under PI_CODING_AGENT_DIR", () => {
    delete process.env.STEAK_PI_FINISH_GUARD;
    const path = file(JSON.stringify({ finishGuard: { maxPushes: 2 } }));
    process.env.PI_CODING_AGENT_DIR = join(path, "..");
    expect(finishGuardSettings().maxPushes).toBe(2);
  });
});

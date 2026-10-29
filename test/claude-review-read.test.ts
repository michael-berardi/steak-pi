import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeReviewReadDirs } from "../src/subagents/claude-review-read.ts";
import { claudeWorkerArgs } from "../src/subagents/claude-worker.ts";
import { type TaskRecord, emptyUsage } from "../src/subagents/types.ts";

// Hermetic: a fake HOME under the OS temp dir, never the operator's cache.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "j3068-home-"));
  const review = join(home, ".cache", "ut-overseer", "J-3068", "review");
  mkdirSync(review, { recursive: true });
  writeFileSync(join(review, "evidence.md"), "synthetic evidence\n");
  mkdirSync(join(home, ".cache", "ut-overseer", "J-9999", "review"), { recursive: true });
  writeFileSync(join(home, ".cache", "ut-overseer", "J-9999", "review", "other.md"), "other job\n");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const REVIEW = () => join(home, ".cache", "ut-overseer", "J-3068", "review");
const reviewer = (task: string) => ({ role: "reviewer", mayEdit: false, task });

function leaf(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id: "t1", label: "Review", task: "Review the evidence", role: "reviewer", mayEdit: false, ownedPaths: [], allowBash: false,
    state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, ...overrides,
  } as TaskRecord;
}

describe("claude reviewer read grant (J-3068)", () => {
  it("grants only the one review folder a reviewer explicitly names", () => {
    const task = `Read ${REVIEW()}/evidence.md and report.`;
    expect(claudeReviewReadDirs(reviewer(task), home)).toEqual([REVIEW()]);
  });

  it("accepts the ~/ spelling of the same staged file", () => {
    const task = "Read ~/.cache/ut-overseer/J-3068/review/evidence.md then report.";
    expect(claudeReviewReadDirs(reviewer(task), home)).toEqual([REVIEW()]);
  });

  it("grants an explicitly named other-job folder only, never ambient access to it", () => {
    const other = join(home, ".cache", "ut-overseer", "J-9999", "review");
    expect(claudeReviewReadDirs(reviewer(`Review the run cwd only.`), home)).toEqual([]);
    expect(claudeReviewReadDirs(reviewer(`Read ${other}/other.md`), home)).toEqual([other]);
  });

  it("grants nothing when the task names no staged file", () => {
    expect(claudeReviewReadDirs(reviewer("Review the diff in the run cwd."), home)).toEqual([]);
  });

  it("never grants the cache root, a job folder, or a non-review file", () => {
    expect(claudeReviewReadDirs(reviewer(`Read ${join(home, ".cache", "ut-overseer", "J-3068", "evidence.md")}`), home)).toEqual([]);
    expect(claudeReviewReadDirs(reviewer(`Read ${join(home, ".cache", "ut-overseer")}`), home)).toEqual([]);
    expect(claudeReviewReadDirs(reviewer(`List ${join(home, ".cache", "ut-overseer", "J-3068")}`), home)).toEqual([]);
  });

  it("refuses path traversal out of the review folder", () => {
    expect(claudeReviewReadDirs(reviewer(`Read ${REVIEW()}/../../J-9999/review/other.md`), home)).toEqual([]);
  });

  it("never grants to a writer or a non-reviewer role", () => {
    const task = `Read ${REVIEW()}/evidence.md`;
    expect(claudeReviewReadDirs({ role: "reviewer", mayEdit: true, task }, home)).toEqual([]);
    expect(claudeReviewReadDirs({ role: "worker", mayEdit: false, task }, home)).toEqual([]);
    expect(claudeReviewReadDirs({ role: undefined, mayEdit: false, task }, home)).toEqual([]);
  });

  it("refuses a symlinked review folder", () => {
    const real = join(home, "elsewhere");
    mkdirSync(real);
    writeFileSync(join(real, "x.md"), "x");
    rmSync(REVIEW(), { recursive: true, force: true });
    symlinkSync(real, REVIEW());
    expect(claudeReviewReadDirs(reviewer(`Read ${REVIEW()}/x.md`), home)).toEqual([]);
  });

  it("the argv adds --add-dir for the granted folder and keeps every write and shell guard", () => {
    const args = claudeWorkerArgs(8, { role: "reviewer", mayEdit: false, task: `Read ${REVIEW()}/evidence.md`, home } as never);
    const i = args.indexOf("--add-dir");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(REVIEW());
    expect(args.join(" ")).not.toMatch(/Bash|Write|Edit|dangerously/);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  it("omits --add-dir when no grant applies", () => {
    const args = claudeWorkerArgs(8, { role: "reviewer", mayEdit: false, task: "Review the run cwd." } as never);
    expect(args).not.toContain("--add-dir");
  });
});

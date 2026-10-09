import { describe, expect, it } from "vitest";
import {
  assertClaudeReviewArgsShellFree,
  claudeShellPolicy,
  isClaudeReadOnlyReview,
  CLAUDE_REVIEW_SHELL_ARGS_REJECTED,
  CLAUDE_REVIEW_SHELL_SUPPRESSED,
  CLAUDE_REVIEW_TOOLS,
} from "../src/subagents/claude-review-permissions.ts";
import { CLAUDE_CODE_ALLOWED_TOOLS } from "../src/subagents/claude-worker.ts";

// Every input and argv below is a SYNTHETIC fixture. Nothing here spawns the
// Claude CLI or touches a shell; the checks only exercise the pure helpers.

const BASE_ARGS = [
  "--print", "--output-format", "stream-json", "--verbose", "--model", "claude-opus-5-5", "--effort", "xhigh",
  "--no-session-persistence", "--permission-mode", "dontAsk", "--safe-mode", "--restricted",
  "--setting-sources", "", "--strict-mcp-config",
];

function syntheticArgs(tools: string, allowed: string[] = []): string[] {
  return [...BASE_ARGS, "--tools", tools, ...(allowed.length === 0 ? [] : ["--allowedTools", ...allowed])];
}

describe("claude read-only reviewer shell policy (synthetic)", () => {
  it("keeps the reviewer tool set identical to the worker's read-only allowlist", () => {
    expect(CLAUDE_REVIEW_TOOLS.join(",")).toBe(CLAUDE_CODE_ALLOWED_TOOLS);
  });

  it("withholds shell from a read-only reviewer that asked for allowBash, with a named diagnostic", () => {
    const policy = claudeShellPolicy({ role: "reviewer", mayEdit: false, allowBash: true });
    expect(policy.allowBash).toBe(false);
    expect(policy.suppressed).toBe(true);
    expect(policy.diagnostic).toContain(CLAUDE_REVIEW_SHELL_SUPPRESSED);
    expect(policy.diagnostic).toMatch(/aliases, pipelines and interpreters/);
    expect(policy.diagnostic).toMatch(/signal arbitrary processes/);
    expect(policy.diagnostic).toMatch(/parent must stage git evidence/);
    expect(policy.permissionLine).toContain("Read, Grep, Glob only");
    expect(policy.permissionLine).toContain(CLAUDE_REVIEW_SHELL_SUPPRESSED);
    expect(policy.permissionLine).not.toMatch(/\bBash\b/);
    expect(policy.bashStatus).toBe(`no (${CLAUDE_REVIEW_SHELL_SUPPRESSED}: read-only reviewer)`);
    expect(policy.bashStatus).not.toMatch(/^yes/);
  });

  it("emits no diagnostic when a read-only reviewer never asked for a shell", () => {
    expect(claudeShellPolicy({ role: "reviewer", mayEdit: false, allowBash: false })).toEqual({
      allowBash: false, suppressed: false, bashStatus: "no",
    });
    expect(claudeShellPolicy({ role: "reviewer" })).toEqual({ allowBash: false, suppressed: false, bashStatus: "no" });
  });

  it("treats a missing or malformed mayEdit and role spelling variants as read-only review", () => {
    for (const role of ["reviewer", "Reviewer", "REVIEWER", " reviewer\n"]) {
      expect(isClaudeReadOnlyReview({ role, mayEdit: false })).toBe(true);
      expect(claudeShellPolicy({ role, allowBash: true }).allowBash).toBe(false);
    }
    for (const mayEdit of [undefined, false, "true", 1, null] as unknown as boolean[]) {
      expect(isClaudeReadOnlyReview({ role: "reviewer", mayEdit })).toBe(true);
      expect(claudeShellPolicy({ role: "reviewer", mayEdit, allowBash: true }).suppressed).toBe(true);
    }
  });

  it("never grants a shell to a read-only reviewer across the whole synthetic input matrix", () => {
    for (const allowBash of [true, false, undefined, "yes", 1] as unknown as boolean[]) {
      for (const mayEdit of [false, undefined] as Array<boolean | undefined>) {
        expect(claudeShellPolicy({ role: "reviewer", mayEdit, allowBash }).allowBash).toBe(false);
      }
    }
  });

  it("leaves an explicitly authorized editable worker shell unchanged", () => {
    expect(claudeShellPolicy({ role: "worker", mayEdit: true, allowBash: true })).toEqual({
      allowBash: true, suppressed: false, bashStatus: "yes (unsandboxed, operator trust domain)",
    });
    expect(claudeShellPolicy({ role: "worker", mayEdit: true, allowBash: false })).toEqual({
      allowBash: false, suppressed: false, bashStatus: "no",
    });
  });

  it("does not change an editable reviewer, a scout or a read-only worker", () => {
    // Outside the P-0525 contract (role reviewer AND mayEdit false): behavior is as before.
    for (const input of [
      { role: "reviewer", mayEdit: true, allowBash: true },
      { role: "scout", mayEdit: false, allowBash: true },
      { role: "worker", mayEdit: false, allowBash: true },
    ]) {
      expect(isClaudeReadOnlyReview(input)).toBe(false);
      expect(claudeShellPolicy(input)).toEqual({
        allowBash: true, suppressed: false, bashStatus: "yes (unsandboxed, operator trust domain)",
      });
    }
  });
});

describe("claude read-only reviewer argv guard (synthetic)", () => {
  const reviewer = { role: "reviewer", mayEdit: false, allowBash: true };

  it("accepts the read-only argv and the same argv for any non-review leaf", () => {
    expect(() => assertClaudeReviewArgsShellFree(reviewer, syntheticArgs("Read,Grep,Glob"))).not.toThrow();
    expect(() => assertClaudeReviewArgsShellFree(reviewer, syntheticArgs("Read Grep Glob", ["Read", "Glob(src/**)"]))).not.toThrow();
  });

  it("is a no-op for an authorized editable worker shell", () => {
    const worker = { role: "worker", mayEdit: true, allowBash: true };
    const args = syntheticArgs("Read,Grep,Glob,Edit,Write,NotebookEdit,Bash", ["Edit(//repo/src/a.ts)", "Bash"]);
    expect(() => assertClaudeReviewArgsShellFree(worker, args)).not.toThrow();
  });

  it("rejects Bash in --tools for a read-only reviewer", () => {
    expect(() => assertClaudeReviewArgsShellFree(reviewer, syntheticArgs("Read,Grep,Glob,Bash"))).toThrow(CLAUDE_REVIEW_SHELL_ARGS_REJECTED);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, syntheticArgs("Read,Grep,Glob,Edit"))).toThrow(/not one of Read, Grep, Glob/);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, syntheticArgs("default"))).toThrow(CLAUDE_REVIEW_SHELL_ARGS_REJECTED);
  });

  it("rejects unscoped and scoped Bash allow rules, including interpreter and kill rules", () => {
    for (const rule of ["Bash", "Bash(*)", "Bash(git status:*)", "Bash(python:*)", "Bash(kill:*)", "bash", "Read,Bash", "Edit(//repo/a.ts)"]) {
      expect(() => assertClaudeReviewArgsShellFree(reviewer, syntheticArgs("Read,Grep,Glob", [rule]))).toThrow(CLAUDE_REVIEW_SHELL_ARGS_REJECTED);
    }
  });

  it("rejects a Bash rule hidden after a permitted one and the alternate flag spelling", () => {
    expect(() => assertClaudeReviewArgsShellFree(reviewer, syntheticArgs("Read,Grep,Glob", ["Read", "Bash"]))).toThrow(CLAUDE_REVIEW_SHELL_ARGS_REJECTED);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, [...syntheticArgs("Read,Grep,Glob"), "--allowed-tools", "Bash"])).toThrow(CLAUDE_REVIEW_SHELL_ARGS_REJECTED);
  });

  it("fails closed on a missing, repeated, valueless or inline --tools", () => {
    expect(() => assertClaudeReviewArgsShellFree(reviewer, BASE_ARGS)).toThrow(/--tools is missing/);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, [...syntheticArgs("Read"), "--tools", "Bash"])).toThrow(/more than once/);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, [...BASE_ARGS, "--tools"])).toThrow(/no value/);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, [...BASE_ARGS, "--tools=Bash"])).toThrow(/inline form/);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, [...syntheticArgs("Read"), "--allowedTools=Bash"])).toThrow(/inline form/);
  });

  it("requires dontAsk and rejects permission-skip flags", () => {
    const withMode = (mode: string) => syntheticArgs("Read,Grep,Glob").map((arg) => (arg === "dontAsk" ? mode : arg));
    expect(() => assertClaudeReviewArgsShellFree(reviewer, withMode("bypassPermissions"))).toThrow(/dontAsk/);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, syntheticArgs("Read,Grep,Glob").filter((arg) => arg !== "--permission-mode" && arg !== "dontAsk"))).toThrow(/dontAsk/);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, [...syntheticArgs("Read,Grep,Glob"), "--dangerously-skip-permissions"])).toThrow(/permission-skip/);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, [...syntheticArgs("Read,Grep,Glob"), "--allow-dangerously-skip-permissions"])).toThrow(/permission-skip/);
  });

  it("rejects the argv an ungated allowBash would build for a read-only reviewer", () => {
    // Synthetic copy of the pre-fix argv shape: this is the gap the guard closes.
    const ungated = syntheticArgs("Read,Grep,Glob,Bash", ["Bash"]);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, ungated)).toThrow(CLAUDE_REVIEW_SHELL_ARGS_REJECTED);
    const gated = claudeShellPolicy(reviewer).allowBash;
    const fixed = syntheticArgs(gated ? "Read,Grep,Glob,Bash" : "Read,Grep,Glob", gated ? ["Bash"] : []);
    expect(() => assertClaudeReviewArgsShellFree(reviewer, fixed)).not.toThrow();
  });
});

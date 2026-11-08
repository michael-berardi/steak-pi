import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectPolicy } from "../src/subagents/project-policy.ts";

describe("resolveProjectPolicy", () => {
  const root = mkdtempSync(join(tmpdir(), "steak-policy-"));
  const policy = join(root, "policy.json");
  writeFileSync(policy, JSON.stringify({ noClaudeProjects: ["Alpha"], planOnlyProjects: ["beta", " "] }));

  it("matches a whole folder name, case-insensitively, in the cwd", () => {
    expect(resolveProjectPolicy(join(root, "ALPHA", "src"), [], { policyPath: policy })).toEqual({ noClaude: "alpha" });
    expect(resolveProjectPolicy(join(root, "beta"), [], { policyPath: policy })).toEqual({ planOnly: "beta" });
    expect(resolveProjectPolicy(join(root, "alphabet"), [], { policyPath: policy })).toEqual({});
  });

  it("matches a path a task owns and the main checkout of a git worktree", () => {
    expect(resolveProjectPolicy(root, [join(root, "beta", "x")], { policyPath: policy })).toEqual({ planOnly: "beta" });
    const main = join(root, "alpha");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    const wt = join(root, "elsewhere", "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    expect(resolveProjectPolicy(wt, [], { policyPath: policy })).toEqual({ noClaude: "alpha" });
  });

  it("has no policy without a file and restricts both when the file is unreadable", () => {
    expect(resolveProjectPolicy(root, [], { policyPath: join(root, "missing.json") })).toEqual({});
    const bad = join(root, "bad.json");
    writeFileSync(bad, "nope");
    const result = resolveProjectPolicy(root, [], { policyPath: bad });
    expect(result.noClaude).toMatch(/not valid JSON/);
    expect(result.planOnly).toMatch(/not valid JSON/);
  });
});

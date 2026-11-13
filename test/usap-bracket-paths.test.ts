import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeOwnedPathRules } from "../src/subagents/claude-owned-paths.ts";
import { claudeWorkerArgs } from "../src/subagents/claude-worker.ts";
import { normalizeDispatch, SubagentPolicyError } from "../src/subagents/policy.ts";
import type { DispatchInput } from "../src/subagents/types.ts";

/**
 * Reference matcher for the rule syntax measured against the Claude Code CLI (2.1.322): `Edit(//abs)` rules are
 * gitignore-style; an unescaped `[abc]` is a character class and `*` / `{a,b}` are patterns, while a
 * backslash-escaped metacharacter matches only itself. The real CLI measurements are in
 * proof/claude-cli-escape-proof.txt; this matcher lets the unit tests state them without a model.
 */
function ruleRegex(rule: string): RegExp {
  const body = /^Edit\(\/(.*)\)$/.exec(rule)![1]!;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") { out += (body[++i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    else if (c === "[") { const end = body.indexOf("]", i); out += body.slice(i, end + 1); i = end; }
    else if (c === "*" && body[i + 1] === "*") { out += ".*"; i++; }
    else if (c === "*") out += "[^/]*";
    else if (c === "{") { const end = body.indexOf("}", i); out += `(?:${body.slice(i + 1, end).split(",").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`; i = end; }
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}
const allowed = (rules: string[], file: string): boolean => rules.some((rule) => ruleRegex(rule).test(file));

describe("claude-code owned paths with permission-rule metacharacters", () => {
  it("synthetic: a dynamic-route file is owned exactly; character-class siblings are denied", () => {
    const rules = claudeOwnedPathRules(["/repo/src/app/[id]/route.ts"], () => undefined);
    expect(rules).toEqual(["Edit(//repo/src/app/\\[id\\]/route.ts)", "Edit(//repo/src/app/\\[id\\]/route.ts/**)"]);
    expect(allowed(rules, "/repo/src/app/[id]/route.ts")).toBe(true);
    for (const sibling of ["x", "i", "d"]) expect(allowed(rules, `/repo/src/app/${sibling}/route.ts`)).toBe(false);
    expect(allowed(rules, "/repo/src/app/[id]/other.ts")).toBe(false);
  });

  it("synthetic: an owned bracket directory allows its descendants and nothing else", () => {
    const rules = claudeOwnedPathRules(["/repo/pages/[slug]"], () => undefined);
    expect(allowed(rules, "/repo/pages/[slug]/index.astro")).toBe(true);
    expect(allowed(rules, "/repo/pages/s/index.astro")).toBe(false);
    expect(allowed(rules, "/repo/pages/l/index.astro")).toBe(false);
  });

  it("synthetic: * { } ( ) ! ] are literal, never patterns", () => {
    for (const [owned, decoy] of [["/repo/a*b.ts", "/repo/azzb.ts"], ["/repo/a{x,y}b.ts", "/repo/axb.ts"], ["/repo/a(x)b.ts", "/repo/axb.ts"], ["/repo/a!b.ts", "/repo/azb.ts"], ["/repo/a]b.ts", "/repo/azb.ts"]] as const) {
      const rules = claudeOwnedPathRules([owned], () => undefined);
      expect(allowed(rules, owned), owned).toBe(true);
      expect(allowed(rules, decoy), owned).toBe(false);
    }
  });

  it("synthetic: ? and backslash cannot be made literal in the CLI matcher, so they are still refused with the full path", () => {
    for (const owned of ["/repo/a?b.ts", "/repo/a\\b.ts"]) {
      expect(() => claudeOwnedPathRules([owned], () => undefined)).toThrow(/permission-rule metacharacter/);
      expect(() => claudeOwnedPathRules([owned], () => undefined)).toThrow(JSON.stringify(owned));
    }
  });

  it("synthetic: the CLI argv carries the escaped rule and no widened ancestor rule", () => {
    const args = claudeWorkerArgs(8, { mayEdit: true, ownedPaths: ["/repo/src/app/[id]/route.ts"] }, () => undefined);
    const rules = args.slice(args.indexOf("--allowedTools") + 1);
    expect(rules).toContain("Edit(//repo/src/app/\\[id\\]/route.ts)");
    expect(rules.some((rule) => /^Edit\(\/\/repo(\/src(\/app)?)?(\/\*\*)?\)$/.test(rule))).toBe(false);
  });
});

describe("dispatch of bracket and glob owned paths", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const cwdFixture = (): string => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), "usap-bracket-"))); dirs.push(d); return d; };
  const dispatch = (ownedPaths: string[], cwd: string) => normalizeDispatch({
    goal: "Edit routes", harness: "claude-code", tasks: [{ label: "Writer", task: "Edit", mayEdit: true, ownedPaths }],
  } as DispatchInput, cwd, "test/model", "high", 0, () => "r");

  it("synthetic: a wave owning a Next.js dynamic route is accepted", () => {
    const cwd = cwdFixture();
    const run = dispatch(["src/app/api/os/records/[recordType]/route.ts", "src/app/[id]/route.ts", "pages/[slug]", "a*b.ts"], cwd);
    expect(run.tasks[0]!.ownedPaths).toEqual([
      join(cwd, "src/app/api/os/records/[recordType]/route.ts"), join(cwd, "src/app/[id]/route.ts"), join(cwd, "pages/[slug]"), join(cwd, "a*b.ts")]);
  });

  it("synthetic: a symlink escape from a bracket path is still refused", () => {
    const cwd = cwdFixture(); const outside = cwdFixture();
    mkdirSync(join(cwd, "src"));
    symlinkSync(outside, join(cwd, "src/[id]"), "dir");
    expect(() => dispatch(["src/[id]/route.ts"], cwd)).toThrow(/escapes cwd through a symlink/);
    expect(() => dispatch(["../[id]/route.ts"], cwd)).toThrow(/traversal/);
  });

  it("synthetic: a refused relative path names the full resolved path, what it was resolved against, and how to fix it", () => {
    const cwd = cwdFixture();
    let message = "";
    try { dispatch(["src/x?y"], cwd); } catch (error) { expect(error).toBeInstanceOf(SubagentPolicyError); message = (error as Error).message; }
    expect(message).toContain(JSON.stringify(join(cwd, "src/x?y")));
    expect(message).toContain(`owned path "src/x?y" resolved to ${JSON.stringify(join(cwd, "src/x?y"))} (relative to the run cwd ${JSON.stringify(cwd)}); pass an absolute path or set the run cwd`);
  });

  it("synthetic: an absolute refused path gets no relative hint and is printed whole", () => {
    const cwd = cwdFixture();
    const long = join(cwd, ...Array.from({ length: 20 }, () => "d".repeat(15)), "x?y");
    let message = "";
    try { dispatch([long], cwd); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(JSON.stringify(long));
    expect(message).not.toContain("relative to the run cwd");
  });
});

describe("dispatch error text for refused owned paths (review r2)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const fixture = (): string => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), "usap-r2-"))); dirs.push(d); return d; };
  const refuse = (ownedPaths: string[], cwd: string): string => {
    try {
      normalizeDispatch({ goal: "g", harness: "claude-code", tasks: [{ label: "W", task: "t", mayEdit: true, ownedPaths }] } as DispatchInput, cwd, "m", "high", 0, () => "r");
    } catch (error) { return (error as Error).message; }
    return "";
  };

  it("synthetic: a trailing-space owned path is refused at dispatch with the reason and the full path", () => {
    const cwd = fixture();
    const message = refuse(["src /a.ts"], cwd);
    expect(message).toMatch(/begins or ends with whitespace/);
    expect(message).toContain(JSON.stringify(join(cwd, "src /a.ts")));
  });

  it("synthetic: control and bidi characters are stripped from the message and the relative-path hint", () => {
    const cwd = fixture();
    const message = refuse(["a\u0085b‮/x?y"], cwd);
    expect(message).not.toMatch(/[\u007f-\u009f‪-‮⁦-⁩]/u);
    expect(message).toContain("pass an absolute path or set the run cwd]");
  });

  it("synthetic: reason plus hint stay within 2000 characters and the hint stays whole", () => {
    const cwd = fixture();
    const message = refuse([`${"d".repeat(1500)}/x?y`], cwd);
    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message.endsWith("pass an absolute path or set the run cwd]")).toBe(true);
    expect(message).toContain("[owned path ");
  });
});

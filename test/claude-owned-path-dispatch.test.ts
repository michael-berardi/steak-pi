import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeDispatch, SubagentPolicyError } from "../src/subagents/policy.ts";
import type { DispatchInput } from "../src/subagents/types.ts";

const temporaryDirectories: string[] = [];
const metacharacters = [
  ["asterisk", "*"], ["question mark", "?"],
  ["opening bracket", "["], ["closing bracket", "]"],
  ["opening brace", "{"], ["closing brace", "}"],
  ["opening parenthesis", "("], ["closing parenthesis", ")"],
  ["exclamation mark", "!"], ["backslash", "\\"],
  ["LF", "\n"], ["CR", "\r"],
] as const;

function fixture(): { base: string; cwd: string } {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "steak-claude-path-dispatch-")));
  temporaryDirectories.push(base);
  const cwd = join(base, "work");
  mkdirSync(cwd);
  return { base, cwd };
}

function writer(label: string, ownedPaths: string[]): DispatchInput["tasks"][number] {
  return { label, task: "Edit only the exact owned paths", mayEdit: true, ownedPaths };
}

function dispatch(tasks: DispatchInput["tasks"], overrides: Partial<DispatchInput> = {}): DispatchInput {
  return { goal: "Validate ownership before starting any leaf", harness: "claude-code", tasks, ...overrides };
}

function normalize(input: DispatchInput, cwd: string) {
  return normalizeDispatch(input, cwd, "test/model", "high", 0, () => "path-regression");
}

function expectPermissionRejection(input: DispatchInput, cwd: string, field: string, label: string): void {
  let error: unknown;
  try {
    normalize(input, cwd);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(SubagentPolicyError);
  const message = (error as SubagentPolicyError).message;
  expect(message).toContain(field);
  expect(message).toContain(label);
  expect(message).toMatch(/permission[- ]rule/i);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("synthetic: Claude owned-path dispatch permission validation", () => {
  // normalizeDispatch is the pre-start boundary: a rejected wave cannot yield a
  // runnable record, even when earlier leaves are valid or background is true.
  for (const background of [false, true]) {
    it.each(metacharacters)(`${background ? "background" : "foreground"} mixed wave rejects later writer with %s without widening ownership`, (_name, character) => {
      const { cwd } = fixture();
      const unsafePath = `later/name${character}part.ts`;
      const input = dispatch([
        { label: "Read first", task: "Inspect without edits" },
        writer("Safe earlier writer", ["earlier/plain.ts"]),
        writer("Invalid later writer", ["later/valid.ts", unsafePath]),
      ], { background, concurrency: 3 });
      const originalPaths = [...input.tasks[2].ownedPaths!];

      expectPermissionRejection(input, cwd, "tasks[2].ownedPaths[1]", "Invalid later writer");
      // Neither stripping syntax nor granting the safe parent is an acceptable
      // recovery: reject the whole input and leave exact ownership untouched.
      expect(input.tasks[2].ownedPaths).toEqual(originalPaths);
    });
  }

  it.each([undefined, "pi"] as const)("Pi route %s still accepts literal bracket ownership", (harness) => {
    const { cwd } = fixture();
    const run = normalize(dispatch([
      writer("Pi brackets", ["src/[route]/page.ts"]),
    ], { harness }), cwd);
    expect(run.tasks[0].ownedPaths).toEqual([join(cwd, "src/[route]/page.ts")]);
  });

  it("accepts plain, spaced, and absolute paths without granting their parents", () => {
    const { cwd } = fixture();
    const paths = ["src/plain.ts", "folder with spaces/file name.ts", join(cwd, "absolute/file.ts")];
    const run = normalize(dispatch([writer("Exact safe writer", paths)]), cwd);
    expect(run.tasks[0].ownedPaths).toEqual(paths.map((path) => resolve(cwd, path)));
    expect(run.tasks[0].ownedPaths).not.toContain(cwd);
    expect(run.tasks[0].ownedPaths).not.toContain(join(cwd, "src"));
  });

  it("rejects an absolute bracket alias even when its physical target is safe", () => {
    const { cwd } = fixture();
    const target = join(cwd, "safe-target");
    const alias = join(cwd, "[alias]");
    mkdirSync(target);
    symlinkSync(target, alias, "dir");
    expectPermissionRejection(dispatch([
      writer("Absolute alias writer", [join(alias, "missing.ts")]),
    ]), cwd, "tasks[0].ownedPaths[0]", "Absolute alias writer");
  });

  it("rejects brackets inherited from the lexical cwd, not just the supplied relative path", () => {
    const { base, cwd } = fixture();
    const aliasCwd = join(base, "[cwd-alias]");
    symlinkSync(cwd, aliasCwd, "dir");
    expectPermissionRejection(dispatch([
      writer("Bracket cwd writer", ["plain.ts"]),
    ]), aliasCwd, "tasks[0].ownedPaths[0]", "Bracket cwd writer");
  });

  it("rejects brackets inherited only from the physical cwd", () => {
    const { base } = fixture();
    const target = join(base, "[physical-cwd]");
    const aliasCwd = join(base, "safe-cwd-alias");
    mkdirSync(target);
    symlinkSync(target, aliasCwd, "dir");
    expectPermissionRejection(dispatch([
      writer("Physical cwd writer", ["plain.ts"]),
    ]), aliasCwd, "tasks[0].ownedPaths[0]", "Physical cwd writer");
  });

  for (const missingChild of [false, true]) {
    it.each(metacharacters)(`rejects physical-only %s through a symlink (${missingChild ? "nonexistent child" : "existing target"})`, (_name, character) => {
      const { cwd } = fixture();
      const target = join(cwd, `target${character}part`);
      const alias = join(cwd, "safe-alias");
      mkdirSync(target);
      symlinkSync(target, alias, "dir");
      const ownedPath = missingChild ? "safe-alias/not-created/deeper/file.ts" : "safe-alias";
      expectPermissionRejection(dispatch([
        writer("Physical target writer", [ownedPath]),
      ]), cwd, "tasks[0].ownedPaths[0]", "Physical target writer");
    });
  }

  it.each([false, true])("accepts a safe symlink with missing child = %s and retains exact lexical ownership", (missingChild) => {
    const { cwd } = fixture();
    const target = join(cwd, "safe target");
    const alias = join(cwd, "safe-alias");
    mkdirSync(target);
    symlinkSync(target, alias, "dir");
    const ownedPath = missingChild ? "safe-alias/not-created/deeper/file.ts" : "safe-alias";
    const run = normalize(dispatch([writer("Safe symlink writer", [ownedPath])]), cwd);
    expect(run.tasks[0].ownedPaths).toEqual([join(cwd, ownedPath)]);
  });
});

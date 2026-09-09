import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOwnedPath,
  normalizeDispatch,
  SubagentPolicyError,
} from "../src/subagents/policy.ts";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  USAP_VERSION,
  type DispatchInput,
} from "../src/subagents/types.ts";

const temporaryDirectories: string[] = [];

function fixture(): { base: string; cwd: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "steak-policy-"));
  const cwd = join(base, "work");
  const outside = join(base, "outside");
  mkdirSync(join(cwd, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  temporaryDirectories.push(base);
  return { base, cwd, outside };
}

function dispatch(tasks: DispatchInput["tasks"], overrides: Partial<DispatchInput> = {}): DispatchInput {
  return { goal: "Ship bounded workers", tasks, ...overrides };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("normalizeDispatch", () => {
  it("applies secure read-only defaults and creates stable display-safe IDs", () => {
    const { cwd } = fixture();
    const run = normalizeDispatch(
      dispatch([{ label: " Inspect ", task: " Read the code " }]),
      cwd,
      " test/model ",
      " medium ",
      1234,
      () => " fixed id\n",
    );

    expect(run).toMatchObject({
      version: USAP_VERSION,
      id: "run-fixed-id",
      goal: "Ship bounded workers",
      constraints: [],
      cwd: resolve(cwd),
      model: "test/model",
      thinkingLevel: "medium",
      concurrency: 1,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      background: false,
      state: "running",
      createdAt: 1234,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
    });
    expect(run.tasks).toEqual([
      expect.objectContaining({
        id: "run-fixed-id-task-1",
        label: "Inspect",
        task: "Read the code",
        role: "worker",
        mayEdit: false,
        ownedPaths: [],
        allowBash: false,
        state: "queued",
        output: "",
        turns: 0,
        relaySent: 0,
        relayReceived: 0,
        truncated: false,
      }),
    ]);
    expect(run.tasks[0].usage).not.toBe(run.usage);
  });

  it("normalizes writable ownership and preserves explicit policy fields", () => {
    const { cwd } = fixture();
    const run = normalizeDispatch(
      dispatch(
        [{
          label: "Implement",
          task: "Change policy",
          role: "reviewer",
          mayEdit: true,
          ownedPaths: ["src/new-area"],
          allowBash: true,
        }],
        {
          constraints: [" narrow changes "],
          contract: " return evidence ",
          concurrency: 1,
          timeoutMs: MIN_TIMEOUT_MS,
          background: true,
        },
      ),
      cwd,
      "model",
      "high",
      9,
      () => "abc",
    );

    expect(run.constraints).toEqual(["narrow changes"]);
    expect(run.contract).toBe("return evidence");
    expect(run.concurrency).toBe(1);
    expect(run.timeoutMs).toBe(MIN_TIMEOUT_MS);
    expect(run.background).toBe(true);
    expect(run.tasks[0]).toMatchObject({
      role: "reviewer",
      mayEdit: true,
      ownedPaths: [join(cwd, "src/new-area")],
      allowBash: true,
    });
  });

  it("requires one to eight tasks with unique nonempty labels", () => {
    const { cwd } = fixture();
    expect(() => normalizeDispatch(dispatch([]), cwd, "m", "t")).toThrow(/1 to 8/);
    expect(() => normalizeDispatch(
      dispatch(Array.from({ length: 9 }, (_, index) => ({ label: `t${index}`, task: "x" }))),
      cwd,
      "m",
      "t",
    )).toThrow(/1 to 8/);
    expect(() => normalizeDispatch(dispatch([{ label: " ", task: "x" }]), cwd, "m", "t"))
      .toThrow(/nonempty/);
    expect(() => normalizeDispatch(
      dispatch([{ label: "Build", task: "x" }, { label: " build ", task: "y" }]),
      cwd,
      "m",
      "t",
    )).toThrow(/not unique/);
  });

  it("enforces concurrency and timeout integer bounds", () => {
    const { cwd } = fixture();
    const task = [{ label: "one", task: "work" }];
    for (const concurrency of [0, MAX_CONCURRENCY + 1, 1.5, Number.NaN]) {
      expect(() => normalizeDispatch(dispatch(task, { concurrency }), cwd, "m", "t"))
        .toThrow(/concurrency/);
    }
    for (const timeoutMs of [MIN_TIMEOUT_MS - 1, MAX_TIMEOUT_MS + 1, 1.5, Infinity]) {
      expect(() => normalizeDispatch(dispatch(task, { timeoutMs }), cwd, "m", "t"))
        .toThrow(/timeoutMs/);
    }
    expect(normalizeDispatch(
      dispatch(task, { concurrency: 4, timeoutMs: MAX_TIMEOUT_MS }),
      cwd,
      "m",
      "t",
    ).timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("defaults concurrency to a full adaptive wave", () => {
    const { cwd } = fixture();
    const many = Array.from({ length: MAX_CONCURRENCY }, (_, i) => ({ label: `t${i}`, task: "work" }));
    expect(normalizeDispatch(dispatch(many), cwd, "m", "t").concurrency).toBe(MAX_CONCURRENCY);
    expect(normalizeDispatch(dispatch(many.slice(0, 3)), cwd, "m", "t").concurrency).toBe(3);
    expect(normalizeDispatch(
      dispatch(many, { concurrency: 2 }),
      cwd,
      "m",
      "t",
    ).concurrency).toBe(2);
  });

  it("requires ownership exactly for writable tasks", () => {
    const { cwd } = fixture();
    expect(() => normalizeDispatch(
      dispatch([{ label: "write", task: "x", mayEdit: true }]),
      cwd,
      "m",
      "t",
    )).toThrow(/requires at least one owned path/);
    expect(() => normalizeDispatch(
      dispatch([{ label: "read", task: "x", ownedPaths: ["src"] }]),
      cwd,
      "m",
      "t",
    )).toThrow(/read-only/);
  });

  it("rejects duplicate, ancestor, descendant, and physical-alias ownership", () => {
    const { cwd } = fixture();
    mkdirSync(join(cwd, "src", "nested"));
    symlinkSync(join(cwd, "src"), join(cwd, "source-alias"));

    const cases: DispatchInput["tasks"][] = [
      [{ label: "a", task: "x", mayEdit: true, ownedPaths: ["src", "src"] }],
      [
        { label: "a", task: "x", mayEdit: true, ownedPaths: ["src"] },
        { label: "b", task: "y", mayEdit: true, ownedPaths: ["src/nested"] },
      ],
      [
        { label: "a", task: "x", mayEdit: true, ownedPaths: ["src/nested"] },
        { label: "b", task: "y", mayEdit: true, ownedPaths: ["src"] },
      ],
      [
        { label: "a", task: "x", mayEdit: true, ownedPaths: ["src"] },
        { label: "b", task: "y", mayEdit: true, ownedPaths: ["source-alias"] },
      ],
    ];
    for (const tasks of cases) {
      expect(() => normalizeDispatch(dispatch(tasks), cwd, "m", "t")).toThrow(/overlaps/);
    }
  });

  it("case-folds dangling ownership on case-insensitive platforms", () => {
    const { cwd } = fixture();
    const check = () => normalizeDispatch(dispatch([
      { label: "upper", task: "x", mayEdit: true, ownedPaths: ["src/Generated"] },
      { label: "lower", task: "y", mayEdit: true, ownedPaths: ["src/generated"] },
    ]), cwd, "m", "t");

    if (process.platform === "darwin" || process.platform === "win32") {
      expect(check).toThrow(/overlaps/);
    } else {
      expect(check).not.toThrow();
    }
  });

  it("rejects lexical traversal, absolute escapes, and symlink ownership escapes", () => {
    const { cwd, outside } = fixture();
    symlinkSync(outside, join(cwd, "escape"));
    const paths = ["../outside", outside, "escape", "escape/new-file"];
    for (const ownedPath of paths) {
      expect(() => normalizeDispatch(
        dispatch([{ label: "write", task: "x", mayEdit: true, ownedPaths: [ownedPath] }]),
        cwd,
        "m",
        "t",
      )).toThrow(SubagentPolicyError);
    }
  });
});

describe("assertOwnedPath", () => {
  it("allows reads under cwd and writes only within lexical and physical ownership", () => {
    const { cwd } = fixture();
    mkdirSync(join(cwd, "src", "owned"));
    mkdirSync(join(cwd, "other"));
    expect(assertOwnedPath(cwd, "other/file.ts", [], "read")).toBe(join(cwd, "other/file.ts"));
    expect(assertOwnedPath(cwd, "src/owned/new.ts", ["src/owned"], "write"))
      .toBe(join(cwd, "src/owned/new.ts"));
    expect(() => assertOwnedPath(cwd, "other/file.ts", ["src/owned"], "write"))
      .toThrow(/outside the task's ownership/);
    expect(() => assertOwnedPath(cwd, "src/file.ts", [], "write"))
      .toThrow(/require an owned path/);
  });

  it("rejects traversal and absolute paths outside cwd", () => {
    const { cwd, outside } = fixture();
    expect(() => assertOwnedPath(cwd, "../outside/file", ["."], "write")).toThrow(/traversal/);
    expect(() => assertOwnedPath(cwd, join(outside, "file"), [], "read")).toThrow(/outside cwd/);
  });

  it("rejects existing and nonexisting descendants through an escaping symlink", () => {
    const { cwd, outside } = fixture();
    writeFileSync(join(outside, "existing.txt"), "outside");
    symlinkSync(outside, join(cwd, "escape"));

    expect(() => assertOwnedPath(cwd, "escape/existing.txt", ["."], "write"))
      .toThrow(/escapes cwd through a symlink/);
    expect(() => assertOwnedPath(cwd, "escape/not-created/deep.txt", ["."], "write"))
      .toThrow(/escapes cwd through a symlink/);
    expect(() => assertOwnedPath(cwd, "escape/not-created", [], "read"))
      .toThrow(/escapes cwd through a symlink/);
  });

  it("rejects dangling symlink ancestors whose eventual target cannot be verified", () => {
    const { cwd, outside } = fixture();
    symlinkSync(join(outside, "not-created"), join(cwd, "dangling"));
    expect(() => assertOwnedPath(cwd, "dangling/file.ts", ["."], "write"))
      .toThrow(/unresolved symlink ancestor/);
  });

  it("rejects a symlink that stays in cwd but escapes its owned physical subtree", () => {
    const { cwd } = fixture();
    mkdirSync(join(cwd, "owned"));
    mkdirSync(join(cwd, "unowned"));
    symlinkSync(join(cwd, "unowned"), join(cwd, "owned", "alias"));
    expect(() => assertOwnedPath(cwd, "owned/alias/file.ts", ["owned"], "write"))
      .toThrow(/outside the task's ownership/);
  });
});

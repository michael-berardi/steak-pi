import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeApiWorkerArgs, claudeWorkerArgs } from "../src/subagents/claude-worker.ts";
import { parseWaveSpec } from "../src/subagents/claude-api-cli.ts";
import { normalizeDispatch, SubagentPolicyError } from "../src/subagents/policy.ts";
import { normalizeReadPath, readUnderDeclaredRoots } from "../src/subagents/read-paths.ts";
import { assertOwnedPath } from "../src/subagents/policy.ts";
import { buildPiWorkerSystemPrompt, createGuardedPiWorkerTools } from "../src/subagents/pi-worker.ts";
import { type RunRecord, type TaskRecord, emptyUsage } from "../src/subagents/types.ts";

// Hermetic: a fake HOME and a fake run cwd under the OS temp dir, never the
// operator's cache and never a project checkout.
let home: string;
let cwd: string;

function folder(...parts: string[]): string {
  const path = join(home, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

const CAPTURES = () => join(home, ".cache", "ut-coordinator", "J-3760", "captures");
const SCRATCH = () => join(home, ".cache", "agent-scratch", "visual-qa", "shots");
const OVERSEER_REVIEW = () => join(home, ".cache", "ut-overseer", "J-3760", "review");

beforeEach(() => {
  // macOS tmpdir() is reached through the /var -> /private/var symlink; resolve it so
  // the test compares physical paths, exactly what the grant records.
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "j3760-home-")));
  cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "j3760-cwd-")));
  folder(".cache", "ut-coordinator", "J-3760", "captures");
  folder(".cache", "agent-scratch", "visual-qa", "shots");
  folder(".cache", "ut-overseer", "J-3760", "review");
  folder(".cache", "ut-coordinator", "J-9999", "captures");
  writeFileSync(join(CAPTURES(), "home-375.png"), "synthetic png bytes");
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function leaf(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t1", label: "Review captures", task: "Review the captures.", role: "reviewer", mayEdit: false,
    ownedPaths: [], readPaths: [], allowBash: false, state: "queued", output: "", turns: 0,
    usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, ...overrides,
  } as TaskRecord;
}

function dispatch(tasks: Array<Record<string, unknown>>) {
  return normalizeDispatch(
    { goal: "Review the staged captures", tasks: tasks as never },
    cwd,
    "claude-code/claude-opus-5-5",
    "medium",
    1,
    () => "run-1",
    home,
  );
}

describe("read-only artifact roots outside the run cwd (J-3760)", () => {
  it("accepts a captures folder inside a private job home and returns its physical path", () => {
    expect(normalizeReadPath("~/.cache/ut-coordinator/J-3760/captures", "readPaths[0]", home)).toBe(CAPTURES());
    expect(normalizeReadPath(CAPTURES(), "readPaths[0]", home)).toBe(CAPTURES());
    expect(normalizeReadPath(SCRATCH(), "readPaths[0]", home)).toBe(SCRATCH());
    expect(normalizeReadPath(OVERSEER_REVIEW(), "readPaths[0]", home)).toBe(OVERSEER_REVIEW());
  });

  it("refuses every location that is not a private agent home", () => {
    for (const path of [cwd, "/tmp", home, join(home, "dev", "overseer"), "/etc", "relative/captures"]) {
      expect(() => normalizeReadPath(path, "readPaths[0]", home)).toThrow(/readPaths\[0\]/);
    }
  });

  it("refuses the cache root and a task or job home itself, so a grant always names a folder", () => {
    mkdirSync(join(home, ".cache", "agent-scratch", "solo-task"), { recursive: true });
    expect(() => normalizeReadPath(join(home, ".cache", "ut-coordinator"), "readPaths[0]", home)).toThrow(/never granted/);
    expect(() => normalizeReadPath(join(home, ".cache", "agent-scratch"), "readPaths[0]", home)).toThrow(/never granted/);
    expect(() => normalizeReadPath(join(home, ".cache", "ut-coordinator", "J-3760"), "readPaths[0]", home)).toThrow(/task or job home itself/);
    // An agent-scratch task home is refused exactly like a job home.
    expect(() => normalizeReadPath(join(home, ".cache", "agent-scratch", "solo-task"), "readPaths[0]", home)).toThrow(/task or job home itself/);
    // A job home keeps its report and handoff: only a folder below it is granted.
    expect(() => normalizeReadPath(join(home, ".cache", "ut-coordinator", "not-a-job", "captures"), "readPaths[0]", home)).toThrow(/never another folder directly below/);
  });

  it("refuses a ~user form and an overlong value", () => {
    expect(() => normalizeReadPath("~root/.cache/ut-coordinator/J-3760/captures", "readPaths[0]", home)).toThrow(/~/);
    expect(() => normalizeReadPath(`~/${"a".repeat(2_100)}`, "readPaths[0]", home)).toThrow(/at most/);
  });

  it("accepts the recorded physical path when $HOME itself sits behind a symlink", () => {
    // A resumed run passes the physical path it recorded at dispatch; that must
    // still validate when the operator home is reached through a symlink.
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "j3760-home-root-")));
    const real = join(base, "real-home");
    mkdirSync(join(real, ".cache", "ut-coordinator", "J-3760", "captures"), { recursive: true });
    const linkedHome = join(base, "home-link");
    symlinkSync(real, linkedHome);
    try {
      expect(normalizeReadPath(join(real, ".cache", "ut-coordinator", "J-3760", "captures"), "readPaths[0]", linkedHome))
        .toBe(join(real, ".cache", "ut-coordinator", "J-3760", "captures"));
      expect(normalizeReadPath("~/.cache/ut-coordinator/J-3760/captures", "readPaths[0]", linkedHome))
        .toBe(join(real, ".cache", "ut-coordinator", "J-3760", "captures"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("refuses a file, a missing folder, a traversal and a control character", () => {
    expect(() => normalizeReadPath(join(CAPTURES(), "home-375.png"), "readPaths[0]", home)).toThrow(/real directory/);
    expect(() => normalizeReadPath(join(CAPTURES(), "missing"), "readPaths[0]", home)).toThrow(/does not exist/);
    expect(() => normalizeReadPath(`${CAPTURES()}/../../J-9999/captures`, "readPaths[0]", home)).toThrow(/parent-directory/);
    expect(() => normalizeReadPath(`${CAPTURES()}\u0000`, "readPaths[1]", home)).toThrow(/control characters/);
    expect(() => normalizeReadPath(`${CAPTURES()}\n`, "readPaths[1]", home)).toThrow(/control characters/);
  });

  it("follows an operator symlink on the private home itself but never below it", () => {
    // This machine links ~/.cache/ut-coordinator to ut-overseer; the root may be a
    // symlink, a folder below it may not.
    const linkedHome = realpathSync.native(mkdtempSync(join(tmpdir(), "j3760-linked-home-")));
    try {
      mkdirSync(join(linkedHome, ".cache", "ut-overseer", "J-3760", "captures"), { recursive: true });
      symlinkSync(join(linkedHome, ".cache", "ut-overseer"), join(linkedHome, ".cache", "ut-coordinator"));
      expect(normalizeReadPath("~/.cache/ut-coordinator/J-3760/captures", "readPaths[0]", linkedHome))
        .toBe(join(linkedHome, ".cache", "ut-overseer", "J-3760", "captures"));
    } finally {
      rmSync(linkedHome, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked grant folder and a symlinked parent", () => {
    const target = folder("elsewhere");
    const linked = join(home, ".cache", "ut-coordinator", "J-3760", "linked");
    symlinkSync(target, linked);
    expect(() => normalizeReadPath(linked, "readPaths[0]", home)).toThrow(/real directory/);

    const movedReal = join(home, "moved-job");
    mkdirSync(join(movedReal, "captures"), { recursive: true });
    writeFileSync(join(movedReal, "captures", "x.png"), "x");
    const jobHome = join(home, ".cache", "ut-coordinator", "J-8888");
    mkdirSync(jobHome, { recursive: true });
    rmSync(jobHome, { recursive: true, force: true });
    symlinkSync(movedReal, jobHome);
    expect(() => normalizeReadPath(join(jobHome, "captures"), "readPaths[0]", home)).toThrow(/escapes its private home through a symlink/);
  });
});

describe("dispatch validation of readPaths", () => {
  it("records the physical artifact root on a read-only task", () => {
    const run = dispatch([{ label: "Review", task: "Review the captures.", role: "reviewer", readPaths: ["~/.cache/ut-coordinator/J-3760/captures"] }]);
    expect(run.tasks[0].readPaths).toEqual([CAPTURES()]);
    expect(run.tasks[0].ownedPaths).toEqual([]);
    expect(run.tasks[0].mayEdit).toBe(false);
  });

  it("defaults to no grant and de-duplicates repeated entries", () => {
    const run = dispatch([
      { label: "Plain", task: "Review.", role: "reviewer" },
      { label: "Twice", task: "Review.", role: "reviewer", readPaths: [CAPTURES(), `${CAPTURES()}/`] },
    ]);
    expect(run.tasks[0].readPaths).toEqual([]);
    expect(run.tasks[1].readPaths).toEqual([CAPTURES()]);
  });

  it("refuses a named path outside the declared roots with the field in the message", () => {
    expect(() => dispatch([{ label: "Review", task: "Review.", role: "reviewer", readPaths: [join(cwd, "captures")] }]))
      .toThrow(SubagentPolicyError);
    expect(() => dispatch([{ label: "Review", task: "Review.", role: "reviewer", readPaths: [join(cwd, "captures")] }]))
      .toThrow(/tasks\[0\]\.readPaths\[0\]/);
  });

  it("refuses readPaths on a task that may edit", () => {
    expect(() => dispatch([{
      label: "Edit and read", task: "Edit.", mayEdit: true, ownedPaths: [cwd],
      readPaths: ["~/.cache/ut-coordinator/J-3760/captures"],
    }])).toThrow(/cannot also read outside cwd/);
  });

  it("refuses a non-array readPaths", () => {
    expect(() => dispatch([{ label: "Review", task: "Review.", role: "reviewer", readPaths: CAPTURES() }]))
      .toThrow(/readPaths must be an array/);
  });
});

describe("Claude Code reviewer argv", () => {
  const reviewer = (readPaths: string[]) => ({ role: "reviewer", mayEdit: false, task: "Review the staged captures.", readPaths });

  it("adds --add-dir for the declared root and keeps the read-only tool policy", () => {
    const dirs = [CAPTURES()];
    const args = claudeWorkerArgs(8, reviewer(dirs));
    const index = args.indexOf("--add-dir");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe(CAPTURES());
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args.join(" ")).toMatch(/--restricted/);
    expect(args.join(" ")).not.toMatch(/Bash|Write|NotebookEdit|Edit\(|dangerously/);
  });

  it("grants nothing when the leaf declares no read path", () => {
    expect(claudeWorkerArgs(8, reviewer([]))).not.toContain("--add-dir");
  });

  it("refuses a read path on a leaf that may edit", () => {
    expect(() => claudeWorkerArgs(8, { role: "worker", mayEdit: true, ownedPaths: [cwd], readPaths: [CAPTURES()] }))
      .toThrow(/readPaths are read-only/);
  });

  it("refuses read path grants on the explicit API route, which forbids --add-dir", () => {
    expect(() => claudeApiWorkerArgs(8, reviewer([CAPTURES()]), undefined, "claude-opus-5-5" as never, undefined,
      { settingsPath: "/tmp/settings.json", maxBudgetUsd: 1 })).toThrow(/cannot be granted on the explicit API route/);
  });

  it("refuses the grant at dispatch, before any checkpoint, on an explicit API run", () => {
    expect(() => normalizeDispatch(
      { goal: "Review", tasks: [{ label: "Review", task: "Review.", role: "reviewer", readPaths: [CAPTURES()] }] as never },
      cwd, "claude-code-api/claude-sonnet-5-5", "medium", 1, () => "run-1", home,
    )).toThrow(/readPaths cannot be granted on the explicit API route/);
  });

  it("re-checks the grant at launch, so a folder swapped for a symlink is refused", () => {
    const swapped = join(home, ".cache", "ut-coordinator", "J-3760", "swapped");
    mkdirSync(swapped, { recursive: true });
    const args = claudeWorkerArgs(8, reviewer([swapped]));
    expect(args).toContain(swapped);
    const moved = join(home, "moved-grant");
    mkdirSync(moved);
    rmSync(swapped, { recursive: true, force: true });
    symlinkSync(moved, swapped);
    expect(() => claudeWorkerArgs(8, reviewer([swapped]))).toThrow(/no longer a real directory/);
  });
});

describe("explicit Claude API wave specs", () => {
  it("refuses a readPaths leaf in the spec before any admission or checkpoint", () => {
    const spec = JSON.stringify({
      goal: "Review captures", cwd, route: "claude-code-api/claude-sonnet-5-5",
      tasks: [{ label: "Review", task: "Review.", role: "reviewer", readPaths: ["~/.cache/ut-coordinator/J-3760/captures"] }],
    });
    expect(() => parseWaveSpec(spec)).toThrow(/cannot be granted on the explicit API route/);
  });
});

describe("reads and writes under a granted root", () => {
  it("resolves a file inside the grant and refuses a sibling outside it", () => {
    expect(readUnderDeclaredRoots([CAPTURES()], join(CAPTURES(), "home-375.png"))).toBe(join(CAPTURES(), "home-375.png"));
    expect(readUnderDeclaredRoots([CAPTURES()], join(home, ".cache", "ut-coordinator", "J-9999", "captures"))).toBeUndefined();
    expect(readUnderDeclaredRoots([CAPTURES()], cwd)).toBeUndefined();
    expect(readUnderDeclaredRoots([], join(CAPTURES(), "home-375.png"))).toBeUndefined();
  });

  it("refuses a symlink created after dispatch instead of trusting the earlier check", () => {
    const outside = join(home, "outside.png");
    writeFileSync(outside, "outside the grant");
    symlinkSync(outside, join(CAPTURES(), "linked.png"));
    // The physical path decides: a link out of the grant reads nothing.
    expect(readUnderDeclaredRoots([CAPTURES()], join(CAPTURES(), "linked.png"))).toBeUndefined();
    writeFileSync(join(CAPTURES(), "real.png"), "inside");
    symlinkSync(join(CAPTURES(), "real.png"), join(CAPTURES(), "inside-link.png"));
    expect(readUnderDeclaredRoots([CAPTURES()], join(CAPTURES(), "inside-link.png"))).toBe(join(CAPTURES(), "real.png"));
  });

  it("never turns a read grant into write authority", async () => {
    expect(() => assertOwnedPath(cwd, join(CAPTURES(), "home-375.png"), [], "write")).toThrow();
    const granted = leaf({ readPaths: [CAPTURES()] });
    const names = createGuardedPiWorkerTools({ cwd, task: granted, relay: {} as never }).map((tool) => tool.name);
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("bash");
    // Dispatch refuses the combination outright, so a writer never carries a grant.
    expect(() => dispatch([{ label: "Write", task: "Edit.", mayEdit: true, ownedPaths: [cwd], readPaths: [CAPTURES()] }]))
      .toThrow(/cannot also read outside cwd/);
  });

  it("refuses grep and find outside the granted root", async () => {
    const tools = createGuardedPiWorkerTools({ cwd, task: leaf({ readPaths: [CAPTURES()] }), relay: {} as never });
    const invoke = (name: string, args: unknown) => tools.find((tool) => tool.name === name)!
      .execute(name, args, undefined, undefined, {} as never);
    const outside = join(home, ".cache", "ut-coordinator", "J-9999", "captures");
    await expect(invoke("grep", { pattern: "x", path: outside })).rejects.toThrow();
    await expect(invoke("find", { pattern: "*.png", path: outside })).rejects.toThrow();
  });

  it("keeps the recorded grant when a run is re-dispatched (resume path)", () => {
    const first = dispatch([{ label: "Review", task: "Review.", role: "reviewer", readPaths: ["~/.cache/ut-coordinator/J-3760/captures"] }]);
    const recorded = first.tasks[0].readPaths!;
    const again = dispatch([{
      label: "Review", task: "Review.", role: "reviewer",
      ...(recorded.length > 0 ? { readPaths: recorded } : {}),
    }]);
    expect(again.tasks[0].readPaths).toEqual([CAPTURES()]);
  });

  it("lets a Pi child read, list, grep and find inside the granted root only", async () => {
    writeFileSync(join(CAPTURES(), "notes.md"), "capture-token\n");
    const tools = createGuardedPiWorkerTools({ cwd, task: leaf({ readPaths: [CAPTURES()] }), relay: {} as never });
    const invoke = (name: string, args: unknown) => tools.find((tool) => tool.name === name)!
      .execute(name, args, undefined, undefined, {} as never);
    expect(JSON.stringify(await invoke("read", { path: join(CAPTURES(), "notes.md") }))).toContain("capture-token");
    expect(JSON.stringify(await invoke("ls", { path: CAPTURES() }))).toContain("home-375.png");
    expect(JSON.stringify(await invoke("grep", { pattern: "capture-token", path: CAPTURES() }))).toContain("notes.md");
    expect(JSON.stringify(await invoke("find", { pattern: "*.png", path: CAPTURES() }))).toContain("home-375.png");
    // Outside the grant, even though it is another private capture folder.
    const outside = join(home, ".cache", "ut-coordinator", "J-9999", "captures");
    await expect(invoke("read", { path: join(outside, "other.png") })).rejects.toThrow();
    await expect(invoke("ls", { path: outside })).rejects.toThrow();
  });

  it("tells the Pi child exactly which roots it may read and that they are read-only", () => {
    const run = dispatch([{ label: "Review", task: "Review.", role: "reviewer", readPaths: ["~/.cache/ut-coordinator/J-3760/captures"] }]) as RunRecord;
    const prompt = buildPiWorkerSystemPrompt(run, run.tasks[0]);
    expect(prompt).toContain("Read-only artifact roots granted by the parent (reads only, never writes):");
    expect(prompt).toContain(`- ${CAPTURES()}`);
  });
});

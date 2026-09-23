import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

/**
 * CLI contract: bin/ut-todo must be drivable by any agent's shell, in a plain
 * temp cwd, with no Claude Code environment. Output must match the native Pi
 * tool byte for byte (verified separately against the shipped adapter bridge).
 */
const BIN = new URL("../bin/ut-todo", import.meta.url);
const run = promisify(execFile);
const exec = process.execPath;

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ultraterm-plan-cli-"));
  tempDirs.push(dir);
  return dir;
}

/** Run the CLI in cwd with Claude Code detection stripped out. */
async function utodo(cwd: string, args: string[], env: Record<string, string> = {}) {
  const clean = { ...process.env } as Record<string, string | undefined>;
  delete clean.CLAUDE_CODE_SESSION_ID;
  delete clean.UT_TODO_SESSION;
  return run(exec, [BIN.pathname, ...args], {
    cwd,
    env: { ...clean, ...env },
    encoding: "utf8",
    timeout: 30000,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ut-todo cli", () => {
  it("runs under plain node and stores the plan under .steak-pi/todo", async () => {
    const cwd = await tempDir();
    const { stdout } = await utodo(cwd, ["init", "Inspect:read code,map callers", "Build:ship"]);
    expect(stdout).toContain("1. Inspect (0/2)");
    expect(stdout).toContain("Overall: 0/3 done.");
    expect(existsSync(path.join(cwd, ".steak-pi", "todo"))).toBe(true);
    const files = (await fs.readdir(path.join(cwd, ".steak-pi", "todo"))).sort();
    expect(files).toHaveLength(1);
    const store = await fs.readdir(path.join(cwd, ".steak-pi", "todo", files[0]));
    expect(store.sort()).toEqual(["TODO.md", "todo.json"]);
  });

  it("init, prefix done, bulk json, and view behave like the native tool", async () => {
    const cwd = await tempDir();
    await utodo(cwd, ["init", "Inspect:read code,review tests", "Build:ship"]);
    const done = await utodo(cwd, ["done", "revie"]);
    expect(done.stdout).toContain("Overall: 1/3 done.");
    const bulk = await utodo(cwd, ["json", '{"op":"done","items":["read code","ship"]}']);
    expect(bulk.stdout).toContain("Overall: 3/3 done.");
    const view = await utodo(cwd, ["view"]);
    expect(view.stdout).toContain("[x] read code");
    expect(view.stdout).toContain("2. Build (1/1)");
  });

  it("block records the reason; unblock clears it", async () => {
    const cwd = await tempDir();
    await utodo(cwd, ["init", "Only:task one"]);
    const blocked = await utodo(cwd, ["block", "task one", "--reason", "waiting on creds"]);
    expect(blocked.stdout).toContain("[!] task one — waiting on creds");
    const unblocked = await utodo(cwd, ["unblock", "task"]);
    expect(unblocked.stdout).not.toContain("waiting on creds");
  });

  it("--session and UT_TODO_SESSION keep separate lists per project directory", async () => {
    const cwd = await tempDir();
    await utodo(cwd, ["init", "Default:a"]);
    await utodo(cwd, ["--session", "review", "init", "Review:b"]);
    await utodo(cwd, ["--session", "review=2", "init", "Other:c"]);
    const envList = await utodo(cwd, ["init", "Env:d"], { UT_TODO_SESSION: "envd" });
    expect(envList.stdout).toContain("Overall: 0/1 done.");
    expect((await utodo(cwd, ["--session", "review", "view"])).stdout).toContain("[>] b");
    expect((await utodo(cwd, ["--session=review=2", "view"])).stdout).toContain("[>] c");
    expect((await utodo(cwd, ["view"])).stdout).toContain("[>] a");
    const stores = await fs.readdir(path.join(cwd, ".steak-pi", "todo"));
    expect(stores).toHaveLength(4);
  });

  it("lookup misses fail with exit code 2 and the known-tasks hint", async () => {
    const cwd = await tempDir();
    await utodo(cwd, ["init", "Only:task one"]);
    await expect(utodo(cwd, ["done", "nope"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("ut-todo: unknown task: nope — known tasks: task one"),
    });
  });

  it("json rejects malformed input with exit code 2; help exits 0", async () => {
    const cwd = await tempDir();
    await expect(utodo(cwd, ["json", "{not json}"])).rejects.toMatchObject({ code: 2 });
    const help = await utodo(cwd, ["--help"]);
    expect(help.stdout).toContain("ut-todo init 'Phase:item one,item two'");
  });

  it("a crash-left lock cannot wedge the store (stale locks break free)", async () => {
    const cwd = await tempDir();
    await utodo(cwd, ["init", "Only:a"]);
    const store = (await fs.readdir(path.join(cwd, ".steak-pi", "todo")))[0];
    const lock = path.join(cwd, ".steak-pi", "todo", store, ".lock");
    await fs.writeFile(lock, "");
    const stale = new Date(Date.now() - 60000);
    await fs.utimes(lock, stale, stale);
    const { stdout } = await utodo(cwd, ["done", "a"]);
    expect(stdout).toContain("Overall: 1/1 done.");
    expect(existsSync(lock)).toBe(false);
  });
});

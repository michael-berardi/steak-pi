import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPlanExtension } from "../pi/extension.ts";
import { TodoError } from "../src/core.ts";

/**
 * Focused package-side check of the Pi extension contract: deps injection,
 * tool output, and persistence layout. The full behaviour suite runs in the
 * monorepo (test/todo-extension.test.ts) through Steak Pi's wrapper, which is
 * this same module with its real deps.
 */

const SESSION_ID = "7c824aae-7b2e-4a3a-a9f0-06a190b1fbc8";
const canonicalSessionFile = (file: string): string => file;
const setPinnedPanel = vi.fn();

function harness(cwd: string) {
  let execute: ((...args: unknown[]) => Promise<any>) | undefined;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    registerTool(tool: { execute: (...args: unknown[]) => Promise<any> }) {
      execute = tool.execute;
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  createPlanExtension({ setPinnedPanel, canonicalSessionFile })(pi);
  if (!execute) throw new Error("todo tool was not registered");
  const ctx = {
    cwd,
    ui: { setWidget: vi.fn() },
    sessionManager: {
      getSessionId: () => SESSION_ID,
      getSessionFile: () => path.join(cwd, `${SESSION_ID}.jsonl`),
    },
  } as unknown as ExtensionContext;
  return {
    call: (params: object) => execute!("call", params, undefined, undefined, ctx),
    handlers,
    ctx,
  };
}

function planDir(cwd: string, sessionFile: string): string {
  const hash = createHash("sha256").update(JSON.stringify([sessionFile, SESSION_ID])).digest("hex");
  return path.join(cwd, ".steak-pi", "todo", hash);
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ultraterm-plan-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ultraterm plan pi extension", () => {
  it("registers the todo tool with the native op surface", () => {
    const { handlers } = harness(os.tmpdir());
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("session_tree")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
  });

  it("returns the same text as the core render and persists both files", async () => {
    const cwd = await tempDir();
    const plan = harness(cwd);
    const result = await plan.call({
      op: "init",
      list: [{ phase: "Build", items: ["implement"] }],
    });
    expect(result.content[0].text).toContain("1. Build (0/1)");
    expect(result.content[0].text).toContain("Overall: 0/1 done.");
    const dir = planDir(cwd, path.join(cwd, `${SESSION_ID}.jsonl`));
    const persisted = JSON.parse(await fs.readFile(path.join(dir, "todo.json"), "utf8"));
    expect(persisted.phases[0].items[0]).toEqual({ content: "implement", status: "in_progress" });
    expect(await fs.readFile(path.join(dir, "TODO.md"), "utf8")).toContain("1. Build (0/1)");
  });

  it("propagates core failures as TodoError without writing state", async () => {
    const cwd = await tempDir();
    const plan = harness(cwd);
    await expect(plan.call({ op: "done", task: "nothing" })).rejects.toBeInstanceOf(TodoError);
    expect(existsSync(path.join(cwd, ".steak-pi"))).toBe(false);
  });

  it("idempotent re-init keeps recorded progress (the survival guarantee)", async () => {
    const cwd = await tempDir();
    const plan = harness(cwd);
    const init = { op: "init", list: [{ phase: "Batch", items: ["a", "b"] }] };
    await plan.call(init);
    await plan.call({ op: "done", task: "a" });
    const again = await plan.call(init);
    expect(again.content[0].text).toContain("Overall: 1/2 done");
  });

  it("injects the host's pinned-panel compositor with a state signature", async () => {
    const cwd = await tempDir();
    const plan = harness(cwd);
    await plan.call({ op: "init", list: [{ phase: "Build", items: ["implement"] }] });
    expect(setPinnedPanel).toHaveBeenCalledWith(
      plan.ctx,
      "todo",
      expect.any(Function),
      expect.any(String),
    );
    const [signature] = setPinnedPanel.mock.calls.at(-1)!.slice(3) as [string];
    expect(JSON.parse(signature)).toEqual({
      phases: [{ name: "Build", items: [{ content: "implement", status: "in_progress" }] }],
    });
  });
});

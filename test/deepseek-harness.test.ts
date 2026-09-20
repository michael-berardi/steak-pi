import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import extension from "../extensions/deepseek-harness.ts";
import { adaptWorkerTools, appendHarnessPrompt, isDeepSeekHarnessRoute, rewriteHarnessPayload } from "../src/deepseek-harness/index.ts";
import { createGuardedPiWorkerTools } from "../src/subagents/pi-worker.ts";
const model = { provider: "opencode-go", id: "deepseek-v4.1-flash" };

describe("compatible DSH Minimal", () => {
  it("activates exactly and leaves other tool objects untouched", () => {
    expect(isDeepSeekHarnessRoute(model)).toBe(true);
    for (const m of [undefined, { ...model, provider: "deepseek" }, { ...model, id: "deepseek-v4-flash" }]) {
      expect(isDeepSeekHarnessRoute(m)).toBe(false);
      const tools: any[] = [];
      expect(adaptWorkerTools(m, tools)).toBe(tools);
    }
    expect(appendHarnessPrompt("MANDATORY APPROVAL")).toMatch(/^MANDATORY APPROVAL\n/);
  });
  it("preserves exact native edit schemas/executors rather than widening aliases", () => {
    const tools = [{ name: "edit", parameters: { native: true }, execute: vi.fn() }] as any;
    expect(adaptWorkerTools(model, tools)).toBe(tools);
    expect(adaptWorkerTools(model, tools)[0]).toBe(tools[0]);
  });
  it("retains mayEdit/allowBash and guarded path rejection", async () => {
    const task = { ownedPaths: [resolve("src/deepseek-harness")], mayEdit: false, allowBash: false } as any;
    const tools = adaptWorkerTools(model, createGuardedPiWorkerTools({ cwd: process.cwd(), task, relay: {} as any }));
    expect(tools.map((t) => t.name)).not.toContain("edit");
    expect(tools.map((t) => t.name)).not.toContain("bash");
    const editable = adaptWorkerTools(model, createGuardedPiWorkerTools({ cwd: process.cwd(), task: { ...task, mayEdit: true }, relay: {} as any }));
    await expect(editable.find((t) => t.name === "edit")!.execute("deny", { path: "package.json", edits: [{ oldText: "x", newText: "y" }] }, undefined, undefined, {} as any)).rejects.toThrow();
    await expect(tools[0].execute("deny", { path: "../../outside" }, undefined, undefined, {} as any)).rejects.toThrow();
  });
  it("bootstrap preserves mandatory messages/custom gates/schema then promotes without state restoration", () => {
    const messages = [{ role: "system", content: "APPROVAL" }, { role: "user", content: "task" }];
    const names = ["bash", "read", "edit", "write", "grep", "find", "ls", "approval", "ultraterm_relay"];
    const tools = names.map((name) => ({ type: "function", function: { name, parameters: { unchanged: true } } }));
    const payload = { messages, tools };
    const result = rewriteHarnessPayload(payload) as typeof payload;
    expect(result.messages).toBe(messages);
    expect(result.tools.map((t) => t.function.name)).toEqual(["bash", "read", "edit", "write", "approval", "ultraterm_relay"]);
    expect(result.tools[2]).toBe(tools[2]);
    const promoted = { ...payload, messages: [...messages, { role: "assistant", content: "done" }] };
    expect(rewriteHarnessPayload(promoted)).toBe(promoted);
  });
  it("unmanaged primary never replaces tools and skips narrowing unknown search executors", async () => {
    const handlers = new Map<string, Function>();
    const pi = { on: (name: string, handler: Function) => handlers.set(name, handler), registerFlag: vi.fn(), getFlag: () => false, registerTool: vi.fn(), getAllTools: () => [{ name: "grep", sourceInfo: { source: "extension" } }] };
    extension(pi as any);
    await handlers.get("session_start")!({}, {});
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("before_provider_request")).toBe(true);
    expect(await handlers.get("before_provider_request")!({ payload: { tools: [], messages: [] } }, { model })).toBeUndefined();
    expect(await handlers.get("before_agent_start")!({ systemPrompt: "guard" }, { model: { ...model, provider: "other" } })).toBeUndefined();
  });
  it.skipIf(!process.env.DSH_QA_SDK)("uses staged SDK 0.86 native edits/diffs and ambiguity checks", async () => {
    const root = process.env.DSH_QA_SDK!;
    expect(JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version).toBe("0.86.0");
    const sdk = await import(/* @vite-ignore */ pathToFileURL(resolve(root, "dist/core/tools/index.js")).href);
    const dir = await mkdtemp(resolve("src/deepseek-harness/.qa-"));
    try {
      await writeFile(resolve(dir, "file.txt"), "before\n");
      const [edit] = adaptWorkerTools(model, [sdk.createEditToolDefinition(dir)]);
      const result = await edit.execute("native", { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] }, undefined, undefined, {} as any);
      expect(await readFile(resolve(dir, "file.txt"), "utf8")).toBe("after\n");
      expect(result.details.diff).toContain("after");
      await writeFile(resolve(dir, "file.txt"), "same\nsame\n");
      await expect(edit.execute("ambiguous", { path: "file.txt", edits: [{ oldText: "same", newText: "bad" }] }, undefined, undefined, {} as any)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// Real subprocess tests, no model requests.
import { PersistentBashSession } from "../vendor/pi-dsh-minimal/bash-session.ts";
describe.skipIf(process.platform === "win32")("worker persistent runtime", () => {
  it("retains shell state, isolates workers and terminally disposes", async () => {
    const a = new PersistentBashSession(process.cwd()), b = new PersistentBashSession(process.cwd());
    try {
      await a.exec("export DSH_TEST_VALUE=retained; dsh_fn() { printf function-ok; }");
      expect(await a.exec('printf "%s " "$DSH_TEST_VALUE"; dsh_fn')).toBe("retained function-ok");
      expect(await b.exec('printf "%s" "${DSH_TEST_VALUE-unset}"')).toBe("unset");
    } finally { await Promise.all([a.dispose(), b.dispose()]); }
    await expect(a.exec("echo forbidden")).rejects.toThrow("disposed");
  });
  it("reports incomplete persistent commands as native tool errors, then recovers", async () => {
    const shell = new PersistentBashSession(process.cwd());
    const task = { id: "timeout-check", ownedPaths: [], mayEdit: false, allowBash: true } as any;
    const tool = createGuardedPiWorkerTools({ cwd: process.cwd(), task, relay: {} as any, persistentBash: shell }).find(t => t.name === "bash")!;
    try {
      await expect(tool.execute("timeout", { command: "sleep 2", timeout: 0.02 }, undefined, undefined, {} as any)).rejects.toThrow("did not complete");
      const result = await tool.execute("recovery", { command: "printf recovered" }, undefined, undefined, {} as any);
      expect(JSON.stringify(result.content)).toContain("recovered");
    } finally { await shell.dispose(); }
  });
  it("reaps an ignoring shell on timeout, bounds output and aborts", async () => {
    const shell = new PersistentBashSession(process.cwd());
    try {
      expect(await shell.exec("trap '' TERM; while :; do :; done", { timeoutMs: 30 })).toContain("reset");
      expect(await shell.exec("printf recovered")).toBe("recovered");
      expect((await shell.exec("yes output", { maxOutputChars: 100 })).length).toBeLessThan(300);
      const controller = new AbortController();
      const pending = shell.exec("sleep 30", { signal: controller.signal });
      setTimeout(() => controller.abort(), 30);
      await expect(pending).rejects.toThrow("aborted");
    } finally { await shell.dispose(); }
  });
});

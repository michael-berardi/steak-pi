import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import writeRequiresRead, { FILE_RULE } from "../extensions/write-requires-read.ts";

type Handler = (event: any, ctx: any) => any;

describe("write requires read", () => {
  let dir: string;
  let handlers: Map<string, Handler>;
  let n: number;
  const saved = process.env.STEAK_PI_WRITE_GUARD;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "steak-pi-write-guard-"));
    writeFileSync(join(dir, "notes.txt"), "alpha\n");
    handlers = new Map();
    n = 0;
    delete process.env.STEAK_PI_WRITE_GUARD;
    writeRequiresRead({ on: (e: string, h: Handler) => void handlers.set(e, h) } as unknown as ExtensionAPI);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.STEAK_PI_WRITE_GUARD; else process.env.STEAK_PI_WRITE_GUARD = saved;
  });
  const ctx = () => ({ cwd: dir });
  const call = (toolName: string, path: string, isError = false) => {
    const toolCallId = `c${++n}`;
    const blocked = handlers.get("tool_call")!({ type: "tool_call", toolName, toolCallId, input: { path } }, ctx());
    if (!blocked) handlers.get("tool_result")!({ type: "tool_result", toolName, toolCallId, isError }, ctx());
    return blocked;
  };

  it("blocks write to an existing file that was never read, naming the fix", () => {
    const r = call("write", "notes.txt");
    expect(r.block).toBe(true);
    expect(r.reason).toContain("notes.txt");
    expect(r.reason).toContain("Read it first");
  });
  it("allows write after a successful read", () => {
    expect(call("read", "notes.txt")).toBeUndefined();
    expect(call("write", "notes.txt")).toBeUndefined();
  });
  it("does not count a failed read", () => {
    call("read", "notes.txt", true);
    expect(call("write", "notes.txt")?.block).toBe(true);
  });
  it("allows creating a new file, and rewriting it afterwards", () => {
    expect(call("write", "new.txt")).toBeUndefined();
    writeFileSync(join(dir, "new.txt"), "x");
    expect(call("write", "new.txt")).toBeUndefined();
  });
  it("resolves absolute, relative and @-prefixed paths to one file", () => {
    call("read", `@${join(dir, "notes.txt")}`);
    expect(call("write", "./notes.txt")).toBeUndefined();
  });
  it("forgets reads when a new session starts", () => {
    call("read", "notes.txt");
    handlers.get("session_start")!({ type: "session_start" }, ctx());
    expect(call("write", "notes.txt")?.block).toBe(true);
  });
  it("can be switched off", () => {
    process.env.STEAK_PI_WRITE_GUARD = "off";
    expect(call("write", "notes.txt")).toBeUndefined();
  });
  it("adds the file rule to the system prompt once, and not when switched off", () => {
    const h = handlers.get("before_agent_start")!;
    const first = h({ systemPrompt: "base" }, ctx());
    expect(first.systemPrompt).toBe(`base\n\n${FILE_RULE}`);
    expect(h({ systemPrompt: first.systemPrompt }, ctx())).toBeUndefined();
    process.env.STEAK_PI_WRITE_GUARD = "off";
    expect(h({ systemPrompt: "base" }, ctx())).toBeUndefined();
  });
  it("ignores other tools", () => {
    expect(call("bash", "notes.txt")).toBeUndefined();
  });
});

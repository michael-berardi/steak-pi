import { mkdtempSync, mkdirSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeClaudeWorkerSession } from "../src/subagents/claude-session.ts";

const id = "0b5e1c2a-1111-4222-8333-944455556666";
let root: string;
let home: string;
let projects: string;

function transcript(dir: string): void {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), "worker transcript");
  writeFileSync(join(dir, id, "child.jsonl"), "subagent transcript");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "steak-claude-session-"));
  home = join(root, "home");
  projects = join(home, ".claude", "projects");
  mkdirSync(projects, { recursive: true });
  vi.stubEnv("HOME", home);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("Claude worker transcript cleanup", () => {
  it("skips symlinked projects, preserving UUID-named external data", () => {
    const outside = join(root, "outside");
    const normal = join(projects, "normal");
    transcript(outside); transcript(normal);
    symlinkSync(outside, join(projects, "linked-project"));
    removeClaudeWorkerSession(id);
    expect(existsSync(join(outside, `${id}.jsonl`))).toBe(true);
    expect(existsSync(join(outside, id, "child.jsonl"))).toBe(true);
    expect(existsSync(join(normal, `${id}.jsonl`))).toBe(false);
    expect(existsSync(join(normal, id))).toBe(false);
  });

  it("skips non-directory project entries", () => {
    writeFileSync(join(projects, "not-a-directory"), "not a project");
    expect(() => removeClaudeWorkerSession(id)).not.toThrow();
  });

  it("refuses a symlinked recursive target and transcript file", () => {
    const outside = join(root, "outside");
    transcript(outside);
    const project = join(projects, "normal");
    mkdirSync(project);
    symlinkSync(join(outside, id), join(project, id));
    symlinkSync(join(outside, `${id}.jsonl`), join(project, `${id}.jsonl`));
    removeClaudeWorkerSession(id);
    expect(existsSync(join(outside, id, "child.jsonl"))).toBe(true);
    expect(existsSync(join(project, id))).toBe(true);
    expect(existsSync(join(project, `${id}.jsonl`))).toBe(true);
  });

  it.each(["projects", ".claude"])("refuses a symlinked %s root", (entry) => {
    const outside = join(root, "outside");
    const entryPath = entry === "projects" ? projects : join(home, ".claude");
    const project = entry === "projects" ? join(outside, "normal") : join(outside, "projects", "normal");
    transcript(project);
    rmSync(entryPath, { recursive: true });
    symlinkSync(outside, entryPath);
    removeClaudeWorkerSession(id);
    expect(existsSync(join(project, `${id}.jsonl`))).toBe(true);
    expect(existsSync(join(project, id, "child.jsonl"))).toBe(true);
  });

  it("keeps the UUID traversal guard and tolerates missing transcripts", () => {
    const project = join(projects, "normal");
    transcript(project);
    removeClaudeWorkerSession("../normal");
    expect(existsSync(join(project, `${id}.jsonl`))).toBe(true);
    removeClaudeWorkerSession(id); removeClaudeWorkerSession(id);
    removeClaudeWorkerSession(id, join(root, "missing-home"));
    expect(existsSync(join(project, id))).toBe(false);
  });
});

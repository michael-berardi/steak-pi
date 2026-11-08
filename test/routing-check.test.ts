import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (file: string) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ["--no-warnings", join(__dirname, "../src/routing-check.ts"), file], { encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    const e = error as { status: number; stderr: string };
    return { code: e.status, out: e.stderr };
  }
};

describe("steak-pi routing check", () => {
  const dir = mkdtempSync(join(tmpdir(), "routing-check-"));
  const write = (name: string, value: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(value)); return p; };
  const classes = (note: string) => ({ taskClasses: { "quick-edit": { chain: ["openrouter/inception/mercury-3"], requiresTestGate: false, note } } });
  it("accepts a valid file", () => {
    expect(run(write("ok.json", classes("short summary")))).toMatchObject({ code: 0 });
  });
  it("rejects a task-class note over 400 characters, naming the key (the 2026-11-08 outage)", () => {
    const result = run(write("long.json", classes("x".repeat(401))));
    expect(result.code).toBe(1);
    expect(result.out).toContain("taskClasses.quick-edit.note");
  });
  it("rejects a file that is not JSON", () => {
    const p = join(dir, "broken.json"); writeFileSync(p, "{");
    expect(run(p).code).toBe(1);
  });
});

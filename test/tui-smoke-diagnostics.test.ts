import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Synthetic test: exercises the shell diagnostics helper without tmux or Pi.
const helper = join(process.cwd(), "scripts/lib/tui-smoke-diagnostics.sh");

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), "tui-diag-test-")); });
afterEach(() => rmSync(work, { recursive: true, force: true }));

function runDump(fixture: string, sessionDir: string, version: string, cwd: string, diagDir?: string) {
  const script = `source "$1"; dump_resume_diagnostics "$2" "$3" "$4" "$5"`;
  const env = { ...process.env, ...(diagDir ? { TUI_DIAGNOSTICS_DIR: diagDir } : {}) };
  const run = spawnSync("bash", ["-c", script, "bash", helper, fixture, sessionDir, version, cwd], {
    encoding: "utf8", env,
  });
  return { code: run.status ?? -1, stderr: run.stderr ?? "" };
}

describe("TUI smoke resume diagnostics", () => {
  it("reports fixture header cwd, process cwd, Pi version and every session file", () => {
    const sessions = join(work, "sessions");
    mkdirSync(sessions);
    writeFileSync(join(sessions, "fixture.jsonl"), JSON.stringify({ type: "session", cwd: "/tmp/fixture-project" }) + "\n{}\n");
    writeFileSync(join(sessions, "other.jsonl"), JSON.stringify({ type: "session", cwd: "/elsewhere" }) + "\n");
    const result = runDump(join(sessions, "fixture.jsonl"), sessions, "1.0.4", "/tmp/process-cwd");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Pi version: 1.0.4");
    expect(result.stderr).toContain("process cwd: /tmp/process-cwd");
    expect(result.stderr).toContain("fixture header cwd: /tmp/fixture-project");
    expect(result.stderr).toContain("session files: 2");
    expect(result.stderr).toContain("other.jsonl");
    expect(result.stderr).toContain("header_cwd=/elsewhere");
  });

  it("names a missing fixture and session dir instead of failing silently", () => {
    const result = runDump(join(work, "absent.jsonl"), join(work, "no-dir"), "0.0.0", "/x");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("fixture header cwd: <fixture missing>");
    expect(result.stderr).toContain("session dir missing");
  });

  it("names an unreadable header without crashing", () => {
    const sessions = join(work, "sessions");
    mkdirSync(sessions);
    writeFileSync(join(sessions, "bad.jsonl"), "not json\n");
    const result = runDump(join(sessions, "bad.jsonl"), sessions, "1.0.4", "/x");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("<unreadable session header: JSONDecodeError>");
  });

  it("keeps the saved report private (folder 0700, file 0600) when a diagnostics dir is set", () => {
    const sessions = join(work, "sessions");
    mkdirSync(sessions);
    writeFileSync(join(sessions, "fixture.jsonl"), JSON.stringify({ type: "session", cwd: "/p" }) + "\n");
    const diag = join(work, "diag");
    const result = runDump(join(sessions, "fixture.jsonl"), sessions, "1.0.4", "/p", diag);
    expect(result.code).toBe(0);
    expect(statSync(diag).mode & 0o777).toBe(0o700);
    const file = join(diag, "resume-diagnostics.txt");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("fixture header cwd: /p");
  });
});

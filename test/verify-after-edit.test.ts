import { execFileSync } from "node:child_process";
import { promises as fs, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import verifyAfterEditExtension, {
  formatAppendix,
  loadVerifyConfig,
  runVerify,
  shellInvocation,
  shouldVerify,
  verificationTreeHash,
} from "../extensions/verify-after-edit.ts";

const storage = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock("../src/verification-artifacts.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verification-artifacts.ts")>();
  return { ...actual, beginVerification: (root?: string) => actual.beginVerification(root ?? storage.root) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

function registeredHandler() {
  let handler!: (event: any, ctx: any) => Promise<any>;
  verifyAfterEditExtension({ on(name: string, value: typeof handler) {
    if (name === "tool_result") handler = value;
  } } as unknown as ExtensionAPI);
  return handler;
}

const CONFIG = { command: "npm run -s typecheck", failLimit: 2, timeoutMs: 90_000 };
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "steak-pi-verify-")));
  tempDirs.push(dir);
  return dir;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function nodeCommand(script: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

async function writeConfig(
  cwd: string,
  verify: { command: string; failLimit?: number; timeoutMs?: number },
): Promise<void> {
  await fs.mkdir(path.join(cwd, ".steak-pi"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, ".steak-pi", "config.json"),
    JSON.stringify({ verify }),
  );
}

beforeEach(async () => { storage.root = path.join(await tempDir(), "logs"); });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("verify-after-edit", () => {
  it("loads valid config values and stays idle without a command", async () => {
    const cwd = await tempDir();
    await writeConfig(cwd, { command: "npm test", failLimit: 3, timeoutMs: 1234 });
    expect(loadVerifyConfig(cwd)).toEqual({ command: "npm test", failLimit: 3, timeoutMs: 1234 });
    expect(loadVerifyConfig("/nonexistent")).toBeNull();
    expect(shouldVerify(null, "edit", false, 0, 1000, 0)).toBe(false);
  });

  it("only reacts to successful edit and write tools before the failure limit", () => {
    expect(shouldVerify(CONFIG, "edit", false, 0, 1000, 0)).toBe(true);
    expect(shouldVerify(CONFIG, "write", false, 1, 1000, 0)).toBe(true);
    expect(shouldVerify(CONFIG, "bash", false, 0, 1000, 0)).toBe(false);
    expect(shouldVerify(CONFIG, "edit", true, 0, 1000, 0)).toBe(false);
    expect(shouldVerify(CONFIG, "edit", false, 2, 1000, 0)).toBe(false);
  });

  it("debounces rapid successive edits", () => {
    expect(shouldVerify(CONFIG, "edit", false, 0, 1000, 900)).toBe(false);
    expect(shouldVerify(CONFIG, "edit", false, 0, 1600, 900)).toBe(true);
  });

  it("uses a fixed shell executable and passes the configured command as one argument", () => {
    expect(shellInvocation("echo $HOME", "darwin")).toEqual({
      executable: "/bin/bash",
      args: ["--noprofile", "--norc", "-o", "pipefail", "-c", "echo $HOME"],
    });
    expect(shellInvocation("echo %USERPROFILE%", "win32")).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "echo %USERPROFILE%"],
    });
  });

  it("does not hide a failed pipeline producer behind a successful filter", async () => {
    const cwd = await tempDir();
    const result = await runVerify({ command: "false | true", failLimit: 2, timeoutMs: 2000 }, cwd);
    expect(result.failed).toBe(true);
  });

  it("retains native reports and rejects failed suites or stale reports without rerunning", async () => {
    const cwd = await tempDir();
    const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numFailedTestSuites: 1, testResults: [{ status: "passed", assertionResults: [{ status: "passed" }] }, { status: "failed", assertionResults: [] }] };
    const command = nodeCommand(`const fs=require('node:fs');fs.appendFileSync('runs','x');fs.writeFileSync('report.json',${JSON.stringify(JSON.stringify(report))})`);
    const result = await runVerify({ command, failLimit: 2, timeoutMs: 2000, vitestReport: "report.json" }, cwd);
    expect(result.failed).toBe(true);
    expect(result.tail).toContain("1 failed suites");
    expect(JSON.parse(await fs.readFile(path.join(result.artifact!, "native-report.json"), "utf8"))).toEqual(report);
    expect(await fs.readFile(path.join(cwd, "runs"), "utf8")).toBe("x");
    const stale = await runVerify({ command: "true", failLimit: 2, timeoutMs: 2000, vitestReport: "report.json" }, cwd);
    expect(stale.failed).toBe(true);
    expect(stale.tail).toContain("stale");
  });

  it("bounds failure output", async () => {
    const cwd = await tempDir();
    const result = await runVerify({
      command: nodeCommand("process.stderr.write('x'.repeat(10000)); process.exit(1)"),
      failLimit: 2,
      timeoutMs: 2_000,
    }, cwd);
    expect(result.failed).toBe(true);
    expect(result.tail).toHaveLength(4_000);
    expect(result.tail).toBe("x".repeat(4_000));
    expect(await fs.readFile(path.join(result.artifact!, "stderr.log"), "utf8")).toBe("x".repeat(10_000));
    expect(JSON.parse(await fs.readFile(path.join(result.artifact!, "result.json"), "utf8"))).toMatchObject({ failed: true, exitCode: 1, complete: true, bytes: 10_000 });
  });

  it("times out, cleans up the process tree, and accepts caller aborts", async () => {
    const cwd = await tempDir();
    const marker = path.join(cwd, "late-write");
    const command = nodeCommand(
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 300); ` +
      "setInterval(() => {}, 1000)",
    );
    const timedOut = await runVerify({ command, failLimit: 2, timeoutMs: 40 }, cwd);
    expect(timedOut).toMatchObject({
      failed: true,
      tail: "verification timed out after 40ms",
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const controller = new AbortController();
    const pending = runVerify({
      command: nodeCommand("setInterval(() => {}, 1000)"),
      failLimit: 2,
      timeoutMs: 5_000,
    }, cwd, controller.signal);
    setTimeout(() => controller.abort(), 40);
    await expect(pending).resolves.toMatchObject({ failed: true, tail: "verification aborted" });
  });

  it("never executes project config when the event context is untrusted", async () => {
    const cwd = await tempDir();
    await writeConfig(cwd, {
      command: nodeCommand("require('node:fs').writeFileSync('ran', 'yes')"),
      timeoutMs: 1_000,
    });
    let handler: ((event: any, ctx: any) => Promise<unknown>) | undefined;
    const pi = {
      on(name: string, value: typeof handler) {
        if (name === "tool_result") handler = value;
      },
    } as unknown as ExtensionAPI;
    verifyAfterEditExtension(pi);

    const result = await handler?.(
      { toolName: "edit", isError: false, content: [{ type: "text", text: "edited" }] },
      { cwd, isProjectTrusted: () => false, signal: undefined },
    );
    expect(result).toBeUndefined();
    await expect(fs.access(path.join(cwd, "ran"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not read config for non-edit, failed, or untrusted results", async () => {
    const handler = registeredHandler();
    const cwd = await tempDir();
    const reads = vi.mocked(readFileSync);
    reads.mockClear();
    const ctx = { cwd, isProjectTrusted: () => true, signal: undefined };
    for (const toolName of ["read", "bash", "grep", "find", "ls", "custom"]) {
      await handler({ toolName, isError: false, content: [] }, ctx);
    }
    for (const toolName of ["edit", "write"]) {
      await handler({ toolName, isError: true, content: [] }, ctx);
      await handler({ toolName, isError: false, content: [] }, {
        ...ctx, isProjectTrusted: () => false,
      });
    }
    expect(reads).not.toHaveBeenCalled();
  });

  it("skips config reads while verification is already running", async () => {
    const cwd = await tempDir();
    await writeConfig(cwd, { command: nodeCommand("setTimeout(() => {}, 100)"), timeoutMs: 2000 });
    const handler = registeredHandler();
    const reads = vi.mocked(readFileSync);
    reads.mockClear();
    const ctx = { cwd, isProjectTrusted: () => true, signal: undefined };
    const event = { toolName: "EDIT", isError: false, content: [] };
    const pending = handler(event, ctx);
    try {
      await handler(event, ctx);
      await handler({ ...event, toolName: "write" }, ctx);
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      await pending;
    }
  });

  it("reads changed commands and failure limits freshly for each eligible edit", async () => {
    const cwd = await tempDir();
    await writeConfig(cwd, { command: "exit 1", failLimit: 1 });
    const handler = registeredHandler();
    const reads = vi.mocked(readFileSync);
    reads.mockClear();
    vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    const ctx = { cwd, isProjectTrusted: () => true, signal: undefined };
    const event = { toolName: "write", isError: false, content: [] };
    const first = await handler(event, ctx);
    expect(first.content.at(-1).text).toContain("attempt 1/1");
    await writeConfig(cwd, { command: "printf changed; exit 1", failLimit: 3 });
    const second = await handler(event, ctx);
    expect(second.content.at(-1).text).toContain("attempt 2/3");
    expect(second.content.at(-1).text).toContain("changed");
    expect(reads.mock.calls.filter(([name]) => String(name).endsWith(path.join(".steak-pi", "config.json")))).toHaveLength(2);
  });

  it("reports the failure that reaches failLimit, then suppresses later runs", async () => {
    const cwd = await tempDir();
    await writeConfig(cwd, {
      command: nodeCommand("process.stderr.write('synthetic failure'); process.exit(1)"),
      failLimit: 2,
      timeoutMs: 2_000,
    });
    let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
    const pi = {
      on(name: string, value: typeof handler) {
        if (name === "tool_result") handler = value;
      },
    } as unknown as ExtensionAPI;
    verifyAfterEditExtension(pi);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(3_000);
    const event = {
      toolName: "write",
      isError: false,
      content: [{ type: "text", text: "wrote file" }],
    };
    const ctx = { cwd, isProjectTrusted: () => true, signal: undefined };

    const first = await handler?.(event, ctx);
    const second = await handler?.(event, ctx);
    const third = await handler?.(event, ctx);
    expect(first.content.at(-1).text).toContain("verify failed (attempt 1/2)");
    expect(second.content.at(-1).text).toContain("verify failed (attempt 2/2)");
    expect(second.content.at(-1).text).toContain("synthetic failure");
    expect(third).toBeUndefined();
  });

  it("formats the appendix with attempt, limit, and output tail", () => {
    const text = formatAppendix("npm run -s typecheck", 1, 2, "error TS2322: x");
    expect(text).toContain("[steak-pi] verify failed (attempt 1/2)");
    expect(text).toContain("npm run -s typecheck");
    expect(text).toContain("error TS2322: x");
    expect(text).toContain("Fix the reported problem before finishing.");
  });

  it("hashes working-tree content, ignores ignored files, and never follows symlinks", async () => {
    const cwd = await tempDir();
    execFileSync("git", ["init", "--quiet", cwd]);
    writeFileSync(path.join(cwd, ".gitignore"), "ignored\n");
    writeFileSync(path.join(cwd, "file"), "a");
    const first = verificationTreeHash(cwd);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    writeFileSync(path.join(cwd, "ignored"), "ignored content");
    expect(verificationTreeHash(cwd)).toBe(first);
    writeFileSync(path.join(cwd, "file"), "b");
    expect(verificationTreeHash(cwd)).not.toBe(first);
    symlinkSync("ignored", path.join(cwd, "link"));
    const linked = verificationTreeHash(cwd);
    writeFileSync(path.join(cwd, "ignored"), "different ignored content");
    expect(verificationTreeHash(cwd)).toBe(linked);
  });

  it("debounces concurrent edits into one batch and appends a success receipt naming a private artifact root", async () => {
    const cwd = await tempDir();
    await fs.mkdir(path.join(cwd, ".steak-pi"), { recursive: true });
    await fs.writeFile(path.join(cwd, ".steak-pi", "config.json"), JSON.stringify({ verify: { command: "printf x >> runs" } }));
    const handler = registeredHandler();
    const ctx = { cwd, isProjectTrusted: () => true, signal: undefined };
    const event = { toolName: "edit", isError: false, content: [{ type: "text", text: "edited" }] };
    const started = performance.now();
    const pending = handler(event, ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await handler({ ...event, toolName: "write" }, ctx)).toBeUndefined();
    const result = await pending;
    expect(performance.now() - started).toBeGreaterThanOrEqual(790);
    expect(await fs.readFile(path.join(cwd, "runs"), "utf8")).toBe("x");
    expect(result.content[0]).toEqual(event.content[0]);
    expect(result.content[1].text).toMatch(/^\[steak-pi\] verify passed: printf x >> runs \| tree=unavailable \| \d+ms\nRetained stdout, stderr, and producer status: .+$/);
    const artifact = result.content[1].text.split("status: ")[1];
    expect(artifact.startsWith(storage.root!)).toBe(true);
    // A sequential edit is a new batch, never skipped by a last-run throttle.
    await handler(event, ctx);
    expect(await fs.readFile(path.join(cwd, "runs"), "utf8")).toBe("xx");
  });

  it("scrubs caller BASH_ENV and ENV so their scripts cannot run inside verification", async () => {
    const cwd = await tempDir();
    const bashEnv = path.join(cwd, "bash-env.sh");
    const envScript = path.join(cwd, "env.sh");
    const bashMarker = path.join(cwd, "bash-env-ran");
    const envMarker = path.join(cwd, "env-ran");
    await fs.writeFile(bashEnv, `touch ${shellQuote(bashMarker)}\n`);
    await fs.writeFile(envScript, `touch ${shellQuote(envMarker)}\n`);
    const saved = { BASH_ENV: process.env.BASH_ENV, ENV: process.env.ENV };
    process.env.BASH_ENV = bashEnv;
    process.env.ENV = envScript;
    try {
      const result = await runVerify({ command: "true", failLimit: 2, timeoutMs: 5_000 }, cwd, undefined, { artifactRoot: path.join(cwd, "logs") });
      expect(result.failed).toBe(false);
    } finally {
      if (saved.BASH_ENV === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = saved.BASH_ENV;
      if (saved.ENV === undefined) delete process.env.ENV; else process.env.ENV = saved.ENV;
    }
    await expect(fs.access(bashMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(envMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on an invalid vitestReport configuration without running the command", async () => {
    const cwd = await tempDir();
    await fs.mkdir(path.join(cwd, ".steak-pi"), { recursive: true });
    await fs.writeFile(
      path.join(cwd, ".steak-pi", "config.json"),
      JSON.stringify({ verify: { command: nodeCommand("require('node:fs').writeFileSync('ran', 'yes')"), vitestReport: 123 } }),
    );
    const config = loadVerifyConfig(cwd);
    expect(config?.configurationError).toContain("vitestReport");
    const result = await runVerify(config!, cwd, undefined, { artifactRoot: path.join(cwd, "logs") });
    expect(result.failed).toBe(true);
    expect(result.tail).toContain("vitestReport");
    await expect(fs.access(path.join(cwd, "ran"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a passing run's private root and complete producer status", async () => {
    const cwd = await tempDir();
    const logs = path.join(cwd, "logs");
    const result = await runVerify({ command: nodeCommand("process.stdout.write('ok')"), failLimit: 2, timeoutMs: 5_000 }, cwd, undefined, { artifactRoot: logs });
    expect(result.failed).toBe(false);
    expect(statSync(logs).mode & 0o777).toBe(0o700);
    expect(statSync(result.artifact!).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await fs.readFile(path.join(result.artifact!, "result.json"), "utf8")))
      .toMatchObject({ failed: false, complete: true, exitCode: 0, bytes: 2, finished: true });
    expect(await fs.readFile(path.join(result.artifact!, "stdout.log"), "utf8")).toBe("ok");
  });

  it("decodes split and invalid console bytes without crashing or corrupting the tail", async () => {
    const cwd = await tempDir();
    const script = "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0xff])), 20); setTimeout(() => { process.exitCode = 1; }, 60)";
    const result = await runVerify({ command: nodeCommand(script), failLimit: 2, timeoutMs: 5_000 }, cwd, undefined, { artifactRoot: path.join(cwd, "logs") });
    expect(result.failed).toBe(true);
    expect(result.tail).toContain("\u00e9");
    expect(result.tail).toContain("\uFFFD");
  });
});

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import verifyAfterEditExtension, {
  formatAppendix,
  loadVerifyConfig,
  runVerify,
  shellInvocation,
  shouldVerify,
} from "../extensions/verify-after-edit.ts";

const CONFIG = { command: "npm run -s typecheck", failLimit: 2, timeoutMs: 90_000 };
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "steak-pi-verify-"));
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
      executable: "/bin/sh",
      args: ["-c", "echo $HOME"],
    });
    expect(shellInvocation("echo %USERPROFILE%", "win32")).toEqual({
      executable: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "echo %USERPROFILE%"],
    });
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
  });

  it("times out, cleans up the process tree, and accepts caller aborts", async () => {
    const cwd = await tempDir();
    const marker = path.join(cwd, "late-write");
    const command = nodeCommand(
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 300); ` +
      "setInterval(() => {}, 1000)",
    );
    const timedOut = await runVerify({ command, failLimit: 2, timeoutMs: 40 }, cwd);
    expect(timedOut).toEqual({
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
    await expect(pending).resolves.toEqual({ failed: true, tail: "verification aborted" });
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
});

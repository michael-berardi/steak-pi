import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn,
}));
import { discoverClaudeModels, getClaudeStatus, killProcessTree } from "../../extensions/claude-code/claude-cli.ts";

class FakeChild extends EventEmitter {
  pid = 1234567;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  unref = vi.fn();
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

let child: FakeChild;
let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  child = new FakeChild();
  mocks.spawn.mockReset().mockImplementation((command: string) => command === "taskkill" ? new FakeChild() : child);
  vi.spyOn(process, "kill").mockImplementation(() => true);
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  vi.restoreAllMocks();
});

async function launch(platform: NodeJS.Platform = "linux"): Promise<void> {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  const abort = new AbortController();
  const discovery = discoverClaudeModels({ PI_CLAUDE_CODE_COMMAND: process.execPath }, abort.signal).catch(() => {});
  stop = async () => { abort.abort(); await discovery; };
  await vi.waitFor(() => assert.equal(mocks.spawn.mock.calls.length, 1));
}

for (const [code, signal] of [[0, null], [1, null], [null, "SIGTERM"]] as const) {
  test(`Windows skips taskkill after exit (${code ?? signal})`, async () => {
    await launch("win32");
    child.exit(code, signal);
    killProcessTree(child as unknown as ChildProcess);
    assert.equal(mocks.spawn.mock.calls.length, 1);
    assert.equal(child.kill.mock.calls.length, 0);
  });
}

test("Windows still kills a live Claude tree", async () => {
  await launch("win32");
  killProcessTree(child as unknown as ChildProcess);
  assert.deepEqual(mocks.spawn.mock.calls[1]?.slice(0, 2), ["taskkill", ["/F", "/T", "/PID", "1234567"]]);
});

test("Windows auth status cleanup never taskkills its exited probe", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const status = getClaudeStatus({ PI_CLAUDE_CODE_COMMAND: process.execPath });
  await vi.waitFor(() => assert.equal(mocks.spawn.mock.calls.length, 1));
  child.stdout.write('{"loggedIn":true}');
  child.exit(0);
  assert.equal((await status).loggedIn, true);
  assert.equal(mocks.spawn.mock.calls.length, 1);
});

test("POSIX kills a live detached Claude process group", async () => {
  await launch();
  killProcessTree(child as unknown as ChildProcess);
  assert.deepEqual(vi.mocked(process.kill).mock.calls, [[-1234567, "SIGKILL"]]);
});

test("a signalled Claude leader still has its MCP process group killed", async () => {
  await launch();
  child.exit(null, "SIGTERM");
  killProcessTree(child as unknown as ChildProcess);
  assert.deepEqual(vi.mocked(process.kill).mock.calls, [[-1234567, "SIGKILL"]]);
});

test("POSIX skips an old exited leader whose group ownership cannot be verified", async () => {
  await launch();
  const now = performance.now();
  const clock = vi.spyOn(performance, "now").mockReturnValue(now);
  child.exit(0);
  clock.mockReturnValue(now + 5_000);
  killProcessTree(child as unknown as ChildProcess);
  assert.equal(vi.mocked(process.kill).mock.calls.length, 0);
  assert.equal(child.kill.mock.calls.length, 0);
});

test("POSIX skips an exited process with no recorded group ownership", () => {
  child.exitCode = 0;
  killProcessTree(child as unknown as ChildProcess);
  assert.equal(vi.mocked(process.kill).mock.calls.length, 0);
  assert.equal(child.kill.mock.calls.length, 0);
});

test("POSIX auth probes never signal a process group they did not create", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const abort = new AbortController();
  const status = getClaudeStatus({ PI_CLAUDE_CODE_COMMAND: process.execPath }, abort.signal).catch(() => {});
  stop = async () => { abort.abort(); await status; };
  await vi.waitFor(() => assert.equal(mocks.spawn.mock.calls.length, 1));
  killProcessTree(child as unknown as ChildProcess);
  assert.equal(vi.mocked(process.kill).mock.calls.length, 0);
  assert.deepEqual(child.kill.mock.calls, [["SIGKILL"]]);
});

test("POSIX never falls back to a reused leader PID after group cleanup fails", async () => {
  await launch();
  child.exit(0);
  vi.mocked(process.kill).mockImplementation(() => { throw new Error("ESRCH"); });
  killProcessTree(child as unknown as ChildProcess);
  assert.equal(child.kill.mock.calls.length, 0);
});

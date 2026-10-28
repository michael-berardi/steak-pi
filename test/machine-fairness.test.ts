import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineSlots } from "../src/subagents/machine-slots.ts";
import type { CapacityConfig } from "../src/subagents/capacity.ts";

const directories: string[] = [];
const config = (global = 1): CapacityConfig => ({
  session: { providers: {}, global: 8 },
  machine: { providers: { alpha: 1, beta: 1 }, global },
});
function fixture(global = 1) {
  const dir = mkdtempSync(join(tmpdir(), "usap-machine-fairness-"));
  directories.push(dir);
  const capacity = config(global);
  return { dir, capacity, slots: () => new MachineSlots({ dir, config: capacity }) };
}
function queuedFiles(dir: string) {
  return [".waiters", ".admission"].flatMap(bucket =>
    readdirSync(join(dir, bucket)).map(name => `${bucket}/${name}`));
}
afterEach(() => {
  vi.useRealTimers();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("machine acquisition FIFO", () => {
  it.each([
    { name: "provider", global: 3, newer: "alpha" },
    { name: "global across providers", global: 1, newer: "beta" },
  ])("protects an older queued request from repeated newer $name arrivals", async ({ global, newer }) => {
    vi.useFakeTimers();
    const { slots, dir } = fixture(global);
    const held = await slots().acquire("alpha");
    const abort = new AbortController();
    const older = slots().acquire("alpha", abort.signal, 5_000).catch(error => error as Error);
    let releaseOlder: (() => void) | undefined;
    try {
      held();
      // The old retry loop lets each zero-timeout arrival steal the free slot
      // before the sleeping older request's next poll. No timing race is needed.
      for (let i = 0; i < 5; i++) {
        let stolen: (() => void) | undefined;
        try {
          await expect(slots().acquire(newer, undefined, 0).then(release => {
            stolen = release;
            return release;
          })).rejects.toThrow(/exhausted/);
        } finally { stolen?.(); }
      }
      await vi.advanceTimersByTimeAsync(250);
      const result = await older;
      expect(result).toBeTypeOf("function");
      if (typeof result === "function") releaseOlder = result;
      releaseOlder?.();
      expect(queuedFiles(dir)).toEqual([]);
    } finally {
      held();
      abort.abort();
      const result = await older;
      if (typeof result === "function") result();
    }
  });

  it("skips provider-blocked waiters but respects them as soon as they become eligible", async () => {
    vi.useFakeTimers();
    const { slots } = fixture(2);
    const held = await slots().acquire("alpha");
    const abort = new AbortController();
    const older = slots().acquire("alpha", abort.signal, 5_000).catch(error => error as Error);
    try {
      const independent = await slots().acquire("beta", undefined, 0);
      independent();
      held();
      let stolen: (() => void) | undefined;
      try {
        await expect(slots().acquire("beta", undefined, 0).then(release => {
          stolen = release;
          return release;
        })).rejects.toThrow(/exhausted/);
      } finally { stolen?.(); }
      await vi.advanceTimersByTimeAsync(250);
      const result = await older;
      expect(result).toBeTypeOf("function");
      if (typeof result === "function") result();
    } finally {
      held();
      abort.abort();
      const result = await older;
      if (typeof result === "function") result();
    }
  });

  it("removes cancelled and timed-out requests without consuming either bucket", async () => {
    vi.useFakeTimers();
    const { slots, dir } = fixture();
    const held = await slots().acquire("alpha");
    const abort = new AbortController();
    const cancelled = slots().acquire("alpha", abort.signal, 5_000).catch(error => error as Error);
    const timedOut = slots().acquire("beta", undefined, 25).catch(error => error as Error);
    abort.abort();
    expect(await cancelled).toEqual(expect.objectContaining({ message: expect.stringContaining("aborted") }));
    await vi.advanceTimersByTimeAsync(250);
    expect(await timedOut).toBeInstanceOf(Error);
    expect(queuedFiles(dir)).toEqual([]);
    expect(slots().inspect("beta").providerBucket.held).toBe(0);
    held();
    const release = await slots().acquire("beta", undefined, 0);
    release();
    expect(slots().inspect("beta").globalBucket.held).toBe(0);
  });
});

function olderProcess(dir: string, capacity: CapacityConfig): ChildProcess {
  const moduleUrl = new URL("../src/subagents/machine-slots.ts", import.meta.url).href;
  // IPC-driven retry clock keeps this regression deterministic across processes.
  const script = `
import { MachineSlots } from ${JSON.stringify(moduleUrl)};
const callbacks = new Set();
globalThis.setTimeout = callback => { callbacks.add(callback); return callback; };
globalThis.clearTimeout = callback => { callbacks.delete(callback); };
let release;
process.on('message', message => {
  if (message === 'tick') {
    const pending = [...callbacks]; callbacks.clear();
    for (const callback of pending) callback();
  } else if (message === 'release') { release?.(); process.disconnect(); }
});
let observed = false;
release = await new MachineSlots({ dir: ${JSON.stringify(dir)}, config: ${JSON.stringify(capacity)} })
  .acquire('alpha', undefined, 10000, { onWait: () => {
    if (!observed) { observed = true; process.send('queued'); }
  } });
process.send('acquired');
`;
  return spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

it("protects a real older parent process against repeated newer arrivals", async () => {
  const { slots, dir, capacity } = fixture();
  const held = await slots().acquire("alpha");
  const child = olderProcess(dir, capacity);
  const closed = once(child, "close");
  try {
    expect((await once(child, "message"))[0]).toBe("queued");
    held();
    for (let i = 0; i < 5; i++) {
      let stolen: (() => void) | undefined;
      try {
        await expect(slots().acquire("beta", undefined, 0).then(release => {
          stolen = release;
          return release;
        })).rejects.toThrow(/exhausted/);
      } finally { stolen?.(); }
    }
    const acquired = once(child, "message");
    child.send("tick");
    expect((await acquired)[0]).toBe("acquired");
    child.send("release");
    expect((await closed)[0]).toBe(0);
    expect(queuedFiles(dir)).toEqual([]);
  } finally {
    held();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}, 10_000);

it("ignores a provably dead process's queued request without stealing live leases", async () => {
  const { slots, dir, capacity } = fixture();
  const held = await slots().acquire("alpha");
  const child = olderProcess(dir, capacity);
  const closed = once(child, "close");
  try {
    expect((await once(child, "message"))[0]).toBe("queued");
    child.kill("SIGKILL");
    await closed;
    await expect(slots().acquire("beta", undefined, 0)).rejects.toThrow(/exhausted/);
    expect(slots().inspect("alpha").providerBucket.held).toBe(1);
    held();
    const release = await slots().acquire("beta", undefined, 0);
    release();
    expect(slots().inspect("beta").globalBucket.held).toBe(0);
  } finally {
    held();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
}, 10_000);

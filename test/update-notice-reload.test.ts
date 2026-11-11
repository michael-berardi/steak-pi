import { describe, expect, it } from "vitest";
import { reloadWhenIdle } from "../extensions/update-notice.ts";

// A host that models Pi's agent lifecycle: waitForIdle resolves at the next idle, agent_settled fires at idle.
function fakeHost(options: { reloadError?: string } = {}) {
  const listeners = new Set<() => unknown>();
  const waiters: Array<() => void> = [];
  const notes: Array<{ message: string; level: string }> = [];
  let idle = true;
  let reloads = 0;
  let reloadedWhileBusy = false;
  const pi = {
    on(event: string, handler: () => unknown) {
      if (event !== "agent_settled") throw new Error(`unexpected event ${event}`);
      listeners.add(handler);
      return () => { listeners.delete(handler); };
    },
  } as any;
  const ctx = {
    isIdle: () => idle,
    waitForIdle: () => idle ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve)),
    reload: async () => {
      if (!idle) reloadedWhileBusy = true;
      reloads += 1;
      if (options.reloadError) throw new Error(options.reloadError);
    },
  };
  return {
    pi,
    ctx,
    notify: (message: string, level: "info" | "error") => { notes.push({ message, level }); },
    notes,
    listeners,
    get reloads() { return reloads; },
    get reloadedWhileBusy() { return reloadedWhileBusy; },
    startRun() { idle = false; },
    settle() {
      idle = true;
      for (const resolve of waiters.splice(0)) resolve();
      for (const listener of [...listeners]) void listener();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("/steak-update reload waits for idle and is never aborted by a busy session", () => {
  it("reloads at once when the agent is already idle", async () => {
    const host = fakeHost();
    await reloadWhenIdle(host.pi, host.ctx, host.notify);
    expect(host.reloads).toBe(1);
    expect(host.notes).toEqual([]);
    expect(host.listeners.size).toBe(0);
  });

  it("queues a reload requested while busy and runs it at the next idle, never during the run", async () => {
    const host = fakeHost();
    host.startRun();
    const done = reloadWhenIdle(host.pi, host.ctx, host.notify);
    await tick();
    expect(host.reloads).toBe(0);
    expect(host.notes).toEqual([{ message: expect.stringContaining("queued"), level: "info" }]);
    host.settle();
    await done;
    expect(host.reloads).toBe(1);
    expect(host.reloadedWhileBusy).toBe(false);
    expect(host.listeners.size).toBe(0);
  });

  it("keeps the request queued when a new run starts before the wait returns, then reloads at that next idle", async () => {
    const host = fakeHost();
    host.startRun();
    const ctx = {
      ...host.ctx,
      // The wait returns, but a new run already began: the host is busy again.
      waitForIdle: async () => { host.startRun(); },
    };
    const done = reloadWhenIdle(host.pi, ctx as any, host.notify);
    await done;
    expect(host.reloads).toBe(0);
    expect(host.listeners.size).toBe(1);
    host.settle();
    await tick();
    expect(host.reloads).toBe(1);
    expect(host.reloadedWhileBusy).toBe(false);
    expect(host.listeners.size).toBe(0);
  });

  it("names a reload failure instead of dropping it silently", async () => {
    const host = fakeHost({ reloadError: "extension load failed" });
    await reloadWhenIdle(host.pi, host.ctx, host.notify);
    expect(host.notes).toEqual([{ message: "Reload failed: extension load failed", level: "error" }]);
  });

  it("refuses to reload when the host cannot wait for idle, rather than aborting a running operation", async () => {
    const host = fakeHost();
    const ctx = { isIdle: () => false, reload: host.ctx.reload };
    await reloadWhenIdle(host.pi, ctx as any, host.notify);
    expect(host.reloads).toBe(0);
    expect(host.notes).toEqual([{ message: expect.stringMatching(/does not expose ctx\.waitForIdle.*Run \/reload yourself/s), level: "error" }]);
  });
});

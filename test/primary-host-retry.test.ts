import { describe, expect, it } from "vitest";
import { createPrimaryHostPublisher, getPrimaryHostIdentity, type HostDependencies } from "../src/primary-host.ts";

/** Synthetic tmux/descriptor fixture; no operator pane or session is accessed. */
function fixture() {
  const calls: string[][] = [];
  const options = new Map<string, string>();
  let generation = 0;
  let failedProofs = 1;
  let throws = false;
  let vacancyFails = false;
  let validPath = true;
  const device = { rdev: 42, isCharacterDevice: () => true };
  const deps: HostDependencies = { env: { TMUX_PANE: "%1", ULTRATERM_SLOT: "1" }, pid: 55,
    fd: () => device, stat: () => device, sessionPath: () => validPath, uuid: () => `retry-${++generation}` };
  const ctx = { mode: "tui", hasUI: true, sessionManager: {
    getSessionId: () => "session", getSessionFile: () => "/synthetic/session.jsonl",
  } };
  const p = createPrimaryHostPublisher(async (_command, args, config) => {
    calls.push(args);
    expect(config.timeout).toBe(1000);
    if (args[0] === "display-message") {
      if (args[4] === "#{@pi-primary-host}") return { code: vacancyFails ? 1 : 0, stdout: options.get("@pi-primary-host") ?? "" };
      if (failedProofs > 0) {
        failedProofs--;
        if (throws) throw new Error("synthetic proof timeout");
        return { code: 1, stdout: "" };
      }
      return { code: 0, stdout: args[4].includes("#{pane_pid}") ? "/dev/ttys001|55\n" : "/dev/ttys001\n" };
    }
    if (args[0] === "set-option") options.set(args[4], args[5]);
    if (args[0] === "if-shell") {
      const tuple = options.get("@pi-primary-host");
      const literal = tuple?.replaceAll("#", "##").replaceAll(",", "#,").replaceAll("}", "#}");
      if (tuple !== undefined && args[4] === `#{==:#{@pi-primary-host},${literal}}`) options.clear();
    }
    return { code: 0, stdout: "" };
  }, () => { throw new Error("must not fabricate history"); }, deps);
  return { p, ctx, deps, calls, options,
    failProofs: (n: number) => { failedProofs = n; },
    throwProof: () => { throws = true; },
    failVacancy: (value: boolean) => { vacancyFails = value; },
    pathValid: (value: boolean) => { validPath = value; } };
}

describe("primary host retry recovery (synthetic)", () => {
  it.each(["exit", "throw"])("re-runs the full proof after an initial timeout (%s)", async failure => {
    const f = fixture();
    if (failure === "throw") f.throwProof();
    try {
      await f.p.start(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      await f.p.retry(f.ctx);
      const host = getPrimaryHostIdentity(f.ctx.sessionManager)!;
      expect(host).toMatchObject({ sessionId: "session", generation: "retry-1" });
      expect(f.options.get("@pi-primary-host")).toBe(JSON.stringify(host));
      expect(f.options.get("@pi-session-file")).toBe(host.sessionFile);
      expect(f.calls.filter(args => args[4] === "#{@pi-primary-host}")).toHaveLength(1);
      const writes = f.calls.filter(args => args[0] === "set-option").length;
      await f.p.retry(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBe(host);
      expect(f.calls.filter(args => args[0] === "set-option")).toHaveLength(writes);
    } finally { await f.p.stop(); }
  });

  it("publishes nothing while repeated full proofs fail", async () => {
    const f = fixture(); f.failProofs(3);
    try {
      await f.p.start(f.ctx); await f.p.retry(f.ctx); await f.p.retry(f.ctx);
      expect(f.options.size).toBe(0);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      await f.p.retry(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeDefined();
    } finally { await f.p.stop(); }
  });

  it.each(["tuple", "vacancy-read", "path", "descriptor", "worker"])("does not bypass the %s guard during recovery", async guard => {
    const f = fixture();
    try {
      await f.p.start(f.ctx);
      if (guard === "tuple") f.options.set("@pi-primary-host", "another-process");
      if (guard === "vacancy-read") f.failVacancy(true);
      if (guard === "path") f.pathValid(false);
      if (guard === "descriptor") f.deps.fd = () => ({ rdev: 43, isCharacterDevice: () => true });
      if (guard === "worker") f.deps.env.PI_WORKER = "1";
      await f.p.retry(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      expect(f.calls.some(args => args[0] === "set-option")).toBe(false);
      if (guard === "tuple") expect(f.options.get("@pi-primary-host")).toBe("another-process");
    } finally { await f.p.stop(); }
  });

  it.each([false, true])("never resurrects a stopped publisher (reload=%s)", async reload => {
    const f = fixture(); f.failProofs(0);
    try {
      await f.p.start(f.ctx);
      const first = getPrimaryHostIdentity(f.ctx.sessionManager)!;
      await f.p.stop(reload);
      const count = f.calls.length;
      await f.p.retry(f.ctx);
      expect(f.calls).toHaveLength(count);
      expect(f.options.size).toBe(0);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      // Only an explicit lifecycle start can reactivate a stopped publisher.
      await f.p.start(f.ctx, reload);
      const next = getPrimaryHostIdentity(f.ctx.sessionManager)!;
      expect(next).toBeDefined();
      expect(next.generation === first.generation).toBe(reload);
    } finally { await f.p.stop(); }
  });

  it("cannot retry over another process-wide publisher", async () => {
    const f = fixture(); const other = fixture(); other.failProofs(0);
    try {
      await f.p.start(f.ctx); await other.p.start(other.ctx);
      const host = getPrimaryHostIdentity(other.ctx.sessionManager);
      const count = f.calls.length;
      await f.p.retry(f.ctx);
      expect(f.calls).toHaveLength(count);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      expect(getPrimaryHostIdentity(other.ctx.sessionManager)).toBe(host);
    } finally { await f.p.stop(); await other.p.stop(); }
  });
});

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, rmSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createPrimaryHostPublisher, getPrimaryHostIdentity, isCanonicalSessionPath, type HostDependencies } from "../src/primary-host.ts";
function fixture() {
  let validPath = true;
  let generation = 0;
  const calls: string[][] = [];
  const device = { rdev: 42, isCharacterDevice: () => true };
  const deps: HostDependencies = { env: { TMUX_PANE: "%1", ULTRATERM_SLOT: "1" }, pid: 55,
    fd: () => device, stat: () => device, sessionPath: () => validPath, uuid: () => `generation-${++generation}` };
  const ctx = { mode: "tui", hasUI: true, sessionManager: {
    getSessionId: () => "session", getSessionFile: () => "/tmp/test-session.jsonl",
  } };
  const entries: string[] = [];
  const exec = async (_: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: args[0] === "display-message" ? "/dev/ttys001\n" : "" };
  };
  const make = () => createPrimaryHostPublisher(exec, (type) => entries.push(type), deps);
  return { deps, ctx, calls, entries, make, exec, setPathValid: (value: boolean) => { validPath = value; } };
}
describe("primary proof", () => {
  it("shares ownership across independent extension-loader evaluations", async () => {
    const f = fixture(); const primary = f.make();
    vi.resetModules();
    const copy = await import("../src/primary-host.ts");
    const other = copy.createPrimaryHostPublisher(f.exec, () => {}, f.deps);
    const child = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager } };
    try {
      await Promise.all([primary.start(f.ctx), other.start(child)]);
      const host = getPrimaryHostIdentity(f.ctx.sessionManager);
      expect(host).toBeDefined();
      expect(copy.getPrimaryHostIdentity(f.ctx.sessionManager)).toBe(host);
      expect(copy.getPrimaryHostIdentity(child.sessionManager)).toBeUndefined();
      await other.stop();
      expect(copy.getPrimaryHostIdentity(f.ctx.sessionManager)).toBe(host);
    } finally { await primary.stop(); await other.stop(); }
  });
  it("rejects inherited pane env, workers, RPC, test, mirror and mismatched descriptors", async () => {
    for (const invalid of ["worker", "rpc", "pipe", "tty", "test", "mirror", "unmanaged", "unsafe-path"]) {
      const f = fixture();
      if (invalid === "worker") f.ctx.hasUI = false;
      if (invalid === "rpc") f.ctx.mode = "rpc";
      if (invalid === "pipe") f.deps.fd = () => ({ rdev: 42, isCharacterDevice: () => false });
      if (invalid === "tty") f.deps.fd = (fd) => ({ rdev: fd === 0 ? 42 : 43, isCharacterDevice: () => true });
      if (invalid === "test") f.deps.env.NODE_ENV = "test";
      if (invalid === "mirror") f.deps.env.PI_MIRROR = "1";
      if (invalid === "unmanaged") delete f.deps.env.ULTRATERM_SLOT;
      if (invalid === "unsafe-path") f.setPathValid(false);
      const p = f.make(); await p.start(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      expect(f.calls.some((args) => args[0] === "set-option")).toBe(false);
      await p.stop();
    }
  });
  it("reserves one owner and rotates only at explicit lifecycle boundaries", async () => {
    const f = fixture(); const p = f.make();
    await p.start(f.ctx);
    const host = getPrimaryHostIdentity(f.ctx.sessionManager)!;
    expect(host).toMatchObject({ version: 1, pid: 55, sessionId: "session" });
    expect(Object.isFrozen(host)).toBe(true);
    await p.retry(f.ctx);
    expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBe(host);
    const child = fixture(); const other = child.make(); await other.start(child.ctx);
    expect(getPrimaryHostIdentity(child.ctx.sessionManager)).toBeUndefined();
    await other.stop();
    await p.start(f.ctx);
    expect(getPrimaryHostIdentity(f.ctx.sessionManager)?.generation).not.toBe(host.generation);
    const generation = getPrimaryHostIdentity(f.ctx.sessionManager)?.generation;
    await p.stop(true); const reloaded = f.make(); await reloaded.start(f.ctx, true);
    expect(getPrimaryHostIdentity(f.ctx.sessionManager)?.generation).toBe(generation);
    await reloaded.stop();
    expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
    const cleanup = f.calls.find((args) => args[0] === "if-shell")!;
    expect(cleanup[4]).toContain("@pi-primary-host");
    expect(cleanup[4]).toContain(host.generation);
  });
  it.each(["exit", "throw"])("retries a failed mapping write (%s) before completing publication", async (failure) => {
    const f = fixture();
    let failMapping = true;
    const p = createPrimaryHostPublisher(async (command, args) => {
      const result = await f.exec(command, args);
      if (args[0] === "set-option" && args[4] === "@pi-session-file" && failMapping) {
        failMapping = false;
        if (failure === "throw") throw new Error("mapping write failed");
        return { code: 1, stdout: "" };
      }
      return result;
    }, () => {}, f.deps);
    try {
      await p.start(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      const descriptor = f.calls.find(args => args[4] === "@pi-primary-host")![5];
      await p.retry(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toEqual(JSON.parse(descriptor));
      expect(f.calls.filter(args => args[4] === "@pi-primary-host").map(args => args[5])).toEqual([descriptor, descriptor]);
      expect(f.calls.filter(args => args[4] === "@pi-session-file")).toHaveLength(2);
      const count = f.calls.length;
      await p.retry(f.ctx);
      expect(f.calls).toHaveLength(count);
    } finally { await p.stop(); }
  });
  it("cleans a partial binding conditionally and cannot overwrite its replacement", async () => {
    const f = fixture();
    const p = createPrimaryHostPublisher(async (command, args) => {
      const result = await f.exec(command, args);
      return args[0] === "set-option" && args[4] === "@pi-session-file" ? { code: 1, stdout: "" } : result;
    }, () => {}, f.deps);
    const replacement = f.make();
    try {
      await p.start(f.ctx);
      const partial = JSON.parse(f.calls.find(args => args[4] === "@pi-primary-host")![5]);
      await replacement.start(f.ctx);
      expect(f.calls.filter(args => args[4] === "@pi-primary-host")).toHaveLength(1);
      await p.stop();
      const cleanup = f.calls.find(args => args[0] === "if-shell")!;
      expect(cleanup[4]).toContain(partial.generation);
      expect(cleanup[5]).toContain("@pi-primary-host");
      expect(cleanup[5]).toContain("@pi-session-file");
      await replacement.start(f.ctx);
      const host = getPrimaryHostIdentity(f.ctx.sessionManager)!;
      expect(host.generation).not.toBe(partial.generation);
      const count = f.calls.length;
      await p.retry(f.ctx);
      await p.stop();
      expect(f.calls).toHaveLength(count);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBe(host);
    } finally { await p.stop(); await replacement.stop(); }
  });
  it("publishes a scoped intended SDK path without fabricating history", async () => {
    const root = realpathSync(mkdtempSync("/tmp/steak-primary-proof-"));
    const f = fixture(); const file = join(root, "session.jsonl");
    f.ctx.sessionManager.getSessionFile = () => file;
    f.deps.sessionPath = path => isCanonicalSessionPath(path, root);
    const p = f.make();
    try {
      expect(existsSync(file)).toBe(false);
      await p.start(f.ctx);
      expect(f.entries).toEqual([]);
      expect(existsSync(file)).toBe(false);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)?.generation).toBe("generation-1");
      writeFileSync(file, '{"type":"session","id":"session"}\n', { mode: 0o600 });
      await p.retry(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)?.generation).toBe("generation-1");
    } finally { await p.stop(); rmSync(root, { recursive: true, force: true }); }
  });
  it("rejects unsafe intended paths and symlink or writable parents", () => {
    const root = realpathSync(mkdtempSync("/tmp/steak-primary-path-"));
    try {
      const directory = join(root, "cwd"); mkdirSync(directory, { mode: 0o700 });
      const file = join(directory, "new.jsonl");
      expect(isCanonicalSessionPath(file, root)).toBe(true);
      expect(isCanonicalSessionPath(join(root, "missing", "new.jsonl"), root)).toBe(false);
      expect(isCanonicalSessionPath(join(root, "..", "outside.jsonl"), root)).toBe(false);
      chmodSync(directory, 0o777);
      expect(isCanonicalSessionPath(file, root)).toBe(false);
      chmodSync(directory, 0o700);
      symlinkSync(join(root, "nonexistent"), file);
      expect(isCanonicalSessionPath(file, root)).toBe(false);
      rmSync(file); symlinkSync(directory, join(root, "alias"));
      expect(isCanonicalSessionPath(join(root, "alias", "new.jsonl"), root)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

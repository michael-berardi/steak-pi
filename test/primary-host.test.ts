import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, rmSync, existsSync, chmodSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { canonicalSessionPath, createPrimaryHostPublisher, getPrimaryHostIdentity, isCanonicalSessionPath,
  isProvenSessionFile, osAccountHome, provenCanonicalSessionFile, registeredSessionRoot, registeredSessionRoots,
  type HostDependencies } from "../src/primary-host.ts";
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
/** Model tmux's conditional cleanup: compare the entire current tuple before
 * removing either option, including when another process has replaced it. */
function trackedPublisher(f: ReturnType<typeof fixture>) {
  const options = new Map<string, string>();
  const p = createPrimaryHostPublisher(async (command, args) => {
    if (args[0] === "display-message" && args[4] === "#{@pi-primary-host}") {
      f.calls.push(args);
      return { code: 0, stdout: `${options.get("@pi-primary-host") ?? ""}\n` };
    }
    const result = await f.exec(command, args);
    if (args[0] === "set-option") options.set(args[4], args[5]);
    if (args[0] === "if-shell") {
      const tuple = options.get("@pi-primary-host");
      const literal = tuple?.replaceAll("#", "##").replaceAll(",", "#,").replaceAll("}", "#}");
      if (tuple !== undefined && args[4] === `#{==:#{@pi-primary-host},${literal}}`) {
        options.delete("@pi-primary-host");
        options.delete("@pi-session-file");
      }
    }
    return result;
  }, () => {}, f.deps);
  return { p, options };
}
const LEGACY_AGENT_DIR = [".pi", "agent"] as const;
const PROJECTION_AGENT_DIRS = [
  [".ultraterm", "provider-accounts", "opencode-go", "primary", "agent"],
  [".ultraterm", "provider-accounts", "opencode-go", "b", "agent"],
  [".ultraterm", "provider-accounts", "codex", "primary", "agent"],
  [".ultraterm", "provider-accounts", "codex", "fallback", "agent"],
] as const;

/** A fixture account home that stands in for the OS account home. */
function accountHome() {
  const dir = realpathSync(mkdtempSync("/tmp/steak-primary-home-"));
  return { dir, roots: registeredSessionRoots({ uid: process.getuid?.() ?? 0, homedir: dir }) };
}
/** A session file where Pi really puts one: `<agent dir>/sessions/--<cwd>--`. */
function sessionFile(dir: string, parts: readonly string[], name = "session") {
  const directory = join(dir, ...parts, "sessions", "--tmp-work--");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { file: join(directory, `${name}.jsonl`), header: (id: string) => JSON.stringify({ type: "session", id }) + "\n" };
}
function projectPublisher(home: { dir: string; roots: string[] }, parts: readonly string[]) {
  const session = sessionFile(home.dir, parts);
  const f = publishedFor(home, session.file);
  f.ctx.sessionManager.getSessionId = () => "session";
  return { ...f, session };
}
/** A publisher whose manager reports `file`: both seams are the real proofs, over
 * the fixture account home, so a catalogued alias is judged as the alias it is. */
function publishedFor(home: { dir: string; roots: string[] }, file: string) {
  const f = fixture();
  f.ctx.sessionManager.getSessionFile = () => file;
  f.deps.sessionPath = (path, id) => isProvenSessionFile(path, id, home.roots, home.dir);
  f.deps.canonicalFilePath = (path, id) => provenCanonicalSessionFile(path, id, home.roots, home.dir);
  return f;
}
/** The account router's shared-root projection: a catalogued Codex agent
 * directory whose `sessions` entry is an account-owned symlink to the canonical
 * shared `.pi/agent/sessions` root, so the SDK reports the ALIASED path for a
 * session that physically lives in the canonical root. */
function aliasProjection(home: { dir: string; roots: string[] }, parts: readonly string[]) {
  const canonical = sessionFile(home.dir, LEGACY_AGENT_DIR);
  const canonicalRoot = join(home.dir, ...LEGACY_AGENT_DIR, "sessions");
  const aliasRoot = join(home.dir, ...parts, "sessions");
  mkdirSync(dirname(aliasRoot), { recursive: true, mode: 0o700 });
  symlinkSync(canonicalRoot, aliasRoot, "dir");
  return { canonicalFile: canonical.file, canonicalRoot, aliasRoot,
    file: join(aliasRoot, "--tmp-work--", "session.jsonl"), header: canonical.header };
}
describe("registered isolated roots", () => {
  it("accepts the legacy global root and every Go/Codex projection root, and only those", () => {
    const home = accountHome();
    try {
      for (const parts of [LEGACY_AGENT_DIR, ...PROJECTION_AGENT_DIRS]) {
        const { file, header } = sessionFile(home.dir, parts, "session");
        writeFileSync(file, header("session"), { mode: 0o600 });
        expect(isCanonicalSessionPath(file, home.roots)).toBe(true);
        expect(isProvenSessionFile(file, "session", home.roots)).toBe(true);
        expect(registeredSessionRoot(file, home.roots)).toBe(join(home.dir, ...parts, "sessions"));
        // A projection root is not reachable from the OS account's own root set.
        expect(isCanonicalSessionPath(file)).toBe(false);
        expect(isProvenSessionFile(file, "session")).toBe(false);
      }
      // Exactly the catalog, no family or sibling of it.
      for (const foreign of [[".claude", "agent"], ["elsewhere", "sessions"],
        [".ultraterm", "provider-accounts", "opencode-go", "primary"],
        [".ultraterm", "provider-accounts", "codex", "b", "agent"]]) {
        const { file, header } = sessionFile(home.dir, foreign, "session");
        writeFileSync(file, header("session"), { mode: 0o600 });
        expect(isCanonicalSessionPath(file, home.roots)).toBe(false);
        expect(registeredSessionRoot(file, home.roots)).toBeUndefined();
      }
      expect(home.roots).toHaveLength(5);
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it("refuses a symlinked, writable or escaped ancestor inside a registered root", () => {
    const home = accountHome();
    try {
      const parts = PROJECTION_AGENT_DIRS[3];
      const { file, header } = sessionFile(home.dir, parts, "session");
      writeFileSync(file, header("session"), { mode: 0o600 });
      expect(isProvenSessionFile(file, "session", home.roots)).toBe(true);
      const sessions = join(home.dir, ...parts, "sessions");
      chmodSync(sessions, 0o777);
      expect(isCanonicalSessionPath(file, home.roots)).toBe(false);
      chmodSync(sessions, 0o700);
      // A symlinked ancestor still spells a registered path but is not that path.
      const linked = join(home.dir, ...parts.slice(0, -1), "agent-link");
      symlinkSync(join(home.dir, ...parts), linked, "dir");
      expect(isCanonicalSessionPath(join(linked, "sessions", "--tmp-work--", "session.jsonl"), home.roots)).toBe(false);
      expect(isCanonicalSessionPath(join(home.dir, ...parts, "sessions", "--tmp-work--",
        "..", "..", "..", "..", "..", "outside.jsonl"), home.roots)).toBe(false);
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it("never takes a root from HOME or PI_CODING_AGENT_DIR", () => {
    const home = accountHome();
    try {
      const { file, header } = sessionFile(home.dir, LEGACY_AGENT_DIR, "session");
      writeFileSync(file, header("session"), { mode: 0o600 });
      vi.stubEnv("HOME", home.dir);
      vi.stubEnv("PI_CODING_AGENT_DIR", join(home.dir, ...LEGACY_AGENT_DIR));
      vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", join(home.dir, ...LEGACY_AGENT_DIR, "sessions"));
      try {
        expect(registeredSessionRoots().some((root) => root.startsWith(home.dir))).toBe(false);
        expect(registeredSessionRoots()).toContain(join(userInfo().homedir, ".pi", "agent", "sessions"));
        expect(registeredSessionRoot(file)).toBeUndefined();
        expect(isProvenSessionFile(file, "session")).toBe(false);
        expect(isCanonicalSessionPath(file)).toBe(false);
        // The OS account record is the only source, and it must belong to this uid.
        expect(osAccountHome()).toBe(userInfo().homedir);
        expect(osAccountHome({ uid: (process.getuid?.() ?? 0) + 1, homedir: home.dir })).toBeUndefined();
        expect(osAccountHome({ uid: process.getuid?.() ?? 0, homedir: "/" })).toBeUndefined();
        expect(registeredSessionRoots(null)).toEqual([]);
      } finally { vi.unstubAllEnvs(); }
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it("judges the file's own header, and only that header, against the actual session id", () => {
    const home = accountHome();
    try {
      const { file, header } = sessionFile(home.dir, PROJECTION_AGENT_DIRS[0], "real-session");
      writeFileSync(file, header("real-session"), { mode: 0o600 });
      expect(isProvenSessionFile(file, "real-session", home.roots)).toBe(true);
      // A declared id that the file does not carry is not this conversation.
      expect(isProvenSessionFile(file, "other-session", home.roots)).toBe(false);
      // "absent" is a valid complete header id, not a missing-header marker.
      writeFileSync(file, header("absent"), { mode: 0o600 });
      expect(isProvenSessionFile(file, "absent", home.roots)).toBe(true);
      expect(provenCanonicalSessionFile(file, "absent", home.roots)).toBe(file);
      expect(isProvenSessionFile(file, "other-session", home.roots)).toBe(false);
      expect(provenCanonicalSessionFile(file, "other-session", home.roots)).toBeUndefined();
      // A caller-supplied label, an empty id or a path-shaped id is never an id.
      for (const id of ["", "session title", "../real-session", "x".repeat(129)]) {
        expect(isProvenSessionFile(file, id, home.roots)).toBe(false);
      }
      // Pi buffers a new session: no complete first line to judge yet is tolerated.
      const pending = join(home.dir, ...PROJECTION_AGENT_DIRS[0], "sessions", "--tmp-work--", "later.jsonl");
      expect(isProvenSessionFile(pending, "later", home.roots)).toBe(true);
      writeFileSync(pending, "{\"type\":\"session\",\"id\":\"lat", { mode: 0o600 });
      expect(isProvenSessionFile(pending, "later", home.roots)).toBe(true);
      // A full admission buffer without a newline is oversized, not provisional.
      writeFileSync(pending, "x".repeat(64 * 1024), { mode: 0o600 });
      expect(isProvenSessionFile(pending, "later", home.roots)).toBe(false);
      writeFileSync(pending, JSON.stringify({ type: "session", id: "other", padding: "x".repeat(64 * 1024) }) + "\n", { mode: 0o600 });
      expect(provenCanonicalSessionFile(pending, "later", home.roots)).toBeUndefined();
      // An existing, complete header that is not a session header is refused.
      writeFileSync(pending, "not json\n", { mode: 0o600 });
      expect(isProvenSessionFile(pending, "later", home.roots)).toBe(false);
      writeFileSync(pending, header("later").replace("session", "label"), { mode: 0o600 });
      expect(isProvenSessionFile(pending, "later", home.roots)).toBe(false);
      // Another user could rewrite a group- or other-writable file.
      writeFileSync(pending, header("later"), { mode: 0o600 });
      chmodSync(pending, 0o666);
      expect(isProvenSessionFile(pending, "later", home.roots)).toBe(false);
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it("publishes an isolated projection session, and refuses a forged header or a stale id", async () => {
    const home = accountHome();
    try {
      const f = projectPublisher(home, PROJECTION_AGENT_DIRS[2]);
      const p = f.make();
      try {
        await p.start(f.ctx);
        expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toMatchObject({ sessionId: "session", sessionFile: f.session.file });
        expect(f.calls.find((args) => args[4] === "@pi-primary-host")![5]).toContain(f.session.file);
      } finally { await p.stop(); }
      // The same path with someone else's header never becomes this conversation.
      const forged = projectPublisher(home, PROJECTION_AGENT_DIRS[2]);
      writeFileSync(forged.session.file, forged.session.header("someone-else"), { mode: 0o600 });
      const rejected = forged.make();
      try {
        await rejected.start(forged.ctx);
        expect(getPrimaryHostIdentity(forged.ctx.sessionManager)).toBeUndefined();
        expect(forged.calls.some((args) => args[0] === "set-option")).toBe(false);
      } finally { await rejected.stop(); }
      // A session switch to a file outside the catalog is never published.
      const switched = projectPublisher(home, PROJECTION_AGENT_DIRS[2]);
      writeFileSync(switched.session.file, switched.session.header("session"), { mode: 0o600 });
      const switching = switched.make();
      try {
        switched.ctx.sessionManager.getSessionFile = () => join(home.dir, "elsewhere", "session.jsonl");
        await switching.start(switched.ctx);
        expect(getPrimaryHostIdentity(switched.ctx.sessionManager)).toBeUndefined();
      } finally { await switching.stop(); }
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it("refuses a delegated child and a process that is not the pane's own root", async () => {
    const home = accountHome();
    try {
      for (const marker of ["PI_WORKER", "PI_MIRROR", "ULTRATERM_MIRROR"]) {
        const child = projectPublisher(home, PROJECTION_AGENT_DIRS[1]);
        writeFileSync(child.session.file, child.session.header("session"), { mode: 0o600 });
        child.deps.env[marker] = "1";
        const p = child.make();
        await p.start(child.ctx);
        expect(getPrimaryHostIdentity(child.ctx.sessionManager)).toBeUndefined();
        expect(child.calls).toEqual([]);
        await p.stop();
      }
      // Claude Code markers also leak into every pane of a tmux server first started
      // from a Claude Code session, so they only refuse a process that is not the
      // pane's own root: unreported, or another, root is refused; the root publishes.
      for (const marker of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION"]) {
        for (const root of ["", "400", "55"]) {
          const child = projectPublisher(home, PROJECTION_AGENT_DIRS[1]);
          writeFileSync(child.session.file, child.session.header("session"), { mode: 0o600 });
          child.deps.env[marker] = "1";
          child.deps.parentOf = () => 400;
          const p = createPrimaryHostPublisher(async (_command, args) => {
            child.calls.push(args);
            return { code: 0, stdout: args[0] === "display-message" ? `/dev/ttys001\t${root}\n` : "" };
          }, () => {}, child.deps);
          try {
            await p.start(child.ctx);
            if (root === "55") expect(getPrimaryHostIdentity(child.ctx.sessionManager)).toBeDefined();
            else expect(getPrimaryHostIdentity(child.ctx.sessionManager)).toBeUndefined();
            expect(child.calls.some((args) => args[0] === "set-option")).toBe(root === "55");
          } finally { await p.stop(); }
        }
      }
      // tmux reports the pane's process root: only it, or a descendant, may publish.
      const pane = projectPublisher(home, PROJECTION_AGENT_DIRS[1]);
      writeFileSync(pane.session.file, pane.session.header("session"), { mode: 0o600 });
      const reported = { 55: 400, 56: 900 } as Record<number, number>;
      const withRoot = (deps: HostDependencies) => createPrimaryHostPublisher(
        async (_command, args) => ({ code: 0, stdout: args[0] === "display-message" ? "/dev/ttys001\t400\n" : "" }), () => {}, deps);
      pane.deps.parentOf = (pid) => reported[pid];
      const published = withRoot(pane.deps);
      try {
        await published.start(pane.ctx);
        expect(getPrimaryHostIdentity(pane.ctx.sessionManager)).toBeDefined();
      } finally { await published.stop(); }
      expect(getPrimaryHostIdentity(pane.ctx.sessionManager)).toBeUndefined();
      // A child that merely inherited the pane environment never reaches the root.
      const child = projectPublisher(home, PROJECTION_AGENT_DIRS[1]);
      writeFileSync(child.session.file, child.session.header("session"), { mode: 0o600 });
      let hops = 0;
      child.deps.parentOf = () => (++hops < 8 ? 901 : 1);
      const refused = withRoot(child.deps);
      try {
        await refused.start(child.ctx);
        expect(getPrimaryHostIdentity(child.ctx.sessionManager)).toBeUndefined();
      } finally { await refused.stop(); }
      // An unreported pane root (a tmux that cannot name it, or a test double)
      // skips only this extra layer: the tty and descriptor proof is still required.
      const unproven = projectPublisher(home, PROJECTION_AGENT_DIRS[1]);
      writeFileSync(unproven.session.file, unproven.session.header("session"), { mode: 0o600 });
      unproven.deps.parentOf = () => { throw new Error("must not be consulted"); };
      const unnamed = unproven.make();
      try {
        await unnamed.start(unproven.ctx);
        expect(getPrimaryHostIdentity(unproven.ctx.sessionManager)).toBeDefined();
      } finally { await unnamed.stop(); }
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
});
describe("catalogued account root aliases", () => {
  it("projects a catalogued alias onto its canonical shared root and publishes the canonical file", async () => {
    const home = accountHome();
    try {
      const projection = aliasProjection(home, PROJECTION_AGENT_DIRS[3]);
      writeFileSync(projection.file, projection.header("session"), { mode: 0o600 });
      expect(isCanonicalSessionPath(projection.file, home.roots, home.dir)).toBe(true);
      expect(provenCanonicalSessionFile(projection.file, "session", home.roots, home.dir)).toBe(projection.canonicalFile);
      expect(isProvenSessionFile(projection.file, "session", home.roots, home.dir)).toBe(true);
      // The root a consumer is handed is the canonical one, never the link.
      expect(registeredSessionRoot(projection.file, home.roots, home.dir)).toBe(projection.canonicalRoot);
      // The catalog is anchored to the OS account home: a lookalike elsewhere is not it.
      expect(isCanonicalSessionPath(projection.file, home.roots)).toBe(false);
      expect(provenCanonicalSessionFile(projection.file, "session", home.roots)).toBeUndefined();
      // A declared id the shared file does not carry is not this conversation.
      expect(isProvenSessionFile(projection.file, "other-session", home.roots, home.dir)).toBe(false);
      const f = publishedFor(home, projection.file);
      const p = f.make();
      try {
        await p.start(f.ctx);
        expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toMatchObject({ sessionId: "session", sessionFile: projection.canonicalFile });
        const descriptor = f.calls.find((args) => args[4] === "@pi-primary-host")![5];
        expect(descriptor).toContain(projection.canonicalFile);
        expect(descriptor).not.toContain(projection.aliasRoot);
        expect(f.calls.find((args) => args[4] === "@pi-session-file")![5]).toBe(projection.canonicalFile);
      } finally { await p.stop(); }
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it("refuses a repointed, writable, escaping or nested alias", () => {
    const home = accountHome();
    try {
      const projection = aliasProjection(home, PROJECTION_AGENT_DIRS[3]);
      writeFileSync(projection.file, projection.header("session"), { mode: 0o600 });
      expect(isCanonicalSessionPath(projection.file, home.roots, home.dir)).toBe(true);
      // A repointed alias is not the catalogued one, even when it holds the same file.
      rmSync(projection.aliasRoot);
      const moved = join(home.dir, "moved");
      mkdirSync(join(moved, "--tmp-work--"), { recursive: true, mode: 0o700 });
      writeFileSync(join(moved, "--tmp-work--", "session.jsonl"), projection.header("session"), { mode: 0o600 });
      symlinkSync(moved, projection.aliasRoot, "dir");
      expect(canonicalSessionPath(projection.file, home.roots, home.dir)).toBeUndefined();
      expect(isProvenSessionFile(projection.file, "session", home.roots, home.dir)).toBe(false);
      rmSync(projection.aliasRoot);
      symlinkSync(projection.canonicalRoot, projection.aliasRoot, "dir");
      expect(isCanonicalSessionPath(projection.file, home.roots, home.dir)).toBe(true);
      // An alias behind a writable directory, and a writable target, are both refused.
      const account = join(home.dir, ".ultraterm");
      chmodSync(account, 0o770);
      expect(isCanonicalSessionPath(projection.file, home.roots, home.dir)).toBe(false);
      chmodSync(account, 0o700);
      chmodSync(projection.canonicalRoot, 0o777);
      expect(isCanonicalSessionPath(projection.file, home.roots, home.dir)).toBe(false);
      chmodSync(projection.canonicalRoot, 0o700);
      expect(isCanonicalSessionPath(projection.file, home.roots, home.dir)).toBe(true);
      // A nested link inside the alias reaches the same file but is not that path.
      const nested = join(projection.aliasRoot, "elsewhere");
      symlinkSync(projection.canonicalRoot, nested, "dir");
      expect(isCanonicalSessionPath(join(nested, "--tmp-work--", "session.jsonl"), home.roots, home.dir)).toBe(false);
      rmSync(nested);
      // An escape out of the alias, and a link at any unregistered root, are refused.
      expect(isCanonicalSessionPath(join(projection.aliasRoot, "..", "..", "..", "..", "..", "outside.jsonl"),
        home.roots, home.dir)).toBe(false);
      for (const foreign of [[".claude", "agent"], [".ultraterm", "provider-accounts", "codex", "b", "agent"]]) {
        const root = join(home.dir, ...foreign, "sessions");
        mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
        symlinkSync(projection.canonicalRoot, root, "dir");
        expect(isCanonicalSessionPath(join(root, "--tmp-work--", "session.jsonl"), home.roots, home.dir)).toBe(false);
      }
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it("refuses an indirect hop even when its endpoint is the exact catalogued target", () => {
    const home = accountHome();
    try {
      const projection = aliasProjection(home, PROJECTION_AGENT_DIRS[3]);
      writeFileSync(projection.file, projection.header("session"), { mode: 0o600 });
      expect(provenCanonicalSessionFile(projection.file, "session", home.roots, home.dir)).toBe(projection.canonicalFile);
      rmSync(projection.aliasRoot);
      const hopDirectory = join(home.dir, "unchecked");
      mkdirSync(hopDirectory, { mode: 0o700 });
      const hop = join(hopDirectory, "hop");
      symlinkSync(projection.canonicalRoot, hop, "dir");
      symlinkSync(hop, projection.aliasRoot, "dir");
      for (const mode of [0o700, 0o777]) {
        chmodSync(hopDirectory, mode);
        expect(realpathSync(projection.aliasRoot)).toBe(projection.canonicalRoot);
        expect(canonicalSessionPath(projection.file, home.roots, home.dir)).toBeUndefined();
        expect(provenCanonicalSessionFile(projection.file, "session", home.roots, home.dir)).toBeUndefined();
        expect(registeredSessionRoot(projection.file, home.roots, home.dir)).toBeUndefined();
      }
      // Restore the exact direct target: the same canonical file is accepted.
      rmSync(projection.aliasRoot);
      symlinkSync(projection.canonicalRoot, projection.aliasRoot, "dir");
      expect(provenCanonicalSessionFile(projection.file, "session", home.roots, home.dir)).toBe(projection.canonicalFile);
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it("publishes no alias tuple for a forged header, and revokes an old tuple for a repointed alias", async () => {
    const home = accountHome();
    try {
      const forged = aliasProjection(home, PROJECTION_AGENT_DIRS[3]);
      writeFileSync(forged.file, forged.header("someone-else"), { mode: 0o600 });
      const refusedPublisher = publishedFor(home, forged.file);
      const refused = refusedPublisher.make();
      try {
        await refused.start(refusedPublisher.ctx);
        expect(getPrimaryHostIdentity(refusedPublisher.ctx.sessionManager)).toBeUndefined();
        expect(refusedPublisher.calls.some((args) => args[0] === "set-option")).toBe(false);
      } finally { await refused.stop(); }
      const held = aliasProjection(home, PROJECTION_AGENT_DIRS[2]);
      writeFileSync(held.file, held.header("session"), { mode: 0o600 });
      const f = publishedFor(home, held.file);
      const { p, options } = trackedPublisher(f);
      try {
        await p.start(f.ctx);
        expect(getPrimaryHostIdentity(f.ctx.sessionManager)?.sessionFile).toBe(held.canonicalFile);
        // The alias is repointed under the live session: the published canonical
        // file is not the projection of the reported path any more, so the old
        // publication must be removed rather than merely never rewritten.
        rmSync(held.aliasRoot);
        const moved = join(home.dir, "moved");
        mkdirSync(join(moved, "--tmp-work--"), { recursive: true, mode: 0o700 });
        writeFileSync(join(moved, "--tmp-work--", "session.jsonl"), held.header("session"), { mode: 0o600 });
        symlinkSync(moved, held.aliasRoot, "dir");
        const written = f.calls.filter((args) => args[4] === "@pi-primary-host").length;
        await p.retry(f.ctx);
        expect(f.calls.filter((args) => args[4] === "@pi-primary-host")).toHaveLength(written);
        expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
        expect(options.has("@pi-primary-host")).toBe(false);
        expect(options.has("@pi-session-file")).toBe(false);
        expect(f.calls.filter((args) => args[0] === "if-shell")).toHaveLength(1);
      } finally { await p.stop(); }
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
});
describe("binding revalidation", () => {
  it.each([false, true])("revokes a changed header without clearing another process tuple (replacement=%s)", async (replacement) => {
    const home = accountHome();
    try {
      const projection = aliasProjection(home, PROJECTION_AGENT_DIRS[2]);
      writeFileSync(projection.file, projection.header("session"), { mode: 0o600 });
      const f = publishedFor(home, projection.file);
      const { p, options } = trackedPublisher(f);
      try {
        await p.start(f.ctx);
        const host = getPrimaryHostIdentity(f.ctx.sessionManager)!;
        expect(host).toBeDefined();
        const foreign = { ...host, pid: host.pid + 1, generation: "another-process", sessionFile: "/other/session.jsonl" };
        if (replacement) {
          options.set("@pi-primary-host", JSON.stringify(foreign));
          options.set("@pi-session-file", foreign.sessionFile);
        }
        // A complete "absent" header must revoke a different published id,
        // including through the catalogued alias, just like any other mismatch.
        writeFileSync(projection.canonicalFile, projection.header("absent"), { mode: 0o600 });
        await p.retry(f.ctx);
        expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
        if (replacement) {
          expect(options.get("@pi-primary-host")).toBe(JSON.stringify(foreign));
          expect(options.get("@pi-session-file")).toBe(foreign.sessionFile);
        } else {
          expect(options.size).toBe(0);
        }
        expect(f.calls.filter(args => args[0] === "if-shell")).toHaveLength(1);
        // Restoring the file never revives the revoked tuple. A later turn re-runs
        // the full start proof and publishes a NEW generation, but only into a
        // vacant pane: another process's tuple is never taken over.
        writeFileSync(projection.canonicalFile, projection.header("session"), { mode: 0o600 });
        await p.retry(f.ctx);
        if (replacement) {
          expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
          expect(options.get("@pi-primary-host")).toBe(JSON.stringify(foreign));
          // Revocation releases ownership, so an explicit lifecycle start can rebind.
          await p.start(f.ctx);
        }
        const rebound = getPrimaryHostIdentity(f.ctx.sessionManager);
        expect(rebound?.generation).toBeDefined();
        expect(rebound?.generation).not.toBe(host.generation);
        expect(options.get("@pi-primary-host")).toBe(JSON.stringify(rebound));
      } finally { await p.stop(); }
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it.each(["tty", "child", "pid", "alias-ancestor", "target-ancestor"])("revokes a completed binding when its %s proof changes", async (invalid) => {
    const home = accountHome();
    try {
      const projection = aliasProjection(home, PROJECTION_AGENT_DIRS[3]);
      writeFileSync(projection.file, projection.header("session"), { mode: 0o600 });
      const f = publishedFor(home, projection.file);
      if (invalid === "pid") {
        f.deps.parentOf = () => 400;
        f.exec = async (_command, args) => {
          f.calls.push(args);
          return { code: 0, stdout: args[0] === "display-message" ? "/dev/ttys001\t400\n" : "" };
        };
      }
      const { p, options } = trackedPublisher(f);
      try {
        await p.start(f.ctx);
        expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeDefined();
        if (invalid === "tty") f.deps.fd = () => ({ rdev: 43, isCharacterDevice: () => true });
        if (invalid === "child") f.deps.env.CLAUDECODE = "1";
        if (invalid === "pid") f.deps.parentOf = () => 1;
        if (invalid === "alias-ancestor") chmodSync(dirname(projection.aliasRoot), 0o777);
        if (invalid === "target-ancestor") chmodSync(dirname(projection.canonicalRoot), 0o777);
        await p.retry(f.ctx);
        expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
        expect(options.size).toBe(0);
      } finally { await p.stop(); }
    } finally { rmSync(home.dir, { recursive: true, force: true }); }
  });
  it("re-links a live pane after a transient proof failure instead of leaving it unlinked", async () => {
    const f = fixture();
    let failing = 0;
    const exec = f.exec;
    f.exec = async (command, args) => {
      // A 1 s tmux timeout under load reads as a failed pane proof.
      if (args[0] === "display-message" && args[4] === "#{pane_tty}\t#{pane_pid}" && failing > 0) {
        failing -= 1; f.calls.push(args); return { code: 1, stdout: "" };
      }
      return exec(command, args);
    };
    const { p, options } = trackedPublisher(f);
    try {
      await p.start(f.ctx);
      const first = getPrimaryHostIdentity(f.ctx.sessionManager)!;
      expect(first).toBeDefined();
      failing = 1;
      await p.retry(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      expect(options.size).toBe(0);
      await p.retry(f.ctx);
      const relinked = getPrimaryHostIdentity(f.ctx.sessionManager)!;
      expect(relinked.sessionId).toBe(first.sessionId);
      expect(relinked.generation).not.toBe(first.generation);
      expect(options.get("@pi-primary-host")).toBe(JSON.stringify(relinked));
      expect(options.get("@pi-session-file")).toBe(relinked.sessionFile);
      expect(f.entries).toEqual([]);
    } finally { await p.stop(); }
  });
  it("keeps a pane unlinked while its proof still fails, and never re-links after stop", async () => {
    const f = fixture();
    const { p, options } = trackedPublisher(f);
    try {
      f.setPathValid(false);
      await p.start(f.ctx);
      await p.retry(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      expect(options.size).toBe(0);
      f.setPathValid(true);
      await p.retry(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeDefined();
      await p.stop();
      expect(options.size).toBe(0);
      const count = f.calls.length;
      await p.retry(f.ctx);
      expect(f.calls).toHaveLength(count);
      expect(options.size).toBe(0);
    } finally { await p.stop(); }
  });
  it("revokes a partial publication when its source proof fails instead of retrying its writes", async () => {
    const f = fixture();
    const p = createPrimaryHostPublisher(async (command, args) => {
      const result = await f.exec(command, args);
      return args[0] === "set-option" && args[4] === "@pi-session-file" ? { code: 1, stdout: "" } : result;
    }, () => {}, f.deps);
    try {
      await p.start(f.ctx);
      expect(getPrimaryHostIdentity(f.ctx.sessionManager)).toBeUndefined();
      f.setPathValid(false);
      await p.retry(f.ctx);
      expect(f.calls.filter(args => args[0] === "set-option")).toHaveLength(2);
      expect(f.calls.filter(args => args[0] === "if-shell")).toHaveLength(1);
    } finally { await p.stop(); }
  });
});
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
      // A completed publication is freshly proved without rewriting its tuple.
      expect(f.calls.slice(count).map(args => args[0])).toEqual(["display-message"]);
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

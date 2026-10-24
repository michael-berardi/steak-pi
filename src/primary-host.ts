import { closeSync, constants, fstatSync, openSync, readSync, statSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * The agent directories this SDK serves native conversations for: Pi's own agent
 * directory and the provider-projection agent directories the account router
 * selects (Go 1, Go 2, Codex primary, Codex fallback).
 *
 * This catalog is the whole root set, deliberately. A session root is never
 * derived from `HOME` or from `PI_CODING_AGENT_DIR`: both are process input that a
 * wrapper, launcher or inherited child can restate, and a child that names its
 * parent's pane must not be able to point a native conversation at an arbitrary
 * directory by restating one of them.
 */
const REGISTERED_AGENT_DIRS: readonly (readonly string[])[] = [
  [".pi", "agent"],
  [".ultraterm", "provider-accounts", "opencode-go", "primary", "agent"],
  [".ultraterm", "provider-accounts", "opencode-go", "b", "agent"],
  [".ultraterm", "provider-accounts", "codex", "primary", "agent"],
  [".ultraterm", "provider-accounts", "codex", "fallback", "agent"],
];

/**
 * Catalogued session-root aliases: the ONE link the account router's shared-root
 * projection creates. A Codex projection keeps its own agent directory (its auth,
 * models and extensions) but shares the canonical session root, so its `sessions`
 * entry is an account-owned symlink to that root.
 *
 * This catalog, never the link's own text, is what permits an alias: the link is
 * a registered projection directory under the OS account home, it must resolve to
 * the catalogued target EXACTLY (a repointed link is refused), it must be owned by
 * this account, and both the link's own ancestors and the target chain must be
 * canonical owner-only directories. Nothing here is derived from `HOME`, an
 * environment value or a config file, and no other symlink, sibling directory or
 * nested link is ever accepted.
 */
const REGISTERED_ROOT_ALIASES: readonly { alias: readonly string[]; target: readonly string[] }[] = [
  { alias: [".ultraterm", "provider-accounts", "codex", "primary", "agent", "sessions"],
    target: [".pi", "agent", "sessions"] },
  { alias: [".ultraterm", "provider-accounts", "codex", "fallback", "agent", "sessions"],
    target: [".pi", "agent", "sessions"] },
];

export interface OsAccountIdentity { uid: number; homedir: string }

/** The home the OPERATING SYSTEM records for the account this process runs under:
 * the account database entry for this uid (`os.userInfo()`), never `HOME`. A home
 * the OS cannot name, or one that does not belong to this uid, names no root at
 * all rather than falling back to a restatable environment value. `osUser` is a
 * code-only seam for tests; no environment variable or config reaches it. */
export function osAccountHome(osUser?: OsAccountIdentity | null): string | undefined {
  let identity = osUser;
  if (identity === undefined) {
    try { const info = userInfo(); identity = { uid: info.uid, homedir: info.homedir }; }
    catch { return undefined; }
  }
  if (!identity || typeof identity.homedir !== "string") return undefined;
  const home = identity.homedir;
  if (!home.startsWith("/") || /^\/+$/.test(home)) return undefined;
  const uid = process.getuid?.();
  if (uid !== undefined && identity.uid !== uid) return undefined;
  return home;
}

/** Every registered session root: each known agent directory's own `sessions`
 * subdirectory under the OS account home, and nothing else. */
export function registeredSessionRoots(osUser?: OsAccountIdentity | null): string[] {
  const home = osAccountHome(osUser);
  if (home === undefined) return [];
  return REGISTERED_AGENT_DIRS.map((parts) => join(home, ...parts, "sessions"));
}

/** Every directory from `path` up to and including `home` is a real, owner-owned
 * directory nobody else can write, so no level of that chain can be swapped for a
 * link. Home itself is validated first: it must be a real directory of this
 * account. */
function isCanonicalChainTo(home: string, path: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    for (let current = path;; current = dirname(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022)
        || realpathSync(current) !== current) return false;
      if (current === home) return true;
      if (dirname(current) === current) return false;
    }
  } catch { return false; }
}

type RootAlias = { kind: "plain" } | { kind: "refused" } | { kind: "proven"; target: string };

/** How `root` itself must be read: as an ordinary directory, as the catalogued
 * alias's proven canonical target, or as a refusal. A catalogued alias path is
 * judged AS an alias and nothing else, so a link that is missing, dangling,
 * foreign-owned, repointed, or sitting in a writable directory is refused rather
 * than silently read as an ordinary path. */
function catalogueRootAlias(root: string, home: string | undefined): RootAlias {
  if (home === undefined) return { kind: "plain" };
  const entry = REGISTERED_ROOT_ALIASES.find((candidate) => join(home, ...candidate.alias) === root);
  if (entry === undefined) return { kind: "plain" };
  const uid = process.getuid?.();
  if (uid === undefined) return { kind: "refused" };
  try {
    const link = lstatSync(root);
    // A projection that materialized a real directory needs no alias at all.
    if (!link.isSymbolicLink()) return { kind: "plain" };
    const target = join(home, ...entry.target);
    // Require the direct, exact catalogued link text, not merely endpoint equality:
    // realpath alone would conceal an unchecked intermediate (possibly writable
    // or foreign-owned) hop that happens to lead to the approved target today.
    if (link.uid !== uid || readlinkSync(root) !== target) return { kind: "refused" };
    // Both sides of the link are canonical owner-only chains below the account home.
    if (!isCanonicalChainTo(home, dirname(root)) || !isCanonicalChainTo(home, target)) return { kind: "refused" };
    return { kind: "proven", target };
  } catch { return { kind: "refused" }; }
}

/** The canonical root and file one candidate root must be judged as: an ordinary
 * path unchanged, a catalogued alias projected onto its target, `undefined` when
 * that is not possible. A nested link inside the projection is NOT projected: it
 * is judged by the canonical walk, which refuses it. */
function projectSessionPath(file: string, candidate: string, home: string | undefined): { file: string; root: string } | undefined {
  const root = resolve(candidate);
  const alias = catalogueRootAlias(root, home);
  if (alias.kind === "refused") return undefined;
  if (alias.kind === "plain") return { file, root };
  const rel = relative(root, file);
  if (resolve(file) !== file || !rel || rel === ".." || rel.startsWith(".." + sep)) return undefined;
  return { file: join(alias.target, rel), root: alias.target };
}

/** Accept the SDK's intended file before persistence, never create it here.
 *
 * `root` is a single caller-owned root (as the bridge passes) or the registered
 * root set itself. Every ancestor from the file up to that root must be a real,
 * owner-owned directory nobody else can write that canonicalizes to itself, so a
 * symlinked or reshuffled path is never accepted. A catalogued account root alias
 * is allowed as the root's own link and is projected onto the canonical target it
 * must name; the CANONICAL file is returned, never the alias. `home` is a
 * code-only seam for tests, like {@link osAccountHome}'s `osUser`: no environment
 * variable, config or session input reaches it. */
export function canonicalSessionPath(file: string, root: string | readonly string[] = registeredSessionRoots(),
  home: string | undefined = osAccountHome()): string | undefined {
  for (const candidate of typeof root === "string" ? [root] : root) {
    const projected = projectSessionPath(file, candidate, home);
    if (projected !== undefined && insideCanonicalDirectory(projected.file, projected.root)) return projected.file;
  }
  return undefined;
}

export function isCanonicalSessionPath(file: string, root: string | readonly string[] = registeredSessionRoots(),
  home: string | undefined = osAccountHome()): boolean {
  return canonicalSessionPath(file, root, home) !== undefined;
}

function insideCanonicalDirectory(file: string, root: string): boolean {
  try {
    const rel = relative(root, file);
    if (resolve(file) !== file || !file.endsWith(".jsonl") || !rel || rel === ".." || rel.startsWith(".." + sep)) return false;
    const uid = process.getuid?.();
    if (uid === undefined) return false;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o022)) return false;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    for (let path = dirname(file);; path = dirname(path)) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) || realpathSync(path) !== path) return false;
      if (path === root) return true;
      if (dirname(path) === path) return false;
    }
  } catch { return false; }
}

/** The registered root that contains `file` as a canonical session file, answered
 * as the canonical directory it really is: a catalogued alias root answers with
 * the target it names, so no caller is handed a link it would then have to
 * follow. Callers that must open the file (the native inbox reader) resolve the
 * root here instead of naming one, so an isolated Go/Codex projection reads its
 * own root. */
export function registeredSessionRoot(file: string, roots: readonly string[] = registeredSessionRoots(),
  home: string | undefined = osAccountHome()): string | undefined {
  for (const candidate of roots) {
    const projected = projectSessionPath(file, candidate, home);
    if (projected !== undefined && insideCanonicalDirectory(projected.file, projected.root)) return projected.root;
  }
  return undefined;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEADER_BYTES = 64 * 1024;
const ABSENT_HEADER = Symbol("absent session header");

/** The actual session id this file's OWN canonical first header carries. `ABSENT_HEADER`
 * means there is no complete first line to judge yet: the final file is missing
 * (Pi buffers a new session before its first flush) or its first line is still
 * being written (Pi rewrites entry by entry). `undefined` means the file exists
 * with a first line that cannot be trusted, which is never the same thing. */
function headerSessionId(file: string): string | typeof ABSENT_HEADER | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o022 || (uid !== undefined && stat.uid !== uid)) return undefined;
    const bytes = Buffer.alloc(HEADER_BYTES);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, count).indexOf(10);
    if (end < 0) return count < HEADER_BYTES ? ABSENT_HEADER : undefined;
    const header = JSON.parse(bytes.subarray(0, end).toString("utf8")) as { type?: unknown; id?: unknown };
    return header?.type === "session" && typeof header.id === "string" && SESSION_ID.test(header.id) ? header.id : undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? ABSENT_HEADER : undefined;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** The whole source proof for one native conversation: a registered root, a
 * canonical owner-only ancestor chain with no symlink, and the file's OWN
 * canonical session header carrying the ACTUAL session id. A catalogued account
 * root alias is projected onto the canonical target it must name, so the caller
 * receives the CANONICAL session file and never publishes or opens the alias.
 * Only the final file may still be missing (a session Pi has not persisted yet);
 * its parent directories are already proven by the walk above. A caller-supplied
 * id, a filename guess or a stale environment value therefore cannot name a
 * conversation. */
export function provenCanonicalSessionFile(file: string, sessionId: string,
  root: string | readonly string[] = registeredSessionRoots(),
  home: string | undefined = osAccountHome()): string | undefined {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return undefined;
  const canonical = canonicalSessionPath(file, root, home);
  if (canonical === undefined) return undefined;
  const header = headerSessionId(canonical);
  return header === ABSENT_HEADER || header === sessionId ? canonical : undefined;
}

export function isProvenSessionFile(file: string, sessionId: string,
  root: string | readonly string[] = registeredSessionRoots(),
  home: string | undefined = osAccountHome()): boolean {
  return provenCanonicalSessionFile(file, sessionId, root, home) !== undefined;
}

export interface PrimaryHostIdentity {
  version: 1;
  pid: number;
  sessionId: string;
  sessionFile: string;
  generation: string;
}
interface RegistryState {
  version: 1;
  registry: WeakMap<object, PrimaryHostIdentity>;
  reloadIdentity: WeakMap<object, PrimaryHostIdentity>;
  owner?: object;
}
// Pi may evaluate a shared TS dependency separately for each extension. Keep
// ownership process-wide across those loader copies, keyed by the real manager.
const registryKey = Symbol.for("steak-pi.primary-host.v1");
const globals = globalThis as unknown as Record<symbol, RegistryState | undefined>;
const state = globals[registryKey] ??= { version: 1, registry: new WeakMap(), reloadIdentity: new WeakMap() };
if (state.version !== 1 || !(state.registry instanceof WeakMap) || !(state.reloadIdentity instanceof WeakMap)) {
  throw new Error("Incompatible primary host registry");
}
const { registry, reloadIdentity } = state;
export function getPrimaryHostIdentity(sessionManager: object): PrimaryHostIdentity | undefined {
  return registry.get(sessionManager);
}
interface Device { rdev: number; isCharacterDevice(): boolean }
/**
 * A delegated headless child (a USAP/SDK worker, an agent mirror, a Claude Code
 * process) inherits its parent's pane variables but owns no pane of its own, so it
 * must never publish the tuple that names the parent's conversation.
 *
 * The worker/mirror markers are scrubbed from every managed launch, so their
 * presence always means a delegated child. The Claude Code markers are different:
 * a tmux server first started from a Claude Code session keeps them in its GLOBAL
 * environment, so every pane it spawns afterwards inherits them, including a
 * primary Steak Pi that is the pane's own root process. They only disqualify a
 * process that is not that root ({@link isDelegatedPaneChild} `ownsPaneRoot`).
 */
const WORKER_MARKERS = ["PI_WORKER", "PI_MIRROR", "ULTRATERM_MIRROR"] as const;
const CLAUDE_MARKERS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_CHILD_SESSION"] as const;
export function isDelegatedPaneChild(env: NodeJS.ProcessEnv = process.env, ownsPaneRoot = false): boolean {
  if (WORKER_MARKERS.some((name) => Boolean(env[name]))) return true;
  return !ownsPaneRoot && CLAUDE_MARKERS.some((name) => Boolean(env[name]));
}
export interface HostContext {
  mode: string;
  hasUI: boolean;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
}
export interface HostDependencies {
  env: NodeJS.ProcessEnv;
  pid: number;
  fd(fd: number): Device;
  stat(path: string): Device;
  /** The registered-root, canonical-ancestor and actual-header proof for the
   * ACTUAL session id ({@link isProvenSessionFile}), never a filename guess. */
  sessionPath(path: string, sessionId: string): boolean;
  /** The same proof, resolved to the CANONICAL session file the reported path
   * really names ({@link provenCanonicalSessionFile}): a catalogued account root
   * alias is projected onto its proven target, so a published identity never
   * names an alias. Absent only for callers that inject `sessionPath` alone. */
  canonicalFilePath?(path: string, sessionId: string): string | undefined;
  uuid(): string;
  /** Direct parent of a live process, or undefined when the OS cannot answer. A
   * publisher uses it to prove it is the pane's own process root or a descendant
   * of it, so a child that inherited another pane's `TMUX_PANE` cannot publish
   * there. */
  parentOf?(pid: number): number | undefined;
}
/** Direct parent of `pid`, read from `ps` with a hard timeout. A refusal to answer
 * is `undefined`, which never counts as proof. */
function osParentOf(pid: number): number | undefined {
  try {
    const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
    const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return result.status === 0 && /^\d+$/.test(text) ? Number(text) : undefined;
  } catch { return undefined; }
}
export const primaryHostDependencies: HostDependencies = {
  env: process.env, pid: process.pid, fd: fstatSync, stat: statSync,
  sessionPath: isProvenSessionFile, canonicalFilePath: provenCanonicalSessionFile,
  uuid: randomUUID, parentOf: osParentOf,
};

/** The canonical file a live manager's reported path is published as. An injected
 * canonical seam is the whole answer: a refusal is never re-read as the reported
 * path. Callers that inject only `sessionPath` (test doubles) publish the proven
 * path as it stands. */
function publishedSessionFile(deps: HostDependencies, file: string, sessionId: string): string | undefined {
  if (deps.canonicalFilePath !== undefined) return deps.canonicalFilePath(file, sessionId);
  return deps.sessionPath(file, sessionId) ? file : undefined;
}
type Exec = (command: string, args: string[], options: { timeout: number }) => Promise<{ code: number; stdout: string }>;

/** Only an eligibility hint; descriptor/context proof is still mandatory. */
export function hasManagedTuiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^%\d+$/.test(env.TMUX_PANE ?? "") && /^[1-9]\d{0,7}$/.test(env.ULTRATERM_SLOT ?? "")
    && env.NODE_ENV !== "test" && !env.VITEST && !env.NODE_TEST_CONTEXT
    && !env.PI_WORKER && !env.PI_MIRROR && !env.ULTRATERM_MIRROR;
}

/** Publisher-only controller. Consumers only use the private registry getter. */
export function createPrimaryHostPublisher(exec: Exec, _appendEntry: (type: string, data: unknown) => void,
  deps: HostDependencies = primaryHostDependencies) {
  const token = {};
  // `reported` is the path the live manager itself names; `host.sessionFile` is the
  // canonical file that path projects to. Watching both is what keeps a repointed
  // alias from keeping an old tuple alive.
  let binding: { pane: string; manager: object; reported: string; host: PrimaryHostIdentity } | undefined;
  let pending: typeof binding;
  let stopped = false;
  let chain = Promise.resolve();
  const tmux = (args: string[]) => exec(deps.env.TMUX_BIN || "tmux", args, { timeout: 1000 });
  const enqueue = (fn: () => Promise<void>) => (chain = chain.then(fn).catch(() => {}));
  const ANCESTRY_HOPS = 8;
  async function descendsFromPaneRoot(rootPid: number): Promise<boolean> {
    let current = deps.pid;
    for (let hop = 0; hop < ANCESTRY_HOPS; hop++) {
      if (current === rootPid) return true;
      const parent = deps.parentOf?.(current);
      if (parent === undefined || !Number.isSafeInteger(parent) || parent <= 1) return false;
      current = parent;
    }
    return false;
  }
  async function prove(ctx: HostContext): Promise<string | undefined> {
    const pane = deps.env.TMUX_PANE;
    if (ctx.mode !== "tui" || ctx.hasUI !== true || !pane || !hasManagedTuiEnvironment(deps.env)) return;
    // A delegated child inherits its parent's pane environment without owning that
    // pane, so it is refused before any descriptor or tuple work is done. Claude Code
    // markers can also be inherited from the tmux server's global environment, so
    // they are judged below, once tmux has named the pane's process root.
    if (isDelegatedPaneChild(deps.env, true)) return;
    const claudeMarked = isDelegatedPaneChild(deps.env, false);
    // One call, exactly as the native pane proof does: the pane's terminal and its
    // process root, so the tty proof and the ancestry proof judge one snapshot.
    const result = await tmux(["display-message", "-p", "-t", pane, "#{pane_tty}\t#{pane_pid}"]);
    if (result.code !== 0) return;
    const [rawTty, rawRoot] = result.stdout.split("\t");
    const tty = (rawTty ?? "").trim();
    if (!tty.startsWith("/dev/") || /[\r\n]/.test(tty)) return;
    const device = deps.stat(tty);
    if (!device.isCharacterDevice()) return;
    for (const fd of [0, 1]) {
      const actual = deps.fd(fd);
      if (!actual.isCharacterDevice() || actual.rdev !== device.rdev) return;
    }
    // When tmux reports the pane's process root, this process must BE that root or
    // a descendant of it: a child that only inherited a pane variable is refused
    // rather than publishing another pane's conversation.
    const reported = (rawRoot ?? "").trim();
    // A Claude Code marker is only waived for the pane's own root process: a headless
    // child of Claude Code is always a descendant of the root, never the root itself.
    if (claudeMarked && !(/^\d+$/.test(reported) && Number(reported) === deps.pid)) return;
    if (reported.length > 0) {
      if (!/^\d+$/.test(reported) || Number(reported) <= 1 || !(await descendsFromPaneRoot(Number(reported)))) return;
    }
    return pane;
  }
  async function clear() {
    const old = binding;
    binding = undefined;
    if (!old) return;
    if (registry.get(old.manager) === old.host) registry.delete(old.manager);
    const value = JSON.stringify(old.host);
    // Both tests and mutations execute in one tmux command queue. Escape format
    // metacharacters so session paths cannot become tmux format expressions.
    const literal = (text: string) => text.replaceAll("#", "##").replaceAll(",", "#,").replaceAll("}", "#}");
    await tmux(["if-shell", "-F", "-t", old.pane,
      `#{==:#{@pi-primary-host},${literal(value)}}`,
      `set-option -pu -t ${old.pane} @pi-primary-host ; set-option -pu -t ${old.pane} @pi-session-file`, ""]);
  }
  async function stillProven(ctx: HostContext, next: NonNullable<typeof binding>): Promise<boolean> {
    try {
      return ctx.sessionManager === next.manager && ctx.sessionManager.getSessionId() === next.host.sessionId
        && ctx.sessionManager.getSessionFile() === next.reported && await prove(ctx) === next.pane
        && publishedSessionFile(deps, next.reported, next.host.sessionId) === next.host.sessionFile;
    } catch { return false; }
  }
  async function publish(ctx: HostContext) {
    if (state.owner !== token) return;
    const next = pending ?? binding;
    if (!next) return;
    // Successful publication is not permanent proof. Recheck the reported alias,
    // canonical chain, actual header, and pane on every retry, even with no writes
    // pending. A refusal revokes only our exact registry identity and tmux tuple.
    if (!await stillProven(ctx, next)) {
      pending = undefined;
      try { await clear(); } finally { if (state.owner === token) state.owner = undefined; }
      return;
    }
    if (!pending) return;
    const result = await tmux(["set-option", "-p", "-t", next.pane, "@pi-primary-host", JSON.stringify(next.host)]);
    if (result.code !== 0) return;
    // Retain the binding for ownership-checked cleanup even if the second
    // write fails, but keep publication pending until both options succeed.
    binding = next;
    const mapping = await tmux(["set-option", "-p", "-t", next.pane, "@pi-session-file", next.host.sessionFile]);
    if (mapping.code !== 0) return;
    pending = undefined;
    registry.set(next.manager, next.host);
  }
  async function establish(ctx: HostContext, reload: boolean) {
    if (state.owner && state.owner !== token) return;
    const pane = await prove(ctx);
    if (!pane || (state.owner && state.owner !== token)) return;
    if (state.owner === token) { await clear(); pending = undefined; }
    const file = ctx.sessionManager.getSessionFile();
    const sessionId = ctx.sessionManager.getSessionId();
    // The ACTUAL SDK identities, each proven before anything is published: the
    // root is registered (a catalogued account root alias is projected onto its
    // canonical target), the ancestors canonical, and the file's OWN header (as
    // soon as it exists) carries exactly this session id. The identity is
    // published with the CANONICAL session file, never the alias.
    if (!file || !file.startsWith("/") || /[\r\n\0]/.test(file) || typeof sessionId !== "string"
      || !SESSION_ID.test(sessionId)) return;
    const published = publishedSessionFile(deps, file, sessionId);
    if (published === undefined) return;
    state.owner = token;
    const previous = reload ? reloadIdentity.get(ctx.sessionManager) : undefined;
    reloadIdentity.delete(ctx.sessionManager);
    pending = { pane, manager: ctx.sessionManager, reported: file, host: Object.freeze({ version: 1, pid: deps.pid,
      sessionId, sessionFile: published, generation: previous?.sessionId === sessionId && previous.sessionFile === published ? previous.generation : deps.uuid() }) };
    // A genuine SDK session may buffer until its first assistant. Publish
    // the proven intended path; receipt ACK still requires real persistence.
    await publish(ctx);
  }
  return {
    start(ctx: HostContext, reload = false) { return enqueue(() => { stopped = false; return establish(ctx, reload); }); },
    // A revocation (or a start whose proof failed) releases ownership, and a live
    // pane must not stay unlinked for the rest of its life because one proof read
    // failed: under load a 1 s tmux or ps call times out and reads as a refusal
    // (2026-10-21: a working pane fell back to the read-only mirror for good).
    // Each later turn therefore re-runs the full start proof. Nothing revoked is
    // revived: a fresh proof publishes a new generation, and a proof that still
    // fails publishes nothing. A stopped session (shutdown or reload) is never
    // re-established here; only its own lifecycle start does that.
    retry(ctx: HostContext) { return enqueue(async () => {
      if (stopped || state.owner || pending || binding) { await publish(ctx); return; }
      // Never take a pane another process has published to since: only a vacant
      // pane is re-established.
      const pane = deps.env.TMUX_PANE;
      if (!pane) return;
      const current = await tmux(["display-message", "-p", "-t", pane, "#{@pi-primary-host}"]);
      if (current.code !== 0 || current.stdout.trim() !== "") return;
      await establish(ctx, false);
    }); },
    stop(reload = false) { return enqueue(async () => {
      stopped = true;
      const current = binding ?? pending;
      if (reload && current) reloadIdentity.set(current.manager, current.host);
      pending = undefined;
      try { await clear(); } finally { if (state.owner === token) state.owner = undefined; }
    }); },
  };
}

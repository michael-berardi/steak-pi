import { fstatSync, statSync, lstatSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/** Accept the SDK's intended file before persistence, never create it here. */
export function isCanonicalSessionPath(file: string, root = join(homedir(), ".pi/agent/sessions")): boolean {
  try {
    root = resolve(root);
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
  sessionPath(path: string): boolean;
  uuid(): string;
}
export const primaryHostDependencies: HostDependencies = {
  env: process.env, pid: process.pid, fd: fstatSync, stat: statSync,
  sessionPath: isCanonicalSessionPath, uuid: randomUUID,
};
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
  let binding: { pane: string; manager: object; host: PrimaryHostIdentity } | undefined;
  let pending: typeof binding;
  let chain = Promise.resolve();
  const tmux = (args: string[]) => exec(deps.env.TMUX_BIN || "tmux", args, { timeout: 1000 });
  const enqueue = (fn: () => Promise<void>) => (chain = chain.then(fn).catch(() => {}));
  async function prove(ctx: HostContext): Promise<string | undefined> {
    const pane = deps.env.TMUX_PANE;
    if (ctx.mode !== "tui" || ctx.hasUI !== true || !pane || !hasManagedTuiEnvironment(deps.env)) return;
    const result = await tmux(["display-message", "-p", "-t", pane, "#{pane_tty}"]);
    const tty = result.stdout.trim();
    if (result.code !== 0 || !tty.startsWith("/dev/") || /[\r\n]/.test(tty)) return;
    const device = deps.stat(tty);
    if (!device.isCharacterDevice()) return;
    for (const fd of [0, 1]) {
      const actual = deps.fd(fd);
      if (!actual.isCharacterDevice() || actual.rdev !== device.rdev) return;
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
  async function publish(ctx: HostContext) {
    if (!pending || state.owner !== token) return;
    const next = pending;
    if (ctx.sessionManager !== next.manager || ctx.sessionManager.getSessionId() !== next.host.sessionId
      || ctx.sessionManager.getSessionFile() !== next.host.sessionFile) return;
    if (await prove(ctx) !== next.pane || !deps.sessionPath(next.host.sessionFile)) return;
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
  return {
    start(ctx: HostContext, reload = false) { return enqueue(async () => {
      if (state.owner && state.owner !== token) return;
      const pane = await prove(ctx);
      if (!pane || (state.owner && state.owner !== token)) return;
      if (state.owner === token) { await clear(); pending = undefined; }
      const file = ctx.sessionManager.getSessionFile();
      const sessionId = ctx.sessionManager.getSessionId();
      if (!file || !file.startsWith("/") || /[\r\n\0]/.test(file) || !sessionId || !deps.sessionPath(file)) return;
      state.owner = token;
      const previous = reload ? reloadIdentity.get(ctx.sessionManager) : undefined;
      reloadIdentity.delete(ctx.sessionManager);
      pending = { pane, manager: ctx.sessionManager, host: Object.freeze({ version: 1, pid: deps.pid,
        sessionId, sessionFile: file, generation: previous?.sessionId === sessionId && previous.sessionFile === file ? previous.generation : deps.uuid() }) };
      // A genuine SDK session may buffer until its first assistant. Publish
      // the proven intended path; receipt ACK still requires real persistence.
      await publish(ctx);
    }); },
    retry(ctx: HostContext) { return enqueue(() => publish(ctx)); },
    stop(reload = false) { return enqueue(async () => {
      const current = binding ?? pending;
      if (reload && current) reloadIdentity.set(current.manager, current.host);
      pending = undefined;
      try { await clear(); } finally { if (state.owner === token) state.owner = undefined; }
    }); },
  };
}

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { providerAccountCommand, type AccountCommand } from "./provider-accounts.ts";

/** Any account id the router's claude-accounts.json registry defines (primary, b, team-2, ...). */
export type ClaudeAccountId = string;
export interface ClaudeAccountSelection {
  id: ClaudeAccountId;
  label: string;
  configMode: "default" | "explicit";
  configDir?: string;
}

const UNSAFE_SELECTION = "Unsafe Claude provider account selection";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// The router's own grammar for account ids and registry labels.
const ACCOUNT_ID = /^(?=.{1,24}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACCOUNT_LABEL = /^[A-Za-z0-9 ()._-]{1,24}$/;
const REGISTRY_MAX_BYTES = 64 * 1024;
// The two conventional accounts a router may confirm without an explicit eligibility verdict; any other
// (registry-defined, possibly lent or owner-reserved) account must be reported `eligible: true`.
const CONVENTIONAL_ACCOUNTS: readonly string[] = ["primary", "b"];

/** The router answered for an account it did not confirm as eligible (absent verdict, or `eligible: false`). */
export class ClaudeAccountEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAccountEligibilityError";
  }
}

/** Two registry accounts name one config folder: the later entry is refused rather than sharing an identity. */
export class ClaudeAccountFolderConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAccountFolderConflictError";
  }
}

export function isClaudeAccountId(value: unknown): value is ClaudeAccountId {
  return typeof value === "string" && ACCOUNT_ID.test(value);
}

export function assertClaudeAccountId(value: unknown): asserts value is ClaudeAccountId {
  if (!isClaudeAccountId(value)) throw new Error("Unknown Claude account ID");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isConfigPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024 && isAbsolute(value) && !CONTROL_CHARACTERS.test(value);
}

function assertConfigPath(value: unknown): asserts value is string {
  if (!isConfigPath(value)) throw new Error("Unsafe Claude config directory");
}

type DirState = { state: "ok" | "missing" } | { state: "unsafe"; why: string };

/** The router's folder judgement, below $HOME only: every component a real directory (no symlink) owned by this
 * user and closed to group/other writes; the last one must also show none of `leafMask`. Missing is not unsafe:
 * the router decides whether a folder that does not exist yet is an account. */
function dirState(path: string, home: string, leafMask: number): DirState {
  const uid = process.getuid?.();
  const unsafe = (why: string): DirState => ({ state: "unsafe", why });
  try {
    const anchor = statSync(home);
    if (!anchor.isDirectory() || (uid !== undefined && anchor.uid !== uid)) return unsafe("$HOME is not a directory owned by this user");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : unsafe("$HOME is unreadable");
  }
  const parts = path.slice(home.length + 1).split(sep);
  let current = home;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info: Stats;
    try { info = lstatSync(current); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "missing" } : unsafe(`${current} is unreadable`); }
    if (info.isSymbolicLink()) return unsafe(`${current} is a symlink`);
    if (!info.isDirectory()) return unsafe(`${current} is not a directory`);
    if (uid !== undefined && info.uid !== uid) return unsafe(`${current} is owned by another user`);
    if (info.mode & (index === parts.length - 1 ? leafMask : 0o022)) return unsafe(`${current} is too open`);
  }
  return { state: "ok" };
}

type Registry = { state: "absent" } | { state: "invalid"; why: string } | { state: "ok"; entries: unknown[] };

/** claude-accounts.json, read the way the router reads it: a small regular file reached through safe folders,
 * never through a symlink. Anything but a plain absence is "invalid" and fails closed. */
function readRegistry(home: string): Registry {
  const file = join(home, ".config", "ultraterm", "claude-accounts.json");
  const folder = dirState(dirname(file), home, 0o022);
  if (folder.state === "missing") return { state: "absent" };
  if (folder.state === "unsafe") return { state: "invalid", why: folder.why };
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "invalid", why: "claude-accounts.json is unreadable" }; }
  try {
    const info = fstatSync(fd);
    const uid = process.getuid?.();
    if (!info.isFile() || info.size > REGISTRY_MAX_BYTES || (uid !== undefined && info.uid !== uid) || info.mode & 0o022) {
      return { state: "invalid", why: "claude-accounts.json is not a small regular file owned by this user" };
    }
    const data: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return Array.isArray(data) ? { state: "ok", entries: data } : { state: "invalid", why: "claude-accounts.json is not a JSON list" };
  } catch { return { state: "invalid", why: "claude-accounts.json is not valid JSON" }; }
  finally { closeSync(fd); }
}

/** An absolute path under $HOME (a leading ~ expands), or undefined. */
function underHome(raw: unknown, home: string): string | undefined {
  const text = typeof raw === "string" ? raw.trim() : "";
  const expanded = text.startsWith("~/") ? join(home, text.slice(2)) : text;
  if (!isAbsolute(expanded)) return undefined;
  const path = resolve(expanded);
  return path.startsWith(home + sep) && isConfigPath(path) ? path : undefined;
}

interface AccountFolder { id: ClaudeAccountId; label: string; configDir: string }
interface AccountFolders { accounts: AccountFolder[]; refused: Map<ClaudeAccountId, string> }

/** One key per folder: macOS and Windows resolve paths that differ only in case or Unicode form to one directory. */
function folderKey(path: string): string {
  const normal = path.normalize("NFC");
  return process.platform === "darwin" || process.platform === "win32" ? normal.toLowerCase() : normal;
}

/** The accounts the router derives from claude-accounts.json, in its order: primary first (default ~/.claude), then
 * ~/.claude-b only while no registry exists, then each valid registry entry once. A label is the registry's own,
 * else "Claude N" by position. A non-primary entry whose folder an earlier account already claims (or that names
 * the default ~/.claude, which belongs to primary) is not an account: it lands in `refused` with the reason. */
function claudeAccountFolders(home: string, registry: Registry): AccountFolders {
  const defaultDir = join(home, ".claude");
  const accounts: Array<{ id: ClaudeAccountId; configDir: string; label?: string }> = [{ id: "primary", configDir: defaultDir }];
  const entries = registry.state === "ok" ? registry.entries.filter(record) : [];
  for (const item of entries) {
    const directory = isClaudeAccountId(item.id) && item.id === "primary" ? underHome(item.configDir, home) : undefined;
    if (directory) accounts[0].configDir = directory;
  }
  const claimed = new Map<string, ClaudeAccountId>([[folderKey(defaultDir), "primary"], [folderKey(accounts[0].configDir), "primary"]]);
  const refused = new Map<ClaudeAccountId, string>();
  const claim = (id: ClaudeAccountId, configDir: string, label?: string): void => {
    const owner = claimed.get(folderKey(configDir));
    if (owner !== undefined) {
      refused.set(id, `${configDir} is already claimed by account "${owner}"`);
      return;
    }
    claimed.set(folderKey(configDir), id);
    accounts.push({ id, configDir, ...(label !== undefined ? { label } : {}) });
  };
  if (registry.state === "absent") claim("b", join(home, ".claude-b"));
  for (const item of entries) {
    if (!isClaudeAccountId(item.id) || item.id === "primary") continue;
    const directory = underHome(item.configDir, home);
    if (directory === undefined || accounts.some(account => account.id === item.id) || refused.has(item.id)) continue;
    const label = typeof item.label === "string" ? item.label.trim() : "";
    claim(item.id, directory, ACCOUNT_LABEL.test(label) ? label : undefined);
  }
  return {
    accounts: accounts.map((account, index) => ({ id: account.id, configDir: account.configDir, label: account.label ?? `Claude ${index + 1}` })),
    refused,
  };
}

function accountSelection(id: ClaudeAccountId): ClaudeAccountSelection {
  assertClaudeAccountId(id);
  const home = resolve(homedir());
  const registry = readRegistry(home);
  const { accounts, refused } = claudeAccountFolders(home, registry);
  let folder = accounts.find(account => account.id === id);
  // A registry that does not list the conventional ids leaves them at their default folders; the router still decides.
  if (!folder && registry.state !== "invalid" && id === "b" && !refused.has("b")) {
    const owner = accounts.find(account => folderKey(account.configDir) === folderKey(join(home, ".claude-b")));
    if (owner) refused.set("b", `${owner.configDir} is already claimed by account "${owner.id}"`);
    else folder = { id, label: "Claude 2", configDir: join(home, ".claude-b") };
  }
  if (!folder && refused.has(id)) {
    throw new ClaudeAccountFolderConflictError(`Claude account "${id}" is refused: its config folder ${refused.get(id)}; give each account its own folder in claude-accounts.json`);
  }
  if (!folder) {
    throw new Error(registry.state === "invalid"
      ? `Claude account registry is unusable (${registry.why}); cannot resolve account "${id}"`
      : `Unknown Claude account ID "${id}": not defined in claude-accounts.json`);
  }
  assertConfigPath(folder.configDir);
  // Unset CLAUDE_CONFIG_DIR (default mode) is primary's alone: it can never name another account's identity.
  const configMode = id === "primary" && folder.configDir === join(home, ".claude") ? "default" : "explicit";
  const state = dirState(folder.configDir, home, configMode === "default" ? 0o022 : 0o077);
  if (state.state === "unsafe") throw new Error(`Claude account "${id}" config folder is unsafe (${state.why})`);
  return configMode === "default"
    ? { id, label: folder.label, configMode }
    : { id, label: folder.label, configMode, configDir: folder.configDir };
}

/** Grammar plus registry: the id is one the router's registry defines and its folder is safe. */
export function assertKnownClaudeAccount(value: unknown): asserts value is ClaudeAccountId {
  assertClaudeAccountId(value);
  accountSelection(value);
}

/** The router's own words for why an account is not selectable, bounded and single-line. */
function ineligibleReason(account: Record<string, unknown>): string {
  for (const field of [account.stateText, account.ineligibleReason, account.reason]) {
    const text = typeof field === "string" ? field.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ").trim().slice(0, 160) : "";
    if (text) return text;
  }
  return account.eligible !== undefined ? "the router reported it ineligible" : "the router did not report it eligible";
}

/** Read-only selection, never a reservation: no release or ambient fallback. */
export async function resolveClaudeAccount(
  id: ClaudeAccountId,
  command: AccountCommand = providerAccountCommand,
): Promise<ClaudeAccountSelection> {
  assertClaudeAccountId(id);
  const expected = accountSelection(id);
  const result: unknown = await command(["select", "--provider", "claude", "--account", id]);
  if (!record(result) || result.ok !== true || result.provider !== "claude" || !record(result.account)) {
    throw new Error(UNSAFE_SELECTION);
  }
  const account = result.account;
  const configDir = expected.configDir ?? join(resolve(homedir()), ".claude");
  if (account.id !== id || account.label !== expected.label || account.configDir !== configDir) throw new Error(UNSAFE_SELECTION);
  // An explicit eligible:false always refuses. Beyond the two conventional accounts the router must also say
  // eligible:true: an owner-reserved or lent account never launches on an absent or unknown verdict.
  if (account.eligible !== true && (account.eligible !== undefined || !CONVENTIONAL_ACCOUNTS.includes(id))) {
    throw new ClaudeAccountEligibilityError(`${UNSAFE_SELECTION}: Claude account "${id}" is not eligible (${ineligibleReason(account)}); nothing was launched`);
  }
  const env = account.launchEnv;
  if (!record(env)) throw new Error(UNSAFE_SELECTION);
  if (expected.configMode === "default") {
    if (!exactKeys(env, ["unset"]) || !Array.isArray(env.unset) || env.unset.length !== 1 ||
        env.unset[0] !== "CLAUDE_CONFIG_DIR") throw new Error(UNSAFE_SELECTION);
  } else {
    if (!exactKeys(env, ["set"]) || !record(env.set) || !exactKeys(env.set, ["CLAUDE_CONFIG_DIR"]) ||
        env.set.CLAUDE_CONFIG_DIR !== configDir) throw new Error(UNSAFE_SELECTION);
  }
  return expected;
}

/** Return a fresh child environment; never change the caller's env or process.env. */
export function applyClaudeAccountEnv(
  base: NodeJS.ProcessEnv,
  selection?: ClaudeAccountSelection,
): NodeJS.ProcessEnv {
  const env = { ...base };
  if (env.CLAUDE_CONFIG_DIR === "") delete env.CLAUDE_CONFIG_DIR;
  if (env.CLAUDE_CONFIG_DIR !== undefined) assertConfigPath(env.CLAUDE_CONFIG_DIR);
  if (env.ULTRATERM_PROVIDER_ACCOUNT !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(env.ULTRATERM_PROVIDER_ACCOUNT)) throw new Error("Unsafe inherited provider account label");
  if (selection === undefined) return env;

  // Revalidate even typed selections at the launch boundary.
  if (!record(selection)) throw new Error(UNSAFE_SELECTION);
  assertClaudeAccountId(selection.id);
  const expected = accountSelection(selection.id);
  if (selection.label !== expected.label || selection.configMode !== expected.configMode ||
      selection.configDir !== expected.configDir) throw new Error(UNSAFE_SELECTION);
  if (expected.configMode === "default") delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = expected.configDir;
  env.ULTRATERM_PROVIDER_ACCOUNT = selection.id;
  return env;
}

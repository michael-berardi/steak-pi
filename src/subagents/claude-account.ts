import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { providerAccountCommand, type AccountCommand } from "./provider-accounts.ts";

export type ClaudeAccountId = "primary" | "b";
export interface ClaudeAccountSelection {
  id: ClaudeAccountId;
  label: string;
  configMode: "default" | "explicit";
  configDir?: string;
}

const UNSAFE_SELECTION = "Unsafe Claude provider account selection";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export function assertClaudeAccountId(value: unknown): asserts value is ClaudeAccountId {
  if (value !== "primary" && value !== "b") throw new Error("Unknown Claude account ID");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function assertConfigPath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 1024 || !isAbsolute(value) || CONTROL_CHARACTERS.test(value)) {
    throw new Error("Unsafe Claude config directory");
  }
}

function canonicalConfigDir(id: ClaudeAccountId): string {
  const dir = join(homedir(), id === "primary" ? ".claude" : ".claude-b");
  assertConfigPath(dir);
  return dir;
}

function accountSelection(id: ClaudeAccountId): ClaudeAccountSelection {
  return id === "primary"
    ? { id, label: "Claude 1", configMode: "default" }
    : { id, label: "Claude 2", configMode: "explicit", configDir: canonicalConfigDir(id) };
}

/** Read-only selection, never a reservation: no release or ambient fallback. */
export async function resolveClaudeAccount(
  id: ClaudeAccountId,
  command: AccountCommand = providerAccountCommand,
): Promise<ClaudeAccountSelection> {
  assertClaudeAccountId(id);
  const result: unknown = await command(["select", "--provider", "claude", "--account", id]);
  if (!record(result) || result.ok !== true || result.provider !== "claude" || !record(result.account)) {
    throw new Error(UNSAFE_SELECTION);
  }
  const account = result.account;
  const expected = accountSelection(id);
  const configDir = canonicalConfigDir(id);
  if (account.id !== id || account.label !== expected.label || account.configDir !== configDir ||
      (Object.hasOwn(account, "eligible") && account.eligible !== true)) {
    throw new Error(UNSAFE_SELECTION);
  }
  const env = account.launchEnv;
  if (!record(env)) throw new Error(UNSAFE_SELECTION);
  if (id === "primary") {
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
  if (selection.id === "primary") delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = expected.configDir;
  env.ULTRATERM_PROVIDER_ACCOUNT = selection.id;
  return env;
}

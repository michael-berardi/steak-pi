import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderAccountRouterError,
  ProviderAccountUnavailableError,
  accountLimitSignal,
  claudeAccountConfigDir,
  codexAccountAgentDir,
  createProviderAccountRouter,
  pinnedAccountId,
  providerAccountRouterPath,
  runWithProviderAccount,
  type AccountSelection,
  type LeaseRenewal,
  type ProviderAccount,
  type ProviderAccountRouter,
  type RouterExec,
} from "../src/subagents/provider-accounts.ts";
import { removeDiscardedPiSession } from "../src/subagents/account-directories.ts";
import { removeClaudeWorkerSession } from "../src/subagents/claude-session.ts";
import { emptyUsage, sanitizeProviderAccountRef, type TaskRecord, type WorkerProgress, type WorkerResult } from "../src/subagents/types.ts";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "steak-accounts-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "run-acct-task-1", label: "leaf", task: "work", role: "worker", mayEdit: false, ownedPaths: [], allowBash: false,
    state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, ...overrides,
  };
}

const done: WorkerResult = { state: "done", output: "ok", turns: 1, usage: emptyUsage() };
/** 2026-10-09 16:00 UTC: 09:00 in Los Angeles (PDT), 12:00 in New York (EDT). */
const NOW = Date.UTC(2026, 9, 9, 16, 0, 0);
const NOW_S = NOW / 1000;

/** In-memory router: scripted selections, recorded calls. */
function fakeRouter(script: (call: number, request: { account?: string }) => AccountSelection) {
  const selects: Array<{ provider: string; account?: string; owner: string; existing?: boolean }> = [];
  const releases: string[] = [];
  const limits: Array<{ provider: string; account: string; resetAt?: number; reason: string }> = [];
  const renews: string[] = [];
  const renewal: { answer: LeaseRenewal } = { answer: "renewed" };
  const router: ProviderAccountRouter = {
    async select(request) { selects.push(request); return script(selects.length, request); },
    async renew(lease) { renews.push(lease); return renewal.answer; },
    async release(lease) { releases.push(lease); },
    async limit(request) { limits.push(request); },
  };
  return { router, selects, releases, limits, renews, renewal };
}

const claude2: ProviderAccount = { id: "b", label: "Claude 2", configDir: "/accounts/claude-b" };
const selected = (account: ProviderAccount, lease = "lease-1"): AccountSelection => ({ kind: "selected", account, lease });

describe("router CLI contract", () => {
  const exec = (stdout: string, calls: string[][] = []): RouterExec => async (_command, args) => { calls.push([...args]); return { stdout }; };

  it("asks for a reservation and returns canonical labels whatever the router printed", async () => {
    const calls: string[][] = [];
    const router = createProviderAccountRouter({ command: "/bin/router", exec: exec(JSON.stringify({
      ok: true, account: { id: "b", label: "Secondary!", configDir: "/accounts/claude-b" }, lease: "L-9",
    }), calls) });
    const outcome = await router.select({ provider: "claude", account: "b", owner: "steak-pi:12:run x:task/1" });
    expect(calls[0]).toEqual(["select", "--provider", "claude", "--account", "b", "--owner", "steak-pi:12:run_x:task_1", "--reserve"]);
    expect(outcome).toEqual({ kind: "selected", account: { id: "b", label: "Claude 2", configDir: "/accounts/claude-b" }, lease: "L-9" });
  });

  it("uses GPT labels for the Codex accounts and requires the secondary agent dir", async () => {
    const good = createProviderAccountRouter({ command: "/bin/router", exec: exec(JSON.stringify({ ok: true, account: { id: "fallback", agentDir: "/accounts/pi-fallback" } })) });
    expect(await good.select({ provider: "codex", owner: "o" })).toEqual({ kind: "selected", account: { id: "fallback", label: "GPT 2", agentDir: "/accounts/pi-fallback" } });
    const bad = createProviderAccountRouter({ command: "/bin/router", exec: exec(JSON.stringify({ ok: true, account: { id: "fallback" } })) });
    expect((await bad.select({ provider: "codex", owner: "o" })).kind).toBe("unavailable");
  });

  it("reports a queue answer as queued and everything else as unavailable (fail closed)", async () => {
    const queued = createProviderAccountRouter({ command: "/bin/router", exec: exec(JSON.stringify({ ok: false, queued: true, error: "usage unknown\nfor Claude 1" })) });
    expect(await queued.select({ provider: "claude", owner: "o" })).toEqual({ kind: "queued", error: "usage unknown for Claude 1" });
    for (const stdout of ["not json", "[]", JSON.stringify({ ok: false, error: "bad account" }), JSON.stringify({ ok: true }),
      JSON.stringify({ ok: true, account: { id: "Third", configDir: "/x" } }), JSON.stringify({ ok: true, account: { id: "a--b", configDir: "/x" } }),
      JSON.stringify({ ok: true, account: { id: "c".repeat(25), configDir: "/x" } }), JSON.stringify({ ok: true, account: { id: "third" } }),
      JSON.stringify({ ok: true, account: { id: "primary" }, lease: "has space" }),
      JSON.stringify({ ok: true, account: { id: "primary", configDir: "relative/dir" } })]) {
      const router = createProviderAccountRouter({ command: "/bin/router", exec: exec(stdout) });
      expect((await router.select({ provider: "claude", owner: "o" })).kind, stdout).toBe("unavailable");
    }
  });

  it("accepts any safe registered account ID, not a fixed pair, with its own directory", async () => {
    const claude = createProviderAccountRouter({ command: "/bin/router", exec: exec(JSON.stringify({ ok: true, account: { id: "team-3", label: "evil", configDir: "/home/u/.claude-3" }, lease: "L3" })) });
    expect(await claude.select({ provider: "claude", account: "team-3", owner: "o" })).toEqual({ kind: "selected", account: { id: "team-3", label: "Claude (team-3)", configDir: "/home/u/.claude-3" }, lease: "L3" });
    const labelled = createProviderAccountRouter({ command: "/bin/router", exec: exec(JSON.stringify({ ok: true, account: { id: "c", label: "Claude 3", configDir: "/home/u/.claude-c" } })) });
    expect(await labelled.select({ provider: "claude", owner: "o" })).toMatchObject({ kind: "selected", account: { id: "c", label: "Claude 3" } });
    const codex = createProviderAccountRouter({ command: "/bin/router", exec: exec(JSON.stringify({ ok: true, account: { id: "third", agentDir: "/home/u/.pi-3" } })) });
    expect(await codex.select({ provider: "codex", owner: "o" })).toMatchObject({ kind: "selected", account: { id: "third", label: "GPT (third)", agentDir: "/home/u/.pi-3" } });
  });

  it("treats a failed or relative router command as unavailable", async () => {
    const broken = createProviderAccountRouter({ command: "/bin/router", exec: async () => { throw new Error("spawn ENOENT"); } });
    expect(await broken.select({ provider: "claude", owner: "o" })).toMatchObject({ kind: "unavailable", error: "spawn ENOENT" });
    const relative = createProviderAccountRouter({ command: "ut-provider-accounts", exec: exec("{}") });
    expect((await relative.select({ provider: "claude", owner: "o" })).kind).toBe("unavailable");
  });

  it("sends release and limit with the documented flags", async () => {
    const calls: string[][] = [];
    const router = createProviderAccountRouter({ command: "/bin/router", exec: exec('{"ok":true}', calls) });
    await router.release("L-9");
    await router.limit({ provider: "codex", account: "primary", resetAt: 1_900_000_000.9, reason: "usage limit" });
    await router.limit({ provider: "claude", account: "b", reason: "usage limit" });
    expect(calls).toEqual([
      ["release", "--lease", "L-9"],
      ["limit", "--provider", "codex", "--account", "primary", "--reset-at", "1900000000", "--reason", "usage_limit"],
      ["limit", "--provider", "claude", "--account", "b", "--reason", "usage_limit"],
    ]);
  });

  it("names a failed release, limit or renew instead of swallowing it", async () => {
    const down = createProviderAccountRouter({ command: "/bin/router", exec: async () => { throw new Error("down\nnow"); } });
    await expect(down.release("L")).rejects.toMatchObject({ name: "Error", operation: "release", reason: "down now" });
    await expect(down.limit({ provider: "claude", account: "b", reason: "r" })).rejects.toBeInstanceOf(ProviderAccountRouterError);
    await expect(down.renew("L")).rejects.toMatchObject({ operation: "renew", reason: "down now" });
    const refusing = createProviderAccountRouter({ command: "/bin/router", exec: exec(JSON.stringify({ ok: false, error: "no such lease" })) });
    await expect(refusing.release("L")).rejects.toMatchObject({ operation: "release", reason: "no such lease" });
    await expect(refusing.limit({ provider: "claude", account: "b", reason: "r" })).rejects.toMatchObject({ operation: "limit", reason: "no such lease" });
    const garbled = createProviderAccountRouter({ command: "/bin/router", exec: exec("not json") });
    await expect(garbled.release("L")).rejects.toMatchObject({ reason: "router gave no usable answer" });
    await expect(garbled.renew("L")).rejects.toMatchObject({ reason: "router gave no usable answer" });
    const relative = createProviderAccountRouter({ command: "router", exec: exec("{}") });
    await expect(relative.limit({ provider: "claude", account: "b", reason: "r" })).rejects.toMatchObject({ reason: "router path must be absolute" });
  });

  it("passes the router only a minimal environment plus ULTRATERM_ variables", async () => {
    let seen: NodeJS.ProcessEnv = {};
    const router = createProviderAccountRouter({
      command: "/bin/router",
      env: { PATH: "/bin", HOME: "/h", ULTRATERM_STATE: "/s", ANTHROPIC_API_KEY: "secret", OPENAI_API_KEY: "secret" },
      exec: async (_c, _a, options) => { seen = options.env; return { stdout: '{"ok":true}' }; },
    });
    await router.release("L");
    expect(seen).toEqual({ PATH: "/bin", HOME: "/h", ULTRATERM_STATE: "/s" });
  });

  it("resolves the router from the override, then the installed script, else legacy", () => {
    const home = tempRoot();
    expect(providerAccountRouterPath({}, home)).toBeUndefined();
    mkdirSync(join(home, ".ultraterm", "bin"), { recursive: true });
    writeFileSync(join(home, ".ultraterm", "bin", "ut-provider-accounts"), "#!/bin/sh\n");
    expect(providerAccountRouterPath({}, home)).toBe(join(home, ".ultraterm", "bin", "ut-provider-accounts"));
    expect(providerAccountRouterPath({ ULTRATERM_ACCOUNT_ROUTER: " /tmp/fake-router " }, home)).toBe("/tmp/fake-router");
  });
});

describe("account pinning", () => {
  const ref = (provider: "claude" | "codex", id: string) => ({ provider, id, label: id });

  it("pins to the recorded account and never invents one for a fresh task", () => {
    expect(pinnedAccountId(task(), "claude")).toBeUndefined();
    expect(pinnedAccountId(task({ providerAccount: ref("claude", "b") }), "claude")).toBe("b");
    expect(pinnedAccountId(task({ providerAccount: ref("codex", "fallback") }), "codex")).toBe("fallback");
    expect(pinnedAccountId(task({ providerAccount: ref("claude", "team-3") }), "claude")).toBe("team-3");
  });

  it("treats history recorded before account balancing as the primary account", () => {
    expect(pinnedAccountId(task({ claudeSessionId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b" }), "claude")).toBe("primary");
    expect(pinnedAccountId(task({ sessionFile: "/x/session.jsonl" }), "codex")).toBe("primary");
    expect(pinnedAccountId(task({ sessionFile: "  " }), "codex")).toBeUndefined();
  });

  it("refuses an unrecognised or foreign pin instead of moving the history", () => {
    expect(() => pinnedAccountId(task({ providerAccount: ref("claude", "Evil") }), "claude")).toThrow(ProviderAccountUnavailableError);
    expect(() => pinnedAccountId(task({ providerAccount: ref("claude", "../b") }), "claude")).toThrow(/not moved/);
    expect(() => pinnedAccountId(task({ providerAccount: ref("codex", "primary") }), "claude")).toThrow(/not moved/);
  });

  it("sanitizes untrusted checkpoint data to canonical labels", () => {
    expect(sanitizeProviderAccountRef({ provider: "claude", id: "b", label: "evil", configDir: "/c/b" })).toEqual({ provider: "claude", id: "b", label: "Claude 2", configDir: "/c/b" });
    expect(sanitizeProviderAccountRef({ provider: "codex", id: "primary", configDir: "/c" })).toEqual({ provider: "codex", id: "primary", label: "GPT 1" });
    expect(sanitizeProviderAccountRef({ provider: "claude", id: "Constructor" })).toBeUndefined();
    expect(sanitizeProviderAccountRef({ provider: "claude", id: "a--b" })).toBeUndefined();
    expect(sanitizeProviderAccountRef({ provider: "claude", id: "c", label: "Claude 3" })).toEqual({ provider: "claude", id: "c", label: "Claude 3" });
    expect(sanitizeProviderAccountRef({ provider: "claude", id: "c", label: "evil" })).toEqual({ provider: "claude", id: "c", label: "Claude (c)" });
    expect(sanitizeProviderAccountRef({ provider: "claude", id: "b", configDir: "rel" })).toEqual({ provider: "claude", id: "b", label: "Claude 2" });
    expect(sanitizeProviderAccountRef("claude")).toBeUndefined();
  });
});

/** A private (0700) directory, the shape every secondary account directory must have. */
function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}
const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("account directories", () => {
  it("leaves the primary Claude account on the CLI's default directory, whatever its legacy mode, and never changes it", () => {
    const home = tempRoot();
    const legacy = join(home, ".claude");
    mkdirSync(legacy);
    chmodSync(legacy, 0o755);
    expect(claudeAccountConfigDir({ id: "primary", label: "Claude 1", configDir: legacy }, home)).toBeUndefined();
    expect(claudeAccountConfigDir({ id: "primary", label: "Claude 1" }, home)).toBeUndefined();
    expect(claudeAccountConfigDir(undefined, home)).toBeUndefined();
    expect(modeOf(legacy)).toBe(0o755);
  });

  it("binds a secondary Claude account to its own private directory and refuses a missing one", () => {
    const home = tempRoot();
    const dir = join(home, "claude-b");
    expect(() => claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir: dir }, home)).toThrow(/Claude 2 config directory is missing/);
    privateDir(dir);
    expect(claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir: dir }, home)).toBe(dir);
  });

  it("serves any number of registered accounts, each only through its own directory", () => {
    const home = tempRoot();
    for (const id of ["b", "team-3", "x9"]) {
      const dir = privateDir(join(home, ".config", `claude-${id}`));
      expect(claudeAccountConfigDir({ id, label: providerLabel(id), configDir: dir }, home), id).toBe(dir);
    }
  });

  it("refuses a secondary directory that is not private, writable by others above it, or not owned by the user", () => {
    const home = tempRoot();
    const dir = join(home, "claude-b");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    const account: ProviderAccount = { id: "b", label: "Claude 2", configDir: dir };
    expect(() => claudeAccountConfigDir(account, home)).toThrow(/must be private \(mode 0700\)/);
    chmodSync(dir, 0o770);
    expect(() => claudeAccountConfigDir(account, home)).toThrow(/must be private/);
    chmodSync(dir, 0o700);
    expect(claudeAccountConfigDir(account, home)).toBe(dir);
    // The mode is only checked, never repaired.
    chmodSync(dir, 0o750);
    expect(() => claudeAccountConfigDir(account, home)).toThrow(ProviderAccountUnavailableError);
    expect(modeOf(dir)).toBe(0o750);
    // A private directory below one that others can write could be swapped from under the worker.
    const shared = join(home, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const nested = privateDir(join(shared, "claude-b"));
    expect(() => claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir: nested }, home)).toThrow(/group or others can write/);
  });

  it("refuses a directory outside home, home itself and traversal out of it", () => {
    const home = privateDir(join(tempRoot(), "home"));
    const elsewhere = privateDir(join(tempRoot(), "claude-b"));
    for (const configDir of [elsewhere, home, join(home, "x", "..", "..", "claude-b"), "relative/dir"]) {
      expect(() => claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir }, home), configDir).toThrow(/outside the home directory|not an absolute path/);
    }
  });

  it("refuses a symlink anywhere on the way to a secondary directory", () => {
    const home = tempRoot();
    const real = privateDir(join(home, "real", "claude-b"));
    symlinkSync(real, join(home, "link-b"));
    symlinkSync(join(home, "real"), join(home, "link-parent"));
    for (const configDir of [join(home, "link-b"), join(home, "link-parent", "claude-b")]) {
      expect(() => claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir }, home), configDir).toThrow(/passes through a symlink/);
    }
    expect(claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir: real }, home)).toBe(real);
    // The home path itself may sit behind a link (macOS /var, a symlinked $HOME).
    const alias = join(tempRoot(), "home-link");
    symlinkSync(home, alias);
    expect(claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir: join(alias, "real", "claude-b") }, alias)).toBe(join(alias, "real", "claude-b"));
  });

  it("never lets a secondary account alias, reach into or replace ~/.claude", () => {
    const home = tempRoot();
    const legacy = join(home, ".claude");
    mkdirSync(legacy);
    mkdirSync(join(legacy, "b"), { mode: 0o700 });
    symlinkSync(legacy, join(home, "claude-b"));
    for (const configDir of [legacy, join(home, "claude-b"), join(legacy, "b"), `${legacy}/`]) {
      expect(() => claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir }, home), configDir).toThrow(ProviderAccountUnavailableError);
    }
    expect(() => claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir: legacy }, home)).toThrow(/cannot use the primary Claude config directory/);
    expect(() => claudeAccountConfigDir({ id: "b", label: "Claude 2", configDir: join(legacy, "b") }, home)).toThrow(/inside the primary Claude config directory/);
  });

  it("binds a secondary Codex account to its private agent dir and auth path without reading the credential", () => {
    const home = tempRoot();
    const defaultDir = join(home, ".pi", "agent");
    const agent = join(home, "pi-fallback");
    const account: ProviderAccount = { id: "fallback", label: "GPT 2", agentDir: agent };
    expect(() => codexAccountAgentDir(account, defaultDir, home)).toThrow(/GPT 2 agent directory is missing/);
    privateDir(agent);
    expect(() => codexAccountAgentDir(account, defaultDir, home)).toThrow(/no auth\.json/);
    writeFileSync(join(agent, "auth.json"), "{}");
    expect(codexAccountAgentDir(account, defaultDir, home)).toEqual({ agentDir: agent, authPath: join(agent, "auth.json") });
    chmodSync(agent, 0o755);
    expect(() => codexAccountAgentDir(account, defaultDir, home)).toThrow(/must be private/);
  });

  it("refuses a Codex auth.json that is a symlink, and a secondary agent dir that aliases Pi's default", () => {
    const home = tempRoot();
    const defaultDir = privateDir(join(home, ".pi", "agent"));
    const agent = privateDir(join(home, "pi-fallback"));
    writeFileSync(join(home, "elsewhere.json"), "{}");
    symlinkSync(join(home, "elsewhere.json"), join(agent, "auth.json"));
    const account: ProviderAccount = { id: "fallback", label: "GPT 2", agentDir: agent };
    expect(() => codexAccountAgentDir(account, defaultDir, home)).toThrow(/no auth\.json/);
    writeFileSync(join(defaultDir, "auth.json"), "{}");
    expect(() => codexAccountAgentDir({ id: "fallback", label: "GPT 2", agentDir: defaultDir }, defaultDir, home)).toThrow(/cannot use Pi's default agent directory/);
    expect(() => codexAccountAgentDir({ id: "fallback", label: "GPT 2", agentDir: join(defaultDir, "sub") }, defaultDir, home)).toThrow(/inside Pi's default agent directory/);
  });

  it("leaves the primary Codex account on Pi's default agent dir", () => {
    const home = tempRoot();
    const agent = join(home, ".pi", "agent");
    mkdirSync(agent, { recursive: true });
    chmodSync(agent, 0o755);
    expect(codexAccountAgentDir({ id: "primary", label: "GPT 1", agentDir: agent }, agent, home)).toBeUndefined();
    expect(codexAccountAgentDir({ id: "primary", label: "GPT 1" }, agent, home)).toBeUndefined();
    expect(modeOf(agent)).toBe(0o755);
  });
});

const providerLabel = (id: string): string => (id === "b" ? "Claude 2" : `Claude (${id})`);

describe("transcript cleanup follows only validated account directories", () => {
  const sessionId = "0b5e1c2a-1111-4222-8333-944455556666";
  const plant = (configDir: string): string => {
    const project = join(configDir, "projects", "p");
    mkdirSync(project, { recursive: true });
    const transcript = join(project, `${sessionId}.jsonl`);
    writeFileSync(transcript, "prompt");
    return transcript;
  };

  it("removes a transcript from a private account directory and from the legacy default", () => {
    const home = tempRoot();
    const b = privateDir(join(home, "claude-b"));
    const inB = plant(b);
    const legacyTranscript = plant(join(home, ".claude"));
    removeClaudeWorkerSession(sessionId, home, b);
    removeClaudeWorkerSession(sessionId, home, join(home, ".claude"));
    expect(existsSync(inB)).toBe(false);
    expect(existsSync(legacyTranscript)).toBe(false);
  });

  it("leaves a transcript alone when the recorded directory is outside home, not private or behind a symlink", () => {
    const home = tempRoot();
    const outside = privateDir(join(tempRoot(), "claude-b"));
    const loose = join(home, "claude-loose");
    mkdirSync(loose);
    chmodSync(loose, 0o755);
    const linked = privateDir(join(home, "real-b"));
    symlinkSync(linked, join(home, "link-b"));
    const kept = [plant(outside), plant(loose), plant(linked)];
    for (const configDir of [outside, loose, join(home, "link-b")]) removeClaudeWorkerSession(sessionId, home, configDir);
    expect(kept.every((path) => existsSync(path))).toBe(true);
  });
});

describe("discarded pre-inference Pi session files", () => {
  const sessionFile = (dir: string, body: string, name = "2026-10-09_abc.jsonl"): string => {
    const file = join(dir, name);
    writeFileSync(file, body);
    return file;
  };
  const header = '{"type":"session","id":"abc","cwd":"/repo"}\n{"type":"message","message":{"role":"user","content":"task"}}\n';

  it("removes the empty session an attempt announced inside the task session directory", () => {
    const dir = tempRoot();
    const file = sessionFile(dir, header);
    expect(removeDiscardedPiSession(file, dir)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(removeDiscardedPiSession(file, dir)).toBe(false);
  });

  it("keeps anything that is not clearly this task's empty session", () => {
    const dir = tempRoot();
    const other = tempRoot();
    const answered = sessionFile(dir, `${header}{"type":"message","message":{"role":"assistant","content":"hi"}}\n`, "answered.jsonl");
    const elsewhere = sessionFile(other, header);
    const notJsonl = sessionFile(dir, header, "notes.txt");
    writeFileSync(join(other, "target.jsonl"), header);
    symlinkSync(join(other, "target.jsonl"), join(dir, "linked.jsonl"));
    expect(removeDiscardedPiSession(answered, dir)).toBe(false);
    expect(removeDiscardedPiSession(elsewhere, dir)).toBe(false);
    expect(removeDiscardedPiSession(notJsonl, dir)).toBe(false);
    expect(removeDiscardedPiSession(join(dir, "linked.jsonl"), dir)).toBe(false);
    expect(removeDiscardedPiSession(join(dir, "..", "x.jsonl"), dir)).toBe(false);
    expect(removeDiscardedPiSession(sessionFile(dir, header, "nodir.jsonl"), undefined)).toBe(false);
    expect(removeDiscardedPiSession(undefined, dir)).toBe(false);
    expect([answered, elsewhere, notJsonl, join(other, "target.jsonl"), join(dir, "nodir.jsonl")].every((path) => existsSync(path))).toBe(true);
  });
});

describe("account limit signal", () => {
  it("recognises a usage limit and reads a relative reset", () => {
    expect(accountLimitSignal("You have hit your ChatGPT usage limit (pro plan). Try again in ~90 min.", 1_000_000)).toEqual({ resetAt: 1_000 + 5_400 });
    expect(accountLimitSignal("usage_limit_reached, resets in 2 hours", 0)).toEqual({ resetAt: 7_200 });
  });

  it("reads the absolute reset notice in its own time zone", () => {
    const classified = (reset: string) => `Claude CLI synthetic error: quota limit reached; ${reset}; check Claude usage and retry the same route only after reset`;
    // 9:20am PDT is 16:20 UTC; 5pm EDT is 21:00 UTC; Oct 12 at 3pm PDT is 22:00 UTC three days on.
    expect(accountLimitSignal(classified("resets Oct 9 at 9:20am (America/Los_Angeles)"), NOW)).toEqual({ resetAt: NOW_S + 20 * 60 });
    expect(accountLimitSignal(classified("resets Oct 9 at 5pm (America/New_York)"), NOW)).toEqual({ resetAt: NOW_S + 5 * 3600 });
    expect(accountLimitSignal(classified("resets Oct 12 at 3pm (America/Los_Angeles)"), NOW)).toEqual({ resetAt: NOW_S + (3 * 24 + 6) * 3600 });
    expect(accountLimitSignal("You've hit your limit · resets 5pm (America/New_York)", NOW)).toEqual({ resetAt: NOW_S + 5 * 3600 });
    // 16:00 UTC is 21:30 in Kolkata (UTC+5:30), so the next 12:30am is three hours away.
    expect(accountLimitSignal("5-hour limit reached ∙ resets 12:30am (Asia/Kolkata)", NOW)).toEqual({ resetAt: NOW_S + 3 * 3600 });
    expect(accountLimitSignal("weekly limit reached, resets Oct 10 at 12am (Etc/UTC)", NOW)).toEqual({ resetAt: NOW_S + 8 * 3600 });
    expect(accountLimitSignal("Claude AI usage limit reached|1791846000", NOW)).toEqual({ resetAt: 1_791_846_000 });
  });

  it("rolls a date without a year to the next year and a bare time to the next day", () => {
    const dec = Date.UTC(2026, 11, 30, 12, 0, 0);
    expect(accountLimitSignal("quota limit reached; resets Jan 2 at 3pm (Etc/UTC)", dec)).toEqual({ resetAt: Date.UTC(2027, 0, 2, 15) / 1000 });
    // It is 9am in Los Angeles: 8am has passed today (so tomorrow), 10am has not.
    expect(accountLimitSignal("quota limit reached; resets 8am (America/Los_Angeles)", NOW)).toEqual({ resetAt: NOW_S + 23 * 3600 });
    expect(accountLimitSignal("quota limit reached; resets 10am (America/Los_Angeles)", NOW)).toEqual({ resetAt: NOW_S + 3600 });
  });

  it("drops a reset it cannot place instead of guessing", () => {
    for (const reset of ["resets Oct 9 at 5pm (Not/AZone)", "resets Oct 9 at 5pm (America/New_York; rm -rf)", "resets Oct 9 at 13pm (Etc/UTC)",
      "resets Oct 9 at 5:75pm (Etc/UTC)", "resets Feb 31 at 5pm (Etc/UTC)", "resets Oct 9 at 5pm", "resets Mar 8 at 2:30am (America/New_York)",
      "resets Oct 9 at 8am (Etc/UTC)", "resets Oct 30 at 5pm (Etc/UTC)", "resets Oct 9 at 5pm (Etc/UTC", "resets soon"]) {
      expect(accountLimitSignal(`quota limit reached; ${reset}`, reset.includes("Mar 8") ? Date.UTC(2026, 2, 1) : NOW), reset).toEqual({});
    }
  });

  it("ignores transient rate limits, reply limits and unrelated errors", () => {
    for (const text of ["429 rate limit exceeded", "Codex reply limit: Codex ended this reply after 15 minutes; usage limit unchanged", "fetch failed", "Child exceeded the 8-turn limit", undefined, ""]) {
      expect(accountLimitSignal(text), String(text)).toBeUndefined();
    }
  });

  it("drops an implausible reset instead of trusting it", () => {
    expect(accountLimitSignal("usage limit reached, try again in 9999 days", 0)).toEqual({});
    expect(accountLimitSignal("usage limit reached, try again in 0 minutes", 0)).toEqual({});
  });

  it("still recognises the limit wordings of the Claude worker's final classifier, and not its rate-limit line", () => {
    for (const text of ["quota limit reached; check Claude usage and retry the same route only after reset", "You've hit your session limit", "5-hour limit reached", "weekly limit reached"]) {
      expect(accountLimitSignal(text, NOW), text).toEqual({});
    }
    expect(accountLimitSignal("rate limit reached; retry with bounded backoff", NOW)).toBeUndefined();
    expect(accountLimitSignal("unrecognized synthetic error (fail closed); check Claude usage before debugging", NOW)).toBeUndefined();
  });
});

describe("runWithProviderAccount", () => {
  const base = (router: ProviderAccountRouter | undefined, overrides: Partial<Parameters<typeof runWithProviderAccount>[0]> = {}) => {
    const progress: WorkerProgress[] = [];
    return {
      progress,
      input: { provider: "claude" as const, router, runId: "run-acct", task: task(), signal: new AbortController().signal, now: () => NOW, onProgress: (value: WorkerProgress) => { progress.push(value); }, ...overrides },
    };
  };

  it("reserves before launch, records the pin once and releases after completion", async () => {
    const { router, selects, releases } = fakeRouter(() => selected(claude2));
    const { input, progress } = base(router);
    const order: string[] = [];
    const result = await runWithProviderAccount(input, async (reserve) => {
      order.push(`select-calls:${selects.length}`);
      const reservation = await reserve();
      order.push(`reserved:${reservation?.account.id}:${releases.length}`);
      return done;
    });
    expect(result).toBe(done);
    expect(order).toEqual(["select-calls:0", "reserved:b:0"]);
    expect(selects).toEqual([{ provider: "claude", owner: `steak-pi:${process.pid}:run-acct:run-acct-task-1` }]);
    expect(releases).toEqual(["lease-1"]);
    expect(progress).toEqual([{ providerAccount: { provider: "claude", id: "b", label: "Claude 2", configDir: "/accounts/claude-b" } }]);
  });

  it("holds the lease through late cleanup and releases only after it settles", async () => {
    const { router, releases } = fakeRouter(() => selected(claude2));
    const { input } = base(router);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const result = await runWithProviderAccount(input, async (reserve) => { await reserve(); return { ...done, cleanup }; });
    expect(releases).toEqual([]);
    finishCleanup();
    await result.cleanup;
    expect(releases).toEqual(["lease-1"]);
  });

  it("releases the lease when the launch throws and when the pin check refuses the answer", async () => {
    const thrower = fakeRouter(() => selected(claude2));
    await expect(runWithProviderAccount(base(thrower.router).input, async (reserve) => { await reserve(); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(thrower.releases).toEqual(["lease-1"]);

    const wrong = fakeRouter(() => selected({ id: "primary", label: "Claude 1" }, "lease-2"));
    const pinned = base(wrong.router, { task: task({ providerAccount: { provider: "claude", id: "b", label: "Claude 2" } }) });
    const result = await runWithProviderAccount(pinned.input, async (reserve) => { await reserve(); return done; });
    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("pinned to Claude 2") });
    expect(wrong.releases).toEqual(["lease-2"]);
    expect(wrong.selects[0].account).toBe("b");
  });

  it("queues behind unavailable capacity, polls, then proceeds once capacity returns", async () => {
    const { router, selects } = fakeRouter((call) => call < 3 ? { kind: "queued", error: "Claude 1 at limit" } : selected(claude2));
    const sleeps: number[] = [];
    const { input, progress } = base(router, { pollMs: 5_000, sleep: async (ms) => { sleeps.push(ms); return true; } });
    const result = await runWithProviderAccount(input, async (reserve) => { await reserve(); return done; });
    expect(result.state).toBe("done");
    expect(selects).toHaveLength(3);
    expect(sleeps).toEqual([5_000, 5_000]);
    expect(progress[0]).toEqual({ state: "waiting", currentTool: "waiting for Claude account capacity" });
    expect(progress[1]).toMatchObject({ state: "running", currentTool: undefined, providerAccount: { id: "b" } });
    expect(Object.hasOwn(progress[1], "currentTool")).toBe(true);
  });

  it("stops waiting at the bound with an explicit non-worker error and no lease", async () => {
    const { router, releases } = fakeRouter(() => ({ kind: "queued", error: "usage unknown" }));
    let clock = 0;
    const { input } = base(router, { maxWaitMs: 20_000, pollMs: 10_000, now: () => clock, sleep: async (ms) => { clock += ms; return true; } });
    const launch = vi.fn(async (reserve: () => Promise<unknown>) => { await reserve(); return done; });
    const result = await runWithProviderAccount(input, launch);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/^Waiting for Claude account capacity ended after \d+ min: usage unknown; no inference started$/);
    expect(releases).toEqual([]);
  });

  it("ends a queue wait promptly on cancellation with the right terminal state", async () => {
    const { router } = fakeRouter(() => ({ kind: "queued", error: "all busy" }));
    const controller = new AbortController();
    const { input, progress } = base(router, { signal: controller.signal, pollMs: 60_000 });
    const pending = runWithProviderAccount(input, async (reserve) => { await reserve(); return done; });
    await vi.waitFor(() => expect(progress).toEqual([{ state: "waiting", currentTool: "waiting for Claude account capacity" }]));
    controller.abort(new DOMException("Task cancelled", "AbortError"));
    expect(await pending).toMatchObject({ state: "aborted", error: expect.stringMatching(/Waiting for Claude account capacity/) });

    const deadline = new AbortController();
    const timed = runWithProviderAccount(base(router, { signal: deadline.signal, pollMs: 60_000 }).input, async (reserve) => { await reserve(); return done; });
    deadline.abort(new DOMException("Run deadline exceeded", "TimeoutError"));
    expect((await timed).state).toBe("timed_out");
  });

  it("annotates a launch that swallowed the queue wait and ended while still parked", async () => {
    const { router } = fakeRouter(() => ({ kind: "queued", error: "busy" }));
    const controller = new AbortController();
    const { input } = base(router, { signal: controller.signal, pollMs: 60_000 });
    const pending = runWithProviderAccount(input, async (reserve) => {
      try { await reserve(); } catch { /* a runner that folds the error into its own classification */ }
      return { state: "aborted", output: "", turns: 0, usage: emptyUsage(), error: "Task cancelled" } satisfies WorkerResult;
    });
    controller.abort(new DOMException("Task cancelled", "AbortError"));
    expect(await pending).toMatchObject({ state: "aborted", error: "Task cancelled; waiting for Claude account capacity, no inference started" });
  });

  it("fails closed when the router is unavailable instead of falling back to another account", async () => {
    const { router, releases } = fakeRouter(() => ({ kind: "unavailable", error: "router could not be run" }));
    const result = await runWithProviderAccount(base(router).input, async (reserve) => { await reserve(); return done; });
    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("account router unavailable: router could not be run; no inference started") });
    expect(releases).toEqual([]);
  });

  it("uses the legacy primary route without a router and refuses a pinned secondary account", async () => {
    const legacy = await runWithProviderAccount(base(undefined).input, async (reserve) => { expect(await reserve()).toBeUndefined(); return done; });
    expect(legacy.state).toBe("done");
    const resumedPrimary = base(undefined, { task: task({ claudeSessionId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b" }) });
    expect((await runWithProviderAccount(resumedPrimary.input, async (reserve) => { await reserve(); return done; })).state).toBe("done");
    const pinned = base(undefined, { task: task({ providerAccount: { provider: "claude", id: "b", label: "Claude 2" } }) });
    expect(await runWithProviderAccount(pinned.input, async (reserve) => { await reserve(); return done; }))
      .toMatchObject({ state: "failed", error: expect.stringContaining("pinned to Claude 2 but no account router is installed") });
  });

  it("does not route a provider the balancer does not own", async () => {
    const { router, selects } = fakeRouter(() => selected(claude2));
    const { input } = base(router, { provider: undefined });
    const result = await runWithProviderAccount(input, async (reserve) => { expect(await reserve(undefined)).toBeUndefined(); return done; });
    expect(result.state).toBe("done");
    expect(selects).toEqual([]);
  });

  it("reports a usage limit to the router for the account that hit it, then releases", async () => {
    const { router, limits, releases } = fakeRouter(() => selected(claude2));
    const failed: WorkerResult = { state: "failed", output: "", turns: 1, usage: emptyUsage(), error: "Claude CLI synthetic error: quota limit reached; resets Oct 9 at 9:20am (America/Los_Angeles)" };
    await runWithProviderAccount({ ...base(router).input, limitRetries: 0 }, async (reserve) => { await reserve(); return failed; });
    expect(limits).toEqual([{ provider: "claude", account: "b", resetAt: NOW_S + 20 * 60, reason: "usage limit" }]);
    expect(releases).toEqual(["lease-1"]);

    const other = fakeRouter(() => selected(claude2));
    await runWithProviderAccount(base(other.router).input, async (reserve) => { await reserve(); return { ...failed, error: "fetch failed" }; });
    expect(other.limits).toEqual([]);
  });
});

/** Stateful stand-in for the real router's observable rules: an explicit or owner-pinned account
 * queues while it cools down, and automatic selection takes the first account that is not cooling. */
function stubRouter(accounts: ProviderAccount[]) {
  const cooling = new Set<string>();
  const owners = new Map<string, string>();
  const selects: Array<{ provider: string; account?: string; owner: string; existing?: boolean }> = [];
  const limits: Array<{ provider: string; account: string; resetAt?: number; reason: string }> = [];
  const events: string[] = [];
  const renewals: LeaseRenewal[] = [];
  let leases = 0;
  const router: ProviderAccountRouter = {
    async select(request) {
      selects.push(request);
      const wanted = request.account ?? owners.get(request.owner);
      const account = wanted ? accounts.find((candidate) => candidate.id === wanted) : accounts.find((candidate) => !cooling.has(candidate.id));
      if (!account || (!request.existing && cooling.has(account.id))) return { kind: "queued", error: account ? `${account.label} is cooling down` : "every account is cooling down" };
      owners.set(request.owner, account.id);
      const lease = `lease-${++leases}`;
      events.push(`select:${account.id}:${lease}`);
      return { kind: "selected", account, lease };
    },
    async renew(lease) { events.push(`renew:${lease}`); return renewals.shift() ?? "renewed"; },
    async release(lease) { events.push(`release:${lease}`); },
    async limit(request) { limits.push(request); cooling.add(request.account); events.push(`limit:${request.account}`); },
  };
  return { router, cooling, selects, limits, events, renewals };
}

const claude1: ProviderAccount = { id: "primary", label: "Claude 1" };
const SESSION = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const limitText = "Claude CLI synthetic error: quota limit reached; resets Oct 9 at 9:20am (America/Los_Angeles)";
const limited = (extra: Partial<WorkerResult> = {}): WorkerResult => ({ state: "failed", output: "", turns: 0, usage: emptyUsage(), error: limitText, ...extra });
const spent = { ...emptyUsage(), input: 100, output: 20, totalTokens: 120 };

describe("router JSON as the real ut-provider-accounts prints it", () => {
  // Verbatim stdout of the router (ultraterm scripts/ut-provider-accounts) in a temp HOME with two Claude
  // accounts and two Codex accounts; only the home directory is rewritten.
  const answers = {
    claudeAuto: '{"account": {"configDir": "/home/u/.claude-b", "id": "b", "label": "Claude 2"}, "lease": "a046377dae61757e4eeb77e1", "leaseExpiresAt": 1791543001.241785, "mode": "together", "ok": true, "provider": "claude", "reason": "most headroom (0 live, 10% used)"}',
    claudePrimary: '{"account": {"configDir": "/home/u/.claude", "id": "primary", "label": "Claude 1"}, "lease": "7be36e6e38ca1a67654b2da9", "leaseExpiresAt": 1791543002.190302, "mode": "together", "ok": true, "provider": "claude", "reason": "explicit account"}',
    codexAuto: '{"account": {"agentDir": "/home/u/.pi-gpt2", "id": "fallback", "label": "GPT 2"}, "lease": "2368ff8963c9b84f2d988a89", "leaseExpiresAt": 1791543002.7235148, "mode": "together", "ok": true, "provider": "codex", "reason": "most headroom (0 live, 20% used)"}',
    codexPrimary: '{"account": {"id": "primary", "label": "GPT 1"}, "lease": "0c4c1f1d9a3b44b19f0a1b2c", "leaseExpiresAt": 1791543003.5, "mode": "together", "ok": true, "provider": "codex", "reason": "only account"}',
    cooling: '{"account": "b", "error": "Claude 2 is cooling down until 08:05 (the session stays on its account)", "ok": false, "queued": true, "resetAt": 1791547500}',
    allCooling: '{"error": "every Claude account is cooling down (Claude 1, Claude 2); the earliest returns at 06:37; queued, not failed", "ok": false, "queued": true, "resetAt": 1791542227}',
    signedOut: '{"account": "b", "error": "Claude 2 is signed out", "ok": false, "queued": false}',
    pinnedElsewhere: '{"error": "owner steak-pi:1:run-a:t1 is pinned to account b; a session never moves to primary", "ok": false, "pinned": "b", "queued": false}',
    renewed: '{"leaseExpiresAt": 1791543900.5, "ok": true, "renewed": true}',
    expired: '{"ok": true, "renewed": false}',
    badArguments: '{"error": "invalid arguments; run ut-provider-accounts --help", "ok": false, "queued": false}',
  };
  const routerFor = (stdout: string, calls: string[][] = []) => createProviderAccountRouter({ command: "/bin/router", exec: async (_command, args) => { calls.push([...args]); return { stdout }; } });

  it("reads a Claude reservation: canonical label, config dir, hex lease", async () => {
    expect(await routerFor(answers.claudeAuto).select({ provider: "claude", owner: "o" })).toEqual({
      kind: "selected", account: { id: "b", label: "Claude 2", configDir: "/home/u/.claude-b" }, lease: "a046377dae61757e4eeb77e1",
    });
    expect(await routerFor(answers.claudePrimary).select({ provider: "claude", account: "primary", owner: "o" })).toEqual({
      kind: "selected", account: { id: "primary", label: "Claude 1", configDir: "/home/u/.claude" }, lease: "7be36e6e38ca1a67654b2da9",
    });
  });

  it("reads a Codex reservation for both accounts, and never invents an agent dir", async () => {
    expect(await routerFor(answers.codexAuto).select({ provider: "codex", owner: "o" })).toEqual({
      kind: "selected", account: { id: "fallback", label: "GPT 2", agentDir: "/home/u/.pi-gpt2" }, lease: "2368ff8963c9b84f2d988a89",
    });
    expect(await routerFor(answers.codexPrimary).select({ provider: "codex", owner: "o" })).toEqual({
      kind: "selected", account: { id: "primary", label: "GPT 1" }, lease: "0c4c1f1d9a3b44b19f0a1b2c",
    });
    // The Claude parser refuses a Codex answer for the other provider's account ID, and vice versa.
    expect((await routerFor(answers.codexAuto).select({ provider: "claude", owner: "o" })).kind).toBe("unavailable");
    expect((await routerFor(answers.claudeAuto).select({ provider: "codex", owner: "o" })).kind).toBe("unavailable");
  });

  it("waits on a queued answer (exit 3 carries the same JSON) and fails closed on every refusal", async () => {
    for (const stdout of [answers.cooling, answers.allCooling]) {
      expect((await routerFor(stdout).select({ provider: "claude", owner: "o" })).kind, stdout).toBe("queued");
    }
    expect(await routerFor(answers.cooling).select({ provider: "claude", account: "b", owner: "o" })).toEqual({ kind: "queued", error: "Claude 2 is cooling down until 08:05 (the session stays on its account)" });
    for (const stdout of [answers.signedOut, answers.pinnedElsewhere, answers.badArguments]) {
      expect((await routerFor(stdout).select({ provider: "claude", owner: "o" })).kind, stdout).toBe("unavailable");
    }
  });

  it("sends exactly the helper's flags for select --existing, renew, release and limit", async () => {
    const calls: string[][] = [];
    const router = routerFor(answers.claudeAuto, calls);
    await router.select({ provider: "claude", account: "b", owner: "steak-pi:1:run-a:t1", existing: true });
    await routerFor(answers.renewed, calls).renew("a046377dae61757e4eeb77e1");
    await router.release("a046377dae61757e4eeb77e1");
    expect(calls).toEqual([
      ["select", "--provider", "claude", "--account", "b", "--owner", "steak-pi:1:run-a:t1", "--reserve", "--existing"],
      ["renew", "--lease", "a046377dae61757e4eeb77e1"],
      ["release", "--lease", "a046377dae61757e4eeb77e1"],
    ]);
  });

  it("reads renew answers: renewed, expired, and anything else as a named failure", async () => {
    expect(await routerFor(answers.renewed).renew("L")).toBe("renewed");
    expect(await routerFor(answers.expired).renew("L")).toBe("expired");
    await expect(routerFor(answers.badArguments).renew("L")).rejects.toMatchObject({ operation: "renew", reason: "invalid arguments; run ut-provider-accounts --help" });
    for (const stdout of ["not json", "{}", '{"ok": true}', '{"ok": true, "renewed": "yes"}']) {
      await expect(routerFor(stdout).renew("L"), stdout).rejects.toBeInstanceOf(ProviderAccountRouterError);
    }
    const down = createProviderAccountRouter({ command: "/bin/router", exec: async () => { throw new Error("timed out"); } });
    await expect(down.renew("L")).rejects.toMatchObject({ operation: "renew", reason: "timed out" });
  });

  it("requires explicit release and limit acknowledgements", async () => {
    for (const stdout of ['{"ok": true}', '{"ok": true, "released": true}']) {
      await expect(routerFor(stdout).release("L"), stdout).resolves.toBeUndefined();
      await expect(routerFor(stdout).limit({ provider: "claude", account: "b", reason: "usage limit" }), stdout).resolves.toBeUndefined();
    }
    await expect(routerFor(answers.badArguments).limit({ provider: "claude", account: "b", reason: "usage limit" })).rejects.toMatchObject({ operation: "limit" });
    await expect(routerFor("not json").release("L")).rejects.toMatchObject({ operation: "release" });
    await expect(routerFor("{}").release("L")).rejects.toMatchObject({ operation: "release" });
    await expect(routerFor("{}").limit({ provider: "claude", account: "b", reason: "usage limit" })).rejects.toMatchObject({ operation: "limit" });
  });
});

describe("best-effort router calls are named, not swallowed", () => {
  const SESSION_ID = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
  const input = (router: ProviderAccountRouter, notices: string[], overrides: Partial<Parameters<typeof runWithProviderAccount>[0]> = {}) =>
    ({ provider: "claude" as const, router, runId: "run-acct", task: task(), signal: new AbortController().signal, onProgress: () => {}, renewMs: 0, now: () => NOW,
      onNotice: (message: string) => { notices.push(message); }, ...overrides });
  const failing = (operation: "renew" | "release" | "limit", reason: string) => () => { throw new ProviderAccountRouterError(operation, reason); };

  it("names a failed release without failing the worker, and says the router expires the lease", async () => {
    const { router } = fakeRouter(() => selected(claude2));
    router.release = async () => failing("release", "router timed out")();
    const notices: string[] = [];
    const result = await runWithProviderAccount(input(router, notices), async (reserve) => { await reserve(); return done; });
    expect(result.state).toBe("done");
    expect(notices).toEqual(["Claude 2 lease release failed: router timed out; the router expires an abandoned lease"]);
  });

  it("names a failed renewal once, keeps the worker running and keeps trying", async () => {
    const stub = fakeRouter(() => selected(claude2));
    let attempts = 0;
    stub.router.renew = async () => { attempts += 1; return failing("renew", "router timed out")(); };
    const notices: string[] = [];
    const result = await runWithProviderAccount(input(stub.router, notices, { renewMs: 5 }), async (reserve) => {
      await reserve();
      await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(3));
      return done;
    });
    expect(result.state).toBe("done");
    expect(notices).toEqual(["Claude 2 lease renewal failed: router timed out"]);
    expect(stub.releases).toEqual(["lease-1"]);
  });

  it("names an unusable renewal answer and a lease that could not be re-reserved, and drops a lease for another account", async () => {
    const stub = fakeRouter((call) => (call === 1 ? selected(claude2) : { kind: "queued", error: "Claude 2 is cooling down" }));
    stub.renewal.answer = "failed";
    const notices: string[] = [];
    const run = (overrides: Partial<Parameters<typeof runWithProviderAccount>[0]> = {}) => runWithProviderAccount(input(stub.router, notices, { renewMs: 5, ...overrides }), async (reserve) => {
      await reserve();
      await vi.waitFor(() => expect(stub.renews.length).toBeGreaterThanOrEqual(2));
      return done;
    });
    await run();
    expect(notices).toEqual(["Claude 2 lease renewal failed: router gave no usable answer"]);

    const lost = fakeRouter((call) => (call === 1 ? selected(claude2) : { kind: "queued", error: "Claude 2 is cooling down" }));
    lost.renewal.answer = "expired";
    const lostNotices: string[] = [];
    await runWithProviderAccount(input(lost.router, lostNotices, { renewMs: 5 }), async (reserve) => { await reserve(); await vi.waitFor(() => expect(lost.selects.length).toBeGreaterThanOrEqual(2)); return done; });
    expect(lostNotices).toEqual(["Claude 2 lease expired and could not be re-reserved: Claude 2 is cooling down"]);

    const stray = fakeRouter((call) => (call === 1 ? selected(claude2, "lease-1") : selected({ id: "primary", label: "Claude 1" }, "lease-stray")));
    stray.renewal.answer = "expired";
    const strayNotices: string[] = [];
    await runWithProviderAccount(input(stray.router, strayNotices, { renewMs: 5 }), async (reserve) => { await reserve(); await vi.waitFor(() => expect(stray.releases).toContain("lease-stray")); return done; });
    expect(strayNotices[0]).toBe("Claude 2 lease expired and could not be re-reserved: router answered a different account or no lease");
    expect(stray.releases).toContain("lease-stray");
  });

  it("does not relaunch a usage limit the router was not told about, and names the failure in the task error", async () => {
    const stub = fakeRouter(() => selected(claude2));
    stub.router.limit = async () => failing("limit", "router timed out")();
    const record = task();
    const notices: string[] = [];
    const launch = vi.fn(async (reserve: () => Promise<unknown>) => { await reserve(); record.claudeSessionId = SESSION_ID; return { state: "failed" as const, output: "", turns: 1, usage: emptyUsage(), error: limitText }; });
    const result = await runWithProviderAccount(input(stub.router, notices, { task: record, maxTurns: 8, limitRetries: 2 }), launch);
    // Without the report the router would still offer the exhausted account: a relaunch would only repeat the failure.
    expect(launch).toHaveBeenCalledTimes(1);
    expect(stub.selects).toHaveLength(1);
    expect(result.state).toBe("failed");
    expect(result.error).toBe(`${limitText}; the usage limit could not be reported to the account router (router timed out), so the task was not relaunched`);
    expect(notices).toEqual(["Claude 2 usage limit could not be reported to the account router: router timed out"]);
    expect(stub.releases).toEqual(["lease-1"]);
    expect(record.claudeSessionId).toBe(SESSION_ID);
  });

  it("shows a failure on the task's step line when no observer is given", async () => {
    const { router } = fakeRouter(() => selected(claude2));
    router.release = async () => failing("release", "down")();
    const progress: WorkerProgress[] = [];
    await runWithProviderAccount({ provider: "claude", router, runId: "run-acct", task: task(), signal: new AbortController().signal, renewMs: 0, onProgress: (value) => { progress.push(value); } },
      async (reserve) => { await reserve(); return done; });
    expect(progress.at(-1)).toEqual({ currentTool: "Claude 2 lease release failed: down; the router expires an abandoned lease" });
  });

  it("names a third account by its own label in every refusal", async () => {
    const team: ProviderAccount = { id: "team-3", label: "Claude (team-3)", configDir: "/accounts/claude-team-3" };
    const pinned = { provider: "claude" as const, id: "team-3", label: "Claude (team-3)" };
    const base = { provider: "claude" as const, runId: "run-acct", signal: new AbortController().signal, onProgress: () => {} };
    const legacy = await runWithProviderAccount({ ...base, router: undefined, task: task({ providerAccount: pinned }) }, async (reserve) => { await reserve(); return done; });
    expect(legacy.error).toMatch(/pinned to Claude \(team-3\) but no account router is installed/);
    const { router } = fakeRouter(() => selected(claude2));
    const moved = await runWithProviderAccount({ ...base, router, task: task({ providerAccount: pinned }) }, async (reserve) => { await reserve(); return done; });
    expect(moved.error).toMatch(/Router answered Claude 2 for a task pinned to Claude \(team-3\)/);
    const ok = fakeRouter(() => selected(team, "lease-team"));
    const held = await runWithProviderAccount({ ...base, router: ok.router, task: task({ providerAccount: pinned }) }, async (reserve) => { const reservation = await reserve(); return { ...done, output: reservation?.ref.label ?? "" }; });
    expect(held.output).toBe("Claude (team-3)");
    expect(ok.selects[0].account).toBe("team-3");
  });

  it("removes only the empty Pi session this attempt announced when it restarts fresh, and nothing else", async () => {
    const gpt1: ProviderAccount = { id: "primary", label: "GPT 1" };
    const dir = tempRoot();
    const header = '{"type":"session","id":"abc"}\n{"type":"message","message":{"role":"user","content":"task"}}\n';
    const bystander = join(dir, "other-task.jsonl");
    writeFileSync(bystander, header);
    const first = join(dir, "first.jsonl");
    const stub = stubRouter([gpt1, { id: "fallback", label: "GPT 2", agentDir: "/accounts/pi-fallback" }]);
    const record = task();
    const seen: Array<string | undefined> = [];
    const result = await runWithProviderAccount({
      provider: "codex", router: stub.router, runId: "run-acct", task: record, signal: new AbortController().signal, maxTurns: 8, renewMs: 0, now: () => NOW,
      pollMs: 1, sleep: async () => true, sessionDir: dir, onProgress: (value) => { if (value.providerAccount && !record.providerAccount) record.providerAccount = value.providerAccount; },
    }, async (reserve, attempt) => {
      await reserve();
      seen.push(record.sessionFile);
      if (seen.length === 1) {
        writeFileSync(first, header);
        // The coordinator records the path after the wrapper has seen the progress event.
        attempt.onProgress({ state: "starting", sessionFile: first });
        record.sessionFile = first;
        return limited({ turns: 1, error: "You have hit your ChatGPT usage limit (plus plan). Try again in ~10 min." });
      }
      return done;
    });
    expect(result.state).toBe("done");
    // The second attempt starts from nothing, and the half-created file of the first is gone; a neighbour's file is untouched.
    expect(seen).toEqual([undefined, undefined]);
    expect(record.sessionFile).toBeUndefined();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(bystander)).toBe(true);
  });

  it("keeps a Pi session file it did not see the attempt announce, or that carries history", async () => {
    const dir = tempRoot();
    const header = '{"type":"session","id":"abc"}\n{"type":"message","message":{"role":"user","content":"task"}}\n';
    const planted = join(dir, "planted.jsonl");
    const answered = join(dir, "answered.jsonl");
    writeFileSync(planted, header);
    writeFileSync(answered, `${header}{"type":"message","message":{"role":"assistant","content":"hi"}}\n`);
    for (const [file, announce] of [[planted, false], [answered, true]] as const) {
      const stub = stubRouter([{ id: "primary", label: "GPT 1" }]);
      const record = task();
      let calls = 0;
      await runWithProviderAccount({
        provider: "codex", router: stub.router, runId: "run-acct", task: record, signal: new AbortController().signal, maxTurns: 8, renewMs: 0, now: () => NOW,
        pollMs: 1, sleep: async () => { stub.cooling.clear(); return true; }, sessionDir: dir, onProgress: () => {},
      }, async (reserve, attempt) => {
        await reserve();
        calls += 1;
        if (calls === 1) { record.sessionFile = file; if (announce) attempt.onProgress({ sessionFile: file }); return limited({ turns: 1, error: "You have hit your ChatGPT usage limit (plus plan). Try again in ~10 min." }); }
        return done;
      });
      expect(existsSync(file), file).toBe(true);
    }
  });
});

describe("lease renewal while a worker runs", () => {
  const input = (router: ProviderAccountRouter, overrides: Partial<Parameters<typeof runWithProviderAccount>[0]> = {}) =>
    ({ provider: "claude" as const, router, runId: "run-acct", task: task(), signal: new AbortController().signal, onProgress: () => {}, renewMs: 5, ...overrides });

  it("renews the held lease on a timer and stops the moment the lease is released", async () => {
    const stub = stubRouter([claude2]);
    let finish!: () => void;
    const running = new Promise<void>((resolve) => { finish = resolve; });
    const pending = runWithProviderAccount(input(stub.router), async (reserve) => { await reserve(); await running; return done; });
    await vi.waitFor(() => expect(stub.events.filter((event) => event === "renew:lease-1").length).toBeGreaterThanOrEqual(2));
    finish();
    expect((await pending).state).toBe("done");
    expect(stub.events.at(-1)).toBe("release:lease-1");
    const settled = stub.events.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stub.events).toHaveLength(settled);
  });

  it("keeps renewing through late cleanup and stops when that cleanup finishes", async () => {
    const stub = stubRouter([claude2]);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const result = await runWithProviderAccount(input(stub.router), async (reserve) => { await reserve(); return { ...done, cleanup }; });
    await vi.waitFor(() => expect(stub.events.filter((event) => event.startsWith("renew:")).length).toBeGreaterThanOrEqual(1));
    expect(stub.events.some((event) => event.startsWith("release:"))).toBe(false);
    finishCleanup();
    await result.cleanup;
    expect(stub.events.at(-1)).toBe("release:lease-1");
  });

  it("re-reserves a lease the router forgot, for the session already running on that account", async () => {
    const stub = stubRouter([claude1, claude2]);
    stub.renewals.push("expired");
    let finish!: () => void;
    const running = new Promise<void>((resolve) => { finish = resolve; });
    const pending = runWithProviderAccount(input(stub.router, { task: task({ providerAccount: { provider: "claude", id: "b", label: "Claude 2" } }) }), async (reserve) => { await reserve(); await running; return done; });
    await vi.waitFor(() => expect(stub.selects).toHaveLength(2));
    finish();
    await pending;
    expect(stub.selects[1]).toEqual({ provider: "claude", account: "b", owner: stub.selects[0].owner, existing: true });
    // The replacement lease, not the forgotten one, is what gets released.
    expect(stub.events.at(-1)).toBe("release:lease-2");
    expect(stub.events.filter((event) => event.startsWith("release:"))).toEqual(["release:lease-2"]);
  });

  it("survives a router that cannot renew: the worker is never failed by it", async () => {
    const stub = stubRouter([claude2]);
    stub.renewals.push("failed", "failed");
    const pending = runWithProviderAccount(input(stub.router), async (reserve) => { await reserve(); await vi.waitFor(() => expect(stub.events.filter((event) => event.startsWith("renew:")).length).toBeGreaterThanOrEqual(2)); return done; });
    expect((await pending).state).toBe("done");
    expect(stub.selects).toHaveLength(1);
  });

  it("does not renew a task that holds no lease (legacy route or a lease-less answer)", async () => {
    const calls: string[] = [];
    const router: ProviderAccountRouter = {
      async select() { return { kind: "selected", account: claude2 }; },
      async renew() { calls.push("renew"); return "renewed"; }, async release() { calls.push("release"); }, async limit() {},
    };
    await runWithProviderAccount(input(router), async (reserve) => { await reserve(); await new Promise((resolve) => setTimeout(resolve, 25)); return done; });
    expect(calls).toEqual([]);
  });
});

describe("launch slots while a task waits for capacity", () => {
  const slotInput = (router: ProviderAccountRouter, log: string[], overrides: Partial<Parameters<typeof runWithProviderAccount>[0]> = {}) => ({
    provider: "claude" as const, router, runId: "run-acct", task: task(), signal: new AbortController().signal, onProgress: () => {},
    slots: { yield: () => { log.push("yield"); }, reclaim: async () => { log.push("reclaim"); } },
    pollMs: 1, sleep: async () => { log.push("sleep"); return true; }, ...overrides,
  });

  it("gives the slots back for the whole wait and takes them again before any work starts", async () => {
    const { router } = fakeRouter((call) => call < 3 ? { kind: "queued", error: "busy" } : selected(claude2));
    const log: string[] = [];
    const result = await runWithProviderAccount(slotInput(router, log), async (reserve) => { await reserve(); log.push("work"); return done; });
    expect(result.state).toBe("done");
    expect(log).toEqual(["yield", "sleep", "sleep", "reclaim", "work"]);
  });

  it("never touches the slots when capacity is immediate", async () => {
    const { router } = fakeRouter(() => selected(claude2));
    const log: string[] = [];
    await runWithProviderAccount(slotInput(router, log), async (reserve) => { await reserve(); log.push("work"); return done; });
    expect(log).toEqual(["work"]);
  });

  it("settles a wait that times out without ever reclaiming, and releases a lease whose reclaim was refused", async () => {
    const queued = fakeRouter(() => ({ kind: "queued", error: "busy" }));
    const log: string[] = [];
    const timedOut = await runWithProviderAccount(slotInput(queued.router, log, { maxWaitMs: 0 }), async (reserve) => { await reserve(); return done; });
    expect(timedOut.error).toMatch(/Waiting for Claude account capacity ended/);
    expect(log).toEqual(["yield"]);

    const granted = fakeRouter((call) => call === 1 ? { kind: "queued", error: "busy" } : selected(claude2, "lease-9"));
    const refused = await runWithProviderAccount(
      slotInput(granted.router, [], { slots: { yield() {}, reclaim: async () => { throw new DOMException("Run deadline exceeded", "TimeoutError"); } } }),
      async (reserve) => { await reserve(); return done; },
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DOMException);
    expect(granted.releases).toEqual(["lease-9"]);
  });
});

describe("usage limit: relaunch without moving a session", () => {
  const pinnedB = { provider: "claude" as const, id: "b", label: "Claude 2" };
  const params = (router: ProviderAccountRouter, record: TaskRecord, overrides: Partial<Parameters<typeof runWithProviderAccount>[0]> = {}) => {
    const progress: WorkerProgress[] = [];
    return {
      progress,
      input: {
        provider: "claude" as const, router, runId: "run-acct", task: record, signal: new AbortController().signal, maxTurns: 8, renewMs: 0, now: () => NOW,
        onProgress: (value: WorkerProgress) => { progress.push(value); if (value.providerAccount && !record.providerAccount) record.providerAccount = value.providerAccount; },
        pollMs: 1, sleep: async () => true, ...overrides,
      },
    };
  };

  it("starts a task that hit the limit before any inference fresh, on the account the router then offers", async () => {
    const stub = stubRouter([claude1, claude2]);
    const record = task();
    const seen: Array<{ account?: string; session?: string; priorTurns: number }> = [];
    const result = await runWithProviderAccount(params(stub.router, record).input, async (reserve, attempt) => {
      const reservation = await reserve();
      seen.push({ account: reservation?.account.id, session: record.claudeSessionId, priorTurns: attempt.priorTurns });
      if (seen.length === 1) { record.claudeSessionId = SESSION; return limited({ turns: 1 }); }
      record.claudeSessionId = "11111111-1111-4111-8111-111111111111";
      return done;
    });
    expect(result.state).toBe("done");
    // The empty session of the first attempt is not carried to the other account.
    expect(seen).toEqual([{ account: "primary", session: undefined, priorTurns: 0 }, { account: "b", session: undefined, priorTurns: 0 }]);
    expect(stub.events).toEqual(["select:primary:lease-1", "limit:primary", "release:lease-1", "select:b:lease-2", "release:lease-2"]);
    expect(stub.limits).toEqual([{ provider: "claude", account: "primary", resetAt: NOW_S + 20 * 60, reason: "usage limit" }]);
    // A new owner (the old one is bound to the limited account) and no pinned account in the second request.
    expect(stub.selects[0].owner).not.toBe(stub.selects[1].owner);
    expect(stub.selects[1].owner).toMatch(/:r1$/);
    expect(stub.selects[1].account).toBeUndefined();
    expect(record.providerAccount).toMatchObject({ id: "b", label: "Claude 2" });
  });

  it("queues a Pi/Codex task the same way and never hands it a paid route", async () => {
    const gpt1: ProviderAccount = { id: "primary", label: "GPT 1" };
    const stub = stubRouter([gpt1]);
    const record = task({ sessionFile: undefined });
    const waits: string[] = [];
    let clearAfter = 2;
    const result = await runWithProviderAccount(
      params(stub.router, record, { provider: "codex", sleep: async () => { waits.push("poll"); if (--clearAfter === 0) stub.cooling.clear(); return true; } }).input,
      async (reserve) => {
        await reserve();
        return waits.length === 0 ? limited({ error: "You have hit your ChatGPT usage limit (plus plan). Try again in ~90 min.", turns: 1 }) : done;
      },
    );
    // Only GPT 1 exists: after the limit the fresh task waits for it instead of failing or going elsewhere.
    expect(result.state).toBe("done");
    expect(waits).toHaveLength(2);
    expect(stub.limits[0]).toMatchObject({ provider: "codex", account: "primary" });
    expect(stub.limits[0].resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 5_000);
  });

  it("queues a task that owns history for its own account and resumes it there with the work carried forward", async () => {
    const stub = stubRouter([claude1, claude2]);
    const record = task({ claudeSessionId: SESSION, providerAccount: pinnedB });
    let polls = 0;
    const attempts: Array<{ account?: string; priorTurns: number }> = [];
    const { input, progress } = params(stub.router, record, { sleep: async () => { if (++polls === 2) stub.cooling.clear(); return true; } });
    const result = await runWithProviderAccount(input, async (reserve, attempt) => {
      const reservation = await reserve();
      attempts.push({ account: reservation?.account.id, priorTurns: attempt.priorTurns });
      if (attempts.length === 1) return limited({ turns: 3, usage: spent, toolSuccesses: 2 });
      attempt.onProgress({ turns: 1, usage: spent, toolSuccesses: 1 });
      return { ...done, turns: 2, usage: spent, toolSuccesses: 1 };
    });
    expect(result.state).toBe("done");
    expect(attempts).toEqual([{ account: "b", priorTurns: 0 }, { account: "b", priorTurns: 3 }]);
    // Every request names the owning account; the other account is never asked for.
    expect(stub.selects.map((request) => request.account)).toEqual(["b", "b", "b", "b"]);
    expect(stub.events.filter((event) => event.startsWith("select:"))).toEqual(["select:b:lease-1", "select:b:lease-2"]);
    expect(stub.events.indexOf("release:lease-1")).toBeLessThan(stub.events.indexOf("select:b:lease-2"));
    // The wait was visible, and the session's counters continue instead of restarting.
    expect(progress).toContainEqual({ state: "waiting", currentTool: "waiting for Claude account capacity" });
    expect(progress).toContainEqual({ turns: 4, usage: expect.objectContaining({ totalTokens: 240 }), toolSuccesses: 3 });
    expect(result).toMatchObject({ turns: 5, toolSuccesses: 3, usage: expect.objectContaining({ totalTokens: 240 }) });
    expect(record.claudeSessionId).toBe(SESSION);
    expect(record.providerAccount).toEqual(pinnedB);
  });

  it("treats a session that already ran inference as owned even when it began without a pin", async () => {
    const stub = stubRouter([claude1, claude2]);
    const record = task();
    const attempts: Array<string | undefined> = [];
    const { input } = params(stub.router, record, { sleep: async () => { stub.cooling.clear(); return true; } });
    const result = await runWithProviderAccount(input, async (reserve) => {
      attempts.push((await reserve())?.account.id);
      if (attempts.length === 1) { record.claudeSessionId = SESSION; return limited({ turns: 4, usage: spent }); }
      return done;
    });
    expect(result.state).toBe("done");
    expect(attempts).toEqual(["primary", "primary"]);
    expect(record.claudeSessionId).toBe(SESSION);
    expect(stub.selects[1].account).toBe("primary");
  });

  it("does not park an owned session behind a reset further away than it would wait", async () => {
    const stub = stubRouter([claude1, claude2]);
    const record = task({ claudeSessionId: SESSION, providerAccount: pinnedB });
    const launch = vi.fn(async (reserve: () => Promise<unknown>) => { await reserve(); return limited({ turns: 2, usage: spent, error: "Claude usage limit reached. Try again in 3 hours." }); });
    const result = await runWithProviderAccount(params(stub.router, record, { maxWaitMs: 30 * 60_000 }).input, launch);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ state: "failed", error: expect.stringContaining("Try again in 3 hours") });
    expect(stub.limits[0].resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3 * 3600 - 60);
    expect(stub.events.at(-1)).toBe("release:lease-1");
  });

  it("does not relaunch once the turn budget is spent, on a non-limit failure, or on cancellation", async () => {
    const budget = stubRouter([claude2]);
    const record = task({ claudeSessionId: SESSION, providerAccount: pinnedB });
    const exhausted = vi.fn(async (reserve: () => Promise<unknown>) => { await reserve(); return limited({ turns: 8, usage: spent }); });
    await runWithProviderAccount(params(budget.router, record, { maxTurns: 8 }).input, exhausted);
    expect(exhausted).toHaveBeenCalledTimes(1);

    const other = stubRouter([claude2]);
    const transient = vi.fn(async (reserve: () => Promise<unknown>) => { await reserve(); return limited({ error: "fetch failed" }); });
    await runWithProviderAccount(params(other.router, task()).input, transient);
    expect(transient).toHaveBeenCalledTimes(1);
    expect(other.limits).toEqual([]);

    const cancelled = stubRouter([claude1, claude2]);
    const controller = new AbortController();
    const aborting = vi.fn(async (reserve: () => Promise<unknown>) => { await reserve(); controller.abort(new DOMException("Task cancelled", "AbortError")); return limited(); });
    await runWithProviderAccount(params(cancelled.router, task(), { signal: controller.signal }).input, aborting);
    expect(aborting).toHaveBeenCalledTimes(1);
    expect(cancelled.limits).toHaveLength(1);
  });

  it("stops after the retry bound and returns the last limit failure with every lease released", async () => {
    const { router, limits, releases, selects } = fakeRouter(() => selected(claude2));
    const record = task();
    const launch = vi.fn(async (reserve: () => Promise<unknown>) => { await reserve(); return limited(); });
    const result = await runWithProviderAccount(params(router, record, { limitRetries: 2 }).input, launch);
    expect(launch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ state: "failed", error: limitText });
    expect(limits).toHaveLength(3);
    expect(releases).toEqual(["lease-1", "lease-1", "lease-1"]);
    expect(selects.map((request) => request.owner.split(":").slice(-1)[0])).toEqual(["run-acct-task-1", "r1", "r2"]);
  });

  it("settles a wait that ends in a later attempt with the work kept on its account", async () => {
    const stub = stubRouter([claude2]);
    const record = task({ claudeSessionId: SESSION, providerAccount: pinnedB });
    let clock = 0;
    const result = await runWithProviderAccount(
      params(stub.router, record, { maxWaitMs: 20_000, pollMs: 10_000, now: () => clock, sleep: async (ms) => { clock += ms; return true; } }).input,
      async (reserve) => { await reserve(); return limited({ turns: 3, usage: spent }); },
    );
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/^Waiting for Claude account capacity ended after \d+ min: Claude 2 is cooling down; no further inference started$/);
    // The earlier attempt's work is not lost from the totals.
    expect(result).toMatchObject({ turns: 3, usage: expect.objectContaining({ totalTokens: 120 }) });
    expect(record.claudeSessionId).toBe(SESSION);
  });
});

// Opt-in contract check against the real router: STEAK_PI_ROUTER_CONTRACT=/abs/path/to/ut-provider-accounts.
// It runs the script in a throwaway HOME with synthetic nonsecret usage snapshots; no real account is read.
describe.skipIf(!process.env.STEAK_PI_ROUTER_CONTRACT)("the real ut-provider-accounts router", () => {
  const command = process.env.STEAK_PI_ROUTER_CONTRACT!;
  function sandbox() {
    const home = tempRoot();
    for (const dir of [".claude", ".claude-b", ".pi-gpt2", ".config/ultraterm"]) mkdirSync(join(home, dir), { recursive: true });
    const usage = join(home, ".ultraterm", "provider-accounts", "usage");
    mkdirSync(usage, { recursive: true, mode: 0o700 });
    for (const dir of [join(home, ".ultraterm"), join(home, ".ultraterm", "provider-accounts"), usage]) execFileSync("chmod", ["700", dir]);
    writeFileSync(join(home, ".config", "ultraterm", "claude-accounts.json"), JSON.stringify([{ id: "primary", configDir: "~/.claude" }, { id: "b", configDir: "~/.claude-b" }]));
    const at = Math.floor(Date.now() / 1000);
    const snapshot = (name: string, used: number, extra: object = {}) => writeFileSync(join(usage, `${name}.json`), JSON.stringify({ updatedAt: at, windows: [{ usedPercent: used, resetAt: at + 3600 }], ...extra }));
    snapshot("claude-primary", 60); snapshot("claude-b", 10); snapshot("codex-primary", 30); snapshot("codex-fallback", 20, { agentDir: join(home, ".pi-gpt2") });
    const env = { PATH: process.env.PATH, HOME: home } as NodeJS.ProcessEnv;
    const status = () => JSON.parse(execFileSync(command, ["status"], { env, encoding: "utf8" })) as { providers: Record<string, { accounts: Array<{ id: string; live: number }> }> };
    return { home, env, router: createProviderAccountRouter({ command, env }), status };
  }

  it("balances two providers, pins an owner, queues a cooling account, and renews and releases real leases", async () => {
    const { home, router, status } = sandbox();
    const claude = await router.select({ provider: "claude", owner: "steak-pi:1:run-a:t1" });
    expect(claude).toMatchObject({ kind: "selected", account: { id: "b", label: "Claude 2", configDir: join(home, ".claude-b") } });
    const codex = await router.select({ provider: "codex", owner: "steak-pi:1:run-a:t2" });
    expect(codex).toMatchObject({ kind: "selected", account: { id: "fallback", label: "GPT 2", agentDir: join(home, ".pi-gpt2") } });
    const lease = (claude as { lease: string }).lease;
    expect(await router.renew(lease)).toBe("renewed");
    expect(status().providers.claude.accounts.find((account) => account.id === "b")?.live).toBe(1);

    await router.limit({ provider: "claude", account: "b", resetAt: Math.floor(Date.now() / 1000) + 1800, reason: "usage limit" });
    // The owner stays on its account: it queues while that account cools down, and an existing session re-reserves it.
    expect((await router.select({ provider: "claude", account: "b", owner: "steak-pi:1:run-a:t1" })).kind).toBe("queued");
    expect((await router.select({ provider: "claude", account: "b", owner: "steak-pi:1:run-a:t1", existing: true })).kind).toBe("selected");
    // A new owner is a fresh session: the router offers the account that is not cooling down.
    expect(await router.select({ provider: "claude", owner: "steak-pi:1:run-a:t1:r1" })).toMatchObject({ kind: "selected", account: { id: "primary", label: "Claude 1" } });

    await router.release(lease);
    expect(await router.renew(lease)).toBe("expired");
    await router.limit({ provider: "claude", account: "primary", reason: "usage limit" });
    expect((await router.select({ provider: "claude", owner: "steak-pi:1:run-a:t9" })).kind).toBe("queued");
  });

  it("fails closed through a real refusal and reports a missing account as unavailable", async () => {
    const { router } = sandbox();
    expect((await router.select({ provider: "claude", account: "nope", owner: "steak-pi:1:run-a:t1" })).kind).toBe("unavailable");
    expect((await router.select({ provider: "claude", account: "b", owner: "steak-pi:1:run-a:t1" })).kind).toBe("selected");
    expect(await router.select({ provider: "claude", account: "primary", owner: "steak-pi:1:run-a:t1" })).toMatchObject({ kind: "unavailable", error: expect.stringContaining("pinned") });
  });

  it("queues a pinned resume behind a real cooldown without launching, and leaks no lease", async () => {
    const { router, status } = sandbox();
    await router.limit({ provider: "claude", account: "b", resetAt: Math.floor(Date.now() / 1000) + 1800, reason: "usage limit" });
    const launch = vi.fn(async (reserve: () => Promise<unknown>) => { await reserve(); return done; });
    const result = await runWithProviderAccount({
      provider: "claude", router, runId: "run-live", task: task({ claudeSessionId: SESSION, providerAccount: { provider: "claude", id: "b", label: "Claude 2" } }),
      signal: new AbortController().signal, onProgress: () => {}, maxWaitMs: 0,
    }, launch);
    expect(result.state).toBe("failed");
    expect(result.error).toMatch(/^Waiting for Claude account capacity ended after \d+ min: Claude 2 is cooling down until (?:\w{3} )?\d\d:\d\d; no inference started$/);
    expect(status().providers.claude.accounts.every((account) => account.live === 0)).toBe(true);
  });

  it("runs a fresh task end to end: reserve, renew while running, release", async () => {
    const { router, status } = sandbox();
    let during = -1;
    const result = await runWithProviderAccount({
      provider: "claude", router, runId: "run-live", task: task(), signal: new AbortController().signal, onProgress: () => {}, renewMs: 20,
    }, async (reserve) => {
      await reserve();
      during = status().providers.claude.accounts.reduce((sum, account) => sum + account.live, 0);
      await new Promise((resolve) => setTimeout(resolve, 80));
      return done;
    });
    expect(result.state).toBe("done");
    expect(during).toBe(1);
    expect(status().providers.claude.accounts.every((account) => account.live === 0)).toBe(true);
  });
});

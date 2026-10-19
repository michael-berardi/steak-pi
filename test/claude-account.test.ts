import { describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerAccountCommand } from "../src/subagents/provider-accounts.ts";
import {
  applyClaudeAccountEnv,
  assertClaudeAccountId,
  resolveClaudeAccount,
  type ClaudeAccountId,
  type ClaudeAccountSelection,
} from "../src/subagents/claude-account.ts";

// No real router, auth store, HOME inspection, or child process in these tests.
vi.mock("node:os", () => ({ homedir: vi.fn(() => "/synthetic/claude-home") }));
vi.mock("../src/subagents/provider-accounts.ts", () => ({ providerAccountCommand: vi.fn() }));

function response(id: ClaudeAccountId = "primary") {
  const configDir = join(homedir(), id === "primary" ? ".claude" : ".claude-b");
  return {
    ok: true,
    provider: "claude",
    account: { id, label: id === "primary" ? "Claude 1" : "Claude 2", configDir, eligible: true,
      launchEnv: id === "primary" ? { unset: ["CLAUDE_CONFIG_DIR"] } : { set: { CLAUDE_CONFIG_DIR: configDir } } },
  };
}

function selection(id: ClaudeAccountId): ClaudeAccountSelection {
  return id === "primary"
    ? { id, label: "Claude 1", configMode: "default" }
    : { id, label: "Claude 2", configMode: "explicit", configDir: join(homedir(), ".claude-b") };
}

async function refuses(value: unknown, id: ClaudeAccountId = "primary") {
  const command = vi.fn(async () => value);
  await expect(resolveClaudeAccount(id, command)).rejects.toThrow(/Unsafe/);
  // Refusal never reserves, releases, retries another account, or falls back.
  expect(command).toHaveBeenCalledExactlyOnceWith(["select", "--provider", "claude", "--account", id]);
}

describe("read-only Claude account selection", () => {
  it.each(["primary", "b"] as const)("selects only %s with canonical HOME metadata", async id => {
    const before = { ...process.env };
    const metadata = response(id);
    const original = structuredClone(metadata);
    const command = vi.fn(async () => metadata);
    expect(homedir()).toBe("/synthetic/claude-home");
    expect(await resolveClaudeAccount(id, command)).toEqual(selection(id));
    expect(command).toHaveBeenCalledExactlyOnceWith(["select", "--provider", "claude", "--account", id]);
    expect(metadata).toEqual(original);
    expect(process.env).toEqual(before);
  });

  it("uses the existing provider command by default", async () => {
    vi.mocked(providerAccountCommand).mockResolvedValueOnce(response("b"));
    expect(await resolveClaudeAccount("b")).toEqual(selection("b"));
    expect(providerAccountCommand).toHaveBeenLastCalledWith(["select", "--provider", "claude", "--account", "b"]);
  });

  it.each([undefined, null, "", "auto", "fallback", "Primary", "primary\n", 0, {}, ["b"]].map(value => [value]))(
    "rejects unknown runtime account ID %j before contacting the router", async value => {
      const command = vi.fn(async () => response());
      expect(() => assertClaudeAccountId(value)).toThrow(/Unknown/);
      await expect(resolveClaudeAccount(value as ClaudeAccountId, command)).rejects.toThrow(/Unknown/);
      expect(command).not.toHaveBeenCalled();
    },
  );

  it.each(["primary", "b"] as const)("accepts exact runtime ID %s", id => {
    expect(() => assertClaudeAccountId(id)).not.toThrow();
  });

  it("propagates router refusal without selecting a different account", async () => {
    const error = new Error("router refused: no eligible Claude account");
    const command = vi.fn(async () => { throw error; });
    await expect(resolveClaudeAccount("b", command)).rejects.toBe(error);
    expect(command).toHaveBeenCalledExactlyOnceWith(["select", "--provider", "claude", "--account", "b"]);
  });

  it.each([undefined, null, false, "{}", [], {}, { ok: false }, { ok: "true" }, { ok: 1 }].map(value => [value]))(
    "refuses malformed or non-success response %j", async value => { await refuses(value); },
  );

  it("rejects missing/wrong provider, account, labels and eligibility", async () => {
    for (const provider of [undefined, "codex", "claude-code", "Claude"]) {
      await refuses({ ...response(), provider });
    }
    for (const account of [undefined, null, [], {}, { ...response().account, id: "unknown" },
      { ...response().account, id: "b" }, { ...response().account, label: undefined },
      { ...response().account, label: "Claude 2" }, { ...response().account, label: "Claude 1\n" },
      { ...response().account, eligible: false }, { ...response().account, eligible: "true" }]) {
      await refuses({ ...response(), account });
    }
    await refuses(response("b"), "primary");
    await refuses(response("primary"), "b");
  });

  it.each(["primary", "b"] as const)("rejects noncanonical %s config paths", async id => {
    const canonical = response(id).account.configDir;
    for (const configDir of [undefined, null, 3, "", ".claude", "~/.claude", "/tmp/unrelated",
      join(homedir(), id === "primary" ? ".claude-b" : ".claude"), `${canonical}/`,
      `${canonical}/../${id === "primary" ? ".claude" : ".claude-b"}`, `${canonical}\n`,
      `${canonical}\u0000`, `${canonical}\u0085`, `/${"x".repeat(1024)}`]) {
      await refuses({ ...response(id), account: { ...response(id).account, configDir } }, id);
    }
  });

  it("requires primary's exact unset, not explicit ~/.claude or any extra mutation", async () => {
    for (const launchEnv of [undefined, null, [], {}, { unset: [] }, { unset: "CLAUDE_CONFIG_DIR" },
      { unset: ["CLAUDE_CONFIG_DIR", "HOME"] }, { unset: ["CLAUDE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] },
      { unset: ["HOME"] }, { set: { CLAUDE_CONFIG_DIR: join(homedir(), ".claude") } },
      { unset: ["CLAUDE_CONFIG_DIR"], set: {} }, { unset: ["CLAUDE_CONFIG_DIR"], extra: true }]) {
      await refuses({ ...response(), account: { ...response().account, launchEnv } });
    }
  });

  it("requires b's exact set and refuses env injection or ambiguous mutations", async () => {
    const configDir = join(homedir(), ".claude-b");
    for (const launchEnv of [undefined, null, [], {}, { set: [] }, { set: {} }, { unset: ["CLAUDE_CONFIG_DIR"] },
      { set: { CLAUDE_CONFIG_DIR: join(homedir(), ".claude") } }, { set: { CLAUDE_CONFIG_DIR: `${configDir}\n` } },
      { set: { CLAUDE_CONFIG_DIR: configDir, HOME: "/tmp" } },
      { set: { CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: "synthetic-not-a-key" } },
      { set: { CLAUDE_CONFIG_DIR: configDir }, unset: [] },
      { set: { CLAUDE_CONFIG_DIR: configDir }, append: { PATH: "/tmp" } }]) {
      await refuses({ ...response("b"), account: { ...response("b").account, launchEnv } }, "b");
    }
  });
});

describe("task-local Claude account environments", () => {
  it("returns a fresh unselected environment and preserves inherited account context", () => {
    const base = Object.freeze({ PATH: "/synthetic/bin", CLAUDE_CONFIG_DIR: "/synthetic/inherited", ULTRATERM_PROVIDER_ACCOUNT: "b" });
    const result = applyClaudeAccountEnv(base);
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
    result.PATH = "/synthetic/child-only";
    expect(base.PATH).toBe("/synthetic/bin");
    expect(applyClaudeAccountEnv({})).toEqual({});
    for (const id of ["primary", "b", "fallback", "Claude2"]) {
      expect(applyClaudeAccountEnv({ ULTRATERM_PROVIDER_ACCOUNT: id })).toEqual({ ULTRATERM_PROVIDER_ACCOUNT: id });
    }
  });

  it("distinguishes explicit inherited ~/.claude from selected primary's default unset", () => {
    const base = Object.freeze({ CLAUDE_CONFIG_DIR: join(homedir(), ".claude"), ULTRATERM_PROVIDER_ACCOUNT: "b", KEEP: "value" });
    expect(applyClaudeAccountEnv(base).CLAUDE_CONFIG_DIR).toBe(join(homedir(), ".claude"));
    const primary = applyClaudeAccountEnv(base, selection("primary"));
    expect(primary).toEqual({ ULTRATERM_PROVIDER_ACCOUNT: "primary", KEEP: "value" });
    expect(Object.hasOwn(primary, "CLAUDE_CONFIG_DIR")).toBe(false);
    expect(base.CLAUDE_CONFIG_DIR).toBe(join(homedir(), ".claude"));
  });

  it("isolates primary/b children without mutating inputs, selections, or process.env", async () => {
    const before = { ...process.env };
    const base = Object.freeze({ CLAUDE_CONFIG_DIR: "/synthetic/inherited", ULTRATERM_PROVIDER_ACCOUNT: "primary", KEEP: "value" });
    const [primarySelection, bSelection] = await Promise.all([
      resolveClaudeAccount("primary", async () => response("primary")),
      resolveClaudeAccount("b", async () => response("b")),
    ]);
    Object.freeze(primarySelection); Object.freeze(bSelection);
    const primary = applyClaudeAccountEnv(base, primarySelection);
    const b = applyClaudeAccountEnv(base, bSelection);
    expect(primary).toEqual({ ULTRATERM_PROVIDER_ACCOUNT: "primary", KEEP: "value" });
    expect(b).toEqual({ CLAUDE_CONFIG_DIR: join(homedir(), ".claude-b"), ULTRATERM_PROVIDER_ACCOUNT: "b", KEEP: "value" });
    expect(applyClaudeAccountEnv(b, primarySelection)).toEqual(primary);
    expect(applyClaudeAccountEnv(primary, bSelection)).toEqual(b);
    expect(primary).not.toBe(b);
    expect(base).toEqual({ CLAUDE_CONFIG_DIR: "/synthetic/inherited", ULTRATERM_PROVIDER_ACCOUNT: "primary", KEEP: "value" });
    expect(process.env).toEqual(before);
  });

  it("treats an empty inherited config variable as unset, not explicit ~/.claude", () => {
    expect(applyClaudeAccountEnv({ CLAUDE_CONFIG_DIR: "" })).toEqual({});
  });

  it.each(["relative", "~/.claude", "/ok\nBAD=value", "/ok\r", "/ok\u0000", "/ok\u007f", "/ok\u0085", `/${"x".repeat(1024)}`, 123, null])(
    "fails closed on unsafe inherited directory %j even with a selected account", path => {
      const base = { CLAUDE_CONFIG_DIR: path } as NodeJS.ProcessEnv;
      for (const selected of [undefined, selection("primary"), selection("b")]) {
        expect(() => applyClaudeAccountEnv(base, selected)).toThrow(/Unsafe/);
      }
    },
  );

  it("accepts a control-free absolute inherited path up to exactly 1024 characters", () => {
    const path = `/${"x".repeat(1023)}`;
    expect(applyClaudeAccountEnv({ CLAUDE_CONFIG_DIR: path }).CLAUDE_CONFIG_DIR).toBe(path);
  });

  it.each(["", "claude:b", "b\n", "primary\u0000", "x".repeat(65)])(
    "fails closed on invalid inherited account label %j", label => {
      const base = { ULTRATERM_PROVIDER_ACCOUNT: label } as NodeJS.ProcessEnv;
      for (const selected of [undefined, selection("primary"), selection("b")]) {
        expect(() => applyClaudeAccountEnv(base, selected)).toThrow(/Unsafe/);
      }
    },
  );

  it("revalidates forged selections at the launch boundary", () => {
    for (const forged of [null, {}, { ...selection("b"), id: "unknown" },
      { ...selection("primary"), configMode: "explicit", configDir: join(homedir(), ".claude") },
      { ...selection("primary"), configDir: join(homedir(), ".claude-b") },
      { ...selection("b"), configMode: "default" }, { ...selection("b"), label: "Claude 1" },
      { ...selection("b"), configDir: "/tmp/ambient" }, { ...selection("b"), configDir: undefined }]) {
      expect(() => applyClaudeAccountEnv({}, forged as ClaudeAccountSelection)).toThrow();
    }
  });
});

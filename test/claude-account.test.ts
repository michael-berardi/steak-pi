import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerAccountCommand } from "../src/subagents/provider-accounts.ts";
import {
  applyClaudeAccountEnv,
  assertClaudeAccountId,
  assertKnownClaudeAccount,
  ClaudeAccountEligibilityError,
  ClaudeAccountFolderConflictError,
  isClaudeAccountId,
  resolveClaudeAccount,
  type ClaudeAccountId,
  type ClaudeAccountSelection,
} from "../src/subagents/claude-account.ts";
import { TEAM_REGISTRY, stageClaudeHome } from "./helpers/claude-registry-fixture.ts";

// No real router, auth store, HOME inspection, or child process in these tests. The registry cases below
// stage their own private HOME on disk and point the mocked homedir at it.
vi.mock("node:os", async (importOriginal) => ({ ...await importOriginal<typeof import("node:os")>(), homedir: vi.fn(() => "/synthetic/claude-home") }));
vi.mock("../src/subagents/provider-accounts.ts", () => ({ providerAccountCommand: vi.fn() }));

const staged: Array<{ remove(): void }> = [];
afterEach(() => {
  vi.mocked(homedir).mockReturnValue("/synthetic/claude-home");
  for (const home of staged.splice(0)) home.remove();
});

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

  it.each([undefined, null, "", "Primary", "primary\n", "Team-2", "team-2-", "-team-2", "team--2", "team_2", "x".repeat(25), 0, {}, ["b"]].map(value => [value]))(
    "rejects malformed runtime account ID %j before contacting the router", async value => {
      const command = vi.fn(async () => response());
      expect(() => assertClaudeAccountId(value)).toThrow(/Unknown/);
      expect(isClaudeAccountId(value)).toBe(false);
      await expect(resolveClaudeAccount(value as ClaudeAccountId, command)).rejects.toThrow(/Unknown/);
      expect(command).not.toHaveBeenCalled();
    },
  );

  it.each(["auto", "fallback", "team-2", "unknown"])("rejects well-formed but undefined account ID %s before contacting the router", async id => {
    const command = vi.fn(async () => response());
    expect(() => assertClaudeAccountId(id)).not.toThrow();
    expect(() => assertKnownClaudeAccount(id)).toThrow(`Unknown Claude account ID "${id}": not defined in claude-accounts.json`);
    await expect(resolveClaudeAccount(id, command)).rejects.toThrow(/Unknown Claude account ID/);
    expect(command).not.toHaveBeenCalled();
  });

  it.each(["primary", "b", "team-2", "team-3", "a1-b2-c3", "x".repeat(24)])("accepts exact runtime ID %s", id => {
    expect(() => assertClaudeAccountId(id)).not.toThrow();
    expect(isClaudeAccountId(id)).toBe(true);
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

describe("registry-defined Claude accounts (claude-accounts.json)", () => {
  function stage(registry: unknown, folders: readonly string[] = [".claude-team-2"]) {
    const home = stageClaudeHome(registry, folders);
    staged.push(home);
    vi.mocked(homedir).mockReturnValue(home.home);
    return home.home;
  }
  function teamResponse(home: string, overrides: Record<string, unknown> = {}) {
    const configDir = join(home, ".claude-team-2");
    return { ok: true, provider: "claude", account: { id: "team-2", label: "Claude (Team)", configDir, eligible: true,
      launchEnv: { set: { CLAUDE_CONFIG_DIR: configDir } }, ...overrides } };
  }

  it("selects team-2 with its registry label and folder, never changing process.env", async () => {
    const home = stage(TEAM_REGISTRY);
    const before = { ...process.env };
    const command = vi.fn(async () => teamResponse(home));
    expect(await resolveClaudeAccount("team-2", command)).toEqual({
      id: "team-2", label: "Claude (Team)", configMode: "explicit", configDir: join(home, ".claude-team-2"),
    });
    expect(command).toHaveBeenCalledExactlyOnceWith(["select", "--provider", "claude", "--account", "team-2"]);
    expect(process.env).toEqual(before);
  });

  it("launches team-2 on its own folder and overrides an inherited one", async () => {
    const home = stage(TEAM_REGISTRY);
    const selected = await resolveClaudeAccount("team-2", async () => teamResponse(home));
    const base = Object.freeze({ CLAUDE_CONFIG_DIR: join(home, ".claude-b"), ULTRATERM_PROVIDER_ACCOUNT: "b", KEEP: "value" });
    expect(applyClaudeAccountEnv(base, selected)).toEqual({ CLAUDE_CONFIG_DIR: join(home, ".claude-team-2"), ULTRATERM_PROVIDER_ACCOUNT: "team-2", KEEP: "value" });
    expect(base.ULTRATERM_PROVIDER_ACCOUNT).toBe("b");
  });

  it("keeps primary (unset) and b (explicit ~/.claude-b) unchanged beside team-2", async () => {
    const home = stage(TEAM_REGISTRY, [".claude-b", ".claude-team-2"]);
    const bDir = join(home, ".claude-b");
    expect(await resolveClaudeAccount("primary", async () => ({ ...response("primary"), account: { ...response("primary").account, configDir: join(home, ".claude") } })))
      .toEqual({ id: "primary", label: "Claude 1", configMode: "default" });
    expect(await resolveClaudeAccount("b", async () => ({ ...response("b"), account: { ...response("b").account, configDir: bDir, launchEnv: { set: { CLAUDE_CONFIG_DIR: bDir } } } })))
      .toEqual({ id: "b", label: "Claude 2", configMode: "explicit", configDir: bDir });
  });

  it("knows team-2 only from the registry", () => {
    stage(undefined);
    expect(() => assertKnownClaudeAccount("team-2")).toThrow(/Unknown Claude account ID "team-2"/);
    stage(TEAM_REGISTRY);
    expect(() => assertKnownClaudeAccount("team-2")).not.toThrow();
    expect(() => assertKnownClaudeAccount("kx")).toThrow(/Unknown Claude account ID "kx"/);
  });

  it("names accounts by position when the registry gives no label, as the router does", async () => {
    const home = stage([{ id: "primary", configDir: "~/.claude" }, { id: "team-2", configDir: "~/.claude-team-2" },
      { id: "zed", configDir: "~/.claude-zed", label: "Claude <x>" }, { id: "team-2", configDir: "~/.claude-other", label: "Duplicate" }], [".claude-team-2", ".claude-zed"]);
    expect((await resolveClaudeAccount("team-2", async () => teamResponse(home, { label: "Claude 2" }))).label).toBe("Claude 2");
    const zed = join(home, ".claude-zed");
    expect((await resolveClaudeAccount("zed", async () => ({ ok: true, provider: "claude", account: { id: "zed", label: "Claude 3", configDir: zed, eligible: true, launchEnv: { set: { CLAUDE_CONFIG_DIR: zed } } } }))).label).toBe("Claude 3");
    await refuses(teamResponse(home, { label: "Claude (Team)" }), "team-2");
  });

  it("derives the b label and folder from the conventional defaults when the registry omits it", async () => {
    const home = stage([{ id: "primary", configDir: "~/.claude" }, { id: "team-2", configDir: "~/.claude-team-2" }]);
    const bDir = join(home, ".claude-b");
    expect(await resolveClaudeAccount("b", async () => ({ ...response("b"), account: { ...response("b").account, configDir: bDir, launchEnv: { set: { CLAUDE_CONFIG_DIR: bDir } } } })))
      .toMatchObject({ id: "b", label: "Claude 2", configDir: bDir });
  });

  it("refuses a router answer that disagrees with the registry about team-2", async () => {
    const home = stage(TEAM_REGISTRY);
    const teamDir = join(home, ".claude-team-2");
    for (const overrides of [{ label: "Claude 3" }, { label: "Claude 2" }, { id: "b" }, { configDir: join(home, ".claude-b") },
      { launchEnv: { set: { CLAUDE_CONFIG_DIR: join(home, ".claude-b") } } }, { launchEnv: { unset: ["CLAUDE_CONFIG_DIR"] } },
      { launchEnv: { set: { CLAUDE_CONFIG_DIR: teamDir, HOME: "/tmp" } } }, { eligible: false }]) {
      await refuses(teamResponse(home, overrides), "team-2");
    }
  });

  it.each([
    ["outside HOME", "/tmp/claude-team-2"], ["relative", ".claude-team-2"], ["escaping HOME", "~/../claude-team-2"], ["HOME itself", "~"], ["empty", ""],
  ])("ignores a registry entry whose configDir is %s", (_name, configDir) => {
    stage([{ id: "team-2", configDir }], []);
    expect(() => assertKnownClaudeAccount("team-2")).toThrow(/Unknown Claude account ID "team-2"/);
  });

  it("fails closed on an unusable registry but still resolves primary's default folder", async () => {
    for (const [name, prepare] of [
      ["invalid JSON", () => stage("{not json", [])],
      ["not a list", () => stage({ "team-2": "~/.claude-team-2" }, [])],
      ["oversized", () => stage(" ".repeat(70 * 1024), [])],
      ["symlinked file", () => {
        const home = stage(undefined, []);
        mkdirSync(join(home, ".config", "ultraterm"), { recursive: true, mode: 0o700 });
        writeFileSync(join(home, "real.json"), JSON.stringify(TEAM_REGISTRY), { mode: 0o600 });
        symlinkSync(join(home, "real.json"), join(home, ".config", "ultraterm", "claude-accounts.json"));
      }],
      ["group-writable file", () => { const home = stage(TEAM_REGISTRY, [".claude-team-2"]); chmodSync(join(home, ".config", "ultraterm", "claude-accounts.json"), 0o664); }],
      ["group-writable folder", () => { const home = stage(TEAM_REGISTRY, [".claude-team-2"]); chmodSync(join(home, ".config", "ultraterm"), 0o770); }],
    ] as const) {
      prepare();
      for (const id of ["team-2", "b"]) expect(() => assertKnownClaudeAccount(id), `${name}: ${id}`).toThrow(/registry is unusable/);
      expect(await resolveClaudeAccount("primary", async () => ({ ...response("primary"), account: { ...response("primary").account, configDir: join(homedir(), ".claude") } })), name)
        .toEqual({ id: "primary", label: "Claude 1", configMode: "default" });
    }
  });

  it("treats the router's ok:true select for the requested id as its eligibility verdict, with no eligible field", async () => {
    const home = stage(TEAM_REGISTRY);
    const { eligible: _omitted, ...answer } = teamResponse(home).account;
    const command = vi.fn(async () => ({ ok: true, provider: "claude", account: answer }));
    await expect(resolveClaudeAccount("team-2", command)).resolves.toEqual({
      id: "team-2", label: "Claude (Team)", configMode: "explicit", configDir: join(home, ".claude-team-2"),
    });
    expect(command).toHaveBeenCalledExactlyOnceWith(["select", "--provider", "claude", "--account", "team-2"]);
  });

  it("refuses a registry account the router reports queued or reserved, naming the router's reason", async () => {
    const home = stage(TEAM_REGISTRY);
    const { eligible: _omitted, ...answer } = teamResponse(home).account;
    const held: Array<[Record<string, unknown>, RegExp]> = [
      [{ queued: true }, /"team-2" is not eligible \(the router reported it queued or reserved\)/],
      [{ reserved: true }, /"team-2" is not eligible \(the router reported it queued or reserved\)/],
      [{ state: "queued" }, /"team-2" is not eligible \(the router reported it queued or reserved\)/],
      [{ state: "reserved" }, /"team-2" is not eligible \(the router reported it queued or reserved\)/],
      [{ stateText: "reserved for its owner" }, /"team-2" is not eligible \(reserved for its owner\)/],
    ];
    for (const [extra, reason] of held) {
      const command = vi.fn(async () => ({ ok: true, provider: "claude", account: { ...answer, ...extra } }));
      const failure = await resolveClaudeAccount("team-2", command).then(() => undefined, (error: unknown) => error);
      expect(failure, JSON.stringify(extra)).toBeInstanceOf(ClaudeAccountEligibilityError);
      expect((failure as Error).message, JSON.stringify(extra)).toMatch(reason);
      expect((failure as Error).message).toMatch(/nothing was launched$/);
      expect(command).toHaveBeenCalledExactlyOnceWith(["select", "--provider", "claude", "--account", "team-2"]);
    }
    // A state text without a verdict is still refused when it names a reservation.
    await expect(resolveClaudeAccount("team-2", async () => teamResponse(home, { eligible: undefined, stateText: "reserved for its owner" }))).rejects.toThrow(ClaudeAccountEligibilityError);
  });

  it("refuses eligible:false and non-true verdicts with the router's own reason", async () => {
    const home = stage(TEAM_REGISTRY);
    await expect(resolveClaudeAccount("team-2", async () => teamResponse(home, { eligible: false, state: "reserved", stateText: "reserved for its owner" })))
      .rejects.toThrow(/"team-2" is not eligible \(reserved for its owner\)/);
    const noisy = await resolveClaudeAccount("team-2", async () => teamResponse(home, { eligible: false, stateText: "reserved\nfor\u001b its owner" })).catch((error: unknown) => error);
    expect(noisy).toBeInstanceOf(ClaudeAccountEligibilityError);
    expect((noisy as Error).message).toContain('"team-2" is not eligible (reserved for its owner)');
    expect((noisy as Error).message).not.toMatch(/[\u0000-\u001f]/);
    await expect(resolveClaudeAccount("team-2", async () => teamResponse(home, { eligible: false, ineligibleReason: "below its floor" }))).rejects.toThrow(/\(below its floor\)/);
    await expect(resolveClaudeAccount("team-2", async () => teamResponse(home, { eligible: false }))).rejects.toThrow(/\(the router reported it ineligible\)/);
    for (const verdict of ["true", 1, null, {}]) {
      await expect(resolveClaudeAccount("team-2", async () => teamResponse(home, { eligible: verdict })), String(verdict)).rejects.toThrow(ClaudeAccountEligibilityError);
    }
    // The conventional accounts keep their lenient absent verdict, but eligible:false is refused for them too.
    await expect(resolveClaudeAccount("b", async () => ({ ...response("b"), account: { ...response("b").account, eligible: false, stateText: "cooling down" } }))).rejects.toThrow(/"b" is not eligible \(cooling down\)/);
  });

  it("accepts an absent verdict for primary, b and registry accounts alike when the router selects them ok:true", async () => {
    const home = stage(TEAM_REGISTRY, [".claude-b", ".claude-team-2"]);
    for (const id of ["primary", "b"] as const) {
      const { eligible: _omitted, ...account } = response(id).account;
      await expect(resolveClaudeAccount(id, async () => ({ ok: true, provider: "claude", account })), id).resolves.toMatchObject({ id });
    }
    const { eligible: _omitted, ...team } = teamResponse(home).account;
    await expect(resolveClaudeAccount("team-2", async () => ({ ok: true, provider: "claude", account: team }))).resolves.toMatchObject({ id: "team-2" });
  });

  it("still refuses a non-ok or mismatched select answer for a registry account", async () => {
    const home = stage(TEAM_REGISTRY);
    const { eligible: _omitted, ...team } = teamResponse(home).account;
    await refuses({ ok: false, provider: "claude", account: team }, "team-2");
    await refuses({ ok: true, provider: "claude", account: { ...team, id: "team-3" } }, "team-2");
  });

  it("refuses a registry entry whose folder another account already claims, by name", async () => {
    const claimed: Array<[string, unknown[], string]> = [
      ["the same folder as an earlier entry", [{ id: "team-2", configDir: "~/.claude-shared" }, { id: "team-3", configDir: "~/.claude-shared" }], "team-3"],
      ["a spelling of the same folder", [{ id: "team-2", configDir: "~/.claude-shared" }, { id: "team-3", configDir: "~/x/../.claude-shared/" }], "team-3"],
      ["primary's default folder", [{ id: "team-3", configDir: "~/.claude" }], "team-3"],
      ["primary's remapped folder", [{ id: "primary", configDir: "~/.claude-main" }, { id: "team-3", configDir: "~/.claude-main" }], "team-3"],
      ["the default folder while primary is remapped", [{ id: "primary", configDir: "~/.claude-main" }, { id: "team-3", configDir: "~/.claude" }], "team-3"],
      ["primary's folder named before primary itself", [{ id: "team-3", configDir: "~/.claude-main" }, { id: "primary", configDir: "~/.claude-main" }], "team-3"],
      ["the conventional b folder, when the registry omits b", [{ id: "team-3", configDir: "~/.claude-b" }], "b"],
    ];
    for (const [name, registry, refusedId] of claimed) {
      stage(registry, [".claude-shared", ".claude-main", ".claude-b", "x"]);
      const failure = (() => { try { assertKnownClaudeAccount(refusedId); } catch (error) { return error; } })();
      expect(failure, name).toBeInstanceOf(ClaudeAccountFolderConflictError);
      expect((failure as Error).message, name).toMatch(new RegExp(`Claude account "${refusedId}" is refused: its config folder .* is already claimed by account "[a-z0-9-]+"`));
    }
  });

  it("keeps the first claimant of a folder and never maps a second id onto its identity", async () => {
    const home = stage([{ id: "team-2", configDir: "~/.claude-shared" }, { id: "team-3", configDir: "~/.claude-shared" }], [".claude-shared"]);
    const shared = join(home, ".claude-shared");
    const command = vi.fn(async () => teamResponse(home, { label: "Claude 2", configDir: shared, launchEnv: { set: { CLAUDE_CONFIG_DIR: shared } } }));
    await expect(resolveClaudeAccount("team-2", command)).resolves.toMatchObject({ id: "team-2", configMode: "explicit", configDir: shared });
    const second = vi.fn(async () => teamResponse(home, { id: "team-3", label: "Claude 3", configDir: shared, launchEnv: { set: { CLAUDE_CONFIG_DIR: shared } } }));
    await expect(resolveClaudeAccount("team-3", second)).rejects.toThrow(ClaudeAccountFolderConflictError);
    expect(second).not.toHaveBeenCalled();
    expect(() => applyClaudeAccountEnv({}, { id: "team-3", label: "Claude 3", configMode: "explicit", configDir: shared })).toThrow(ClaudeAccountFolderConflictError);
  });

  it("applies default (unset CLAUDE_CONFIG_DIR) mode to primary alone", async () => {
    const home = stage([{ id: "primary", configDir: "~/.claude" }, { id: "team-3", configDir: "~/.claude" }], []);
    const primary = await resolveClaudeAccount("primary", async () => ({ ...response("primary"), account: { ...response("primary").account, configDir: join(home, ".claude") } }));
    expect(primary).toEqual({ id: "primary", label: "Claude 1", configMode: "default" });
    expect(() => assertKnownClaudeAccount("team-3")).toThrow(/is already claimed by account "primary"/);
    // A forged default-mode selection for another id is refused at the launch boundary as well.
    expect(() => applyClaudeAccountEnv({ CLAUDE_CONFIG_DIR: join(home, ".claude-b") }, { id: "team-3", label: "Claude 2", configMode: "default" })).toThrow();
  });

  it("holds explicit account folders to 0700 and the default folder to no group/other write", async () => {
    const home = stage([{ id: "team-2", configDir: "~/.claude-team-2" }], [".claude-team-2"]);
    mkdirSync(join(home, ".claude"), { mode: 0o755 });
    chmodSync(join(home, ".claude"), 0o755);
    // ~/.claude at 0755 is fine for primary (default mode refuses only group/other write) ...
    await expect(resolveClaudeAccount("primary", async () => ({ ...response("primary"), account: { ...response("primary").account, configDir: join(home, ".claude") } }))).resolves.toMatchObject({ configMode: "default" });
    chmodSync(join(home, ".claude"), 0o775);
    expect(() => assertKnownClaudeAccount("primary")).toThrow(/config folder is unsafe \(.*too open\)/);
    // ... while an explicit folder must show no group/other bit at all.
    chmodSync(join(home, ".claude-team-2"), 0o750);
    expect(() => assertKnownClaudeAccount("team-2")).toThrow(/config folder is unsafe \(.*too open\)/);
    chmodSync(join(home, ".claude-team-2"), 0o700);
    expect(() => assertKnownClaudeAccount("team-2")).not.toThrow();
  });

  it("refuses a config folder that is a symlink, open to others, or reached through an open parent", async () => {
    const home = stage(TEAM_REGISTRY, []);
    const command = vi.fn(async () => teamResponse(home));
    mkdirSync(join(home, "elsewhere"), { mode: 0o700 });
    symlinkSync(join(home, "elsewhere"), join(home, ".claude-team-2"));
    await expect(resolveClaudeAccount("team-2", command)).rejects.toThrow(/config folder is unsafe \(.*symlink\)/);
    expect(command).not.toHaveBeenCalled();
    const open = stage(TEAM_REGISTRY, []);
    mkdirSync(join(open, ".claude-team-2"), { mode: 0o755 });
    chmodSync(join(open, ".claude-team-2"), 0o755);
    await expect(resolveClaudeAccount("team-2", command)).rejects.toThrow(/config folder is unsafe \(.*too open\)/);
    expect(() => applyClaudeAccountEnv({}, { id: "team-2", label: "Claude (Team)", configMode: "explicit", configDir: join(open, ".claude-team-2") })).toThrow(/unsafe/);
    expect(command).not.toHaveBeenCalled();
  });

  it("revalidates a forged team-2 selection at the launch boundary", () => {
    const home = stage(TEAM_REGISTRY);
    const good: ClaudeAccountSelection = { id: "team-2", label: "Claude (Team)", configMode: "explicit", configDir: join(home, ".claude-team-2") };
    expect(applyClaudeAccountEnv({}, good)).toEqual({ CLAUDE_CONFIG_DIR: join(home, ".claude-team-2"), ULTRATERM_PROVIDER_ACCOUNT: "team-2" });
    for (const forged of [{ ...good, label: "Claude 3" }, { ...good, configMode: "default", configDir: undefined },
      { ...good, configDir: join(home, ".claude-b") }, { ...good, configDir: undefined }, { ...good, id: "kx" }]) {
      expect(() => applyClaudeAccountEnv({}, forged as ClaudeAccountSelection)).toThrow();
    }
  });
});

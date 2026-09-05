import { afterEach, describe, expect, it, vi } from "vitest";
import sessionTitleExtension, {
  deriveSessionTitle,
} from "../extensions/session-title.ts";

describe("deriveSessionTitle", () => {
  it("titles sessions from the first real prompt", () => {
    expect(deriveSessionTitle("Fix the login bug")).toBe(
      "Fix the login bug",
    );
  });

  it("collapses multi-line prompts into one readable line", () => {
    expect(deriveSessionTitle("  Fix\nthe\tlogin  bug ")).toBe(
      "Fix the login bug",
    );
  });

  it("never titles from slash commands or blank input", () => {
    expect(deriveSessionTitle("/rename Literal Name")).toBeNull();
    expect(deriveSessionTitle("   \n  ")).toBeNull();
    expect(deriveSessionTitle("")).toBeNull();
  });

  it("caps long prompts on a character budget with an ellipsis", () => {
    const title = deriveSessionTitle("word ".repeat(40));
    expect(title).not.toBeNull();
    expect(Array.from(title ?? "").length).toBe(80);
    expect(title?.endsWith("\u2026")).toBe(true);
  });

  it("keeps emoji intact when truncating", () => {
    const title = deriveSessionTitle("\u{1F600}".repeat(100));
    expect(Array.from(title ?? "").length).toBe(80);
    expect(title?.startsWith("\u{1F600}")).toBe(true);
  });

  it.each([
    ["ZWJ emoji", "\u{1F469}\u200d\u{1F4BB}"],
    ["regional flags", "\u{1F1FA}\u{1F1F8}"],
    ["combining marks", "e\u0301"],
    ["CJK", "\u754c"],
  ])("uses grapheme-safe budgets for %s", (_label, grapheme) => {
    const withinBudget = grapheme.repeat(80);
    expect(deriveSessionTitle(withinBudget)).toBe(withinBudget);
    expect(deriveSessionTitle(grapheme.repeat(81))).toBe(
      `${grapheme.repeat(79)}\u2026`,
    );
  });
});

describe("session title extension wiring", () => {
  it("sets the session name once from the first real prompt and never overrides renames", () => {
    const handlers: Array<(event: { text: string }) => void> = [];
    let currentName: string | undefined;
    const calls: string[] = [];
    const api = {
      on(_event: string, handler: (event: { text: string }) => void) {
        if (_event === "input") handlers.push(handler);
      },
      getSessionName: () => currentName,
      setSessionName: (name: string) => {
        calls.push(name);
        currentName = name;
      },
    };

    sessionTitleExtension(api as never);
    expect(handlers.length).toBe(1);

    handlers[0]?.({ text: "/rename Kept" });
    handlers[0]?.({ text: "First real prompt" });
    expect(calls).toEqual(["First real prompt"]);

    handlers[0]?.({ text: "Second prompt" });
    expect(calls.length).toBe(1);
  });

  it("ignores extension-generated input before the first real prompt", () => {
    let handler!: (event: { text: string; source: string }) => void;
    const setSessionName = vi.fn();
    sessionTitleExtension({
      on(name: string, next: typeof handler) { if (name === "input") handler = next; },
      getSessionName: () => undefined,
      setSessionName,
    } as never);
    handler({ text: "Worker completion notice", source: "extension" });
    expect(setSessionName).not.toHaveBeenCalled();
    handler({ text: "Real user task", source: "interactive" });
    expect(setSessionName).toHaveBeenCalledWith("Real user task");
  });

  it("contains session metadata failures instead of interrupting input", () => {
    let handler: ((event: { text: string }) => void) | undefined;
    const api = {
      on(_event: string, next: (event: { text: string }) => void) {
        if (_event === "input") handler = next;
      },
      getSessionName() {
        throw new Error("session store unavailable");
      },
      setSessionName() {
        throw new Error("must not be reached");
      },
    };

    sessionTitleExtension(api as never);
    expect(() => handler?.({ text: "Keep working" })).not.toThrow();
  });
});

describe("pane session binding (mock tmux only)", () => {
  afterEach(() => vi.unstubAllEnvs());
  function setup() {
    vi.stubEnv("TMUX_PANE", "%13");
    vi.stubEnv("ULTRATERM_SLOT", "99");
    vi.stubEnv("TMUX_BIN", "/mock/tmux");
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "" });
    sessionTitleExtension({ on: (name: string, handler: any) => handlers.set(name, handler), exec } as never);
    const start = (file: string | undefined, mode = "tui", reason = "startup") =>
      handlers.get("session_start")!({ reason }, { mode, sessionManager: { getSessionFile: () => file } });
    return { exec, start, stop: () => handlers.get("session_shutdown")!() };
  }
  it.each(["startup", "new", "resume", "fork", "reload"])("publishes actual file on %s using pane, not stale slot", async (reason) => {
    const { exec, start } = setup();
    await start("/tmp/session with spaces.jsonl", "tui", reason);
    expect(exec).toHaveBeenCalledWith("/mock/tmux", ["set-option", "-p", "-t", "%13", "@pi-session-file", "/tmp/session with spaces.jsonl"], { timeout: 1000 });
  });
  it("does not publish for child SDK/RPC processes or outside tmux", async () => {
    const { exec, start } = setup();
    await start("/tmp/child.jsonl", "rpc");
    await start("/tmp/child.jsonl", "sdk");
    vi.stubEnv("TMUX_PANE", "");
    await start("/tmp/child.jsonl");
    expect(exec).not.toHaveBeenCalled();
  });
  it("clears ephemeral and orderly shutdown bindings", async () => {
    const { exec, start, stop } = setup();
    await start(undefined);
    expect(exec).toHaveBeenLastCalledWith("/mock/tmux", ["set-option", "-pu", "-t", "%13", "@pi-session-file"], { timeout: 1000 });
    await start("/tmp/live.jsonl");
    exec.mockResolvedValueOnce({ code: 0, stdout: "/tmp/live.jsonl\n" });
    await stop();
    expect(exec).toHaveBeenLastCalledWith("/mock/tmux", ["set-option", "-pu", "-t", "%13", "@pi-session-file"], { timeout: 1000 });
    const count = exec.mock.calls.length;
    await stop();
    expect(exec.mock.calls.length).toBe(count);
  });
  it("leaves a replacement binding alone and contains closed-pane errors", async () => {
    const { exec, start, stop } = setup();
    await start("/tmp/old.jsonl");
    exec.mockResolvedValueOnce({ code: 0, stdout: "/tmp/new.jsonl\n" });
    await stop();
    expect(exec.mock.calls.length).toBe(2);
    exec.mockRejectedValue(new Error("closed pane"));
    await expect(start("/tmp/live.jsonl")).resolves.toBeUndefined();
  });
});

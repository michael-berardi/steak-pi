import { describe, expect, it } from "vitest";
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
});

describe("session title extension wiring", () => {
  it("sets the session name once from the first real prompt and never overrides renames", () => {
    const handlers: Array<(event: { text: string }) => void> = [];
    let currentName: string | undefined;
    const calls: string[] = [];
    const api = {
      on(_event: string, handler: (event: { text: string }) => void) {
        handlers.push(handler);
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
});

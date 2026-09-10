import { expect, it } from "vitest";
import sessionTitleExtension from "../extensions/session-title.ts";
it("uses real SDK lifecycle hooks, never ordinary input for generation changes", () => {
  const handlers = new Map<string, Function>();
  sessionTitleExtension({ on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
  expect([...handlers.keys()]).toEqual(["session_start", "session_tree", "message_end", "session_shutdown", "input"]);
});

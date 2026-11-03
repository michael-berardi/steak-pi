import { describe, expect, it, vi } from "vitest";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { providerSessionCleanup } from "../src/provider-session-cleanup.ts";
import modelRoutePolicy from "../extensions/model-route-policy.ts";

describe("synthetic: separate provider SDK cleanup", () => {
  it("cleans the requested session in the same SDK registry without closing another session", () => {
    const sdk = findPackageJSON(import.meta.resolve("@earendil-works/pi-coding-agent"))!;
    const ai = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdk))!;
    const { registerSessionResourceCleanup } = createRequire(sdk)(join(dirname(ai), "dist/session-resources.js"));
    const sessions = new Set(["one", "two"]);
    const cleanup = vi.fn((id?: string) => { if (id) sessions.delete(id); else sessions.clear(); });
    const unregister = registerSessionResourceCleanup(cleanup);
    try {
      const dispose = providerSessionCleanup();
      expect(() => dispose("")).toThrow("without a session ID");
      expect(cleanup).not.toHaveBeenCalled();
      dispose("one");
      expect(cleanup).toHaveBeenCalledWith("one");
      expect([...sessions]).toEqual(["two"]);
    } finally { unregister(); }
  });

  it("cleans on shutdown but not reload", async () => {
    const sdk = findPackageJSON(import.meta.resolve("@earendil-works/pi-coding-agent"))!;
    const ai = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(sdk))!;
    const { registerSessionResourceCleanup } = createRequire(sdk)(join(dirname(ai), "dist/index.js"));
    const cleanup = vi.fn();
    const unregister = registerSessionResourceCleanup(cleanup);
    const handlers = new Map<string, Function>();
    try {
      modelRoutePolicy({ registerProvider: vi.fn(), registerVirtualModel: vi.fn(), registerFlag: vi.fn(), on: (name: string, fn: Function) => handlers.set(name, fn) } as never);
      const shutdown = handlers.get("session_shutdown")!;
      const ctx = { sessionManager: { getSessionId: () => "current-session" } };
      await shutdown({ reason: "reload" }, ctx);
      expect(cleanup).not.toHaveBeenCalled();
      await shutdown({ reason: "quit" }, ctx);
      expect(cleanup).toHaveBeenCalledWith("current-session");
    } finally { unregister(); }
  });
});

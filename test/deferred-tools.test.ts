import "./ultracompress-settings-mock.ts";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deferredToolsEnabled, setToolActive } from "../src/deferred-tools.ts";
import ultraCompressExtension from "../extensions/ultracompress/index.ts";

type Handler = (event: any, ctx: any) => any;

function fakePi(initial: string[]) {
  let active = [...initial];
  const handlers = new Map<string, Handler[]>();
  const pi = {
    getActiveTools: () => [...active],
    setActiveTools: vi.fn((names: string[]) => { active = [...names]; }),
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand() {}, registerTool() {},
  };
  const emit = async (name: string, event: unknown, ctx: unknown = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  return { pi, emit, active: () => active };
}

describe("deferred tool exposure", () => {
  it("toggles one tool without disturbing others and reports no-op changes", () => {
    const { pi, active } = fakePi(["read", "bash"]);
    expect(setToolActive(pi, "late", true)).toBe(true);
    expect(setToolActive(pi, "late", true)).toBe(false);
    expect(active()).toEqual(["read", "bash", "late"]);
    expect(setToolActive(pi, "late", false)).toBe(true);
    expect(active()).toEqual(["read", "bash"]);
    expect(pi.setActiveTools).toHaveBeenCalledTimes(2);
  });

  it("tolerates hosts without tool toggling", () => {
    expect(setToolActive({}, "late", true)).toBe(false);
  });

  it("honours the STEAK_PI_DEFER_TOOLS opt-out", () => {
    expect(deferredToolsEnabled({})).toBe(true);
    expect(deferredToolsEnabled({ STEAK_PI_DEFER_TOOLS: "off" })).toBe(false);
    expect(deferredToolsEnabled({ STEAK_PI_DEFER_TOOLS: "1" })).toBe(true);
  });

  it("exposes ultracompress recall after compaction and uc before the first large result is archived", async () => {
    const tools = ["read", "ultracompress_recall", "ultracompress_uc"];
    const { pi, emit, active } = fakePi(tools);
    ultraCompressExtension(pi as never);
    await emit("session_start", {}, { sessionManager: { getEntries: () => [{ type: "message" }] } });
    expect(active()).toEqual(["read"]);
    await emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "short" }] });
    expect(active()).toEqual(["read"]);
    await emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "x".repeat(8192) }] });
    expect(active()).toEqual(["read", "ultracompress_uc"]);
    await emit("session_compact", {});
    expect(active()).toEqual(["read", "ultracompress_uc", "ultracompress_recall"]);
  });

  it("keeps recall visible when resuming an already compacted session", async () => {
    const { pi, emit, active } = fakePi(["read", "ultracompress_recall", "ultracompress_uc"]);
    ultraCompressExtension(pi as never);
    await emit("session_start", {}, { sessionManager: { getEntries: () => [{ type: "compaction" }] } });
    expect(active()).toEqual(["read", "ultracompress_recall"]);
  });
});

describe("ultracompress binary availability", () => {
  it("detects executables by path and through PATH", async () => {
    // The shared settings mock stubs availability; exercise the real check.
    const { isUltraCompressBinAvailable } = await vi.importActual<typeof import("../extensions/ultracompress/src/settings.ts")>(
      "../extensions/ultracompress/src/settings.ts");
    const dir = mkdtempSync(join(tmpdir(), "uc-bin-"));
    const bin = join(dir, "ultracompress");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(isUltraCompressBinAvailable(bin)).toBe(true);
    expect(isUltraCompressBinAvailable("ultracompress", { PATH: dir })).toBe(true);
    expect(isUltraCompressBinAvailable("ultracompress", { PATH: "/nonexistent" })).toBe(false);
    expect(isUltraCompressBinAvailable(join(dir, "missing"))).toBe(false);
  });
});

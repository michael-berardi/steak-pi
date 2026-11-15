import { describe, expect, it } from "vitest";
import { SettingsManager, shouldCompact } from "@earendil-works/pi-coding-agent";

const model = { provider: "example", id: "model" } as any;

describe("agent compaction configuration", () => {
  it("resolves an exact per-model reserve and triggers strictly above its threshold", () => {
    const settings = SettingsManager.inMemory({ compaction: { modelOverrides: { "example/model": { reserveTokens: 700000 } } } });
    const resolved = settings.getCompactionSettings(model);
    expect(resolved).toEqual({ enabled: true, reserveTokens: 700000, keepRecentTokens: 20000 });
    expect(shouldCompact(300000, 1000000, resolved)).toBe(false);
    expect(shouldCompact(300001, 1000000, resolved)).toBe(true);
    expect(settings.getCompactionSettings({ provider: "other", id: "model" } as any).reserveTokens).toBe(16384);
  });
  it("leaves the agent defaults unchanged when unset", () => {
    const resolved = SettingsManager.inMemory({}).getCompactionSettings(model);
    expect(resolved).toEqual({ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
    expect(shouldCompact(983616, 1000000, resolved)).toBe(false);
    expect(shouldCompact(983617, 1000000, resolved)).toBe(true);
  });
  it("names an invalid model override when read", () => {
    const settings = SettingsManager.inMemory({ compaction: { modelOverrides: { "example/model": { reserveTokens: -1 } } } });
    expect(() => settings.getCompactionSettings(model)).toThrow('Invalid compaction.modelOverrides["example/model"].reserveTokens setting');
  });
});

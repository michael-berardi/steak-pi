import { describe, expect, it, vi } from "vitest";
import { companionActivity, createActivitySignal } from "../src/tui/activity-signal.ts";
import { initialCompanionState, reduceCompanionState, type CompanionAction } from "../src/tui/model.ts";

describe("managed terminal activity", () => {
  it("signals lifecycle transitions, not redraws or elapsed time", () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn();
      const emit = createActivitySignal(write, () => ({ mode: "tui", isTTY: true, slot: "8" }));
      let state = initialCompanionState();
      const update = (action: CompanionAction) => {
        state = reduceCompanionState(state, action);
        emit(companionActivity(state));
      };
      emit(companionActivity(state));
      update({ type: "agent_start" });
      vi.advanceTimersByTime(60_000);
      update({ type: "stream", kind: "thinking" });
      update({ type: "stream", kind: "text" });
      update({ type: "tool_start", id: "a", name: "bash" });
      expect(write.mock.calls.map(([data]) => data)).toEqual([
        "\x1b]777;ultraterm;activity=idle\x07", "\x1b]777;ultraterm;activity=working\x07",
      ]);
      update({ type: "prompt_start" });
      update({ type: "prompt_start" });
      update({ type: "tool_end", id: "a", name: "bash" });
      expect(companionActivity(state)).toBe("idle");
      update({ type: "prompt_end" });
      update({ type: "prompt_end" });
      expect(companionActivity(state)).toBe("working");
      update({ type: "settled" });
      expect(companionActivity(state)).toBe("idle");
      update({ type: "compact_start" });
      expect(companionActivity(state)).toBe("working");
      update({ type: "compact_end" });
      expect(companionActivity(state)).toBe("idle");
      emit("idle", true); // shutdown reset is explicit even if already idle
      expect(write).toHaveBeenCalledTimes(8);
    } finally { vi.useRealTimers(); }
  });

  it("gates on TUI, TTY and an exact slot 1..8", () => {
    for (const mode of ["tui", "rpc"]) for (const isTTY of [true, false]) {
      for (const slot of [undefined, "", "0", "9", "01", "1x", " 1", "1", "8"]) {
        const write = vi.fn();
        createActivitySignal(write, () => ({ mode, isTTY, slot }))("working");
        expect(write.mock.calls.length).toBe(mode === "tui" && isTTY && ["1", "8"].includes(slot ?? "") ? 1 : 0);
      }
    }
  });
});

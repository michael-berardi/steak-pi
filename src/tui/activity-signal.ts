import type { CompanionState } from "./model.ts";

export type Activity = "working" | "idle";

export function companionActivity(state: CompanionState): Activity {
  if (state.promptDepth > 0 || state.phase === "waiting") return "idle";
  return state.agentActive || state.phase === "compacting" ? "working" : "idle";
}

/** Transition-only signalling; ordinary CLI/RPC and unmanaged terminals stay untouched. */
export function createActivitySignal(
  write: (data: string) => void,
  environment: () => { mode: string; isTTY: boolean; slot: string | undefined },
) {
  let previous: Activity | undefined;
  return (activity: Activity, reset = false): void => {
    const { mode, isTTY, slot } = environment();
    if (mode !== "tui" || !isTTY || !/^[1-8]$/.test(slot ?? "")) return;
    if (reset || activity !== previous) {
      write(`\x1b]777;ultraterm;activity=${activity}\x07`);
      previous = activity;
    }
  };
}

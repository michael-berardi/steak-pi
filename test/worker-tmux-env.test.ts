import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeWorkerEnv } from "../src/subagents/claude-worker.ts";
import { piWorkerBashEnv } from "../src/subagents/pi-worker.ts";

describe("USAP worker tmux environment isolation", () => {
  it("drops TMUX and TMUX_PANE and puts ~/.ultraterm/bin ahead of Homebrew for Pi and Claude workers", () => {
    const home = mkdtempSync(join(tmpdir(), "steak-pi-tmux-env-"));
    try {
      const utBin = join(home, ".ultraterm", "bin");
      mkdirSync(utBin, { recursive: true });
      const base: NodeJS.ProcessEnv = {
        HOME: home,
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        TMUX: `${home}/.ultraterm/tmux/s,2132,0`,
        TMUX_PANE: "%6",
      };

      const piEnv = piWorkerBashEnv(base, home);
      expect(piEnv.TMUX).toBeUndefined();
      expect(piEnv.TMUX_PANE).toBeUndefined();
      const piParts = (piEnv.PATH ?? "").split(":");
      expect(piParts[0]).toBe(utBin);
      expect(piParts.indexOf(utBin)).toBeLessThan(piParts.indexOf("/opt/homebrew/bin"));

      const claudeEnv = claudeWorkerEnv(base, false);
      expect(claudeEnv.TMUX).toBeUndefined();
      expect(claudeEnv.TMUX_PANE).toBeUndefined();
      const claudeParts = (claudeEnv.PATH ?? "").split(":");
      expect(claudeParts[0]).toBe(utBin);
      expect(claudeParts.indexOf(utBin)).toBeLessThan(claudeParts.indexOf("/opt/homebrew/bin"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

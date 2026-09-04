import { describe, it } from "vitest";
import * as fs from "node:fs";
import {
  terminalBackgroundFor,
  DARK_TERMINAL_THEME,
  WHITE_TERMINAL_THEME,
} from "../src/lib/terminalThemes.ts";

describe("dump", () => {
  it("dumps terminal backgrounds", () => {
    const appThemes = [
      "oled", "white", "obsidian-rite", "nord-frost", "crystal",
      "vapor", "frutiger-aero", "frutiger-dark", "oel-drive",
    ];
    const map: Record<string, string> = {};
    for (const t of appThemes) {
      try {
        map[t] = terminalBackgroundFor(t).background ?? "none";
      } catch (e) {
        map[t] = "error: " + String(e).slice(0, 60);
      }
    }
    map["__dark_base"] = DARK_TERMINAL_THEME.background;
    map["__light_base"] = WHITE_TERMINAL_THEME.background;
    fs.writeFileSync("/tmp/audit/steak-corpus/terminal-bgs.json", JSON.stringify(map, null, 1));
    console.log(JSON.stringify(map, null, 1));
  });
});

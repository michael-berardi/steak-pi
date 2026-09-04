import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Steak Pi terminal themes — the bridge between app themes and UltraTerm.
 *
 * Each theme pairs a Pi theme name with a terminal background so the
 * terminal chrome and the agent UI read as one surface. OLED-first: the
 * flagship theme is true black, high contrast, minimal.
 *
 * This module is pure data + lookup: no timers, no I/O at import, zero idle
 * overhead. UltraTerm (or any host) can read the same registry to tint its
 * own chrome in lockstep with the agent theme.
 */

export interface TerminalTheme {
  /** Pi theme name (`pi --use-theme <name>` / settings.json "theme"). */
  name: string;
  /** Terminal background color (hex) the host should apply. */
  background: string;
  /** High-contrast foreground for host chrome that needs one. */
  foreground: string;
  /** Steak accent used sparingly for chrome highlights. */
  accent: string;
  /** Light base means dark terminal text. */
  light: boolean;
}

export const STEAK_ACCENT = "#e63946";
export const STEAK_ACCENT_DEEP = "#b02a37";
export const STEM_GREEN = "#2a9d5c";
export const JACKPOT_GOLD = "#f4c95d";

/** True-black OLED base — the flagship Steak Pi surface. */
export const DARK_TERMINAL_THEME: TerminalTheme = {
  name: "steak-oled",
  background: "#000000",
  foreground: "#f2f4f8",
  accent: STEAK_ACCENT,
  light: false,
};

/** White base for bright-room sessions. */
export const WHITE_TERMINAL_THEME: TerminalTheme = {
  name: "steak-light",
  background: "#fafafa",
  foreground: "#16181d",
  accent: STEAK_ACCENT_DEEP,
  light: true,
};

/** The full Steak Pi terminal-theme corpus. */
export const TERMINAL_THEMES: Record<string, TerminalTheme> = {
  oled: DARK_TERMINAL_THEME,
  "steak-oled": DARK_TERMINAL_THEME,
  white: WHITE_TERMINAL_THEME,
  "steak-light": WHITE_TERMINAL_THEME,
  "obsidian-rite": {
    name: "obsidian-rite",
    background: "#0b0b10",
    foreground: "#e8e6f0",
    accent: "#8b7bd8",
    light: false,
  },
  "nord-frost": {
    name: "nord-frost",
    background: "#2e3440",
    foreground: "#eceff4",
    accent: "#88c0d0",
    light: false,
  },
  crystal: {
    name: "crystal",
    background: "#0e1a20",
    foreground: "#d8f0f5",
    accent: "#4dd0e1",
    light: false,
  },
  vapor: {
    name: "vapor",
    background: "#14101f",
    foreground: "#f0e6ff",
    accent: "#ff6ec7",
    light: false,
  },
  "frutiger-aero": {
    name: "frutiger-aero",
    background: "#0a1a24",
    foreground: "#d8f2ff",
    accent: "#39c2ff",
    light: false,
  },
  "frutiger-dark": {
    name: "frutiger-dark",
    background: "#101418",
    foreground: "#dce8f0",
    accent: "#54c6eb",
    light: false,
  },
  "oel-drive": {
    name: "oel-drive",
    background: "#050805",
    foreground: "#d2f5d2",
    accent: "#33ff66",
    light: false,
  },
};

/** Resolve a theme by name; falls back to the OLED flagship. */
export function terminalBackgroundFor(name: string): TerminalTheme {
  return TERMINAL_THEMES[name] ?? DARK_TERMINAL_THEME;
}

/** Locate a packaged Pi theme JSON for a terminal theme, if vendored. */
export function piThemeFile(name: string, repoRoot: string): string | null {
  const candidate = path.join(repoRoot, "themes", `${name}.json`);
  try {
    fs.accessSync(candidate, fs.constants.R_OK);
    return candidate;
  } catch {
    return null;
  }
}

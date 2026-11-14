// Steak Pi's default look: the bundled `steak` theme, applied for the session when the operator has not
// chosen a theme. Any selection wins and is never overwritten: a `theme` in the global or project settings
// (including `system` and light/dark pairs), `--use-theme` / `--theme`, or STEAK_PI_THEME=off. The default
// is applied as a theme instance, so nothing is written to the settings file and a later pick in /settings
// takes over immediately and permanently.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_THEME = "steak";

function settingsTheme(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { theme?: unknown };
    return parsed && typeof parsed === "object" ? parsed.theme : undefined;
  } catch {
    // A settings file Pi cannot parse is Pi's to report; treat the theme as chosen so we change nothing.
    return "unreadable";
  }
}

/** True when the operator picked a theme anywhere Pi would read one. */
export function operatorChoseTheme(input: { agentDir: string | (() => string); cwd: string; argv?: readonly string[]; env?: Record<string, string | undefined> }): boolean {
  const agentDir = typeof input.agentDir === "function" ? input.agentDir() : input.agentDir;
  const argv = input.argv ?? process.argv, env = input.env ?? process.env;
  if (/^(?:off|0|false|none)$/i.test(env.STEAK_PI_THEME ?? "")) return true;
  if (argv.some((arg) => arg === "--theme" || arg === "--use-theme" || arg.startsWith("--theme=") || arg.startsWith("--use-theme="))) return true;
  return [join(agentDir, "settings.json"), join(input.cwd, ".pi", "settings.json")]
    .some((path) => { const value = settingsTheme(path); return value !== undefined && value !== null && value !== ""; });
}

type ThemeUi = { getTheme(name: string): unknown; setTheme(theme: never): { success: boolean } };

/** Apply the bundled default theme when the operator chose none. Never throws (an unresolvable settings directory changes nothing); returns whether it applied. */
export function applyDefaultTheme(ui: ThemeUi, input: { agentDir: string | (() => string); cwd: string; argv?: readonly string[]; env?: Record<string, string | undefined> }): boolean {
  try {
    if (operatorChoseTheme(input)) return false;
    const theme = ui.getTheme(DEFAULT_THEME);
    return theme ? ui.setTheme(theme as never).success : false;
  } catch {
    return false;
  }
}

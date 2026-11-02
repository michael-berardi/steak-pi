import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The router's claude-accounts.json with the owner-reserved third account. */
export const TEAM_REGISTRY = [
  { id: "primary", label: "Claude 1", configDir: "~/.claude" },
  { id: "b", label: "Claude 2", configDir: "~/.claude-b" },
  { id: "team-2", label: "Claude (Team)", configDir: "~/.claude-team-2",
    reserve: { floorPercent: 35, relaxedFloorPercent: 15, relaxLastHours: 48, greenMarginPercent: 15, owner: "Synthetic Owner (lent account)" } },
];

/** A private synthetic HOME holding `registry` (a JSON value, raw text, or undefined for none) and 0700 `folders`. */
export function stageClaudeHome(registry: unknown, folders: readonly string[] = []): { home: string; remove(): void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-registry-home-")));
  if (registry !== undefined) {
    const directory = join(home, ".config", "ultraterm");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, "claude-accounts.json"), typeof registry === "string" ? registry : JSON.stringify(registry), { mode: 0o600 });
  }
  for (const folder of folders) mkdirSync(join(home, folder), { mode: 0o700 });
  return { home, remove: () => rmSync(home, { recursive: true, force: true }) };
}

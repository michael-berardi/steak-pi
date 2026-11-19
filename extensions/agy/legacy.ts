// The direct Antigravity OAuth route was removed. A user who had turned it on gets one notice, once per session start.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_CONFIG_ENV = "STEAK_PI_ANTIGRAVITY_CONFIG";

export const LEGACY_NOTICE =
  "The direct Google Antigravity provider was removed from Steak Pi: Google's terms say that using third-party software to access Antigravity (for example with Antigravity OAuth) breaches the agreement and can get the account suspended. " +
  "Use the official Antigravity CLI instead: install agy, run it once to sign in, then pick a model under the `agy` provider (see docs/AGY.md). You can delete the old config file.";

/** The legacy config path when it exists and says "enabled": true; otherwise undefined. Never throws. */
export function legacyEnabledConfig(env: Record<string, string | undefined> = process.env): string | undefined {
  const path = env[LEGACY_CONFIG_ENV] || join(homedir(), ".config", "ultraterm", "antigravity.json");
  try {
    if (!existsSync(path)) return undefined;
    const raw = JSON.parse(readFileSync(path, "utf8")) as { enabled?: unknown };
    return raw && raw.enabled === true ? path : undefined;
  } catch { return undefined; }
}

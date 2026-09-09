import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_CONCURRENCY } from "./types.ts";

/**
 * Provider-aware capacity limits for USAP worker launches.
 *
 * Two tiers apply to every launch:
 * - Session tier: per-provider ceiling inside one pi session
 *   (GLM flash lanes 8; paid Codex/Luna lanes 6 by doctrine; unknown 8).
 * - Machine tier: per-provider ceiling shared by every session on this
 *   computer, plus one global ceiling across all providers. These protect
 *   the provider's rate limits and the operator's machine when several
 *   sessions delegate at once. Defaults were dialed with live GLM runs:
 *   see benchmarks/usap/results/glm53-live-mirror-2026-09-09.md.
 */

export interface CapacityConfig {
  session: { providers: Record<string, number>; global: number };
  machine: { providers: Record<string, number>; global: number };
}

/** Per-session provider ceilings. One session may run 8 GLM + 6 Luna at once. */
const DEFAULT_SESSION_PROVIDERS: Record<string, number> = {
  zai: MAX_CONCURRENCY,
  "openai-codex": 6,
};

/**
 * Machine-wide defaults. zai 8 is the operator-set total across ALL sessions
 * on this computer (one full GLM session, or several narrower ones);
 * codex 12 covers two Luna-heavy sessions; global bounds all providers.
 */
const DEFAULT_MACHINE_PROVIDERS: Record<string, number> = {
  zai: 8,
  "openai-codex": 12,
};

const DEFAULTS: CapacityConfig = {
  session: { providers: DEFAULT_SESSION_PROVIDERS, global: MAX_CONCURRENCY + 6 },
  machine: { providers: DEFAULT_MACHINE_PROVIDERS, global: 24 },
};

function sanitizeProviders(input: unknown): Record<string, number> | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 64) {
      out[key] = value;
    }
  }
  return out;
}

function globalFrom(input: unknown, fallback: number, max: number): number {
  if (typeof input === "number" && Number.isInteger(input) && input >= 1 && input <= max) return input;
  return fallback;
}

function configPath(): string | undefined {
  if (process.env.STEAK_PI_USAP_CAPS === "off") return undefined;
  if (process.env.STEAK_PI_USAP_CAPS) return process.env.STEAK_PI_USAP_CAPS;
  const candidate = join(homedir(), ".config", "steak-pi", "usap-caps.json");
  return existsSync(candidate) ? candidate : undefined;
}

/** Load capacity config: defaults, optionally overridden by ~/.config/steak-pi/usap-caps.json. */
export function loadCapacityConfig(path = configPath()): CapacityConfig {
  if (!path) return structuredClone(DEFAULTS);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const session = (raw.session ?? {}) as Record<string, unknown>;
    const machine = (raw.machine ?? {}) as Record<string, unknown>;
    return {
      session: {
        providers: sanitizeProviders(session.providers) ?? { ...DEFAULTS.session.providers },
        // Session globals feed SessionScheduler, which validates 1..64.
        global: globalFrom(session.global, DEFAULTS.session.global, 64),
      },
      machine: {
        providers: sanitizeProviders(machine.providers) ?? { ...DEFAULTS.machine.providers },
        global: globalFrom(machine.global, DEFAULTS.machine.global, 128),
      },
    };
  } catch {
    // A malformed config must never break dispatch; fall back to defaults.
    return structuredClone(DEFAULTS);
  }
}

export function sessionCap(config: CapacityConfig, provider: string): number {
  return Math.min(config.session.providers[provider] ?? MAX_CONCURRENCY, config.session.global, 64);
}

export function machineCap(config: CapacityConfig, provider: string): number {
  return Math.min(config.machine.providers[provider] ?? 12, config.machine.global);
}

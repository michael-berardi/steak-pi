import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, homedir, totalmem } from "node:os";
import { join } from "node:path";
import { MAX_CONCURRENCY } from "./types.ts";

/**
 * Provider-aware capacity limits for USAP worker launches.
 *
 * No width is built in. A wave asks for as many workers as it has tasks, and
 * two tiers decide how many run at once:
 * - Session tier: ceilings inside one pi session.
 * - Machine tier: ceilings shared by every session on this computer, so
 *   several sessions delegating at once cannot overload it.
 * Both default to what this computer can carry (`adaptiveCeiling`); the
 * operator's usap-caps.json overrides any of them, per provider or overall.
 * A provider that throttles is slowed separately by the session scheduler.
 */

/** Memory budgeted per worker when sizing the default ceiling: workers may take about half the machine. */
const WORKER_MEMORY_BYTES = 2 * 1024 ** 3;
/** A small machine still runs a useful wave. */
const MIN_ADAPTIVE_CEILING = 4;

/** Workers this computer can run at once: two per core or one per 2 GiB of memory, whichever is lower. */
export function adaptiveCeiling(cpus = availableParallelism(), memoryBytes = totalmem()): number {
  const byCpu = Math.floor(cpus) * 2;
  const byMemory = Math.floor(memoryBytes / WORKER_MEMORY_BYTES);
  const fit = Math.min(byCpu, byMemory);
  return Math.max(MIN_ADAPTIVE_CEILING, Math.min(MAX_CONCURRENCY, Number.isFinite(fit) ? fit : MIN_ADAPTIVE_CEILING));
}

export interface CapacityConfig {
  session: { providers: Record<string, number>; global: number };
  machine: { providers: Record<string, number>; global: number };
}

/** Per-session provider ceilings; providers not listed get the session ceiling. Steak Pi
 * ships no provider-specific ceiling: the operator's usap-caps.json sets them. */
const DEFAULT_SESSION_PROVIDERS: Record<string, number> = {};

/** Machine-wide per-provider ceilings (none by default); the global ceiling bounds all providers. */
const DEFAULT_MACHINE_PROVIDERS: Record<string, number> = {};

function defaults(): CapacityConfig {
  const ceiling = adaptiveCeiling();
  return {
    session: { providers: { ...DEFAULT_SESSION_PROVIDERS }, global: ceiling },
    machine: { providers: { ...DEFAULT_MACHINE_PROVIDERS }, global: ceiling },
  };
}

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
  const DEFAULTS = defaults();
  if (!path) return DEFAULTS;
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
    return DEFAULTS;
  }
}

export function sessionCap(config: CapacityConfig, provider: string): number {
  return Math.min(config.session.providers[provider] ?? config.session.global, config.session.global, MAX_CONCURRENCY);
}

export function machineCap(config: CapacityConfig, provider: string): number {
  return Math.min(config.machine.providers[provider] ?? config.machine.global, config.machine.global);
}

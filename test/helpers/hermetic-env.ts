import { join } from "node:path";

/** Inherited variables that point the updater at this machine's real Pi, UltraTerm or Steak Pi state, or change its mode. */
const MACHINE_STATE = /^(ULTRATERM_|PI_|STEAK_PI_|XDG_)|^(CI|DO_NOT_TRACK|HOMEBREW_NO_ANALYTICS)$/;

/**
 * Environment for a CLI under test: the parent's environment minus everything that names machine state, with HOME and
 * ULTRATERM_HOME inside the fixture. A Pi or UltraTerm session running the suite exports ULTRATERM_HOME, PI_CODING_AGENT_DIR
 * and friends; passed through, `steak-pi update` would read (and re-point) the operator's real provider-account settings.
 */
export function hermeticEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!MACHINE_STATE.test(key)) env[key] = value;
  return { ...env, HOME: home, ULTRATERM_HOME: join(home, ".ultraterm"), ...extra };
}

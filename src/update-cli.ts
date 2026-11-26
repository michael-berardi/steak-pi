import { rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { checkForUpdate, DEFAULT_CACHE_PATH, UPDATE_CACHE_ENV } from "./update-check.ts";
import { DEFAULT_AUTO_LOG } from "./update-log.ts";
import { clearUpdatePrefs, readUpdatePrefs, setAutoUpdate, skipVersion, writeUpdatePrefs } from "./update-prefs.ts";
import { pruneReleases } from "./update-releases.ts";

/**
 * The report and preference half of `steak-pi update` (the shell CLI does the install).
 * Exit codes: 0 current or done, 10 update available, 1 failed (cause on stderr), 2 usage.
 */
const say = (message: string): void => { process.stdout.write(`${message}\n`); };
const fail = (message: string, code = 1): number => { process.stderr.write(`steak-pi: ${message}\n`); return code; };
const cachePath = (): string => process.env[UPDATE_CACHE_ENV] || DEFAULT_CACHE_PATH;

async function main(flag = "", value = "", extra = ""): Promise<number> {
  switch (flag) {
    case "--check":
    case "--skip": {
      if (!/^\d+\.\d+\.\d+$/.test(value)) return fail(`usage: steak-pi update ${flag}`, 2);
      const state = await checkForUpdate(value, { force: true });
      if (state.error) return fail(`update check failed: ${state.error}`);
      if (!state.available || !state.latest) {
        say(`Steak Pi ${value} is up to date.`);
        return 0;
      }
      if (flag === "--skip") {
        skipVersion(state.latest);
        say(`Skipped Steak Pi ${state.latest}. A newer release will notify again.`);
        return 0;
      }
      say(`Steak Pi ${state.latest} available (you have ${value}) · run: steak-pi update`);
      return 10;
    }
    case "--auto":
    case "--checks": {
      const key = flag === "--auto" ? "auto" : "checks";
      const label = flag === "--auto" ? "Automatic updates" : "Update checks";
      if (value === "status") {
        const prefs = readUpdatePrefs();
        if (prefs.error) return fail(prefs.error);
        say(`${label}: ${prefs[key] ? "on" : "off"}`);
        if (key === "auto" && prefs.autoError) say(`Last automatic install failed: ${prefs.autoError}`);
        return 0;
      }
      if (value !== "on" && value !== "off") return fail(`usage: steak-pi update ${flag} on|off|status`, 2);
      if (key === "checks") writeUpdatePrefs({ checks: value === "on" });
      else if (value === "on") setAutoUpdate(true);
      else {
        // Off also drops what automatic updates and notices left behind.
        writeUpdatePrefs({ auto: false, autoAsked: true, autoError: undefined, skippedVersion: undefined, notice: undefined });
        rmSync(cachePath(), { force: true });
        rmSync(DEFAULT_AUTO_LOG, { force: true });
      }
      say(`${label}: ${value}`);
      return 0;
    }
    case "--offer-auto": {
      // After an install on a terminal: ask once, remember either answer.
      const prefs = readUpdatePrefs();
      if (prefs.error || prefs.auto || prefs.autoAsked) return 0;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("Install future updates automatically? [y/N] ").finally(() => rl.close());
      const on = /^y(es)?$/i.test(answer.trim());
      setAutoUpdate(on);
      say(on ? "Automatic updates: on (turn off: steak-pi update --auto off)" : "Automatic updates: off");
      return 0;
    }
    case "--prune": {
      for (const version of pruneReleases(value, extra).removed) say(`Removed old release ${version}.`);
      return 0;
    }
    case "--cleanup":
      clearUpdatePrefs();
      rmSync(cachePath(), { force: true });
      rmSync(DEFAULT_AUTO_LOG, { force: true });
      return 0;
    default:
      return fail("usage: steak-pi update [--check | --skip | --auto on|off|status | --checks on|off|status]", 2);
  }
}

const [flag, value, extra] = process.argv.slice(2);
main(flag, value, extra).then((code) => { process.exitCode = code; }, (error: unknown) => {
  process.exitCode = fail(error instanceof Error ? error.message : String(error));
});

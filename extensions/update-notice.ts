import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkForUpdate, updateCheckDisabled, type UpdateState } from "../src/update-check.ts";

/**
 * "Update available" notice and one-step update.
 *
 * Lightweight by design: interactive sessions only (print-mode workers never check), one background
 * request at session start at most every 6 hours per machine (shared cache), no polling, nothing on the
 * startup path. When a newer release exists the footer shows one line; `/steak-update` installs it and
 * reloads. Agents and scripts update with `steak-pi update` (or `steak-pi update --check`).
 * Opt out with STEAK_PI_NO_UPDATE_CHECK=1.
 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG_ROOT, "bin", "steak-pi");
const STATUS_KEY = "steak-update";

export function packageVersion(root = PKG_ROOT): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

export function noticeText(state: UpdateState): string | undefined {
  return state.available ? `Steak Pi ${state.latest} available (you have ${state.current}) · /steak-update` : undefined;
}

function runCli(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", [CLI, ...args], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({ ok: !error, output: output || (error ? error.message : "") });
    });
  });
}

export default function updateNotice(pi: ExtensionAPI): void {
  const current = packageVersion();

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI || updateCheckDisabled()) return;
    // Fire and forget: the check never delays startup and a failure only means no notice.
    void checkForUpdate(current).then((state) => {
      const text = noticeText(state);
      if (text) { try { ctx.ui.setStatus(STATUS_KEY, text); } catch { /* the session may have closed */ } }
    }).catch(() => undefined);
  });

  pi.registerCommand("steak-update", {
    description: "Install the latest Steak Pi release and reload",
    handler: async (args, ctx) => {
      if (args.trim() === "check") {
        const state = await checkForUpdate(current, { force: true });
        ctx.ui.notify(state.error ? `Update check failed: ${state.error}`
          : state.available ? `Steak Pi ${state.latest} is available (you have ${current}).`
          : `Steak Pi ${current} is the latest release.`, state.error ? "error" : "info");
        return;
      }
      ctx.ui.notify(`Updating Steak Pi from ${current}…`, "info");
      const result = await runCli(["update"]);
      if (!result.ok) {
        ctx.ui.notify(`Steak Pi update failed:\n${result.output}`, "error");
        return;
      }
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.notify(result.output.split("\n").slice(-3).join("\n"), "info");
      if (/up to date/i.test(result.output)) return;
      await ctx.waitForIdle?.();
      await ctx.reload();
    },
  });
}

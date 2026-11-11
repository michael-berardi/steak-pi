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

/** The host surface a queued reload needs. Pi's built-in `/reload` warns and drops
 * while busy; Steak Pi's own reload paths must never abort a running operation and
 * never drop the request: they wait for idle and, if the host is busy again when
 * the wait returns, run at the next idle instead. */
export interface ReloadContext {
  isIdle(): boolean;
  waitForIdle?: () => Promise<void>;
  reload(): Promise<void>;
}

export async function reloadWhenIdle(
  pi: Pick<ExtensionAPI, "on">,
  ctx: ReloadContext,
  notify: (message: string, level: "info" | "error") => void,
): Promise<void> {
  if (typeof ctx.waitForIdle !== "function") {
    notify("Reload refused: this Pi build does not expose ctx.waitForIdle, so reloading now could abort a running operation. Run /reload yourself once the agent is idle.", "error");
    return;
  }
  let queued = false;
  let done = false;
  // Always reload through the command context (the only one that exposes reload);
  // the agent_settled event context is not a command context.
  const runReload = async (): Promise<void> => {
    if (done) return;
    done = true;
    off();
    try {
      await ctx.reload();
    } catch (error) {
      notify(`Reload failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };
  const off = pi.on("agent_settled", async () => {
    if (queued) await runReload();
  });
  if (!ctx.isIdle()) notify("Steak Pi reload queued: it will run when the current response finishes.", "info");
  await ctx.waitForIdle();
  if (ctx.isIdle()) {
    await runReload();
    return;
  }
  // The wait returned but a new run already started: keep the request queued for
  // the next idle instead of letting the host warn and drop it.
  queued = true;
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
      await reloadWhenIdle(pi, ctx, (message, level) => ctx.ui.notify(message, level));
    },
  });
}

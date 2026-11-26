import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkForUpdate, updateCheckDisabled, type UpdateState } from "../src/update-check.ts";
import { boundedAppend, boundLog, DEFAULT_AUTO_LOG } from "../src/update-log.ts";
import { isNoticeDue, markNoticeShown, readUpdatePrefs, recordAutoError, setAutoUpdate, skipVersion, writeUpdatePrefs } from "../src/update-prefs.ts";
import { markReleaseRan } from "../src/update-releases.ts";

/**
 * "Update available" notice, one-step update and opt-in automatic updates.
 *
 * Interactive TUI sessions only: print, JSON, RPC and worker sessions never check, show or ask anything.
 * One anonymous background request at session start, at most every 24 hours per machine (shared cache),
 * never on the startup path. A newer release shows one footer line and, when the session is idle with an
 * empty editor, one dialog (Install update / Remind me later / Skip this version), at most once per 24
 * hours per version. After an install the user is asked once whether future updates install
 * automatically (off by default). When on, `steak-pi update` runs detached at low priority, logs to one
 * bounded file and applies on /reload; a failure is recorded and falls back to the dialog.
 * Opt out with STEAK_PI_NO_UPDATE_CHECK=1 or `steak-pi update --checks off`.
 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG_ROOT, "bin", "steak-pi");
const STATUS_KEY = "steak-update";
/** A session-start dialog dismisses itself (as "Remind me later") after this long. */
const PROMPT_TIMEOUT_MS = 60_000;

export const UPDATE_CHOICES = ["Install update", "Remind me later", "Skip this version"] as const;
const attempted = new Set<string>();

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

export interface CliResult { ok: boolean; output: string }
/** Injectable in tests; production uses the real shell CLI. */
export interface UpdateRuntime {
  runCli?: (args: string[]) => Promise<CliResult>;
  runDetached?: (args: string[]) => Promise<CliResult>;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile("/bin/sh", [CLI, ...args], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({ ok: !error, output: output || (error ? error.message : "") });
    });
  });
}

/** Detached and niced, writing straight to the bounded log, so it finishes even if this session exits. */
export function runDetached(args: string[], log = DEFAULT_AUTO_LOG): Promise<CliResult> {
  boundedAppend(log, `${new Date().toISOString()} steak-pi ${args.join(" ")}`);
  let start = 0;
  try { start = statSync(log).size; } catch { /* the log could not be created; the child still runs */ }
  return new Promise((resolve) => {
    let fd: number | undefined;
    try { fd = openSync(log, "a", 0o600); } catch { /* no log: discard output */ }
    const finish = (ok: boolean, fallback: string): void => {
      let output = "";
      try { output = readFileSync(log).subarray(start).toString("utf8").trim(); } catch { /* no log */ }
      boundLog(log);
      resolve({ ok, output: output || fallback });
    };
    const child = spawn("/bin/sh", ["-c", 'command -v nice >/dev/null 2>&1 && exec nice -n 10 /bin/sh "$@"; exec /bin/sh "$@"', "sh", CLI, ...args], {
      detached: true,
      stdio: ["ignore", fd ?? "ignore", fd ?? "ignore"],
    });
    if (fd !== undefined) closeSync(fd);
    child.unref();
    child.on("error", (error) => finish(false, error.message));
    child.on("close", (code) => finish(code === 0, code === 0 ? "" : `exit ${code}`));
  });
}

function interactive(ctx: Pick<ExtensionContext, "mode" | "hasUI">): boolean {
  return ctx.mode === "tui" && ctx.hasUI;
}

function setStatus(ctx: Pick<ExtensionContext, "ui">, text: string | undefined): void {
  try { ctx.ui.setStatus(STATUS_KEY, text); } catch { /* the session may have closed */ }
}

/** The last meaningful line of CLI output, for a one-line notification. */
const lastLine = (output: string): string => output.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";

type UpdateContext = ExtensionContext & Partial<ReloadContext>;

/** Ask once (any answer is remembered) whether future updates install automatically. */
async function offerAuto(ctx: UpdateContext): Promise<void> {
  const prefs = readUpdatePrefs();
  if (prefs.error || prefs.auto || prefs.autoAsked) return;
  const on = await ctx.ui.confirm("Install future updates automatically?", "Off by default. Change it any time: steak-pi update --auto on|off");
  setAutoUpdate(on);
}

/** The update dialog. Installing goes through the same `steak-pi update` as the CLI. */
export async function offerUpdate(
  ctx: UpdateContext,
  state: UpdateState,
  options: { pi?: Pick<ExtensionAPI, "on">; runtime?: UpdateRuntime; timeoutMs?: number } = {},
): Promise<void> {
  if (!interactive(ctx) || !state.available || !state.latest) return;
  const choice = await ctx.ui.select(
    `Steak Pi ${state.latest} is available — you have ${state.current}.`,
    [...UPDATE_CHOICES],
    options.timeoutMs ? { timeout: options.timeoutMs } : undefined,
  );
  if (choice === "Skip this version") {
    skipVersion(state.latest);
    setStatus(ctx, undefined);
    return;
  }
  if (choice !== "Install update") return; // later or dismissed: the footer line stays
  ctx.ui.notify(`Installing Steak Pi ${state.latest}…`, "info");
  const result = await (options.runtime?.runCli ?? runCli)(["update"]);
  if (!result.ok) {
    ctx.ui.notify(`Steak Pi update failed: ${lastLine(result.output) || "unknown cause"}`, "error");
    return;
  }
  setStatus(ctx, undefined);
  ctx.ui.notify(lastLine(result.output), "info");
  await offerAuto(ctx);
  if (options.pi && typeof ctx.waitForIdle === "function" && typeof ctx.reload === "function") {
    await reloadWhenIdle(options.pi, ctx as ReloadContext, (message, level) => ctx.ui.notify(message, level));
  }
}

/** Opt-in automatic install: once per version per session; a failure records its cause and falls back to the dialog. */
export async function installInBackground(state: UpdateState, ctx: UpdateContext, runtime: UpdateRuntime = {}): Promise<void> {
  if (!state.latest || attempted.has(state.latest)) return;
  attempted.add(state.latest);
  setStatus(ctx, `Steak Pi ${state.latest} installing in the background`);
  const result = await (runtime.runDetached ?? runDetached)(["update"]);
  if (result.ok) {
    writeUpdatePrefs({ autoError: undefined });
    setStatus(ctx, `Steak Pi ${state.latest} installed · /reload to use it`);
    return;
  }
  const cause = lastLine(result.output) || "automatic install failed";
  recordAutoError(cause);
  setStatus(ctx, noticeText(state));
  ctx.ui.notify(`Steak Pi automatic update failed: ${cause}`, "error");
  await offerUpdate(ctx, state, { runtime });
}

/** First interactive start of a release folder: record that it ran, then prune older ones in the background. */
function settleRelease(): void {
  const release = markReleaseRan(PKG_ROOT);
  if (!release) return;
  try {
    const child = spawn(process.execPath, ["--no-warnings", join(PKG_ROOT, "src", "update-cli.ts"), "--prune", release.root, release.version], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined); // pruning is housekeeping; it never affects the session
    child.unref();
  } catch { /* as above */ }
}

export default function updateNotice(pi: ExtensionAPI): void {
  const current = packageVersion();

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (!interactive(ctx)) return;
    settleRelease();
    if (updateCheckDisabled() || !readUpdatePrefs().checks) return;
    // Fire and forget: the check never delays startup and a failure only means no notice.
    void checkForUpdate(current).then(async (state) => {
      const prefs = readUpdatePrefs();
      if (!isNoticeDue(state, prefs)) return;
      markNoticeShown(state.latest!);
      if (prefs.auto) return installInBackground(state, ctx);
      setStatus(ctx, noticeText(state));
      // Never over a running response or a half-typed prompt.
      const typing = typeof ctx.ui.getEditorText === "function" && ctx.ui.getEditorText().trim() !== "";
      if (typeof ctx.isIdle === "function" && ctx.isIdle() && !typing) await offerUpdate(ctx, state, { timeoutMs: PROMPT_TIMEOUT_MS });
    }).catch(() => undefined);
  });

  pi.registerCommand("steak-update", {
    description: "Install the latest Steak Pi release (check: report only; status: update settings)",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "status") {
        const prefs = readUpdatePrefs();
        ctx.ui.notify(prefs.error ? `Update settings: ${prefs.error}`
          : `Automatic updates: ${prefs.auto ? "on" : "off"}${prefs.skippedVersion ? ` · skipped ${prefs.skippedVersion}` : ""}${prefs.autoError ? ` · last failure: ${prefs.autoError}` : ""}`,
        prefs.error || prefs.autoError ? "error" : "info");
        return;
      }
      const state = await checkForUpdate(current, { force: true });
      if (state.error || !state.available) {
        ctx.ui.notify(state.error ? `Update check failed: ${state.error}` : `Steak Pi ${current} is the latest release.`, state.error ? "error" : "info");
        return;
      }
      if (command === "check") {
        ctx.ui.notify(`Steak Pi ${state.latest} available (you have ${current}).`, "info");
        return;
      }
      if (interactive(ctx)) { await offerUpdate(ctx, state, { pi }); return; }
      // An explicit command without dialogs: install without questions.
      const result = await runCli(["update"]);
      ctx.ui.notify(lastLine(result.output), result.ok ? "info" : "error");
    },
  });
}

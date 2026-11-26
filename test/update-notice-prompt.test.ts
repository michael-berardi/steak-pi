import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import updateNotice, { installInBackground, noticeText, offerUpdate, packageVersion, runDetached, UPDATE_CHOICES, type UpdateRuntime } from "../extensions/update-notice.ts";
import { readUpdatePrefs, setAutoUpdate } from "../src/update-prefs.ts";
import type { UpdateState } from "../src/update-check.ts";

const current = packageVersion();
const bump = (version: string) => { const parts = version.split(".").map(Number); parts[2] += 1; return parts.join("."); };
const newer = bump(current);
const state = (version = newer): UpdateState => ({ current, latest: version, available: true });
const saved = { ...process.env };
let dir: string;
const prefs = () => readUpdatePrefs(join(dir, "steak-pi.json"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "steak-update-notice-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.STEAK_PI_UPDATE_CACHE = join(dir, "update-check.json");
  process.env.STEAK_PI_LATEST_TAG = `v${newer}`;
  delete process.env.STEAK_PI_NO_UPDATE_CHECK;
  delete process.env.CI;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
    else process.env[key] = saved[key] as string;
  }
  rmSync(dir, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
function host(mode: "tui" | "print" | "rpc" = "tui", options: { idle?: boolean; editor?: string } = {}) {
  const handlers: Record<string, Handler[]> = {};
  const commands: Record<string, { handler: Handler }> = {};
  const ui = {
    select: vi.fn(async (_title: string, _options: string[], _opts?: { timeout?: number }) => undefined as string | undefined),
    confirm: vi.fn(async (_title: string, _message: string) => false),
    setStatus: vi.fn((_key: string, _text?: string) => undefined),
    notify: vi.fn((_message: string, _level?: string) => undefined),
    getEditorText: () => options.editor ?? "",
  };
  const ctx = {
    mode,
    hasUI: mode !== "print",
    ui,
    isIdle: () => options.idle ?? true,
    waitForIdle: async () => undefined,
    reload: vi.fn(async () => undefined),
  };
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      (handlers[event] ??= []).push(handler);
      return () => { handlers[event] = (handlers[event] ?? []).filter((candidate) => candidate !== handler); };
    }),
    registerCommand: vi.fn((name: string, spec: { handler: Handler }) => { commands[name] = spec; }),
  };
  const trigger = async (event: string) => { for (const handler of handlers[event] ?? []) await handler({}, ctx); };
  return { pi, ctx, ui, commands, trigger };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const footer = (h: ReturnType<typeof host>) => h.ui.setStatus.mock.calls.map((call) => call[1]);

describe("Steak Pi update notice and prompt", () => {
  it("shows one footer line and one dialog per version at an idle interactive session start", async () => {
    const h = host();
    updateNotice(h.pi as never);
    await h.trigger("session_start");
    await settle();
    expect(footer(h)).toEqual([`Steak Pi ${newer} available (you have ${current}) · /steak-update`]);
    expect(h.ui.select).toHaveBeenCalledTimes(1);
    expect(h.ui.select.mock.calls[0][0]).toBe(`Steak Pi ${newer} is available — you have ${current}.`);
    expect(h.ui.select.mock.calls[0][1]).toEqual(["Install update", "Remind me later", "Skip this version"]);
    expect(h.ui.select.mock.calls[0][2]).toMatchObject({ timeout: expect.any(Number) }); // a dialog never waits forever
    // "Remind me later" (or no answer): nothing again for this version within 24 hours.
    const again = host();
    updateNotice(again.pi as never);
    await again.trigger("session_start");
    await settle();
    expect(again.ui.select).not.toHaveBeenCalled();
    expect(again.ui.setStatus).not.toHaveBeenCalled();
  });

  it("keeps to the footer while a response runs or the user is typing", async () => {
    for (const options of [{ idle: false }, { editor: "half a prompt" }]) {
      rmSync(join(dir, "steak-pi.json"), { force: true });
      const h = host("tui", options);
      updateNotice(h.pi as never);
      await h.trigger("session_start");
      await settle();
      expect(footer(h)[0]).toContain(`Steak Pi ${newer} available`);
      expect(h.ui.select).not.toHaveBeenCalled();
    }
  });

  it("never checks, shows or asks in print, JSON/RPC or worker sessions", async () => {
    for (const mode of ["print", "rpc"] as const) {
      const h = host(mode);
      updateNotice(h.pi as never);
      await h.trigger("session_start");
      await settle();
      expect(h.ui.select).not.toHaveBeenCalled();
      expect(h.ui.setStatus).not.toHaveBeenCalled();
      expect(h.ui.notify).not.toHaveBeenCalled();
      await offerUpdate(h.ctx as never, state());
      expect(h.ui.select).not.toHaveBeenCalled();
    }
    expect(readdirSync(dir)).toEqual([]); // not even the cache file
  });

  it("stays silent under CI, the env opt-out and the settings switch", async () => {
    const quiet = async () => {
      const h = host();
      updateNotice(h.pi as never);
      await h.trigger("session_start");
      await settle();
      expect(h.ui.select).not.toHaveBeenCalled();
      expect(h.ui.setStatus).not.toHaveBeenCalled();
    };
    process.env.CI = "1";
    await quiet();
    delete process.env.CI;
    process.env.STEAK_PI_NO_UPDATE_CHECK = "1";
    await quiet();
    delete process.env.STEAK_PI_NO_UPDATE_CHECK;
    writeFileSync(join(dir, "steak-pi.json"), JSON.stringify({ updates: { checks: false } }));
    await quiet();
  });

  it("Skip this version hides that version; a newer one notifies again", async () => {
    const first = host();
    first.ui.select.mockResolvedValueOnce("Skip this version");
    updateNotice(first.pi as never);
    await first.trigger("session_start");
    await settle();
    expect(prefs().skippedVersion).toBe(newer);
    expect(footer(first).at(-1)).toBeUndefined();
    const next = bump(newer);
    process.env.STEAK_PI_LATEST_TAG = `v${next}`;
    rmSync(join(dir, "update-check.json"), { force: true });
    const second = host();
    updateNotice(second.pi as never);
    await second.trigger("session_start");
    await settle();
    expect(second.ui.select.mock.calls[0][0]).toContain(next);
  });

  it("Install update runs steak-pi update, asks once about automatic updates (default no), then reloads", async () => {
    const h = host();
    h.ui.select.mockResolvedValue("Install update");
    const runtime: UpdateRuntime = { runCli: vi.fn(async () => ({ ok: true, output: `Downloading...\nSteak Pi updated: ${current} -> ${newer}. Restart Pi or run /reload.` })) };
    await offerUpdate(h.ctx as never, state(), { pi: h.pi as never, runtime });
    expect(runtime.runCli).toHaveBeenCalledWith(["update"]);
    expect(h.ui.confirm).toHaveBeenCalledTimes(1);
    expect(h.ui.confirm.mock.calls[0][0]).toBe("Install future updates automatically?");
    expect(prefs()).toMatchObject({ auto: false, autoAsked: true });
    expect(h.ctx.reload).toHaveBeenCalledTimes(1);
    expect(h.ui.notify.mock.calls.at(-1)?.[0]).toContain(`Steak Pi updated: ${current} -> ${newer}`);
    await offerUpdate(h.ctx as never, state(), { runtime });
    expect(h.ui.confirm).toHaveBeenCalledTimes(1); // never asked again after "no"
  });

  it("a failed install names the cause and does not ask about automatic updates", async () => {
    const h = host();
    h.ui.select.mockResolvedValueOnce("Install update");
    await offerUpdate(h.ctx as never, state(), { runtime: { runCli: async () => ({ ok: false, output: "steak-pi: checksum mismatch for steak-pi-9.9.9.tgz; nothing was changed" }) } });
    expect(h.ui.notify.mock.calls.at(-1)?.[0]).toBe("Steak Pi update failed: steak-pi: checksum mismatch for steak-pi-9.9.9.tgz; nothing was changed");
    expect(h.ui.confirm).not.toHaveBeenCalled();
  });

  it("with automatic updates on, installs in the background and says it applies on /reload", async () => {
    setAutoUpdate(true);
    const version = bump(bump(newer));
    const h = host();
    const runDetached = vi.fn(async () => ({ ok: true, output: "Steak Pi updated." }));
    await installInBackground(state(version), h.ctx as never, { runDetached });
    expect(runDetached).toHaveBeenCalledWith(["update"]);
    expect(footer(h).at(-1)).toBe(`Steak Pi ${version} installed · /reload to use it`);
    expect(h.ui.select).not.toHaveBeenCalled();
  });

  it("a failed automatic install records its cause and falls back to the dialog", async () => {
    setAutoUpdate(true);
    const version = bump(bump(bump(newer)));
    const h = host();
    await installInBackground(state(version), h.ctx as never, { runDetached: async () => ({ ok: false, output: "Downloading...\nsteak-pi: download of steak-pi-x.tgz failed; nothing was changed" }) });
    expect(prefs().autoError).toBe("steak-pi: download of steak-pi-x.tgz failed; nothing was changed");
    expect(h.ui.notify.mock.calls[0][0]).toContain("automatic update failed");
    expect(h.ui.select.mock.calls[0][0]).toContain(version);
  });

  it("a detached run writes to one bounded log and reports its output", async () => {
    const log = join(dir, "logs", "auto-update.log");
    const result = await runDetached(["version"], log);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`steak-pi ${current}`);
    expect(readdirSync(join(dir, "logs"))).toEqual(["auto-update.log"]);
    expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it("/steak-update check reports a failed check with its cause", async () => {
    process.env.STEAK_PI_LATEST_TAG = "nightly";
    const h = host();
    updateNotice(h.pi as never);
    await h.commands["steak-update"].handler("check", h.ctx);
    expect(h.ui.notify.mock.calls[0][0]).toContain("Update check failed: STEAK_PI_LATEST_TAG has no x.y.z tag");
    expect(h.ui.select).not.toHaveBeenCalled();
  });

  it("notice text", () => {
    expect(noticeText(state())).toBe(`Steak Pi ${newer} available (you have ${current}) · /steak-update`);
    expect(noticeText({ current, available: false })).toBeUndefined();
    expect(UPDATE_CHOICES).toHaveLength(3);
  });
});

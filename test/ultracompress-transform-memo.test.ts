import "./ultracompress-settings-mock.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import ultraCompressExtension from "../extensions/ultracompress/index.ts";
import { runUltraCompress } from "../extensions/ultracompress/src/bridge.ts";
import {
  DEFAULT_SETTINGS,
  isUltraCompressBinAvailable,
  loadSettings,
  moduleDir,
  packageVersion,
  type UltraCompressSettings,
} from "../extensions/ultracompress/src/settings.ts";

vi.mock("../extensions/ultracompress/src/bridge.ts", () => ({ runUltraCompress: vi.fn() }));

const DEBUG_FILE = path.join(os.tmpdir(), "ultracompress-debug.json");
const text = (value: string) => ({ type: "text", text: value });
const long = "L".repeat(9000); // above Steak Pi's 8192-character default
const messages = () => [
  { role: "user", content: "go" },
  { role: "toolResult", content: [text(long)] },
  { role: "assistant", content: [text("done")] },
];
const model = { provider: "anthropic", input: ["text", "image"] };

type Handler = (event: any, ctx: any) => any;
function register(overrides: Partial<UltraCompressSettings> = {}) {
  const settings: UltraCompressSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    snapshot: { ...structuredClone(DEFAULT_SETTINGS.snapshot), enabled: false }, // never write snapshots into the repo cwd
    ...overrides,
  };
  vi.mocked(loadSettings).mockReturnValue(settings);
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Handler>();
  ultraCompressExtension({
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerCommand(name: string, command: { handler: Handler }) { commands.set(name, command.handler); },
    registerTool() {},
  } as never);
  return {
    settings,
    context: (ctx: any = { model }) => handlers.get("context")![1]({ messages: messages() }, ctx),
    start: () => handlers.get("session_start")![0]({}, { sessionManager: { getEntries: () => [] } }),
    compact: (event: any = {}, ctx: any = {}) => handlers.get("session_before_compact")![0](event, ctx),
    command: (name: string) => commands.get(name)!,
  };
}

const stats = (over: Record<string, unknown> = {}) => ({
  tokens_before_est: 10_000, tokens_after_est: 1_000, savings_pct: 90,
  summarized_messages: 4, kept_messages: 1, ...over,
});
const compactResult = (over: Record<string, unknown> = {}) => ({
  ok: true,
  data: { summary: "deterministic brief", first_kept_entry_id: "kept", details: {}, stats: stats(over) },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isUltraCompressBinAvailable).mockReturnValue(true);
  vi.mocked(runUltraCompress).mockReset();
  fs.rmSync(DEBUG_FILE, { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(DEBUG_FILE, { recursive: true, force: true });
});

describe("skipping the CLI when it cannot help", () => {
  it("does not spawn for a model without image input", async () => {
    const hooks = register();
    expect(await hooks.context({ model: { provider: "anthropic", input: ["text"] } })).toBeUndefined();
    expect(runUltraCompress).not.toHaveBeenCalled();
  });

  it("does not spawn when the model is unknown", async () => {
    const hooks = register();
    await hooks.context({});
    await hooks.context({ model: undefined });
    expect(runUltraCompress).not.toHaveBeenCalled();
  });

  it("does not spawn under the text-only vcc policy", async () => {
    const hooks = register({ policy: "vcc" });
    expect(await hooks.context()).toBeUndefined();
    expect(runUltraCompress).not.toHaveBeenCalled();
  });

  it("does not spawn when the binary is missing", async () => {
    vi.mocked(isUltraCompressBinAvailable).mockReturnValue(false);
    const hooks = register();
    await hooks.context();
    expect(runUltraCompress).not.toHaveBeenCalled();
  });
});

describe("memoizing blocks the core left as text", () => {
  it("records every non-op candidate after a successful response", async () => {
    const hooks = register();
    // The core reports neither ops nor no_gain; the block must still stick.
    vi.mocked(runUltraCompress).mockResolvedValue({ ok: true, data: { ops: [] } });
    expect(await hooks.context()).toBeUndefined();
    expect(await hooks.context()).toBeUndefined();
    expect(runUltraCompress).toHaveBeenCalledTimes(1);
  });

  it("honours the successful response's own no_gain list", async () => {
    const hooks = register();
    vi.mocked(runUltraCompress).mockResolvedValue({
      ok: true,
      data: { ops: [], no_gain: [{ message_index: 0, block_index: 0 }] },
    });
    await hooks.context();
    await hooks.context();
    expect(runUltraCompress).toHaveBeenCalledTimes(1);
  });

  it("applies cached snaps and keeps the rest memoized", async () => {
    const hooks = register();
    vi.mocked(runUltraCompress).mockResolvedValue({
      ok: true,
      data: {
        ops: [{
          op: "snap", message_index: 0, block_index: 0, head: "h\n", tail: "t",
          frames: [{ id: "f1", width: 1, height: 1, png_base64: "aGVsbG8=" }], tokens_before: 1, tokens_after: 2,
        }],
      },
    });
    const first = await hooks.context();
    expect(JSON.stringify(first.messages)).toContain('"data":"aGVsbG8="');
    expect((await hooks.context()).messages).toEqual(first.messages);
    expect(runUltraCompress).toHaveBeenCalledTimes(1);
  });

  it("retries a failed block once, then leaves it alone for the session", async () => {
    const hooks = register();
    vi.mocked(runUltraCompress).mockResolvedValue({ ok: false, error: "unavailable" });
    await hooks.context();
    await hooks.context();
    await hooks.context();
    expect(runUltraCompress).toHaveBeenCalledTimes(2);
  });

  it("forgets every decision on session_start", async () => {
    const hooks = register();
    vi.mocked(runUltraCompress).mockResolvedValue({ ok: true, data: { ops: [] } });
    await hooks.context();
    await hooks.context();
    expect(runUltraCompress).toHaveBeenCalledTimes(1);
    hooks.start();
    await hooks.context();
    expect(runUltraCompress).toHaveBeenCalledTimes(2);
  });
});

describe("vision gating per request", () => {
  it("re-evaluates vision when the model switches instead of latching it", async () => {
    const hooks = register();
    vi.mocked(runUltraCompress).mockResolvedValue({
      ok: true,
      data: {
        ops: [{
          op: "snap", message_index: 0, block_index: 0, head: "h\n", tail: "t",
          frames: [{ id: "f1", width: 1, height: 1, png_base64: "aGVsbG8=" }], tokens_before: 1, tokens_after: 2,
        }],
      },
    });
    const visionModel = { provider: "anthropic", input: ["text", "image"] };
    expect(JSON.stringify((await hooks.context({ model: visionModel })).messages)).toContain('"data":"aGVsbG8="');
    // The operator switches to a text-only model: cached frames must not be shipped to it.
    expect(await hooks.context({ model: { provider: "anthropic", input: ["text"] } })).toBeUndefined();
    expect(JSON.stringify((await hooks.context({ model: visionModel })).messages)).toContain('"data":"aGVsbG8="');
    expect(runUltraCompress).toHaveBeenCalledTimes(1);
  });

  it("re-reads vision after session_start", async () => {
    const hooks = register();
    vi.mocked(runUltraCompress).mockResolvedValue({ ok: true, data: { ops: [] } });
    expect(await hooks.context({ model: { provider: "anthropic", input: ["text"] } })).toBeUndefined();
    expect(runUltraCompress).not.toHaveBeenCalled();
    hooks.start();
    await hooks.context({ model });
    expect(runUltraCompress).toHaveBeenCalledTimes(1);
  });
});

describe("session_start", () => {
  it("drops calibration so a new session does not reuse it", async () => {
    const hooks = register();
    vi.mocked(runUltraCompress).mockResolvedValueOnce(compactResult({ chars_per_token: 4.25, calibrated: true }));
    await hooks.compact({ preparation: { tokensBefore: 10_000 }, branchEntries: [] });
    expect((vi.mocked(runUltraCompress).mock.lastCall?.[2] as { charsPerToken?: number }).charsPerToken).toBeUndefined();

    vi.mocked(runUltraCompress).mockResolvedValueOnce({ ok: true, data: { ops: [] } });
    await hooks.context();
    expect((vi.mocked(runUltraCompress).mock.lastCall?.[2] as { charsPerToken?: number }).charsPerToken).toBe(4.25);

    hooks.start();
    vi.mocked(runUltraCompress).mockResolvedValueOnce({ ok: true, data: { ops: [] } });
    await hooks.context();
    expect((vi.mocked(runUltraCompress).mock.lastCall?.[2] as { charsPerToken?: number }).charsPerToken).toBeUndefined();
  });
});

describe("debug log", () => {
  it("writes to the OS temp dir when debug is on", async () => {
    const hooks = register({ debug: true });
    vi.mocked(runUltraCompress).mockResolvedValue({ ok: false, error: "synthetic failure" });
    await hooks.context();
    const written = JSON.parse(fs.readFileSync(DEBUG_FILE, "utf8")) as { transformError: string };
    expect(written.transformError).toBe("synthetic failure");
  });

  it("reports a write failure once and keeps the session running", async () => {
    fs.mkdirSync(DEBUG_FILE); // writing a file at this path now fails with EISDIR
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const hooks = register({ debug: true });
    vi.mocked(runUltraCompress).mockResolvedValue({ ok: false, error: "synthetic failure" });
    await hooks.context();
    await hooks.context();
    await hooks.context();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain("[ultracompress] debug write failed");
    errors.mockRestore();
    fs.rmSync(DEBUG_FILE, { recursive: true, force: true });
  });

  it("stays silent when debug is off", async () => {
    const hooks = register({ debug: false });
    vi.mocked(runUltraCompress).mockResolvedValue({ ok: false, error: "synthetic failure" });
    await hooks.context();
    expect(fs.existsSync(DEBUG_FILE)).toBe(false);
  });
});

describe("module paths", () => {
  it("decodes file URLs instead of using the raw pathname", () => {
    expect(moduleDir("file:///tmp/a%20b/transforms.ts")).toBe("/tmp/a b");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const extensionSrc = path.join(here, "..", "extensions", "ultracompress", "src");
    expect(moduleDir(new URL("../extensions/ultracompress/src/settings.ts", import.meta.url).href)).toBe(extensionSrc);
  });

  it("reports unknown when no package.json describes the directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-no-manifest-"));
    try {
      expect(packageVersion(dir)).toBe("unknown");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stats command", () => {
  it("reports the version of the package that ships this extension", async () => {
    const hooks = register();
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(packageVersion()).toBe(pkg.version);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "uc-stats-"));
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const notify = vi.fn();
    try {
      await hooks.command("ultracompress-stats")(undefined, { ui: { notify } });
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
    const lines = String(notify.mock.calls[0][0]).split("\n");
    expect(lines[0]).toBe(`ultracompress ${pkg.version}`);
  });
});

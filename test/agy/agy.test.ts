import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearModelCache, listAgyModels, parseModels } from "../../extensions/agy/models.ts";
import { agyStatus, createAgyProvider } from "../../extensions/agy/provider.ts";
import { buildArgs, effortFor, promptInput, streamAgy } from "../../extensions/agy/stream.ts";
import { buildPrompt, knownConversations, PROMPT_MAX_BYTES, tailBytes } from "../../extensions/agy/prompt.ts";
import { legacyEnabledConfig, LEGACY_NOTICE } from "../../extensions/agy/legacy.ts";
import agyExtension from "../../extensions/agy/index.ts";

const FAKE = new URL("./fake-agy.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "agy-test-"));
const log = join(dir, "argv.log"), stdinLog = join(dir, "stdin.log"), pids = join(dir, "pids.log");
const saved = { ...process.env };

beforeEach(() => {
  clearModelCache(); knownConversations.clear();
  writeFileSync(log, ""); writeFileSync(pids, ""); writeFileSync(stdinLog, "");
  Object.assign(process.env, { STEAK_PI_AGY_BIN: FAKE, FAKE_AGY_LOG: log, FAKE_AGY_STDIN: stdinLog, FAKE_AGY_PIDS: pids });
  delete process.env.FAKE_AGY_SCENARIO; delete process.env.STEAK_PI_AGY_MODE;
});
afterEach(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const ctx = (...messages: unknown[]) => ({ messages }) as never;
const model = { id: "gemini-x-high", api: "agy-stream-json", provider: "agy" } as never;
const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
const turns = () => calls().filter((c) => c[0] !== "models");
/** The prompts agy received on stdin, one per turn. */
const prompts = () => readFileSync(stdinLog, "utf8").split("\n").filter(Boolean).map((l) => { const e = JSON.parse(l); expect(e.event).toBe("user"); return e.message.content as string; });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function run(scenario: string, messages: unknown[] = [user("hi")], options: Record<string, unknown> = {}) {
  process.env.FAKE_AGY_SCENARIO = scenario;
  const events: any[] = [];
  for await (const e of streamAgy(model, ctx(...messages), options as never)) events.push(e);
  const last = events.at(-1);
  return { events, message: last.message ?? last.error, last };
}

describe("models", () => {
  it("lists exactly what `agy models` prints, skipping headers", () => {
    expect(parseModels("Fetching available models...\ngemini-x-high Gemini X (High)\n\n")).toEqual([{ id: "gemini-x-high", name: "Gemini X (High)" }]);
  });
  it("reads them from the binary and builds provider models", async () => {
    expect((await listAgyModels()).map((m) => m.id)).toEqual(["gemini-x-high", "gemini-x-low", "other-model"]);
    await listAgyModels(); // cached
    expect(calls().filter((c) => c[0] === "models")).toHaveLength(1);
    const provider = createAgyProvider();
    let persisted: { models: { id: string; provider: string; api: string }[] } | undefined;
    await provider.refreshModels?.({ credential: undefined, allowNetwork: true, signal: new AbortController().signal, publish: async (p: { persist?: typeof persisted }) => { persisted = p.persist; return true; } } as never);
    expect(persisted?.models.map((m) => [m.id, m.provider, m.api])).toContainEqual(["other-model", "agy", "agy-stream-json"]);
  });
});

describe("missing and signed-out", () => {
  it("names a missing binary with the official install command", async () => {
    process.env.STEAK_PI_AGY_BIN = join(dir, "does-not-exist");
    const status = await agyStatus();
    expect(status.ok).toBe(false);
    if (!status.ok) { expect(status.error.kind).toBe("missing"); expect(status.error.message).toContain("curl -fsSL https://antigravity.google/cli/install.sh | bash"); }
    const { message } = await run("success");
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("install.sh");
  });
  it("hides the provider (check returns undefined) when missing or signed out", async () => {
    const provider = createAgyProvider() as any;
    const check = provider.auth.apiKey.check;
    process.env.STEAK_PI_AGY_BIN = join(dir, "nope");
    expect(await check({ signal: new AbortController().signal })).toBeUndefined();
    process.env.STEAK_PI_AGY_BIN = FAKE; process.env.FAKE_AGY_SCENARIO = "signed-out"; clearModelCache();
    expect(await check({ signal: new AbortController().signal })).toBeUndefined();
    const status = await agyStatus();
    expect(!status.ok && status.error.kind).toBe("signed-out");
    process.env.FAKE_AGY_SCENARIO = "success"; clearModelCache();
    expect(await check({ signal: new AbortController().signal })).toMatchObject({ type: "api_key" });
  });
  it("a turn with agy's real unauthenticated output names the cause, and leaks no sign-in URL", async () => {
    const { message } = await run("auth-error");
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("not signed in");
    expect(message.errorMessage).toContain("authentication failed or timed out");
    expect(message.errorMessage).toContain("run agy once to sign in");
    expect(message.errorMessage).not.toContain("accounts.google.com");
  });
  it("names a model the plan lacks", async () => {
    const { message } = await run("model-error");
    expect(message.errorMessage).toContain("does not offer the model");
    expect(message.errorMessage).toContain("agy models");
  });
});

describe("a turn", () => {
  it("streams ACTIVE deltas as text, then DONE, then result SUCCESS, with usage", async () => {
    const { events, message } = await run("success");
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => e.delta);
    expect(deltas).toEqual(["Git rebase ", "rewrites history.", "\n"]);
    expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_delta", "text_delta", "text_delta", "text_end", "done"]);
    expect(message.content).toEqual([{ type: "text", text: "Git rebase rewrites history.\n" }]);
    expect(message.stopReason).toBe("stop");
    expect(message.responseId).toBe("c3b66b04-872b-4fbe-a3a4-058a026ef20a");
    expect(message.usage).toMatchObject({ input: 10302 - 8113 + 116, cacheRead: 8113, output: 589, totalTokens: 11007, reasoning: 551 });
  });
  it("uses the result's response when only a DONE step with no delta... is streamed", async () => {
    const { message } = await run("done-only");
    expect(message.content[0].text).toBe("whole answer\n");
  });
  it("shows a tool step as one progress line, never a Pi tool call", async () => {
    const { events, message } = await run("tool");
    expect(events.some((e) => String(e.type).startsWith("toolcall"))).toBe(false);
    expect(message.content.every((b: any) => b.type === "text")).toBe(true);
    expect(message.content[0].text).toBe("› agy run_command: echo hello_headless_demo\nIt printed hello_headless_demo.\n");
    expect(message.stopReason).toBe("stop");
  });
  it.each([["canceled", "CANCELED"], ["interrupted", "INTERRUPTED"], ["waiting", "WAITING"]])("maps %s to a named error", async (scenario, word) => {
    const { message, last } = await run(scenario);
    expect(last.type).toBe("error");
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain(word);
  });
});

describe("arguments", () => {
  it("runs agy as documented, in the session cwd, with agy's own permissions", async () => {
    await run("success", [user("hi")]);
    expect(turns()[0]).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-x-high", "--disable-slash-commands", "--add-dir", process.cwd()]);
    expect(prompts()).toEqual(["hi"]);
  });
  it("sends the prompt on stdin, never in argv, even one that looks like a flag", async () => {
    const flag = "--dangerously-skip-permissions please";
    await run("success", [user(flag)]);
    expect(turns()[0].join(" ")).not.toContain("dangerously");
    expect(turns()[0]).not.toContain(flag);
    expect(prompts()).toEqual([flag]);
    expect(promptInput("a\nb")).toBe('{"event":"user","message":{"content":"a\\nb"}}\n');
  });
  it("carries a 300 KB non-ASCII prompt intact", async () => {
    const big = "héllo 日本語 🚀 ".repeat(15_000);
    expect(Buffer.byteLength(big)).toBeGreaterThan(300_000);
    const { message } = await run("success", [user(big)]);
    expect(message.stopReason).toBe("stop");
    expect(prompts()).toEqual([big.trim()]);
    expect(JSON.stringify(turns())).not.toContain("héllo");
  });
  it("maps Pi thinking levels to --effort and never passes --dangerously-skip-permissions", async () => {
    expect(["off", "minimal", "low", "medium", "high", "xhigh", "max", undefined].map(effortFor)).toEqual(["low", "low", "low", "medium", "high", "xhigh", "max", undefined]);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) await run("success", [user("hi")], { reasoning: level });
    process.env.STEAK_PI_AGY_MODE = "plan";
    await run("success", [user("hi")], { reasoning: "high" });
    const all = turns();
    expect(all.map((c) => c[c.indexOf("--effort") + 1])).toEqual(["low", "low", "low", "medium", "high", "xhigh", "high"]);
    expect(all.at(-1)).toContain("--mode");
    expect(all.flat()).not.toContain("--dangerously-skip-permissions");
    expect(buildArgs({ model: "m", cwd: "/w" })).not.toContain("--dangerously-skip-permissions");
  });
  it("rejects an unknown mode instead of ignoring it", async () => {
    process.env.STEAK_PI_AGY_MODE = "yolo";
    const { message } = await run("success");
    expect(message.errorMessage).toContain("STEAK_PI_AGY_MODE");
    expect(turns()).toHaveLength(0);
  });
  it("resumes the conversation when history is linear, and replays a transcript otherwise", async () => {
    const first = await run("success", [user("one")]);
    const a1 = first.message;
    await run("success", [user("one"), a1, user("two")]);
    const second = turns()[1];
    expect(prompts()[1]).toBe("two");
    expect(second[second.indexOf("--conversation") + 1]).toBe("c3b66b04-872b-4fbe-a3a4-058a026ef20a");
    // An edited branch (the assistant message is not the one agy last produced) gets a fresh conversation and a transcript.
    knownConversations.clear();
    await run("success", [user("one"), a1, user("two")]);
    const third = turns()[2];
    expect(third).not.toContain("--conversation");
    expect(prompts()[2]).toContain("[user]\none");
    expect(prompts()[2]).toContain("[assistant]\nGit rebase rewrites history.");
    expect(prompts()[2]).toContain("Current request:\ntwo");
  });
  it("resuming sends every user message since agy's last reply", async () => {
    const a1 = (await run("success", [user("one")])).message;
    await run("success", [user("one"), a1, user("two"), user("three")]);
    expect(prompts()[1]).toBe("two\n\nthree");
    expect(turns()[1]).toContain("--conversation");
  });
  it("caps a replayed transcript by bytes, on a character boundary", () => {
    expect(tailBytes("日本語日本語", 7)).toBe("本語"); // 7 bytes would split a character: the partial one is dropped
    const msgs = Array.from({ length: 200 }, (_, i) => [user("日本語".repeat(300) + i), { role: "assistant", content: [{ type: "text", text: "ok" }], provider: "other", model: "m", timestamp: 2 }]).flat();
    const built = buildPrompt([...msgs, user("now")] as never, "m");
    expect(Buffer.byteLength(built.prompt)).toBeLessThanOrEqual(PROMPT_MAX_BYTES);
    expect(built.prompt).toContain("Current request:\nnow");
    expect(built.prompt).not.toContain("\ufffd");
  });
});

describe("cancellation", () => {
  const waitFor = async (cond: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25)); };
  const pidList = () => readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);

  it("abort stops agy and its children with SIGINT first, leaving no live process", async () => {
    process.env.FAKE_AGY_SCENARIO = "hang";
    const controller = new AbortController();
    const stream = streamAgy(model, ctx(user("go")), { signal: controller.signal } as never);
    await waitFor(() => pidList().length >= 2);
    expect(pidList()).toHaveLength(2);
    controller.abort();
    const events: any[] = [];
    for await (const e of stream) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    await waitFor(() => pidList().every((p) => !alive(p)));
    expect(pidList().filter(alive)).toEqual([]);
  }, 20_000);

  it("escalates to SIGKILL when agy ignores SIGINT and SIGTERM", async () => {
    process.env.FAKE_AGY_SCENARIO = "stubborn";
    const controller = new AbortController();
    const stream = streamAgy(model, ctx(user("go")), { signal: controller.signal } as never);
    await waitFor(() => pidList().length >= 2);
    controller.abort();
    for await (const _ of stream) { /* drain */ }
    await waitFor(() => pidList().every((p) => !alive(p)));
    expect(pidList().filter(alive)).toEqual([]);
  }, 20_000);

  it("kills a tool that ignores SIGINT/SIGTERM and holds agy's stdout once agy has exited, and the turn resolves", async () => {
    const { message } = await run("orphan", [user("go")]);
    expect(message.stopReason).toBe("stop");
    expect(pidList()).toHaveLength(2);
    await waitFor(() => pidList().every((p) => !alive(p)));
    expect(pidList().filter(alive)).toEqual([]);
  }, 20_000);

  it("a timeout still fires while a gentler stop is pending", async () => {
    const controller = new AbortController();
    process.env.FAKE_AGY_SCENARIO = "stubborn";
    const events: any[] = [];
    const stream = streamAgy(model, ctx(user("go")), { signal: controller.signal, timeoutMs: 2000 } as never);
    await waitFor(() => pidList().length >= 2, 1500);
    expect(pidList()).toHaveLength(2);
    const started = Date.now(); // measure only abort -> timeout -> stream resolution; fixture startup is not this behavior
    controller.abort(); // stop() is now pending (agy ignores SIGINT/SIGTERM); the timeout must not wait for it
    for await (const e of stream) events.push(e);
    expect(Date.now() - started).toBeLessThan(2500);
    await waitFor(() => pidList().every((p) => !alive(p)));
    expect(pidList().filter(alive)).toEqual([]);
  }, 20_000);

  it("a Pi that gets SIGTERM kills agy's group and still exits from the signal", async () => {
    const script = new URL("./pi-child.mjs", import.meta.url).pathname;
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, FAKE_AGY_SCENARIO: "stubborn" } });
    await waitFor(() => pidList().length >= 2);
    expect(pidList()).toHaveLength(2);
    const exited = new Promise<string | null>((resolve) => child.once("exit", (_c, sig) => resolve(sig)));
    child.kill("SIGTERM");
    expect(await exited).toBe("SIGTERM");
    await waitFor(() => pidList().every((p) => !alive(p)));
    expect(pidList().filter(alive)).toEqual([]);
  }, 20_000);

  it("a timeout kills the child and is named", async () => {
    process.env.FAKE_AGY_SCENARIO = "hang";
    const { message } = await run("hang", [user("go")], { timeoutMs: 300 });
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("timed out");
    await waitFor(() => pidList().every((p) => !alive(p)));
    expect(pidList().filter(alive)).toEqual([]);
  }, 20_000);
});

describe("retired direct route", () => {
  it("notifies once at session start when the old config is enabled, and never otherwise", () => {
    const old = join(dir, "antigravity.json");
    writeFileSync(old, '{"enabled": true}'); chmodSync(old, 0o600);
    process.env.STEAK_PI_ANTIGRAVITY_CONFIG = old;
    expect(legacyEnabledConfig()).toBe(old);
    const handlers: Record<string, (e: unknown, c: any) => void> = {};
    const registered: any[] = [];
    agyExtension({ registerProvider: (p: any) => registered.push(p), registerCommand: () => {}, on: (n: string, h: any) => { handlers[n] = h; } } as never);
    expect(registered.map((p) => p.id)).toEqual(["agy"]);
    const notes: string[][] = [];
    handlers.session_start({}, { ui: { notify: (m: string, l: string) => notes.push([m, l]) } });
    expect(notes).toEqual([[LEGACY_NOTICE, "warning"]]);
    expect(LEGACY_NOTICE).toContain("terms");
    expect(LEGACY_NOTICE).toContain("docs/AGY.md");
    writeFileSync(old, '{"enabled": false}');
    expect(legacyEnabledConfig()).toBeUndefined();
    process.env.STEAK_PI_ANTIGRAVITY_CONFIG = join(dir, "absent.json");
    expect(legacyEnabledConfig()).toBeUndefined();
    expect(existsSync(old)).toBe(true); // never deleted for the user
  });
});

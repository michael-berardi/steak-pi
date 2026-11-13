// `steak-pi update --models` refreshes Pi's cached catalogs with extensions loaded. `pi update --models` builds its
// model runtime without them, so an extension provider's row stayed as cached while the command reported success.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { formatModelRefreshReport, refreshModelCatalogs, type RefreshRegistry } from "../src/model-refresh-extension.ts";
import { writeFakeClaude } from "./helpers/fake-claude-catalog.ts";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "bin", "steak-pi");
const PI_CLI = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

/** An isolated home whose `pi` is the real Pi runtime with only the claude-code extension, and a fake claude CLI. */
function fixture(pi?: string) {
  const home = mkdtempSync(join(tmpdir(), "steak-update-models-"));
  homes.push(home);
  const bin = join(home, "bin"); mkdirSync(bin);
  const agent = join(home, "agent"); mkdirSync(agent);
  const claude = join(bin, "claude");
  writeFileSync(join(bin, "pi"), pi ?? `#!/bin/sh\nexec "${process.execPath}" "${PI_CLI}" --no-extensions -e "${join(ROOT, "extensions/claude-code/index.ts")}" "$@"\n`, { mode: 0o755 });
  const store = join(agent, "models-store.json");
  const run = (args: string[]) => spawnSync("/bin/sh", [CLI, ...args], {
    encoding: "utf8",
    timeout: 110_000,
    // No provider credential reaches the child, so no built-in provider is fetched: the test uses no network.
    env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: agent, PI_CLAUDE_CODE_COMMAND: claude, PI_SKIP_VERSION_CHECK: "1", STEAK_PI_LIBEXEC: "", STEAK_PI_LATEST_TAG: "v0.0.1" },
  });
  const row = () => JSON.parse(readFileSync(store, "utf8"))["claude-code"] as { models: { id: string }[]; steakPiVersion?: string };
  return { claude, store, run, row };
}

const SEVEN = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];

describe("steak-pi update --models", () => {
  it("replaces a stale extension-provider row and reports the provider, without an 'up to date' line", () => {
    const f = fixture();
    writeFakeClaude(f.claude, SEVEN);
    writeFileSync(f.store, JSON.stringify({ "claude-code": { models: SEVEN.slice(0, 5).map((id) => ({ id, provider: "claude-code", name: id })), checkedAt: 1 } }));
    const result = f.run(["update", "--models"]);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain("claude-code: refreshed with 7 models");
    expect(result.stdout).toContain("Model catalogs refreshed.");
    expect(result.stdout).not.toContain("up to date");
    expect(f.row().models.map((model) => model.id)).toEqual(SEVEN);
    expect(f.row().steakPiVersion).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
  }, 120_000);

  it("names the provider's error and exits non-zero, leaving the stored row", () => {
    const f = fixture();
    writeFakeClaude(f.claude, "fail");
    writeFileSync(f.store, JSON.stringify({ "claude-code": { models: [{ id: "m1", provider: "claude-code" }], checkedAt: 1 } }));
    const result = f.run(["update", "--models"]);
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(result.stdout).toMatch(/claude-code: FAILED: .*model discovery failed.*catalog probe refused/);
    expect(result.stdout).not.toContain("Model catalogs refreshed");
    expect(result.stdout + result.stderr).not.toContain("up to date");
    expect(f.row().models).toHaveLength(1);
  }, 120_000);

  it("fails when pi exits before the refresh finished", () => {
    const f = fixture("#!/bin/sh\necho 'pi cannot start' >&2\nexit 3\n");
    const result = f.run(["update", "--models"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("model catalogs were not refreshed: pi exited (3) before the refresh finished");
    expect(result.stderr).toContain("pi cannot start");
    expect(result.stdout).not.toContain("up to date");
  }, 30_000);
});

describe("refreshModelCatalogs", () => {
  function registry(script: { errors?: [string, string][]; write?: Record<string, number>; aborted?: boolean }[], registered: string[], configured: string[] = registered) {
    const store: Record<string, { models: unknown[]; checkedAt: number }> = {};
    const calls: { providers?: readonly string[]; allowNetwork: boolean; force: boolean }[] = [];
    const fake: RefreshRegistry = {
      async refresh(options) {
        calls.push({ providers: options.providers, allowNetwork: options.allowNetwork, force: options.force });
        const step = script[calls.length - 1] ?? {};
        for (const [provider, count] of Object.entries(step.write ?? {})) store[provider] = { models: Array.from({ length: count }, () => ({})), checkedAt: Date.now() };
        return { aborted: step.aborted ?? false, errors: new Map((step.errors ?? []).map(([provider, message]) => [provider, new Error(message)])) };
      },
      getAll: () => [{ provider: "builtin-a" }, { provider: "builtin-a" }, { provider: "builtin-b" }, { provider: "ext-a" }],
      getRegisteredProviderIds: () => registered,
      getProviderAuthStatus: (provider) => ({ configured: configured.includes(provider) }),
    };
    return { fake, calls, read: () => store };
  }

  it("forces a network refresh of every provider and reports each one", async () => {
    const r = registry([{ write: { "ext-a": 7, "builtin-a": 0 }, errors: [["ext-b", "login required"]] }], ["ext-a", "ext-b", "ext-c"], ["ext-a", "ext-b"]);
    const report = await refreshModelCatalogs(r.fake, r.read);
    expect(r.calls).toEqual([{ providers: undefined, allowNetwork: true, force: true }]);
    expect(report.ok).toBe(false);
    expect(formatModelRefreshReport(report)).toEqual([
      "builtin-a: refreshed with 2 models", // an empty overlay row: the provider's built-in catalog stands
      "ext-a: refreshed with 7 models",
      "ext-b: FAILED: login required",
      "ext-c: skipped (not configured)",
      "1 provider without a configured credential was not fetched.",
    ]);
  });

  it("retries an extension provider whose refresh Pi's own startup refresh superseded, and fails it if it still did not run", async () => {
    const retried = registry([{}, { write: { "ext-a": 3 } }], ["ext-a"]);
    const ok = await refreshModelCatalogs(retried.fake, retried.read);
    expect(retried.calls[1]).toEqual({ providers: ["ext-a"], allowNetwork: true, force: true });
    expect(ok.ok).toBe(true);
    expect(ok.providers).toEqual([{ provider: "ext-a", status: "refreshed", models: 3 }]);
    const stuck = registry([{}, {}], ["ext-a"]);
    const failed = await refreshModelCatalogs(stuck.fake, stuck.read);
    expect(failed.ok).toBe(false);
    expect(failed.providers).toEqual([{ provider: "ext-a", status: "failed", detail: "the refresh did not complete" }]);
  });

  it("reports a timeout as a failure", async () => {
    const r = registry([{ aborted: true }], ["ext-a"]);
    const report = await refreshModelCatalogs(r.fake, r.read);
    expect(report.ok).toBe(false);
    expect(report.providers).toEqual([{ provider: "ext-a", status: "failed", detail: "the refresh timed out" }]);
  });
});

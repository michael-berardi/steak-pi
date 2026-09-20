import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APPROVED_EXTENSIONS, preflightPrimary, createPrimaryShell, resolveNativePi, resolveSystemBash } from "../src/deepseek-primary.ts";
import { isDeepSeekHarnessRoute } from "../src/deepseek-harness/index.ts";

describe("managed primary admission", () => {
  function fixture(run: (root: string, cwd: string, agent: string) => void) {
    const base = mkdtempSync(join(tmpdir(), "primary-dsh-"));
    const root = join(base, "steak"); const cwd = join(base, "project"); const agent = join(base, "agent");
    for (const dir of [root, join(cwd, ".pi"), agent]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "steak-pi", version: "0.6.0", pi: { extensions: ["./extensions", "./extensions/ultracompress/index.ts", "./extensions/skill-catalog-lite/index.ts"] } }));
    for (const name of APPROVED_EXTENSIONS) { const p = join(root, "extensions", name); mkdirSync(resolve(p, ".."), { recursive: true }); writeFileSync(p, ""); }
    try { run(root, cwd, agent); } finally { rmSync(base, { recursive: true, force: true }); }
  }
  it("admits the fully enabled canonical package and retains discovery of mandatory resources", () => fixture((root, cwd, agent) => {
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [root] }));
    const args = preflightPrimary(root, cwd, agent, ["--print", "hello"], {});
    expect(args).toContain("--no-extensions"); expect(args.filter(a => a === "-e")).toHaveLength(APPROVED_EXTENSIONS.length);
    expect(args).toContain("--steak-dsh-managed"); expect(args).toContain("deepseek-v4.1-flash");
    expect(args).not.toContain("--no-context-files"); expect(args).not.toContain("--no-prompt-templates"); expect(args).not.toContain("--no-skills");
  }));
  for (const settings of [{ packages: ["npm:unknown"] }, { shellCommandPrefix: "guard" }, { shellPath: "/bin/bash" }, { tools: { bash: { commandPrefix: "guard" } } }, { extensions: ["guard.ts"] }, { packages: [{ source: "/unknown", extensions: [] }] }]) {
    it(`rejects unsupported settings ${JSON.stringify(settings)}`, () => fixture((root, cwd, agent) => {
      writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify(settings));
      expect(() => preflightPrimary(root, cwd, agent, [], {})).toThrow(/nothing was launched/);
    }));
  }
  it("rejects discovered guards, override flags, and startup hooks", () => fixture((root, cwd, agent) => {
    expect(() => preflightPrimary(root, cwd, agent, ["--no-tools"], {})).toThrow();
    expect(() => preflightPrimary(root, cwd, agent, [], { BASH_ENV: "guard" })).toThrow();
    mkdirSync(join(agent, "extensions")); writeFileSync(join(agent, "extensions/guard.ts"), "");
    expect(() => preflightPrimary(root, cwd, agent, [], {})).toThrow(/unapproved extension/);
  }));
  it("rejects hidden package entrypoints and newly discovered nested guards", () => fixture((root, cwd, agent) => {
    mkdirSync(join(root, "extensions/new.guard")); writeFileSync(join(root, "extensions/new.guard/index.ts"), "");
    expect(() => preflightPrimary(root, cwd, agent, [], {})).toThrow(/directory/);
    rmSync(join(root, "extensions/new.guard"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "steak-pi", version: "0.6.0", pi: { extensions: ["./guard.ts"] } }));
    expect(() => preflightPrimary(root, cwd, agent, [], {})).toThrow(/manifest/);
  }));
  it("pins supported system bash and refuses a PATH shadow", () => fixture((_root, cwd) => {
    expect(resolveSystemBash({ SHELL: "/bin/bash" }, cwd)).toMatch(/\/bash$/);
    writeFileSync(join(cwd, "bash"), "#!/bin/sh\n");
    expect(() => resolveSystemBash({ SHELL: "/bin/zsh", PATH: cwd }, cwd)).toThrow(/custom PATH/);
  }));
  it.skipIf(!process.env.DSH_QA_SDK)("resolves the published Pi0.86 bundled CLI from its pinned SDK", () => {
    expect(resolveNativePi("", process.env.DSH_QA_SDK)).toMatch(/\/dist\/bundle\/cli\.js$/);
  });
  it("gates the exact route", () => {
    expect(isDeepSeekHarnessRoute({ provider: "opencode-go", id: "deepseek-v4.1-flash" })).toBe(true);
    expect(isDeepSeekHarnessRoute({ provider: "opencode", id: "deepseek-v4.1-flash" })).toBe(false);
    expect(isDeepSeekHarnessRoute(undefined)).toBe(false);
  });
});

describe("primary native operations", () => {
  it("preserves state and native metadata, then positively cleans and restores a fresh shell", async () => {
    const shell = createPrimaryShell(process.cwd());
    const exec = async (command: string, env: Record<string, string> = { PI_TEST_PRIMARY: "metadata" }) => { let output = ""; const result = await shell.operations.exec(command, process.cwd(), { onData: b => { output += b; }, env }); return { output, ...result }; };
    try {
      await exec("export DSH_TEST_PRIMARY=kept");
      expect((await exec('printf "%s:%s" "$DSH_TEST_PRIMARY" "$PI_TEST_PRIMARY"')).output).toBe("kept:metadata");
      expect((await exec("false")).exitCode).toBe(1);
      expect((await exec('printf "%s" "${PI_TEST_PRIMARY-unset}"', {})).output).toBe("unset");
      await shell.dispose();
      expect((await exec('printf "%s" "${DSH_TEST_PRIMARY-unset}"')).output).toBe("unset");
      await expect(exec("exit 0")).rejects.toThrow(/did not complete normally/);
    } finally { await shell.dispose(); }
  });
  it("fails rather than accepting a null completion", async () => {
    const shell = createPrimaryShell(process.cwd(), (() => ({ exec: async () => "timeout", dispose: async () => {} })) as any);
    await expect(shell.operations.exec("x", ".", { onData() {} })).rejects.toThrow(/did not complete normally/);
    await shell.dispose();
  });
  it("poisons future execution when cleanup cannot be confirmed", async () => {
    const shell = createPrimaryShell(process.cwd(), (() => ({ exec: async (_: string, o: any) => { o.onExitCode(0); return ""; }, dispose: async () => { throw new Error("not reaped"); } })) as any);
    await shell.operations.exec("x", ".", { onData() {} });
    await expect(shell.dispose()).rejects.toThrow("not reaped");
    await expect(shell.operations.exec("x", ".", { onData() {} })).rejects.toThrow("cleanup failed");
  });
});

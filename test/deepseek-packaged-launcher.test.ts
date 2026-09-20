import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const source = fileURLToPath(new URL("../", import.meta.url));
const extensions = ["deepseek-harness.ts", "model-route-policy.ts", "session-title.ts", "statusline.ts", "todo.ts", "ultraterm-inbox.ts", "ultraterm-subagents.ts", "ultraterm-ui.ts", "verify-after-edit.ts", "ultracompress/index.ts", "skill-catalog-lite/index.ts"];

function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const f = setup();
  try { run(f); } finally { rmSync(f.base, { recursive: true, force: true }); }
}
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dsh-packaged-")));
  const root = join(base, "node_modules/steak-pi");
  const cwd = join(base, "project");
  const agent = join(base, "agent");
  const sdk = join(base, "node_modules/@earendil-works/pi-coding-agent");
  const marker = join(base, "native-spawn.json");
  for (const dir of [cwd, agent, join(sdk, "dist"), join(root, "skills")]) mkdirSync(dir, { recursive: true });
  // Real, unmodified package files, physically beneath node_modules (not symlinks).
  for (const name of ["package.json", "bin/steak-pi-dsh", "src/deepseek-primary.ts", "vendor/pi-dsh-minimal/bash-session.ts", ...extensions.map(p => `extensions/${p}`)]) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, name), target);
  }
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [root] }));
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.86.0", type: "module", bin: { pi: "dist/cli.js" } }));
  writeFileSync(join(sdk, "dist/cli.js"), `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), root: process.env.STEAK_DSH_MANAGED_ROOT, execArgv: process.execArgv }));
console.log("fake-native-pi 0.86.0");`);
  // Intentionally do not inherit developer credentials, startup hooks or settings.
  const env = { PATH: "/usr/bin:/bin", SHELL: "/bin/bash", HOME: base, PI_CODING_AGENT_DIR: agent, ULTRATERM_PI_PACKAGE_ROOT: sdk };
  const launcher = join(root, "bin/steak-pi-dsh");
  const launch = (args = ["--version"], overrides = {}) => spawnSync(process.execPath, [launcher, ...args], { cwd, env: { ...env, ...overrides }, encoding: "utf8", timeout: 15_000 });
  return { base, root, cwd, agent, marker, launcher, env, launch };
}

describe("installed DSH launcher (actual Node, zero model requests)", () => {
  it("loads the reviewed package beneath node_modules and reaches native Pi --version", () => fixture(f => {
    const result = f.launch();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("fake-native-pi 0.86.0\n");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING");
    const spawned = JSON.parse(readFileSync(f.marker, "utf8"));
    expect(spawned.args).toContain("--version");
    expect(spawned.args).toContain("--steak-dsh-managed");
    expect(spawned.args.filter((a: string) => a === "-e")).toHaveLength(extensions.length);
    expect(spawned.root).toBe(f.root);
    expect(spawned.execArgv).toEqual([]);
  }));

  for (const option of ["--no-tools", "--extension", "--provider", "--model"]) {
    it(`still rejects unsafe ${option} before native spawn`, () => fixture(f => {
      const result = f.launch([option, "unreviewed", "--version"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("preflight:");
      expect(result.stderr).toContain(option);
      expect(result.stderr).toContain("nothing was launched");
      expect(existsSync(f.marker)).toBe(false);
    }));
  }
  for (const key of ["BASH_ENV", "ENV", "NODE_OPTIONS", "PI_PACKAGE_DIR"]) {
    it(`still rejects ${key} before native spawn`, () => fixture(f => {
      const result = f.launch(["--version"], { [key]: key === "NODE_OPTIONS" ? "--trace-warnings" : "/unreviewed" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${key} is unsupported`);
      expect(existsSync(f.marker)).toBe(false);
    }));
  }
  it("still rejects configured shell guards before native spawn", () => fixture(f => {
    writeFileSync(join(f.agent, "settings.json"), JSON.stringify({ shellCommandPrefix: "guard" }));
    const result = f.launch();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported setting shellCommandPrefix");
    expect(existsSync(f.marker)).toBe(false);
  }));

  for (const extra of ["src/unreviewed.ts", "vendor/pi-dsh-minimal/unreviewed.ts", "../unreviewed/extra.ts"]) {
    it(`does not strip arbitrary ${extra} even while its hook is active`, () => fixture(f => {
      const target = join(f.root, extra);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "export const value: number = 1;\n");
      appendFileSync(join(f.root, "src/deepseek-primary.ts"), `\nimport ${JSON.stringify(pathToFileURL(target).href)};\n`);
      const result = f.launch();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Stripping types is currently unsupported for files under node_modules");
      expect(result.stderr).toContain("unreviewed");
      expect(existsSync(f.marker)).toBe(false);
    }));
  }

  for (const failImport of [false, true]) {
    it(`deregisters its temporary hook after ${failImport ? "failed" : "successful"} import`, () => fixture(f => {
      if (failImport) appendFileSync(join(f.root, "src/deepseek-primary.ts"), '\nthrow new Error("fixture import failure");\n');
      const probe = join(f.base, "probe.mjs");
      writeFileSync(probe, `import module from "node:module";
const original = module.registerHooks;
let registered = 0, deregistered = 0;
module.registerHooks = (...args) => {
  registered++;
  const hook = original(...args);
  return { deregister() { deregistered++; return hook.deregister(); } };
};
module.syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(f.launcher).href)});
console.log(JSON.stringify({ registered, deregistered }));`);
      const result = spawnSync(process.execPath, [probe, "--no-session"], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 15_000 });
      expect(result.stdout).toContain('{"registered":1,"deregistered":1}');
      expect(result.status, result.stderr).toBe(failImport ? 1 : 0);
      expect(existsSync(f.marker)).toBe(!failImport);
    }));
  }
});

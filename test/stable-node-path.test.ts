import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { homebrewOptNodePath, NodeRuntimeMovedError, NODE_PATH_ENV, stableNodePath } from "../extensions/claude-code/stable-node-path.ts";

const OLD = "/opt/homebrew/Cellar/node@22/22.23.4_2/bin/node";
const OPT = "/opt/homebrew/opt/node@22/bin/node";
const live = (...paths: string[]) => (path: string) => paths.includes(path);

describe("stableNodePath", () => {
  it("maps a vanished versioned Cellar execPath to the opt link", () => {
    expect(stableNodePath({ execPath: OLD, env: {}, isExecutable: live(OPT) })).toBe(OPT);
  });

  it("uses the opt link of any formula and prefix, with no hard-coded version", () => {
    expect(stableNodePath({ execPath: "/usr/local/Cellar/node/25.1.0/bin/node", env: {}, isExecutable: live("/usr/local/opt/node/bin/node") }))
      .toBe("/usr/local/opt/node/bin/node");
  });

  it("prefers the opt link even while the old keg still exists", () => {
    expect(stableNodePath({ execPath: OLD, env: {}, isExecutable: live(OLD, OPT) })).toBe(OPT);
  });

  it("returns a non-Homebrew execPath unchanged", () => {
    const nvm = "/home/dev/.nvm/versions/node/v22.20.0/bin/node";
    expect(stableNodePath({ execPath: nvm, env: {}, isExecutable: live(nvm) })).toBe(nvm);
  });

  it("falls back to execPath when the opt link is missing but the keg exists", () => {
    expect(stableNodePath({ execPath: OLD, env: {}, isExecutable: live(OLD) })).toBe(OLD);
  });

  it("honours an executable explicit override first and ignores a dead one", () => {
    expect(stableNodePath({ execPath: OLD, env: { [NODE_PATH_ENV]: "/custom/node" }, isExecutable: live("/custom/node", OPT) })).toBe("/custom/node");
    expect(stableNodePath({ execPath: OLD, env: { [NODE_PATH_ENV]: "/dead/node" }, isExecutable: live(OPT) })).toBe(OPT);
  });

  it("throws the named error, not an escaping spawn failure, when nothing is left", () => {
    let caught: unknown;
    try { stableNodePath({ execPath: OLD, env: {}, isExecutable: live() }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(NodeRuntimeMovedError);
    expect((caught as Error).message).toBe(`node runtime moved: ${OLD}; restart this session`);
    expect((caught as NodeRuntimeMovedError).code).toBe("ERR_NODE_RUNTIME_MOVED");
  });

  it("resolves at call time, so an upgrade mid-session is survived", () => {
    let present = new Set([OLD, OPT]);
    const deps = { execPath: OLD, env: {}, isExecutable: (path: string) => present.has(path) };
    expect(stableNodePath(deps)).toBe(OPT);
    present = new Set([OPT]);
    expect(stableNodePath(deps)).toBe(OPT);
  });

  it("homebrewOptNodePath only maps Cellar node paths", () => {
    expect(homebrewOptNodePath(OLD)).toBe(OPT);
    expect(homebrewOptNodePath("/usr/bin/node")).toBeUndefined();
  });

  it("the real process resolves to something executable", () => {
    expect(stableNodePath()).toMatch(/node/);
  });
});

describe("spawn sites", () => {
  it("never pass a bare process.execPath to a child", () => {
    for (const rel of ["../extensions/claude-code/claude-cli.ts", "../src/local/runtime.ts"]) {
      const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(source, rel).not.toMatch(/process\.execPath/);
      expect(source, rel).toMatch(/stableNodePath\(\)/);
    }
  });
});

describe("bin/steak-pi launcher", () => {
  const bin = fileURLToPath(new URL("../bin/steak-pi", import.meta.url));
  const exe = (path: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755); };
  function launcherNode(setup: (root: string) => string, extraEnv: Record<string, string> = {}): string {
    const root = mkdtempSync(join(tmpdir(), "steak-pi-node-"));
    try {
      const pathDir = setup(root);
      const fakePi = join(root, "fakebin/pi"); exe(fakePi);
      writeFileSync(fakePi, '#!/bin/sh\nprintf "STEAK_PI_NODE=%s\\n" "${STEAK_PI_NODE:-}"\n');
      const out = execFileSync("/bin/sh", [bin, "run"], { encoding: "utf8", env: { PATH: `${pathDir}:${join(root, "fakebin")}:/usr/bin:/bin`, HOME: root, ...extraEnv } });
      return /^STEAK_PI_NODE=(.*)$/m.exec(out)?.[1] ?? "";
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it("exports the opt link when node was found through a versioned Cellar path", () => {
    let expected = "";
    const got = launcherNode((root) => {
      exe(join(root, "Cellar/node@22/22.1.0/bin/node"));
      exe(join(root, "opt/node@22/bin/node"));
      expected = join(root, "opt/node@22/bin/node");
      return join(root, "Cellar/node@22/22.1.0/bin");
    });
    expect(got).toBe(expected);
  });

  it("keeps a non-Homebrew node path and honours an explicit override", () => {
    let dir = "";
    expect(launcherNode((root) => { exe(join(root, "bin/node")); dir = join(root, "bin"); return dir; })).toBe(join(dir, "node"));
    expect(launcherNode((root) => { exe(join(root, "bin/node")); return join(root, "bin"); }, { STEAK_PI_NODE: "/custom/node" })).toBe("/custom/node");
  });
});

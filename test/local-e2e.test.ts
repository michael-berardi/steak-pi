// The real supervisor, lease files, health wait and idle stop, against a stand-in "llama-server": a script that
// only answers /health. No model is loaded and nothing is downloaded.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensure, manualHolder, pidHolder, release, status, stop, systemDeps, type Deps } from "../src/local/runtime.ts";
import { tempDir, seedProfile } from "./helpers/local-fixture.ts";

const STAND_IN = `#!/usr/bin/env node
const http = require("node:http");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const readyAt = Date.now() + 300;
const server = http.createServer((request, response) => { response.statusCode = Date.now() >= readyAt ? 200 : 503; response.end('{"status":"ok"}'); });
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;

const freePort = (): Promise<number> => new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)); });
});
const until = async (check: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  for (const deadline = Date.now() + ms; Date.now() < deadline;) { if (await check()) return true; await new Promise((resolve) => setTimeout(resolve, 200)); }
  return false;
};

const saved = { ...process.env };
let root: ReturnType<typeof tempDir>;
let deps: Deps;
let port: number;

beforeEach(async () => {
  root = tempDir();
  const script = join(root.path, "stand-in-server");
  writeFileSync(script, STAND_IN);
  chmodSync(script, 0o755);
  process.env.STEAK_PI_LLAMA_SERVER = script;
  process.env.PI_CODING_AGENT_DIR = root.path;
  process.env.STEAK_PI_LOCAL_GRACE_S = "2";
  process.env.STEAK_PI_LOCAL_HEALTH_TIMEOUT_S = "30";
  port = await freePort();
  const dir = join(root.path, "local");
  // This machine's own memory, disk and other servers must not decide the test.
  deps = { ...systemDeps(dir), availableBytes: () => 64 * 1024 ** 3, diskPercent: () => 10, otherServers: () => [] };
  seedProfile(dir, { port });
});
afterEach(async () => {
  await stop(deps).catch(() => undefined);
  for (const key of ["STEAK_PI_LLAMA_SERVER", "PI_CODING_AGENT_DIR", "STEAK_PI_LOCAL_GRACE_S", "STEAK_PI_LOCAL_HEALTH_TIMEOUT_S"]) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  root.cleanup();
});

describe("on-demand server, for real processes", () => {
  it("starts on the first ensure, is shared, and stops by itself one grace after the last release", async () => {
    const first = await ensure(deps, "model-a", pidHolder(process.pid));
    expect(first).toMatchObject({ started: true, baseUrl: `http://127.0.0.1:${port}/v1` });
    expect(await deps.health(port)).toBe(true);
    expect((await ensure(deps, "model-a", pidHolder(process.pid))).started).toBe(false);
    const running = await status(deps);
    expect(running).toMatchObject({ healthy: true, holders: 2 });
    expect(running.running?.serverPid).toBeGreaterThan(0);
    await release(deps, pidHolder(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 3500)); // longer than the grace: a remaining lease keeps it up
    expect(await deps.health(port)).toBe(true);
    await release(deps, pidHolder(process.pid));
    expect(await until(async () => !existsSync(join(deps.dir, "server.json")) && await deps.portFree(port), 25_000)).toBe(true);
    expect(await deps.health(port)).toBe(false);
  }, 60_000);

  it("a manual start stays up past the grace until stop, which confirms the port is released", async () => {
    await ensure(deps, "model-a", manualHolder());
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(await deps.health(port)).toBe(true);
    const result = await stop(deps);
    expect(result).toMatchObject({ stopped: true, id: "model-a", port, portReleased: true });
    expect(await deps.portFree(port)).toBe(true);
    expect(existsSync(join(deps.dir, "server.json"))).toBe(false);
  }, 60_000);

  it("refuses a second start while a foreign process holds the port, and leaves no lease", async () => {
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, "127.0.0.1", resolve));
    try {
      await expect(ensure(deps, "model-a", pidHolder(process.pid))).rejects.toMatchObject({ code: "port-busy" });
      expect((await status(deps)).holders).toBe(0);
    } finally { holder.close(); }
  });
});

describe("bin/steak-pi local", () => {
  it("dispatches to the module under plain Node (type stripping), with nothing installed", () => {
    const bin = fileURLToPath(new URL("../bin/steak-pi", import.meta.url));
    const result = spawnSync("sh", [bin, "local", "status"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: root.path, HOME: root.path } });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/server\s+stopped/);
    expect(result.stdout).toMatch(/model\s+local\/model-a/);
    const refused = spawnSync("sh", [bin, "local", "ensure", "nope"], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: root.path, HOME: root.path } });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/^steak-pi local: REFUSED \(unknown-model\)/);
  });
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { ACTIVE_RUNTIME_FILE, captureStagedRuntimeIdentity, importStagedModule, resolveStagedModule, type StagedRuntimeIdentity } from "../src/subagents/staged-runtime.ts";

const version = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const relativePath = "src/subagents/pi-worker.ts";

async function fixture(check: (root: string, original: string, moduleUrl: string, stage: (name: string, version?: string) => Promise<string>, identity: StagedRuntimeIdentity) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "staged-runtime-test-"));
  const original = join(root, "old", "node_modules", "steak-pi");
  const moduleUrl = pathToFileURL(join(original, "src/subagents/staged-runtime.ts")).href;
  const stage = async (name: string, version?: string) => {
    const pkg = join(root, name, "node_modules", "steak-pi");
    await mkdir(join(pkg, "src/subagents"), { recursive: true });
    await writeFile(join(pkg, relativePath), "export {};\n");
    await writeFile(join(pkg, "package.json"), JSON.stringify(version === undefined ? {} : { version }));
    return pkg;
  };
  await stage("old", version);
  const identity = captureStagedRuntimeIdentity(moduleUrl);
  await rm(join(root, "old"), { recursive: true });
  try { await check(root, original, moduleUrl, stage, identity); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("a session's original tree wins over the active pointer while it exists", async () => fixture(async (root, original, moduleUrl, stage, identity) => {
  await stage("old", version);
  const current = await stage("steak-pi-composer1-new", version);
  await writeFile(join(root, ACTIVE_RUNTIME_FILE), JSON.stringify({ package: current }));
  const resolved = resolveStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity });
  assert.equal(resolved.url, pathToFileURL(join(original, relativePath)).href);
  assert.equal(resolved.replaced, false);
}));

test("a replaced tree resolves a byte-identical active package", async () => fixture(async (root, _original, moduleUrl, stage, identity) => {
  const current = await stage("steak-pi-composer1-new", version);
  await writeFile(join(root, ACTIVE_RUNTIME_FILE), JSON.stringify({ package: current }));
  const resolved = resolveStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity });
  assert.equal(resolved.url, pathToFileURL(join(current, relativePath)).href);
  assert.equal(resolved.replaced, true);
}));

test("a missing pointer falls back to byte-identical staged trees", async () => fixture(async (root, _original, moduleUrl, stage, identity) => {
  const current = await stage("steak-pi-composer1-new", version);
  assert.equal(resolveStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity }).url, pathToFileURL(join(current, relativePath)).href);
}));

test("different or unknown package versions fail closed with all candidates", async () => fixture(async (root, original, moduleUrl, stage, identity) => {
  const different = await stage("steak-pi-composer1-wrong", "999.0.0");
  const unknown = await stage("steak-pi-composer1-unknown");
  assert.throws(() => resolveStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity }), error => {
    assert.ok(error instanceof Error);
    for (const evidence of ["was replaced", original, different.replace(/\/node_modules\/steak-pi$/, ""), unknown.replace(/\/node_modules\/steak-pi$/, ""), "999.0.0", "unknown"]) {
      assert.ok(error.message.includes(evidence));
    }
    return true;
  });
}));

test("a refusal is not cached: the next dispatch can resolve a newly staged tree", async () => fixture(async (root, _original, moduleUrl, stage, identity) => {
  assert.throws(() => resolveStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity }), /was replaced/);
  const current = await stage("steak-pi-composer1-new", version);
  assert.equal(resolveStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity }).url, pathToFileURL(join(current, relativePath)).href);
}));


test("a same-version but different build is refused without byte-identity evidence", async () => fixture(async (root, _original, moduleUrl, stage, identity) => {
  const other = await stage("steak-pi-composer1-otherhash", version);
  await writeFile(join(other, relativePath), "export const unreviewed = true;\n");
  assert.throws(() => resolveStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity }), /integrity|build|identical/);
}));


test("the original content-addressed build wins over a newer same-version pointer", async () => fixture(async (root, _original, _moduleUrl, stage) => {
  const original = await stage("gone/steak-pi-composer1-aaaaaaaa", version);
  const moduleUrl = pathToFileURL(join(original, "src/subagents/staged-runtime.ts")).href;
  const identity = captureStagedRuntimeIdentity(moduleUrl);
  await rm(join(root, "gone"), { recursive: true });
  const exact = await stage("steak-pi-composer1-aaaaaaaa", version);
  const newer = await stage("steak-pi-composer1-bbbbbbbb", version);
  await writeFile(join(root, ACTIVE_RUNTIME_FILE), JSON.stringify({ package: newer }));
  assert.equal(resolveStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity }).url, pathToFileURL(join(exact, relativePath)).href);
}));

test("identical entry points do not authorize changed imported helpers", async () => fixture(async (root, _original, moduleUrl, stage, identity) => {
  const changed = await stage("steak-pi-composer1-other", version);
  await writeFile(join(changed, "src/subagents/helper.ts"), "export const changed = true;\n");
  assert.throws(() => resolveStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity }), /different build.*integrity/);
}));

test("a deleted jiti cache file is regenerated on the next worker launch", async () => fixture(async (root, _original, moduleUrl, stage, identity) => {
  await stage("steak-pi-composer1-new", version);
  const cacheDirectory = join(root, "jiti");
  const cacheFile = join(cacheDirectory, "subagents-claude-worker.8ecac393.mjs");
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(cacheFile, "// cached transpile output\n");
  let launches = 0;
  const importModule = async () => {
    launches += 1;
    try {
      await readFile(cacheFile, "utf8");
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      // Jiti writes a fresh transpile file when its cache directory exists; the
      // missing directory is what made that write fail in the incident.
      await writeFile(cacheFile, "// regenerated transpile output\n");
    }
    return { launches };
  };
  const options = { moduleUrl, runtimeRoot: root, identity, importModule };
  assert.equal((await importStagedModule(relativePath, options)).launches, 1);
  await rm(cacheDirectory, { recursive: true, force: true });
  assert.equal((await importStagedModule(relativePath, options)).launches, 3);
  assert.match(await readFile(cacheFile, "utf8"), /regenerated transpile output/);
}));

test("a persistent jiti cache failure names the removed cache and the cause", async () => fixture(async (root, _original, moduleUrl, stage, identity) => {
  await stage("steak-pi-composer1-new", version);
  const cacheFile = join(root, "jiti", "subagents-claude-worker.8ecac393.mjs");
  let launches = 0;
  const importModule = async () => {
    launches += 1;
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${cacheFile}'`), { code: "ENOENT", path: cacheFile });
  };
  await assert.rejects(
    importStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity, importModule }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const evidence of ["jiti", cacheFile, "recreated", "ENOENT"]) assert.ok(error.message.includes(evidence));
      return true;
    },
  );
  assert.equal(launches, 2);
}));

test("an ENOENT outside a jiti cache is re-thrown without creating a directory", async () => fixture(async (root, _original, moduleUrl, stage, identity) => {
  await stage("steak-pi-composer1-new", version);
  const outside = join(root, "not-a-jiti-cache");
  const missingFile = join(outside, "subagents-worker.8ecac393.mjs");
  const original = Object.assign(new Error(`ENOENT: no such file or directory, open '${missingFile}'`), { code: "ENOENT", path: missingFile });
  let launches = 0;
  const importModule = async () => {
    launches += 1;
    throw original;
  };
  await assert.rejects(importStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity, importModule }), error => error === original);
  assert.equal(launches, 1);
  assert.equal(existsSync(outside), false);
}));

test("a non-ENOENT error on a jiti path is not mistaken for a removed cache", async () => fixture(async (root, _original, moduleUrl, stage, identity) => {
  await stage("steak-pi-composer1-new", version);
  const cacheDirectory = join(root, "jiti");
  const cacheFile = join(cacheDirectory, "subagents-claude-worker.8ecac393.mjs");
  const original = Object.assign(new Error(`EACCES: permission denied, open '${cacheFile}'`), { code: "EACCES", path: cacheFile });
  let launches = 0;
  const importModule = async () => {
    launches += 1;
    throw original;
  };
  await assert.rejects(importStagedModule(relativePath, { moduleUrl, runtimeRoot: root, identity, importModule }), error => error === original);
  assert.equal(launches, 1);
  assert.equal(existsSync(cacheDirectory), false);
}));

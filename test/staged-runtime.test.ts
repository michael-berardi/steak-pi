import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { ACTIVE_RUNTIME_FILE, captureStagedRuntimeIdentity, resolveStagedModule, type StagedRuntimeIdentity } from "../src/subagents/staged-runtime.ts";

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

// The claude-code row in Pi's models-store.json is shared by every running Pi. An older Steak Pi must not replace a
// newer one's catalog with its own shorter discovery.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryModelsStore, type CredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, keepsStoredRow, steakPiVersion, storedRowIsOlderAndShorter, VERSION_MARKER } from "../../extensions/claude-code/catalog-guard.ts";
import { createClaudeCodeProvider } from "../../extensions/claude-code/provider.ts";
import { writeFakeClaude } from "../helpers/fake-claude-catalog.ts";

const credentials: CredentialStore = {
  read: async () => undefined,
  write: async () => {},
  delete: async () => {},
  list: async () => [],
} as unknown as CredentialStore;

let directory: string;
let claude: string;
let previousCommand: string | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "steak-catalog-guard-"));
  claude = join(directory, "claude");
  previousCommand = process.env.PI_CLAUDE_CODE_COMMAND;
  process.env.PI_CLAUDE_CODE_COMMAND = claude;
});
afterEach(() => {
  if (previousCommand === undefined) delete process.env.PI_CLAUDE_CODE_COMMAND;
  else process.env.PI_CLAUDE_CODE_COMMAND = previousCommand;
  rmSync(directory, { recursive: true, force: true });
});

/** One running Pi: its own provider instance and Steak Pi version, over the shared store. */
function pane(store: InMemoryModelsStore, version: string) {
  const lines: string[] = [];
  const models = createModels({ credentials, modelsStore: store });
  const provider = createClaudeCodeProvider({ version, log: (line) => lines.push(line) });
  models.setProvider(provider);
  const refresh = async (allowNetwork = true) => {
    const result = await models.refresh({ allowNetwork, force: true });
    expect([...result.errors.values()].map((error) => error.message)).toEqual([]);
  };
  const dynamicIds = () => provider.getModels().map((model) => model.id).filter((id) => id.startsWith("m"));
  return { refresh, lines, dynamicIds };
}

const SEVEN = ["m1", "m2", "m3", "m4", "m5", "m6", "m7"];
const FIVE = SEVEN.slice(0, 5);
const row = async (store: InMemoryModelsStore) => (await store.read("claude-code")) as unknown as { models: { id: string }[]; checkedAt: number; [VERSION_MARKER]?: string };

describe("claude-code stored catalog guard", () => {
  it("stamps the stored row with the Steak Pi version that wrote it", async () => {
    const store = new InMemoryModelsStore();
    writeFakeClaude(claude, SEVEN);
    await pane(store, "0.30.1").refresh();
    const stored = await row(store);
    expect(stored.models.map((model) => model.id)).toEqual(SEVEN);
    expect(stored[VERSION_MARKER]).toBe("0.30.1");
    expect(steakPiVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("an older Steak Pi keeps a newer one's longer row, logs one named line, and lists the stored models", async () => {
    const store = new InMemoryModelsStore();
    writeFakeClaude(claude, SEVEN);
    await pane(store, "0.31.0").refresh();
    const before = await row(store);
    writeFakeClaude(claude, FIVE);
    const older = pane(store, "0.30.1");
    await older.refresh();
    const after = await row(store);
    expect(after.models.map((model) => model.id)).toEqual(SEVEN);
    expect(after[VERSION_MARKER]).toBe("0.31.0");
    expect(after.checkedAt).toBeGreaterThanOrEqual(before.checkedAt);
    expect(older.lines).toHaveLength(1);
    expect(older.lines[0]).toContain("[claude-code] kept the stored model catalog (7 models, written by Steak Pi 0.31.0)");
    expect(older.lines[0]).toContain("Steak Pi 0.30.1 discovered 5");
    expect(older.dynamicIds()).toEqual(SEVEN);
  });

  it("the same or a newer version may shrink the row, and any version may grow it", async () => {
    const store = new InMemoryModelsStore();
    writeFakeClaude(claude, SEVEN);
    await pane(store, "0.30.1").refresh();
    writeFakeClaude(claude, FIVE);
    const same = pane(store, "0.30.1");
    await same.refresh();
    expect((await row(store)).models).toHaveLength(5);
    expect(same.lines).toEqual([]);
    await pane(store, "0.31.0").refresh();
    expect((await row(store))[VERSION_MARKER]).toBe("0.31.0");
    writeFakeClaude(claude, SEVEN);
    const older = pane(store, "0.30.1");
    await older.refresh();
    const grown = await row(store);
    expect(grown.models).toHaveLength(7);
    expect(grown[VERSION_MARKER]).toBe("0.30.1");
    expect(older.lines).toEqual([]);
  });

  it("replaces a shorter row written before the marker existed", async () => {
    const store = new InMemoryModelsStore();
    await store.write("claude-code", { models: FIVE.map((id) => ({ id, provider: "claude-code" })) as never, checkedAt: 1 });
    writeFakeClaude(claude, SEVEN);
    await pane(store, "0.30.1").refresh();
    const stored = await row(store);
    expect(stored.models).toHaveLength(7);
    expect(stored[VERSION_MARKER]).toBe("0.30.1");
  });

  it("a session keeps its own discovery in memory when an unmarked older writer shortens the stored row", async () => {
    const store = new InMemoryModelsStore();
    writeFakeClaude(claude, SEVEN);
    const current = pane(store, "0.30.1");
    await current.refresh();
    // A pane still running a release from before the marker writes its 5-row discovery over the shared row.
    const stale = await row(store);
    await store.write("claude-code", { models: stale.models.slice(0, 5) as never, checkedAt: Date.now() });
    await current.refresh(false); // cache-only pass, as Pi runs whenever a provider registers
    expect(current.dynamicIds()).toEqual(SEVEN);
    // A row from the same or a newer Steak Pi is taken as stored.
    await store.write("claude-code", { models: stale.models.slice(0, 5) as never, checkedAt: Date.now(), [VERSION_MARKER]: "0.30.1" } as never);
    await current.refresh(false);
    expect(current.dynamicIds()).toEqual(FIVE);
  });

  it("states the rule as pure functions", () => {
    const stored = (count: number, version?: string) => ({ models: SEVEN.slice(0, count).map((id) => ({ id })), ...(version ? { [VERSION_MARKER]: version } : {}) });
    expect(compareVersions("0.30.0", "0.30.1")).toBeLessThan(0);
    expect(compareVersions("0.30.10", "0.30.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(keepsStoredRow(stored(7, "0.31.0"), 5, "0.30.1")).toBe(true);
    expect(keepsStoredRow(stored(7, "0.31.0"), 7, "0.30.1")).toBe(false); // not fewer
    expect(keepsStoredRow(stored(7, "0.30.1"), 5, "0.30.1")).toBe(false); // not older
    expect(keepsStoredRow(stored(7), 5, "0.30.1")).toBe(false); // no marker
    expect(keepsStoredRow(stored(7, "0.31.0"), 5, undefined)).toBe(false); // outside the package
    expect(keepsStoredRow(undefined, 5, "0.30.1")).toBe(false);
    expect(storedRowIsOlderAndShorter(stored(5), stored(7), "0.30.1")).toBe(true);
    expect(storedRowIsOlderAndShorter(stored(5, "0.30.0"), stored(7), "0.30.1")).toBe(true);
    expect(storedRowIsOlderAndShorter(stored(5, "0.30.1"), stored(7), "0.30.1")).toBe(false);
    expect(storedRowIsOlderAndShorter(stored(7), stored(5), "0.30.1")).toBe(false); // a superset is taken
  });
});

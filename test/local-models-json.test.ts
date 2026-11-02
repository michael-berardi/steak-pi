import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalError, upsertLocalModel } from "../src/local/store.ts";
import { tempDir } from "./helpers/local-fixture.ts";

const dirs: Array<{ cleanup(): void }> = [];
afterEach(() => { while (dirs.length) dirs.pop()?.cleanup(); });
const temp = () => { const dir = tempDir(); dirs.push(dir); return dir.path; };
const model = (id: string, extra = {}) => ({ id, baseUrl: "http://127.0.0.1:8089/v1", contextWindow: 32768, ...extra });
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const mode = (file: string) => statSync(file).mode & 0o777;

describe("models.json writer", () => {
  it("adds ONE local provider next to existing providers, keeping every other key untouched", () => {
    const file = join(temp(), "models.json");
    const original = { providers: { cloud: { baseUrl: "https://example.test/v1", apiKey: "!cat /x", models: [{ id: "m", extra: { keep: true } }] } }, topLevel: 1 };
    writeFileSync(file, JSON.stringify(original, null, 2));
    const { backup } = upsertLocalModel(file, model("a"));
    const after = read(file);
    expect(after.providers.cloud).toEqual(original.providers.cloud);
    expect(after.topLevel).toBe(1);
    expect(after.providers.local).toEqual({ api: "openai-completions", apiKey: "local", baseUrl: "http://127.0.0.1:8089/v1", models: [model("a")] });
    expect(Object.keys(after.providers).filter((name) => name === "local")).toHaveLength(1);
    expect(backup && read(backup)).toEqual(original);
    expect(mode(file)).toBe(0o600);
    expect(mode(backup!)).toBe(0o600);
  });

  it("replaces a model with the same id, appends another, and keeps the provider's own settings", () => {
    const file = join(temp(), "models.json");
    writeFileSync(file, JSON.stringify({ providers: { local: { baseUrl: "http://127.0.0.1:9000/v1", apiKey: "mine", headers: { "x-a": "b" }, models: [model("a"), model("b")] } } }));
    upsertLocalModel(file, model("a", { contextWindow: 16384 }));
    upsertLocalModel(file, model("c"));
    const local = read(file).providers.local;
    expect(local).toMatchObject({ baseUrl: "http://127.0.0.1:9000/v1", apiKey: "mine", headers: { "x-a": "b" } });
    expect(local.models.map((entry: { id: string }) => entry.id).sort()).toEqual(["a", "b", "c"]);
    expect(local.models.find((entry: { id: string }) => entry.id === "a").contextWindow).toBe(16384);
  });

  it("creates the file when there is none (no backup), atomically: no temp file is left behind", () => {
    const dir = temp();
    const file = join(dir, "sub", "models.json");
    const { backup } = upsertLocalModel(file, model("a"));
    expect(backup).toBeUndefined();
    expect(readdirSync(join(dir, "sub"))).toEqual(["models.json"]);
    expect(mode(file)).toBe(0o600);
    expect(read(file).providers.local.models).toHaveLength(1);
  });

  it("refuses an invalid file without touching it or making a backup", () => {
    const dir = temp();
    const file = join(dir, "models.json");
    writeFileSync(file, "{ not json");
    expect(() => upsertLocalModel(file, model("a"))).toThrow(LocalError);
    expect(() => upsertLocalModel(file, model("a"))).toThrow(/not valid JSON/);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
    expect(readdirSync(dir)).toEqual(["models.json"]);
    writeFileSync(file, "[1]");
    expect(() => upsertLocalModel(file, model("a"))).toThrow(/not a JSON object/);
  });

  it("keeps the five newest backups", () => {
    const dir = temp();
    const file = join(dir, "models.json");
    writeFileSync(file, "{}");
    for (let second = 0; second < 8; second++) upsertLocalModel(file, model("a"), new Date(Date.UTC(2026, 10, 2, 12, 0, second)));
    const backups = readdirSync(dir).filter((name) => name.startsWith("models.json.bak-")).sort();
    expect(backups).toHaveLength(5);
    expect(backups.at(-1)).toBe("models.json.bak-20261102-120007");
    expect(existsSync(join(dir, "models.json"))).toBe(true);
  });
});

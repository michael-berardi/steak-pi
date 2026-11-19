import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_ENV } from "../../extensions/antigravity/config.ts";

const dir = mkdtempSync(join(tmpdir(), "ag-lazy-"));
let providerLoaded = 0;
let mockProvider = true;
vi.mock("../../extensions/antigravity/provider.ts", async (original) => { providerLoaded += 1; return mockProvider ? { createAntigravityProvider: () => ({ id: "antigravity" }) } : await original(); });
const { default: extension } = await import("../../extensions/antigravity/index.ts");
const pi = () => { const registered: unknown[] = []; return { registered, api: { registerProvider: (p: unknown) => registered.push(p) } as never }; };

afterEach(() => { delete process.env[CONFIG_ENV]; });

describe("antigravity extension is lazy", () => {
  it("registers nothing and loads nothing of the module when it is not configured", async () => {
    process.env[CONFIG_ENV] = join(dir, "absent.json");
    const host = pi();
    await extension(host.api);
    expect(host.registered).toEqual([]);
    expect(providerLoaded).toBe(0);
  });

  it("loads the provider only once the config turns it on", async () => {
    const path = join(dir, "on.json");
    writeFileSync(path, '{"enabled": true}');
    process.env[CONFIG_ENV] = path;
    const host = pi();
    await extension(host.api);
    expect(providerLoaded).toBe(1);
    expect(host.registered).toHaveLength(1);
  });

  it("the entry point imports nothing but node built-ins and its own small files", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(new URL(`../../extensions/antigravity/${f}`, import.meta.url), "utf8");
    const staticImports = (text: string) => [...text.matchAll(/^import (?:type )?[^;]*? from "([^"]+)";/gm)].map((m) => m[1]);
    // index.ts: the type-only host import, the config, and a package-version helper that itself imports node built-ins only.
    expect(staticImports(read("index.ts")).sort()).toEqual(["../claude-code/catalog-guard.ts", "./config.ts", "@earendil-works/pi-coding-agent"].sort());
    expect(staticImports(read("config.ts")).every((s) => s.startsWith("node:") || s === "./errors.ts")).toBe(true);
    expect(staticImports(read("errors.ts"))).toEqual([]);
  });
});

describe("antigravity under Pi's own extension loader", () => {
  it("loads from a copied folder; registers no provider when off, and a provider with no models when on", async () => {
    const { cp, rm } = await import("node:fs/promises");
    const { loadExtensions } = await import(new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    const target = mkdtempSync(join(tmpdir(), "ag-loader-"));
    try {
      await cp(new URL("../../extensions/", import.meta.url), join(target, "extensions"), { recursive: true, filter: (src) => !src.includes("node_modules") });
      process.env[CONFIG_ENV] = join(target, "absent.json");
      const off = await loadExtensions([join(target, "extensions/antigravity/index.ts")], target);
      expect(off.errors).toEqual([]);
      expect(off.runtime.pendingNativeProviderRegistrations).toHaveLength(0);
      const config = join(target, "on.json");
      writeFileSync(config, '{"enabled": true}');
      process.env[CONFIG_ENV] = config;
      const on = await loadExtensions([join(target, "extensions/antigravity/index.ts")], target);
      expect(on.errors).toEqual([]);
      const registrations = on.runtime.pendingNativeProviderRegistrations;
      expect(registrations).toHaveLength(1);
      expect(registrations[0].provider.id).toBe("antigravity");
      expect(registrations[0].provider.getModels()).toEqual([]);
    } finally { await rm(target, { recursive: true, force: true }); }
  });
});

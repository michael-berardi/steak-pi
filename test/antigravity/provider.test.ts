import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAntigravityProvider } from "../../extensions/antigravity/provider.ts";
import { post } from "../../extensions/antigravity/transport.ts";
import { json, startFake, testConfig, type Fake } from "./fixture.ts";

let fake: Fake;
beforeEach(async () => { fake = await startFake(); });
afterEach(() => fake.close());

const ctx = (credential: unknown) => ({ credential, allowNetwork: true, signal: new AbortController().signal, publish: async () => true }) as Record<string, unknown>;

describe("antigravity provider", () => {
  it("has no model of its own and makes no call while signed out", async () => {
    const provider = createAntigravityProvider(testConfig(fake));
    expect(provider.getModels()).toEqual([]);
    await provider.refreshModels?.(ctx(undefined) as never);
    expect(provider.getModels()).toEqual([]);
    expect(fake.seen).toEqual([]);
  });

  it("publishes the signed-in account's live list and nothing else", async () => {
    fake.on("/v1internal:fetchAvailableModels", (req, res) => json(res, 200, { models: { live: { displayName: "Live", maxTokens: 1000 } } }));
    const provider = createAntigravityProvider(testConfig(fake));
    let persisted: { models: { id: string }[] } | undefined;
    await provider.refreshModels?.({ ...ctx({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 1e6, projectId: "p-9" }), publish: async (p: { persist?: typeof persisted }) => { persisted = p.persist; return true; } } as never);
    expect(persisted?.models.map((m) => m.id)).toEqual(["live"]);
    expect(JSON.parse(fake.seen[0].body)).toEqual({ project: "p-9" });
    expect(fake.seen[0].headers.authorization).toBe("Bearer a");
  });

  it("offers Pi a /login method and no api-key method", () => {
    const provider = createAntigravityProvider(testConfig(fake));
    expect(Object.keys(provider.auth)).toEqual(["oauth"]);
    expect(provider.auth.oauth?.isSubscription).toBe(true);
  });
});

describe("antigravity upload", () => {
  it("a request body that stops moving fails with a named cause and is not sent again", async () => {
    let connections = 0;
    fake.raw("/stall", (req) => { connections += 1; req.pause(); });
    const body = Buffer.alloc(48 * 1024 * 1024, 1);
    const error = await post(`${fake.url}/stall`, body, { headers: { "Content-Type": "application/octet-stream" }, limits: { firstByteMs: 400, streamIdleMs: 400 }, label: "stream" }).catch((e) => e);
    expect(error.code).toBe("upload-stalled");
    expect(error.message).toMatch(/upload stalled at [\d.]+ MB of 48\.0 MB.*not sent again/);
    expect(connections).toBeLessThanOrEqual(1);
  }, 15_000);
});

describe("antigravity source stays neutral", () => {
  const root = new URL("../../extensions/antigravity/", import.meta.url);
  const sources = readdirSync(root).filter((f) => f.endsWith(".ts")).map((f) => ({ f, text: readFileSync(new URL(f, root), "utf8") }));

  it("names no model, vendor model family, OAuth client or account in source", () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
    const forbidden = /\b(?:gemini|claude|gpt|opus|sonnet|haiku|deepseek|llama|mistral)\b|[\w-]*-\d+[.\-\d]*(?:-(?:low|medium|high|flash|pro))\b|GOCSPX-[\w-]{10,}|apps\.googleusercontent\.com|@gmail\.com|client_id=\d/i;
    // Reusing the Claude Code module's wait helpers is a path (`../claude-code/...`) and a comment, not a model choice.
    const bare = (l: string) => l.replace(/\.\.\/claude-code\//g, "").replace(/Claude Code relay/g, "");
    for (const { f, text } of sources) expect(text.split("\n").filter((l) => forbidden.test(bare(l))), f).toEqual([]);
  });

  it("the module has no default OAuth client and no default model in what it loads", async () => {
    const config = (await import("../../extensions/antigravity/config.ts")).parseConfig({ enabled: true })!;
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.projectId).toBeUndefined();
  });

  it("the only hosts in source are the provider's own defaults", () => {
    const hosts = new Set<string>();
    for (const { text } of sources) for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1]);
    for (const host of ["cloudcode-pa.googleapis.com", "accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"]) hosts.delete(host);
    expect([...hosts].filter((h) => !/^(?:localhost|127\.0\.0\.1|example\.com)$/.test(h))).toEqual([]);
  });

  it("is listed as a Steak Pi extension and its doc ships", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(manifest.pi.extensions).toContain("./extensions/antigravity/index.ts");
    expect(manifest.files).toContain("docs/ANTIGRAVITY.md");
  });
});

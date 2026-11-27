import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleAiPlanClientError, googleAiPlanClient } from "../../extensions/google-ai-plan/client.ts";
import { createGoogleAiPlanProvider } from "../../extensions/google-ai-plan/provider.ts";

const dirs: string[] = [];
const agentDir = () => { const dir = mkdtempSync(join(tmpdir(), "gap-client-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Google AI Ultra plan OAuth client", () => {
  it("ships no client: without configuration sign-in fails with a named error", () => {
    expect(() => googleAiPlanClient({ PI_CODING_AGENT_DIR: agentDir() })).toThrow(GoogleAiPlanClientError);
    expect(() => googleAiPlanClient({ PI_CODING_AGENT_DIR: agentDir() })).toThrow(/No Google AI Ultra plan OAuth client is configured/);
  });

  it("reads the operator's client file", () => {
    const dir = agentDir();
    writeFileSync(join(dir, "google-ai-plan-client.json"), JSON.stringify({ clientId: "app-id", clientSecret: "app-secret" }));
    expect(googleAiPlanClient({ PI_CODING_AGENT_DIR: dir })).toEqual({ clientId: "app-id", clientSecret: "app-secret" });
  });

  it("prefers both environment variables and refuses only one", () => {
    expect(googleAiPlanClient({ STEAK_PI_GOOGLE_AI_PLAN_CLIENT_ID: "a", STEAK_PI_GOOGLE_AI_PLAN_CLIENT_SECRET: "b" })).toEqual({ clientId: "a", clientSecret: "b" });
    expect(() => googleAiPlanClient({ STEAK_PI_GOOGLE_AI_PLAN_CLIENT_ID: "a" })).toThrow(/Set both/);
  });

  it("refuses a malformed client file by name", () => {
    const dir = agentDir();
    writeFileSync(join(dir, "google-ai-plan-client.json"), "{nope");
    expect(() => googleAiPlanClient({ PI_CODING_AGENT_DIR: dir })).toThrow(/not valid JSON/);
    writeFileSync(join(dir, "google-ai-plan-client.json"), JSON.stringify({ clientId: "x" }));
    expect(() => googleAiPlanClient({ PI_CODING_AGENT_DIR: dir })).toThrow(/needs non-empty string clientId and clientSecret/);
  });

  it("builds the provider without a client, so Pi starts cleanly", () => {
    const provider = createGoogleAiPlanProvider({ PI_CODING_AGENT_DIR: agentDir() });
    expect(provider.id).toBe("google-ai-plan");
    expect(provider.getModels().map((model) => model.id)).toContain("gemini-4-neon");
  });
});

import { piShipsGoogleAiPlan } from "../../extensions/google-ai-plan/index.ts";
describe("step-aside when Pi ships the provider", () => {
  it("steps aside only when pi-ai exports googleAiPlanProvider", async () => {
    expect(await piShipsGoogleAiPlan(async () => ({ googleAiPlanProvider: () => ({}) }))).toBe(true);
    expect(await piShipsGoogleAiPlan(async () => { throw new Error("Cannot find module"); })).toBe(false);
    expect(await piShipsGoogleAiPlan(async () => ({}))).toBe(false);
    // The pinned Pi does not ship it yet, so the port registers.
    expect(await piShipsGoogleAiPlan()).toBe(false);
  });
});

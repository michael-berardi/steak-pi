import { chmodSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Canary strings stand in for secrets: they must never surface anywhere. */
export const CANARY_WORKSPACE = "wrkspc_CANARYWORKSPACE0123456789";
export const CANARY_HEADER = `anthropic-workspace-id: ${CANARY_WORKSPACE}`;
export const CANARY_KEY = "sk-ant-api03-CANARYKEYMUSTNEVERAPPEAR";
export const NOW = Date.parse("2026-10-13T12:00:00Z");

export interface ApiFixture {
  dir: string;
  configPath: string;
  settingsPath: string;
  helperPath: string;
  options: { configPath: string; now: () => number };
  /** Rewrite the approval record (mode 600) with overrides merged over the valid default. */
  writeConfig(overrides?: Record<string, unknown>): void;
  writeSettings(value: unknown): void;
  cleanup(): void;
}

export function approvalRecord(settingsPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    approval: { approvedBy: "operator", source: "phase-A brief", task: "sonnet-usap-api-test", approvedAt: "2026-10-13T00:00:00Z", expiresAt: "2026-10-20T00:00:00Z" },
    routes: ["claude-code-api/claude-sonnet-5-5", "claude-code-api/claude-opus-5-5"],
    settingsPath,
    budget: { maxLeafUsd: 1, maxRunUsd: 2 },
    ...overrides,
  };
}

export function apiFixture(): ApiFixture {
  const dir = mkdtempSync(join(tmpdir(), "usap-claude-api-"));
  const helperPath = join(dir, "key-helper");
  // The helper is never executed by USAP; its content proves nothing is read from it.
  writeFileSync(helperPath, `#!/bin/sh\necho ${CANARY_KEY}\n`, { mode: 0o700 });
  chmodSync(helperPath, 0o700);
  const settingsPath = join(dir, "settings.json");
  const configPath = join(dir, "approval.json");
  const fixture: ApiFixture = {
    dir, configPath, settingsPath, helperPath,
    options: { configPath, now: () => NOW },
    writeSettings(value) { writeFileSync(settingsPath, JSON.stringify(value), { mode: 0o600 }); chmodSync(settingsPath, 0o600); },
    writeConfig(overrides = {}) { writeFileSync(configPath, JSON.stringify(approvalRecord(settingsPath, overrides)), { mode: 0o600 }); chmodSync(configPath, 0o600); },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
  fixture.writeSettings({ apiKeyHelper: helperPath, env: { ANTHROPIC_CUSTOM_HEADERS: CANARY_HEADER } });
  fixture.writeConfig();
  return fixture;
}

export { symlinkSync };

#!/usr/bin/env -S node --experimental-strip-types
/**
 * Supported entry point for explicit Claude API USAP waves (see docs/CLAUDE-API-ROUTE.md).
 *
 *   node scripts/usap-claude-api.ts admit [--tasks N] [--route R]
 *   node scripts/usap-claude-api.ts dispatch <wave.json> [--checkpoint-root DIR] [--out FILE]
 *   node scripts/usap-claude-api.ts resume <run-id> [--checkpoint-root DIR] [--out FILE]
 *
 * Runs in the foreground inside the native SubagentCoordinator; SIGINT/SIGTERM
 * cancel the run and the runner signals only its own child process. Output is a
 * sanitized JSON summary on stdout; worker reports follow on stderr-free text.
 * Exit 0 = every task done, 1 = failed/partial, 2 = admission/usage error, 130 = cancelled.
 */
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { admitClaudeApiRoute, CLAUDE_API_SONNET_ROUTE, ClaudeApiAdmissionError } from "../src/subagents/claude-api-route.ts";
import { parseWaveSpec, resumeClaudeApiRun, runClaudeApiWave } from "../src/subagents/claude-api-cli.ts";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  const checkpointRoot = flag(rest, "--checkpoint-root");
  const out = flag(rest, "--out");
  const deps = { ...(checkpointRoot ? { checkpointRoot } : {}), signal: controller.signal };
  if (command === "admit") {
    const route = flag(rest, "--route") ?? CLAUDE_API_SONNET_ROUTE;
    const admission = admitClaudeApiRoute({ route, taskCount: Number(flag(rest, "--tasks") ?? 1) });
    // Structure only: no settings path, helper path or header value.
    const { settingsPath: _settingsPath, ...safe } = admission;
    console.log(JSON.stringify({ admitted: true, ...safe }, null, 2));
    return 0;
  }
  if (command !== "dispatch" && command !== "resume") {
    console.error("usage: usap-claude-api.ts admit|dispatch <wave.json>|resume <run-id> [--checkpoint-root DIR] [--out FILE]");
    return 2;
  }
  const target = rest[0];
  if (!target || target.startsWith("--")) { console.error(`${command} needs ${command === "dispatch" ? "a wave spec file" : "a run id"}`); return 2; }
  const outcome = command === "dispatch"
    ? await runClaudeApiWave(parseWaveSpec(readFileSync(target, "utf8")), deps)
    : await resumeClaudeApiRun(target, deps);
  const body = JSON.stringify(outcome.summary, null, 2);
  console.log(body);
  console.log(`\n${outcome.text}`);
  if (out) { writeFileSync(out, `${body}\n`, { mode: 0o600 }); chmodSync(out, 0o600); }
  return outcome.exitCode;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  // Admission and usage failures are named, value-free, and exit 2.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof ClaudeApiAdmissionError ? 2 : 1;
});

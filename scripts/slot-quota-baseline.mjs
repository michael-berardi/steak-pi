#!/usr/bin/env node
// Spec 01 baseline (read-only): how often does an interactive slot end a turn on a
// quota / plan-limit / content-filter / route-unavailable / transient error that the
// ordered chain classifier (eligibleChainFallback) would accept for a hop?
//
// Scans *.jsonl session transcripts modified within the window. Counts only
// interactive sessions: a valid Pi session header plus at least one user message
// that is not a USAP worker prompt. USAP children persist under their run's
// checkpoint directory, but any that land here are excluded by their prompt prefix.
// Failed attempts that Pi retried and recovered are persisted with a context_edit
// omission; those are excluded so only turns that actually ENDED on the error count.
//
// Prints one JSON object of counts. No message text, no session IDs, no paths
// beyond the directory given. Never writes anything.
//
// Usage: node scripts/slot-quota-baseline.mjs [--sessions <dir>] [--days <n>]
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The classifier is the shipped one, imported from source. Older Node needs the
// type-stripping flag for .ts imports; re-exec once with it when required.
let policy;
let refusal;
try {
  policy = await import(new URL("../src/model-route-policy.ts", import.meta.url));
  refusal = await import(new URL("../src/content-filter-refusal.ts", import.meta.url));
} catch (error) {
  if (error?.code === "ERR_UNKNOWN_FILE_EXTENSION" || error?.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
    const rerun = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(rerun.status ?? 1);
  }
  throw error;
}
const { eligibleChainFallback, ROUTE_UNAVAILABLE_WORDING } = policy;
const { isContentFilterRefusal } = refusal;

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const USAP_CHILD_PREFIXES = [
  "You are one bounded child under the UltraTerm Subagent Protocol",
  "Continue the exact assigned leaf",
];
const QUOTA_WORDING = /subscription_quota_exceeded|GoUsageLimitError|usage limit|quota[_ -]?(?:exhausted|exceeded|reached)|insufficient_quota/i;

function parseArgs(argv) {
  let sessions = join(homedir(), ".pi", "agent", "sessions");
  let days = 7;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sessions" && i + 1 < argv.length) sessions = argv[++i];
    else if (argv[i] === "--days" && i + 1 < argv.length) days = Number(argv[++i]);
    else throw new Error("Unknown or incomplete argument; expected --sessions <dir> and --days <n>.");
  }
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days must be a positive number.");
  return { sessions, days };
}

/** Session files modified within the window. Symlinks are never followed. */
async function collectFiles(dir, cutoff, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectFiles(full, cutoff, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const info = await stat(full);
        if (info.mtimeMs >= cutoff) out.push(full);
      } catch { /* unreadable file: skip */ }
    }
  }
}

/** Bounded line reads: a line over MAX_LINE_BYTES is dropped, never buffered whole. */
async function* lines(path) {
  let pending = "";
  let dropping = false;
  for await (const chunk of createReadStream(path, { encoding: "utf8" })) {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      const part = newline === -1 ? chunk.slice(start) : chunk.slice(start, newline);
      if (dropping) {
        if (newline === -1) break;
        dropping = false;
      } else if (pending.length + part.length > MAX_LINE_BYTES) {
        pending = "";
        if (newline === -1) { dropping = true; break; }
      } else if (newline === -1) {
        pending += part;
        break;
      } else {
        const line = pending + part;
        pending = "";
        if (line.trim()) yield line;
      }
      if (newline === -1) break;
      start = newline + 1;
    }
  }
  if (!dropping && pending.trim() && pending.length <= MAX_LINE_BYTES) yield pending;
}

const textOf = (content) => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";

function kindOf(errorMessage) {
  if (isContentFilterRefusal(errorMessage)) return "contentFilter";
  if (QUOTA_WORDING.test(errorMessage)) return "quota";
  if (ROUTE_UNAVAILABLE_WORDING.test(errorMessage)) return "routeUnavailable";
  return "transient";
}

const { sessions, days } = parseArgs(process.argv.slice(2));
const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
const files = [];
await collectFiles(sessions, cutoff, files);
files.sort();

const byKind = { quota: 0, contentFilter: 0, routeUnavailable: 0, transient: 0 };
const byProvider = {};
let sessionsScanned = 0;
let turnsEndedOnEligibleError = 0;

for (const file of files) {
  let header = false;
  let firstUserText;
  const candidates = [];
  const omitted = new Set();
  try {
    for await (const line of lines(file)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!header) {
        header = entry?.type === "session";
        if (!header) break;
        sessionsScanned++;
        continue;
      }
      if (entry?.type === "context_edit" && entry.replacement === null && typeof entry.targetId === "string") {
        omitted.add(entry.targetId);
        continue;
      }
      if (entry?.type !== "message" || !entry.message) continue;
      const message = entry.message;
      if (message.role === "user" && firstUserText === undefined) firstUserText = textOf(message.content);
      if (message.role === "assistant" && message.stopReason === "error" &&
          typeof message.errorMessage === "string" && eligibleChainFallback(message.errorMessage)) {
        candidates.push({ id: entry.id, provider: typeof message.provider === "string" ? message.provider : "unknown", kind: kindOf(message.errorMessage) });
      }
    }
  } catch { continue; }
  if (!header) continue;
  // Interactive only: a real user turn, and not a USAP worker prompt/continuation.
  if (firstUserText === undefined) continue;
  if (USAP_CHILD_PREFIXES.some(prefix => firstUserText.startsWith(prefix))) continue;
  for (const candidate of candidates) {
    if (typeof candidate.id === "string" && omitted.has(candidate.id)) continue; // retried and recovered
    turnsEndedOnEligibleError++;
    byKind[candidate.kind]++;
    byProvider[candidate.provider] = (byProvider[candidate.provider] ?? 0) + 1;
  }
}

console.log(JSON.stringify({ windowDays: days, sessionsScanned, turnsEndedOnEligibleError, byKind, byProvider }, null, 2));
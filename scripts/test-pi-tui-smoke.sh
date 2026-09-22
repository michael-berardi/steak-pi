#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="smoke"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/steak-pi-smoke.XXXXXX")"
TMUX_SOCKET="$TMP/tmux.sock"
SAFE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Every tmux invocation uses a randomized private socket and a scrubbed process
# environment. Cleanup can therefore never address the operator's tmux server.
tmux_private() {
  env -i HOME="$TMP/home" PATH="$SAFE_PATH" TMPDIR="$TMP" \
    LANG="en_US.UTF-8" LC_ALL="en_US.UTF-8" \
    tmux -S "$TMUX_SOCKET" "$@"
}

cleanup() {
  tmux_private kill-server >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

PI_EXECUTABLE="${PI_EXECUTABLE:-$ROOT/node_modules/.bin/pi}"
STEAK_PACKAGE="${STEAK_PACKAGE:-$ROOT}"
[[ -x "$PI_EXECUTABLE" && -d "$STEAK_PACKAGE" ]]

mkdir -p "$TMP/config" "$TMP/sessions" "$TMP/home" \
  "$TMP/xdg-config" "$TMP/xdg-state" "$TMP/xdg-cache" "$TMP/xdg-data"
PI_VERSION="$(env -i HOME="$TMP/home" PATH="$SAFE_PATH" \
  PI_CODING_AGENT_DIR="$TMP/config" PI_OFFLINE=1 PI_TELEMETRY=0 \
  "$PI_EXECUTABLE" --version)"
[[ "$PI_VERSION" == "0.85.1" || "$PI_VERSION" == "0.86.0" || "$PI_VERSION" == "0.86.1" || "$PI_VERSION" == "0.87.0" ]] || {
  echo "Steak Pi smoke requires reviewed Pi 0.85.1, 0.86.0, 0.86.1 or 0.87.0; found $PI_VERSION" >&2
  exit 1
}

capture() {
  tmux_private capture-pane -p -S - -t "$SESSION:0.0"
}

capture_current() {
  tmux_private capture-pane -p -t "$SESSION:0.0"
}

assert_ansi_width() {
  local width="$1"
  local raw="$TMP/capture-${SESSION}-${width}.ansi"
  tmux_private capture-pane -p -e -t "$SESSION:0.0" >"$raw"
  (cd "$ROOT" && node --input-type=module - "$raw" "$width") <<'NODE'
import fs from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
const [file, widthText] = process.argv.slice(2);
const width = Number(widthText);
for (const [index, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
  if (visibleWidth(line) > width) throw new Error(`line ${index + 1} exceeds ${width} columns`);
  const unknownEscape = line
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[\s\S]*?\x1b\\/g, "");
  if (unknownEscape.includes("\x1b")) throw new Error(`line ${index + 1} has malformed ANSI`);
}
NODE
}

wait_for() {
  local needle="$1"
  local attempts="${2:-80}"
  for ((i = 0; i < attempts; i++)); do
    if capture 2>/dev/null | grep -Fq -- "$needle"; then return 0; fi
    sleep 0.1
  done
  printf 'Timed out waiting for %q\n' "$needle" >&2
  capture >&2 || true
  return 1
}

wait_for_current() {
  local needle="$1"
  local attempts="${2:-80}"
  for ((i = 0; i < attempts; i++)); do
    if capture_current 2>/dev/null | grep -Fq -- "$needle"; then return 0; fi
    sleep 0.1
  done
  printf 'Timed out waiting in current viewport for %q\n' "$needle" >&2
  capture_current >&2 || true
  return 1
}

node - "$TMP/config/settings.json" "$STEAK_PACKAGE" <<'NODE'
const fs = require("node:fs");
const [file, root] = process.argv.slice(2);
fs.writeFileSync(file, JSON.stringify({
  defaultProvider: "zai",
  defaultModel: "glm-5.3-flash",
  defaultThinkingLevel: "high",
  defaultProjectTrust: "always",
  enableInstallTelemetry: false,
  quietStartup: true,
  packages: [root],
}, null, 2));
NODE
node - "$TMP/sessions/fixture.jsonl" "$ROOT" <<'NODE'
const fs = require("node:fs");
const [file, cwd] = process.argv.slice(2);
const now = Date.now();
const iso = new Date(now - 60_000).toISOString();
const lines = [
  { type: "session", version: 3, id: "11111111-1111-4111-8111-111111111111", timestamp: iso, cwd },
  { type: "message", id: "a1b2c3d4", parentId: null, timestamp: iso, message: { role: "user", content: "fixture-resume-marker", timestamp: now - 60_000 } },
  { type: "message", id: "b2c3d4e5", parentId: "a1b2c3d4", timestamp: iso, message: { role: "assistant", content: [{ type: "text", text: "fixture restored" }], api: "openai-completions", provider: "zai", model: "glm-5.3-flash", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: now - 59_000 } },
];
const run = { runId: "run-visual-fixture", goal: "Verify the subagent workgroup", state: "failed", model: "zai/glm-5.3-flash", createdAt: now - 60_000, endedAt: now - 1_000, tasks: [
  { taskId: "one", label: "Source review", state: "done", turns: 8, toolSuccesses: 6, toolErrors: 0, startedAt: now - 60_000, endedAt: now - 10_000, output: "Reviewed implementation and retained evidence." },
  { taskId: "two", label: "Long-running verification", state: "failed", turns: 64, toolSuccesses: 55, toolErrors: 1, startedAt: now - 60_000, endedAt: now - 1_000, error: "Turn budget reached — partial work retained", output: "Partial verification report is available for inspection." },
] };
lines.push(
  { type: "message", id: "c3d4e5f6", parentId: "b2c3d4e5", timestamp: iso, message: { ...lines[2].message, content: [{ type: "toolCall", id: "fixture-dispatch", name: "ultraterm_subagents", arguments: { goal: run.goal, tasks: run.tasks.map(t => ({ label: t.label, task: t.label })) } }], stopReason: "toolUse" } },
  { type: "message", id: "d4e5f6a7", parentId: "c3d4e5f6", timestamp: iso, message: { role: "toolResult", toolCallId: "fixture-dispatch", toolName: "ultraterm_subagents", content: [{ type: "text", text: "USAP visual fixture: one success and one exhausted budget" }], details: { mode: "foreground", run }, isError: false, timestamp: now } },
);
fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
NODE

# Exercise the REAL host's passive custom-message delivery without any provider
# request. Only the worker runner and route catalog are synthetic; the extension
# completion path and Pi TUI/session delivery are the candidate implementation.
cat >"$TMP/completion-proof.ts" <<EOF
import { createUltratermSubagentsExtension } from "$ROOT/extensions/ultraterm-subagents.ts";
import { emptyUsage } from "$ROOT/src/subagents/types.ts";
export default function(pi) {
  const tools = new Map();
  const model = { provider: "zai", id: "glm-5.3-flash", input: ["text"] };
  createUltratermSubagentsExtension({ checkpointRoot: "$TMP/completion-checkpoints", profiles: [], idFactory: () => "completion-proof", createRunner: () => async () => ({ state: "done", output: "offline proof", turns: 1, usage: emptyUsage() }) })({
    registerTool: (tool) => tools.set(tool.name, tool), on: () => {},
    appendEntry: (...args) => pi.appendEntry(...args), sendMessage: (...args) => pi.sendMessage(...args),
  });
  pi.registerCommand("usap-smoke", { description: "Offline completion proof", handler: async (_args, ctx) => {
    await tools.get("ultraterm_subagents").execute("proof", { goal: "offline completion proof", model: "zai/glm-5.3-flash", background: true, tasks: [{ label: "Completion delivery verified", task: "offline" }] }, undefined, undefined, {
      ...ctx, model, thinkingLevel: "medium",
      modelRegistry: { isUsingOAuth: () => false, hasConfiguredAuth: () => true, getAvailable: () => [model], find: () => model, getProvider: () => ({ streamSimple() {} }) },
    });
  } });
}
EOF

PI_ENV="env -i HOME='$TMP/home' PATH='$SAFE_PATH' TMPDIR='$TMP' SHELL='/bin/bash' USER='steak-smoke' TERM='screen-256color' COLORTERM='truecolor' LANG='en_US.UTF-8' LC_ALL='en_US.UTF-8' XDG_CONFIG_HOME='$TMP/xdg-config' XDG_STATE_HOME='$TMP/xdg-state' XDG_CACHE_HOME='$TMP/xdg-cache' XDG_DATA_HOME='$TMP/xdg-data' PI_CODING_AGENT_DIR='$TMP/config' PI_OFFLINE='1' PI_TELEMETRY='0' NODE_DISABLE_COMPILE_CACHE='1'"

# Private tmux, HOME, XDG, Pi config, and session stores prevent access to
# UltraTerm panes, operator sessions, credentials, telemetry, or startup network.
tmux_private -f /dev/null new-session -d -x 80 -y 24 -s "$SESSION" \
  "cd '$ROOT' && exec $PI_ENV '$PI_EXECUTABLE' --offline --approve \
    --session-dir '$TMP/sessions' --extension '$TMP/completion-proof.ts' --no-skills --no-prompt-templates \
    --no-context-files --use-theme dark"

wait_for "STEAK PI"
wait_for_current "● ready"
startup="$(capture)"
for routine_section in "[Context]" "[Skills]" "[Extensions]" "[Themes]"; do
  if grep -Fq -- "$routine_section" <<<"$startup"; then
    printf 'Quiet startup leaked routine section %s.\n' "$routine_section" >&2
    exit 1
  fi
done
if grep -Fq -- "[Extension issues]" <<<"$startup"; then
  printf 'Pi reported extension issues.\n' >&2
  exit 1
fi
if grep -Fq -- "[Theme conflicts]" <<<"$startup"; then
  printf 'Pi reported theme conflicts.\n' >&2
  exit 1
fi

# Native local-bash submit plus Up/Down history: no provider request is made.
first_command="!printf 'steak-%s' smoke"
second_command="!printf 'second-%s' smoke"
tmux_private send-keys -t "$SESSION:0.0" -l "$first_command"
tmux_private send-keys -t "$SESSION:0.0" Enter
wait_for "steak-smoke"
tmux_private send-keys -t "$SESSION:0.0" Up
sleep 0.2
wait_for_current "$first_command"
tmux_private send-keys -t "$SESSION:0.0" Down
tmux_private send-keys -t "$SESSION:0.0" -l "$second_command"
tmux_private send-keys -t "$SESSION:0.0" Enter
wait_for "second-smoke"

# Completion must appear before any subsequent user input. The old nextTurn
# implementation fails this assertion because no prompt follows the command.
tmux_private send-keys -t "$SESSION:0.0" -l '/usap-smoke'
tmux_private send-keys -t "$SESSION:0.0" Enter
wait_for "Completion delivery verified"
wait_for "1 done"

# Use native selector confirmation to load a seeded private session, then
# verify both its transcript and the extension's resumed state.
tmux_private resize-window -t "$SESSION" -x 120 -y 40
tmux_private send-keys -t "$SESSION:0.0" -l '/resume'
tmux_private send-keys -t "$SESSION:0.0" Enter
wait_for_current "Resume Session"
tmux_private send-keys -t "$SESSION:0.0" Enter
wait_for_current "● resumed"
wait_for_current "fixture-resume-marker"
wait_for_current "Subagents"
wait_for_current "Turn budget reached"
if [[ -n "${TUI_EVIDENCE_DIR:-}" ]]; then
  mkdir -p "$TUI_EVIDENCE_DIR"
  tmux_private capture-pane -p -e -t "$SESSION:0.0" >"$TUI_EVIDENCE_DIR/steak-usap-120.ansi"
  capture_current >"$TUI_EVIDENCE_DIR/steak-usap-120.txt"
fi

# Exercise compact and wide redraws and ensure both footer surfaces survive.
for geometry in "40 14" "80 32" "120 32"; do
  read -r width height <<<"$geometry"
  tmux_private resize-window -t "$SESSION" -x "$width" -y "$height"
  sleep 0.2
  pane="$(capture_current)"
  grep -Fq -- "● resumed" <<<"$pane"
  grep -Fq -- "╰─" <<<"$pane"
  if (( width >= 54 )); then grep -Eq -- "ctx | tok|ctx —|◫" <<<"$pane"; fi
  assert_ansi_width "$width"
  if [[ -n "${TUI_EVIDENCE_DIR:-}" ]]; then
    tmux_private capture-pane -p -e -t "$SESSION:0.0" >"$TUI_EVIDENCE_DIR/steak-usap-${width}.ansi"
    capture_current >"$TUI_EVIDENCE_DIR/steak-usap-${width}.txt"
  fi
done

# Native expansion uses the same tool context as a real restored transcript.
tmux_private send-keys -t "$SESSION:0.0" C-o
wait_for_current "Reviewed implementation"
for width in 120 80; do
  tmux_private resize-window -t "$SESSION" -x "$width" -y 40
  sleep .2
  assert_ansi_width "$width"
  if [[ -n "${TUI_EVIDENCE_DIR:-}" ]]; then
    tmux_private capture-pane -p -e -t "$SESSION:0.0" >"$TUI_EVIDENCE_DIR/steak-usap-expanded-${width}.ansi"
    capture_current >"$TUI_EVIDENCE_DIR/steak-usap-expanded-${width}.txt"
  fi
done

# Repeat startup under Pi's opposite stock theme.
SESSION="light"
tmux_private new-session -d -x 80 -y 24 -s "$SESSION" \
  "cd '$ROOT' && exec $PI_ENV '$PI_EXECUTABLE' --offline --approve --no-session \
    --no-skills --no-prompt-templates --no-context-files --use-theme light"
wait_for "STEAK PI"
wait_for_current "● ready"
assert_ansi_width 80

session_count="$(find "$TMP/sessions" -type f -name '*.jsonl' | wc -l | tr -d ' ')"
[[ "$session_count" -ge 1 ]]
printf 'Steak Pi native TUI smoke passed offline with isolated resume (%s session files).\n' "$session_count"

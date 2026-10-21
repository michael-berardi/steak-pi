#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="smoke"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/steak-pi-smoke.XXXXXX")"
printf 'TUI workspace: %s (new, disposable)\n' "$TMP"
TMUX_SOCKET="$TMP/tmux.sock"
SAFE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Every tmux invocation uses a randomized private socket and a scrubbed process
# environment. Cleanup can therefore never address the operator's tmux server.
tmux_private() {
  env -i HOME="$TMP/home" PATH="$SAFE_PATH" TMPDIR="$TMP" \
    LANG="en_US.UTF-8" LC_ALL="en_US.UTF-8" \
    tmux -S "$TMUX_SOCKET" "$@"
}

SERVER_PID=""
SERVER_IDENTITY=""
SOCKET_IDENTITY=""
PANE_PIDS=()
PANE_STARTS=()
process_identity() { ps -p "$1" -o pid=,lstart=,comm= 2>/dev/null || true; }
socket_identity() { python3 -c 'import os,sys; s=os.lstat(sys.argv[1]); print(f"{s.st_dev}:{s.st_ino}")' "$TMUX_SOCKET" 2>/dev/null || true; }
record_ownership() {
  local pane
  if [[ -z "$SERVER_PID" ]]; then
    SERVER_PID="$(tmux_private display-message -p -t "$SESSION" '#{pid}')"
    SERVER_IDENTITY="$(process_identity "$SERVER_PID")"
    SOCKET_IDENTITY="$(socket_identity)"
  fi
  pane="$(tmux_private display-message -p -t "$SESSION" '#{pane_pid}')"
  PANE_PIDS+=("$pane")
  PANE_STARTS+=("$(ps -p "$pane" -o lstart=)")
  printf 'TUI ownership: server=%s; pane=%s; cwd=%s; socket=%s\n' "$SERVER_IDENTITY" "$(process_identity "$pane")" "$ROOT" "$TMUX_SOCKET"
}
cleanup() {
  local i alive=0
  if [[ -n "$SERVER_PID" && -n "$(process_identity "$SERVER_PID")" ]]; then
    if [[ "$(process_identity "$SERVER_PID")" != "$SERVER_IDENTITY" || "$(socket_identity)" != "$SOCKET_IDENTITY" ]]; then
      echo "TUI cleanup identity changed; preserving $TMP" >&2
      return 1
    fi
    tmux_private kill-server >/dev/null 2>&1 || true
  fi
  # The private server owns the pane shutdown; never signal a name/port match.
  for _ in {1..30}; do
    alive=0
    for ((i=0; i<${#PANE_PIDS[@]}; i++)); do
      if [[ "$(ps -p "${PANE_PIDS[$i]}" -o lstart= 2>/dev/null || true)" == "${PANE_STARTS[$i]}" ]]; then alive=1; fi
    done
    [[ "$alive" == 0 ]] && break
    sleep 0.1
  done
  if [[ "$alive" != 0 || ( -n "$SERVER_PID" && "$(process_identity "$SERVER_PID")" == "$SERVER_IDENTITY" ) ]]; then
    echo "TUI processes have not exited; preserving $TMP" >&2
    return 1
  fi
  if [[ "${TUI_KEEP_WORKSPACE:-0}" == 1 ]]; then
    printf 'TUI processes/socket closed; workspace retained: %s\n' "$TMP"
  else
    rm -rf "$TMP"
    [[ ! -e "$TMP" ]] && echo "TUI cleanup verified: owned server/panes exited; private socket and workspace absent."
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PI_EXECUTABLE="${PI_EXECUTABLE:-$ROOT/node_modules/.bin/pi}"
STEAK_PACKAGE="${STEAK_PACKAGE:-$ROOT}"
[[ -x "$PI_EXECUTABLE" && -d "$STEAK_PACKAGE" ]]

mkdir -p "$TMP/config" "$TMP/sessions" "$TMP/home" \
  "$TMP/xdg-config" "$TMP/xdg-state" "$TMP/xdg-cache" "$TMP/xdg-data"
PI_VERSION="$(env -i HOME="$TMP/home" PATH="$SAFE_PATH" \
  PI_CODING_AGENT_DIR="$TMP/config" PI_OFFLINE=1 PI_TELEMETRY=0 \
  "$PI_EXECUTABLE" --version)"
[[ "$PI_VERSION" == "0.85.1" || "$PI_VERSION" == "0.86.0" || "$PI_VERSION" == "0.86.1" || "$PI_VERSION" == "0.87.0" || "$PI_VERSION" == "0.87.1" || "$PI_VERSION" == "0.99.2" || "$PI_VERSION" == "1.0.0" || "$PI_VERSION" == "1.0.4" ]] || {
  echo "Steak Pi smoke requires reviewed Pi 0.85.1, 0.86.0, 0.86.1, 0.87.0, 0.87.1, 0.99.2, 1.0.0 or 1.0.4; found $PI_VERSION" >&2
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
  defaultProvider: "xiaomi",
  defaultModel: "mimo-v2.6-flash",
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
  { type: "message", id: "b2c3d4e5", parentId: "a1b2c3d4", timestamp: iso, message: { role: "assistant", content: [{ type: "text", text: "fixture restored" }], api: "openai-completions", provider: "xiaomi", model: "mimo-v2.6-flash", usage: { input: 16200, output: 450, cacheRead: 8000, cacheWrite: 200, totalTokens: 24850, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.234 } }, stopReason: "stop", timestamp: now - 59_000 } },
];
const run = { runId: "run-visual-fixture", goal: "Verify the subagent workgroup", state: "failed", model: "xiaomi/mimo-v2.6-flash", createdAt: now - 60_000, endedAt: now - 1_000, tasks: [
  { taskId: "one", label: "Source review", state: "done", turns: 8, toolSuccesses: 6, toolErrors: 0, startedAt: now - 60_000, endedAt: now - 10_000, output: "Reviewed implementation and retained evidence." },
  { taskId: "two", label: "Long-running verification", state: "failed", turns: 64, toolSuccesses: 55, toolErrors: 1, startedAt: now - 60_000, endedAt: now - 1_000, error: "Turn budget reached — partial work retained", output: "Partial verification report is available for inspection." },
] };
lines.push(
  { type: "message", id: "c3d4e5f6", parentId: "b2c3d4e5", timestamp: iso, message: { ...lines[2].message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } }, content: [{ type: "toolCall", id: "fixture-dispatch", name: "ultraterm_subagents", arguments: { goal: run.goal, tasks: run.tasks.map(t => ({ label: t.label, task: t.label })) } }], stopReason: "toolUse" } },
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
  // A credential-free, network-denied model keeps real model/context metadata
  // available in both stock themes. Any accidental request fails explicitly.
  pi.registerProvider("xiaomi", {
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", api: "openai-completions", apiKey: "offline-fixture",
    models: [{ id: "mimo-v2.6-flash", name: "Offline TUI fixture", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1000 }],
    streamSimple() { throw new Error("Network forbidden in offline TUI fixture"); },
  });
  const tools = new Map();
  const model = { provider: "xiaomi", id: "mimo-v2.6-flash", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", input: ["text"] };
  createUltratermSubagentsExtension({ checkpointRoot: "$TMP/completion-checkpoints", profiles: [], idFactory: () => "completion-proof", createRunner: () => async () => ({ state: "done", output: "offline proof", turns: 1, usage: emptyUsage() }) })({
    registerTool: (tool) => tools.set(tool.name, tool), on: () => {},
    appendEntry: (...args) => pi.appendEntry(...args), sendMessage: (...args) => pi.sendMessage(...args),
  });
  pi.registerCommand("usap-smoke", { description: "Offline completion proof", handler: async (_args, ctx) => {
    await tools.get("ultraterm_subagents").execute("proof", { goal: "offline completion proof", model: "xiaomi/mimo-v2.6-flash", background: true, tasks: [{ label: "Completion delivery verified", task: "offline" }] }, undefined, undefined, {
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
record_ownership

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
# Select the seeded fixture explicitly; the current session can sort ahead of it.
tmux_private send-keys -t "$SESSION:0.0" -l 'fixture-resume-marker'
sleep .2
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
for geometry in "40 16" "48 20" "59 24" "64 24" "80 32" "120 32" "192 40"; do
  read -r width height <<<"$geometry"
  tmux_private resize-window -t "$SESSION" -x "$width" -y "$height"
  sleep 0.2
  pane="$(capture_current)"
  if [[ -n "${TUI_EVIDENCE_DIR:-}" ]]; then
    tmux_private capture-pane -p -e -t "$SESSION:0.0" >"$TUI_EVIDENCE_DIR/steak-usap-${width}.ansi"
    capture_current >"$TUI_EVIDENCE_DIR/steak-usap-${width}.txt"
  fi
  for expected in '● resumed' '╰─' '◫' '$1.234' 'tok' 'cache'; do
    if ! grep -Fq -- "$expected" <<<"$pane"; then
      printf 'Native status at %s columns is missing %q\n%s\n' "$width" "$expected" "$pane" >&2
      exit 1
    fi
  done
  assert_ansi_width "$width"
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

# Repeat startup under Pi's opposite stock theme with an independent session:
# concurrent hosts must never share the same session/checkpoint ownership.
node - "$TMP/sessions/fixture.jsonl" "$TMP/light-fixture.jsonl" <<'NODE'
const fs = require("node:fs");
const [source, target] = process.argv.slice(2);
const lines = fs.readFileSync(source, "utf8").trim().split("\n").map(JSON.parse);
lines[0].id = "22222222-2222-4222-8222-222222222222";
fs.writeFileSync(target, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
NODE
SESSION="light"
tmux_private new-session -d -x 80 -y 24 -s "$SESSION" \
  "cd '$ROOT' && exec $PI_ENV '$PI_EXECUTABLE' --offline --approve --session '$TMP/light-fixture.jsonl' \
    --extension '$TMP/completion-proof.ts' --no-skills --no-prompt-templates --no-context-files --use-theme light"
record_ownership
wait_for_current "● resumed"
for width in 40 59 80 120 192; do
  tmux_private resize-window -t "$SESSION" -x "$width" -y 32
  sleep .2
  assert_ansi_width "$width"
  if [[ -n "${TUI_EVIDENCE_DIR:-}" ]]; then
    tmux_private capture-pane -p -e -t "$SESSION:0.0" >"$TUI_EVIDENCE_DIR/steak-light-${width}.ansi"
    capture_current >"$TUI_EVIDENCE_DIR/steak-light-${width}.txt"
  fi
done
if capture | grep -Eq 'Extension .* error:|USAP checkpoints already owned'; then
  echo 'Light-theme fixture reported an extension/session ownership error' >&2
  capture >&2
  exit 1
fi

# Offline provider-boundary regression: queue a follow-up, compose a mixed long
# paste, then Escape to restore the queue. Native getText -> setText used to
# erase the paste map here while leaving only its marker in the sent message.
cat >"$TMP/paste-proof.ts" <<EOF
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { appendFileSync, writeFileSync } from "node:fs";
export default function(pi) {
  pi.registerProvider("xiaomi", {
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1", api: "openai-completions", apiKey: "offline-fixture",
    models: [{ id: "mimo-v2.6-flash", name: "Offline paste fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      // No network or inference: capture exactly what reaches the provider API.
      const stream = createAssistantMessageEventStream();
      const users = context.messages.filter(m => m.role === "user");
      const last = users.at(-1);
      const text = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter(b => b.type === "text").map(b => b.text).join("");
      appendFileSync("$TMP/paste-requests.jsonl", JSON.stringify({ text }) + "\\n");
      const message = { role: "assistant", api: "openai-completions", provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (text === "paste-stream") {
          const finish = () => {
            clearTimeout(timer);
            message.stopReason = "aborted"; message.errorMessage = "Offline fixture aborted";
            stream.push({ type: "error", reason: "aborted", error: message }); stream.end();
          };
          const timer = setTimeout(finish, 30000);
          options?.signal?.addEventListener("abort", finish, { once: true });
          writeFileSync("$TMP/paste-stream-started", "ready");
        } else {
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message }); stream.end();
        }
      });
      return stream;
    },
  });
}
EOF
SESSION="paste"
tmux_private new-session -d -x 120 -y 32 -s "$SESSION" \
  "cd '$ROOT' && exec $PI_ENV '$PI_EXECUTABLE' --offline --approve --no-session \
    --extension '$TMP/paste-proof.ts' --no-skills --no-prompt-templates --no-context-files --use-theme dark"
record_ownership
wait_for_current "● ready"
tmux_private send-keys -t "$SESSION:0.0" -l 'paste-stream'
tmux_private send-keys -t "$SESSION:0.0" Enter
for _ in {1..100}; do [[ -f "$TMP/paste-stream-started" ]] && break; sleep .1; done
[[ -f "$TMP/paste-stream-started" ]] || { capture >&2; echo 'Offline paste stream did not start' >&2; exit 1; }
tmux_private send-keys -t "$SESSION:0.0" -l 'queued paste preface'
tmux_private send-keys -t "$SESSION:0.0" M-Enter
wait_for_current 'Follow-up: queued paste preface'
python3 - "$TMP" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
payload = "It's kind of interesting, this talk has a lot of detail. Keep the quoted words, punctuation, and Unicode intact: café 🥩. " * 14
prefix, suffix = 'Please examine this quote: ', ' Then compare it with my other content.'
(root / 'paste-input').write_bytes((prefix + '\x1b[200~' + payload + '\x1b[201~' + suffix).encode())
(root / 'paste-expected.json').write_text(json.dumps('queued paste preface\n\n' + prefix + payload + suffix))
PY
# Scripted bracketed paste, not clipboard or real user input.
tmux_private load-buffer "$TMP/paste-input"
tmux_private paste-buffer -t "$SESSION:0.0"
wait_for_current '[paste #1'
if [[ -n "${TUI_EVIDENCE_DIR:-}" ]]; then
  tmux_private capture-pane -p -e -t "$SESSION:0.0" >"$TUI_EVIDENCE_DIR/steak-paste-collapsed.ansi"
  capture_current >"$TUI_EVIDENCE_DIR/steak-paste-collapsed.txt"
fi
tmux_private send-keys -t "$SESSION:0.0" Escape
# Restoration expands the draft, so its prefix can be above the editor viewport.
# Give the restored fixture enough rows to inspect both ends without editing it.
tmux_private resize-window -t "$SESSION" -x 120 -y 64
wait_for_current 'queued paste preface'
sleep .3
if [[ -n "${TUI_EVIDENCE_DIR:-}" ]]; then
  tmux_private capture-pane -p -e -t "$SESSION:0.0" >"$TUI_EVIDENCE_DIR/steak-paste-restored.ansi"
  capture_current >"$TUI_EVIDENCE_DIR/steak-paste-restored.txt"
fi
tmux_private send-keys -t "$SESSION:0.0" Enter
for _ in {1..100}; do
  [[ "$(wc -l <"$TMP/paste-requests.jsonl" | tr -d ' ')" -ge 2 ]] && break
  sleep .1
done
if [[ -n "${TUI_EVIDENCE_DIR:-}" ]]; then
  sleep .2
  tmux_private capture-pane -p -e -t "$SESSION:0.0" >"$TUI_EVIDENCE_DIR/steak-paste-submitted.ansi"
  capture_current >"$TUI_EVIDENCE_DIR/steak-paste-submitted.txt"
fi
python3 - "$TMP" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
requests = [json.loads(line)['text'] for line in (root / 'paste-requests.jsonl').read_text().splitlines()]
expected = json.loads((root / 'paste-expected.json').read_text())
assert requests == ['paste-stream', expected], f'Provider-bound paste mismatch: {requests!r}'
print(f'Native queue/abort/paste provider-boundary proof passed ({len(expected)} characters, exact match).')
PY

session_count="$(find "$TMP/sessions" -type f -name '*.jsonl' | wc -l | tr -d ' ')"
[[ "$session_count" -ge 1 ]]
printf 'Steak Pi native TUI smoke passed offline with isolated resume (%s session files).\n' "$session_count"

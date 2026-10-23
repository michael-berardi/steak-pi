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
    printf "TUI processes/socket closed; workspace retained: %s\n" "$TMP"
  else
    rm -rf "$TMP"
    [[ ! -e "$TMP" ]] && echo "TUI cleanup verified: owned processes/socket and disposable workspace absent."
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
  packages: [],
}, null, 2));
NODE

EVIDENCE="${TUI_EVIDENCE_DIR:-$TMP/evidence}"
mkdir -p "$EVIDENCE"
cat >"$TMP/paste-proof.ts" <<EOF
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { appendFileSync, writeFileSync } from "node:fs";
export default function(pi) {
  pi.on("input", event => { appendFileSync("$TMP/input-events.jsonl", JSON.stringify({text:event.text,source:event.source}) + "\\n"); });
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
        timestamp: Date.now(), content: [{type: "text", text: "Offline input captured"}], stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
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
PI_ENV="env -i HOME='$TMP/home' PATH='$SAFE_PATH' TMPDIR='$TMP' SHELL='/bin/bash' USER='steak-smoke' TERM='screen-256color' COLORTERM='truecolor' LANG='en_US.UTF-8' LC_ALL='en_US.UTF-8' XDG_CONFIG_HOME='$TMP/xdg-config' XDG_STATE_HOME='$TMP/xdg-state' XDG_CACHE_HOME='$TMP/xdg-cache' XDG_DATA_HOME='$TMP/xdg-data' PI_CODING_AGENT_DIR='$TMP/config' PI_OFFLINE='1' PI_TELEMETRY='0' NODE_DISABLE_COMPILE_CACHE='1'"
cat >"$TMP/delayed-companion.ts" <<EOF
import companion from "$STEAK_PACKAGE/extensions/statusline.ts";
import { writeFileSync } from "node:fs";
export default function(pi) {
 companion({...pi,on(name,handler){
  if(name === "session_start") return pi.on(name,async(event,ctx)=>{
    writeFileSync("$TMP/before-first-companion", "ready");
    await new Promise(resolve=>setTimeout(resolve,4000));
    return handler(event,ctx);
  });
  return pi.on(name,handler);
 }});
}
EOF
SESSION="paste"
tmux_private new-session -d -x 120 -y 32 -s "$SESSION" \
  "cd '$ROOT' && exec $PI_ENV '$PI_EXECUTABLE' --offline --approve --no-session \
    --extension '$TMP/paste-proof.ts' --extension '$TMP/delayed-companion.ts' --no-skills --no-prompt-templates --no-context-files --use-theme dark"
record_ownership
for _ in {1..100}; do [[ -f "$TMP/before-first-companion" ]] && break; sleep .05; done
[[ -f "$TMP/before-first-companion" ]] || { capture >&2; exit 1; }

python3 - "$TMP" <<'PYFIX'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]);nonce="startup-proof";payload="\n".join(f"Row {i:02d}: synthetic note {nonce} for paste test." for i in range(1,26));suffix=" help me do a new linkedin post about this";p.joinpath('direct-paste-input').write_bytes(('[200~'+payload+'[201~').encode());p.joinpath('direct-expected.json').write_text(json.dumps(payload+suffix));p.joinpath('direct-suffix').write_text(suffix)
PYFIX
# Scripted bracketed paste, not clipboard or real user input.
# tmux 3.8 paste-buffer rewrites embedded bracketed-paste markers, so send the bytes literally.
tmux_private send-keys -t "$SESSION:0.0" -l "$(cat "$TMP/direct-paste-input")"
wait_for_current '[paste #1 +25 lines]'
tmux_private send-keys -t "$SESSION:0.0" -l "$(<"$TMP/direct-suffix")"
sleep .2
capture_current > "$EVIDENCE/paste-before-first-swap.txt"
wait_for_current "STEAK PI"
wait_for_current "● ready"
capture_current > "$EVIDENCE/paste-direct-before-submit.txt"
tmux_private capture-pane -p -e -t "$SESSION:0.0" > "$EVIDENCE/paste-direct-before-submit.ansi"
tmux_private send-keys -t "$SESSION:0.0" Enter
for _ in {1..100}; do [[ -s "$TMP/paste-requests.jsonl" ]] && break; sleep .1; done
python3 - "$TMP" "$EVIDENCE" <<'PYCHECK'
import json,pathlib,sys,hashlib
p,e=map(pathlib.Path,sys.argv[1:]);f=p/'paste-requests.jsonl';assert f.exists(),'no provider-bound request';r=[json.loads(x)for x in f.read_text().splitlines()];expected=json.loads((p/'direct-expected.json').read_text());actual=r[0]['text'];result={'kind':'synthetic offline real Pi CLI/PTY input boundary, not real provider or hardware input','exact':actual==expected,'expectedChars':len(expected),'actualChars':len(actual),'containsKnownMarker':'[paste #1' in actual,'expectedSha256':hashlib.sha256(expected.encode()).hexdigest(),'actualSha256':hashlib.sha256(actual.encode()).hexdigest(),'workspace':str(p)};e.joinpath('direct-provider-result.json').write_text(json.dumps(result,indent=2));e.joinpath('direct-provider-text.txt').write_text(actual);e.joinpath('direct-expected-text.txt').write_text(expected);print(json.dumps(result));assert result['exact'], 'fresh mixed paste leaked or changed at provider boundary'
PYCHECK

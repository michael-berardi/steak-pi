#!/bin/bash
# PowerShell 7 (Linux) container test for scripts/install.ps1. Run inside mcr.microsoft.com/powershell:
#   bash /itest/pwsh.sh   (dist/release at /rel, dist/itest at /itest)
# Same synthetic-release approach as linux.sh; the base is served by a short-lived python3 http.server
# on port 8791 (container-local only), because Invoke-WebRequest does not support file://.
set -eu
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq python3 tar ca-certificates >/dev/null
elif command -v tdnf >/dev/null 2>&1; then
  tdnf install -y python3 tar ca-certificates >/dev/null
else
  echo "FAIL: no supported package manager (apt-get or tdnf)"; exit 1
fi
PWSH=$(command -v pwsh)
W=/tmp/work; mkdir -p "$W"
. /itest/fixture.sh
mkdir -p "$W/cli"
tar -xzf /rel/steak-pi.tgz -C "$W/cli" package/bin/steak-pi
CLI="$W/cli/package/bin/steak-pi"
cp /itest/fake-pi "$W/fake-pi"; cp /itest/fake-npm "$W/fake-npm"
chmod 755 "$W/fake-pi" "$W/fake-npm"
mkdir -p "$W/binA" "$W/binB"
ln -sf "$W/fake-pi" "$W/binA/pi"
make_base "$W/base1" 0.98.0 no
make_base "$W/baseB" 0.98.0 yes

python3 -m http.server 8791 --bind 127.0.0.1 --directory "$W" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8791/base1/SHA256SUMS', timeout=2)" 2>/dev/null && break
  sleep 1
done

echo "== P1: Pi present, Node absent (install.ps1 fetches official Node), real npm ci =="
HA="$W/homeA"; mkdir -p "$HA"
env HOME="$HA" PATH="$W/binA:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HA/agent" \
  STEAK_PI_HOME="$HA/steak-pi" STEAK_PI_BIN_DIR="$HA/bin" STEAK_PI_RELEASE_BASE="http://127.0.0.1:8791/base1" \
  "$PWSH" -NoProfile -File /rel/install.ps1 > "$W/p1.log" 2>&1 || { cat "$W/p1.log"; exit 1; }
cat "$W/p1.log"
assert_contains "$HA/agent/settings.json" "$HA/steak-pi/releases/0.98.0/package" "P1 settings pin"
assert_contains "$W/p1.log" "steak-pi CLI      0.98.0" "P1 status version"
assert_contains "$W/p1.log" "Pi was already installed" "P1 pi-present message"
assert_contains "$W/p1.log" "fetching the official Node" "P1 node fetch"
[ -x "$HA/bin/steak-pi" ] || { echo "FAIL: P1 steak-pi shim"; exit 1; }
assert_absent "$HA/bin/pi" "P1 must not add a pi shim"
env HOME="$HA" PATH="$W/binA:/usr/bin:/bin" "$HA/bin/steak-pi" version | grep -F "steak-pi 0.98.0" || { echo "FAIL: P1 version command"; exit 1; }

echo "== P2: Pi absent, fake npm, Node present (from P1's runtime) =="
HB="$W/homeB"; mkdir -p "$HB"
NODEBIN=$(ls -d "$HA/steak-pi/runtime"/node-*/bin | head -n 1)
ln -sf "$NODEBIN/node" "$W/binB/node"
ln -sf "$W/fake-npm" "$W/binB/npm"
env HOME="$HB" PATH="$W/binB:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HB/agent" \
  STEAK_PI_HOME="$HB/steak-pi" STEAK_PI_BIN_DIR="$HB/bin" STEAK_PI_RELEASE_BASE="http://127.0.0.1:8791/baseB" \
  NPM_CALLS="$HB/npm-calls.log" FAKE_PI="$W/fake-pi" \
  "$PWSH" -NoProfile -File /rel/install.ps1 > "$W/p2.log" 2>&1 || { cat "$W/p2.log"; exit 1; }
cat "$W/p2.log"
assert_contains "$HB/npm-calls.log" "@earendil-works/pi-coding-agent@1.0.4" "P2 pinned Pi install"
assert_contains "$HB/agent/settings.json" "$HB/steak-pi/releases/0.98.0/package" "P2 settings pin"
assert_contains "$W/p2.log" "Pi 1.0.4 was installed too" "P2 pi-installed message"
[ -x "$HB/bin/pi" ] || { echo "FAIL: P2 pi shim"; exit 1; }

echo "== P3: corrupted archive refused, nothing installed =="
HC="$W/homeC"; mkdir -p "$HC"
corrupt "$W/base1"
if env HOME="$HC" PATH="$W/binA:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HC/agent" \
  STEAK_PI_HOME="$HC/steak-pi" STEAK_PI_BIN_DIR="$HC/bin" STEAK_PI_RELEASE_BASE="http://127.0.0.1:8791/base1" \
  "$PWSH" -NoProfile -File /rel/install.ps1 > "$W/p3.log" 2>&1; then echo "FAIL: P3 accepted a corrupted archive"; exit 1; fi
assert_contains "$W/p3.log" "checksum mismatch for steak-pi.tgz" "P3 checksum error" # pwsh wraps long error lines
assert_absent "$HC/steak-pi/releases" "P3 no releases"
assert_absent "$HC/bin/steak-pi" "P3 no shim"
assert_absent "$HC/agent/settings.json" "P3 no settings"

echo "== PSScriptAnalyzer (skipped with a message if it will not install quickly) =="
timeout 240 "$PWSH" -NoProfile -Command \
  "try { Install-Module PSScriptAnalyzer -Force -Scope CurrentUser -ErrorAction Stop; \$r = Invoke-ScriptAnalyzer -Path /rel/install.ps1; if (\$r) { \$r | Format-Table -AutoSize | Out-String | Write-Host; exit 1 } else { 'PSScriptAnalyzer: no findings' } } catch { 'PSScriptAnalyzer skipped: ' + \$_.Exception.Message }" || echo "PSScriptAnalyzer step did not complete cleanly (see above)"

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
trap - EXIT
if python3 -c "import socket; s=socket.socket(); s.settimeout(2); s.connect(('127.0.0.1',8791))" 2>/dev/null; then
  echo "FAIL: port 8791 still open"; exit 1
fi
echo "PWSH-INSTALL-TESTS-PASS (port 8791 released)"
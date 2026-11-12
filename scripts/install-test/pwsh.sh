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

assert_contains "$HB/bin/pi" "steak-pi-installer-shim" "P2 pi shim marker"
assert_contains "$HB/bin/steak-pi" "steak-pi-installer-shim" "P2 steak-pi shim marker"

echo "== P4: a foreign pi in the bin folder is left alone; the resolved lock version is used =="
HD="$W/homeD"; mkdir -p "$HD/bin"
printf '#!/bin/sh\necho users-own-pi\n' > "$HD/bin/pi"; chmod 755 "$HD/bin/pi"
env HOME="$HD" PATH="$W/binB:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HD/agent" \
  STEAK_PI_HOME="$HD/steak-pi" STEAK_PI_BIN_DIR="$HD/bin" STEAK_PI_RELEASE_BASE="http://127.0.0.1:8791/baseB" \
  NPM_CALLS="$HD/npm-calls.log" FAKE_PI="$W/fake-pi" \
  "$PWSH" -NoProfile -File /rel/install.ps1 > "$W/p4.log" 2>&1 || { cat "$W/p4.log"; exit 1; }
assert_contains "$HD/bin/pi" "users-own-pi" "P4 foreign pi preserved"
assert_contains "$W/p4.log" "alone: it was not written by this installer" "P4 message"
assert_contains "$HD/npm-calls.log" "@earendil-works/pi-coding-agent@1.0.4" "P4 resolved pin, not the ^1.0.0 range"
assert_contains "$HD/agent/settings.json" "$HD/steak-pi/releases/0.98.0/package" "P4 settings pin"

echo "== P5: re-run with our own pi shim on PATH is not taken for the user's Pi =="
env HOME="$HB" PATH="$HB/bin:$W/binB:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HB/agent" \
  STEAK_PI_HOME="$HB/steak-pi" STEAK_PI_BIN_DIR="$HB/bin" STEAK_PI_RELEASE_BASE="http://127.0.0.1:8791/baseB" \
  NPM_CALLS="$HB/npm-calls2.log" FAKE_PI="$W/fake-pi" \
  "$PWSH" -NoProfile -File /rel/install.ps1 > "$W/p5.log" 2>&1 || { cat "$W/p5.log"; exit 1; }
if grep -Fq "Pi is already installed" "$W/p5.log"; then echo "FAIL: P5 took its own shim for the user's Pi"; exit 1; fi
assert_contains "$W/p5.log" "Pi 1.0.4 was installed too" "P5 message"

echo "== P6: relative STEAK_PI_HOME and STEAK_PI_BIN_DIR (the cwd must not matter later) =="
HE="$W/homeE"; mkdir -p "$HE/cwd"
( cd "$HE/cwd" && env HOME="$HE" PATH="$W/binA:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HE/agent" \
  STEAK_PI_HOME="rel/steak-pi" STEAK_PI_BIN_DIR="./rel/bin" STEAK_PI_RELEASE_BASE="http://127.0.0.1:8791/base1" \
  "$PWSH" -NoProfile -File /rel/install.ps1 > "$W/p6.log" 2>&1 ) || { cat "$W/p6.log"; exit 1; }
assert_contains "$HE/agent/settings.json" "$HE/cwd/rel/steak-pi/releases/0.98.0/package" "P6 absolute pin from a relative home"
[ -f "$HE/cwd/rel/steak-pi/releases/0.98.0/package/package.json" ] || { echo "FAIL: P6 release missing"; exit 1; }
[ -x "$HE/cwd/rel/bin/steak-pi" ] || { echo "FAIL: P6 shim missing"; exit 1; }
if ls "$HE/cwd/rel/steak-pi/releases" | grep -q '^\.staging'; then echo "FAIL: P6 staging folder left behind"; exit 1; fi

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

echo "== P7: Test-PathEntryPresent (Path comparison) =="
cat > "$W/pathtest.ps1" <<'PSEOF'
$ast = [System.Management.Automation.Language.Parser]::ParseFile('/rel/install.ps1', [ref]$null, [ref]$null)
$fn = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-PathEntryPresent' }, $true)[0]
if (-not $fn) { Write-Host 'FAIL: Test-PathEntryPresent not found'; exit 1 }
. ([scriptblock]::Create($fn.Extent.Text))
$env:SPTEST_HOME = 'C:\Users\Me'
$cases = @(
  @('C:\a;C:\Users\Me\bin', 'C:\Users\Me\bin', $true),
  @('C:\a;C:\USERS\me\BIN\', 'C:\Users\Me\bin', $true),
  @('C:\a;%SPTEST_HOME%\bin', 'C:\Users\Me\bin', $true),
  @('C:\a;%SPTEST_HOME%\bin\', 'C:\Users\Me\bin', $true),
  @('C:\a;C:\Users\Me\bin2', 'C:\Users\Me\bin', $false),
  @('', 'C:\Users\Me\bin', $false),
  @(';;C:\a;', 'C:\Users\Me\bin', $false))
foreach ($c in $cases) {
  $got = Test-PathEntryPresent -pathValue $c[0] -dir $c[1]
  if ($got -ne $c[2]) { Write-Host "FAIL: Test-PathEntryPresent('$($c[0])') = $got, want $($c[2])"; exit 1 }
}
Write-Host 'Test-PathEntryPresent: all cases ok'
PSEOF
"$PWSH" -NoProfile -File "$W/pathtest.ps1" || { echo "FAIL: P7"; exit 1; }

echo "== PSScriptAnalyzer (skipped with a message if it will not install quickly) =="
timeout 240 "$PWSH" -NoProfile -Command \
  "try { Install-Module PSScriptAnalyzer -Force -Scope CurrentUser -ErrorAction Stop; \$r = Invoke-ScriptAnalyzer -Path /rel/install.ps1; if (\$r) { \$r | Format-Table -AutoSize | Out-String | Write-Host; exit 1 } else { 'PSScriptAnalyzer: no findings' } } catch { 'PSScriptAnalyzer skipped: ' + \$_.Exception.Message }" || { echo "FAIL: PSScriptAnalyzer reported findings in install.ps1 (or did not finish within 240s)"; exit 1; }

kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
trap - EXIT
if python3 -c "import socket; s=socket.socket(); s.settimeout(2); s.connect(('127.0.0.1',8791))" 2>/dev/null; then
  echo "FAIL: port 8791 still open"; exit 1
fi
echo "PWSH-INSTALL-TESTS-PASS (port 8791 released)"
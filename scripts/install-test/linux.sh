#!/bin/bash
# Linux container test for scripts/install.sh (run as: bash /itest/linux.sh inside ubuntu:24.04,
# with dist/release mounted at /rel and dist/itest at /itest). Mirrors test/install-cli.test.ts:
# synthetic release, fake pi (and fake npm for the Pi-absent branch), throwaway HOME.
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq curl tar ca-certificates python3 >/dev/null
W=/tmp/work; mkdir -p "$W"
. /itest/fixture.sh
mkdir -p "$W/cli"
tar -xzf /rel/steak-pi.tgz -C "$W/cli" package/bin/steak-pi
CLI="$W/cli/package/bin/steak-pi"
cp /itest/fake-pi "$W/fake-pi"; cp /itest/fake-npm "$W/fake-npm"
chmod 755 "$W/fake-pi" "$W/fake-npm"
mkdir -p "$W/binA" "$W/binB" "$W/empty"
ln -sf "$W/fake-pi" "$W/binA/pi"

make_base "$W/base1" 0.98.0 no

echo "== A: Pi present, Node absent (installer fetches official Node), real npm ci =="
HA="$W/homeA"; mkdir -p "$HA"
env -i HOME="$HA" PATH="$W/binA:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HA/agent" \
  STEAK_PI_HOME="$HA/steak-pi" STEAK_PI_BIN_DIR="$HA/bin" STEAK_PI_RELEASE_BASE="file://$W/base1" \
  sh /rel/install.sh > "$W/a.log" 2>&1 || { cat "$W/a.log"; exit 1; }
cat "$W/a.log"
assert_contains "$HA/agent/settings.json" "$HA/steak-pi/releases/0.98.0/package" "A settings pin"
assert_contains "$W/a.log" "steak-pi CLI      0.98.0" "A status version"
assert_contains "$W/a.log" "Pi was already installed" "A pi-present message"
assert_contains "$W/a.log" "fetching the official Node" "A node fetch"
[ -x "$HA/bin/steak-pi" ] || { echo "FAIL: A steak-pi shim"; exit 1; }
assert_absent "$HA/bin/pi" "A must not add a pi shim"
ls -d "$HA/steak-pi/runtime"/node-*/bin/node >/dev/null || { echo "FAIL: A runtime node"; exit 1; }
"$HA/bin/steak-pi" version | grep -F "steak-pi 0.98.0" || { echo "FAIL: A version command"; exit 1; }

echo "== E: re-run upgrades in place (0.99.0), keeps the old release =="
make_base "$W/base1" 0.99.0 no
env -i HOME="$HA" PATH="$W/binA:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HA/agent" \
  STEAK_PI_HOME="$HA/steak-pi" STEAK_PI_BIN_DIR="$HA/bin" STEAK_PI_RELEASE_BASE="file://$W/base1" \
  sh /rel/install.sh > "$W/e.log" 2>&1 || { cat "$W/e.log"; exit 1; }
assert_contains "$HA/agent/settings.json" "$HA/steak-pi/releases/0.99.0/package" "E settings re-pin"
assert_contains "$W/e.log" "steak-pi CLI      0.99.0" "E status version"
[ -d "$HA/steak-pi/releases/0.98.0/package" ] || { echo "FAIL: E old release retained"; exit 1; }

echo "== B: Pi absent, fake npm, Node present (from A's runtime) =="
HB="$W/homeB"; mkdir -p "$HB"
NODEBIN=$(ls -d "$HA/steak-pi/runtime"/node-*/bin | head -n 1)
ln -sf "$NODEBIN/node" "$W/binB/node"
ln -sf "$W/fake-npm" "$W/binB/npm"
make_base "$W/baseB" 0.98.0 yes
env -i HOME="$HB" PATH="$W/binB:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HB/agent" \
  STEAK_PI_HOME="$HB/steak-pi" STEAK_PI_BIN_DIR="$HB/bin" STEAK_PI_RELEASE_BASE="file://$W/baseB" \
  NPM_CALLS="$HB/npm-calls.log" FAKE_PI="$W/fake-pi" \
  sh /rel/install.sh > "$W/b.log" 2>&1 || { cat "$W/b.log"; exit 1; }
cat "$W/b.log"
assert_contains "$HB/npm-calls.log" "install --prefix $HB/steak-pi/pi --ignore-scripts --no-audit --no-fund --loglevel=error @earendil-works/pi-coding-agent@1.0.4" "B pinned Pi install"
assert_contains "$HB/npm-calls.log" "ci --ignore-scripts --no-audit --no-fund" "B npm ci"
assert_contains "$HB/agent/settings.json" "$HB/steak-pi/releases/0.98.0/package" "B settings pin"
assert_contains "$W/b.log" "Pi 1.0.4 was installed too" "B pi-installed message"
[ -x "$HB/bin/pi" ] || { echo "FAIL: B pi shim"; exit 1; }
env -i HOME="$HB" PATH="$W/binB:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HB/agent" "$HB/bin/pi" install /tmp/other
assert_contains "$HB/agent/settings.json" "/tmp/other" "B shimmed pi works"

echo "== C: corrupted archive refused, nothing installed =="
HC="$W/homeC"; mkdir -p "$HC"
corrupt "$W/base1"
if env -i HOME="$HC" PATH="$W/binA:/usr/bin:/bin" PI_CODING_AGENT_DIR="$HC/agent" \
  STEAK_PI_HOME="$HC/steak-pi" STEAK_PI_BIN_DIR="$HC/bin" STEAK_PI_RELEASE_BASE="file://$W/base1" \
  sh /rel/install.sh > "$W/c.log" 2>&1; then echo "FAIL: C accepted a corrupted archive"; exit 1; fi
assert_contains "$W/c.log" "checksum mismatch for steak-pi.tgz; nothing was installed" "C checksum error"
assert_absent "$HC/steak-pi/releases" "C no releases"
assert_absent "$HC/bin/steak-pi" "C no shim"
assert_absent "$HC/agent/settings.json" "C no settings"

echo "== D: missing prerequisite named =="
HD="$W/homeD"; mkdir -p "$HD"
if env -i HOME="$HD" PATH="$W/empty" STEAK_PI_HOME="$HD/steak-pi" STEAK_PI_BIN_DIR="$HD/bin" \
  /bin/sh /rel/install.sh > "$W/d.log" 2>&1; then echo "FAIL: D ran without prerequisites"; exit 1; fi
assert_contains "$W/d.log" "needs curl or wget" "D names the missing prerequisite"
assert_absent "$HD/steak-pi/releases" "D nothing installed"

echo "LINUX-INSTALL-TESTS-PASS"
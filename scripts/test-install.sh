#!/bin/sh
# Installer test driver for scripts/install.sh and scripts/install.ps1.
#   1. builds the release assets into dist/release (scripts/build-release.sh; needs a clean tracked tree)
#   2. host (macOS/Linux shell): test/install-cli.test.ts through vitest
#   3. Linux container (ubuntu:24.04): scripts/install-test/linux.sh runs install.sh against the release
#   4. PowerShell 7 container (pwsh-install-test:7.4.6, built here from ubuntu:24.04 plus Microsoft's official
#      arm64/x64 tarball when absent): scripts/install-test/pwsh.sh runs install.ps1 and PSScriptAnalyzer
# Usage: scripts/test-install.sh [--skip-docker]   (docker is needed unless --skip-docker)
# Every container runs with --rm and one at a time; each test uses a throwaway HOME and PI_CODING_AGENT_DIR.
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd)
SKIP_DOCKER=0
case "${1:-}" in --skip-docker) SKIP_DOCKER=1 ;; "") ;; *) echo "usage: $0 [--skip-docker]" >&2; exit 2 ;; esac

fail() { echo "test-install: FAIL: $*" >&2; exit 1; }
pass() { echo "ok - $*"; }

sh scripts/build-release.sh dist/release >/dev/null || fail "scripts/build-release.sh"
pass "release assets built in dist/release"

npx vitest run test/install-cli.test.ts || fail "host installer tests (test/install-cli.test.ts)"
pass "host installer tests (vitest, test/install-cli.test.ts)"

if [ "$SKIP_DOCKER" -eq 1 ]; then
  echo "test-install: container tests skipped (--skip-docker)"
  exit 0
fi

docker run --rm --name steak-pi-install-linux \
  -v "$ROOT/dist/release:/rel:ro" -v "$ROOT/scripts/install-test:/itest:ro" \
  ubuntu:24.04 bash /itest/linux.sh || fail "Linux container install tests (ubuntu:24.04)"
pass "Linux container install tests (ubuntu:24.04)"

PS_VERSION=7.4.6
PWSH_IMAGE="pwsh-install-test:$PS_VERSION"
if ! docker image inspect "$PWSH_IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$PWSH_IMAGE" - >/dev/null <<DOCKERFILE || fail "cannot build the PowerShell $PS_VERSION test image"
FROM ubuntu:24.04
RUN apt-get update -qq && apt-get install -y -qq ca-certificates curl libicu74 >/dev/null \\
 && case "\$(uname -m)" in aarch64) a=arm64 ;; x86_64) a=x64 ;; *) echo "unsupported CPU \$(uname -m)" >&2; exit 1 ;; esac \\
 && curl -fsSL --retry 3 -o /tmp/ps.tgz "https://github.com/PowerShell/PowerShell/releases/download/v$PS_VERSION/powershell-$PS_VERSION-linux-\$a.tar.gz" \\
 && mkdir -p /opt/powershell && tar -xzf /tmp/ps.tgz -C /opt/powershell && chmod +x /opt/powershell/pwsh \\
 && ln -s /opt/powershell/pwsh /usr/bin/pwsh && rm /tmp/ps.tgz
DOCKERFILE
fi
docker run --rm --name steak-pi-install-pwsh \
  -v "$ROOT/dist/release:/rel:ro" -v "$ROOT/scripts/install-test:/itest:ro" \
  "$PWSH_IMAGE" bash /itest/pwsh.sh || fail "PowerShell 7 (Linux) container tests"
pass "PowerShell 7 (Linux) container tests and PSScriptAnalyzer step"

echo "test-install: all installer tests passed"

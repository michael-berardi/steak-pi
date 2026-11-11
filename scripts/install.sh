#!/bin/sh
# Steak Pi installer for macOS and Linux:  curl -fsSL https://github.com/michael-berardi/steak-pi/releases/latest/download/install.sh | sh
# Downloads the latest release archive, checks its SHA-256, installs it into the release-folder layout
# `steak-pi update` maintains, and points Pi at it. Uses the Node 22.19+ already on this machine, or fetches
# the official Node into Steak Pi's own folder (nothing global). Uses the `pi` already on PATH, or installs
# the Pi coding agent into Steak Pi's folder and adds a `pi` shim only when none existed.
# Layout:  $STEAK_PI_HOME/releases/<version>/package   (default ~/.local/share/steak-pi)
# Environment: STEAK_PI_HOME, STEAK_PI_BIN_DIR (default ~/.local/bin), STEAK_PI_VERSION (default: latest),
# STEAK_PI_PI_VERSION (Pi version to install when pi is absent; default: the pin in the release's package-lock.json),
# STEAK_PI_RELEASE_BASE (override the download base URL, used by tests).
set -eu

REPO="github.com/michael-berardi/steak-pi"
NODE_MIN_MAJOR=22; NODE_MIN_MINOR=19
HOME_DIR="${STEAK_PI_HOME:-$HOME/.local/share/steak-pi}"
case "$HOME_DIR" in /*) ;; *) HOME_DIR="$(pwd)/$HOME_DIR" ;; esac
RELEASES="$HOME_DIR/releases"
BIN_DIR="${STEAK_PI_BIN_DIR:-$HOME/.local/bin}"
case "$BIN_DIR" in /*) ;; *) BIN_DIR="$(pwd)/$BIN_DIR" ;; esac
if [ -n "${STEAK_PI_RELEASE_BASE:-}" ]; then BASE="$STEAK_PI_RELEASE_BASE"
elif [ -n "${STEAK_PI_VERSION:-}" ]; then BASE="https://$REPO/releases/download/v${STEAK_PI_VERSION#v}"
else BASE="https://$REPO/releases/latest/download"; fi
if [ -n "${STEAK_PI_VERSION:-}" ]; then ARCHIVE="steak-pi-${STEAK_PI_VERSION#v}.tgz"; else ARCHIVE="steak-pi.tgz"; fi

say() { printf '%s\n' "$*"; }
die() { printf 'steak-pi install: %s\n' "$*" >&2; exit 1; }

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1" || die "download failed: $1"; }
else die "needs curl or wget to download the release; install one (macOS: curl is built in; Debian/Ubuntu: apt-get install curl) and run this again"; fi
command -v tar >/dev/null 2>&1 || die "needs tar to unpack the release; install tar (Debian/Ubuntu: apt-get install tar) and run this again"

if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "needs sha256sum or shasum to verify the download; install coreutils (Debian/Ubuntu: apt-get install coreutils) and run this again"; fi

main() {
TMP=$(mktemp -d "${TMPDIR:-/tmp}/steak-pi-install.XXXXXX") || die "cannot create a temporary folder"
STAGE=""
trap 'rm -rf "$TMP"; if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# expect <file> <name> <sums-file>: the file's SHA-256 must equal the line for <name> in the sums file.
expect() {
  want=$(awk -v n="$2" '{ f=$2; sub(/^\*/, "", f); if (f == n) print $1 }' "$3")
  [ -n "$want" ] || die "no checksum for $2 in $(basename "$3")"
  [ "$(sha256 "$1")" = "$want" ] || die "checksum mismatch for $2; nothing was installed"
}

node_ok() { # node_ok <node-binary>
  v=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}; rest=${v#*.}; minor=${rest%%.*}
  [ "$major" -gt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]; }
}

say "Downloading Steak Pi..."
fetch "$BASE/$ARCHIVE" "$TMP/$ARCHIVE"
fetch "$BASE/SHA256SUMS" "$TMP/SHA256SUMS"
expect "$TMP/$ARCHIVE" "$ARCHIVE" "$TMP/SHA256SUMS"
mkdir "$TMP/src"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP/src" || die "cannot unpack the download"
[ -f "$TMP/src/package/package.json" ] && [ -f "$TMP/src/package/bin/steak-pi" ] || die "the download is not a Steak Pi release (package/package.json or package/bin/steak-pi missing)"
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TMP/src/package/package.json" | head -n 1)
[ -n "$VERSION" ] || die "cannot read the release version"
if [ -n "${STEAK_PI_VERSION:-}" ] && [ "$VERSION" != "${STEAK_PI_VERSION#v}" ]; then
  die "the archive reports version $VERSION, not the pinned ${STEAK_PI_VERSION#v}; nothing was installed"
fi

# Node: the one on PATH when it is new enough, else the official build, kept inside Steak Pi's own folder.
NODE_BIN=""
NODE_DIR=""
if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE_BIN=$(command -v node)
else
  ls /lib/ld-musl-* >/dev/null 2>&1 && die "this system uses musl (Alpine): install Node 22.19+ with its package manager (apk add nodejs npm), then run this again"
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) die "unsupported system $(uname -s); on Windows use install.ps1" ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  say "Node 22.19 or newer not found; fetching the official Node 22 LTS for $os-$arch..."
  nbase="https://nodejs.org/dist/latest-v22.x"
  fetch "$nbase/SHASUMS256.txt" "$TMP/NODESUMS"
  nname=$(awk -v s="-$os-$arch.tar.gz" 'index($2, s) { print $2 }' "$TMP/NODESUMS" | head -n 1)
  [ -n "$nname" ] || die "no official Node build for $os-$arch"
  fetch "$nbase/$nname" "$TMP/$nname"
  expect "$TMP/$nname" "$nname" "$TMP/NODESUMS"
  nver=${nname#node-}; nver=${nver%%-*}
  mkdir -p "$HOME_DIR/runtime"
  NODE_DIR="$HOME_DIR/runtime/node-$nver-$os-$arch"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    rm -rf "$NODE_DIR.tmp"; mkdir "$NODE_DIR.tmp"
    tar -xzf "$TMP/$nname" -C "$NODE_DIR.tmp" --strip-components=1 || die "cannot unpack Node"
    rm -rf "$NODE_DIR"; mv "$NODE_DIR.tmp" "$NODE_DIR"
  fi
  NODE_BIN="$NODE_DIR/bin/node"
  node_ok "$NODE_BIN" || die "the downloaded Node does not run on this machine"
  PATH="$NODE_DIR/bin:$PATH"; export PATH
fi
NPM="$(dirname "$NODE_BIN")/npm"; [ -x "$NPM" ] || NPM=npm
command -v "$NPM" >/dev/null 2>&1 || die "npm not found next to $NODE_BIN or on PATH; it ships with Node"

# Pi: the one on PATH when present, else the pinned release installed into Steak Pi's own folder.
PI_WAS_PRESENT=0
PI_VERSION_INSTALLED=""
if command -v pi >/dev/null 2>&1; then
  PI_WAS_PRESENT=1
  say "Pi is already installed ($(command -v pi)); using it."
else
  PI_VERSION_INSTALLED="${STEAK_PI_PI_VERSION:-}"
  if [ -z "$PI_VERSION_INSTALLED" ]; then
    [ -f "$TMP/src/package/package-lock.json" ] || die "the release has no package-lock.json to read the Pi version pin from; set STEAK_PI_PI_VERSION"
    PI_VERSION_INSTALLED=$("$NODE_BIN" -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).packages[""].devDependencies["@earendil-works/pi-coding-agent"] || ""' "$TMP/src/package/package-lock.json")
    [ -n "$PI_VERSION_INSTALLED" ] || die "no Pi version pin in the release's package-lock.json; set STEAK_PI_PI_VERSION"
  fi
  say "Pi not found; installing @earendil-works/pi-coding-agent@$PI_VERSION_INSTALLED into $HOME_DIR/pi..."
  mkdir -p "$HOME_DIR/pi"
  ( cd "$HOME_DIR/pi" && npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
      "$NPM" install --prefix "$HOME_DIR/pi" --ignore-scripts --no-audit --no-fund --loglevel=error \
      "@earendil-works/pi-coding-agent@$PI_VERSION_INSTALLED" </dev/null ) || die "npm install of @earendil-works/pi-coding-agent@$PI_VERSION_INSTALLED failed; nothing was changed"
  PI_LAUNCHER="$HOME_DIR/pi/node_modules/.bin/pi"
  [ -x "$PI_LAUNCHER" ] || die "the Pi install did not produce $PI_LAUNCHER"
fi

# Unpack into the release-folder layout the CLI maintains: <home>/releases/<version>/package.
mkdir -p "$RELEASES" "$BIN_DIR"
chmod 700 "$HOME_DIR" 2>/dev/null || true
REL="$RELEASES/$VERSION"
if [ -f "$REL/package/package.json" ] && [ "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REL/package/package.json" | head -n 1)" = "$VERSION" ]; then
  say "Steak Pi $VERSION is already unpacked; re-pointing Pi."
else
  [ ! -e "$REL" ] || die "release destination $REL already exists but is incomplete; preserved it (remove it and run this again)"
  say "Installing Steak Pi $VERSION..."
  STAGE=$(mktemp -d "$RELEASES/.staging-$VERSION.XXXXXX") || die "cannot create a staging folder in $RELEASES"
  mv "$TMP/src/package" "$STAGE/package"
  # The same dependency install `steak-pi update` runs: the extensions import Pi's own packages, so dev dependencies stay.
  ( cd "$STAGE/package" && npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
      "$NPM" ci --ignore-scripts --no-audit --no-fund --loglevel=error </dev/null ) || die "npm ci failed for Steak Pi $VERSION; nothing was changed"
  if mkdir "$REL" && chmod 700 "$REL" && mv "$STAGE/package" "$REL/package"; then :; else die "cannot move Steak Pi $VERSION into $REL"; fi
  rm -rf "$STAGE"; STAGE=""
fi

# The pi shim is added only when no pi existed before this run.
write_shim() { # write_shim <name> <exec-target>
  shim="$BIN_DIR/$1.tmp.$$"
  if [ -n "$NODE_DIR" ]; then
    cat > "$shim" <<WRAP
#!/bin/sh
PATH="$NODE_DIR/bin:\$PATH"; export PATH
exec "$2" "\$@"
WRAP
  else
    cat > "$shim" <<WRAP
#!/bin/sh
exec "$2" "\$@"
WRAP
  fi
  chmod 755 "$shim"; mv -f "$shim" "$BIN_DIR/$1"
}
if [ "$PI_WAS_PRESENT" -eq 0 ]; then write_shim pi "$HOME_DIR/pi/node_modules/.bin/pi"; fi

# Point Pi at the unpacked release. STEAK_PI_LIBEXEC is the CLI's supported way to pin a local folder
# (the Homebrew wrapper uses it); without it `steak-pi install` would pin a git spec instead.
say "Adding Steak Pi $VERSION to Pi..."
PATH="$BIN_DIR:$PATH"; export PATH
STEAK_PI_LIBEXEC="$REL/package" "$REL/package/bin/steak-pi" install </dev/null || die "'steak-pi install' failed; Pi's settings were not changed"

write_shim steak-pi "$REL/package/bin/steak-pi"

# Health check: the CLI's own status must run and report the release.
if STATUS_OUT=$("$BIN_DIR/steak-pi" status 2>&1 </dev/null); then
  printf '%s\n' "$STATUS_OUT"
else
  printf '%s\n' "$STATUS_OUT" >&2
  die "'steak-pi status' failed after installing"
fi
case "$STATUS_OUT" in *"$VERSION"*) ;; *) die "'steak-pi status' does not report $VERSION" ;; esac

if [ "$PI_WAS_PRESENT" -eq 1 ]; then
  say "Steak Pi $VERSION installed ($BIN_DIR/steak-pi). Pi was already installed; Steak Pi was added to it."
else
  say "Steak Pi $VERSION installed ($BIN_DIR/steak-pi). Pi $PI_VERSION_INSTALLED was installed too ($BIN_DIR/pi)."
fi
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
say "Next: steak-pi run"
}

main "$@"
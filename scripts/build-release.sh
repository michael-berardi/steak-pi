#!/bin/sh
# Builds the download assets for the current commit into <out> (default dist/release):
#   steak-pi-<version>.tgz          the release archive (full tree under package/, like the git clone `steak-pi update` installs)
#   steak-pi-<version>.tgz.sha256   its checksum, in `shasum -a 256 -c` form
#   steak-pi.tgz                    a version-less copy, so releases/latest/download works without knowing the version
#   install.sh, install.ps1         the one-step installers
#   SHA256SUMS                      checksums of every asset above
# Usage: scripts/build-release.sh [out-dir]   (run from a clean checkout of the release tag)
set -eu
cd "$(dirname "$0")/.."
OUT="${1:-dist/release}"
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "build-release: the working tree has changes; build from a clean checkout" >&2; exit 1; }
VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)
[ -n "$VERSION" ] || { echo "build-release: cannot read the version from package.json" >&2; exit 1; }
commit=$(git rev-parse HEAD)
rm -rf "$OUT"; mkdir -p "$OUT"
stage=$(mktemp -d "${TMPDIR:-/tmp}/steak-pi-build.XXXXXX"); trap 'rm -rf "$stage"' EXIT
mkdir "$stage/package"
git archive --format=tar HEAD | tar -x -C "$stage/package"
[ -f "$stage/package/package-lock.json" ] || { echo "build-release: package-lock.json is not committed; npm ci needs it" >&2; exit 1; }
# Deterministic: sorted names, fixed owner and times.
( cd "$stage" && find package -mindepth 1 | LC_ALL=C sort > "$stage.list" )
if tar --version 2>/dev/null | grep -qi gnu; then
  tar -C "$stage" --owner=0 --group=0 --numeric-owner --mtime=@0 --no-recursion -czf "$OUT/steak-pi-$VERSION.tgz" -T "$stage.list"
else
  COPYFILE_DISABLE=1 tar -C "$stage" --uid 0 --gid 0 --uname root --gname root --no-xattrs --no-recursion -czf "$OUT/steak-pi-$VERSION.tgz" -T "$stage.list"
fi
rm -f "$stage.list"
cp "$OUT/steak-pi-$VERSION.tgz" "$OUT/steak-pi.tgz"
cp scripts/install.sh scripts/install.ps1 "$OUT/"
if command -v sha256sum >/dev/null 2>&1; then sums() { sha256sum "$@"; }
else sums() { shasum -a 256 "$@"; }; fi
( cd "$OUT" && sums "steak-pi-$VERSION.tgz" > "steak-pi-$VERSION.tgz.sha256" )
( cd "$OUT" && sums "steak-pi-$VERSION.tgz" steak-pi.tgz "steak-pi-$VERSION.tgz.sha256" install.sh install.ps1 > SHA256SUMS )
echo "built $OUT for $commit (version $VERSION)"
ls -l "$OUT"
#!/bin/sh
# Sourced fixture helpers for the container installer tests. Expects $W (work dir) and $CLI (real bin/steak-pi).
set -eu

make_base() { # make_base <dir> <version> <pin: yes|no>
  b=$1; v=$2; pin=$3
  rm -rf "$b" "$W/src-$v"
  mkdir -p "$b" "$W/src-$v/package/bin"
  printf '{"name":"steak-pi","version":"%s","private":true,"bin":{"steak-pi":"bin/steak-pi"}}' "$v" > "$W/src-$v/package/package.json"
  if [ "$pin" = yes ]; then
    printf '{"name":"steak-pi","version":"%s","lockfileVersion":3,"requires":true,"packages":{"":{"name":"steak-pi","version":"%s","devDependencies":{"@earendil-works/pi-coding-agent":"^1.0.0"}},"node_modules/@earendil-works/pi-coding-agent":{"version":"1.0.4"}}}' "$v" "$v" > "$W/src-$v/package/package-lock.json"
  else
    printf '{"name":"steak-pi","version":"%s","lockfileVersion":3,"requires":true,"packages":{"":{"name":"steak-pi","version":"%s"}}}' "$v" "$v" > "$W/src-$v/package/package-lock.json"
  fi
  cp "$CLI" "$W/src-$v/package/bin/steak-pi"
  chmod 755 "$W/src-$v/package/bin/steak-pi"
  tar -czf "$b/steak-pi.tgz" -C "$W/src-$v" package
  cp "$b/steak-pi.tgz" "$b/steak-pi-$v.tgz"
  ( cd "$b" && sha256sum steak-pi.tgz "steak-pi-$v.tgz" > SHA256SUMS )
}

corrupt() { # corrupt <base>: flip a byte in the version-less archive
  python3 - "$1/steak-pi.tgz" <<'EOF'
import sys
p = sys.argv[1]
data = bytearray(open(p, "rb").read())
data[-1] ^= 0xFF
open(p, "wb").write(data)
EOF
}

assert_contains() { # assert_contains <file> <text> <label>
  grep -Fq "$2" "$1" || { echo "FAIL: $3 ($1 lacks: $2)"; echo "--- $1 ---"; cat "$1"; echo "--- end ---"; exit 1; }
}
assert_absent() { # assert_absent <path> <label>
  [ ! -e "$1" ] || { echo "FAIL: $2 ($1 exists)"; exit 1; }
}
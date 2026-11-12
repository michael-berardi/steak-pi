# Sourced by scripts/test-pi-tui-smoke.sh. Prints the state needed to explain an
# empty or missing Resume picker: the fixture header cwd, the Pi process cwd, the
# Pi version and every session file in the store. The Resume picker filters
# sessions by cwd, so a mismatch between the first two is the usual cause.
#
# Usage: dump_resume_diagnostics <fixture-file> <session-dir> <pi-version> <process-cwd>
# Set TUI_DIAGNOSTICS_DIR to also keep the report in a private folder you own.

session_header_cwd() {
  python3 -c '
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as handle:
        header = json.loads(handle.readline())
    print(header.get("cwd", "<no cwd in session header>"))
except FileNotFoundError:
    print("<fixture missing>")
except (OSError, ValueError) as error:
    print("<unreadable session header: %s>" % type(error).__name__)
' "$1"
}

dump_resume_diagnostics() {
  local fixture="$1" session_dir="$2" pi_version="$3" process_cwd="$4"
  local report="" file
  report+="Resume diagnostics:"$'\n'
  report+="  Pi version: ${pi_version:-<unknown>}"$'\n'
  report+="  process cwd: ${process_cwd:-<unknown>}"$'\n'
  report+="  fixture header cwd: $(session_header_cwd "$fixture")"$'\n'
  report+="  session dir: ${session_dir}"$'\n'
  if [[ -d "$session_dir" ]]; then
    local count=0
    while IFS= read -r file; do
      count=$((count + 1))
      report+="    $(basename "$file") bytes=$(wc -c <"$file" | tr -d ' ') header_cwd=$(session_header_cwd "$file")"$'\n'
    done < <(find "$session_dir" -maxdepth 1 -type f -name '*.jsonl' | LC_ALL=C sort)
    report+="  session files: ${count}"$'\n'
  else
    report+="  session dir missing"$'\n'
  fi
  printf '%s' "$report" >&2
  if [[ -n "${TUI_DIAGNOSTICS_DIR:-}" ]]; then
    mkdir -p "$TUI_DIAGNOSTICS_DIR"
    chmod 700 "$TUI_DIAGNOSTICS_DIR"
    (umask 077 && printf '%s' "$report" >"$TUI_DIAGNOSTICS_DIR/resume-diagnostics.txt")
  fi
}

# Contributing

Issues and focused pull requests are welcome.

## Development

Requirements: Node.js 22.19 or newer and Pi 0.85.1 or 0.86.0 (release-tested
with 0.86.0). Pi 0.85.0 does not expose the required companion lifecycle API,
and Pi 0.87.x is not claimed.

```sh
git clone https://github.com/michael-berardi/steak-pi.git
cd steak-pi
npm ci --ignore-scripts
npm run verify
```

Keep changes narrow, add regression tests for behavior changes, and preserve
Pi's native editor behavior through `CustomEditor`: editing, autocomplete, IME,
mouse input, history, submission, and application keybindings. Transcript,
tools, selectors, and session behavior remain native Pi surfaces.
USAP children must remain bounded and non-recursive; writable tasks require
disjoint ownership and the parent retains integration and verification.

Do not commit credentials, `.env` files, generated session data, or private
benchmark traces. Generated package archives, internal verification prompts, and
raw gate/ledger logs are release assets or private evidence, not tracked files.
This project runs release checks locally and does not accept GitHub Actions
workflows.

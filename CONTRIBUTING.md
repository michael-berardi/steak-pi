# Contributing

Issues and focused pull requests are welcome.

## Development

Requirements: Node.js 22 or newer and Pi 0.85.x.

```sh
git clone https://github.com/michael-berardi/steak-pi.git
cd steak-pi
npm install
npm run verify
```

Keep changes narrow, add regression tests for behavior changes, and preserve
Pi's native editor, transcript, tools, selectors, history, and keybindings.
USAP children must remain bounded and non-recursive; writable tasks require
disjoint ownership and the parent retains integration and verification.

Do not commit credentials, `.env` files, generated session data, or private
benchmark traces. This project runs release checks locally and does not accept
GitHub Actions workflows.

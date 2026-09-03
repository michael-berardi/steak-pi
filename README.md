<div align="center">

# 🍒 Cherry Pi

**The lucky-core flavor of [Pi](https://pi.dev).**

Minimal by design. Smart where it counts. Jackpot when it lands.

*by Employee Cybernetics*

</div>

---

Cherry Pi is a curated layer for the [Pi coding agent](https://pi.dev) — not a
fork. Stock Pi stays stock; Cherry Pi adds only what earns its place, and
nothing else:

- 🎯 **Todo** — a phased task list with OMP-compatible semantics
  (start / done / block / auto-promotion), persisted locally
- 🤖 **Sub-agents** — bounded parallel agents with mid-run steering, matching
  OMP's orchestration model
- 🧠 **Memory** — AGENTS.md conventions plus opt-in cross-session recall
- 🛠️ **Error correction** — LSP diagnostics and a verify-after-edit loop

Everything is toggleable. Idle overhead: zero.

## Error correction

Cherry Pi closes the loop after every edit. Add a verify command to your
project:

```json
// .cherry-pi/config.json
{ "verify": { "command": "npm run -s typecheck", "failLimit": 2 } }
```

After each edit or write, Cherry Pi runs it. Failures are appended to the
tool result with attempt count and output, so the model self-repairs before
moving on — capped at `failLimit` consecutive failures, then it stops
nagging. Success resets the counter. No config, zero overhead.

Pair it with [`pi-lsp`](https://www.npmjs.com/package/@narumitw/pi-lsp)
(`pi install npm:@narumitw/pi-lsp`) for language-server diagnostics your
agent can read and fix directly.

## Memory

Projects remember through `AGENTS.md` conventions — Cherry Pi ships a
`memory` skill that teaches the agent to record durable decisions and
re-read them at session start. Cross-session recall is available as an
opt-in companion (`pi install npm:@narumitw/pi-recall`); it stays opt-in
until isolation and redaction gates pass.

## Opt-in companions

These ship **outside** Cherry Pi by design — install only what you want:

| Capability | Install | Notes |
| --- | --- | --- |
| Plan mode | `pi install npm:pi-plan-mode` | Codex-style explore → approve → implement gate |
| MCP servers | pi settings (`mcpServers`) | Model Context Protocol tools and resources |
| Web access | `pi install npm:pi-web-access` | Web search + content extraction |
| LSP diagnostics | `pi install npm:@narumitw/pi-lsp` | Language-server diagnostics as agent tools |
| Cross-session recall | `pi install npm:@narumitw/pi-recall` | Opt-in until privacy gates pass |

Cherry Pi never enables companions implicitly: each one changes behavior,
so each one is an explicit choice.

## Install

```sh
pi install npm:cherry-pi
```

Or try it without installing:

```sh
pi -e npm:cherry-pi
```

## Why Cherry Pi

Stock Pi is the fastest, leanest coding agent we measured. OMP adds
orchestration and opinions — at five times the token cost. Cherry Pi keeps
Pi's speed and leanness and adds the few capabilities that are worth their
weight, each one independently toggleable and benchmarked.

Benchmarks, methodology, and definition hashes: see
[`BENCHMARKS.md`](./BENCHMARKS.md) (published with v0.1).

## Themes

The **cherry** theme ships in the box: cherry red on neutral dark surfaces,
stem-green success, built for legibility under UltraTerm's theme matrix.

## Status

v0.1 in development. Public release lands with benchmark evidence.

## License

[MIT](./LICENSE) · by Employee Cybernetics

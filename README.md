<div align="center">

# 🍒 Steak Pi

**The lucky-core flavor of [Pi](https://pi.dev).**

Minimal by design. Smart where it counts. Jackpot when it lands.

*by Implose Cybernetics*

</div>

---

Steak Pi is a curated layer for the [Pi coding agent](https://pi.dev) — not a
fork. Stock Pi stays stock; Steak Pi adds only what earns its place, and
nothing else:

- 🎯 **Todo** — a phased task list with OMP-compatible semantics
  (start / done / block / auto-promotion), persisted locally
- 🤖 **Sub-agents** — bounded parallel agents with mid-run steering, matching
  OMP's orchestration model
- 🧠 **Memory** — AGENTS.md conventions plus opt-in cross-session recall
- 🛠️ **Error correction** — LSP diagnostics and a verify-after-edit loop
- ⚡ **UltraCompress** — the default compaction: deterministic VCC briefs,
  snap frames for bulky tool output, optional UltraCompact (UC) packets, and
  lossless recall — no LLM calls, $0 per compaction

Everything is toggleable. Idle overhead: zero.

## Error correction

Steak Pi closes the loop after every edit. Add a verify command to your
project:

```json
// .steak-pi/config.json
{ "verify": { "command": "npm run -s typecheck", "failLimit": 2 } }
```

After each edit or write, Steak Pi runs it. Failures are appended to the
tool result with attempt count and output, so the model self-repairs before
moving on — capped at `failLimit` consecutive failures, then it stops
nagging. Success resets the counter. No config, zero overhead.

Pair it with [`pi-lsp`](https://www.npmjs.com/package/@narumitw/pi-lsp)
(`pi install npm:@narumitw/pi-lsp`) for language-server diagnostics your
agent can read and fix directly.

## Memory

Projects remember through `AGENTS.md` conventions — Steak Pi ships a
`memory` skill that teaches the agent to record durable decisions and
re-read them at session start. Cross-session recall is available as an
opt-in companion (`pi install npm:@narumitw/pi-recall`); it stays opt-in
until isolation and redaction gates pass.

## Opt-in companions

These ship **outside** Steak Pi by design — install only what you want:

| Capability | Install | Notes |
| --- | --- | --- |
| Plan mode | `pi install npm:pi-plan-mode` | Codex-style explore → approve → implement gate |
| MCP servers | pi settings (`mcpServers`) | Model Context Protocol tools and resources |
| Web access | `pi install npm:pi-web-access` | Web search + content extraction |
| LSP diagnostics | `pi install npm:@narumitw/pi-lsp` | Language-server diagnostics as agent tools |
| Cross-session recall | `pi install npm:@narumitw/pi-recall` | Opt-in until privacy gates pass |

Steak Pi never enables companions implicitly: each one changes behavior,
so each one is an explicit choice.

## Install

```sh
pi install git:github.com/michael-berardi/steak-pi@v0.1.0
```

Or try it without installing:

```sh
pi -e git:github.com/michael-berardi/steak-pi
```

## Why Steak Pi

We benchmarked honestly: 23 validated cases x 5 samples, one model
(GLM-5.3-flash) across every harness, correctness decided by independent
verify commands — never by the agent's own opinion.

| | Steak Pi | Stock Pi | OMP |
| --- | --- | --- | --- |
| Completed | **110/115** | 108/115 | 110/115 |
| Median latency | **16.1s** | 18.3s | 23.7s |
| Total tokens | 2.63M | **2.33M** | 14.16M |

Steak Pi completes more tasks than stock Pi, 12% faster at the median,
for a measured 12.8% token premium — the price of the todo tracker,
bounded parallel agents, verify-after-edit, and memory conventions it
adds. Against OMP the case is total: 32% faster, 5.4x leaner.

Full methodology, per-run ledger, runner validation, and the
dual-model verification trail: [`docs/verification/`](./docs/verification/).

## Compaction

Steak Pi compacts with [UltraCompress](https://github.com/michael-berardi/ultracompress)
(vendored under `extensions/ultracompress/`): a deterministic brief in
10–300 ms with zero API cost, lossless recall over the raw session
(`ultracompress_recall`, `/ultracompress-recall`), sticky key facts that
survive every pass, and pre-compaction snapshots in `.steak-pi/snaps/`.
Manual control: `/ultracompress keep:N policy:auto|vcc|snap|uc`. Requires the
`ultracompress` binary (`~/.local/bin/ultracompress`; falls back to Pi core
compaction if missing).

## Themes

Three steak themes ship in the box: **steak-oled** (flagship — true black,
pure-white text, maximum contrast), **steak** (neutral dark), and
**steak-light**. Built for legibility under UltraTerm's theme matrix; the
terminal-theme bridge (`src/lib/terminalThemes.ts`) keeps host chrome and
agent UI on one surface. An OMP-style powerline statusline
(`◆ model · ✦ thinking · ⑂ branch · ⚡ compression`) renders as a footer widget —
event-driven, zero idle overhead.

## Status

v0.2.1 — UltraCompress is the default compaction, replacing Instant Snap
(whose pre-compaction snapshot guarantee is preserved inside UltraCompress).
Benchmark evidence: [ultracompress/docs/BENCHMARKS.md](https://github.com/michael-berardi/ultracompress/blob/main/docs/BENCHMARKS.md).

## License

[MIT](./LICENSE) · by Implose Cybernetics

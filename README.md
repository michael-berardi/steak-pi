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
- 🤖 **UltraTerm Sub-Agent Protocol** — native bounded Pi children, background
  jobs, session-wide scheduling, path ownership, cancellation, accounting, and
  a run-local IRC-style relay
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
pi install git:github.com/michael-berardi/steak-pi@v0.2.1
```

Or try it without installing:

```sh
pi -e git:github.com/michael-berardi/steak-pi
```

## UltraTerm Sub-Agent Protocol

`ultraterm_subagents` replaces the legacy `parallel` subprocess tool. It runs
1–8 bounded native Pi children with at most four active at once across the
session, at most 16 active runs, and 50 retained terminal runs. The parent
supplies the shared goal and contract; every writable leaf must receive
disjoint owned paths. Read-only workers cannot edit, shell access is opt-in and
explicitly outside path sandboxing, ambient extensions and project prompts are
excluded, and every run has hard turn, time, output, and relay bounds.

Background runs return stable IDs immediately. `ultraterm_hub` lists, inspects,
waits for, messages, and cancels them without polling. Children coordinate with
`ultraterm_relay`, an ephemeral run-namespaced mailbox supporting addressed
messages, requests, replies, broadcasts, and parent communication. Worker
usage is attributed to the parent exactly once.

The parent remains the only orchestrator: it owns decomposition, integration,
judgment, and final proof. Full protocol:
[`docs/ULTRATERM-SUBAGENT-PROTOCOL.md`](./docs/ULTRATERM-SUBAGENT-PROTOCOL.md).
A small paid live GLM-5.3-Flash calibration, with raw caveats and no product-win
claim, is recorded at
[`benchmarks/usap/results/glm53-live-calibration-2026-09-04.md`](./benchmarks/usap/results/glm53-live-calibration-2026-09-04.md).

## Why Steak Pi

The historical 0.2.1 benchmark used 23 validated cases × 5 samples, one model
(GLM-5.3-flash) across every harness, and independent verify commands. Those
numbers describe the legacy bounded executor and are retained as the historical
baseline; the new USAP implementation is being rebenchmarked separately.

| | Steak Pi | Stock Pi | OMP |
| --- | --- | --- | --- |
| Completed | **110/115** | 108/115 | 110/115 |
| Median latency | **16.1s** | 18.3s | 23.7s |
| Total tokens | 2.63M | **2.33M** | 14.16M |

In that historical suite, Steak Pi completed more tasks than stock Pi, 12%
faster at the median, for a measured 12.8% token premium. It was 32% faster
and 5.4× leaner than OMP. These results describe the removed legacy executor,
not USAP; current calibration is linked above.

Full methodology, per-run ledger, runner validation, and the dual-model
verification trail:
[`docs/verification/`](https://github.com/michael-berardi/steak-pi/tree/v0.2.1/docs/verification).

## Compaction

Steak Pi compacts with [UltraCompress](https://github.com/michael-berardi/ultracompress)
(vendored under `extensions/ultracompress/`): a deterministic brief in
10–300 ms with zero API cost, lossless recall over the raw session
(`ultracompress_recall`, `/ultracompress-recall`), sticky key facts that
survive every pass, and pre-compaction snapshots in `.steak-pi/snaps/`.
Manual control: `/ultracompress keep:N policy:auto|vcc|snap|uc`. Requires the
`ultracompress` binary (`~/.local/bin/ultracompress`; falls back to Pi core
compaction if missing).

## Companion UI

Steak Pi adds a minimal native header, a responsive two-line footer baseline
(with extension statuses preserved when present), and a theme-inheriting
streaming pulse. It reports ready/thinking/responding/tool/waiting/
compacting/error/completion state alongside model, context, persisted usage,
cache hit rate, branch, and session location. Pi still owns the editor,
transcript, tool cards, selectors, history, scrolling, and every keybinding.

The UI uses only the active Pi theme's semantic tokens—no hard-coded terminal
colors and no UltraTerm-theme matrix—so stock dark/light and user themes work
without a custom per-theme Steak theme. **steak**, **steak-oled**, and
**steak-light** remain optional. See [`docs/COMPANION-UI.md`](./docs/COMPANION-UI.md)
for the state contract and deterministic headless simulator.

```sh
npm run ui:simulate -- --scenario tool --width 80 --height 24
```

## Status

**v0.2.1** — adds the theme-neutral native companion UI, makes UltraCompress
the default compaction, and replaces legacy `parallel` with the UltraTerm
Sub-Agent Protocol. UltraCompress benchmark evidence:
[ultracompress/docs/BENCHMARKS.md](https://github.com/michael-berardi/ultracompress/blob/main/docs/BENCHMARKS.md).

## Contributing and security

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the local verification workflow
and [`SECURITY.md`](./SECURITY.md) for private vulnerability reporting and the
USAP trust boundary.

## License

[MIT](./LICENSE) · by Implose Cybernetics

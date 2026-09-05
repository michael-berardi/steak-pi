<div align="center">

# 🥩 Steak Pi

### Pi, cooked properly.

**Native subagents. Deterministic compaction. Automatic verification.
A useful TUI. No orchestration theatre.**

*The sharp, low-drama package for people who like stock Pi—and would rather not
build the rest themselves.*

[Install](#install) · [Why Steak Pi](#why-steak-pi) · [Benchmarks](#proof-not-garnish) · [USAP](#usap-native-subagents) · [Security](./SECURITY.md)

</div>

---

Steak Pi is the performance-focused package for the
[Pi coding agent](https://pi.dev). It preserves Pi's excellent editor,
transcript, tools, history, selectors, scrolling, and keybindings, then adds the
machinery that turns it into a complete daily driver.

## Install

Verified with Pi 0.85.x. Requires Node.js 22.19.0 or newer.

```sh
pi install git:github.com/michael-berardi/steak-pi@v0.3.3
```

This installs USAP, todo, verification, themes, memory conventions, and the
native companion UI. Deterministic compaction additionally needs the local
[`ultracompress` binary](#ultracompress); without it, Steak Pi safely falls back
to Pi's core compaction.

For a focused launch, enable **Quiet startup** in `/settings`. Routine context,
skill, extension, and theme inventories stay out of the workspace while Pi
continues to surface actionable resource diagnostics.

That is the ceremony. Kettle optional.

> **Measured on the larger controlled GLM-5.3-Flash fixture:** Steak Pi's USAP
> orchestration was **49% faster and used 64% fewer tokens than
> [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi)**. Across all three edit
> fixtures, USAP went **9/9 first-pass**.

## Why Steak Pi

Steak Pi starts with Pi's clean core and adds the parts serious work demands.
OMP organises a fleet; Steak Pi gets the fleet through the work without making
every task attend the meeting:

| Steak Pi adds | What you get |
| --- | --- |
| **USAP native subagents** | Up to four useful workers at once, with ownership, deadlines, cancellation, relay, and exact usage |
| **UltraCompress** | Local 10–300 ms compaction, lossless raw-session retention, ranked recall, and **$0 model cost per compaction** |
| **Verify after edit** | Failed project checks go straight back to the model so it can repair its work |
| **Phased todo** | Persistent start/done/block state with automatic promotion |
| **Companion UI** | Responsive lifecycle, model, context, usage, cache, branch, and location telemetry using the active Pi theme |
| **Memory conventions** | Durable project decisions through `AGENTS.md`; cross-session recall remains explicitly opt-in |

The result is still recognisably Pi: quick to start, pleasant to drive, and not
trying to become an operating system because you asked it to rename a method.

## Proof, not garnish

### Current USAP calibration

Larger four-module implementation; `zai/glm-5.3-flash`; thinking `high`; three
samples per arm; identical fixtures and deterministic verification:

| Arm | First-pass | Median time | Median accounted tokens |
| --- | ---: | ---: | ---: |
| **Steak Pi / USAP** | **3/3** | **125.913 s** | **78,834** |
| Legacy `parallel` | 3/3 | 137.462 s | 193,701 |
| OMP | 3/3 | 246.640 s | 220,809 |

Against OMP, Steak Pi was **about 49% faster and 64% leaner**. Against Steak
Pi's old executor, USAP was **about 8% faster and 59% leaner**. Every run passed
first attempt.

USAP is adaptive by design: tiny jobs stay with the parent; independent leaves
fan out only when parallel work can repay its briefing cost. No compulsory
committee for a two-line fix.

Full controls, all benchmark arms, medians, variability, accounting rules, and
security probes:
[`glm53-live-calibration-2026-09-04.md`](./benchmarks/usap/results/glm53-live-calibration-2026-09-04.md).

### Historical full-suite baseline

Before USAP, Steak Pi and stock Pi ran 23 validated cases × five samples under
the same model:

| | Steak Pi | Stock Pi |
| --- | ---: | ---: |
| Completed | **110/115** | 108/115 |
| Median latency | **16.1 s** | 18.3 s |

Steak Pi completed more runs while finishing **12% faster at the median**.
USAP has since replaced that legacy executor; on both fan-out cases in the
current calibration, it substantially reduced the old executor's orchestration
bill.

Historical methodology and per-run evidence:
[`docs/verification/`](https://github.com/michael-berardi/steak-pi/tree/v0.2.1/docs/verification).

## USAP: native subagents

`ultraterm_subagents` runs bounded Pi children inside the host process. The
parent owns decomposition, judgment, integration, and final proof. Children get
exact leaf contracts, do not receive orchestration tools, and are forbidden by
protocol from recursively delegating.

```text
parent
 ├─ scout     read-only
 ├─ backend   writes src/server/**
 ├─ frontend  writes src/client/**
 └─ reviewer  read-only
        ↕ bounded run-local relay
```

What prevents agent soup:

- **four active children session-wide**, at most eight tasks per run and 16
  active runs;
- foreground by default; background only when parent work can overlap;
- stable run IDs with list, status, wait, message, inbox, and cancel controls;
- isolated worker settings, transcripts, resources, and tool sets;
- read-only workers without edit tools;
- disjoint ownership enforced for guarded writes and edits;
- hard time, turn, output, history, and relay limits;
- exact nested usage attributed to the parent once.

Children coordinate through `ultraterm_relay`, a bounded run-local mailbox with
addressed messages, requests, correlated replies, broadcasts, and parent
communication. A little like IRC, if IRC had path ownership.

**Trust boundary:** USAP is coordination, not an OS sandbox. Explicitly granting
`allowBash` gives a child unsandboxed shell access and can bypass path ownership.
See [`SECURITY.md`](./SECURITY.md) and the full
[USAP protocol](./docs/ULTRATERM-SUBAGENT-PROTOCOL.md).

## Reliability built in

Steak Pi treats reliability as machinery, not a personality trait:

- configured project checks feed failures back into the edit result;
- cancellation, deadline, turn, output, mailbox, and retained-run bounds are
  enforced;
- one failed child cannot erase a sibling's evidence or turn the run green;
- ownership validates containment, symlinks, overlap, and platform case rules;
- malformed, negative, infinite, or duplicated usage cannot corrupt totals;
- workers do not inherit unrelated extensions, skills, prompts, or transcripts.

The [v0.2.1 release](https://github.com/michael-berardi/steak-pi/releases/tag/v0.2.1)
passed **109 automated tests**, dark/light native TUI smoke, 40/120-column resize
and ANSI checks, packed-archive smoke, and a fresh isolated installation. Live
probes exercised cancellation, exact deadlines, correlated relay replies,
prompt injection, and hostile out-of-scope writes. The latter was refused, as
one rather hopes.

### Verify after edit

```json
// .steak-pi/config.json
{ "verify": { "command": "npm run -s typecheck", "failLimit": 2 } }
```

After a successful edit or write in a trusted project, Steak Pi runs the command
when no verification is already active, debounced to 500 ms. It has a timeout,
bounded output, abort handling, process cleanup, and a consecutive-failure cap.
With no configuration, it does nothing at all—an underrated performance
characteristic.

Pair it with [`pi-lsp`](https://www.npmjs.com/package/@narumitw/pi-lsp) for
language-server diagnostics the agent can read and fix directly.

## UltraCompress

[UltraCompress](https://github.com/michael-berardi/ultracompress) provides
byte-deterministic VCC briefs, snap frames for bulky output, optional
UltraCompact packets, sticky facts, pre-compaction snapshots, and **lossless raw
session retention** with ranked recall (**94.4% hit@5** in its published
benchmark).

Compaction takes roughly **10–300 ms**, makes **no LLM call**, and costs **$0 per
compaction**. Context management should not require another context-management
agent. We have standards.

Install the native binary (Rust 1.85 or newer):

```sh
git clone https://github.com/michael-berardi/ultracompress
cd ultracompress && cargo build --release
mkdir -p ~/.local/bin && cp target/release/ultracompress ~/.local/bin/
```

If it is absent or fails, Steak Pi falls back to Pi's core compaction. Commands:
`/ultracompress`, `/ultracompress-recall`, and `/ultracompress-stats`.
[Benchmark evidence](https://github.com/michael-berardi/ultracompress/blob/main/docs/BENCHMARKS.md).

## Native companion UI

Steak Pi adds a compact native header and its signature composer with an
integrated status band, prompt gutter, and conditional extension-status row. It
reports lifecycle state alongside model, context, persisted usage, cache hit
rate, branch, and session location.

The composer extends Pi's `CustomEditor`, preserving native editing,
autocomplete, history, IME, mouse, submit, and application keybindings. It is
event-driven, preserves extension statuses, and uses Pi's semantic theme
tokens: no polling, hard-coded terminal palette, provider hooks, or idle timers. Optional **steak**, **steak-oled**, and **steak-light** themes ship
with it; ordinary Pi and user themes work too.

UI contract and simulator: [`docs/COMPANION-UI.md`](./docs/COMPANION-UI.md).

## Memory and optional companions

The included `memory` skill uses `AGENTS.md` for durable project decisions.
Anything that expands the trust boundary remains opt-in:

| Capability | Install |
| --- | --- |
| Plan mode | `pi install npm:pi-plan-mode` |
| Web access | `pi install npm:pi-web-access` |
| LSP diagnostics | `pi install npm:@narumitw/pi-lsp` |
| Cross-session recall | `pi install npm:@narumitw/pi-recall` |
| MCP servers | Pi settings (`mcpServers`) |

Steak Pi does not install companions behind your back. Your terminal has enough
roommates already.

## Development

```sh
git clone https://github.com/michael-berardi/steak-pi.git
cd steak-pi
npm install
npm run verify
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for contribution guidance and
[`SECURITY.md`](./SECURITY.md) for private vulnerability reporting.

## In one line

**Steak Pi is Pi ready for serious work: faster orchestration, drastically lower
agent overhead, deterministic context, automatic correction, and no unnecessary
ceremony. Already measured. Already bounded. Already cooked.**

[MIT](./LICENSE) · by Implose Cybernetics

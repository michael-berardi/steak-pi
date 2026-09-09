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

Release **0.5.0**, verified with Pi 0.85.1. Requires Pi 0.85.1 or newer within
0.85.x and Node.js 22.19.0 or newer. Pi 0.85.0 lacks the lifecycle/context API
used by the companion UI.

```sh
pi install git:github.com/michael-berardi/steak-pi@v0.5.0
```

This installs USAP, todo, verification, themes, memory conventions, and the
native companion UI. Deterministic compaction additionally needs the local
[`ultracompress` binary](#ultracompress); without it, Steak Pi safely falls back
to Pi's core compaction.

For a focused launch, enable **Quiet startup** in `/settings`. Routine context,
skill, extension, and theme inventories stay out of the workspace while Pi
continues to surface actionable resource diagnostics.

That is the ceremony. Kettle optional.

> **Measured live on GLM-5.3-Flash (2026-09-09 mirror):** 27/27 benchmark runs
> and 16/16 pressure-gate fixes passed first attempt. Under the same delegation
> shape as the September calibration, USAP used **27% fewer tokens** than its
> previous release, and its new capacity system held a hard **8-worker
> machine-wide cap across concurrent sessions** with zero provider errors. In
> the earlier controlled comparison, USAP was **49% faster and 64% leaner than
> [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi)**.

## Why Steak Pi

Steak Pi starts with Pi's clean core and adds the parts serious work demands.
Delegation stays selective: substantial independent leaves can fan out without
making every task attend the meeting:

| Steak Pi adds | What you get |
| --- | --- |
| **USAP native subagents** | Up to eight GLM (or six Luna) workers at once per session, with provider-aware machine-wide caps, ownership, deadlines, cancellation, relay, and reported usage |
| **UltraCompress** | Local 10–300 ms compaction, lossless raw-session retention, ranked recall, and **$0 model cost per compaction** |
| **Verify after edit** | Failed project checks go straight back to the model so it can repair its work |
| **Phased todo** | Persistent start/done/block state with automatic promotion |
| **Companion UI** | Responsive lifecycle, model, context, usage, cache, and cost telemetry using the active Pi theme |
| **Memory conventions** | Durable project decisions through `AGENTS.md`; cross-session recall remains explicitly opt-in |

The result is still recognisably Pi: quick to start, pleasant to drive, and not
trying to become an operating system because you asked it to rename a method.

## Proof, not garnish

### Current live mirror (2026-09-09)

Same controls as the September calibration — `zai/glm-5.3-flash`, thinking
`high`, balanced order, fresh fixtures, deterministic verification — plus two
new measurements: doctrine mode (the shipped guidelines choose between inline
and delegation) and a machine-capacity pressure gate.

| Measurement | Result |
| --- | --- |
| First-pass completion | **27/27 runs**, all arms and modes |
| Forced-delegation token cost (modules) | **57,372 median**, down from 78,834 (**−27%**) at the same delegation shape |
| Worker report trims | nested tokens **−22.6%** and wall **−8%** on the forced tiny case |
| Doctrine mode | matched stock Pi wall time within variance while honoring the delegation-speed contract |
| Machine-capacity gate | 2 sessions × 8 workers; hard cap of 8 concurrent held; 16/16 fixes verified; no 429s — **~8 fixes/minute aggregate** under one shared cap |

**Takeaway:** at the same delegation shape, the 0.5.0 delegation path costs
about a quarter less than 0.4.x, first-pass held at 100%, and several open
windows can now delegate simultaneously without stampeding the provider.

### Whole-package speed (0.5.0 optimization pass)

Microbenchmarks from the 0.5.0 pass, reviewed by GPT-6 Astra:

| Hot path | Before | After |
| --- | ---: | ---: |
| UltraCompress context-hook key cache (6,400 lookups, 32×64 KiB texts) | 434.6 ms | **32.5 ms (13×)** |
| UC reference reverse lookup with LRU-safe eviction | 468.3 ms | **1.1 ms (425×)** |
| Worker native-tool factory access (per 100k) | 22.68 ms | **0.28 ms (80×)** |
| Companion footer | queried context/usage every render | **statuses only** — zero extra provider-state queries |

These paths run before model calls and on every render, so the savings compound
with turn count: long sessions skip thousands of redundant hashes, byte counts,
and factory allocations.

USAP is adaptive by design: tiny jobs stay with the parent; independent leaves
fan out only when parallel work repays its briefing cost with faster
completion. No compulsory committee for a two-line fix.

Full tables, ranges, controls, and limitations:
[`glm53-live-mirror-2026-09-09.md`](./benchmarks/usap/results/glm53-live-mirror-2026-09-09.md).

### Previous calibration (2026-09-04)

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

- **eight active children session-wide** (GLM lanes; Luna lanes six), at most
  eight tasks per run and 16 active runs; launch width defaults to a full wave
  (min(8, task count));
- **machine-wide launch caps** shared across every local session: eight GLM
  workers total, twelve Luna, provider-bucketed and crash-safe, so three open
  windows cannot stampede the provider;
- foreground by default; background only when parent work can overlap;
- stable run IDs with list, status, wait, message, inbox, and cancel controls;
- isolated worker settings, transcripts, resources, and tool sets;
- read-only workers without edit tools;
- disjoint ownership enforced for guarded writes and edits;
- hard time, turn, output, history, and relay limits;
- exact nested usage attributed to the parent once;
- a fixed 12-turn limit per child, including relay-driven follow-up turns.

Children coordinate through `ultraterm_relay`, a bounded run-local mailbox with
addressed messages, requests, correlated replies, broadcasts, and parent
communication. A little like IRC, if IRC had path ownership.

**Native model selection:** USAP 1.1 accepts either an exact `model` or a native
`profile` for the whole run. An Astra manager can explicitly select
`profile: "steak-pi/glm-5-3-flash"`, including reviewer runs. Omitted selectors
use per-parent profile defaults. Receipts and hub telemetry show the resolved
route, selection provenance, and tool success/error counts. Visual inspection
uses `requireImages: true`. See [profiles and examples](./docs/PROFILES.md).

**GPT routing:** GPT-family requests use the paid Codex subscription route only,
never OpenRouter, API-key billing, or batch variants. Default GPT scout/worker
runs select Luna; default reviewer runs retain the parent model. GLM defaults
remain GLM. Explicit selections take precedence; missing authentication or
capability fails closed without fallback. Astra workers default
to **medium** reasoning, independently of the parent's current effort. Set
`thinking: "high"` or `"xhigh"` only with a concrete task benefit in
`thinkingReason`; reviewer role alone does not escalate effort. Other models
keep their existing defaults. See the
[model-routing contract and boundaries](./docs/MODEL-ROUTING.md).

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
- workers do not inherit unrelated extensions, skills, prompts, or transcripts;
- provider image payloads remain intact instead of being rewritten by the
  compaction extension;
- extension event handlers contain unexpected failures rather than taking down
  the host session.

Release candidates must pass the full automated suite, dark/light native TUI
smoke, 40/120-column resize and ANSI checks, packed-archive smoke, and a fresh
isolated installation before release. Live acceptance covers cancellation,
deadlines, correlated relay replies, parent/child loops, image reads, GPT route
denial, and out-of-scope writes. Historical benchmark evidence above does not
substitute for those candidate gates. Worker tool tests execute the real Pi
read, grep, find, ls, edit, write, and bash factories. The native loader explicitly
loads those exports on both Pi SDK loading paths, including the 0.85.1 path.

### Verify after edit

```json
// .steak-pi/config.json
{ "verify": { "command": "npm run -s typecheck", "failLimit": 2 } }
```

After a successful edit or write in a trusted project, Steak Pi runs the command
when no verification is already active, debounced to 500 ms. It has a timeout,
bounded output, abort handling, process cleanup, and a consecutive-failure cap.
Non-edit and failed tool results skip configuration reads. Without a configured
command, successful edits do not launch verification.

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
git clone --branch v0.2.0 https://github.com/michael-berardi/ultracompress
cd ultracompress && cargo build --locked --release
mkdir -p ~/.local/bin && cp target/release/ultracompress ~/.local/bin/
```

The adapter retrieves large UC-transformed output by `uc:<hash>` reference
instead of asking the model to copy dense packets. References use a bounded,
session-local original-text cache; decoded and recalled text is not recompressed.
Fresh explicit file reads remain readable for their first model request,
avoiding an immediate archive/retrieve round trip; older reads remain eligible.
Missing references fall back to raw-history recall or re-reading the source.
References defer reading; retrieval adds the content's tokens back. Encoding
statistics therefore do not prove provider-billed end-to-end savings.

UltraTerm-managed installations prefer the bundled UltraCompress bridge over
older user-local binaries, while preserving explicit overrides and telemetry
opt-out. If it is absent or fails, Steak Pi falls back to Pi's core compaction. Commands:
`/ultracompress`, `/ultracompress-recall`, and `/ultracompress-stats`.

The bundled 0.2.0 adapter searches only the current session's actual lineage
by default, including pre-compaction records. `scope:all` adds sibling branches
in that file, **not other sessions**; another session requires an explicit
`sessionFile`. Role/tool and exclusive entry-range filters narrow before
ranking. Pages and UTF-8 excerpt/result byte budgets are bounded; invalid
selectors fail closed. Byte budgets are not token guarantees and exclude the
host's transport wrapper. Requires the 0.2.0 bridge for these options.

[Benchmark evidence](https://github.com/michael-berardi/ultracompress/blob/main/docs/BENCHMARKS.md).

## Native companion UI

In a managed UltraTerm TUI, Steak Pi emits transition-only terminal activity
signals. Thinking, responding, tool work, and compaction remain active even
when terminal output pauses; waiting for user input and settled sessions are
idle. Signals are not emitted in RPC/print mode or unmanaged terminals. This
requires UltraTerm 1.7.1 or newer; no periodic heartbeat or provider request is
added.


Steak Pi adds a one-line native header and its signature composer with an
integrated status band, prompt gutter, live context-pressure meter, and
conditional extension-status row. It reports lifecycle state alongside model,
context window, persisted usage, cache efficiency, and cost as width permits.

The composer extends Pi's `CustomEditor`, preserving native editing,
autocomplete, history, IME, mouse, submit, and application keybindings. It is
event-driven, preserves extension statuses, and uses Pi's semantic theme
tokens: no polling, hard-coded terminal palette, provider hooks, or idle timers.
Optional **steak**, **steak-oled**, and **steak-light** themes ship with it;
ordinary Pi and user themes work too. In `/settings`, choose an automatic
light/dark theme pair to follow the terminal appearance. UltraTerm defaults to
the built-in `light/dark` pair when no theme has been explicitly chosen.

UI contract and simulator: [`docs/COMPANION-UI.md`](./docs/COMPANION-UI.md).

## Memory and optional companions

The included `memory` skill uses `AGENTS.md` for durable project decisions.
Anything that expands the trust boundary remains opt-in:

| Capability | Install |
| --- | --- |
| Plan mode | `pi install npm:pi-plan-mode` |
| Web access | `pi install npm:pi-web-access` |
| LSP diagnostics | `pi install npm:@narumitw/pi-lsp` |
| Explicit cross-session recall | Built-in `ultracompress_recall` with `sessionFile`; no automatic archive scan |
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

## ⭐ If Steak Pi earned a place in your terminal

**[Give Steak Pi a star →](https://github.com/michael-berardi/steak-pi/stargazers)**

Steak Pi is built in the open, measured in public, and shipped without a
download counter or an ad budget. Stars are the only signal that tells other
people running agents day-to-day that this package is worth their evening —
they decide what the next release gets priority on, and they genuinely help
other cooks find the kitchen. If the benchmarks, the protocol, or the compaction
saved you real time, that one click is the fairest trade on this page.

[MIT](./LICENSE) · by Implose Cybernetics

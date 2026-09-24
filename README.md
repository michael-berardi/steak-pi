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

This checkout is the **Steak Pi 0.7.0** performance candidate (USAP 1.2 wire
format, not yet tagged; install instructions below still point at the 0.6.0
release). It builds on release **Steak Pi 0.6.0** (USAP 1.2). It targets Pi 0.86.0
and retains the Pi 0.85.1 peer range. Session-isolation, repaint, and packaged
smoke checks ran on Pi 0.86.0; earlier 0.85.1 evidence predates those changes.
The feature descriptions apply to this revision. Benchmarks below are explicitly dated historical results, not a remeasurement of 0.6.0 or a multi-hour endurance claim.

## Install

Release **0.6.0**. Requires Pi 0.85.1 or 0.86.0 (release-tested with 0.86.0) and
Node.js 22.19.0 or newer. Pi 0.85.0 lacks the lifecycle/context API used by the
companion UI. Steak Pi is distributed from this Git repository and its GitHub
release archives; it is **not** published to the npm registry.

```sh
pi install git:github.com/michael-berardi/steak-pi@v0.6.0
```

GitHub release archives (`steak-pi-0.6.0.tgz` with its `.sha256` beside it) work
without Git access: verify the checksum, extract, and point Pi at the extracted
package.

```sh
shasum -a 256 -c steak-pi-0.6.0.tgz.sha256
tar -xzf steak-pi-0.6.0.tgz
pi install "$PWD/package"
```

**Homebrew is conditional.** The Implose Cybernetics tap
(`michael-berardi/implose-software-distribution`) is private, so
`brew install` is not a public acquisition path. Pre-existing installs by
already-authorized operators continue to work, and the formula ships the
`steak-pi` updater: `steak-pi install` wires the Homebrew-managed copy into Pi,
and `steak-pi update` upgrades through Homebrew while keeping the Pi-side package
on the same release. Everything else uses the git tag or the release archive
above. `steak-pi status` reports what is installed and how it is managed;
UltraTerm adopts a Homebrew-managed copy automatically when no other
installation is configured.

This installs skill-catalog-lite, USAP, todo, verification, themes, memory conventions, and the
native companion UI. Deterministic compaction additionally needs the local
[`ultracompress` binary](#ultracompress); without it, Steak Pi safely falls back
to Pi's core compaction.

For a focused launch, enable **Quiet startup** in `/settings`. Routine context,
skill, extension, and theme inventories stay out of the workspace while Pi
continues to surface actionable resource diagnostics.

That is the ceremony. Kettle optional.

> **Historical comparison — GLM-5.3-Flash, September 9, 2026**
> (earlier Steak Pi build; identical fixtures, balanced order, deterministic verification):
>
> - **Four-module build: 22% faster than stock Pi** (45.8 s vs 59.0 s median,
>   reproduced at 23% in a second same-day matrix) — 9/9 first-pass on both
>   sides
> - **100% first-pass parity**: every Steak Pi run and every stock Pi run
>   passed deterministic verification, across 18 matched runs
> - **16 fixes across two concurrent windows, verified 16/16, under a hard
>   machine-wide cap of 6 concurrent GLM workers** — zero provider errors.
>   Stock Pi has neither subagents nor any cross-window capacity control.

## Why Steak Pi

Steak Pi starts with Pi's clean core and adds the parts serious work demands.
Delegation stays selective: substantial independent leaves can fan out without
making every task attend the meeting:

| Steak Pi adds | What you get |
| --- | --- |
| **USAP native subagents** | Default provider ceilings of eight ZAI or six Codex workers per session, with provider-aware machine-wide caps, ownership, deadlines, cancellation, relay, and reported usage |
| **Skill catalog lite** | Full catalog under budget; compact name/path/trigger index above it, with on-demand skill reads |
| **UltraCompress** | Local 10–300 ms compaction, lossless raw-session retention, ranked recall, and **$0 model cost per compaction** |
| **Verify after edit** | Debounced project checks return success receipts or repairable failure output |
| **Phased todo** | Persistent state, atomic bulk transitions, and automatic promotion |
| **Companion UI** | Responsive lifecycle, model, context, usage, cache, and cost telemetry using the active Pi theme |
| **Memory conventions** | Durable project decisions through `AGENTS.md`; cross-session recall remains explicitly opt-in |

The result is still recognisably Pi: quick to start, pleasant to drive, and not
trying to become an operating system because you asked it to rename a method.

## Proof, not garnish

### Historical live GLM-5.3-Flash comparison — September 9, 2026

Same fixtures, same model (`zai/glm-5.3-flash`, thinking `high`), balanced
order, fresh fixtures, deterministic verification. Stock Pi ran the same cases
with its own built-in tools only. Medians of three runs per cell:

| Fixture | Stock Pi | Steak Pi | Verdict |
| --- | ---: | ---: | --- |
| Four-module build — median wall | 59.0 s | **45.8 s** | **22% faster than stock Pi** (reproduced at 23% in a second same-day matrix) |
| Four-module build — first-pass | 3/3 | 3/3 | quality held |
| Direct edit — median wall | 11.9 s | 15.5 s | small premium: the full package rides along every turn |
| Two-file parallel fix — median wall | 8.3 s | 14.5 s | same story; doctrine keeps trivial work inline |
| First-pass completion | 9/9 | **9/9** | parity everywhere |
| Eight-fix fan-out, two concurrent windows | n/a — no subagents | **8/8 + 8/8 verified under the 6-wide machine cap** | stock Pi has no equivalent |

In this historical matrix, Steak Pi completed the multi-part fixture faster,
while direct edits and the two-file fixture were slower. Both sides passed all
first-pass checks. These results are not a general speed guarantee or a 0.6.0
benchmark; the new checkpoint persistence has its own local overhead. Stock Pi
alone does not include this package's bounded subagents, guarded path ownership,
shared provider caps, verification loops, or local compaction adapter.

Full tables, ranges, controls, and limitations:
[`glm53-live-mirror-2026-09-09.md`](./benchmarks/usap/results/glm53-live-mirror-2026-09-09.md).

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

- **eight tasks and up to eight concurrent children per run**, 16 active runs;
  default session capacity is eight ZAI / six Codex, fourteen combined;
  launch width defaults to min(8, task count), subject to capacity;
- **machine-wide launch caps** shared across every local session: six GLM
  workers on ZAI, twelve Codex, twelve for other providers, twenty-four
  combined by default; these are configurable capacity defaults, not per-model quotas;
- foreground by default; background only when parent work can overlap;
- stable run IDs with list, status, wait, send, inbox, cancel, diagnose, and
  explicit resume controls;
- isolated worker settings, transcripts, resources, and tool sets;
- read-only workers without edit tools;
- disjoint ownership enforced for guarded writes and edits;
- hard time, turn, output, history, and relay limits;
- exact nested usage attributed to the parent once;
- `timeoutMs`: 10 minutes by default, 1 second–8 hours; `maxTurns`: 64
  assistant turns per child by default, 1–2,048, including relay follow-ups.
  Roughly 12 tool turns remains a leaf-sizing guideline, not the runtime cap.

Children coordinate through `ultraterm_relay`, a bounded run-local mailbox with
addressed messages, requests, correlated replies, broadcasts, and parent
communication. A little like IRC, if IRC had path ownership.

**Native model selection:** USAP 1.2 accepts either an exact `model` or a native
`profile` for the whole run. An Astra manager can explicitly select
`profile: "steak-pi/glm-5-3-flash"`, including reviewer runs. Omitted selectors
use per-parent profile defaults. Receipts and hub telemetry show the resolved
route, selection provenance, and tool success/error counts. Visual inspection
uses `requireImages: true`. See [profiles and examples](./docs/PROFILES.md).

**GPT routing:** GPT-family requests use the paid Codex subscription route only,
never OpenRouter, API-key billing, or batch variants. Built-in routine workers
use OpenCode Go (DeepSeek V4.1 Flash); Astra reviewers retain Astra. Go requires
your own key and can retry once on Go GLM 5.3 Flash for a transient failure before
visible output, never for auth, billing, or region errors. Explicit selections
take precedence; missing authentication or
capability fails closed without fallback. Astra workers default
to **medium** reasoning, independently of the parent's current effort. Set
`thinking: "high"` or `"xhigh"` only with a concrete task benefit in
`thinkingReason`; reviewer role alone does not escalate effort. Other models
keep their existing defaults. See the
[model-routing contract and boundaries](./docs/MODEL-ROUTING.md).

**Session isolation:** Hub operations are private to the native parent session. Runs carry its captured session ID and canonical file, including after restart. Late callbacks cannot write into a switched session. Copied or unowned activity remains history, not live work. Legacy checkpoints are adopted only with matching native filename and header evidence; ambiguous records remain on disk but are not attached automatically.

**Pinned plans:** Todo state is private to the native session under `.steak-pi/todo/<session-hash>/`, with its JSON and Markdown together. Legacy workspace-wide plans stay untouched and are not imported automatically. Completed or empty plans unpin; cancelled subagents unpin once their status settles. A cancelled session switch does not erase current work.

**Trust boundary:** USAP is coordination, not an OS sandbox. Explicitly granting
`allowBash` gives a child unsandboxed shell access and can bypass path ownership.
See [`SECURITY.md`](./SECURITY.md) and the full
[USAP protocol](./docs/ULTRATERM-SUBAGENT-PROTOCOL.md).

## New in 0.7.0 (candidate): lighter, faster, same features

Everything from 0.6.0 stays. The package just stops paying for work that
doesn't help the current session:

| Scripted local model, Pi 0.86.0 | Steak Pi 0.6.0 | 0.7.0 | 0.7.0 via `steak-pi run` |
| --- | ---: | ---: | ---: |
| One-shot edit: wall / peak RSS | 0.99 s / 148 MB | 0.77 s / 118 MB | 0.72 s / 100 MB |
| 8-worker USAP fan-out | 3.24 s / 223 MB | 1.22 s / 153 MB | 1.13 s / 125 MB |
| First request size | 17.4 KB | 12.5 KB | 12.5 KB |
| Idle TUI, 10 sessions (PSS) | 963 MB | 610 MB | — |

Stock Pi on the same fixtures: 0.64 s / 117 MB, 6.1 KB first request, 639 MB
for 10 idle sessions. Method, fixtures and limits:
[`benchmarks/overhead`](./benchmarks/overhead/README.md).

- **Route policy only guards providers that can dispatch.** Wrapping all ~41
  catalog providers made Pi rebuild its model catalog once per provider.
- **Tools appear when they can act.** The hub after your first dispatch,
  UltraCompress recall after a compaction, `uc` before the first archived
  result. Each appears once and stays. `STEAK_PI_DEFER_TOOLS=off` restores
  always-on tools.
- **Workers share the host's Pi code.** The first dispatch used to load a
  second copy of Pi and its dependencies. Workers remain separate sessions.
  `STEAK_PI_WORKER_SDK=unbundled` restores the old path.
- **Session capacity matches the docs.** The session scheduler now honours
  `usap-caps.json` (default 14 = 8 ZAI + 6 Codex) instead of the per-run 8.
- **`steak-pi run`** launches pi with a Node compile cache, two malloc arenas
  and a small V8 young generation, each only if you haven't set it. Point
  UltraTerm harness profiles at `steak-pi run` to use it; `steak-pi env`
  shows what it sets.

## New in 0.6.0 (USAP 1.2)

- Native worker compaction and at most one native retry; budgets remain finite.
  Native summaries can use model calls, and their recorded usage is included in
  worker totals. Pi 0.86 cache-warming requests are disabled for isolated workers.
- Private checkpoints scoped to a persistent parent session. Host exit interrupts
  workers; reopening that session exposes recovery state, not an automatic restart.
  Hub `resume` explicitly creates a new run for unfinished tasks only, continuing
  available native history with fresh budgets. Inspect prior side effects first.
- Hub `diagnose` reports budget, progress, failure and checkpoint metadata without
  worker transcripts. Memory-only parent sessions have no durable recovery.
- Background completion is passively displayed at the idle boundary with no
  added model call; it does not automatically make the parent integrate results.
- Compact terminal cards show task states and errors; expanded cards add bounded
  report excerpts and tool counts. No detached worker or recovery daemon.

### Persistence and runtime limits

- The 8-hour maximum is the configurable `timeoutMs` deadline ceiling, not a claim
  that a session, terminal, or host stays healthy that long. No multi-hour
  endurance run was performed for this release.
- Workers, persistent shells, and live relay state belong to the host Pi process;
  recovery checkpoints are retained on disk. Exiting or crashing the host ends
  child execution; reopening the same
  native session exposes recovery state for inspection, and `resume` starts a new
  run with fresh budgets for unfinished tasks only.
- Memory-only parent sessions (no persisted session file) have no durable
  recovery, and nothing restarts workers automatically: there is no daemon,
  detached worker, cross-host failover, or scheduler.
- Cancel, deadline, turn, output, mailbox, and retained-run bounds are enforced
  per process lifetime; a resumed run gets new budgets instead of inheriting a
  prior allowance.

### Optional DeepSeek harness launcher

`bin/steak-pi-dsh` is an explicit opt-in entrypoint for a managed primary session
on `opencode-go/deepseek-v4.1-flash` with native Pi 0.86.0, giving the session's
native-name `bash` tool persistent shell state under the same ownership and
verification rules. It admits only this first-party package at its canonical path
and refuses unknown extensions, resource filters, startup hooks, or
configuration-changing flags instead of silently dropping guards. Ordinary Pi
loading of the extensions is unchanged. Limits, failure modes, and the guarded
vendor adaptation are documented in
[`docs/DEEPSEEK-HARNESS.md`](./docs/DEEPSEEK-HARNESS.md).

## New in 0.5.5

- **Homebrew distribution (Implose Cybernetics):** the formula lives in the
  private Implose Cybernetics tap, so Homebrew remains an update path for
  already-authorized operators rather than a public install; everyone else uses
  the git tag or the release archive above.
- **`steak-pi` updater CLI:** first-class terminal updates. Homebrew-managed
  installs upgrade through `brew` and keep the pi-side package on the same
  release; git and other non-Homebrew installs re-pin to the latest published
  GitHub release (Steak Pi is not published to the npm registry).
  `steak-pi status` shows what is installed and how it is managed.
- **UltraTerm brew adoption:** UltraTerm's Steak Pi launcher uses the
  Homebrew-managed copy automatically when no other package is configured;
  explicitly configured checkouts keep priority.

See [the changelog](./CHANGELOG.md).

### Skill catalog configuration

The extension rewrites only Pi's recognized `<available_skills>` section via
`before_agent_start`; it does not load skill files itself. Small catalogs remain
byte-for-byte unchanged. Above budget, deterministic first-sentence triggers
are shortened to fit; all names and paths remain. Those identities can exceed
an impossibly small budget, and unfamiliar XML is left unchanged.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `STEAK_PI_SKILL_CATALOG_LITE` | enabled | `off`, `0`, `false`, or `no` disables rewriting |
| `STEAK_PI_SKILL_CATALOG_BYTES` | `8192` | Positive UTF-8 catalog-section budget |
| `STEAK_PI_SKILL_CATALOG_WORDS` | `15` | Positive trigger-word limit, capped at 15 |

Invalid numeric settings use defaults. Triggers can omit later keywords; read
full skill instructions when relevant. Disabling restores the stock catalog on
newly constructed prompts, not an already rewritten stored string.

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

After a successful edit or write in a trusted project, Steak Pi waits for a
500 ms quiet period before running the configured command. Concurrent edits
join the batch; edits arriving during a successful check cause another run.
Success appends a compact receipt with command, a 16-hex working-subtree
fingerprint, and elapsed milliseconds; changes detected during the check are
flagged. The fingerprint covers Git-visible tracked and untracked non-ignored
files, not ignored files or a commit identity; non-Git/unreadable trees report
`unavailable`. A receipt records that command's result, not universal correctness.

Failures append bounded repair output and count toward the consecutive-failure
cap. Checks have a timeout, abort handling, and process cleanup. Non-edit and
failed tool results skip configuration reads; without a configured command,
successful edits do not launch verification.

| `.steak-pi/config.json` field | Default | Meaning |
| --- | --- | --- |
| `verify.command` | unset | Trusted-project shell command; required to enable checks |
| `verify.failLimit` | `2` | Positive integer consecutive-failure cap |
| `verify.timeoutMs` | `90000` | Positive command timeout in milliseconds |

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
git clone --branch v0.2.2 https://github.com/michael-berardi/ultracompress
cd ultracompress && cargo build --locked --release
mkdir -p ~/.local/bin && cp target/release/ultracompress ~/.local/bin/
```

The adapter retrieves large UC-transformed output by `uc:<hash>` reference
instead of asking the model to copy dense packets. References use a bounded,
session-local original-text cache; decoded and recalled text is not recompressed.
Fresh explicit file reads and, by default, fresh bash results remain readable
for their first model request, avoiding an immediate archive/retrieve round
trip; older results remain eligible. Archive references use 72-character
`[UC uc:<64 lowercase hex>]` markers (under 80 characters). `ultracompress_uc`
accepts both these and the previous long archive markers, as well as bare
`uc:<hash>` references; they are not codec packets for `uc decode`.
Missing references fall back to raw-history recall or re-reading the source.
References defer reading; retrieval adds the content's tokens back. Encoding
statistics therefore do not prove provider-billed end-to-end savings.

UltraTerm-managed installations prefer the bundled UltraCompress bridge over
older user-local binaries, while preserving explicit overrides and telemetry
opt-out. If it is absent or fails, Steak Pi falls back to Pi's core compaction,
which can use model calls and the provider's normal allowance. Commands:
`/ultracompress`, `/ultracompress-recall`, and `/ultracompress-stats`.

The bundled adapter searches only the current session's actual lineage
by default, including pre-compaction records. `scope:all` adds sibling branches
in that file, **not other sessions**; another session requires an explicit
`sessionFile`. Role/tool and exclusive entry-range filters narrow before
ranking. Pages and UTF-8 excerpt/result byte budgets are bounded; invalid
selectors fail closed. Byte budgets are not token guarantees and exclude the
host's transport wrapper. Requires bridge 0.2.0 or newer for these options.

Adapter settings live in `~/.pi/agent/ultracompress.json`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `uc.minChars` | `8192` | Minimum text-block character count for UC transforms |
| `snap.minChars` | `8192` | Minimum text-block character count for snap transforms |
| `uc.exemptFreshBash` | `true` | Keep bash results after the latest assistant message untransformed |
| `summaryMaxBytes` | `16384` | Automatic-compaction summary UTF-8 cap, clamped to 1,024–65,536 |

Automatic compaction caps both incoming previous summaries and returned
summaries, with an explicit recall hint when truncated; explicit
`/ultracompress` compaction is exempt. Recall's `snippetBytes` defaults to and
cannot exceed 4,000 UTF-8 bytes per excerpt; the separate whole-result budget
still applies (default 12,000 bytes, excluding the transport wrapper).

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
| MCP servers | An optional MCP extension; not bundled or configured by Steak Pi |

Steak Pi does not install companions behind your back. Your terminal has enough
roommates already.

## Development

```sh
git clone https://github.com/michael-berardi/steak-pi.git
cd steak-pi
npm ci --ignore-scripts
npm run verify
```

`npm ci` installs the dev toolchain (TypeScript, Vitest, and pinned Pi 0.86.0
peers) from `package-lock.json`; `npm run verify` runs typecheck, the full test
suite, and the isolated TUI smoke test. Steak Pi itself has no runtime npm
dependencies beyond the Pi peers declared in `package.json`.

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

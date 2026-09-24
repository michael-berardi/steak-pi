<div align="center">

# 🥩 Steak Pi

### Pi, cooked properly.

**Native subagents, local compaction, automatic verification and a better
terminal UI for the [Pi coding agent](https://pi.dev).**

[Install](#install) · [What you get](#what-you-get) · [Subagents](#subagents-usap) · [Performance](#performance) · [Configuration](#configuration) · [Changelog](./CHANGELOG.md)

</div>

---

Steak Pi is a package for Pi. It keeps everything that makes Pi good (the
editor, transcript, tools, history and keybindings) and adds what long,
serious sessions need: parallel subagents with hard limits, compaction that
costs no model calls, checks that run after every edit, and a status line that
tells you what the agent is doing.

Current release: **0.8.1**, for Pi 0.87 or newer. It is also the Steak Pi
bundled with [UltraTerm](https://implosecybernetics.com) 2.4.1.

## Install

```sh
pi install git:github.com/michael-berardi/steak-pi@v0.8.1
```

Or from the release archive, without Git:

```sh
shasum -a 256 -c steak-pi-0.8.1.tgz.sha256
tar -xzf steak-pi-0.8.1.tgz
pi install "$PWD/package"
```

Requires Node.js 22.19 or newer and Pi 0.87 or newer. Steak Pi is distributed
through this repository's tags and GitHub releases, not the npm registry.

For the leanest sessions, start Pi through the bundled launcher. It passes
every argument to `pi` and sets Node's memory and compile-cache defaults only
where you have not set them yourself:

```sh
steak-pi run          # same arguments as pi
steak-pi env          # show what it sets
steak-pi status       # what is installed and how it is managed
```

Local compaction also needs the [`ultracompress`](#compaction-ultracompress)
binary. Without it, Steak Pi uses Pi's built-in compaction.

## What you get

| Feature | What it does |
| --- | --- |
| **Subagents (USAP)** | Up to eight parallel workers per run, with file ownership, deadlines, cancellation, a message relay between workers, and usage reported back to the parent |
| **Local compaction** | Summaries built in 10–300 ms with no model call; the full raw session stays searchable |
| **Verify after edit** | Runs your project check after edits and hands failures straight back to the agent |
| **Phased todo** | A plan pinned in the terminal, saved per session |
| **Companion UI** | One status line for state, model, context pressure, cache use and cost, in your Pi theme |
| **Skill catalog lite** | Keeps large skill catalogs inside a byte budget without dropping any skill |
| **Memory conventions** | Durable project decisions in `AGENTS.md`; recall across sessions only when you ask |

Tools appear only when they can act. The subagent hub appears after your
first dispatch, compaction recall after your first compaction. The prompt
stays small until you need more.

## Subagents (USAP)

`ultraterm_subagents` runs bounded Pi workers inside the parent process. The
parent plans, integrates and signs off; each worker gets one exact task and
cannot delegate further.

```text
parent
 ├─ scout     read-only
 ├─ backend   writes src/server/**
 ├─ frontend  writes src/client/**
 └─ reviewer  read-only
        ↕ run-local relay
```

- **Limits:** eight tasks and eight concurrent workers per run. Each session
  runs at most eight ZAI and six Codex workers (fourteen combined), within
  machine-wide caps shared by every session on the computer.
- **Ownership:** read-only workers have no edit tools. Writers may only touch
  their own paths, and overlapping ownership is refused before the run starts.
- **Budgets:** a 10-minute deadline by default (up to 8 hours) and 64 turns per
  worker by default. Output, relay and history are also bounded.
- **Control:** runs have stable IDs with `list`, `status`, `wait`, `send`,
  `inbox`, `cancel`, `diagnose` and `resume`. Checkpoints let you inspect and
  resume unfinished work after a restart.

**Models.** Routine workers use MiMo V2.6 Flash on the Xiaomi Token Plan, and
automatic reviewers use MiMo V2.6 Pro. Both fall back only to GLM 5.3 Flash on
the ZAI coding subscription. An explicit `model`, `profile` or `harness`
always wins. A wave of reviewers with no explicit route goes to the **Opus
Pass**: the official Claude Code CLI on Opus 5.5 at `xhigh` effort, using your
existing Claude login. GPT models run only through Codex OAuth, never an API
key. Missing credentials fail the run instead of falling back to something
that bills differently. Details: [model routing](./docs/MODEL-ROUTING.md),
[profiles](./docs/PROFILES.md).

**Trust boundary.** USAP coordinates work; it is not an operating-system
sandbox. Granting a worker `allowBash` gives it an unrestricted shell that can
bypass path ownership. See [SECURITY.md](./SECURITY.md) and the
[protocol](./docs/ULTRATERM-SUBAGENT-PROTOCOL.md).

## Compaction (UltraCompress)

[UltraCompress](https://github.com/michael-berardi/ultracompress) compacts
sessions locally in about 10–300 ms, with no model call and no cost. It keeps
the raw session, so anything summarized away can be recalled later
(`ultracompress_recall`, 94.4% hit@5 in its published benchmark). Large tool
output is archived behind short `uc:<hash>` references the agent can open when
it needs them.

```sh
git clone --branch v0.3.0 https://github.com/michael-berardi/ultracompress
cd ultracompress && cargo build --locked --release
mkdir -p ~/.local/bin && cp target/release/ultracompress ~/.local/bin/
```

Commands: `/ultracompress`, `/ultracompress-recall`, `/ultracompress-stats`.
Settings live in `~/.pi/agent/ultracompress.json`; see the
[UltraCompress docs](https://github.com/michael-berardi/ultracompress) for
thresholds and recall budgets.

## Verify after edit

```json
// .steak-pi/config.json
{ "verify": { "command": "npm run -s typecheck", "failLimit": 2 } }
```

After an edit in a trusted project, Steak Pi waits 500 ms for more edits, then
runs the command once. Success adds a short receipt to the edit result;
failure adds the relevant output so the agent can fix it, up to `failLimit`
failures in a row.

| Field | Default | Meaning |
| --- | --- | --- |
| `verify.command` | unset | Shell command to run; checks are off until you set one |
| `verify.failLimit` | `2` | Consecutive failures before it stops re-running |
| `verify.timeoutMs` | `90000` | Time limit for one check |

For language-server diagnostics, pair it with
[`pi-lsp`](https://www.npmjs.com/package/@narumitw/pi-lsp).

## Performance

Measured September 24, 2026 on Pi 0.87.1 (Apple silicon, macOS) with the
[overhead benchmark](./benchmarks/overhead/README.md): a scripted local model
runs identical fixtures, so these numbers show harness overhead, not model
quality. Medians of 5; every run passed.

| | Stock Pi | Steak Pi 0.8.1 | 0.8.1 via `steak-pi run` |
| --- | ---: | ---: | ---: |
| One-shot edit, peak memory | 113 MB | 154 MB | **112 MB** |
| One-shot edit, wall time | 0.32 s | 0.52 s | 0.47 s |
| Eight-worker fan-out, wall time | no subagents | **1.43 s** | 1.69 s |
| First request | 8.8 KB | 16.2 KB | 16.2 KB |

Through `steak-pi run`, a full Steak Pi session peaks at the same memory as
stock Pi. Workers share the host's Pi code instead of loading their own copy,
which is what keeps eight parallel workers under a second and a half. Earlier
measurements, including a live GLM 5.3 Flash comparison with stock Pi, are in
[`benchmarks/`](./benchmarks/usap/README.md).

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `.steak-pi/config.json` → `verify.*` | off | Verify after edit (above) |
| `~/.pi/agent/ultracompress.json` | built-in | Compaction thresholds and recall budgets |
| `STEAK_PI_DEFER_TOOLS=off` | on | Expose every tool from the first request |
| `STEAK_PI_WORKER_SDK=unbundled` | host bundle | Workers load their own Pi SDK copy |
| `STEAK_PI_SKILL_CATALOG_LITE=off` | on | Keep Pi's stock skill catalog |
| `STEAK_PI_SKILL_CATALOG_BYTES` | `8192` | Byte budget for the skill catalog |

Enable **Quiet startup** in `/settings` to keep routine inventories out of the
workspace. Themes **steak**, **steak-oled** and **steak-light** are included,
and any Pi theme works. The UI contract is in
[docs/COMPANION-UI.md](./docs/COMPANION-UI.md).

Anything that widens what the agent can reach stays opt-in:

| Add-on | Install |
| --- | --- |
| Plan mode | `pi install npm:pi-plan-mode` |
| Web access | `pi install npm:pi-web-access` |
| Language-server diagnostics | `pi install npm:@narumitw/pi-lsp` |

## Development

```sh
git clone https://github.com/michael-berardi/steak-pi.git
cd steak-pi
npm ci --ignore-scripts
npm run verify      # typecheck, full test suite, isolated TUI smoke test
```

Steak Pi has no runtime npm dependencies beyond its Pi peers. See
[CONTRIBUTING.md](./CONTRIBUTING.md) to contribute and
[SECURITY.md](./SECURITY.md) to report a vulnerability privately.

If Steak Pi earns a place in your terminal, a
[star](https://github.com/michael-berardi/steak-pi/stargazers) helps other
people find it.

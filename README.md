# Steak Pi

[![Latest release](https://img.shields.io/github/v/release/michael-berardi/steak-pi?label=release)](https://github.com/michael-berardi/steak-pi/releases/latest) [![MIT License](https://img.shields.io/github/license/michael-berardi/steak-pi)](LICENSE) ![Pi 0.87+](https://img.shields.io/badge/Pi-0.87%2B-8A2BE2) ![Node.js 22.19+](https://img.shields.io/badge/node-22.19%2B-339933)

Subagents, local compaction and edit verification for the [Pi coding agent](https://pi.dev).
For developers working through multi-file changes and long terminal sessions:
keep Pi's editor and tools, add bounded workers, a session plan and a status line.

Provider-neutral: no model, provider preference or paid route is selected for you.
Use your own Pi credentials and model selection; configure worker routes separately.

Steak Pi also ships inside [UltraTerm](https://paretocybernetics.com/software/).

## Measured

Historical same-model benchmark on macOS; small Python tasks, not a claim about every workload:
- [40/40 correct in both harnesses; cost $0.053 vs Claude Code’s $0.089](benchmarks/ab/results-2026-11-04.jsonl).
- [Input tokens: 1.96 M vs 3.71 M; wall time: 482 s vs 434 s](benchmarks/ab/results-2026-11-04.jsonl).
- [Cost ratio 0.59 (95% CI 0.50–0.70): cheaper, not faster; reproduce the summary](benchmarks/ab/summarize.py).

## Install

**macOS or Linux:**

```sh
curl -fsSL https://github.com/michael-berardi/steak-pi/releases/latest/download/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://github.com/michael-berardi/steak-pi/releases/latest/download/install.ps1 | iex
```

These commands execute the release installer. Inspect it first if needed.
It verifies the package archive's SHA-256, installs Node.js 22.19+ and the pinned
Pi version if missing, then registers the package with Pi. No sudo is needed.
If the installer prints a PATH instruction, apply it before continuing.

Already have Pi? Install the current package directly:

```sh
pi install git:github.com/michael-berardi/steak-pi@v0.34.2
```

Requires Node.js 22.19+ and Pi 0.87+; development checks use Pi 1.0.4.
Distribution is through Git tags and [release archives](https://github.com/michael-berardi/steak-pi/releases/latest), not npm.
See [installation details](docs/INSTALL.md) for paths, pins, archive installation and removal.

## First use

From a project you trust:

```sh
steak-pi status
steak-pi run
```

With a direct Pi install, start `pi` instead. Authenticate with `/login` and
choose your model with `/model` as needed. Ask: "Read this project's README and
summarize how to run its tests. Do not change any files."

**Shell access is unrestricted.** Workers' path ownership is coordination,
not an OS sandbox; a worker with shell access can bypass it. Use trusted
projects and review [the security model](SECURITY.md) before granting access.

## What you get

| Feature | Use |
| --- | --- |
| Subagents | Delegate exact tasks with ownership, deadlines, cancellation and a message relay |
| Compaction | Use an optional local binary instead of a model call; retain raw-session recall |
| Verify after edit | Run a configured project check and return failures to the agent |
| Session plan | Keep phased todos visible and saved with the session |
| Write guard | Require a read before replacing an existing file |
| Finish guard | Request another turn for unfinished work, within a configured limit |
| Companion UI | Show state, model, context pressure, cache use and cost |

Verification is **off until configured**. Put this in `.steak-pi/config.json`
(replace the command with your project's check):

```json
{ "verify": { "command": "npm run -s typecheck", "failLimit": 2 } }
```

Subagents need an explicit selection or your own worker routing configuration.
See [worker setup and trust boundaries](docs/REFERENCE.md#subagents-usap) and
[model routing](docs/MODEL-ROUTING.md). No fallback chain ships with the package.

Local compaction requires [UltraCompress](https://github.com/michael-berardi/ultracompress)
on PATH; without it, Pi's built-in compaction remains available.
See [compaction settings](docs/COMPACTION.md) and
[snapshot retention](extensions/ultracompress/README.md).

## Local models

Slot any GGUF into Pi as `local/<id>`: `steak-pi local add <file.gguf | owner/repo:quant>` reads the header, sizes the
context to this machine (one slot, flash attention, q8_0 KV cache, 6 GiB of RAM kept free) and writes one `local`
provider to `models.json`. Then `pi --model local/<id>`: `llama-server` starts on demand, is held only while a prompt runs, and stops after 10 minutes with no run.
It refuses, naming the cause, when memory is short, the disk is above 90% or another model server runs. No model ships
with Steak Pi; workers use `ensure`/`release`. Details: [docs/LOCAL-MODELS.md](./docs/LOCAL-MODELS.md).

## Update

```sh
steak-pi update --check
steak-pi update
```

In Pi, `/steak-update` installs an update and reloads. Existing sessions keep
their loaded runtime. `STEAK_PI_NO_UPDATE_CHECK=1` disables background update checks.
`steak-pi update --models` refreshes provider catalogs without installing a package.

## Reference

- [Session reference](docs/REFERENCE.md): workers, verification, finish guard, settings and adaptive tools
- [Installation and launcher](docs/INSTALL.md): paths, environment, updates and uninstall
- [Companion UI](docs/COMPANION-UI.md) and [themes](docs/THEME-PASS.md)
- [Worker profiles](docs/PROFILES.md) and [subagent protocol](docs/ULTRATERM-SUBAGENT-PROTOCOL.md)
- Optional [Claude Code adapter](docs/CLAUDE-CODE.md) and [local models](docs/LOCAL-MODELS.md)
- [Reproducible overhead benchmark](benchmarks/overhead/README.md) and [changelog](CHANGELOG.md)

## From source

```sh
git clone https://github.com/michael-berardi/steak-pi.git
cd steak-pi
npm ci --ignore-scripts
npm run verify
```

`verify` runs TypeScript checks, commit-identity checks, the full test suite and
isolated TUI tests (which require tmux and Python 3).
No runtime npm dependencies beyond Pi peers. See [CONTRIBUTING.md](CONTRIBUTING.md).
[MIT license](LICENSE).

Part of [Pareto Cybernetics](https://paretocybernetics.com/projects/steak-pi/): free, private, open-source tools for working with AI agents.

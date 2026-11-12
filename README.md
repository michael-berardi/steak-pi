<div align="center">

# 🥩 Steak Pi

### Pi, cooked properly.

**Native subagents, local compaction, automatic verification and a better
terminal UI for the [Pi coding agent](https://pi.dev).**

[![Latest release](https://img.shields.io/github/v/release/michael-berardi/steak-pi?label=release)](https://github.com/michael-berardi/steak-pi/releases/latest) [![MIT License](https://img.shields.io/github/license/michael-berardi/steak-pi)](LICENSE) ![Pi 0.87+](https://img.shields.io/badge/Pi-0.87%2B-8A2BE2) ![Node.js 22.19+](https://img.shields.io/badge/node-22.19%2B-339933)

[Install](#install) · [What you get](#what-you-get) · [Subagents](#subagents-usap) · [Claude Code](#claude-code-on-your-coding-plan) · [Performance](#performance) · [Configuration](#configuration) · [Changelog](./CHANGELOG.md)

</div>

---

Steak Pi is a package for Pi. It keeps everything that makes Pi good (the
editor, transcript, tools, history and keybindings) and adds what long,
serious sessions need: parallel subagents with hard limits, compaction that
costs no model calls, checks that run after every edit, and a status line that
tells you what the agent is doing.

Current release: **0.28.3**, for Pi 0.87 or newer (verified on Pi 1.0.4). Steak Pi also ships inside
[UltraTerm](https://paretocybernetics.com/software/).

## Install

One step on macOS and Linux:

```sh
curl -fsSL https://github.com/michael-berardi/steak-pi/releases/latest/download/install.sh | sh
```

One step on Windows (PowerShell):

```powershell
irm https://github.com/michael-berardi/steak-pi/releases/latest/download/install.ps1 | iex
```

The installer downloads the latest release archive, verifies its SHA-256 before
installing anything, and unpacks it into `~/.local/share/steak-pi/releases/<version>/package`
(on Windows `%LOCALAPPDATA%\steak-pi`), the same layout `steak-pi update` maintains.
It then runs `steak-pi install` so Pi's settings point at that folder, puts a
`steak-pi` command in `~/.local/bin` (on Windows it adds its own bin folder to your
user PATH), and finishes with `steak-pi status`.

It brings what is missing: if Node.js 22.19 or newer is not on PATH it fetches the
official Node build into the Steak Pi folder, and if the `pi` CLI is not on PATH it
installs the pinned Pi version there too and adds a `pi` shim (only when none
existed). It never uses sudo and never edits your shell profile; when the bin
directory is not on PATH it prints the one line to add. Re-run the same command to
upgrade. To remove it, run `steak-pi remove` (drops the Pi-side package), then delete
the Steak Pi folder and the `steak-pi` (and, if it added one, `pi`) shim.
Overrides: `STEAK_PI_HOME`, `STEAK_PI_BIN_DIR`, `STEAK_PI_VERSION` (pin a version),
`STEAK_PI_PI_VERSION` (Pi version to install when pi is absent).

Or install manually with the Pi CLI:

```sh
pi install git:github.com/michael-berardi/steak-pi@v0.28.3
```

Or from the release archive, without Git:

```sh
shasum -a 256 -c steak-pi-0.28.3.tgz.sha256
tar -xzf steak-pi-0.28.3.tgz
npm install --ignore-scripts --prefix "$PWD/package"
pi install "$PWD/package"
```

Requires Node.js 22.19 or newer and Pi 0.87 or newer (verified on Pi 1.0.4). Steak Pi is distributed
through this repository's tags and GitHub releases, not the npm registry.

For the leanest sessions, start Pi through the bundled launcher. It passes
every argument to `pi` and sets Node's memory and compile-cache defaults only
where you have not set them yourself:

```sh
steak-pi run          # same arguments as pi
steak-pi env          # show what it sets
steak-pi status       # installed version, selected Pi settings file and integration
steak-pi update       # install the latest release (--check only reports)
```

For release-folder installations, `steak-pi update` re-points the default `~/.pi/agent` and every UltraTerm provider-account agent directory that pins a release in the same releases folder, and retains existing releases because running sessions may still use them.

For UltraTerm-managed launches, update the supported Homebrew package with
`brew upgrade michael-berardi/pareto-software-distribution/steak-pi`.
The managed launcher adopts a newer compatible Homebrew package at the next
launch when no explicit package pin overrides it. Existing sessions keep their
loaded runtime; never overwrite their runtime trees or hand-copy managed helpers.

Local compaction also needs the [`ultracompress`](#compaction-ultracompress)
binary. Without it, Steak Pi uses Pi's built-in compaction.

## Updating

When a newer release is out, the footer shows `Steak Pi <new> available (you have <old>) · /steak-update`.
Run `/steak-update` in Pi to install it and reload, or `steak-pi update` from a shell (agents use the same
command). The check runs at most every 6 hours, in the background; `STEAK_PI_NO_UPDATE_CHECK=1` turns it off.

## What you get

| Feature | What it does |
| --- | --- |
| **Subagents (USAP)** | Up to eight parallel workers per run, with file ownership, deadlines, cancellation, a message relay between workers, and usage reported back to the parent |
| **Temporary free routes** | Switch an approved free-model preference at model-call boundaries, with a UTC expiry, zero-price request bounds and actual answering-model receipts |
| **Claude Code on your plan** | Built-in `claude-code` provider: Fable, Opus, Sonnet and Haiku through your own Claude subscription, no extra package |
| **Local compaction** | Summaries built in 10–300 ms with no model call; the full raw session stays searchable |
| **Verify after edit** | Runs your project check after edits and hands failures straight back to the agent |
| **Phased todo** | A plan pinned in the terminal, saved per session |
| **Write guard** | `write` refuses to replace an existing file the session has not read; the error says to read it first |
| **Finish guard** | A turn cannot end while todo items are open or the final reply lists unfinished work; capped, never after an abort, error or stop request, on by default |
| **Companion UI** | One status line for state, model, context pressure, cache use and cost, in your Pi theme |
| **Skill catalog lite** | Keeps large skill catalogs inside a byte budget without dropping any skill |
| **Memory conventions** | Durable project decisions in `AGENTS.md`; recall across sessions only when you ask |

Tools appear only when they can act. The subagent hub appears after your
first dispatch, compaction recall after your first compaction. The prompt
stays small until you need more.

Long pastes stay compact in the editor. Their full text and your surrounding
instructions survive queue restoration, dialogs and editor replacement,
including pastes entered while a new session is still starting.
The status band keeps context, tokens, cache use and cost visible in narrow
panes, moving them to a compact second line when needed. The header keeps a
visible gap between its steak emoji and name.

With UltraTerm, agents use the same `overseer_temporary_worker_route` MCP tool
or `ut-overseer temporary-worker-route` CLI to list, preview, activate, inspect
or clear an approved free route. Preferences are data, not package updates:
subsequent model calls pick up changes without restarting workers. Activation
requires the operator's authorization, an exact supported free model and a UTC
expiry; no paid fallback or paid plugin is permitted. One free-tier gateway is the
first adapter. See [model routing](./docs/MODEL-ROUTING.md).

## Claude Code on your coding plan

Steak Pi includes a `claude-code` provider, so your Claude Pro or Max plan works
in Pi with the same single package. Pi keeps the conversation, tools and
approvals; the official Claude Code CLI only talks to the model.

```sh
npm install -g @anthropic-ai/claude-code && claude auth login   # once
pi --model claude-code/<model>
```

Models: the CLI's own catalog (listed in [docs/CLAUDE-CODE.md](./docs/CLAUDE-CODE.md)).
`/claude-code-status` checks the login.

Billing: usage draws from your subscription limits. Anthropic has announced
that `claude -p` usage could move to a separate API-rate credit and has put that
on hold. If your account reports credit overage, the provider stops and says so
instead of spending it. API keys, proxies, Bedrock and Vertex overrides are
refused. Details in [docs/CLAUDE-CODE.md](./docs/CLAUDE-CODE.md). The provider
derives from [pi-claude-code](https://github.com/earendil-works/pi-claude-code)
by Armin Ronacher (MIT).

## Local models

Slot any GGUF into Pi as `local/<id>`: `steak-pi local add <file.gguf | owner/repo:quant>` reads the header, sizes the
context to this machine (one slot, flash attention, q8_0 KV cache, 6 GiB of RAM kept free) and writes one `local`
provider to `models.json`. Then `pi --model local/<id>`: `llama-server` starts on demand, is held only while a prompt runs, and stops after 10 minutes with no run.
It refuses, naming the cause, when memory is short, the disk is above 90% or another model server runs. No model ships
with Steak Pi; workers use `ensure`/`release`. Details: [docs/LOCAL-MODELS.md](./docs/LOCAL-MODELS.md).

## Subagents (USAP)

Running Claude Code workers accept `ultraterm_hub send` and `redirect` without
cancelling or restarting. Replies appear in the run's hub inbox. Redirects do not
change permissions, file ownership or budgets.

Claude Code workers (`harness: "claude-code"`) run at medium effort by default; high or
xhigh only when the dispatch asks with `thinking` and a `thinkingReason`. A resume keeps
the effort the run was recorded with.

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
  runs at most eight workers per provider (fourteen combined; lower per-provider
  ceilings come from your `~/.config/steak-pi/usap-caps.json`), within
  machine-wide caps shared by every session on the computer.
- **Ownership:** read-only workers have no edit tools. Writers may only touch
  their own paths, and overlapping ownership is refused before the run starts.
  Claude ownership paths with permission-rule characters such as `[slug]` are
  rejected before starting. Automatic review fallback is read-only: write,
  shell or ownership grants never move silently to another harness.
- **Reading outside the run cwd:** a read-only leaf may declare `readPaths` for
  private artifacts that must not be staged in a checkout (captures,
  screenshots, logs). Each entry must be an existing real folder below
  `~/.cache/ut-coordinator/J-NNNN/`, `~/.cache/agent-scratch/<task>/` or
  `~/.cache/ut-overseer/J-NNNN/`, and is validated at dispatch. It grants reads
  only: Claude Code adds it with `--add-dir` while its tool allowlist stays
  Read/Grep/Glob, and a Pi child may `read`, `grep`, `find` and `ls` there. See
  the [protocol](./docs/ULTRATERM-SUBAGENT-PROTOCOL.md#read-only-artifact-roots-outside-the-run-cwd-readpaths).
- **Budgets:** a 10-minute deadline by default (up to 8 hours) and 64 turns per
  worker by default. Output, relay and history are also bounded. A worker is told
  once when two requests remain, so it writes its findings and a remaining-work
  list as its final answer. A task that stops on its turn or time budget is marked
  `outcome: "partial"` (with its role, label and a retained-work summary) in the
  result, the completion receipt and the `ultraterm-usap-telemetry` record: it is
  never a finished leaf.
- **Control:** runs have stable IDs with `list`, `status`, `wait`, `send`,
  `inbox`, `cancel`, `diagnose` and `resume`. Checkpoints let you inspect and
  resume unfinished work after a restart. A resume is bounded: each task resumes
  at most once, with the same `maxTurns` and deadline (never larger), on the same
  subscription route (a changed or paid route is refused). The resumed run records
  `resumedFrom`, the original `resumedAs`, and a successful resume supersedes the
  partial attempt in telemetry. A second resume is refused.
- **Recovery:** a worker cut off by a network drop, a provider stream cut or
  stall, an overload or a rate limit resumes its own session automatically (at
  most twice, within the run deadline), so finished steps are not redone.
  A reply that Codex ends at its 15-minute limit is not resent unchanged (it
  would end the same way): Steak Pi names the failure, keeps the model and
  reasoning level, and continues once in smaller steps.

**Models.** Steak Pi is provider-neutral: it ships no model id, fallback chain,
provider preference, worker profile or paid-route grant. Your
`~/.config/ultraterm/routing.json` supplies them — the implicit worker chain
(`textWorkerChain`, `multimodalWorkerChain`), worker profiles, the expert
reviewer, quota tiers, subscription endpoints, the Claude fallback tier and the
implicit review route — and `~/.pi/agent/paid-routes.json` (version 2) carries
the reviewed paid routes and the subset you allow. With nothing configured the
tool still starts and every explicit `model`, `profile` or `harness` works; an
implicit dispatch fails with the config key to set. Paid routes spend only
while reviewed **and** allowed; deleting the entry revokes them. A gateway's
402 / insufficient credits or "no endpoints found" refusal, a provider's
usage-limit refusal, or a provider content-filter refusal (an HTTP 400 that names
`data_inspection_failed`, `content_policy_violation` or a similar code) moves an
implicit wave to the next configured tier instead of stalling. An approved, active free preference applies to implicit workers
until its expiry; explicit selections remain exact. Account-leased subscription
routes stay isolated and balanced, without copying credentials or changing the
parent environment. Image reviews never silently switch to the automatic
text-review fallback, and an implicit review pins an eligible Claude account so it
never runs on a spent login while another account can take it; a Claude quota or
auth refusal before model output moves the same review to the configured fallback
inside the same tool call. Missing credentials fail the run instead of falling back
to something that bills differently. Details: [model routing](./docs/MODEL-ROUTING.md),
[profiles](./docs/PROFILES.md).

**Claude accounts (Steak Pi 0.10.0; UltraTerm's next managed runtime):** add `claudeAccount: "primary"`
(the primary Claude account), `"b"` (the second) or any other id defined in
`~/.config/ultraterm/claude-accounts.json` to an explicit Claude subscription run. Selection
is local to that run and produces an authenticated account receipt. Unavailable
accounts fail without changing defaults or enabling credits. See the
[account-selection contract](./docs/ULTRATERM-SUBAGENT-PROTOCOL.md#task-scoped-claude-subscription-account).

**Trust boundary.** USAP coordinates work; it is not an operating-system
sandbox. Granting a worker `allowBash` gives it an unrestricted shell that can
bypass path ownership. See [SECURITY.md](./SECURITY.md) and the
[protocol](./docs/ULTRATERM-SUBAGENT-PROTOCOL.md).

## Compaction (UltraCompress)

[UltraCompress](https://github.com/michael-berardi/ultracompress) compacts
sessions locally in about 10–300 ms, with no model call and no cost. It keeps
the raw session, so anything summarized away can be recalled later
(`ultracompress_recall`, 94.4% hit@5 in its published benchmark).

```sh
git clone --branch v0.3.0 https://github.com/michael-berardi/ultracompress
cd ultracompress && cargo build --locked --release
mkdir -p ~/.local/bin && cp target/release/ultracompress ~/.local/bin/
```

Commands: `/ultracompress`, `/ultracompress-recall`, `/ultracompress-stats`.
Settings live in `~/.pi/agent/ultracompress.json`; see the
[UltraCompress docs](https://github.com/michael-berardi/ultracompress) for
thresholds and recall budgets.

Pre-compaction snapshots contain full conversation text in `.steak-pi/snaps/`
in each working directory. After a successful snapshot write, Steak Pi keeps
only the newest 10 files and removes files older than 14 days. Configure
`snapshot.maxCount` and `snapshot.maxAgeDays` in the settings file; see the
[extension settings](./extensions/ultracompress/README.md). Idle directories
are not swept. Copy snapshots elsewhere to preserve them beyond these limits.

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

## Finish guard

Agents sometimes end a turn with the work half done: items parked as
`blocked` for reasons they could have worked on, or a closing "still not done"
list. At Pi's final boundary the guard checks two things and, if either is
true, gives the agent one more model request with the open list instead of
settling:

- the todo plan has open items (a `blocked` item counts as open unless its
  reason is a real external blocker such as 2FA, a missing credential,
  payment or spend approval, or legal sign-off);
- the final reply reports unfinished work instead of doing it ("still not
  done", "next step", "haven't fixed yet", ...).

It pushes at most 3 times per message you send, and never after an abort or
an error, when you asked it to stop or hold, when you only wanted an answer,
or when nothing is open. It keeps a few values from events instead of
rescanning the session, and reads no file when a turn ends.

```json
// ~/.pi/agent/steak-pi.json (or steak-pi.json under PI_CODING_AGENT_DIR)
{ "finishGuard": { "enabled": true, "maxPushes": 3, "message": "..." } }
```

`"finishGuard": false` turns it off, as does `STEAK_PI_FINISH_GUARD=0`.
`message` replaces the opening instruction (the open list is always added) and
`maxPushes` is 0-20. Settings are read at startup and whenever a session starts
or reloads. Steak Pi's own subagent workers are exempt: Pi workers load no
extensions and Claude workers run with no user settings or hooks.

The same check ships as a Claude Code Stop hook. It reads only the tail of the
transcript (the last 512 KB, going further back only until your last message),
so with a recent last message a very large transcript costs about the same as
a small one: roughly 80 ms in total. Add it to `~/.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "steak-pi finish-guard-hook" } ] } ] } }
```

Use the absolute path to `steak-pi` if it is not on the hook's `PATH`. The hook
always exits 0, prints nothing unless it blocks, and honors the same settings.
In Claude Code the plan is the last `TodoWrite` list.

## Performance

Measured October 24, 2026 on Pi 1.0.4 (Apple silicon, macOS) with the
[overhead benchmark](./benchmarks/overhead/README.md): a scripted local model
runs identical fixtures, so these numbers show harness overhead, not model
quality. Medians of 5; all 80 synthetic fixture runs passed across stock Pi,
0.11.6 and both current launch modes. Median wall times stayed within 20% of
0.11.6.

| | Stock Pi | Steak Pi 0.11.7 | Via `steak-pi run` |
| --- | ---: | ---: | ---: |
| One-shot edit, peak memory | 130 MiB | 161 MiB | 134 MiB |
| One-shot edit, wall time | 0.22 s | 0.34 s | 0.37 s |
| Eight-worker fan-out, wall time | no subagents | 1.14 s | 1.25 s |

Steak Pi adds orchestration overhead; the launcher lowers its peak memory.
Workers share the host's Pi code instead of loading their own copy. Stock Pi
completes the eight-file fixture without subagents, so its timing is not a
parallel-worker comparison. Earlier measurements are in
[`benchmarks/`](./benchmarks/usap/README.md).

### One-shot leaves: run lean

A session that will not delegate does not need the dispatch tool or the todo tool, and their schemas and guidance
are most of what Steak Pi adds to every request. Pi's own flag leaves them out for one run:

```sh
pi -p --exclude-tools ultraterm_subagents,todo "fix the failing date test"
```

The guards, compaction, verify-after-edit and routing policy stay. When a tool is left out, the skill that explains
it is left out of the catalog too, and no route notice is added. Measured November 11, 2026 on Pi 1.0.4 with the
overhead benchmark (scripted local model, medians of 5, all 75 runs passed): the first request of a one-shot edit is
6,114 bytes on stock Pi, 23,005 bytes on Steak Pi and 7,036 bytes on Steak Pi run lean. The default is unchanged.
This measures request size, not task cost: compare cost on your own tasks before making it a habit.

### Against Claude Code

Same small Claude model at medium effort, same eight small Python tasks, five
repeats each, both harnesses on stock config (no `CLAUDE.md`, `AGENTS.md`, skills,
hooks or MCP), run order alternated, every result checked by a script. Measured
November 4, 2026 on macOS. Cost uses one rate table for both (output $0.50, cache
read $0.01, cache write $0.20 per million tokens), which reproduces Claude Code's
own reported cost to within $0.0000012 per run. Each lane warmed its prompt cache
first.

| 80 runs | Claude Code | Steak Pi | Steak Pi / Claude Code (95% CI) |
| --- | ---: | ---: | ---: |
| Correct | 40 / 40 | 40 / 40 | |
| Input tokens | 3.71 M | 1.96 M | 0.53 (0.47–0.59) |
| Output tokens | 46.4 K | 34.5 K | 0.74 (0.63–0.86) |
| Cost | $0.089 | $0.053 | 0.59 (0.50–0.70) |
| Wall time | 434 s | 482 s | 1.11 (0.97–1.26) |

The starting prompt is about half the size: 10.4 K tokens against 21.6 K. Steak
Pi was cheaper in 38 of 40 paired runs. It is not faster: multi-step tasks (a
rename across files, a debugging task) take more turns. This covers one model on
the Claude route, small tasks and one machine. Reproduce it with
[`benchmarks/ab`](./benchmarks/ab/run.py).

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `.steak-pi/config.json` → `verify.*` | off | Verify after edit (above) |
| `~/.pi/agent/ultracompress.json` | built-in | Compaction thresholds and recall budgets |
| `~/.pi/agent/steak-pi.json` → `finishGuard` | on, 3 pushes | Finish guard (above) |
| `STEAK_PI_FINISH_GUARD=0` | on | Turn the finish guard off |
| `STEAK_PI_WRITE_GUARD=off` | on | Allow `write` to replace a file the session has not read |
| `STEAK_PI_DEFER_TOOLS=off` | on | Expose every tool from the first request |
| `pi --exclude-tools ultraterm_subagents,todo` | off | Lean one-shot leaf: no dispatch or todo tool, their skills hidden (Performance, above) |
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

### Check routing.json before saving it

`steak-pi routing check [file]` validates a `routing.json` with the same parser every Pi turn uses and prints `ok`, or the key that is wrong and why. Run it on a copy before moving an edit into place: one invalid write stops every session that shares the file.

### Hold Backspace to clear the input

Holding Backspace for more than 1.5 seconds clears the entire input editor, without interrupting a running turn. To disable this default-on behavior, set `"holdDeleteClearsInput": false` in `~/.pi/agent/steak-pi.json` (or `steak-pi.json` under `PI_CODING_AGENT_DIR`); restart the session after changing it.

---

Part of [Pareto Cybernetics](https://paretocybernetics.com/projects/steak-pi/): free, private, open-source tools for working with AI agents.

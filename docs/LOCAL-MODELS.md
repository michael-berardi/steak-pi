# Local models

Steak Pi has one generic local profile: the `local` provider. You slot any OpenAI-compatible local model into it
(a GGUF served by `llama-server`) and Steak Pi works out the limits for your hardware, starts the server when a
session or a worker needs it, and stops it when nobody does. It ships no model, no repo and no default id: the model
is whatever you point `add` at. It runs on macOS and Linux. There is no LaunchAgent and no always-on service; everything lives under
`~/.pi/agent/local/` and runs only while something holds a lease.

## Quick start

```sh
brew install llama.cpp                     # or a release from https://github.com/ggml-org/llama.cpp/releases
steak-pi local add ~/models/my-model.gguf  # or: steak-pi local add owner/repo:quant
pi --model local/my-model
```

`add` prints what it chose and why, writes the model into `~/.pi/agent/models.json` (backed up first, atomic, mode
0600) and records the launch profile in `~/.pi/agent/local/profiles/<id>.json`. `local/<id>` then behaves like any
other Pi model: pick it with `--model` or `/model`.

## Commands

| Command | What it does |
|---|---|
| `local add <gguf path \| owner/repo[:quant]> [--name id] [--ctx N] [--port N] [-- args]` | Read the GGUF header, size the context, write the `local` provider entry and the launch profile. Everything after `--` is appended to the `llama-server` command line. |
| `local adapter [id]` / `local adapter off [id]` | The model's harness adapter: look for it again, or stop using it. See [Harness adapters](#harness-adapters-built-into-local-mode). |
| `local start [id]` | Start the server and keep it up until `stop` (a pinned lease). `id` is optional when only one model was added. |
| `local stop` | Stop the server Steak Pi started (only that one) and confirm the port is released. |
| `local status [id]` | Server state, number of users, idle time, and the added models. |
| `local check <id>` | Read-only: runs the disk, memory and model-file checks `ensure` runs, without starting anything or taking a lease. Prints `ok: local/<id> is running` or `ok: local/<id> fits (needs X GiB, Y GiB free)` and exits 0; a start that would be refused prints the `REFUSED` line and exits 3; an unknown id exits 1. Use it before dispatching a worker onto a local model. `ensure` and `check` share one decision function, so they cannot disagree. |
| `local hold <N>m\|h\|d [reason]` / `local hold off` | Switch the local model off until then (the running server is stopped at once); it comes back by itself. See [Holds](#holds-times-the-local-model-stays-off). |
| `local bypass <N>m\|h\|d [reason]` / `local bypass off` | Run the local model anyway for that long, although a hold or the quiet-day rule says off; both apply again afterwards. |
| `local quiet` / `quiet path <repo>` / `quiet process <name>` / `quiet remove <x>` / `quiet today [reason]` | The quiet-day rule: work the local model must not share the machine with. |
| `local tune <id> [--budget 45m] [--target decode\|prefill\|ttft\|balanced] [--allow lossless\|lossy] [--apply]` | Optional: hill-climb the model's server settings with the separate `uio` tuner. See [Tuning](#tuning-optional). |
| `local ensure <id>` / `local release <id>` | Take / give back one lease. For `routing.json` and hooks (below). |

A Hugging Face spec is read without downloading the model: only the file list and the first few MiB of the chosen
quant (the header) are fetched, with `HF_TOKEN` sent if set. The weights are downloaded by `llama-server` itself the
first time it starts, so for a big model run that once by hand (or download the file and pass its path) before
relying on the on-demand start; the health wait is bounded.

## Tuning (optional)

`steak-pi local tune <id>` hands one added model to [`uio`](https://github.com/michael-berardi/ultra-inference-optimization) (ultra-inference-optimization), a separate tool that measures the model on this machine and changes one server setting at a time, keeping only what is faster and passes its quality gates. Steak Pi adds nothing to the model and fetches nothing: it looks for `uio` in `STEAK_PI_UIO`, then on `PATH`, then `~/.local/bin/uio`. When it is not there, the command prints one line with the pinned install command (`uv tool install "git+https://github.com/michael-berardi/ultra-inference-optimization@v0.1.0"`, or `pipx install` with the same URL) and exits 2.

What Steak Pi does around the run:

- It refuses, exactly as `local check` would, while a hold or the quiet-day rule is on.
- It takes an exclusive "tuning" state. If any session or `local start` holds the server it refuses by name with the user count and changes nothing; otherwise it stops the idle server and marks `tuning.json` in the local folder. Until the run ends, `ensure` and `check` refuse with `tuning in progress (since <time>)`. The marker records the tuner's PID, so a crashed run (a dead PID) is not tuning and the next command clears it.
- It streams `uio`'s progress, then prints a before/after table (decode, prefill, TTFT, percent of the hardware ceiling) from its JSON result. Exit codes: 0 done, 2 refused (by Steak Pi or by `uio`, for example on battery), 3 the tuner failed.
- With `--apply`, `uio` rewrites the profile's `extraArgs` itself, only when every gate passed. When its result says `applied.written` is true, Steak Pi re-reads the profile, confirms its `extraArgs` equal `applied.extraArgs`, and records `uioLastTune: {at, workdir, decodeTokS}` (only when the tuned decode speed is a number; Steak DSH's `doctor` shows it). When nothing was written it prints `not applied: <reason>` and exits 0. The new settings are used from the next server start. Without `--apply`, the tested arguments are only printed.

## Harness adapters: built into local mode

Some models have a small add-on (a LoRA adapter, tens to a few hundred MB) trained to work inside this coding agent:
the same model, taught to use Pi's tools in fewer, better turns. Local mode finds and applies one by itself. There is
no flag:

```sh
steak-pi local add ~/models/base.gguf     # finds the harness adapter when one exists, asks once to trust its publisher
pi --model local/base
```

What `add` does, and prints, step by step:

1. **Works out exactly which model the file is.** From the hub repo you added it from (its "quantization of" tag, which
   the file's own name must agree with), or from the file's own name checked against the base it declares. A model
   that says it is a fine-tune, or calls itself something other than the base it declares, gets no adapter: an adapter
   only behaves as trained on the exact model it was trained on, and a fine-tune has the same shapes, so it would load
   and quietly misbehave. A file that declares nothing is not guessed from its name (another account's re-upload could
   match). An Instruct or Chat release is identified only by names that carry that word, never as the pretrained base it
   declares. A fine-tune that kept its base's exact name cannot be told apart from the base; use `--no-adapter` for one.
2. **Asks the Hugging Face index for an adapter trained for this agent on exactly that model** (the hub's own
   `base_model:adapter:<model>` link plus the `pi` tag). The most downloaded one is the candidate, and its llama.cpp
   (GGUF) file must come from the same publisher. Steak Pi names no model, adapter or publisher.
3. **Asks you once to trust the publisher.** Anyone can publish on the hub, an adapter changes how the model behaves,
   and the model's tool calls run with your permissions. So `add` shows the publisher, repo, commit and download count
   and asks `Trust adapters from "<publisher>"? [y/N]`. A yes is remembered in `~/.pi/agent/local/trusted-publishers.json`
   (empty until you answer). With no terminal to ask (scripts, workers), an untrusted publisher's adapter is named and not
   applied; the output gives the exact command, `steak-pi local adapter <id> --trust <publisher>`, which trusts that
   publisher only (or pass `--trust <publisher>` to `add`). Download counts are shown, never used as trust.
4. **Downloads it once, pinned to the commit it was found at**, into `~/.pi/agent/local/adapters/`, checks it against
   the SHA-256 the hub publishes for that commit, and matches it tensor by tensor against the model. The checksum proves
   the file is exactly what that publisher published; it says nothing about who the publisher is (that is step 3). A
   file that does not check out is discarded and the model is added without it, with the cause printed.
5. **Applies it the way it was trained.** The server loads it (`--lora-scaled <file>:1`) and its size counts toward the
   memory a start needs. When the adapter's model card (read at the pinned commit) says it was trained and measured with thinking off, the model
   starts with thinking off (the server default is off too, so every client gets it; `/thinking` in Pi turns it back on).

Nothing is bundled and nothing downloads for a model that has no adapter. Adding a model never fails because of the
adapter: with the hub unreachable the model is added plain, and the output says so.

| Command | What it does |
|---|---|
| `local adapter [id] [--trust [publisher]]` | Look again for a model added before (or after an opt-out); `--trust <publisher>` trusts that publisher only, without asking. Refuses by name when there is none, or when the adapter found now comes from a different publisher. |
| `local adapter <id> --lora <file \| owner/repo[:file]>` | Apply an adapter you choose to a model added before, for example a fine-tune of the base it was trained on (local mode never does that by itself). Same download, checksum and tensor checks; when the adapter's card says it was trained with thinking off, the model starts there. |
| `local adapter off [id]` | Stop using it from the next start. |
| `local add ... --no-adapter` | Add without looking. |
| `local add ... --lora <file \| owner/repo[:file]> [--lora-scale S]` | Use an adapter you choose instead (same checksum and tensor checks). |

`status` shows the adapter next to the model. A start whose adapter file was deleted is `REFUSED (adapter-missing)`;
`local adapter <id>` fetches it again. The `--lora-scaled FILE:SCALE` form and `--reasoning off` need a current
`llama-server` (`llama-server --help` lists both).

## How `add` sizes the context

Hardware limits come from running one model server next to a normal working session:

```
room        = total RAM - 6 GiB headroom - model file size
kv/token    = sum over layers with a KV cache of (kv heads x (key length + value length)) x 34/32     (q8_0)
fits        = room / kv/token
context     = round down to a power of two of min(fits, cap)
cap         = 32768 by default, your --ctx if given, never above the model's native context
```

- A hybrid model that keeps a KV cache on only some layers (the file's `full_attention_interval`, or a per-layer
  `head_count_kv` array) is costed layer by layer. A file that does not describe its attention is costed at a
  generous 128 KiB/token and `add` says so.
- Worked example: a 36 GiB machine and a 12.1 GB (11.3 GiB) model whose cache costs 34 KiB/token leaves 18.7 GiB, which
  would fit over 500k tokens; the default cap makes it **32768**. On a 16 GiB machine the same model is refused
  (weights plus 6 GiB of headroom do not fit), while a 7.5 GiB model with a 100 KiB/token cache shrinks to 16384.
- Below 8192 tokens `add` refuses: a coding session needs at least that. A larger `--ctx` is honoured only as far as
  it fits; `add` prints what it shrank it to.
- Fixed for every profile: one parallel slot (`-np 1`), flash attention on, `-ctk q8_0 -ctv q8_0`, `-ngl 999`,
  `--jinja`, a 2 GiB prompt cache (`--cache-ram 2048`), `--no-webui`, bound to `127.0.0.1`. Reasoning is returned
  separately by `llama-server`'s default `--reasoning-format auto`; on a build that predates it, add the flag after `--`.
- Reasoning: if the chat template mentions `reasoning_effort`, the model gets `thinkingFormat: "chat-template"` with
  `reasoning_effort` bound to Pi's thinking level, and each Pi level is mapped to the nearest effort the template names
  (ties go up). If it mentions `enable_thinking`, thinking is switched on and off. Otherwise the model is plain, with no
  reasoning controls.
- Sampling: only if the file carries `general.sampling.*` defaults are they written as `samplingParams`. Otherwise the
  server's defaults apply; add your vendor's recommended values to the entry in `models.json` yourself.

## GPU headroom: the local route's own limits

A local model is the only route that runs on this machine's own GPU, so it is the only one that can pin it. Three rules
keep it from doing so, and all three are on by default for every local profile:

| Rule | Default | What it does |
|---|---|---|
| Output cap | 4096 tokens per request | The model entry's `maxTokens`, so Pi never asks for more. A request that still asks for more is clamped to the cap; a headless run logs the clamp once, and `steak-pi local status` prints the limit. |
| Prompt cap | 75% of the server's context | A prompt over the cap is **not** truncated: the session is compacted through Pi's own compaction path and the request is refused with `REFUSED (prompt-over-cap)`, naming the size and the cap. A local route therefore compacts earlier than a remote one. |
| Duty cycle | 85% target, at most 10 s of idle | After a request finishes, the next one starts only after an idle gap derived from the previous request's duration (`duration x (1/target - 1)`), capped. The wait is shown in the status line (and the log in print mode), and the request's abort signal cancels it. |
| GPU headroom | 95% high-water, 85% low-water, 2 samples, 30 s cap | At a request start the GPU is sampled once (macOS: `ioreg -r -d 1 -w 0 -c IOAccelerator`, unprivileged, about 0.01 s; no `powermetrics`, which needs root). At or above 95% the start waits until utilisation has been at or below 85% for two samples, at most 30 s, after which it proceeds and says so. Any other platform, a probe error or an unparsable answer means *unknown*: the check does nothing and says why once per session. |

The wait happens in the session, never inside the lease lock, so `release` and `local stop` are never blocked by it. The
GPU is sampled at a request start and while a start is waiting, never per token.

Override any of it in the profile file (`~/.pi/agent/local/profiles/<id>.json`); every key is validated, and a typo is a
named refusal (`bad-limit`), not a silent no-op:

```json
{ "id": "my-model", "ctx": 32768, "port": 8089,
  "limits": {
    "maxOutputTokens": 2048,
    "promptCapRatio": 0.5,
    "duty": { "target": 0.7, "maxGapMs": 20000 },
    "headroom": { "highWater": 90, "lowWater": 70, "confirmSamples": 3, "maxDeferMs": 10000 }
  },
  "server": { "slots": 1, "specDraftMax": 2, "batchSize": 512, "ubatchSize": 128 } }
```

`"duty": "off"` and `"headroom": "off"` turn a rule off. `maxGapMs` may be raised to 30 minutes for a machine that is
meant to stay mostly idle; a duty target of 0.10 with a matching cap is what it takes to keep the GPU below 95% for
most of a long run of large requests.

Server settings that change GPU load are defaults the profile can override, and a value the profile sets explicitly is
never replaced:

| Setting | Default | Why |
|---|---|---|
| `-np` (parallel slots) | 1 | The server serialises requests anyway; a second slot only adds GPU work. |
| `--spec-draft-n-max` | 2, only when the profile turns speculative decoding on and sets no depth | Measured draft acceptance is 52% in the window the GPU report sampled and 61% averaged over the server log's 2,142 requests, so a good share of five drafts per step is GPU work thrown away. |
| `--batch-size` / `--ubatch-size` | 512 / 128 (`server.batchSize`, `server.ubatchSize`) | A pause between requests cannot shorten a GPU submission; a smaller batch can, because the driver gets the GPU back between submissions. llama.cpp's own defaults are 2048 and 512, and one 2048-token prefill submission is 4-6 s of uninterrupted GPU time at the measured prompt-eval rate. **Unverified live**: it needs a server restart and the responsiveness measurement has not been run for batch sizes. |

A flag the profile already passes itself (`-b`, `--batch-size`, `-ub`, `--ubatch-size`, `--spec-draft-n-max`) is never
emitted twice, and `server.ubatchSize` must not exceed `server.batchSize`.

## A small context window gets a small fixed prompt

Request size is the lever, not the gap between requests. Pacing removes a request for a while; it does not make one
cheaper, and a 105 s request still occupies the GPU for 105 s. What actually removes the load is sending less: a smaller
fixed prompt, earlier compaction, a smaller batch. The one recorded session that pinned the GPU on this machine shows the
shape — 65,536-token route, 875 entries, **153 compactions**, every ordinary turn sending **48,321 prompt tokens**
(p50; p90 51,724, max 54,644), of which the server had cached 21,017 and re-evaluated the rest, at 2-3 ms per
re-evaluated token. Its fixed prompt was **130,358 characters of sections** (skills catalog 77,508, project instructions
37,659, memory pack 6,544, rules 6,128, docs 1,700, tool list 779, preamble 169, cwd 51), plus Pi's own tool schemas.

`extensions/prompt-budget` holds the fixed prompt of a route whose declared context window is below a threshold to a
share of that window. It decides from the route's context size only — no model name, no provider — so a 200k or 1M route
is left byte-identical (this hook returns nothing, so Pi keeps the prompt it built).

| Setting | Default | Meaning |
|---|---|---|
| `STEAK_PI_PROMPT_BUDGET` | on | `off` (also `0`, `false`, `no`) leaves every fixed prompt alone. |
| `STEAK_PI_PROMPT_BUDGET_BELOW_TOKENS` | 100000 | Only a route declared below this many tokens is budgeted. |
| `STEAK_PI_PROMPT_BUDGET_SHARE` | 0.25 | The share of that window the fixed prompt may occupy. |
| `STEAK_PI_PROMPT_BUDGET_SKILLS_BYTES` | 8192 | Byte budget for the skills index form (the same form `skill-catalog-lite` renders). |
| `STEAK_PI_PROMPT_BUDGET_MEMORY_BYTES` | 4096 | Byte budget the memory pack is reduced to when it has to give ground. |

A refused value is a named `REFUSED (bad-prompt-budget)` line naming the key (`prompt-budget.share must be a number
greater than 0 and at most 1`), reported once; the default runs and the report says which. The shrink order is fixed:

1. the skills catalog to its index form, and, if that is not enough, to **names plus the instruction to read the
   `SKILL.md`** at the listed location;
2. the documentation block dropped (a small-context route does not need Pi's own docs index in its window);
3. the memory pack at a smaller budget, halved until the prompt fits, and the pack says in the prompt that it was cut and
   from how many bytes;
4. **project instructions (`AGENTS.md` and siblings) are never truncated.** They carry the operator's rules. If they
   alone exceed the budget they stay whole and the overage is reported once, with the numbers, in the status line and
   the log.

For the recorded session this brings the fixed prompt from 32,677 estimated tokens (49.9% of the window) to 15,322
(23.4%), by the skills tier alone; the per-turn estimate with the same kept conversation falls from 49,127 to 31,772
tokens. It does not halve a turn, and cannot: the project instructions are 9,415 tokens of the 16,384-token budget and
are kept whole, and the kept conversation (16,450 tokens) is not a fixed-prompt section. A share of about 0.12, or a
shorter `AGENTS.md`, is what would take a turn under half; neither is something this code should decide for the operator.

### Prompt order, and what a local server can reuse

`llama-server` reuses its prompt cache only for an **identical prefix**. In the recorded session the reusable prefix was
exactly the fixed prompt: `cacheRead` was 20,451 tokens on the first fourteen turns (while the prompt grew from 27,765 to
48,233) and 21,017 on the ordinary turns after that, so 20,504 tokens p50 (p90 32,736, max 51,635) were re-evaluated
every turn, and 31 turns — the first request and the turns right after a compaction — found nothing cached at all and
re-evaluated 43,000-52,000 tokens. Two of Steak Pi's own blocks change between turns and used to sit at the **end of the
fixed prompt, in front of the whole conversation**: the route-availability line (refreshed at most once a minute, and it
carries clock times) and the active todo plan's guidance. The local route now moves those blocks — and only those, and
only for a local model — to the end of the request, after the conversation, so everything stable comes first and
everything that changes per turn comes last (`src/prompt-order.ts`). A request without one of them is returned
untouched, so no hosted route sees a difference. This cannot recover the conversation prefix the server never kept:
that boundary sits at the first replayed message, is server-side, and no prompt ordering inside Steak Pi moves it. It
does mean the fixed prompt — now much smaller — is what a per-turn change can no longer invalidate.

### Compaction cadence

Auto-compaction is Pi's, driven by the prompt cap and the context usage; this change does not add a threshold. What it
changes is when the cap is reached. With the recorded shape — about 65,800 characters (16,450 tokens) of kept
conversation after a compaction, a prompt cap of 49,152 tokens (75% of 65,536) and roughly 2,000-4,000 new tokens per
turn — the fixed prompt used to consume 32,677 of the 49,152 tokens and the kept conversation another 16,450, which is
the cap already: the next turn crosses it, so compaction fired at the first opportunity, "one compaction every 3
entries" (one turn is an assistant entry plus its tool results). With the fixed prompt at 15,322 the same session starts
17,380 tokens under the cap, which is four to nine turns of headroom, and only the compaction itself is followed by a
full prompt re-evaluation. No small-context compaction setting was changed: the fixed prompt was the cause, and the
arithmetic above is the evidence.

## Constraints and refusals

`start`, `ensure` and a session hook refuse with one line, `steak-pi local: REFUSED (<cause>): <detail>`, exit code 2,
and nothing is left running or leased:

| Cause | When |
|---|---|
| `on-hold` | a timed hold is in force (`local hold`); the message says when it ends |
| `quiet-day` | the quiet-day rule fired today; the message says what fired it. The local model returns the next day |
| `bad-hold` | `hold.json` cannot be read; a broken rule file holds the model off instead of switching the rule off |
| `llama-server-missing` | not on `PATH` (and `STEAK_PI_LLAMA_SERVER` is not set); the message carries the install hint |
| `model-missing` | the GGUF file is gone |
| `disk-full` | the disk is above 90% used |
| `other-server` | another local model server (llama-server, llama-cli, ollama, vllm, sglang, lms) is running; one model server at a time |
| `other-model-running` | Steak Pi's server for another model has users; an idle one is replaced instead |
| `port-busy` | the port is held by a process Steak Pi did not start |
| `insufficient-memory` | free plus reclaimable RAM is below weights + KV cache at the profile's context + about 3 GiB of server overhead (a 12 GB model at 32768 needs about 15 GiB) |
| `health-timeout` / `server-exited` | the server never reported healthy within 180 s, or stopped while loading (the log tail is included) |
| `unknown-model` | no such id; the message lists the added ones |
| `bad-limit` / `bad-server` | the profile's `limits` or `server` block has a bad or unknown key; the message names it |
| `prompt-over-cap` | a request's prompt is over the local route's prompt cap: the session is compacted and the request is held |

Memory is checked at `add` against total RAM and again at every start against what is free right now.

## Holds: times the local model stays off

A local model takes most of the GPU and a large share of memory. Two rules keep it away from work that needs the
machine. Both are yours: Steak Pi ships no program name, repository or schedule.

```sh
steak-pi local hold 24h rendering this week   # off for 24 hours, then back on by itself
steak-pi local hold 1h --replace short job    # a shorter hold never shortens a longer one in force, unless --replace
steak-pi local hold off                       # end a timed hold early

steak-pi local quiet path ~/dev/my-heavy-project   # a repository
steak-pi local quiet process HeavyApp               # a program, by the name the process list shows
steak-pi local quiet                               # show the rule and whether it holds right now
steak-pi local quiet today playtest                # off for the rest of today, by hand
steak-pi local quiet remove HeavyApp

steak-pi local bypass 2h run the test I asked for    # run anyway for 2 hours, although a hold or a quiet day says off
steak-pi local bypass off                            # end the bypass early
```

**A timed hold** refuses every start until it ends and stops a running server when it is set.

**A bypass** is the operator's explicit "run it anyway" for a set time (at most 7 days): while it lasts, neither the
timed hold nor the quiet-day rule refuses a start or stops a running server. Both stay recorded and apply again the
moment it ends (by itself, or with `bypass off`). `status` shows what is bypassed and until when. It is never set by
anything but the command.

**The quiet-day rule** watches for work you listed. The first sign of it on a calendar day switches the local model
off for the rest of that local day: a listed program running, or a commit, checkout, merge, reset or rebase in a
listed repository or one of its linked worktrees. Work is read from git's own `HEAD` and `ORIG_HEAD` (their
modification times) and from the time of the last entry in the reflog `logs/HEAD` (not the file's modification time:
`git gc` and `git reflog expire` rewrite that file with no work done, verified on git 2.54). No other file contents are read,
and `git status` and `git fetch` do not count. A listed path may be an ordinary clone, a linked worktree or a
submodule, whose `.git` is a file: the git folder is found from its `gitdir:` line (and `commondir`). `quiet path`
refuses a repository whose HEAD cannot be found, and `status` warns when a listed one later becomes unreadable. The
day is remembered, so the model stays off after the program is closed, and the next day starts clean. Editing files
without committing is not seen; use `quiet today` then. Programs are looked for only when something asks (`status`,
`check`, `ensure`, or the 30-second look of a running server), so a program opened and closed in between is not seen;
a process list that cannot be read (`ps` failed) is reported in `status`, not taken as "no programs".

`check` starts nothing and takes no lease, but it is not strictly read-only: the first time the quiet rule fires on a
day, whichever command sees it first records that day in `hold.json`. The write is made under the same lock as every
other edit; if another command holds the lock, the next look records it.

While a hold is in force:

- `start`, `ensure`, `check` and a session on a `local/...` model refuse with `on-hold` or `quiet-day` and the reason;
- a server that is already running is stopped within 30 seconds, whoever holds a lease;
- a USAP worker profile whose `ensure` runs `steak-pi local ensure` is refused before launch, so an implicit wave
  moves to the next step of its chain. Nothing needs to be taken out of `routing.json`.

**Work already running on the local model is not rerouted.** The hold stops the server under it, its request in
flight ends with a connection error, and the model's partial output is not moved to another route (the fall-through is
for a launch that produced no output yet, so nothing is repeated). A worker that fails this way is resumed by the
coordinator as a network drop; the resume runs its `ensure` hook again, which is refused with `on-hold` or
`quiet-day`, so the worker ends failed with that named cause, and moving the task to another route is then a new
dispatch. A Pi session on a `local/...` model sees the connection error, and its next prompt is refused with the
hold's cause.

The rules live in `~/.pi/agent/local/hold.json`. A file that cannot be read holds the model off (`bad-hold`) and names
the fault: invalid JSON, a wrong type, an unknown key (a typo such as `untill` is not silently ignored) or an
unreadable file or folder. `hold off` (and any other command that edits the rules) on an unreadable file first renames it
to `hold.json.bad-<timestamp>`, says so, and starts a clean file, so the rest of the rule can be copied back.

## Lifecycle: leases and idle stop

`ensure` takes one reference for its holder and starts the server if none runs; `release` gives one back. A holder is a
Pi process (a session, or the workers it launches) or the pinned `manual` holder that `start` uses. Leases are
refcounted per holder and a holder whose process died is dropped, so a crashed session cannot keep the server up. When
the last reference is gone a small supervisor process waits the grace period (10 minutes) and then stops the
`llama-server` it started, confirms the port is released and exits. A new lease inside the grace period cancels the stop.
`local stop` stops it at once, whoever still holds a lease. A lease that lands on a server already stopping for idle
waits for that stop to finish and starts a fresh server, instead of failing with `server-exited`.

State lives in `~/.pi/agent/local/`: `profiles/`, `leases.json`, `server.json` (PIDs, port, start times: only what
is recorded there is ever stopped), `server.log`, `hold.json` (the hold rules above). Environment: `STEAK_PI_LOCAL_GRACE_S` (idle grace, default 600),
`STEAK_PI_LOCAL_HEALTH_TIMEOUT_S` (default 180), `STEAK_PI_LLAMA_SERVER` (path to the binary).

## In a Pi session

The package loads a small extension. A session holds the server only while a run is active: it takes a lease when a
prompt starts on a `local/...` model (the prompt waits for the server, reloading the weights if it stopped while idle)
and gives it back when Pi settles, meaning nothing more will run on its own. A manual `/compact` holds it the same way
for the summary. A pane left open at its prompt holds
nothing, so the idle grace starts as soon as the last run anywhere has settled; an unused model never stays loaded,
whatever happens to the session afterwards (a model change that fires no event, a pane left open for hours). When a
session starts on a local model or switches to one, the server is warmed in the background and its lease is returned
at once, so the first prompt inside the grace period does not wait. A refusal is shown with its named cause and tried
again on the next prompt. Sessions on any other model never touch it. USAP workers do not load extensions; they use
`ensure`/`release`, below.

## For USAP workers

Make a worker profile whose `ensure` runs the same commands (see [model routing](./MODEL-ROUTING.md#profile-launch-hooks-ensure)).
Use a longer `timeoutMs` than a cold model load takes, and an absolute path if `steak-pi` is not on the `PATH` Pi runs with:

```json
{ "workerProfiles": [
  { "id": "steak-pi/local-a", "model": "local/my-model", "thinking": "low",
    "ensure": { "command": ["steak-pi", "local", "ensure", "my-model"],
                "release": ["steak-pi", "local", "release", "my-model"], "timeoutMs": 240000 } }
] }
```

The workers of one Pi process share its lease holder, so a session and its workers keep one server up together. Whether a
local route may serve a kind of task is your decision, from your own evidence: put it in a task class chain like any other
route (see [model routing](./MODEL-ROUTING.md)).

## Slot in a different model

Run `steak-pi local add` again with the other file or spec. Both stay under the one `local` provider; only one server
runs at a time, and switching models mid-session warms the new one (an idle server for the old model is replaced). To change one model's settings, `add` it again with `--ctx`, `--port` or `-- <llama-server args>`
(for example a speculative-decoding flag your build supports), or edit its entry in `models.json` (Pi's side: sampling,
thinking map, token limit) and its profile under `~/.pi/agent/local/profiles/` (the server side).

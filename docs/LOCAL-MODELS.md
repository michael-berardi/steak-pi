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
| `local start [id]` | Start the server and keep it up until `stop` (a pinned lease). `id` is optional when only one model was added. |
| `local stop` | Stop the server Steak Pi started (only that one) and confirm the port is released. |
| `local status [id]` | Server state, number of users, idle time, and the added models. |
| `local check <id>` | Read-only: runs the disk, memory and model-file checks `ensure` runs, without starting anything or taking a lease. Prints `ok: local/<id> is running` or `ok: local/<id> fits (needs X GiB, Y GiB free)` and exits 0; a start that would be refused prints the `REFUSED` line and exits 3; an unknown id exits 1. Use it before dispatching a worker onto a local model. `ensure` and `check` share one decision function, so they cannot disagree. |
| `local ensure <id>` / `local release <id>` | Take / give back one lease. For `routing.json` and hooks (below). |

A Hugging Face spec is read without downloading the model: only the file list and the first few MiB of the chosen
quant (the header) are fetched, with `HF_TOKEN` sent if set. The weights are downloaded by `llama-server` itself the
first time it starts, so for a big model run that once by hand (or download the file and pass its path) before
relying on the on-demand start; the health wait is bounded.

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
| Output cap | 4096 tokens per request | The model entry's `maxTokens`, so Pi never asks for more. A request that still asks for more is clamped to the cap and the clamp is reported once, never silently. |
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

## Constraints and refusals

`start`, `ensure` and a session hook refuse with one line, `steak-pi local: REFUSED (<cause>): <detail>`, exit code 2,
and nothing is left running or leased:

| Cause | When |
|---|---|
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

## Lifecycle: leases and idle stop

`ensure` takes one reference for its holder and starts the server if none runs; `release` gives one back. A holder is a
Pi process (a session, or the workers it launches) or the pinned `manual` holder that `start` uses. Leases are
refcounted per holder and a holder whose process died is dropped, so a crashed session cannot keep the server up. When
the last reference is gone a small supervisor process waits the grace period (10 minutes) and then stops the
`llama-server` it started, confirms the port is released and exits. A new lease inside the grace period cancels the stop.
`local stop` stops it at once, whoever still holds a lease.

State lives in `~/.pi/agent/local/`: `profiles/`, `leases.json`, `server.json` (PIDs, port, start times: only what
is recorded there is ever stopped), `server.log`. Environment: `STEAK_PI_LOCAL_GRACE_S` (idle grace, default 600),
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

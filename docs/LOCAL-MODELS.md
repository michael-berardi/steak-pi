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

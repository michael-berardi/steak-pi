# Session reference

[Install and first use](../README.md) · [Installation details](INSTALL.md)

## Subagents (USAP)

| Feature | What it does |
| --- | --- |
| **Subagents (USAP)** | Up to eight parallel workers per run, with file ownership, deadlines, cancellation, a message relay between workers, and usage reported back to the parent |

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
  the [protocol](./ULTRATERM-SUBAGENT-PROTOCOL.md#read-only-artifact-roots-outside-the-run-cwd-readpaths).
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
to something that bills differently. Details: [model routing](./MODEL-ROUTING.md),
[profiles](./PROFILES.md).

**Claude accounts (Steak Pi 0.10.0; UltraTerm's next managed runtime):** add `claudeAccount: "primary"`
(the primary Claude account), `"b"` (the second) or any other id defined in
`~/.config/ultraterm/claude-accounts.json` to an explicit Claude subscription run. Selection
is local to that run and produces an authenticated account receipt. Unavailable
accounts fail without changing defaults or enabling credits. See the
[account-selection contract](./ULTRATERM-SUBAGENT-PROTOCOL.md#task-scoped-claude-subscription-account).

**Trust boundary.** USAP coordinates work; it is not an operating-system
sandbox. Granting a worker `allowBash` gives it an unrestricted shell that can
bypass path ownership. See [SECURITY.md](../SECURITY.md) and the
[protocol](./ULTRATERM-SUBAGENT-PROTOCOL.md).

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
so it avoids loading the entire transcript at once. Add it to `~/.claude/settings.json`:

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "steak-pi finish-guard-hook" } ] } ] } }
```

Use the absolute path to `steak-pi` if it is not on the hook's `PATH`. The hook
always exits 0, prints nothing unless it blocks, and honors the same settings.
In Claude Code the plan is the last `TodoWrite` list.

## Configuration

| Setting | Default | Effect |
| --- | --- | --- |
| `.steak-pi/config.json` → `verify.*` | off | Verify after edit (see above) |
| `~/.pi/agent/ultracompress.json` | built-in | Compaction thresholds and recall budgets |
| `~/.pi/agent/steak-pi.json` → `finishGuard` | on, 3 pushes | Finish guard (see above) |
| `STEAK_PI_FINISH_GUARD=0` | on | Turn the finish guard off |
| `STEAK_PI_WRITE_GUARD=off` | on | Allow `write` to replace a file the session has not read |
| `STEAK_PI_WORK_RULES=off` | on | Leave the working rules out of the system prompt (`STEAK_PI_WORK_RULES_TEXT` replaces them) |
| `STEAK_PI_WORK_RULES_BRIEF=0\|1` | follows the light shape | Short-reasoning line: on while a one-shot run is light, off once tools load; `1` forces it on (`run --lean` sets it), `0` keeps it out |
| `STEAK_PI_DEFER_TOOLS=off` | on | Expose every tool from the first request (also turns the light one-shot start off) |
| `pi --exclude-tools ultraterm_subagents,todo` | off | Fixed loadout: no dispatch or todo tool, no loader, their skills hidden (see One package, no modes below) |
| `STEAK_PI_WORKER_SDK=unbundled` | host bundle | Workers load their own Pi SDK copy |
| `STEAK_PI_SKILL_CATALOG_LITE=off` | on | Keep Pi's stock skill catalog |
| `STEAK_PI_SKILL_CATALOG_BYTES` | `8192` | Byte budget for the skill catalog |

Enable **Quiet startup** in `/settings` to keep routine inventories out of the
workspace. Themes **steak**, **steak-oled** and **steak-light** are included,
and any Pi theme works. With no theme chosen Steak Pi starts with **steak**
(the Steak DSH palette); a `theme` setting, `--use-theme` or
`STEAK_PI_THEME=off` keeps your own. The UI contract is in
[docs/COMPANION-UI.md](./COMPANION-UI.md).

Anything that widens what the agent can reach stays opt-in:

| Add-on | Install |
| --- | --- |
| Plan mode | `pi install npm:pi-plan-mode` |
| Web access | `pi install npm:pi-web-access` |
| Language-server diagnostics | `pi install npm:@narumitw/pi-lsp` |

### One package, no modes

There is no flag to choose and no second variant. How a session is used decides what it starts with, and the work
decides when it grows:

- **Interactive and hosted sessions** (the terminal UI, `--mode rpc`) send every tool from the first request, exactly
  as 0.28.5 did.
- **One-shot runs** (`pi -p`, `--mode json`) start light: no dispatch, hub or todo tool and none of their guidance,
  plus a short-reasoning line in the working rules, and one very small tool, `load_tools` (about 200 bytes of schema).
- **The dispatch and todo tools load once, for the rest of the session,** when any of these happens: the prompt asks
  for delegation, parallel work or task tracking (subagents, "in parallel", "fan out", a todo list); the run reaches
  its tenth tool call; the model calls `load_tools`; or the session already holds a todo plan or checkpointed
  dispatch runs. After that the tool list does not change again (the hub still appears after the first dispatch, as
  before). Pi sends a tool's guidelines only in the system prompt it built before the run started, so when the tools
  arrive mid-run their guidelines arrive in the tool result that carried them; a prompt that asks for them loads them
  before the first request, where the guidance sits in its usual place. The short-reasoning line goes with the light
  shape when the prompt loads the tools; a run that loads them mid-run keeps the line it started with.
- **Your choice wins.** `--tools`, `--no-tools` or `--exclude-tools` on the command line disable the adaptive loadout,
  and `STEAK_PI_DEFER_TOOLS=off` restores every tool from the first request.
- **`steak-pi run --lean`** is still accepted. It passes `--exclude-tools ultraterm_subagents,ultraterm_hub,todo` and
  sets the short-reasoning line, so the run stays light and cannot load the tools. It is no longer needed: a plain
  one-shot run now costs what a lean run costs.

The guards, compaction, verify-after-edit and routing policy are the same in every shape. When a tool is left out, the
skill that explains it is left out of the catalog too, and no route notice is added.

### Check routing.json before saving it

`steak-pi routing check [file]` validates a `routing.json` with the same parser every Pi turn uses and prints `ok`, or the key that is wrong and why. Run it on a copy before moving an edit into place: one invalid write stops every session that shares the file.

`steak-pi routes rank | record | verdict | report` gives a job queue outside Pi the same task-class ranking and evidence store a USAP dispatch uses, so it can pick the harness and route per job from recorded outcomes (see [Choosing the harness per job](MODEL-ROUTING.md#choosing-the-harness-per-job)).

### Hold Backspace to clear the input

Holding Backspace for more than 1.5 seconds clears the entire input editor, without interrupting a running turn. To disable this default-on behavior, set `"holdDeleteClearsInput": false` in `~/.pi/agent/steak-pi.json` (or `steak-pi.json` under `PI_CODING_AGENT_DIR`); restart the session after changing it.


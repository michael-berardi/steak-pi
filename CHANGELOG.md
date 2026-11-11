# Changelog

## Unreleased

- **One-step installers.** The GitHub release now offers `install.sh` (macOS and Linux) and `install.ps1` (Windows), plus the package archive and `SHA256SUMS`. One command downloads the release, checks its SHA-256 before installing, unpacks it into the release-folder layout `steak-pi update` maintains, points Pi at it, adds the `steak-pi` command, and finishes with `steak-pi status`. It uses the Node 22.19+ and `pi` already on the machine, or fetches the official Node and installs the pinned Pi into the Steak Pi folder when they are missing (a `pi` shim is added only when none existed). Re-running upgrades in place. No sudo, no shell-profile edits.
- `scripts/build-release.sh` builds the release assets deterministically and also emits a version-less `steak-pi.tgz` and `SHA256SUMS`, so `releases/latest/download` works without knowing the version. The existing versioned archive and `.sha256` names are kept.
- Installer tests (`test/install-cli.test.ts`) cover both branches (Pi present, Pi absent), upgrade, idempotence, version pinning, checksum refusal and missing prerequisites, each in a throwaway HOME.

## 0.27.3 (2026-11-11)

- **`steak-pi update` never points Pi at a release it cannot load.** A release folder that already existed was used as is, so a copy of 0.27.2 with its source but an empty `node_modules` became the release Pi loads, and every Pi launch then failed with "Cannot find module @earendil-works/pi-coding-agent". Before Pi settings change, the update now checks that every package the extensions import is installed in that release. Missing ones are installed from the release's own lockfile; if they are still missing, the update stops with the cause and Pi keeps loading the release it had.

## 0.27.2 (2026-11-11)

- **A long Claude conversation no longer fails with "history replay exceeded its wait limit" on a busy machine.** When a Claude Code process is replaced, the whole conversation is replayed into the new one. The wait limit covered the entire replay, so a long session on a loaded machine ran out of time while every message was still being accepted. Each replayed message now has its own limit: a replay that keeps moving finishes, and one that stops is still ended, with the error naming which message was not acknowledged.

## 0.27.1 (2026-11-11)

Fixes from an independent review of 0.27.0, all on the new steak-dsh harness.

- **The sandbox write grant stays narrow.** An owned path outside the run directory is granted only as that directory or the immediate parent of an owned file. A grant that would be the home directory, a directory above it, or one close to the filesystem root is refused by name, and so is a path whose parent does not exist yet. 0.27.0 walked up to the nearest existing directory, which could be the home directory.
- **Ordinary text is no longer read as a quota refusal.** A report that mentions "rate limit", or a line number 402 or 429, could move a wave to the next tier and run it again. Quota is now recognised only from the harness's error events and error output, with HTTP context required for bare numbers.
- **A project that may not use Claude cannot reach it through this harness**, and `claudeAccount` is refused on it by name.
- **A model the harness cannot run is skipped before it is ranked** (unsupported API, no base URL, credentials in the URL, no context window), so a class chain moves on instead of failing the wave.
- **Workers are always stopped.** A leftover process in the worker's group is killed after its leader exits, a worker whose identity could not be read is still signalled, and no worker outlives the host process. A timeout is reported as a timeout even when the dying worker printed an error.
- Docs: `readPaths` need no grant on this harness, and its `--add-dir` grants write access.

## 0.27.0 (2026-11-11)

- **Steak DSH is a third USAP harness.** A leaf can run on the DSH headless CLI with the Steak DSH bundle: dispatch with `harness: "steak-dsh"` and `model: "<provider>/<model-id>"`, or with the exact route `steak-dsh/<provider>/<model-id>`. The inner model must be one Pi already knows and passes the same checks as the native route (retired patterns, paid-route approval, plan-only projects, quota), plus two of its own: an API-key login (OAuth-only logins are refused by name) and an installed `steak-dsh`. Nothing falls back.
- **The evidence router can choose the harness.** A `taskClasses` chain or `textWorkerChain` entry may be `steak-dsh/<provider>/<model-id>`. It is ranked beside the native route on the same recorded outcomes, and the winner sets the run's harness. `steak-pi routing check` validates these entries. Add one only after measuring it on your own tasks: no route is added by default.
- **Ownership, effort and accounting on that harness.** `ownedPaths` become `--owned-path` rules, read-only leaves run read-only, and the shell is off unless `allowBash`. The effort follows the model's own thinking-level map. The key travels only in the child environment. Usage is summed from the harness's own events and priced from the model's cost table. Hub send, redirect and resume are refused by name on this harness.

## 0.26.0 (2026-11-11)

- **One model choice that follows your worker chain in interactive slots (opt-in).** Add `interactiveChainModel` to `routing.json` and pick that model in `/model`: each request goes to the first available step of your worker chain, and a quota, plan-limit or content-filter refusal moves to the next step before any output, the same way workers do. The footer shows which model answered, and cost stays attributed to that model. Without the key nothing changes. Setup: docs/MODEL-ROUTING.md.

## 0.25.7 (2026-11-11)

- **A reload no longer breaks running subagents.** After `/reload`, the reloaded session takes over its own live USAP runs and their checkpoint store, instead of showing "USAP checkpoints memory-only: already owned by a live host in this process". With no runs in flight the store is released cleanly.
- **`/steak-update` never interrupts a response.** The reload waits until the agent is idle; if a new response starts first, it runs at the next idle instead of being dropped.
- **Content-filter refusals continue on the next route.** In an implicit wave, a provider's content-filter refusal (HTTP 400 `data_inspection_failed`) moves the worker to the next configured route even after it has produced output, with its transcript intact. Explicit routes still never reroute; the error now names the filter and says how to rerun elsewhere.
- **Spent quota sent as HTTP 429 is treated as quota.** A body with `insufficient_quota` or "Allocated quota exceeded" moves to the next tier instead of being retried as a rate limit.

## 0.25.6 (2026-11-11)

- **A `readPaths` reviewer can read the operator spelling of a symlinked private root.** The grant records the
  physical path, but the Claude CLI compares requested paths against `--add-dir` entries without resolving symlinks,
  so on a machine where `~/.cache/ut-coordinator` links to `ut-overseer` a reviewer told to read the coordinator
  spelling was refused even with the grant. Every operator spelling of the physical root is now passed as `--add-dir`
  too (and listed in the prompt), each re-resolved at launch and dropped unless it still equals the recorded physical
  root. Found by the live image-read acceptance on the installed build; covered by new regression tests.

## 0.25.5 (2026-11-11)

- **A resumed run keeps its `readPaths` grant even when `$HOME` is a symlink.** Dispatch records the physical
  artifact path, and resume passes that recorded path back through validation; the check compared it only against the
  operator's own spelling of the private home, so a home reached through a symlink refused a grant that had already
  been approved (fails closed, but it breaks the resume). Both spellings are accepted, and a test covers a symlinked
  home with a resumed physical path.

## 0.25.4 (2026-11-11)

- **The footer keeps its stats inside the pane, and a flat-plan route shows plan usage instead of `$0.000`.**
  - The status band leaves its last pane column blank. Stats that ended exactly at the pane edge could be clipped
    there, so the cost (`$0.00…`) was cut off in narrow and half-width panes.
  - On a flat-plan route, the cost atom reads `plan N req` (the session's request count) instead of `$0.000`.
    The route is classified from the operator's `subscriptionRouteChecks` (non-OAuth endpoints only), with no
    provider names in code. Metered routes keep the dollar figure.

## 0.25.3 (2026-11-11)

- **A provider content-filter refusal moves the turn to the next route instead of failing the worker.** A
  provider's input inspection can refuse ordinary engineering text before any output: an HTTP 400 whose error code
  or type names content inspection (`data_inspection_failed`, `content_policy_violation`, `content_filter` and
  similar). Matching is by that response shape only, never by provider name. Before output:
  - an automatic chain hop moves to the next authenticated route, with the same replayed request, and the same
    classed task re-runs on the next ranked route;
  - an implicit wave whose workers were all refused this way re-runs the same tasks on the next configured tier;
  - the receipt names the refusal (`content-filter`, `(content-filter refusal)` on the hop).
  After output began, the refusal is never resent: the run fails with its named cause. A content-filter refusal
  judges the input rather than the route, so it never demotes the route. A bare 400 (bad request, context length,
  invalid body) still never hops.

## 0.25.2 (2026-11-11)

- **An implicit review runs on a Claude account it can actually launch, and a pre-output refusal reaches its
  configured fallback.** The per-turn route line could say the Claude subscription tier was up while every
  dispatch was refused by the CLI with "quota limit reached". The tier verdict is whole-account-set: one eligible
  account made it read "up", but an implicit all-reviewer wave pinned no account, so it ran on the parent's own
  Claude login, which was the spent one. Three things change:
  - the implicit review route asks the router and **pins an eligible account**, exactly like the implicit worker
    tier, and records it as an automatic pick (`selection.accountAutomatic`) rather than an operator choice;
  - a parent login the router proves spent, with no account left to pin, is proven Claude unavailability for a
    read-only review, so that wave goes to `implicitReview.fallback` before anything launches;
  - a Claude review worker refused on a recognized quota or auth failure **before model output** now re-runs the
    same review tasks on `implicitReview.fallback` inside the same call, with a fresh router read at refusal time
    instead of the dispatch-time snapshot. The refused run stays failed with its own cause, the receipt and the
    result name both routes, and when the fallback cannot launch either, the failure names both causes. Privileged
    and image reviews keep their exact Claude route, and the failure says why the fallback never applies to them.
- **An unpinned explicit `claude-code` route is refused on the login it would use.** A route that names no
  `claudeAccount` runs on this session's own login, so that account is what the router must prove launchable:
  the refusal names that login and the router's own cause for it, and points at pinning an eligible account. The
  per-turn route line also names a spent session login beside an otherwise-up tier, so an unpinned route is never
  a surprise.
- **"quota limit reached" is a recognized quota cause.** It is the Claude Code CLI adapter's own pre-output
  wording, and it matched no usage-limit pattern, so such a refusal was never classified as a quota failure.

## 0.25.1 (2026-11-11)

- **`readPaths` hardening after the completion review.** The new read-only artifact grant is tightened where the
  review found slack: an `agent-scratch` task home (`~/.cache/agent-scratch/<task>`) is refused exactly like a job
  home, so a grant always names a folder inside a home; a `~user` form is refused by name instead of being resolved
  against the process cwd; each grant is re-checked at every launch, so a queued leaf whose folder was replaced by a
  symlink is refused instead of handing the CLI a different directory; an explicit Claude API run refuses
  `readPaths` at dispatch (the route's argv forbids `--add-dir`) rather than at launch; and a Pi child resolves a
  relative path against the run cwd, not the process cwd. Tests cover each one, plus the guarded Pi tools exposing
  no write, edit or shell to a leaf that carries a grant.

## 0.25.0 (2026-11-11)

- **A read-only reviewer can finally read the captures it was asked to review.** Claude Code workers run with
  `--restricted`, which confines file tools to the run cwd, so an image reviewer whose evidence lived in a job's
  private cache could not open it at all; the only reachable place was inside the project checkout, which USAP job
  briefs forbid. `ownedPaths` could not help because dispatch refuses paths outside cwd. A read-only task now takes
  `readPaths`: an explicit list of artifact folders it may read, validated at dispatch before the wave is
  checkpointed or any worker exists. Each entry must be an existing real directory strictly below a private agent
  home (`~/.cache/ut-coordinator/J-NNNN/<folder>`, `~/.cache/agent-scratch/<task>/<folder>`,
  `~/.cache/ut-overseer/J-NNNN/<folder>`); the cache root, a job home itself, any other location, a file, a `..`
  segment, a control character or a symlink is refused with a named field error. The grant is read-only on both
  harnesses: Claude Code adds each path with `--add-dir` while the tool allowlist stays `Read,Grep,Glob` under
  `--permission-mode dontAsk` (no write tool, no write rule), and a Pi child may `read`, `grep`, `find` and `ls`
  inside a declared root, re-checking the filesystem on every call. `mayEdit` and `readPaths` never combine, and the
  explicit Claude API route refuses `readPaths` because its argv forbids `--add-dir`. Resumed runs keep the grant
  they were dispatched with.

## 0.24.1 (2026-11-10)

- **A Claude Code worker that has to wait no longer kills itself.** Two USAP workers waiting on a deploy window and a
  cron firing scheduled a background wake-up and ended their turn; the CLI woke them after their final result, which the
  runner correctly refuses ("emitted model output after its final result"), so both runs failed. Workers now run with the
  CLI's background tasks turned off, and the worker prompt says to wait in the foreground with a bounded loop.

## 0.24.0 (2026-11-10)

- **The local route keeps GPU headroom instead of pinning the machine.** A local model is the only route that runs on
  this machine's own GPU, and one session driving it back-to-back pinned it at 98% for tens of seconds at a time. The
  local route now enforces its own limits, all on by default and all overridable from the profile file's `limits` block
  (validated: a bad or unknown key is a named `bad-limit` refusal, never a silent no-op):
  - an **output cap** of 4096 tokens per request (the model entry's `maxTokens`; a request that still asks for more is
    clamped and the clamp is reported once);
  - a **prompt cap** of 75% of the server's context. An over-cap prompt is never truncated: the session is compacted
    through Pi's own compaction path and the request is refused with `REFUSED (prompt-over-cap)`, so a local route
    compacts earlier than a remote one;
  - **duty-cycle pacing**: after a request finishes, the next one starts only after an idle gap derived from the
    previous request's duration and an 85% target, capped at 10 s. The wait is shown in the status line (and the log in
    print mode), the request's abort signal cancels it, and it never holds the lease lock, so `release` and
    `local stop` are never blocked by it;
  - a **GPU headroom check** at each request start: one unprivileged `ioreg` sample (about 0.01 s, no `powermetrics`,
    which needs root). At or above 95% the start waits until utilisation has been at or below 85% for two samples, at
    most 30 s, after which it proceeds and says so. Any other platform, a probe error or an unparsable answer means
    unknown: the check does nothing and says why once per session. The decision is a pure function, unit-tested without
    a GPU.
- **A small-context route is no longer handed a fixed prompt that eats its window.** Request size is what removes GPU
  load: pacing only stops sending for a while, and a request that is 50,000 prompt tokens long is the same 105 s of GPU
  whatever the gap before it. On one recorded 65,536-token local session the fixed prompt was **130,358 characters of
  sections** (skills 77,508, project instructions 37,659, memory 6,544, rules 6,128, docs 1,700) and every ordinary turn
  sent **48,321 prompt tokens** (p50), compacting **153 times in 875 entries**. A new extension holds the fixed prompt of
  any route declared below 100,000 tokens to 25% of its window, shrinking in one stated order: the skills catalog to its
  index form and then to names plus the instruction to read the skill file, the docs block away, the memory pack to a
  smaller budget. **Project instructions are never truncated**: if they alone exceed the budget they stay whole and the
  overage is reported once with the numbers. Thresholds and share are operator settings (`STEAK_PI_PROMPT_BUDGET_*`) and
  a bad value is a named `bad-prompt-budget` refusal. A 200k or 1M route gets a byte-identical prompt: the decision is
  the route's declared context size, never a model name. For the recorded session the fixed prompt falls from 32,677
  estimated tokens (49.9% of the window) to 15,322 (23.4%) and the per-turn estimate from 49,127 to 31,772 tokens; it
  does not halve a turn, because the project instructions (9,415 tokens, kept whole) plus the kept conversation are
  already more than half of it, and the docs section says so with the arithmetic.
- **The local route keeps per-turn blocks out of its reusable prefix.** `llama-server` reuses its prompt cache only for an
  identical prefix, and the recorded session's cache hit was exactly the fixed prompt: 20,504 tokens p50 (p90 32,736)
  were re-evaluated every ordinary turn, with 31 turns (the first request and the turns right after a compaction)
  finding nothing cached and re-evaluating 43,000-52,000 tokens. Steak Pi's two per-turn blocks — the route-availability
  line and the active todo plan's guidance — were appended to the end of the fixed prompt, in front of the whole
  conversation; for a local model they now go into the last user message, after the conversation, so stable content
  comes first and per-turn content comes last. They are not sent as a trailing system message: the local model's chat
  template refuses any system message that is not the first. A request without them is returned untouched, so no other
  route changes.
- **Server launch defaults that change GPU load are reviewed, and only where there is evidence.** One parallel slot
  stays (`-np 1`: the server serialises requests anyway), and `--spec-draft-n-max 2` is now the default when a profile
  turns speculative decoding on without choosing a depth itself (measured draft acceptance is 52% in the window the GPU
  report sampled and 61% averaged over the server log's 2,142 requests, so a good share of five drafts per step is GPU
  work thrown away). `--batch-size 512` / `--ubatch-size 128` are now defaults
  (`server.batchSize` / `server.ubatchSize`): a pause between requests cannot shorten one GPU submission, but a smaller
  batch bounds it, and llama.cpp's own 2048-token logical batch is 4-6 s of uninterrupted GPU time per submission at the
  measured prompt-eval rate. That one is **unverified live**: it needs a server restart and the responsiveness
  measurement for batch sizes has not been run. A flag the profile passes itself is never emitted twice. A value a profile sets
  explicitly is never replaced, and a bad `server` key is a named `bad-server` refusal.
- **A simulation of the recorded GPU trace is part of the test suite.** The utilisation series measured on the affected
  machine is a fixture; the tests replay it with back-to-back 105 s requests and report the share of samples at or above
  95% before and after. With the shipped defaults that share falls from 91% to 84% (the 10 s gap cap binds); reaching
  10% needs a duty target near 0.10 with a matching `maxGapMs`, which the same simulation shows. Live confirmation needs
  the release installed and a re-measurement.
## 0.23.21 (2026-11-10)

- **An implicit Claude wave is no longer refused on an account the router selected.** The router's `select` answer
  carries no `eligible` field, and the guard required one, so a wave that the router had just picked (for example a
  lent plan at its best weekly pace) was refused with "the router did not report it eligible" while `status` showed it
  eligible. An `ok: true` answer for exactly the requested account is now the router's eligibility verdict. The guard
  still refuses an explicit non-true `eligible` (a malformed value fails closed), an account reported queued or
  reserved, and every other check (launch environment, config folder, label).
- **`ownedPaths` may sit on a TrimReaper overflow mirror.** When the reaper moves a folder below home to its declared
  `offload.root` and leaves a symlink, a task may own that symlink: the target is accepted only inside the root's
  `home/<same path below home>` mirror. Any other escaping symlink, including another overflow folder or the mirror of
  a different relative path, is still refused. With no declared root, or an unreadable config, nothing is accepted.

## 0.23.20 (2026-11-09)

- **Fable 5.2 replaces Fable 5.1 in the Claude Code model catalog.** The catalog row and the `fable` alias now name
  Fable 5.2, registered with its 1M context window, so selecting it no longer prints "Model not found for provider
  claude-code. Using custom model id".
- **A registered profile's model can no longer be refused by USAP.** A `claude-code/<model>` route is admitted from
  three sources instead of a list fixed at release time: the pinned routes, the Claude Code model catalog (the shipped
  rows plus every id the CLI reports live) and any operator worker or launch profile that names it. A new Claude model
  therefore dispatches without a Steak Pi release. A route none of the three serves is refused naming all three.
- **A worker cut off by "Connection error." resumes its session.** The provider SDK's plain connection error was not
  classed as a network drop, so a brief outage failed every running worker at once instead of resuming them after a
  short wait (up to two resumes, as for other network drops).

## 0.23.19 (2026-11-08)

- **A slow account router no longer ends a Claude session.** The per-request owner-reserve check killed
  `ut-provider-accounts status` after 10 s, which a loaded machine could exceed (router lock wait plus its CLI probes),
  and the turn died with "account router status failed: Command failed". The safety net is now 20 s
  (`ULTRATERM_ACCOUNT_ROUTER_TIMEOUT_MS`, 1000..60000), the read-only status call is retried once after 500 ms, and the
  error names the cause (timed out / signal / exit code, plus stderr). `ingest` and `select` are never retried.
- **A router refusal is never read as "no reserve".** A status answer of `{ok:false}` (for example a busy state lock)
  used to look like an unmanaged account and let a reserved account pass unchecked; it is now retried and then fails
  closed with the router's own cause.

## 0.23.18 (2026-11-08)

- **A mid-run hop obeys the project policy.** The pre-output fallback hop of a chain worker used the shared automatic
  paid-route grant, so a planOnly project's worker that failed on a plan route before its first output could hop onto
  the paid OpenRouter step. The dispatch's resolved policy now travels into every hop: a planOnly run never hops onto a
  paid route and a noClaude run never hops onto a Claude route.
- **A steer queued after the agent's last turn is not delivered twice.** The lost-steer reclaim at `agent_settled`
  skips a completion steered after `agent_end`: the host exposes no view of the agent's queue, and such a steer is
  still queued and starts the next run. The reclaim still re-sends a steer sent during a run that never landed.
- Tested, not changed: a session moved to another Claude account leaves the refused config folder (explicit
  `CLAUDE_CONFIG_DIR` / `PI_CLAUDE_CODE_CONFIG_DIR` `undefined` overrides reach the launch environment).

## 0.23.17 (2026-11-08)

- **A parent can no longer aim at a dead route.** The implicit route now applies the operator's coordinator policy
  (`noClaudeProjects`, `planOnlyProjects` in `~/.ultraterm/coordinator/policy.json`, matched on the folder names of the
  working directory, its repository or worktree's main checkout, and the paths a task owns; no project names are built
  in; an unreadable policy file restricts both, a missing one restricts nothing). It walks only steps that are allowed
  and available: a noClaude project never reaches a Claude tier or the Claude review route, a planOnly project is never
  given a paid route, and with nothing left the call refuses once naming each skipped step and when it returns.
- **Every turn carries the route availability.** A compact line, refreshed from the account router at most every 60 s,
  marks each chain step and the Claude tier `up`, `COOLING until <time>`, `HELD BACK` or `NOT ALLOWED (project policy)`,
  names the next usable route and tells the parent to omit model/profile/harness and never pin anything not `up`. The
  ultraterm-subagent-protocol skill says the same.
- **The implicit Claude tier never picks an account the router would refuse.** The pick walks the router-eligible
  accounts best first and keeps the first one `select --provider claude` accepts now, so an account listed eligible
  that `select` refuses (reserve floor, stale snapshot) is skipped instead of failing the wave with "would not select
  it now". 2026-11-08: two scout dispatches pinned to cooling routes were refused before launch, and an implicit wave
  failed on a Claude account whose status was ineligible while two others were eligible.

## 0.23.16 (2026-11-08)

- **A background run's completion is no longer lost when the host drops its queued steer.** A completion sent while the
  parent was busy waited for a receipt that never came if the operator interrupted or submitted first (Escape, a cleared
  queue, an aborted tool call), so it was never delivered and the bar showed "USAP delivery unconfirmed". At the next
  boundary where the steer must have landed or been dropped (the agent settling, a session adopting the runtime), a completion with no receipt is sent again, once, and may wake the parent; receipts
  already observed still prevent duplicates. 2026-11-08: run-f40a1335 finished during a `sleep` the operator's next
  message aborted.

## 0.23.15 (2026-11-08)

- **A session no longer stalls on a lent Claude plan's reserve.** When the router refuses the session's Claude account
  (the owner's floor reached, or no current usage reading to check it), the request moves to the next Claude account the
  router selects (`select --exclude`), prints one line naming the cause and the new account, and carries on; the choice
  holds for the rest of the session. The session stops only when no Claude account is eligible, and the error then names
  every cause. 2026-11-08: eight interactive sessions stopped at the floor of the lent plan while both own plans had room.

## 0.23.14 (2026-11-08)

- **The finish guard catches an ending that announces the rest of the work.** A reply ending "**Next:** I'll add …",
  "One gap I'm fixing now", "still needs a test and the build" or "I haven't published it yet" ended the turn before the
  work was done. These now count as unfinished work, so the agent is pushed to keep going.

## 0.23.13 (2026-11-08)

- **`steak-pi routing check [file]`.** Validates a `routing.json` with the exact parser every Pi turn uses, and names the
  bad key. A write that fails it would stop every pane on its next turn (2026-11-08: task-class notes past 400 characters).

## 0.23.12 (2026-11-07)

- **Holding Backspace clears the input again.** A held Backspace that arrives as a batch of DEL bytes, or as key
  presses without repeat flags (UltraTerm's terminal sends these), never added up to a hold, so it deleted one
  character at a time. Both now count, and after 1.5 s the whole input clears. Taps still delete one character.
- **A lent Claude plan with spare allowance runs first.** When the account router marks a Claude account
  `spill.draining` (UltraTerm router 1.0.31), the Claude fallback tier pins workers on it before the least-used one.

## 0.23.11 (2026-11-06)

A local model server can no longer outlive its supervisor.

- **The server dies with its supervisor.** llama-server now runs under a tiny `sh` watchdog that checks every 2 s that
  its parent is still the supervisor (`ps` ppid, which also defeats PID reuse) and stops the server when it is not, so a
  SIGKILLed or crashed supervisor no longer leaves the model loaded (observed 2026-11-06: supervisor 77086 gone, server
  77105 reparented to launchd and running for 50+ minutes). macOS has no `PR_SET_PDEATHSIG`; polling is the portable answer.
- **Existing orphans heal themselves.** `status`, `check`, `ensure`/`start`, `release` and the extension's lease paths find a
  recorded server whose supervisor is dead (matched on PID and start time, never anything else). Idle past the grace it is
  stopped, the port confirmed free and `server.json` cleared; with holders, or inside the grace, a new supervisor adopts it
  and takes over idle-stopping.
- **`steak-pi local status` says `orphaned (supervisor gone)`** instead of `healthy`, and reports what it did about it.

## 0.23.10 (2026-11-06)

Fixes every finding of the Opus check of 0.23.9.

- **Replacing an idle or orphaned local server works again (regression).** Preflight ran while the server being replaced
  still held the shared port (8089) and its memory, so switching local models, or recovering an orphan, was refused with
  `port-busy` / `insufficient-memory`. Preflight now ignores the replaced server's own port and counts its weights as free,
  and runs again after the stop. A refused start still never stops the idle server.
- **A refused local start covers every run, and is bound to its model.** The ensure-and-abort decision moved to
  `agent_start`, so triggered turns (`sendMessage` with `triggerTurn`) and retries are covered. The refusal applies only
  while the model it was made for is selected, and only this hook's own abort (`stopReason: aborted`) is rewritten.
  `session_before_compact` cancels the compaction when the server cannot start.
- **A profile id names a Claude subscription route only as `<short>` or `steak-pi/<short>`.** Ids under any other prefix
  no longer become that route. `claudeAccount` with a profile stays refused unless it is `steak-pi/<short>`.
- **Agent state:** the state file records the writer's start time, so a reused PID no longer silences the real agent;
  ownership is rechecked on the heartbeat; the ancestor walk is capped at 3 s; stale temp files of dead writers are swept.
- **`steak-pi local check`:** a malformed id exits 1 (usage), and a server that is up but not healthy is said so.
- **An explicit Claude subscription route is refused when the router proves Claude exhausted**, like a native route.
- **A usage limit on a route outside every `providerQuotaFallback` tier** (for example `xiaomi`) now names that config key
  in the dispatch error instead of failing silently. Adding the provider to `providerQuotaFallback` (`metered: false`) is
  operator configuration and is not changed here.
- Stale comments about image waves and "both pinned routes" corrected.

## 0.23.9 (2026-11-06)

- **A local model that cannot start now stops the run with its cause.** When the hook could not start a `local/...` model
  (for example `starting swift-1-5 needs about 16.4 GiB ... but only 14.2 GiB is free or reclaimable`) it only notified,
  and the prompt went to the dead endpoint: `Connection error.` five times, then `! error · Connection error.`. The run
  is now aborted before any request and ends with `steak-pi local: REFUSED (<code>): <reason>` as its error, on screen and
  in the session history. The next prompt tries the start again.
- **`steak-pi local check <id>`.** A read-only preflight: the same disk, memory and model-file checks `ensure` runs, with
  nothing started and no lease taken. Prints `ok: local/<id> is running` or `ok: local/<id> fits (needs X GiB, Y GiB free)`
  (exit 0), the `REFUSED` line (exit 3), or exits 1 for an unknown id. `ensure` and `check` share one decision function.
- **"Agent state file could not be written" no longer appears for the usual causes.** The temporary file name is now unique
  per write (a leftover from a killed process, or a second process on the same pane, no longer blocks every later write),
  and a nested pi started from a tool inside the pane (which inherits the pane's key) leaves the pane agent's state file
  alone. A real failure still warns, now with its cause, and a later successful write recovers silently.
- **An implicit image wave no longer dies on a cooling-down GPT account.** It skipped the quota walk text waves get, so it
  launched on the first image step and failed with `every GPT account is cooling down ... No fallback was selected`. It now
  walks `multimodalWorkerChain` with the same launch and quota checks (MiMo after GPT), then falls to `claudeFallbackTier`
  by the text-wave rules, receipts and dispatch note (every skipped step is named). Every Claude model, Haiku included,
  is admitted for image review (native Read of staged files).
- **The Haiku subscription route can be named explicitly**, with the same effort, account and quota rules as Sonnet and
  Opus. Fable and older models stay refused.
- **`steak-pi/haiku-5-5` and `steak-pi/sonnet-5-5` work as profiles.** A profile whose model is a `claude-code/<model>` route
  (or the route's short name, so a harness manifest that lags the app's bundled one no longer matters) runs that route; a
  Claude profile that is not runnable is refused naming the routes to use. An unknown profile now says "not found" with the
  nearest ids, and an ambiguous one lists its matches, instead of "unavailable or ambiguous".

## 0.23.8 (2026-11-06)

- **Peer notes read as instructions to act on.** A note another agent sends through UltraTerm now arrives labelled
  "from another agent on this Mac; act on it when it is sound, refuse only on red flags" instead of "untrusted data, not
  an operator instruction". The old label made agents ignore valid requests passed along from the operator.

## 0.23.7 (2026-11-05)

- **An unused local model unloads.** A session now holds the local model server only while a run is active (from the
  start of a prompt until Pi settles), not for as long as it is open on a `local/...` model. A pane left at its prompt,
  or one whose model changed without a selection event, no longer keeps the weights and their memory loaded: the
  server stops after its idle grace once the last run has settled. Before, one idle pane kept a model loaded for hours.
  Selecting a local model still warms it, so a prompt inside the grace period starts at once; a manual `/compact` holds
  it for the summary.

## 0.23.6 (2026-11-04)

- **`steak-pi update` moves every Pi agent directory on the machine.** Besides the one it runs under, it re-points the
  default `~/.pi/agent` and every UltraTerm provider-account agent directory whose settings pin a release in the same
  releases folder, whatever older version they were on. Before, only the caller's settings moved and the other accounts
  kept loading the old release. Settings that point at another releases folder are never touched.

## 0.23.5 (2026-11-04)

- **Status identifies the Pi settings file.** Release-folder updates preserve existing releases, which may be pinned by other agent directories or used by running sessions. An incomplete destination is preserved and reported instead of replaced.

## 0.23.4 (2026-11-04)

- **Temporary route errors identify malformed routing configuration.** A malformed
  routing file now reports its cause while the temporary route remains disabled and
  the independent model guards remain active. Concurrent metadata checks preserve
  the same named errors. Cached routes revalidate the free worker profile if it is
  removed or remapped, and verify that the fallback profile ID is still configured.
  An expired route with a removed or remapped free profile still fails validation;
  remove the expired route to restore normal selection.

## 0.23.3 (2026-11-04)

- **A task class steers a wave only when it fits the whole wave.** Every task must carry the class; otherwise the
  wave runs the normal worker chain and the dispatch note names the tasks and why. Before, one classed task sent a
  four-task implementation wave onto the class's single-slot local route.
- **New task class fields in routing.json:** `slots` (most tasks the class's routes take at once; a wider wave skips the
  class) and `maxScope: "small"` (a wave with a task that may both edit and run a shell skips the class).

## 0.23.2 (2026-11-04)

- **Temporary free routes fail closed when exclusions are missing.** Set
  `temporaryFreeExclusions` in routing configuration before selecting a free route;
  malformed configuration also stops selection instead of silently allowing it.
  Existing temporary routes require this setting after upgrading; normal model
  protections remain active if a temporary route cannot be loaded.

## 0.23.1 (2026-11-04)

- **`write` no longer replaces a file the session never read.** In a same-model test against Claude Code, an agent
  probed `notes.txt` with `cat -A` (not valid on macOS), took the error for "missing" and overwrote the file: 5 of 11
  runs. A `write` to an existing path that was not read, edited or created in the session is now refused with an error
  that names the fix, and a short rule in the system prompt says a failed command is not proof a file is missing.
  After the change: 30 of 30 correct. `STEAK_PI_WRITE_GUARD=off` switches it off.
- **README: same-model comparison with Claude Code** and a reproducible runner in `benchmarks/ab`.

## 0.23.0 (2026-11-04)

- **Steak Pi reports its own state to UltraTerm.** In an UltraTerm pane, Steak Pi writes a small state file
  (`$ULTRATERM_HOME/agent-state/<tmux session>.json`, mode 0600): working, idle, waiting on subagents or a long shell,
  asking, or an error, plus whether the input box is empty. UltraTerm's rail and job queue read it instead of guessing from
  the screen, so a redraw or a notice under the input box can no longer be mistaken for activity or unsent text. The file
  refreshes every 10 seconds and is removed on exit. Nothing is written outside UltraTerm panes or inside subagents.

## 0.22.4 (2026-11-04)

- **`steak-pi update --check` reports the release Pi actually loads.** A Homebrew CLI older than the release folder made a
  finished update still read as "available".
- **A parent that runs a long serial stretch is reminded once to fan out.** After 40 tool calls in a row without a subagent
  dispatch, the parent gets one short note to send any independent part to `ultraterm_subagents` in one background wave.
  Set `STEAK_PI_DELEGATION_NUDGE=off` to switch it off.

## 0.22.3 (2026-11-04)

- **An update keeps every release a running session may still load.** Each release records when it was replaced; an update
  removes an old release only once every Pi session that could have started on it has ended. Before, a long-running
  session lost its release to a later update and every subagent dispatch from it failed with "Cannot find module".

## 0.22.2 (2026-11-03)

- **The usage dial of a lent Claude account stays current.** Each turn's reading now carries the CLI session id, so the router
  refreshes the snapshot the dial reads, not only its own copy.

## 0.22.1 (2026-11-03)

- **Updating no longer deletes the release running sessions load.** The rollback kept is the release Pi was loading, not the
  CLI's own version. A Homebrew CLI older than the release folder had deleted the live release, and every running session then
  failed to start a Claude worker ("the staged runtime ... was replaced").
- **Workers run the builds, linters and test suites their task asks for.** Focused checks stay the default, but a task,
  constraint or contract that requires a full suite now wins. A repository without an AGENTS.md is no longer a reason to stop.
- **A rate-limited (429) route is held out of evidence routing at once,** instead of after three failures in a row.

## 0.22.0 (2026-11-03)

- **A lent Claude account's owner reserve now holds for every request, not only at launch.** When a session or a USAP Claude
  worker runs on an account the UltraTerm account router reserves (for example "keep the last 20% of the five-hour window"),
  each request asks the router first and stops with a named, non-retried error once the reserve is reached. Each turn's
  official usage reading is fed back to the router, so the next check sees it. Before, a long session or a long headless
  reviewer that started under the floor ran the account into its limit. Without the router both checks are inert.

## 0.21.0 (2026-11-03)

- **Task classes can be assigned automatically.** An optional `taskClassRules` list in routing.json gives an implicit text
  worker task that names no `taskClass` the class of the first matching rule (`when`: `role`, `mayEdit`, `allowBash`,
  `textPattern`). Explicit classes, models and profiles always win; one wave keeps one inferred class and other tasks ride its
  route. Rules name only configured classes (a typo is a named configuration error). Steak Pi ships no rule.

## 0.20.3 (2026-11-02)

- **Homebrew installation status is reported correctly** when Pi stores its package path relative to the agent directory.

## 0.20.2 (2026-11-02)

- **Completed workers exit promptly.** Provider connections are closed when their session ends, without interrupting a reload or other sessions.

## 0.20.1 (2026-11-02)

- **`local ensure` waits for the server.** An unreferenced sleep timer let the CLI exit mid-wait with code 0, so `ensure`
  reported success before `/health` answered and `stop` left its lock behind. The CLI now stays alive until it is done.
- **A lock left by a process that died is taken over at once** (it records its owner), instead of blocking every local
  command for two minutes.
- **Closing a session no longer stops the server on the spot.** The supervisor is started outside the session's process
  tree, so the server keeps its idle grace for the next user.
- **One SIGTERM per server.** A second SIGTERM made llama.cpp abort mid-shutdown; `stop` lets the supervisor send it and
  only follows up with SIGKILL.
- **A failed start is retried before the next prompt**, instead of every prompt failing until `/reload`.

## 0.20.0 (2026-11-02)

- **A built-in local-model module: one generic `local` profile you slot any model into.** `steak-pi local add
  <gguf path | owner/repo[:quant]> [--name id] [--ctx N] [--port N] [-- extra llama-server args]` reads the GGUF header
  (architecture, native context, attention shape, chat template; a small reader, no new dependency, and for a Hugging
  Face spec only the file list and the first few MiB of the chosen quant) and writes ONE `local` provider plus that model into
  `~/.pi/agent/models.json` (timestamped backup first, five kept; atomic; mode 0600; other providers untouched) and a
  launch profile under `~/.pi/agent/local/`. It prints exactly what it chose and why. The context is sized from the
  machine: `total RAM - 6 GiB headroom - weights`, divided by the q8_0 KV cost per token from the metadata (hybrid and
  per-layer attention costed layer by layer), capped at 32768 unless `--ctx` asks for more, never above the model's
  native context, rounded down to a power of two; a model the machine cannot hold, or less than 8192 tokens, is refused.
  One slot, flash attention, q8_0 KV cache, a 2 GiB prompt cache. When the chat template supports `reasoning_effort` or
  `enable_thinking`, the model gets a chat-template reasoning map; otherwise it is plain. Sampling comes only from the
  file's own `general.sampling.*`.
- **On-demand server.** `local start|stop|status [id]` run `llama-server` (from `PATH`, or `STEAK_PI_LLAMA_SERVER`, else a
  named error with the install hint) in the background, owned by Steak Pi (PID, start time and port recorded; only that
  is ever stopped), with refcounted leases under `~/.pi/agent/local/` and an idle auto-stop after a grace (default 10
  minutes) once the last user lets go. A start is refused with a named cause when another local model server runs, the
  port is taken, free plus reclaimable RAM cannot hold weights + KV cache + server overhead, the disk is above 90%, or the
  model file is gone; it waits for `/health` (bounded) and stops a server that never came up. `stop` confirms the port
  is released. No LaunchAgent and no always-on service.
- **`local ensure <id>` / `local release <id>`**: argv commands for `routing.json` `workerProfiles[].ensure`, so slots and
  USAP workers bring the server up on demand and let it go. Holders are Pi processes; a holder that died is dropped.
- **Pi extension hook.** The package's `extensions/local` takes a lease when a session starts on a `local/...` model or the
  model is switched to one (the first prompt waits for the server), and gives it back on a switch away or at session end.
  Other models are untouched; USAP workers do not load it.
- Docs: README "Local models" and `docs/LOCAL-MODELS.md` (sizing math, constraints, refusals, how to slot in another model).
- Tests: hardware sizing (36 GiB with a 12 GB model gives 32768; a 16 GiB machine refuses or shrinks), the GGUF reader on
  synthetic files, the `models.json` writer (backup, atomic, preserving other providers), lease refcounts and idle stop with
  a fake clock and server, every refusal, the extension hook, real-process start/share/stop against a stand-in server that
  only answers `/health`, and neutrality (no model name, repo or file name in the shipped module).

## 0.19.0 (2026-11-02)

- **Task classes: route a kind of task to the route that measured best for it.** `routing.json` gains an optional
  `taskClasses` object, `{ "<class>": { "chain": [...], "requiresTestGate"?, "note"? } }`. A class is a lowercase
  slug the operator chooses; Steak Pi ships none. A chain step is a worker profile id or an exact `provider/model`
  route. The `ultraterm_subagents` task schema gains an optional `taskClass`. For an implicit text worker wave whose
  class is configured, the dispatch walks the class chain first, with the same launch, quota, paid-route and
  `onlyWhen` checks as `textWorkerChain` (`routeConditions` apply to class steps too), and then falls back to the
  normal route. An unconfigured class is ignored with a note in the dispatch summary, never an error; explicit
  `model`, `profile`, `harness` and `claudeAccount` selections stay exact, and reviewer and image waves are not
  steered. One run uses one route: two configured classes in one wave are refused, and tasks without the class ride
  the wave's route (the note names them). The receipt `run.selection.taskClass` and the dispatch note name the class,
  the serving step and why each earlier step was not chosen. `requiresTestGate` is recorded and surfaced (dispatch
  note, receipt, and a line in an editing worker's prompt asking for its focused check's outcome); the parent still
  runs the gate.
- **Profile launch hook: `workerProfiles[].ensure`.** A profile may declare
  `ensure: { command: [argv...], release?: [argv...], timeoutMs? }`, for a route that needs something running first
  (an on-demand local model server). Before each worker on the profile launches USAP runs `command` (no shell, the
  environment passed through, bounded by `timeoutMs`, default 120 s, at most 600 s). A non-zero exit, a timeout or a
  program that cannot start refuses the launch with its stderr as the named cause; an implicit wave then falls
  through to the next step of the walk inside the same call, and an explicit profile fails with that cause. In a
  `finally` after the worker ends, however it ends, `release` runs (bounded by 30 s, never cancelled by the abort,
  its failure recorded as `task.profileEnsure`, not as a failed worker). Pi and claude-code workers get the hook
  alike; it is resolved only from the operator's routing.json by the profile id the run recorded, never from a
  manifest, task or checkpoint, and it also applies on a bounded resume. Launches of one profile are serialized
  within a session so a start-if-absent command never races itself.
- **Evidence-driven, self-improving, self-healing class routing.** Inside a class chain the steps that pass every
  launch check are now ranked on recorded evidence by expected cost per correct result,
  `(E[cost] + timeWeight x E[seconds]) / p(pass)`, with `p(pass)` a Beta posterior over the route's passes and fails
  seeded by the operator's `taskClasses.<class>.priors` (`{ pass, n, costUsd, seconds }` per chain entry). The pick is
  a Thompson draw, plus a configurable `explore` share (default 0.1) that deliberately picks a weaker route so its
  estimate keeps current; `timeWeight` (seconds to dollars) and a `minPassRate` floor are per class. With neither
  priors nor evidence the configured chain order serves, and no route, model or number is built in. New per-class keys
  `timeWeight`, `minPassRate`, `explore`, `demoteAfter`, `window`, `cooldownMinutes`, `retryMaxTokens`, `priors`, all
  validated with the key named.
- **Route evidence store.** `~/.pi/agent/usap/route-evidence.jsonl` (override `STEAK_PI_ROUTE_EVIDENCE`), append-only,
  rotated at about 5 MB to one `.1` generation. One record per settled task of a classed wave: class, route, outcome
  (`pass`/`fail`/`unknown`), its source (verification verdict, reported `TEST-GATE: pass|fail` line, the operator, or the
  worker's final state), wall seconds, dollars from the run's usage cost, tokens, and a failure kind (`empty-output`,
  `reasoning-exhausted`, `tool-error`, `http-4xx`, `http-5xx`, `quota`, `other`). A later verdict is a new line applied
  to the same run and task. The `ultraterm_hub` action `record-outcome` writes one; a store that cannot be written
  never fails a dispatch.
- **Self-healing.** A route is demoted for a class after `demoteAfter` consecutive failures, when its rolling pass rate
  falls under the floor, or at once on spent credits; it is skipped with the cause named, re-probed once after
  `cooldownMinutes` and promoted by a pass. A reply that is empty or out of output tokens (`stopReason length` is now
  reported as such) is retried once on the same route with a higher output budget, then runs on the next ranked route;
  a 402, insufficient credits or 5xx moves to the next ranked route at once with the cause recorded. A class run's
  runtime hop now follows the class's ranked chain (only routes the class names) instead of the default chain.
- **Debuggable.** The receipt `run.selection.taskClass.decision` and the dispatch note carry the winner, each route's
  `p(pass)`, expected cost and seconds, evidence counts, whether the pick explored, and the routes held out with their
  causes. `ultraterm_hub` `action: "routes"` (read-only) prints the per-class estimates from the store.
- Config validation names the key: class names, chain steps (a profile id or `provider/model`, no duplicates, at most
  16), unknown keys in a class or hook (a misspelled `requiresTestGate` is an error, not a silently dropped gate), and
  an argv that is a shell string, empty, or starts with a relative path.
- Tests: schema validation, class-first then fallback, unknown class, ensure success and refusal with fall-through,
  release on success, failure, throw and abort, and neutrality (no built-in class, chain, hook, route, model or prior).
  Evidence routing: the ranking flips when the evidence flips, exploration at the configured share with a seeded random
  source, the floor, demotion after K failures, re-probe then promotion, the empty-reply retry, 402 failover, store
  rotation, receipts that carry the estimates, and the hub routes view.
## 0.18.11 (2026-11-02)

- **One Claude login check at a time.** Every model and provider probe at startup ran its own `claude auth status`,
  about 50 at once on each Pi start (a multi-GB memory spike). Concurrent checks for one login now share a single
  process, and a logged-in answer is reused for 30 seconds. A logged-out or uncertain answer is never reused, so a fresh
  sign-in is seen at once; the shared check stops only when every caller waiting on it has aborted.

## 0.18.10 (2026-11-02)

- **A plan with its week left is never "short" because of its five-hour window.** A chain step gated on every
  account being short (`onlyWhen.everyAccount`) read the router's top-level `usedPercent`, which is the most-limiting
  window and can be the five-hour one. A plan at 83% of its five hours but 34% of its week counted as short, so work
  went to a paid route while that plan could serve. The check now reads the weekly window, named `seven_day` or `7d`.

## 0.18.9 (2026-11-02)

- **Dependency:** the development tree pins `minimatch` 11.0.3 (was 10.2.6 through Pi), clearing the moderate
  globparts denial-of-service advisory. Nothing shipped at runtime changes.

## 0.18.8 (2026-11-01)

- **Long Claude Code workers are no longer killed at 8 MiB.** The 8 MiB bound now applies to one stream-json frame
  still being buffered; a whole run's stream may reach 256 MiB, since every frame is parsed and dropped as it arrives.
- **Hold Backspace clears the input after 1.5 seconds** (was 2 seconds).
- **Any registry-defined Claude account.** `claudeAccount` (the tool schema, the checkpoint format, subscription
  receipts and the router-selected fallback pin) accepts any account id in
  `~/.config/ultraterm/claude-accounts.json`, not only `primary` and `b`. The id is a lowercase slug of at most 24
  characters; its folder and label come from the registry. Every folder component below `$HOME` must be a real
  directory (no symlink) owned by the user and closed to group and other writes; an explicit account folder must
  also be `0700`, while the default `~/.claude` only has to refuse group and other writes. `primary` still resolves
  to `~/.claude` with `CLAUDE_CONFIG_DIR` unset (explicit only if its registry entry names another folder) and `b` to
  `~/.claude-b`. An undefined id or an unusable registry fails closed with a named error. Without a registry,
  `primary` and `b` keep their folders, now with the same folder-safety checks (a symlinked or group-writable
  `~/.claude`, or a `~/.claude-b` that is not `0700`, is refused with a named error).
- **A registry account must be reported eligible.** For any account other than `primary` and `b`, a router `select`
  answer with no `eligible` field, or with `eligible: false`, is refused with a `ClaudeAccountEligibilityError` that
  carries the router's `stateText` or reason, at dispatch, on resume and at each launch. A lent, owner-reserved
  account never launches on an unknown or absent eligibility.
- **One config folder, one account.** A registry entry whose folder another account already claims (an earlier
  entry, or `primary`'s folder or the default `~/.claude`) is refused with a `ClaudeAccountFolderConflictError`; the
  first claimant keeps the folder. When the registry gives `~/.claude-b` to another id and omits `b`, that entry keeps
  it and `b` is refused. Default (unset `CLAUDE_CONFIG_DIR`) mode
  applies to `primary` alone.
- **USAP call card for a malformed call.** A tool call whose arguments hold no tasks no longer renders
  "Subagents · 0 assignments". While Pi is still streaming the arguments the card says "preparing…"; once they are
  complete it says "invalid arguments; nothing was dispatched". When the call was refused the call card is empty and
  the result card leads with "Subagents · call refused", the error text and an error-colored border. Pi hands the
  failure to renderers only as `context.isError`, which the renderers now read.
- **Claude Code workers run at medium effort by default.** The USAP `claude-code` and `claude-code-api` harness no
  longer forces `xhigh`. A run's effort is the dispatch's `thinking` when given (`medium`, `high` or `xhigh`; `high`
  and `xhigh` need a `thinkingReason`, as on the native route) and `medium` when none is given. That level is passed
  as `--effort <level>` to the Claude CLI and recorded as the run's `thinkingLevel`; a resume keeps the recorded
  effort. Any other level (such as `low` or `max`) is rejected by the tool schema's `thinking` enum, and if one
  reaches the code anyway a `ClaudeCodeEffortError` refuses it before a run starts (dispatch, and the API wave CLI
  whose wave spec gains optional `thinking` and `thinkingReason`) or fails the task before inference (the worker, a
  resume included); a resume whose checkpoint records another level is refused with `Resume refused`. This replaces
  the xhigh-only refusal. The `claudeFallbackTier` still picks `substantial` when high/xhigh is requested, and the quota
  fallback tier and automatic review now run at the dispatch's effort instead of refusing a non-xhigh request.

## 0.18.7 (2026-11-01)

- **Finish guard: "open/remaining/unfinished work" counts only when reported.** The noun phrase alone also appears
  when describing things ("no longer counts as unfinished work"). It now counts only as a list header
  ("Remaining items:") or when the reply says it has some ("there are still open tasks", "we have 2 outstanding
  issues"). Other open-work wording is unchanged.

## 0.18.6 (2026-11-01)

- **Finish guard ignores quoted wording.** Phrases inside quotes ("...", “...”), inline code and code blocks are words
  being cited or shown, so they no longer count as the reply reporting unfinished work. A reply that explains what the
  guard matched, or quotes someone's advice, is no longer pushed back. Unquoted wording still counts.

## 0.18.5 (2026-11-01)

- **`routeConditions`.** An `onlyWhen` condition can now be attached to a plain `"provider/model"` chain step from a
  separate top-level key: `"routeConditions": { "provider/model": { provider, everyAccount: { remainingBelow,
  behindPaceAbove } } }`. The chain itself stays a list of strings, so a `routing.json` that uses it is still read by
  releases that only know string steps (they ignore unknown keys). An inline object step stopped those releases from
  parsing the whole file. An inline `onlyWhen` wins over a `routeConditions` entry for the same route; a malformed
  condition is refused with its key named.

## 0.18.4 (2026-11-01)

- **Config-driven `onlyWhen` semi-fallback.** A `textWorkerChain` step may now be an object
  `{provider, id, onlyWhen: {provider, everyAccount: {remainingBelow, behindPaceAbove}}}` instead of a plain
  route string. The step is eligible only while EVERY configured account of the named router provider is out
  (exhausted or ineligible/signed out), has under `remainingBelow` percent left, or is more than
  `behindPaceAbove` points behind its weekly pace. Unknown or stale usage is not short. A false condition skips
  the step with its named reason in the dispatch note; a step with no `onlyWhen` behaves as before. No model or
  provider names ship in the defaults.
- **Dispatch note.** A skipped `onlyWhen` step names its condition instead of a quota read, in both the success
  path and the no-route error path.

## 0.18.3 (2026-11-01)

- **Finish guard.** A turn can no longer end while the todo plan has open items or the final reply reports
  unfinished work instead of doing it. At Pi's `agent_before_settle` boundary (only for a completed outcome) the
  guard appends a `finish-guard` message listing what is open and asks for one more model request. A `blocked`
  item counts as open unless its reason is a real external blocker (2FA, credential, payment or spend approval,
  legal sign-off). At most 3 pushes per operator message; never after an abort or error, when the operator asked
  to stop or hold or only for an answer, or when nothing is open. On by default.
- **Lightweight.** State is O(1) from events (last operator input, last assistant text, latest `todo` result,
  push count): nothing rescans the session branch or reads a file when a turn ends, and the patterns compile
  once. A session that becomes active (resume, fork, tree move) is seeded with one backward pass from the
  branch tip.
- **Configurable.** `finishGuard` in `~/.pi/agent/steak-pi.json` (`enabled`, `maxPushes` 0-20, `message`);
  `STEAK_PI_FINISH_GUARD=0` turns it off. The wording is provider- and person-neutral.
- **Claude Code Stop hook.** `steak-pi finish-guard-hook` reads the hook JSON on stdin and prints
  `{"decision":"block","reason":...}` or nothing, with the same rules. It reads only the tail of the transcript
  (the last 512 KB, extending backwards only until the last operator message). Median wall time on a 175 MB
  synthetic transcript, process start to exit: 79 ms when that message is about 1 MB from the end, 123 ms when
  it is 25 MB back, 0.32 s at worst when it is the first line (the whole file is read). It never throws and
  always exits 0.
- New files: `extensions/finish-guard.ts`, `src/finish-guard.ts`, `src/finish-guard-hook.ts`.

## 0.18.2 (2026-11-01)

- **Config-driven provider accounts.** The Go and Codex provider-account labels are no longer hard-coded
  "Go 1"/"Go 2"/"GPT1"/"GPT2"; each label comes from the account router's own record, falling back to the
  account id. The Go endpoint base URL and which quota tiers lease accounts now come from the operator's
  `providerQuotaFallback` (`accountRouter`, `baseUrl`) instead of being baked into the worker.
- **Config-driven temporary-free exclusions.** The temporary free route's model-family exclusion list
  (GPT/ChatGPT, ZAI/Xiaomi/GLM, OpenAI/Codex/MiMo/Anthropic/Claude) moved from code into
  `temporaryFreeExclusions` in `routing.json`; with no config it refuses those families by default and
  names the key to set. The neutrality test still excludes tests' synthetic fixtures.
- **No behaviour change when configured.** The operator's own `routing.json` carries the same exclusions and
  account-router settings, so the live route chain and free-route guards are unchanged.
## 0.18.1 (2026-11-01)

- **Documentation corrections.** `docs/MODEL-ROUTING.md` and this changelog described version 1
  paid-routes files as able to take a reviewed table only from a version 2 operator file. The code
  reads a `reviewed` array inside a version 1 file too, which is what the live operator file uses;
  the docs now say so and state that a version 2 file without `reviewed` reviews nothing and never
  borrows the catalog.
- **Removed-defaults documentation.** The protocol reference and skill no longer describe built-in
  provider-specific concurrency ceilings or an always-on GPT OAuth pin; both are operator
  configuration (`usap-caps.json`, `subscriptionRouteChecks`).
- **Stronger neutrality test.** The neutrality test now scans `CONTRIBUTING.md` and `SECURITY.md`,
  matches people's names case-insensitively, catches product/tier names as well as route spellings,
  and exempts personal names only inside distribution URL forms in six named shipped files
  (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `bin/steak-pi`, `src/update-check.ts`,
  `extensions/ultracompress/index.ts`). Each of those files is checked to still contain a real hit,
  so the exemption cannot cover nothing; text outside the URL on the same line is still scanned.
  The tool description and protocol/skill docs no longer name the operator's Claude account labels.
  Install commands and badges keep the real repository owner so links and updates resolve.
- **Test coverage.** Added a paid-routes case proving a version 2 file without a reviewed table
  grants nothing and never borrows the operator's catalog.
- No routing, selection, quota or paid-route behaviour changed.

## 0.18.0 (2026-11-01)

- **Steak Pi is provider-neutral.** The shipped tool no longer carries any model id, fallback chain, provider
  preference, worker profile, expert reviewer, paid-route grant, retired-model list, catalog extra, hidden-model
  rule, quota tier, Claude fallback tier or personal name. Every routing choice is now operator configuration,
  read by the new `src/routing-config.ts` from `~/.config/ultraterm/routing.json` (override
  `STEAK_PI_ROUTING_CONFIG`) and `~/.pi/agent/paid-routes.json` (override `STEAK_PI_PAID_ROUTES`). Missing files
  are an empty configuration: the tool starts and every explicit `model`/`profile`/`harness` selector works, while
  an implicit dispatch fails naming the key to set (`No text worker chain configured: set textWorkerChain in
  ~/.config/ultraterm/routing.json.`). A malformed file fails the decision that needs it with a
  `RoutingConfigError` naming the key, never at import time.
- **New routing.json keys** (documented with placeholders in `docs/MODEL-ROUTING.md`; `workerDefault` and
  `reviewerDefault` are unchanged): `textWorkerChain`, `multimodalWorkerChain`, `defaultChainProfile`,
  `tokenPlanChainHeads`, `reviewerChainHead`, `expertReview`, `workerProfiles`, `retiredModelPatterns`,
  `retiredProfiles`, `catalogExtras`, `providerQuotaFallback`, `hiddenModelPatterns`, `subscriptionRouteChecks`
  (including `modelPattern` family pins), `subscriptionFirstProvider`, `claudeFallbackTier`,
  `claudeCodeDefaults`, `implicitReview`, `verificationGates` and `routeLabels`.
- **paid-routes.json version 2**: `{ "version": 2, "reviewed": [...], "allow": [...] }`. `reviewed` is the
  operator's approved paid-route catalog and `allow` the granted subset; a route spends only when it is in both.
  Version 1 files keep working: a v1 allow entry grants only when the route is also in the reviewed table. A
  version 1 file may carry its own `reviewed` array so one operator file serves both 0.17.0 (which reads only
  `allow`) and this build; a version 1 file without one is checked against the operator's catalog file. A
  version 2 file uses only its own table and never borrows the catalog. Every reader still fails closed on a
  missing or malformed file. `reviewedPaidRoutes()` is new; the deprecated `PAID_ROUTES` export is empty.
- Per-provider session/machine concurrency ceilings are no longer built in (every provider gets the default);
  set them in `~/.config/steak-pi/usap-caps.json`. The Claude Code CLI adapter keeps its own pinned model catalog
  (`src/subagents/claude-code-models.ts`), but no default selects from it.
- The live benchmark runner needs `USAP_BENCH_PROVIDER` and `USAP_BENCH_MODEL`; benchmark result files were renamed
  without a model name. `test/neutrality.test.ts` scans every shipped file for concrete model ids and personal
  names, and the suite runs against a synthetic operator fixture (`test/fixtures/`), never the machine's own files.

## 0.17.0 (2026-10-31)

- **The automatic text worker chain is Go-first.** USAP routine text workers and scouts now run **DeepSeek V4.1
  Flash on OpenCode Go** (`opencode-go/deepseek-v4.1-flash`, profile `steak-pi/opencode-go`; the prepaid plan),
  then **DeepSeek V4.1 Flash on OpenRouter** once Go is used up (the exact
  `openrouter/deepseek/deepseek-v4.1-flash-1017:exacto` route, profile `steak-pi/deepseek-openrouter`, launched
  only while the operator's reviewed-route allowlist carries it), then **GPT-6.1 Terra on Codex OAuth**, then the
  Claude subscription tier. An exhausted tier falls through to the next; a busy or unknown account never moves a
  wave; explicit routes stay exact; a sibling OpenRouter id or a different baseUrl is still refused as a different
  billing target. Image runs keep their Terra → MiMo V2.6 Flash chain, and `MAX_QUOTA_FALL_THROUGHS` stays three
  because the same three gated tiers are walked in the new order.
- **Update available, in one line.** An interactive session checks GitHub's latest release in the background at most
  once every 6 hours per machine (one shared cache file, no polling, nothing on the startup path, no check in print
  mode or CI). When a newer release exists the footer shows `Steak Pi <new> available (you have <old>) · /steak-update`.
  Turn it off with `STEAK_PI_NO_UPDATE_CHECK=1`.
- **One-step update.** `/steak-update` installs the latest release and reloads the session; `/steak-update check`
  only reports. Agents and scripts use `steak-pi update` (or `steak-pi update --check`).
- `steak-pi update` now handles release-folder installs (`.../steak-pi/releases/<version>/package`, the layout
  UltraTerm uses): it downloads the tag into a new folder, installs its full dependency set, re-points Pi's settings
  atomically and keeps exactly one rollback. A failed download or install names its cause and changes nothing.

## 0.16.0 (2026-10-31)

- The default worker is now **DeepSeek V4.1 Flash on OpenRouter**, the exact
  `openrouter/deepseek/deepseek-v4.1-flash-1017:exacto` route (OpenRouter's
  quality-first Exacto provider sort) at `https://openrouter.ai/api/v1`, approved in
  `~/.pi/agent/paid-routes.json` and launched under the operator's exact
  reviewed-route allowlist. Fallback order: OpenCode Go -> OpenRouter DeepSeek
  DeepSeek V4.1 Flash -> GPT-6.1 Terra on Codex OAuth -> the Claude subscription
  tier. DeepSeek and Terra implementation work needs an Opus 5.5 verification.
- Paid routes are allowed: the earlier "subscription first, no paid fallback" rule is
  revoked. Any allowlisted reviewed route may serve a request, including a chain hop,
  without a launch flag; removing the allowlist entry revokes it, and a sibling id
  (for example `deepseek/deepseek-v4.1-flash` without `:exacto`) or a different
  baseUrl is still refused as a different billing target.
- OpenRouter's own 402 "Insufficient credits" / "requires more credits" and
  "No endpoints found" / "0 endpoints out of N requested are available" refusals now
  count as a provider quota cause: an implicit wave refused on OpenRouter before any
  output falls through to Go within the same call instead of stalling. A tier a
  fall-through already refused is never retried, whatever the router later says.
- The account router meters Go, Codex and Claude only. An OpenRouter head launches
  without a router read; only its own refusal proves the route spent. The dispatch's
  route note and receipt name each tier walked past in chain order.
- Bumped the worker chain order in the USAP tool description, model-routing, profile,
  protocol and skill docs.

## 0.15.4 (2026-10-31)

- Long MCP tool names now work on the Claude Code route. Pi names MCP tools `mcp__<server>__<tool>`, and a name over
  50 characters (for example `mcp__overseer__overseer_coordinator_note_disposition`, 52) used to fail the whole turn
  with "Claude Code tool names must be unique ASCII identifiers of at most 50 characters". Such names, and names with
  characters the API does not accept, are now sent as a stable alias: a readable head plus 8 hex digits of the full
  name's SHA-256. Calls map back to the real Pi tool, and the transcript keeps the real name. Names that already fit
  are sent unchanged, so existing sessions are unaffected. Two tools that would share an alias are refused by name.

## 0.15.3 (2026-10-30)

- A background subagent result that arrives while the parent is in a long tool call no longer shows "USAP delivery unconfirmed".
  The result is queued and lands when the current step ends; the receipt is now re-checked at every turn end. The message shows
  only when the parent is idle and the result still has not landed.

## 0.15.2 (2026-10-30)

- USAP workers' read tool now says it can view images (jpg, png, gif, webp,
  bmp), not only text files. It always could; workers given an image task
  sometimes never tried to open the image because the tool description only
  mentioned files.

## 0.15.1 (2026-10-29)

- Automatic image work (requireImages with no model named, or the Terra
  profile) now runs on GPT-6.1 Terra, then MiMo V2.6 Flash. Before, the image
  chain was MiMo Flash alone, so these dispatches were refused with "No
  authenticated route in the default multimodal worker chain" while an explicit
  openai-codex/gpt-6.1-terra read the same scans. The text-only Go route never
  joins the image chain.

## 0.15.0 (2026-10-29)

- Hold Backspace for more than two seconds to clear the input editor without interrupting the agent. Set `holdDeleteClearsInput` to `false` in `~/.pi/agent/steak-pi.json` to disable it.

## 0.14.3 (2026-10-29)

- A Claude Code login check that times out, crashes or prints no status is
  retried once, then named as what it was. Only Claude Code's own
  "loggedIn: false" reads as logged out. Before, a busy check tore down
  Claude workers as "not logged in" while the login was fine.

## 0.14.2 (2026-10-29)

- A terminal's UltraTerm inbox registers again after its session identity is
  republished (or published after session start). Before, the inbox monitor
  stopped for good and every peer message to that terminal was refused with
  "recipient inbox is not registered".
- The temporary free-route tests name the cause when TMPDIR sits under a
  group- or world-writable folder, instead of failing with a bare config error.

## 0.14.1 (2026-10-29)

- Claude Code reviewers can read the one staged review folder their task names
  (under ~/.cache/ut-overseer/<job>/review/), read-only, via --add-dir. Reviewers
  still get no writes and no shell; other folders and the cache root stay denied.

## 0.14.0 (2026-10-28)

- Default implicit workers and scouts now use GPT-6.1 Terra on Codex OAuth,
  then OpenCode Go and Claude Haiku/Sonnet on proven unavailability or usage limits.
- Register Terra in the native Codex catalog and add its high-effort USAP profile;
  explicit GPT-6.1 Sol remains supported and GPT-6.0 Sol stays retired.
- Automatic text-review fallback uses Terra only after proven Claude unavailability;
  implementation on Terra requests Opus 5.5 completion verification.

## 0.13.0 (2026-10-28)

- Running Claude Code subagents now receive hub messages and redirects through
  the official CLI's stream-json input, without cancellation or losing context.
  Replies return through the same run-local hub inbox. Steering keeps existing
  read-only tool limits, owned paths, deadlines and aggregate turn budgets.
- `ultraterm_hub redirect` appends updated instructions to a worker; `send`
  remains available for coordination. Both harnesses use the same relay limits
  and host-bound sender identities.

## 0.12.2 (2026-10-28)

- Settled background runs now wake an idle parent for one integration turn,
  coalescing simultaneous completions without repeating acknowledged results.
  Busy parents receive completion steers in their current run; headless/batch hosts can
  opt out with `STEAK_USAP_WAKE_PARENT=0`, and hosts that reject a wake fall
  back to bounded passive delivery.

## 0.12.1 (2026-10-28)

- Machine launch slots now admit the oldest eligible waiter across parents,
  preventing later arrivals from repeatedly jumping the queue. Provider-blocked
  waiters do not block other providers; cancellation and timeout release their
  queue tickets without reclaiming live leases. Fairness requires upgraded peers.
- Pi leaves can native-Read individual regular files explicitly assigned in
  their task under the job cache, without exposing directories, unassigned files,
  symlinks or writes. Empty and placeholder-only results now fail rather than
  reporting completed.
- Sol and read-only leaves no longer receive a Claude review end-gate. Only
  Go/Haiku implementation leaves request Sonnet/Opus verification respectively.
  Explicit output formats, including JSON-only contracts, override default
  report headings on both harnesses.

## 0.12.0 (2026-10-28)

- Subagents check plan quota before they launch. When the provider account
  router shows every OpenCode Go or GPT account cooling down, signed out or at
  a full usage window, an automatic worker wave skips that provider and moves
  down the chain: Go, then GPT-6.1 Sol, then your Claude subscription, using
  Haiku 5.5 for ordinary leaves and Sonnet 5.5 for leaves that may edit and
  run a shell or ask for xhigh reasoning. Busy accounts, unmeasured usage and an
  unreadable router never count as out of quota. Claude fallback work runs on a
  Claude account the router shows eligible, never the paid API route, and is
  marked as needing an Opus 5.5 review.
- The same Claude fallback also applies when neither Go nor Sol is signed in.
  Without the account router it runs on your own Claude Code login; 0.11.8
  refused such a wave with "No authenticated route".
- A route you name yourself is never rerouted. If its provider is out of
  quota the dispatch is refused at once with the router's reason, and a wave
  with no route that can launch says why for every route it tried.
- A worker that dies before its first model output now fails the dispatch call
  itself, background or not, with the cause, cancels the rest of the wave and
  queues no second message, instead of reporting `Started`.
- A wave refused on a plan limit before any output (Go's usage limit, a Codex
  usage limit, a cooling-down router refusal) re-runs the same tasks on the
  next route within the same call. Spent Go and Codex plans are now reported to
  the router as used up rather than as a passing rate limit, so the next
  dispatch skips them.

## 0.11.8 (2026-10-24)

- A Claude Code error after a failed tool no longer leaves the next message
  stuck in the queue, even when an MCP process keeps the output pipe open.
  History replay, model discovery, process exit and relay traffic now have
  bounded waits; streaming uses an idle budget so long, active replies are not
  interrupted or repeatedly retried. An inactive turn ends with a terminal error.
- Claude Code cleanup skips exited Windows PIDs and stale POSIX process groups
  instead of risking an unrelated process tree. Relay retries refresh the idle
  budget even when Claude Code is silent during backoff.
- Requests stay within Anthropic's limit of four cache markers, keeping the
  system prompt, tools and newest message cached where possible.
- Sessions whose managed runtime was replaced resolve worker modules again
  from the exact content-addressed build, or a same-version copy with
  byte-identical package modules. Different builds fail with a clear cause;
  isolated Codex selection uses the same resolver.

## 0.11.7 (2026-10-24)

- Bound pre-compaction snapshot retention per working directory: keep the
  newest 10 files, with a maximum age of 14 days. Configure both limits with
  `snapshot.maxCount` and `snapshot.maxAgeDays`; existing settings gain the
  defaults automatically. Cleanup runs only after a successful snapshot write,
  leaves unrelated files and symlinks alone, and logs failures without blocking
  compaction or discarding the newly written snapshot.
- Fix the non-Homebrew updater's GitHub API URL and preserve failed-request
  diagnostics instead of misreporting an unreachable server as no release.

## 0.11.6 (2026-10-24)

- A live pane can recover its primary-host link after a temporary proof timeout.
  Later turns repeat the full startup proof only if the pane is vacant; they
  never replace another process's link or restart a stopped publisher.
- Keep the Pi 1.0.4 development fixture on patched Undici 8.12.3. This changes
  development dependencies only, not the Pi version used by installed packages.

## 0.11.5 (2026-10-24)

- Every subagent's preamble now carries the process-listing safety rule, no
  matter what the parent wrote in its brief. On macOS a full process command
  line can include the process environment, and with it API keys, so children
  list processes by PID and name only and never print a full command line or
  an environment listing.

## 0.11.4 (2026-10-23)

- A subagent's findings are no longer lost when another subagent in the same
  run messages it after it has finished. The late message used to wake the
  finished child for another turn, and that turn's reply ("already reported")
  replaced the real report. Messages that arrive after a child's final answer
  wait in its inbox, and the first final answer is always kept as the report;
  a later answer is appended after it. A reply that also calls a tool, or was
  cut off at the token limit, no longer counts as a final answer.
- Children are told to put findings and review requests in their final report,
  which is what the parent reads, and not to broadcast them over the relay.
- The startup-paste TUI test sends its paste byte for byte, as the main smoke
  test already did, so it passes on tmux 3.8.

## 0.11.3 (2026-10-23)

- Restore the composer's context meter. It now stretches across the free space
  between the model/status and the stats, so the stats sit flush right at any
  width: one line when wide, and on the stats row when the pane is narrow.
- Meter shows only when every metric already fits; tiny panes keep the compact
  stats without it.

## 0.11.2 (2026-10-22)

- Escape on a Claude Code turn no longer leaves the session stuck at "thinking".
  A process Claude Code started (an MCP server or a hook) could keep the output
  pipe open after the turn was stopped, so the turn never ended and the next
  message stayed in the queue. Stopping a turn now settles at once, closing the
  old process waits at most two seconds, and the next message runs.
- Escape also ends a turn that is still writing a long history to Claude Code.
- Regression tests reproduce both hangs with a fake Claude Code process.

## 0.11.1 (2026-10-20)

- Preserve a paste and its trailing instruction when entered before the companion
  editor finishes loading. The first native-to-Steak editor swap now captures
  the expanded draft rather than transferring only its paste label.
- Add real-editor and isolated CLI/PTY startup-timing regressions. Existing queue,
  dialog, literal-marker, undo and compact-paste behavior stays unchanged.

## 0.11.0 (2026-10-20)

- Add a stable preferred-free worker route. Approved preference changes are read
  at model-call boundaries without restarting sessions; assistant receipts keep
  the actual answering model and cost.
- Add the MiniMax M3.1 Flash free route on OpenRouter, UTC expiry and strict
  zero-price request bounds. Paid fallback lists and paid plugins are refused.
- Support temporary preference control through UltraTerm's MCP/CLI interface.
  Expired preferences return through the normal routing safeguards.
- Keep a visible gap between the steak emoji and the TUI name, including narrow
  headers where plain-text normalization previously collapsed extra spacing.

## 0.10.3 (2026-10-20)

- Keep context/window size, tokens, meaningful cache percentage and session cost
  visible in narrow terminal panes. Use a compact second line when the complete
  status readout cannot fit on one line; shorten decoration before dropping data.
- Limit the context meter to twelve cells and distinguish filled/remaining
  portions by weight as well as color. Improve metadata contrast in both themes.
- Preserve mouse and autocomplete positions when the band gains a line. Replace
  the long empty-editor hint with `Message`.
- Retain the 0.10.2 paste fix. Verify collapsed, restored and submitted paste states
  with native screenshots and the exact provider-bound text in the offline test.
- Extend native dark/light checks to 40/48/59/64/80/120/192 columns. Independent
  fixture sessions prevent the test hosts from competing for checkpoint ownership.

## 0.10.2 (2026-10-20)

- Keep long pasted content and surrounding typed instructions intact when restoring
  queued messages, opening dialogs or replacing the editor. Previously those
  operations could retain only a `[paste #…]` marker and lose its stored text.
- Preserve native compact paste rendering, editing, undo and submission. Add an
  offline native-TUI regression that checks the exact text reaching the provider
  after queue restoration and interruption.
- Refresh the published overhead measurements on Pi 1.0.4, correct macOS peak
  memory units in the benchmark, and wait for its local fixture process to exit.
- UltraTerm receives the fix through its next managed runtime update; this package
  release does not replace running UltraTerm sessions.

## 0.10.1 (2026-10-19)

- Show a steak emoji (🥩) in the terminal UI header instead of the diamond: `🥩 STEAK PI`. The activity markers in the status line keep their diamonds.

## 0.10.0 (2026-10-19)

- Add a built-in `claude-code` provider: Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and
  Haiku 5.5 through the user's own Claude Code subscription, shipped in the Steak Pi
  package with no separate extension install. Derived from
  [earendil-works/pi-claude-code](https://github.com/earendil-works/pi-claude-code)
  (MIT, Armin Ronacher); the upstream license is kept in `extensions/claude-code/LICENSE`.
- Subscription-first policy accepts exactly provider `claude-code` on
  `process://claude-code` as a subscription route. No other provider or URL gains it;
  `paid-routes.json` is untouched.
- Fix the intermittent "Incomplete Claude Code upstream response" failures: the model
  sometimes called a Pi tool by its bare name (`bash`) instead of `mcp__pi__bash`, which
  aborted the stream. Bare names that match a current Pi tool are now accepted; anything
  else still fails with its real cause.
- Retry a turn up to three attempts with backoff on connection errors, 500/502/503/504/529
  and a stream that dies before its first byte. Never retry 4xx, authentication, rate
  limit or billing errors, or a stream that already produced output. Failures now report
  the underlying error, stage and attempt.
- The usage-credit guard is unchanged: overage stops the run unless
  `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS=1`.

## 0.9.18 (2026-10-19)

- Add per-run `claudeAccount: "primary" | "b"` selection for the existing Claude
  subscription route. Validate the exact registered account at dispatch and each
  launch; unavailable or ambiguous selections fail closed without another account,
  model, API credits or global-default changes.
- Keep default-unset and explicit Claude config namespaces distinct. Record
  sanitized official-CLI subscription identity receipts and pin them on resume;
  clean finished worker transcripts only in their actual namespace.
- Available in the Steak Pi package. UltraTerm receives it through its next
  managed runtime release; this package release does not replace managed helpers.

## 0.9.17 (2026-10-16)

- Validate Claude ownership paths before a wave starts, including implicit
  privileged reviewers when Claude is unavailable.
- Restrict automatic text-review fallback to read-only reviewers without shell
  or ownership grants. Refuse privileged legacy fallback checkpoints on resume.
- Preserve explicit Pi routes, exact ownership, and existing subscription routes.

- Record automatic review provenance honestly: an implicit review on its automatic Claude route
  is `selection.source: "automatic-review"`, and a Sol review chosen because no Claude account
  was eligible is `"automatic-review-fallback"`, instead of `override` (the value an
  operator-requested route produces). A resume keeps either automatic source, and a fallback
  leaf's `reviewFallback` only when it resumes on that fallback route; it does not re-arm the
  automatic Claude -> Sol fallback.
- Run the test suite under a private empty HOME so an operator's live `~/.config/ultraterm`,
  `~/.pi` and `~/.claude` cannot change results (49 tests failed on a machine with a live Go
  `routing.json`; the same suite now passes everywhere).
- Add the explicit Claude API route `claude-code-api/claude-sonnet-5-5|claude-opus-5-5` to the
  official headless Claude Code runner: distinct from the subscription route, admitted per
  dispatch and launch by a task-scoped operator approval record and a strict settings contract,
  `--bare` apiKeyHelper auth, per-session budget ceilings, a CLI-attested sanitized receipt, no
  fallback in either direction, and a standalone `scripts/usap-claude-api.ts` (also
  `steak-pi usap-api`) for dispatch and the one bounded resume. Subscription defaults,
  arguments and environment stripping are unchanged. See `docs/CLAUDE-API-ROUTE.md`, which
  records that promotional API credits cover headless `claude -p` and the Agent SDK, not
  interactive Claude Code.
## 0.9.15 (2026-10-13, local candidate)

- Default routine workers to OpenCode Go DeepSeek V4.1 Flash; balance isolated accounts with sticky resumptions, renewed reservations and bounded cleanup.
- Use GPT-6.1 Sol on Codex OAuth for automatic text review when Claude is unavailable. Preserve explicit routes and record actual fallback evidence.
- Let Go-only parents admit Sol reviews through separate Codex stores without copying credentials or changing parent environment.
- Preserve the installed 0.9.14 checkpoint, queue visibility and Claude owned-path protections.

## 0.9.11 (2026-10-16)

- Rebrand to Pareto Cybernetics: `steak-pi version` reports "(Pareto Cybernetics)" and the
  Homebrew tap is `michael-berardi/pareto-software-distribution`
  (`brew install michael-berardi/pareto-software-distribution/steak-pi`).
- Claude session-limit diagnostics preserve bounded time-only resets and recognize
  structured `usage_limit_reached` errors without treating them as approval.
- Read-only Claude reviewers never receive Bash, even when requested. Parents
  stage git evidence; a named diagnostic explains the denied shell grant.
- `requireImages: true` admits the exact Claude Sonnet/Opus routes for native
  Read-image inspection of files staged under cwd, not inline attachments.
- Claude synthetic failures now direct the parent to check subscription usage
  before debugging. Retry quota failures only on the same route after reset.
  Diagnostics identify quota ahead of a concurrent rate-limit marker;
  usage-limit errors cannot trigger immediate automatic retries.

## 0.9.10 (2026-10-06)

- Claude Code review failures now distinguish subscription limits, login errors
  and connection failures from a different-model response. Quota reset timing is
  preserved without exposing arbitrary diagnostic text. Synthetic CLI messages
  never count as a model response or review approval; the pinned route remains
  mandatory and no fallback is introduced.
- Startup model metadata alone no longer proves that a review actually ran.
- Verified on Pi 1.0.4, including offline native TUI startup, completion delivery
  and session resume. Updated the development lockfile to fix the reported
  brace-expansion and source-map-js security advisories.

## 0.9.9 (2026-10-05)

- GPT-6.0 Sol is retired, and Sol now means GPT-6.1 Sol only. Choosing the old
  model (`gpt-6-sol`, `gpt-6.0-sol`, `openai-codex/gpt-6-sol`,
  `steak-pi/gpt-6-sol`, or a model whose name reads "GPT-6 Sol" or "GPT-6.0 Sol")
  is refused with a `RetiredModelSelectionError` that names GPT-6.1 Sol as the
  replacement. The refusal applies wherever the old model can come in: harness
  profile files (id, label, model arguments, worker and reviewer defaults), a
  dispatch's `model` or `profile`, the UltraTerm model picker and controls, the
  session's own model, worker start-up, every provider request, and resuming a
  saved run after a restart. A retired choice is never quietly switched to 6.1,
  and saved runs are left as they were.
- The built-in profile for choosing Sol explicitly is now `steak-pi/gpt-6-1-sol`
  (route `openai-codex/gpt-6.1-sol`); it replaces `steak-pi/gpt-6-sol`. A harness
  profile file that still lists GPT-6.0 Sol has to be edited: dispatch refuses
  it with the same error, and the UltraTerm model picker offers no choices,
  until it is.
- GPT-6.1 Sol, Astra, Luna, Sonnet, Opus, MiMo and DeepSeek routes, and the
  MiMo, then GPT-6.1 Sol fallback for routine work, are unchanged.
- A child that is about to run out of turns is told once, when two requests
  remain, to write its findings so far and a precise remaining-work list as its
  final answer (Claude Code children get the budget and the same instruction up
  front, since they cannot be interrupted mid-run).
- A task that stops on its turn or time budget is now explicitly partial:
  `outcome: "partial"`, `partialReason` and a bounded `partialSummary`, shown with
  the task's role and label in the run result, the completion receipt, `diagnose`
  and the `ultraterm-usap-telemetry` record. It keeps its `failed` / `timed_out`
  state. A partial can no longer be mistaken for a finished required review.
- Resume is bounded: each task continues its checkpointed session at most once,
  with the same `maxTurns` and deadline (never larger), on the same subscription
  route and reasoning level. A changed, paid or API-key route is refused before the
  one resume is spent, and a resumed run no longer carries an automatic chain, so
  it cannot hop to another route. The resumed run records `resumedFrom`, the
  original records `resumedAs`, and a successful resume marks the partial attempt
  `supersededBy` in telemetry. A second resume is refused with a clear message.
  Behavior change: a resumed run that is interrupted again can no longer be
  resumed; re-dispatch the remaining work.
- Full suite: 806 passed, 1 skipped.

## 0.9.8 (2026-10-04)

- A reply that Codex ends at its 15-minute limit is no longer resent unchanged.
  Codex cuts every reply stream after about 15 minutes; Pi's automatic retry and
  USAP's automatic resume used to send the identical request again, which failed
  the same way every 15 minutes (one analytics worker lost an hour this way).
  Steak Pi now replaces that bare "terminated" with an explicit "Codex reply
  limit" error that names the model and reasoning level (both unchanged; nothing
  is downgraded) and continues once with a smaller-step instruction. A second
  cut stops with the explicit error. A quick "terminated" is still a network drop
  and keeps its normal retry. Nothing from the cut reply ran, so no tool call is
  repeated.
- Full suite: 767 passed, 1 skipped.

## 0.9.7 (2026-10-04)

Fixes from an independent GPT-6 Astra review of 0.9.6:

- An automatically resumed worker shares its task's turn budget instead of
  getting a fresh one, and is not resumed once the budget is used up.
- A Claude Code worker stopped for serving the wrong model (or for malformed
  output) is never retried automatically, even when its stream was cut.
- Deleting a finished Claude worker's transcript never follows a symlinked
  project folder.
- Full suite: 758 passed, 1 skipped.

## 0.9.6 (2026-10-04)

- Workers recover from transient faults on their own. A worker that fails on a
  network drop ("fetch failed"), a provider stream cut or stall, a Claude CLI
  stream cut or process death, an overload or a rate limit resumes its own
  session (at most twice, 10 s to 2 min backoff, only with run budget left)
  instead of failing the task. Finished tool calls are not redone; usage and
  turns carry across attempts and each resume is listed on the task. In a
  measured kill test a fresh restart redid every finished step and spent about
  69% more tokens. Deadlines, turn limits, content filters, route or policy
  refusals and cancellations are never retried.
- Claude Code workers are resumable. They run with a session id instead of
  `--no-session-persistence`, continue with `--resume`, and their transcript is
  deleted when they finish (or when a failed run's checkpoint is pruned).
- Claude Code workers that used WebFetch no longer fail as "a model other than
  the pinned route". Claude Code's Haiku helper summarises fetched pages and
  appears in the run's model usage; it is accepted there and in subagent side
  frames, while the worker's own turns must still be the pinned Sonnet or Opus.
- A resumed worker keeps its original permissions. The continuation prompt
  called a shell-only leaf "read-only", so a resumed worker could stop instead of
  finishing.
- Full suite: 742 passed, 1 skipped. Live check: a real Sonnet worker killed
  mid-command resumed once by itself, ran each step exactly once and left no
  transcript behind.

## 0.9.5 (2026-10-03)

- GLM 5.3, GLM 5.3 Flash and the Z.ai coding plan are retired. The automatic text
  worker chain is now MiMo V2.6 Flash → GPT-6.1 Sol on Codex OAuth (reviewers:
  MiMo V2.6 Pro → GPT-6.1 Sol); image runs use MiMo V2.6 Flash alone with no
  fallback. The built-in `steak-pi/glm-5-3-flash` profile is gone, and any `zai/`,
  `z-ai/` or `glm-` model or profile selector is refused with a message naming
  the replacement.
- Z.ai hosts are no longer treated as subscription routes, Inco GLM Fast is no
  longer a reviewed paid route, the Z.ai capacity bucket is removed, and the
  OpenCode Go provider no longer retries a failed request on Go GLM: the error is
  reported as itself.
- Full suite: 716 passed, 1 skipped.

## 0.9.4 (2026-10-01)

- Verified on Pi 1.0.0. Typecheck is clean and the full suite passes (694 passed,
  1 skipped), the same result as Pi 0.87.1 and 0.99.2. Pi 1.0 makes `steer()`
  return a queue disposition and requires tool contexts to carry `tools` and
  `executeTool`; the worker session type now accepts any `steer()` result and the
  isolation test passes a tool context. No runtime behaviour changes.
- Workers reuse the host's bundled SDK on Pi 0.99.2 and 1.0.0 as well (the allow-list stopped at 0.87.1, so UltraTerm's 0.99.2 runtime silently loaded a second Pi copy per parent).
- Development and verification pin Pi 1.0.0; the peer range stays open.

## 0.9.3 (2026-09-29)

- USAP picks up models added to Pi's models.json while a session is running. The
  model registry is loaded once per session, so a new route such as
  `openai-codex/gpt-6.1-sol` read as "unavailable" until the parent restarted
  (every Claude Code USAP bridge started earlier refused it). On that exact miss,
  dispatch and resume now reload models.json once and resolve again; any other
  error, or a model that is still missing, fails closed with the original message.

## 0.9.2 (2026-09-28)

- Claude Sonnet 5.5 (`claude-code/claude-sonnet-5-5`) is now a USAP Claude Code
  route and the default Claude worker: `harness: "claude-code"` runs Sonnet 5.5
  at xhigh for worker and scout waves. All-reviewer waves still take the Opus
  Pass (Opus 5.5 xhigh), and `model: "claude-code/claude-opus-5-5"` escalates any
  wave to Opus. Each worker's served model is checked against its route, with no
  fallback between the two.

## 0.9.1 (2026-09-27)

- USAP Pi workers no longer hang forever when the provider stream goes silent.
  After a provider error ("Codex SSE response headers timed out", "WebSocket
  closed 1006") the retry could wait on a half-closed connection that never
  errors, so the task stayed "running", kept its capacity slot and blocked every
  queued task behind it. A worker whose session emits nothing (no model output,
  tool, retry or compaction event) for 10 minutes while no tool is running is
  now stopped and fails with "No model or tool activity for 10 min: the provider
  stream stopped responding …". Running tools keep their own timeouts.

## 0.9.0 (2026-09-27)

- Removed the optional UltraCompact integration: no `uc` transforms, UC
  settings, `ultracompress_uc` tool or UC telemetry. VCC briefs, snap frames and
  raw-history recall are unchanged.

## 0.8.2 (USAP 1.3)

- USAP harness `claude-code` now serves workers, not only reviewers. Leaves may
  set `mayEdit` + `ownedPaths` and `allowBash` as on Pi. Ownership is enforced by
  the Claude CLI itself: each owned path becomes an `Edit(//path)` /
  `Edit(//path/**)` allow rule under `--permission-mode dontAsk`, so writes
  elsewhere are denied; `allowBash` adds the Bash tool (operator-level shell, as
  on Pi). Owned paths containing permission-rule metacharacters are refused.
  Relay, images and native worker resume stay unavailable on this harness.
- USAP final reports for Claude Code workers list changed paths: successful
  Edit/Write/NotebookEdit calls join the same journal the Pi runner keeps.

## 0.8.1 (USAP 1.3)

- Merge the Steak Pi 0.7.0 efficiency release (tag `v0.7.0`, `c450e84`) into the
  0.8 line without dropping 0.8 features: deferred tools; no UltraCompress spawns without its binary; workers reuse the host Pi
  bundle; the session scheduler honours `usap-caps.json` `session.global`;
  `steak-pi run` / `steak-pi env`.
- Not merged: 0.7.0's "guard only dispatch-capable providers". On the 0.8 line
  the guard also applies the curated picker scope and the pre-output fallback's
  metering check, and Pi resolves file-backed credentials after the first
  install, so the filter left providers unguarded. Every provider stays guarded.
- Routine workers default to MiMo V2.6 Flash (`steak-pi/mimo-v2-6-flash`, chain
  MiMo V2.6 Flash → ZAI GLM 5.3 Flash) on every built-in parent profile.
  Automatic reviewers keep MiMo V2.6 Pro → ZAI; each automatic profile naming a
  Token Plan model keeps it as its chain head, and the pre-output fallback uses the
  run's recorded chain. Explicit selections, paid-route guards and the main launch
  model are unchanged.
- Pi stays on the 0.87 toolchain bundled with UltraTerm.
- README rewritten around what the package does today; version history lives
  here. The overhead benchmark names its mock route for fan-out and records
  0.8.1 results on Pi 0.87.1.
- No release, publication or installed-runtime verification is claimed by this
  entry.

## 0.8.0 — unreleased candidate (USAP 1.3)

- Add a headless official Claude Code runner to the existing USAP coordinator. Read-only expert planning/review uses exact Opus 5.5/xhigh with existing first-party subscription login; no API-key route, metered fallback or inherited hook/plugin execution.
- All-reviewer waves without an explicit route default to this Opus Pass. Explicit selections remain exact. The initial CLI slice refuses writes, shell, image admission, relay and native worker resume instead of claiming unsupported parity.
- Record harness provenance in run views and dispatch summaries. Preserve native Pi scheduling and parent ownership; keep old Pi checkpoints readable.
- Recognize the pinned Xiaomi Singapore Token Plan as a subscription, preserve the MiMo→ZAI routine chain, skip foreign CLI model names when reading native worker profiles, and retire the old Steak Pi Claude launch profile while retaining opt-in model metadata unchanged.
- Improve Pi SDK dependency preflight for the reviewed 0.87.1 app pairing. This entry is not publication, installation or final expert sign-off evidence.

## 0.7.8 — local candidate

- Reviewer defaults that name the bundled Astra profile enter the same Astra-first expert chain, with the MiMo→ZAI honest fallback if OAuth is unavailable. Explicitly selected Astra stays exact. This aligns owner manifest migrations with the 0.7.7 expert-review policy and is covered by a regression test.

## 0.7.7 — unreleased, staged for review

- **Scarce Astra expert-review default.** Runs containing reviewers resolve an Astra-first expert review chain (`openai-codex/gpt-6-astra` via the paid Codex OAuth coding plan, then the routine MiMo V2.6 Pro → ZAI coding GLM 5.3 Flash subscription order) instead of the routine chain. A metered substitute (batch id, API-key endpoint) never serves as the expert; an unavailable Astra honestly falls back to the routine chain; a reviewer frozen on Astra gets no runtime hop, so a failed expert review is reported, never silently downgraded. Astra remains out of every routine worker chain, explicit model/profile overrides stay exact, and parent-added `steak-pi/gpt-6-sol` / `steak-pi/gpt-6-luna` are explicit-selection profiles only whose `workerDefault` keeps workers on the routine chain.
- **Expert-review end-gate in the worker contract.** The bounded child prompt states that USAP grants no commit/push/deploy permission, requires exactly one bounded Astra final review before commit/push/deploy, and forbids claiming or fabricating expert approval when Astra review is unavailable. Protocol docs encode the same end-gate; role-routing tests pin the expert chain, the honest fallback and the explicit-only Sol/Luna profiles.

## 0.7.6 — unreleased, staged for review

- Ship an opt-in, credential-free first-party Opus 5.5 model fragment with adaptive thinking and explicit high effort compatibility tests for Pi 0.87. No SDK/runtime patch, automatic activation, or provider auth replacement.

## 0.7.5 — unreleased, staged for review (USAP 1.2)

- Ignore hidden harness backups and staging files when loading worker profiles. Upgrade rollback copies cannot create duplicate profile IDs or block delegation.

## 0.7.4 — unreleased, staged for review (USAP 1.2)

This entry records candidate work only. The package is not published, not installed and
not released; nothing below is installed-runtime or native end-to-end verification. The
changed files are still uncommitted in the candidate tree at the time of writing (the
parent owns the commit and the app-resource packaging).

- **One curated picker scope from the selected harness manifest.** Native `/model` and the
  UltraTerm composer list no longer offer the whole authenticated provider library: they
  publish exactly the exact `provider/model` profiles of the harness UltraTerm launched
  this session (`src/harness-profiles.ts` reads `ULTRATERM_HARNESS_ID`/`ULTRATERM_HARNESS`,
  `ULTRATERM_HARNESS_DIR`, and the bundled `ULTRATERM_HARNESS_RESOURCES` directory, with
  `~/.config/ultraterm/harnesses/{harness}.json` as the live operator location). The
  sidebar profile list, native `/model` and the composer therefore show the same routes,
  and adding, renaming or removing a profile reaches both pickers without a code change and
  without any route being hard-coded. Only `--model provider/id` plus an explicit valid
  `--thinking` level is consumed; tools, system prompts, extensions, launchers and
  credentials are still refused and never transferred.
- **Match the effective sidebar catalog.** Bundled and external manifests follow the native merge rules, including protected built-ins, compatible custom additions and rejected invalid overrides. Both manifest revisions are watched. Unknown metadata preserves ordinary standalone availability. Removed OpenRouter DeepSeek Flash and policy-refused GPT routes stay out of the choices.
- **Curation preserves dispatch coverage.** Curation happens only in
  `guardModelRuntime`'s `provider.filterModels` picker snapshot; `Provider.getModels()` /
  `ModelRuntime.getModels()` keep every route, and ordered-chain membership and USAP worker
  preflight check that published dispatch catalog (`registry.getAll()`) rather than the
  curated picker snapshot, so a fallback step (for example `opencode-go/glm-5.3-flash`)
  stays reachable even when it is not a separate picker choice. A standalone Steak/Pi run
  without the UltraTerm launcher metadata, and any route the manifest does not configure,
  keeps its normal authentication and dispatch behavior.
- **Offline hot reload covers the manifest.** `createConfigRefresher` now folds the selected
  harness manifest revision into the same poll as `models.json`/`auth.json`/
  `models-store.json`, so a profile add, rename or removal republishes both pickers on the
  next bounded `allowNetwork:false` reload without a restart, inference or model switch.
- **Focused tests.** `test/model-profile-catalog.test.ts` covers profile additions,
  removals, label/route renames and the sidebar/native/composer equality over one scope;
  `test/model-visibility.test.ts` drives the real Pi 0.87 `ModelRuntime`/`ModelRegistry`
  with an isolated `HOME`/`PI_CODING_AGENT_DIR` and no ambient provider credentials, and
  proves the curated snapshot, the fail-open unknown-metadata case, the empty-manifest case,
  the unfiltered dispatch catalog and the chain fallback. No release, publication, npm push,
  native build or installed-runtime verification is claimed by this entry.
- **Unified worker default.** Text and image workers/reviewers default to MiMo V2.6 Pro, with ZAI coding subscription GLM 5.3 Flash as the only automatic fallback. Explicit run selections stay exact. The dedicated Singapore Token Plan endpoint is classified as prepaid subscription traffic; generic Xiaomi PAYG and lookalike endpoints remain guarded. Stream tests cover primary success and pre-output fallback with real answering-route provenance.
- **Docs.** `docs/MODEL-ROUTING.md`, `docs/PROFILES.md` and `docs/COMPANION-UI.md` record
  the curated picker scope, the fail-open rule and the dispatch/fallback boundary.

## 0.7.3 — unreleased, staged for review (USAP 1.2)

This entry records candidate work only. The package is not published, not installed and
not released; nothing below is installed-runtime or native end-to-end verification. The
changed files are still uncommitted/untracked in the candidate tree (the parent owns the
commit).

- **OpenRouter DeepSeek Flash removed from both pickers (source-level, corrected).**
  Native `/model` and the UltraTerm composer list now read one shared availability filter
  (`src/model-visibility.ts`, applied inside `guardModelRuntime`'s `provider.filterModels`).
  Every plain OpenRouter DeepSeek V4 Flash / V4.1 Flash route is hidden entirely — the
  canonical ids, the released `-0731`/`:batch` forms, the `~deepseek/…-latest` aliases and
  the unversioned `DeepSeek Flash Latest` — because OpenCode Go Flash and INCO Fast already
  cover Flash. The rule is provider-scoped and slug-exact: `deepseek-v4-pro`/`-0813`, the
  `-vision-exp` capability variants, unrelated OpenRouter models and every other provider
  (Go, INCO, Vercel gateway, Xiaomi, …) keep their routes. The provider catalog
  (`Provider.getModels()`) keeps every route, so dispatch coverage and cost accounting are
  untouched, and the running route is published separately as `currentModel` and is never
  re-added as a choice.
- **One authority for both pickers plus offline hot reload.** `catalogModels` publishes the
  same native snapshot native `/model` renders (never a parallel list, and a stale scope
  entry can never union a removed route back in); `createConfigRefresher` polls the native
  config files and re-applies them with `allowNetwork:false`, so a provider/model add,
  rename, removal and a credential add/remove reach both pickers without a restart and
  without inference or network work. Focused tests (`test/model-visibility.test.ts`) drive
  the real Pi 0.87 runtime and assert `getAvailableSnapshot()` equals the published catalog.
- **Docs.** `docs/MODEL-ROUTING.md` records the shared picker source, the offline hot
  reload and the limitation that a session which already loaded the previous extension code
  keeps the old availability until it is restarted.
- No release, publication, npm push, native build or installed-runtime verification is
  claimed by this entry.

## 0.7.2 — unreleased, staged for review (USAP 1.2)

This entry records candidate work only. The package is not published, not installed and
not released; nothing below is installed-runtime or native end-to-end verification. The
new and changed files are still uncommitted/untracked in the candidate tree (the parent
owns the commit).

- **Pi 0.87.0 (candidate).** Admit 0.87.0 to the peer range
  (`0.85.1 || 0.86.0 || 0.86.1 || 0.87.0`) and pin it for development/verification
  dependencies (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`); package
  version moves to `0.7.2`. The bundled Pi archive pin and the native version gate live in
  UltraTerm resources/`src-tauri` and are **pending**: no local activation, no packaged-app
  acceptance and no signed-installer path has been exercised, and running sessions are
  untouched.
- **Final automatic worker chains (source-level).** `DEFAULT_TEXT_WORKER_CHAIN` =
  opencode-go/deepseek-v4.1-flash → opencode-go/glm-5.3-flash → xiaomi/mimo-v2.6-pro
  (Token Plan); `DEFAULT_MULTIMODAL_WORKER_CHAIN` = xiaomi/mimo-v2.6-pro →
  zai/glm-5.3-flash. Chain steps require configured auth, availability and either a
  subscription/local route or an injected paid-route grant, and fail closed with
  "no fallback was selected" otherwise; an unapproved paid step is never taken. No
  automatic GPT-5.6 Luna worker or reviewer exists, and explicit `model`/`profile`
  selections stay exact. Focused unit tests pass; no native/UI end-to-end or provider spend
  is claimed.
- **Steered durable inbox, bounded receipt waits and truthful receipts (candidate, under
  review).** Addressed messages are claimed at the between-tools boundary with a
  sender-UUID pin, `waitMs` (1–120000) is served by an event-driven waiter, and receipts
  expose `waitSupported`/`waitSatisfied`/`timedOut` plus `hostRegistered`/`hostReady`/
  `supportsSteering`/`deliveryState` diagnostics. A receipt is durable mailbox state only:
  `recorded:true` is never agent acknowledgment or a model read, and `agentAcknowledged`/
  `modelRead` stay `false`. Focused CLI/mailbox/wait tests pass; the real native-agent/TUI
  end-to-end acceptance gate is **still pending**, so this is staged, not shipped.
- **Deterministic edit diagnostics (candidate, under review).** New
  `src/verification-artifacts.ts` (private retained raw stdout/stderr/producer status) and
  `src/verification-report.ts` (explicit bounded Vitest JSON report validation), and
  `verify-after-edit` now runs bash with a scrubbed `BASH_ENV`/`ENV` and appends the
  retained-artifact line to its receipt. The stale, never-run orphan
  `extensions/verification-tests/receipt.test.ts` was removed. Some branches (env scrub,
  report `configurationError`, admission contention) still lack a committed CI test, so this
  is staged for review rather than declared complete.
- **Session-replacement checkpoint repair (STILL UNDER REVIEW — do not ship as-is).**
  `CheckpointOwnershipError`/`sameProcess` classification, an in-process owner registry,
  bounded teardown that always closes the store, and in-process collision degradation to
  memory-only. An independent review found the same-process reclaim rule can unlink a
  *live* owner's lock from a second isolate (`worker_threads`) that shares the pid and a
  different registry key, which can lose a running worker's checkpoint; the reclaim rule
  is therefore not accepted. No live lock, process, runtime or setting was touched.
- **Local MiMo credit dial (UltraTerm UI, not this package).** The shared API/ledger/
  enrollment scope is dropped. The dial reports the current calendar month's usage as a
  monthly percentage computed from local telemetry only, with no `Local estimate` label
  (an unobtrusive tooltip may identify the device/calendar scope). It is never an
  API-reported balance. Recorded here only so it is not mistaken for a shipped shared
  feature.
- No release, publication, npm push, native build or installed-runtime verification is
  claimed by this entry.

## 0.7.1 — unreleased (USAP 1.2)

- Todo maintenance corrections, staged for review: an identical `init` list keeps
  recorded progress instead of resetting it; a single `start` activates exactly one
  item while a bulk `start` keeps every named task active; bulk transitions resolve
  task names only and never complete or remove a whole phase by fallback.
- Rejected todo operations write nothing and now name the labels the plan actually
  contains, so a failed lookup is actionable instead of a dead end. A single
  `done`/`drop`/`rm` still accepts a task or a phase name, with a task match
  taking precedence over the phase-name fallback.
- Add the `todo` skill and state the todo recording duties in the session prompt
  only while an unfinished plan exists. Completed plans keep their pinned
  checklist and finished counts visible until the plan is replaced or removed.
- Admit Pi 0.86.1 to the peer range (`0.85.1 || 0.86.0 || 0.86.1`) and pin it for
  verification dependencies. No Woodstar component is bundled in this release.
- Remove the DeepSeek-specific DSH harness, the managed `steak-pi-dsh` launcher
  and the vendored persistent-bash worker runtime. DeepSeek models run as
  ordinary routes (OpenCode Go and the explicitly paid Inco DeepSeek Fast route)
  with the existing paid-route admission unchanged.
- No release, publication, or installed-runtime verification is claimed by this
  entry; the package is still not published to the npm registry.

## 0.7.0 — 2026-09-24 (USAP 1.2 wire format; released from `main`, merged into 0.8.1)

Performance release. No feature removed; the USAP dispatch schema, relay
envelope and checkpoint format are unchanged, so 0.6.0 checkpoints still
resume. Measured on Pi 0.86.0 against a scripted local model
([`benchmarks/overhead`](./benchmarks/overhead/README.md)); figures are
medians of 5 runs, September 24, 2026.

- Route policy guards only providers that can dispatch (configured auth or the
  active model), re-checked on every prompt, model switch, compaction and
  worker turn. Re-registering all ~41 catalog providers made Pi rebuild its
  model catalog per provider: -0.2 s and -20 to -30 MB per session.
- Deferred tools: `ultraterm_hub` appears after the first dispatch (or at start
  when the session has runs), `ultracompress_recall` after a compaction, and
  `ultracompress_uc` after the first tool result large enough to be archived.
  Each tool list change happens at most once per tool. First request with the
  full package: 17.4 KB -> 12.5 KB. `STEAK_PI_DEFER_TOOLS=off` restores
  always-on exposure.
- Without an `ultracompress` binary, live transforms no longer spawn a failing
  process per request and neither UltraCompress tool is exposed.
- USAP workers reuse the host CLI's bundled Pi SDK (supported Pi versions only)
  instead of importing a second copy of Pi and its dependencies on the first
  dispatch. `STEAK_PI_WORKER_SDK=unbundled` restores the old path.
- USAP session scheduler now honours `usap-caps.json` `session.global`
  (default 14 = 8 ZAI + 6 Codex); it was built with the per-run cap of 8.
- `steak-pi run [pi args]` launches pi with Node defaults (compile cache,
  `MALLOC_ARENA_MAX=2`, `--max-semi-space-size=2`), each only when unset;
  `steak-pi env` prints them.
- Results versus 0.6.0 (full package loaded, same Pi, same fixtures):
  - one-shot edit: 0.99 s / 148 MB -> 0.77 s / 118 MB (`run`: 0.70 s / 100 MB);
    stock Pi 0.64 s / 117 MB
  - 8-worker USAP fan-out: 3.24 s / 223 MB -> 1.22 s / 153 MB
    (`run`: 1.13 s / 125 MB)
  - idle TUI PSS: 1 session 150 -> 113 MB; 10 sessions 879 -> 559 MB
    (548 MB via `run`; stock Pi 116 / 618 MB)

## 0.6.0 — 2026-09-20 (USAP 1.2)

- Release date: 2026-09-20. Targets Pi 0.86.0 and retains the 0.85.1 peer range;
  final hardening verification is scoped to 0.86.0. No multi-hour endurance run
  was performed: the 8-hour worker value is a configurable deadline ceiling.
- Distribution: install from the `v0.6.0` git tag or the GitHub release archive
  (`steak-pi-0.6.0.tgz` + `.sha256`). The package is not published to the npm
  registry, and the private Implose Cybernetics Homebrew tap remains a channel
  for already-authorized operators only. Generated package archives and raw
  internal verification logs are no longer tracked in the tree.
- Bind subagent tools, callbacks, results, receipts and checkpoints to the captured native session identity. Foreign or ambiguous records do not attach automatically.
- Keep work running when a session switch or fork is cancelled; interrupt only at committed shutdown.
- Make Todo persistence session-private within a shared workspace; retain legacy files without importing another session's plan.
- Keep tool-result timers as recorded progress snapshots and live elapsed time in the pinned panel, avoiding timer-driven offscreen redraws.
- Default run deadline remains 10 minutes; maximum becomes 8 hours. Per-child
  `maxTurns` defaults to 64 and accepts 1–2,048 assistant turns.
- Enable native worker compaction with at most one native retry. Include recorded
  summary-call usage in worker totals; disable auxiliary cache-warming requests.
- Checkpoint runs and native worker history per persistent parent session. Host
  exit interrupts execution; explicit hub `resume` continues unfinished tasks
  only in a new run with fresh budgets. No automatic restart, daemon, or
  cross-host failover. Memory-only parent sessions have no durable recovery.
- Add hub `diagnose` for bounded failure, budget, progress and persistence metadata.
- Deliver background completion passively at the idle boundary, without an added
  model call; render compact terminal cards with expandable task evidence.
- Reconcile capacity documentation with provider-bucketed defaults; preserve
  explicit routing and parent-owned integration/verification boundaries.

## 0.5.5

- Release date: 2026-09-15.
- Ship the `steak-pi` updater CLI (`bin/steak-pi`): Homebrew-managed installs
  upgrade through `brew` and keep the pi-side package on the same release;
  git installs re-pin to the latest published GitHub release.
- Add a Homebrew distribution channel under Implose Cybernetics
  (`brew install michael-berardi/implose-software-distribution/steak-pi`) for
  operators already authorized on that private tap; the public install path
  remains the git tag or a release archive.
- Document the Homebrew install/update path in the README and keep the
  install line on the current release.

## 0.5.4

- Release date: 2026-09-12.
- Guarantee a FINAL REPORT on every worker settlement: turn-limit exhaustion,
  cancellation, timeout, and error outcomes now synthesize a status envelope with
  the worker's changed-path journal and last step — "(no output)" can no longer be
  a terminal result after edits landed on disk.
- Worker task briefs state the actual toolset: when bash is not granted, children
  are told validation belongs to the parent, ending silent no-shell assumptions.
- Dispatch results carry a per-task permission/model summary (role, mayEdit,
  allowBash, owned-path count, resolved route, selection source) so parents can
  immediately verify what took effect; validation failures return bounded
  field-path diagnostics instead of echoing the full arguments payload.
- Harden explicit model/profile overrides: the resolved selection must carry
  override provenance, guarding against intermittent profile-default fallbacks.

## 0.5.3

- Release date: 2026-09-12.
- Add two-tier skill-catalog-lite: preserve full catalogs within the default
  8,192-byte budget; above it, retain names, paths, and shortened triggers for
  on-demand SKILL.md reads. Add environment configuration and disable controls;
  the synthetic 77-skill fixture reduces the catalog section by 81.4%.
- Raise default UltraCompress UC/snap thresholds to 8,192 characters and exempt
  fresh bash results by default, alongside fresh reads. Emit 72-character archive
  markers while accepting old long markers; default recall excerpts to their
  4,000-byte maximum. Cap automatic-compaction summaries at 16,384 UTF-8 bytes
  by default, including previous summaries; explicit compaction stays uncapped.
- Debounce verification until 500 ms after the latest edit in a batch; rerun
  after edits arriving during a successful check. Append success receipts with
  command, working-subtree fingerprint (or unavailable), and duration; flag tree
  changes during verification and retain bounded failure repair output.
- Add atomic, ordered todo bulk transitions through items for start, done, drop,
  block, unblock, and rm; reject mixed bulk and task/phase selectors.
- Tighten USAP guidance on 12-turn leaf sizing, supplied evidence reuse, batched
  inspection, avoiding identical repeated calls, and parent-only integrated checks.
- Resolve missing worker Pi peers from the actual running host entrypoint when
  local resolution fails; retain errors for broken local exports and never
  install dependencies or change model routes automatically.

## 0.5.2

- Verify primary-host ownership using the managed TUI context, pane terminal
  descriptors, and canonical session path; preserve identity across reloads,
  retry publication, and clear only owned pane bindings.
- Add native UltraTerm inbox delivery with idle gating, bounded Unix-socket
  transport, receipt deduplication, and persisted session evidence before
  recording delivery. Recorded delivery does not prove model-read.
- Fail USAP worker startup early when its own Pi dependencies cannot resolve,
  with actionable repair guidance and no automatic install or model fallback.
- Retain the existing vendored UltraCompress implementation and Pi peer ranges;
  this patch does not upgrade the compaction algorithm.

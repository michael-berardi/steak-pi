# Native worker profiles

Steak Pi selects one harness/model for the whole run.
Native Pi profile selection does not launch another terminal or inherit its
extensions, skills, transcripts or permissions. The explicit `claude-code`
harness uses the official headless CLI instead; see the [capability matrix](./ULTRATERM-SUBAGENT-PROTOCOL.md#harness-selection-13).

## Explicit cross-model dispatch

Any manager can explicitly select another configured profile:

```json
{
  "goal": "Review the parser change",
  "profile": "steak-pi/reviewer-a",
  "tasks": [{
    "label": "parser-review",
    "role": "reviewer",
    "task": "Review src/parser.ts for correctness and report issues. Do not edit files."
  }]
}
```

The reviewer role does not replace that explicit selection. To choose a
model directly, supply `"model": "provider-x/model-name"` **instead of**
`profile`. Any supported, authenticated native provider/model may be selected;
a model family the operator pinned to one subscription route
(`subscriptionRouteChecks` `modelPattern`) runs only there. Bare model names,
conflicting selectors and unavailable routes fail before launch.

## Per-parent defaults

Steak Pi ships no worker profile and no default chain. Routine workers and
scouts follow the operator's configuration (see
[`MODEL-ROUTING.md`](./MODEL-ROUTING.md)): `workerDefault` / `reviewerDefault`
in `~/.config/ultraterm/routing.json`, then the matching parent profile's
defaults, then the configured `textWorkerChain` for automatic profiles. With
nothing configured an implicit dispatch fails with the key to set; explicit
`model`/`profile`/`harness` selections always work. Profiles come from
`workerProfiles` in routing.json and from harness manifests; the only built-in
profile is the neutral virtual `steak-pi/preferred-free`.

When `implicitReview.route` is configured, all-reviewer waves with no explicit
harness/model/profile run it on the official Claude Code CLI at medium effort (high/xhigh when the dispatch asks with a reason) with
existing subscription authentication on an account the router shows eligible
(the wave pins it, so the review never runs on a spent session login while another
account can take it); only the
[bounded automatic review exception](./MODEL-ROUTING.md#implicit-review) may use
`implicitReview.fallback` when Claude is proven unavailable, including a
recognized quota or auth refusal before model output. Any other Claude
Code wave (`harness: "claude-code"`) runs the model named in `model` or the
operator's `claudeCodeDefaults`. Claude workers get `mayEdit` + `ownedPaths`
(enforced by CLI `Edit(...)` allow rules under `dontAsk`). `allowBash` is
unsandboxed, but read-only Claude reviewers never receive Bash, even when
requested: an explicit `claude-code` dispatch that requests it is refused at
dispatch (`claude-review-shell-refused`); an implicit wave withholds it in the run.
Parents stage git evidence for Read/Grep/Glob. `requireImages: true`
admits native Read-image of files staged under cwd, not inline attachments. Hub
send/redirect steers the existing Claude process through stream-json stdin;
replies use the run-local hub inbox. Native Pi-session resume remains
unsupported; Claude workers can resume their own persisted CLI sessions.
A failed task, including quota exhaustion, is not expert approval.
The explicit `claude-code-api/<model>` routes are separate: the same headless
worker on approved API credits, never a default or fallback, and never offered
as an interactive profile. See [CLAUDE-API-ROUTE.md](./CLAUDE-API-ROUTE.md).

Writable work on a route listed in `verificationGates` is told to request one
bounded verification on the gate's reviewer route through the parent; other
routes and read-only leaves receive no automatic end-gate. Explicit task or
contract output formats override default report headings. USAP never grants
permission to release. Explicit native Pi model/profile selections remain exact,
including image-capable routes selected with `requireImages: true`. The
automatic chain hop applies only to eligible failures before content or tool
activity, never authentication/permission/region errors.

Native profiles are read from `workerProfiles` and from the existing JSON
harness manifests under `~/.config/ultraterm/harnesses/`. A manifest profile
with one explicit `--model provider/model` argument is a native route; CLI-only
profiles are not. Only model, thinking and worker-default metadata are
consumed. Executables, other arguments and credentials are never executed or
copied by this resolver.

The manifest of the harness UltraTerm launched this session is also the picker
scope: native `/model` and the UltraTerm composer list show exactly its exact
`provider/model` profiles that are authenticated and policy-valid, so they agree
with the sidebar profile list and a profile add, rename or removal needs no code
change. When no manifest is readable the pickers keep the previous native
availability instead of hiding every model, and dispatch and fallback eligibility
are never narrowed by the manifest — see [`MODEL-ROUTING.md`](./MODEL-ROUTING.md).

An owner may add these fields to a profile entry to configure routine and
explicitly selected native Pi reviewer work from that parent (`harness: "pi"`):

```json
{
  "id": "manager-a",
  "name": "Manager A",
  "description": "Manager with configured workers",
  "args": ["--model", "provider-x/manager-model", "--thinking", "medium"],
  "workerDefault": {"profile": "steak-pi/worker-a"},
  "reviewerDefault": {"profile": "steak-pi/reviewer-a"}
}
```

Each default contains exactly one model or profile. Defaults resolve once to
the target profile's model, not recursively to its worker defaults. A reviewer
default that names an `autoReviewChain` profile resolves the automatic chain
rather than freezing that profile's head model; only an explicit selector runs
it. Explicit dispatch selectors always win. A parent must still match its launch
profile's model; a later `/model` change cannot retain an unrelated stale
default.

A selected profile supplies its thinking preference; the configured expert
reviewer (`expertReview.thinking`) defaults to medium. Request high/xhigh only
with a concrete `thinkingReason`. Existing native capability and billing
safeguards apply regardless of profile metadata.

## Worker lifecycle

Model/profile selection does not alter budgets: `timeoutMs` defaults to 10
minutes (1 second–8 hours), and `maxTurns` defaults to 64 (1–2,048 assistant
turns per task). Pi workers use native compaction and at most one native retry;
this is distinct from subscription route fallback. CLI workers never silently
replay a partial conversation.

A worker that fails on a transient fault (network drop, provider stream cut or
stall, Claude CLI stream cut or process death, overload, rate limit) resumes its
own persisted session automatically: at most twice, after a 10 s to 2 min
backoff, and only with at least 90 s of run budget left. It continues with a
short continuation prompt and its original permissions, so finished tool calls
are not redone; usage and turns carry across attempts and each resume is listed
on the task (`autoResumes`). Deadlines, turn limits, content filters, route or
policy refusals and cancellations are never resumed automatically.

Persistent parent sessions retain private run and native worker checkpoints.
Hub `diagnose` exposes bounded metadata, not worker transcripts. Explicit
`resume` creates a new run for unfinished tasks on the original model/reasoning
route, rechecking availability and authorization with fresh budgets; completed
tasks are not replayed. Apart from the transient-fault resume above there is no
automatic restart, and no detached daemon.
Background completion is passive at idle, with no added model call.

## Evidence and activation

Inspect `details.run.model` and `details.run.selection` in dispatch and hub
results. Selection reports provider, modelId, profile when supplied, matched
parentProfile, source (`override`, `chain`, `profile-default`, `legacy-default`,
`automatic-review`, or `automatic-review-fallback`), and
image/tool-adapter capabilities. Session telemetry records the same provenance
without prompts or outputs. Task evidence includes `toolSuccesses` and
`toolErrors`; done status is not parent acceptance.

Use `requireImages: true` whenever image inspection is part of acceptance.
Advertised capability is checked before launch; actual image/tool behavior
must also be verified against artifacts. Missing capability never causes a
silent model substitution.

These behaviors describe this checkout (checkpoint privacy dates to 0.6.0);
they are not a promise of verified end-to-end recovery in every
environment. Persistent parent sessions keep run and
worker checkpoints private to that session, and the 8-hour ceiling is a deadline
setting rather than an endurance guarantee: host exit interrupts workers, and no
automatic restart or detached daemon exists. Existing sessions retain their loaded
schemas until an operator-coordinated activation. Never overwrite a running
runtime tree or replace sessions to make a new selector appear.

### Approved temporary free preference

`steak-pi/preferred-free` is a stable native Pi **virtual** profile: while the
operator's temporary-route configuration is active, each model call observes the
current bounded approved `:free` preference of the free-tier adapter, with
lazily fetched/cached official zero-price text/tool/reasoning metadata. A
configured worker profile whose model is exactly that free route may be named
instead. Expiry/revocation or ineligible metadata raises
`TEMPORARY_FREE_ROUTE_RETURN_TO_NORMAL`; the backend must checkpoint/switch a
quiet settled job through its normal account ownership and lease path, never
dispatch an unleased subscription model from this virtual namespace. This is
also the selected profile for ordinary implicit text workers while the temporary
configuration is active; reviewers, image requirements and explicit selections
keep their existing semantics. Physical assistant-message receipts, not the
selected virtual profile or config status, prove which model actually answered.
See [temporary free routing](./MODEL-ROUTING.md#temporary-approved-free-workers).

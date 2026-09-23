# Native worker profiles

Steak Pi 0.8.0 candidate (USAP 1.3) selects one harness/model for the whole run.
Native Pi profile selection does not launch another terminal or inherit its
extensions, skills, transcripts or permissions. The explicit `claude-code`
harness uses the official headless CLI instead; see the [capability matrix](./ULTRATERM-SUBAGENT-PROTOCOL.md#harness-selection-13).

## Explicit cross-model dispatch

An Astra manager can select the existing GLM profile:

```json
{
  "goal": "Inspect a rendered asset",
  "profile": "steak-pi/glm-5-3-flash",
  "requireImages": true,
  "tasks": [{
    "label": "visual-review",
    "role": "reviewer",
    "task": "Read the render image in the project and report observable issues. Do not edit files."
  }]
}
```

The reviewer role does not replace that explicit GLM selection. To choose a
model directly, supply `"model": "openai-codex/gpt-6-astra"` **instead of**
`profile`. Any supported, authenticated native provider/model may be selected;
GPT models always require the paid Codex OAuth route. Bare model names,
conflicting selectors and unavailable routes fail before launch.

## Per-parent defaults

Routine workers on every built-in parent profile default to **MiMo V2.6 Pro** on the Xiaomi Token Plan, with **GLM 5.3 Flash on the ZAI coding subscription** as the only automatic fallback. The main app also defaults to MiMo V2.6 Pro. Explicitly native-Pi reviewer runs (`harness: "pi"` or an explicit native model/profile) resolve the same automatic MiMo→ZAI chain: no expert model is ever selected automatically in the native review chain, and the shipped "expert review chain" label is a legacy native-Pi routing flag, not expert sign-off.

All-reviewer waves with no explicit harness/model/profile use the **Opus Pass**:
`claude-code/claude-opus-5-5`, official Claude Code CLI, `xhigh` effort and
existing subscription authentication. No silent fallback is allowed. Expert
planning may select that same harness explicitly. This first CLI slice is
read-only and refuses image admission, shell, editing, relay and worker resume.
A failed or quota-blocked review is not expert approval.

Before commit/push/deploy, weaker implementers request one bounded Opus Pass
through the parent. USAP never grants permission to release. Explicit native Pi
model/profile selections remain exact, including image-capable routes selected
with `requireImages: true`. Pi's subscription fallback applies only to eligible
failures before content or tool activity, never authentication/permission/region
errors and never to the CLI route.

Native profiles are read from the existing JSON harness manifests under
`~/.config/ultraterm/harnesses/`. A profile with one explicit
`--model provider/model` argument is a native route; CLI-only profiles are not.
Only model, thinking and worker-default metadata are consumed. Executables,
other arguments and credentials are never executed or copied by this resolver.
The built-in routes also work when that directory is absent.

The manifest of the harness UltraTerm launched this session is also the picker
scope: native `/model` and the UltraTerm composer list show exactly its exact
`provider/model` profiles that are authenticated and policy-valid, so they agree
with the sidebar profile list and a profile add, rename or removal needs no code
change. When no manifest is readable the pickers keep the previous native
availability instead of hiding every model, and dispatch and fallback eligibility
are never narrowed by the manifest — see [`MODEL-ROUTING.md`](./MODEL-ROUTING.md).

An owner may add these fields to a profile entry to configure GLM for both
routine and explicitly selected native Pi reviewer work from that parent
(`harness: "pi"`). These native defaults do not replace the new automatic
all-reviewer Opus Pass:

```json
{
  "id": "gpt-6-astra",
  "name": "GPT-6 Astra",
  "description": "Paid Codex manager with GLM workers",
  "args": ["--model", "openai-codex/gpt-6-astra", "--thinking", "medium"],
  "workerDefault": {"profile": "steak-pi/glm-5-3-flash"},
  "reviewerDefault": {"profile": "steak-pi/glm-5-3-flash"}
}
```

Each default contains exactly one model or profile. Defaults resolve once to
the target profile's model, not recursively to its worker defaults. A reviewer
default that names the Astra profile resolves the automatic subscription chain
rather than freezing the scarce Astra expert model; only an explicit selector
runs it. Explicit dispatch selectors always win. A parent must still match its
launch profile's model; a later `/model` change cannot retain an unrelated
stale default.

A selected profile supplies its thinking preference. Astra defaults to medium;
request high/xhigh only with a concrete `thinkingReason`. Existing native
capability and billing safeguards apply regardless of profile metadata.

## Worker lifecycle

Model/profile selection does not alter budgets: `timeoutMs` defaults to 10
minutes (1 second–8 hours), and `maxTurns` defaults to 64 (1–2,048 assistant
turns per task). Pi workers use native compaction and at most one native retry;
this is distinct from subscription route fallback. CLI workers never retry or
silently replay a partial conversation.

Persistent parent sessions retain private run and native worker checkpoints.
Hub `diagnose` exposes bounded metadata, not worker transcripts. Explicit
`resume` creates a new run for unfinished tasks on the original model/reasoning
route, rechecking availability and authorization with fresh budgets; completed
tasks are not replayed. There is no automatic restart or detached daemon.
Background completion is passive at idle, with no added model call.

## Evidence and activation

Inspect `details.run.model` and `details.run.selection` in dispatch and hub
results. Selection reports provider, modelId, profile when supplied, matched
parentProfile, source (`override`, `chain`, `profile-default`, or `legacy-default`), and
image/tool-adapter capabilities. Session telemetry records the same provenance
without prompts or outputs. Task evidence includes `toolSuccesses` and
`toolErrors`; done status is not parent acceptance.

Use `requireImages: true` whenever image inspection is part of acceptance.
Advertised capability is checked before launch; actual image/tool behavior
must also be verified against artifacts. Missing capability never causes a
silent model substitution.

These behaviors ship in this Steak Pi 0.8.0 candidate (checkpoint privacy dates
to 0.6.0); they are not a promise of verified end-to-end recovery in every
environment. Persistent parent sessions keep run and
worker checkpoints private to that session, and the 8-hour ceiling is a deadline
setting rather than an endurance guarantee: host exit interrupts workers, and no
automatic restart or detached daemon exists. Existing sessions retain their loaded
schemas until an operator-coordinated activation. Never overwrite a running
runtime tree or replace sessions to make a new selector appear.

# Native worker profiles

Steak Pi 0.6.0 (USAP 1.2) selects one native model for the whole run. Profile selection does not
launch another terminal, CLI, or agent harness, and does not inherit extensions,
skills, transcripts, or permissions from that profile.

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

Built-in defaults use OpenCode Go for routine workers (the user's own Go key is required):

| Parent profile | Routine worker | Reviewer-containing run |
| --- | --- | --- |
| `steak-pi/opencode-go` | `opencode-go/deepseek-v4.1-flash` | `opencode-go/deepseek-v4.1-flash` |
| `steak-pi/glm-5-3-flash` | `opencode-go/deepseek-v4.1-flash` | `opencode-go/deepseek-v4.1-flash` |
| `steak-pi/gpt-6-astra` | `opencode-go/deepseek-v4.1-flash` | `openai-codex/gpt-6-astra` |

Go can retry once on `opencode-go/glm-5.3-flash` after a transient failure before
visible output. Authentication, billing, and region errors never trigger fallback.
For image inspection, explicitly select an authenticated image-capable route with
`requireImages: true`; Go's bundled primary is text-only.

Native profiles are read from the existing JSON harness manifests under
`~/.config/ultraterm/harnesses/`. A profile with one explicit
`--model provider/model` argument is a native route; CLI-only profiles are not.
Only model, thinking and worker-default metadata are consumed. Executables,
other arguments and credentials are never executed or copied by this resolver.
The built-in routes also work when that directory is absent.

An owner may add these fields to a profile entry to configure GLM for both
routine and reviewer work from that parent:

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
the target profile's model, not recursively to its worker defaults. Explicit
dispatch selectors always win. A parent must still match its launch profile's
model; a later `/model` change cannot retain an unrelated stale default.

A selected profile supplies its thinking preference. Astra defaults to medium;
request high/xhigh only with a concrete `thinkingReason`. Existing native
capability and billing safeguards apply regardless of profile metadata.

## Worker lifecycle

Model/profile selection does not alter budgets: `timeoutMs` defaults to 10
minutes (1 second–8 hours), and `maxTurns` defaults to 64 (1–2,048 assistant
turns per task). Workers use native compaction and at most one native retry;
this is distinct from the Go route fallback described above.

Persistent parent sessions retain private run and native worker checkpoints.
Hub `diagnose` exposes bounded metadata, not worker transcripts. Explicit
`resume` creates a new run for unfinished tasks on the original model/reasoning
route, rechecking availability and authorization with fresh budgets; completed
tasks are not replayed. There is no automatic restart or detached daemon.
Background completion is passive at idle, with no added model call.

## Evidence and activation

Inspect `details.run.model` and `details.run.selection` in dispatch and hub
results. Selection reports provider, modelId, profile when supplied, matched
parentProfile, source (`override`, `profile-default`, or `legacy-default`), and
image/tool-adapter capabilities. Session telemetry records the same provenance
without prompts or outputs. Task evidence includes `toolSuccesses` and
`toolErrors`; done status is not parent acceptance.

Use `requireImages: true` whenever image inspection is part of acceptance.
Advertised capability is checked before launch; actual image/tool behavior
must also be verified against artifacts. Missing capability never causes a
silent model substitution.

These behaviors ship in Steak Pi 0.6.0; they are not a promise of verified
end-to-end recovery in every environment. Persistent parent sessions keep run and
worker checkpoints private to that session, and the 8-hour ceiling is a deadline
setting rather than an endurance guarantee: host exit interrupts workers, and no
automatic restart or detached daemon exists. Existing sessions retain their loaded
schemas until an operator-coordinated activation. Never overwrite a running
runtime tree or replace sessions to make a new selector appear.

# Model routing

Steak Pi keeps the parent model selected by the operator. GPT-family requests
require `openai-codex`, OAuth subscription credentials, the Codex Responses API,
and the official HTTPS `chatgpt.com/backend-api` endpoint. OpenRouter, generic
OpenAI API-key billing, custom endpoints, and batch GPT variants are rejected.
The parent session has no provider fallback. Child worker runs have exactly one
ordered automatic chain (below); every other selection is exact.

## Explicit paid Inco profile

The user-owned `~/.pi/agent/paid-routes.json` must contain:

```json
{"version":1,"allow":[{"provider":"inco","model":"glm-5.3-flash:fast","baseUrl":"https://api.inco.ai/v1"}]}
```

Launch that exact selected model with the extension flag
`--steak-pi-paid-route=inco/glm-5.3-flash:fast`. Both the flag and allowlist are
required; this narrow exception only supports that Inco product and exact URL
(no trailing slash, query, alternate endpoint, or model alias). Permission is
captured from the selected model at session start. Switching away does not
approve another route; returning to the same route and compaction on that route
retain approval. Reloading captures the then-selected model again. The file is
re-read at request dispatch so deleting or editing the entry revokes permission.

This is intentional direct paid selection, independent of Go quota. It neither
creates quota-exhaustion evidence nor changes worker defaults. Worker runtime
guards do not receive the parent launch permission, even when reusing a provider
previously guarded for the parent. GPT-family restrictions remain mandatory.
Automatic metered requests while Go is configured still require the existing
strict, short-lived, credential-bound quota evidence; unknown quota, outages,
and authentication failures do not grant access. Xiaomi's dedicated Singapore Token Plan endpoint is a prepaid subscription, not its separate pay-as-you-go API. It does not need a paid-route grant. General Xiaomi API endpoints remain metered and guarded. A parent session's Inco approval never widens worker permissions.

Policy denials use a deterministic message without transient-status keywords.
Pi's native retry classifier treats this denial as nonretryable; real transient
provider failures retain the existing retry behavior.

## Native USAP 1.1 selection

Each run uses one frozen model for all its tasks. Set **either** `model` to an
exact authenticated `provider/model` or `profile` to a native `harness/profile`
route. Explicit selection takes precedence over roles and defaults, including
reviewers, and is **exact**: an explicitly chosen route never gains
cross-provider spending, even when the chosen route happens to be a step of an
automatic chain. For example, an Astra manager can dispatch
`profile: "steak-pi/glm-5-3-flash"`; a GLM manager can explicitly choose an
available paid Codex model; explicitly selecting
`opencode-go/deepseek-v4.1-flash` keeps that route with only OpenCode Go's own
same-plan retry. No CLI is launched to resolve a profile.

Omitting both selectors uses the matching parent profile's `workerDefault`, or
`reviewerDefault` for runs containing reviewers. Profiles that resolve the
built-in `steak-pi/mimo-v2-6-pro` default resolve one **automatic chain** for workers and reviewers and record it as provenance:

- Text and images: `xiaomi/mimo-v2.6-pro` → `zai/glm-5.3-flash`.

The main app also defaults to MiMo V2.6 Pro. Explicitly chosen profiles remain exact; selecting OpenCode Go does not select this cross-provider chain.

The first step that is authenticated, present in the operator's available
catalog, capability-matching, has a native streaming adapter, and is spendable
serves the run. MiMo must use the exact Singapore Token Plan host, with `/v1` or `/anthropic`; ZAI must use its coding subscription endpoint. Lookalike hosts and general paid API endpoints do not qualify. No INCO, OpenRouter, metered/PAYG or GPT-family route is part of this default chain.

A run frozen as an automatic chain may hop to the next eligible chain route at
runtime — this is real routing, not a selection shortcut. The hop happens only
when the attempt fails **before** any content or tool event (a `start` event is
metadata only), the failure is the transient class Go already retries (429,
5xx, rate limit, overloaded, temporary) or a proven exhausted subscription plan
(`subscription_quota_exceeded`), and the caller has not aborted. Same-plan Go
retry deliberately refuses the exhaustion signal, because retrying an exhausted
plan cannot succeed; the chain is the only path that may leave that plan, and
only for the next separately approved subscription route. Auth, permission,
region, context and 400-class failures never hop, whatever transient wording
they carry. The hop stops permanently at the first content/tool event, never
revisits a route (the chain order is monotonic and the failing attempt's own
provider/model identity is recorded), and re-enters the live registry provider
so the metering gate and approval apply to the fallback too. Every forwarded
event keeps the answering provider/model, and each hop is recorded as
`from->to` in `TaskRecord.routeFallbacks`, shown in agent status and bounded session
telemetry. A `model`/`profile` selection, a `profile-default` run, and a resumed
run never install this hop.

Go needs the user's own key and permits one transient-error retry on Go GLM 5.3
Flash before visible output, never for auth, billing, or region errors. A
`/model` change cannot inherit a stale launch profile's defaults. Parents without an explicit profile default use the same MiMo → ZAI automatic chain, including reviewer runs.

Selection resolves against Pi's configured authentication and available model
catalog, so the catalog must list the route before selection can include it.
Missing models, conflicting selectors, unavailable authentication,
unavailable catalog entries, missing native text/tool adapters, and unapproved
paid steps fail before launch. Set
`requireImages: true` for visual critics and render inspection: models without
advertised image input are rejected. Tool-adapter availability is a preflight
check, not a guarantee that every provider/model accepts every tool schema;
actual worker tool results remain visible.

Dispatch receipts, hub results, and bounded session telemetry carry the resolved
provider/model, selected profile when supplied, parent profile when matched,
`override`/`chain`/`profile-default`/`legacy-default` provenance, the ordered
`chainRoutes` of an automatic chain, capabilities and effort.
Task results report native tool successes and errors. If every attempted tool
fails, a prose completion cannot mark the task successful.

Astra workers default to **medium** reasoning, even when the parent is running
at high or xhigh. Explicit `thinking: "high"` or `"xhigh"` is supported with a
concrete task benefit in `thinkingReason`. Reviewer role alone does not raise
effort. Other models preserve their inherited reasoning level unless explicitly
overridden. This is a latency-conscious default, not a claim of universally
equivalent benchmark performance.

`extensions/model-route-policy.ts` composes native provider wrappers through
Pi's supported registry API. The wrapper checks the resolved model immediately
before stream/deferred execution, after auth endpoint resolution. A throw at
this boundary becomes a failed request. It does **not** use a throwing
`before_provider_request` hook: Pi intentionally catches those hook errors and
continues. Session start, model changes, pre-turn, and compaction refresh wrapper
registration without stacking unchanged wrappers. If a configuration reload
introduces a different API, the current composed provider is guarded again.
USAP also checks the route before child creation and installs the same wrappers
in each isolated child runtime, reapplying after session creation and before
every controlled turn to cover refreshed API definitions without wrapper stacking.

The base catalog retains its real API coverage: Pi uses that catalog to choose
between provider execution and a global API fallback. Removing forbidden models
there would let configuration-only providers bypass the guard. Forbidden routes
are instead removed by the availability filter, with dispatch assertions as the
authoritative boundary. An all-model listing may still show unavailable routes.

## Picker availability, hot reload and loaded-agent limits

Native `/model` and the UltraTerm composer list share exactly one source: the native
availability snapshot (`ModelRegistry.getAvailable()` ===
`ModelRuntime.getAvailableSnapshot()`), produced by each provider's `filterModels`.
`guardModelRuntime` applies the shared rule there, and the machine-UI catalog publishes
that same snapshot instead of maintaining a second list. The provider catalog
(`Provider.getModels()`) is never filtered, so dispatch coverage, cost accounting and Pi's
global-API bypass decision stay intact; the published `currentModel` is separate from the
choices, so a running route keeps running and is never re-added as a selectable choice.

The picker scope is curated by the *selected harness*: the one UltraTerm launched this
session (`ULTRATERM_HARNESS_ID` / `ULTRATERM_HARNESS`, `ULTRATERM_HARNESS_DIR`, and the
app-bundled `ULTRATERM_HARNESS_RESOURCES` fallback; live operator manifests live under
`~/.config/ultraterm/harnesses/{harness}.json`). `src/harness-profiles.ts` parses only
exact `--model provider/id` profiles with an explicit valid `--thinking` level, and both
pickers keep exactly those routes of the native snapshot that are authenticated and
policy-valid. The sidebar profile list, native `/model` and the composer therefore show the
same set: adding, renaming or removing a profile needs no code change and no route is
hard-coded. Profile labels and thinking levels are metadata only — tools, system prompts,
extensions, launchers and credentials in a manifest are never executed or transferred.

Unknown metadata fails open. When the selected harness has no readable manifest anywhere
(broken or packaged install, malformed or unreadable file) the scope is unknown and the
previous native availability is kept rather than hiding every model; a manifest that exists
is authority, including one that declares no native route (empty picker, matching the
sidebar). A manifest route the native runtime cannot offer — a removed OpenRouter DeepSeek
Flash route or a policy-refused GPT route — never becomes a choice.

Dispatch stays unfiltered. Curation lives only in the picker snapshot; `Provider.getModels()`
/ `ModelRuntime.getModels()` keep every route, and ordered-chain membership plus USAP worker
preflight check that published dispatch catalog (`registry.getAll()`) instead of the curated
choices, so a fallback step such as `opencode-go/glm-5.3-flash` remains eligible even when
the operator did not list it as a separate picker profile. A standalone Steak Pi run without
the UltraTerm launcher metadata, and every route a manifest does not configure, keeps its
normal authentication and dispatch behavior.

The OpenRouter DeepSeek V4 Flash / V4.1 Flash line is removed entirely from both pickers —
canonical `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4.1-flash`, the released
`-0731` and `:batch` forms, the `~deepseek/…-latest` aliases and the unversioned
`DeepSeek Flash Latest` — because `opencode-go/deepseek-v4.1-flash` (Go Flash) and
`inco/deepseek-v4.1-flash:fast` (INCO Fast) already cover that capability. The rule is
provider-scoped (`provider === "openrouter"`) and slug-exact, so `deepseek-v4-pro` /
`-0813` / `:batch`, the `-vision-exp` capability variants, unrelated OpenRouter models
(`deepseek-chat`, `deepseek-r1`, `deepseek-v3.2`, `~z-ai/glm-flash-latest`, …) and every
other provider keep every route they have. No provider is hidden wholesale and no substring
match can reach another provider's route.

Hot reload: `createConfigRefresher` polls `models.json`, `auth.json`,
`models-store.json` and the selected harness manifest (mtime/size) and re-applies the native
registry with `allowNetwork:false` once per observed revision. Adding, renaming or removing a
configured provider/model or harness profile, and adding or removing a credential,
therefore reach both pickers in an already-running session without a restart, with no
inference, no model switch and no network work. Malformed, slow or aborted config keeps the
last good publication and backs off; a partial/error native snapshot is never published
over it.

Limits of already-loaded agents: this is loaded extension code. A Pi process or session
that started before this rule was installed keeps the previous availability — the guard is
applied when providers are composed and when the registry is refreshed, never
retroactively to code already running — so the removal is visible only after that session
restarts. Hot reload propagates *configuration*, never *code*. Native launch/CLI model
scope, the parent's stale `enabledModels` cleanup and sub-agent session scope are
parent-side concerns and are not changed here.

## Boundaries

UltraTerm's managed Pi launcher also loads this policy extension (without the
Steak Pi TUI). Managed launchers refuse to start if their required extension is
missing. Existing user-owned executables are not overwritten.

This is a guardrail inside the loaded runtime, not an OS/network
sandbox. Disabling the policy extension, executing a separate unguarded CLI,
or privileged code replacing providers can bypass it. UltraTerm separately
validates explicit profile launch arguments; that validation alone cannot
inspect every arbitrary external CLI's private configuration. Do not describe
launch-only validation as universal request enforcement.

## Verification

`test/model-route-policy.test.ts` proves family matching, provider and endpoint
denials, OAuth checks at execution time, zero delegate calls on denial,
registration idempotence/API changes, the ordered chain and catalog/approval
gating, and the pre-output hop against the SDK's own pi-ai event streams: a
before-output transient failure or proven plan exhaustion serves from the next
eligible route with the answering provider/model preserved, while content and
tool events, aborts, auth/permission/region/context failures, unapproved or
off-plan routes, and generic metered endpoints never hop or spend.
`test/subagent-pi-worker.test.ts` proves the hop is installed only for
`source: "chain"` runs (an explicit chain-step route gets none) and that each
hop is recorded as `from->to` provenance. `test/opencode-go-routing.test.ts`
proves the same-plan Go retry still refuses the exhaustion signal.
`test/subagent-model-selection.test.ts` and `test/model-selection-override.test.ts`
prove chain/override provenance, reviewer defaults, and that an explicit
selector is never upgraded into chain provenance.
`test/model-route-native.test.ts` uses isolated homes and a loopback server to
prove zero requests for forbidden extension, models.json, model-level API changes,
and friendly-alias routes, plus allowed GLM-style dispatch with an intact image URL.
Each fixture asserts the SDK's actual selected API, not merely its JSON input.
`test/model-visibility.test.ts` drives the real Pi 0.87 `ModelRuntime`/`ModelRegistry`
without network, with `HOME`/`PI_CODING_AGENT_DIR` isolated and ambient provider credentials
cleared so the operator's live auth and manifests cannot decide an assertion: it proves the
OpenRouter DeepSeek Flash routes are gone from the native availability snapshot while the
provider catalog keeps them, that Go/INCO and other providers are untouched, that the
curated harness scope is the only picker source, that unknown metadata keeps the full native
catalog, that a manifest with no native route is an empty picker, that `catalogModels`
publishes exactly `getAvailableSnapshot()` after a config add, label/id rename, provider
removal and credential removal, and that the unfiltered dispatch catalog still serves the
chain fallback. `test/model-profile-catalog.test.ts` covers profile additions, removals and
renames for the sidebar list and the shared scope plus the native/composer/sidebar equality.
Allowed live probes remain a separate release check. Production
failures must never trigger OpenRouter GPT fallback.

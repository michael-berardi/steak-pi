# Model routing

Steak Pi keeps the parent model selected by the operator. GPT-family requests
require `openai-codex`, OAuth subscription credentials, the Codex Responses API,
and the official HTTPS `chatgpt.com/backend-api` endpoint. OpenRouter, generic
OpenAI API-key billing, custom endpoints, and batch GPT variants are rejected;
there is no provider fallback. This verifies the subscription route, not the
account's billing status or entitlement, which the service verifies.

## Native USAP 1.1 selection

Each run uses one frozen model for all its tasks. Set **either** `model` to an
exact authenticated `provider/model` or `profile` to a native `harness/profile`
route. Explicit selection takes precedence over roles and defaults, including
reviewers. For example, an Astra manager can dispatch
`profile: "steak-pi/glm-5-3-flash"`; a GLM manager can explicitly choose an
available paid Codex model. No CLI is launched to resolve a profile.

Omitting both selectors uses the matching parent profile's `workerDefault`, or
`reviewerDefault` for runs containing reviewers. Built-in Astra defaults remain
Luna for routine work and Astra for review; GLM remains GLM. A `/model` change
cannot inherit a stale launch profile's defaults. Unmapped profiles retain the
legacy role policy. See [profile metadata and examples](./PROFILES.md).

Selection resolves against Pi's configured authentication and available model
catalog. Missing models, conflicting selectors, unavailable authentication,
and missing native text/tool adapters fail before launch. Set
`requireImages: true` for visual critics and render inspection: models without
advertised image input are rejected. Tool-adapter availability is a preflight
check, not a guarantee that every provider/model accepts every tool schema;
actual worker tool results remain visible. No fallback is selected.

Dispatch receipts, hub results, and bounded session telemetry carry the resolved
provider/model, selected profile when supplied, parent profile when matched,
`override`/`profile-default`/`legacy-default` provenance, capabilities and effort.
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
registration idempotence/API changes, and Luna/frontier/GLM selection.
`test/model-route-native.test.ts` uses isolated homes and a loopback server to
prove zero requests for forbidden extension, models.json, model-level API changes,
and friendly-alias routes, plus allowed GLM-style dispatch with an intact image URL.
Each fixture asserts the SDK's actual selected API, not merely its JSON input.
Allowed live probes remain a separate release check. Production failures must never trigger OpenRouter GPT fallback.

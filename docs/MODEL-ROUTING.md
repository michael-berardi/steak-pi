# Model routing

Steak Pi keeps the parent model selected by the operator. GPT-family requests
require `openai-codex`, OAuth subscription credentials, the Codex Responses API,
and the official HTTPS `chatgpt.com/backend-api` endpoint. OpenRouter, generic
OpenAI API-key billing, custom endpoints, and batch GPT variants are rejected;
there is no provider fallback. This verifies the subscription route, not the
account's billing status or entitlement, which the service verifies.

Routine USAP runs (scout/worker roles only) from a GPT parent select
`openai-codex/gpt-5.6-luna`. Runs containing a reviewer retain the parent model.
The run has one explicit model so existing usage and telemetry remain accurate.
Missing Luna or subscription credentials fails the run rather than silently
spending on another provider. A GLM parent remains GLM, with image capabilities
unchanged. To reserve frontier judgment, put it in a reviewer run.

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

# Model routing

Steak Pi is provider-neutral. It ships **no** model id, fallback chain, provider
preference, worker profile, expert reviewer, paid-route grant or retired-model
list of its own. Every routing choice is operator configuration, read from two
user-owned files:

| File | Override | Carries |
| --- | --- | --- |
| `~/.config/ultraterm/routing.json` | `STEAK_PI_ROUTING_CONFIG` | role defaults, chains, profiles, expert reviewer, quota tiers, subscription endpoints, Claude tiers, labels |
| `~/.pi/agent/paid-routes.json` | `STEAK_PI_PAID_ROUTES` | the reviewed paid-route catalog and the operator's allowlist |

A missing file is an empty configuration: the tool starts, every explicit
`model`/`profile`/`harness` selector works, and nothing is spent on a metered
route the operator has not reviewed and allowed. An **implicit** dispatch that
needs a chain nobody configured fails with the key to set, for example
`No text worker chain configured: set textWorkerChain in ~/.config/ultraterm/routing.json.`
A malformed file fails the routing decision that needs it with a
`RoutingConfigError` naming the key; it never fails at import time. Files are
re-read when their identity changes, so edits apply without a restart.

The parent session keeps the model the operator selected and has no provider
fallback. Child worker runs have exactly one ordered automatic chain (the
operator's); every other selection is exact.

## routing.json

Every key is optional. Routes are exact `provider/model` strings (split at the
first `/`, so model ids may contain slashes). Regular expressions are
JavaScript sources, case-insensitive unless noted. Unknown keys are ignored
(other UltraTerm tools share the file).

```jsonc
{
  // Role defaults (unchanged since USAP 1.1): a model or profile selector.
  "workerDefault": { "profile": "steak-pi/worker-a" },
  "reviewerDefault": { "profile": "steak-pi/reviewer-a" },

  // Automatic chains, in order. Implicit text workers walk textWorkerChain; image
  // workers (requireImages with no selector) walk multimodalWorkerChain.
  "textWorkerChain": ["provider-a/model-name", "provider-b/model-name"],
  "multimodalWorkerChain": ["provider-c/vision-model"],

  // Profile whose metadata (thinking) applies when an implicit wave must leave an
  // exhausted provider and re-resolve textWorkerChain.
  "defaultChainProfile": "steak-pi/worker-a",

  // Automatic profiles whose head keeps its own chain instead of the default one:
  // text runs [head, ...then], image runs [head, ...multimodalThen].
  "tokenPlanChainHeads": [
    { "head": "provider-d/plan-model", "then": ["provider-b/model-name"], "multimodalThen": [] }
  ],
  // Head of the native reviewer chain when the profile head keeps no chain of its own.
  "reviewerChainHead": "provider-d/plan-model",

  // The scarce expert reviewer: preferred by legacy reviewer selection, at its own
  // default effort, and only on its exact identity.
  "expertReview": {
    "model": "provider-x/expert-model", "thinking": "medium",
    "requireOAuth": true, "api": "provider-x-api", "baseUrl": "https://expert.example/api"
  },

  // Worker profiles (same shape harness manifests resolve to). autoChain: an
  // implicit run resolves the final chain instead of the profile head;
  // autoReviewChain: reviewer defaults do the same.
  "workerProfiles": [
    { "id": "steak-pi/worker-a", "model": "provider-a/model-name", "thinking": "high", "autoChain": true,
      "workerDefault": { "profile": "steak-pi/worker-a" }, "reviewerDefault": { "profile": "steak-pi/reviewer-a" } }
  ],

  // Retired selectors and identities, refused with RetiredModelSelectionError and
  // the message ({route} is replaced). selectorsOnly: refuse only where the route is
  // named as a dispatch or role-default selection, never in a catalog or identity.
  "retiredModelPatterns": [
    { "pattern": "(?:^|/)old-model(?:$|[-:/])", "message": "{route} was retired; select provider-a/model-name explicitly." }
  ],
  // First-party steak-pi harness profile ids dropped from a live manifest merge.
  "retiredProfiles": ["old-profile"],

  // Model metadata injected into a native provider's catalog (missing ids only),
  // registered at startup and in every isolated child runtime.
  "catalogExtras": [
    { "provider": "provider-x", "models": [
      { "id": "new-model", "name": "New Model", "api": "provider-x-api", "baseUrl": "https://provider-x.example/api",
        "reasoning": true, "input": ["text", "image"], "contextWindow": 1000000, "maxTokens": 128000,
        "cost": { "input": 1, "output": 5, "cacheRead": 0.1, "cacheWrite": 1 } }
    ] }
  ],

  // Account-router quota tiers, in fall-through order. quota is the router's provider
  // key; models (optional) limits the tier to exact ids; metered:false = the router has
  // no meter for it (never preflight-gated, only held out after its own refusal).
  // A tier whose quota key is "codex" is account-leased through the router's Codex store.
  "providerQuotaFallback": [
    { "quota": "provider-a", "provider": "provider-a", "label": "Plan A" },
    { "quota": "gateway", "provider": "provider-b", "metered": false, "label": "Gateway" }
  ],

  // Picker-hidden routes: provider-scoped, matched exactly (case-sensitive) against the
  // model's local slug (the id after its last "/"). Dispatch coverage is unchanged.
  "hiddenModelPatterns": [{ "provider": "provider-b", "pattern": "^duplicate-model(?::batch)?$" }],

  // Subscription endpoints (no paid grant needed): https, no port/credentials, exact host,
  // optional exact-case pathPattern; oauth: only with an OAuth credential; exact: no
  // query/fragment. A check with modelPattern also PINS every model whose id or name
  // matches to that exact route (oauth, api, host, path), refusing excludeIdPattern ids.
  "subscriptionRouteChecks": [
    { "provider": "provider-a", "host": "plan.provider-a.example", "pathPattern": "^/v1(?:/|$)" },
    { "provider": "provider-x", "host": "provider-x.example", "pathPattern": "^/api/?$", "oauth": true, "exact": true,
      "api": "provider-x-api", "modelPattern": "(?:^|[^a-z0-9])family-x(?:[^a-z]|$)", "excludeIdPattern": "batch" }
  ],
  // While this provider's key is configured and not proven exhausted, metered routes
  // without an explicit grant stay denied ("subscription first"). None: no veto.
  "subscriptionFirstProvider": "provider-a",

  // Claude Code CLI adapter choices (routes are the adapter's pinned claude-code/<model> ids).
  "claudeFallbackTier": { "ordinary": "claude-code/<small-model>", "substantial": "claude-code/<medium-model>" },
  "claudeCodeDefaults": { "worker": "claude-code/<medium-model>", "reviewer": "claude-code/<large-model>" },
  // Implicit all-reviewer waves run route; fallback is the Pi route used only on proven
  // Claude quota/auth unavailability before output (read-only reviewers only).
  "implicitReview": { "route": "claude-code/<large-model>", "fallback": "provider-x/model-name" },

  // Routes whose writable work needs a bounded expert verification through the parent.
  "verificationGates": [
    { "match": "^provider-a/", "reviewer": "claude-code/<large-model>", "fallback": "provider-x/model-name" }
  ],

  // Display names for dispatch notes and receipts.
  "routeLabels": { "provider-a/model-name": "Plan A" }
}
```

What each key replaces, and what happens without it:

| Key | Without it |
| --- | --- |
| `textWorkerChain` / `multimodalWorkerChain` | implicit waves fail with the key to set; explicit selectors work |
| `defaultChainProfile` | the forced re-resolve uses the chain with inherited thinking |
| `tokenPlanChainHeads`, `reviewerChainHead` | every automatic profile and reviewer wave resolves the default chain |
| `expertReview` | no expert preference; reviewers resolve like any role default |
| `workerProfiles` | only the neutral virtual `steak-pi/preferred-free` and harness-manifest profiles exist |
| `retiredModelPatterns`, `retiredProfiles` | nothing is retired |
| `catalogExtras` | provider catalogs are exactly what Pi ships |
| `providerQuotaFallback` | no quota preflight or fall-through walk; routes launch as selected |
| `hiddenModelPatterns` | pickers hide nothing beyond the harness scope |
| `subscriptionRouteChecks` | only local endpoints and the Claude Code CLI adapter are subscription/local; no family is pinned |
| `subscriptionFirstProvider` | no subscription-first veto |
| `claudeFallbackTier` | an implicit wave whose chain is out fails naming every cause |
| `claudeCodeDefaults` | `harness: "claude-code"` needs an explicit `model` |
| `implicitReview` | implicit all-reviewer waves resolve the native reviewer chain |
| `verificationGates` | no worker is told to request a verification |
| `routeLabels` | notes show `provider/model` |

Provider-specific *adapter* code stays: the Claude Code CLI adapter keeps its
own pinned model catalog (`src/subagents/claude-code-models.ts`,
`extensions/claude-code/model-catalog.ts`), the subscription-plan transport
adapter keeps its session headers, the account router keeps its provider keys,
and the temporary free route keeps its official zero-price metadata API. No
default selects any of them; automatic order comes only from the keys above.

## paid-routes.json (version 2)

```json
{
  "version": 2,
  "reviewed": [
    { "provider": "provider-b", "model": "model-name", "baseUrl": "https://gateway.example/api/v1" }
  ],
  "allow": [
    { "provider": "provider-b", "model": "model-name", "baseUrl": "https://gateway.example/api/v1" }
  ]
}
```

`reviewed` **is** the operator's approved paid-route catalog; `allow` is the
granted subset. A route spends only when it is in both, matched exactly
(provider, model id, base URL: a trailing slash, path, port, query or alias is a
different billing target). There is no wildcard and no provider-prefix match.
Version 1 files (`{ "version": 1, ... }`) keep working as before: a v1 allow entry
grants only when the route is also in the reviewed table. A version 1 file may carry
its own `reviewed` array, so one operator file serves both the released 0.17.0 (which
reads only `allow`) and this build; when a version 1 file has no `reviewed` table it is
checked against the operator's catalog file instead. A version 2 file uses only its own
`reviewed` table: without one it reviews nothing and never borrows the catalog. Missing,
malformed, unreadable or unmatched files fail closed. Both tables are re-read on every
decision, so deleting an entry revokes it.

`readApprovedPaidRoutes`, `findPaidRoute`, `isAllowlistedPaidRoute`,
`createAllowlistApproval`, `createSelectedRouteApproval` and
`createExplicitPaidApproval` all read this file. `reviewedPaidRoutes()` returns
the reviewed table; the deprecated `PAID_ROUTES` export is always empty.

Launching with `--steak-pi-paid-route=<provider>/<model>` additionally approves
that exact reviewed, allowed route when it is the model Pi resolved at launch.
Operator `/model` switching approves the selected route while it stays reviewed
and allowed; switching away approves nothing else.

Policy denials use a deterministic message without transient-status keywords, so
Pi's native retry classifier treats them as nonretryable.

## Native USAP selection

Each run uses one frozen model for all its tasks. Set **either** `model` to an
exact authenticated `provider/model` or `profile` to a native `harness/profile`
route. Explicit selection takes precedence over roles and defaults, including
reviewers, and is **exact**: an explicitly chosen route never gains
cross-provider spending, even when it happens to be a step of an automatic
chain. No CLI is launched to resolve a profile.

Omitting both selectors consults `workerDefault` / `reviewerDefault` first, then
the matching parent profile's metadata. An automatic profile (`autoChain`)
resolves the configured chain:

- **Chain selection.** The first step that is authenticated, present in the
  published dispatch catalog (`registry.getAll()`, not the curated picker),
  capability-matching, has a native streaming adapter and is spendable
  (subscription/local per `subscriptionRouteChecks`, or reviewed **and** allowed
  in paid-routes.json) serves the run. The receipt records `source: "chain"` and
  the ordered `chainRoutes`.
- **Quota preflight.** For an *implicit* route (no `harness`/`model`/`profile`/`claudeAccount`)
  the dispatch reads the account router once (`ut-provider-accounts status`) when the
  resolved route is in a metered `providerQuotaFallback` tier. A provider is
  **exhausted** only when every configured account is proven unavailable
  (`state: "cooling-down"` or a live `cooldown.until`, `signedOut`, or a usage window at 100%
  that has not reset). `eligible: true` always wins; busy, unmeasured, unlisted and
  unreadable are **not** exhaustion. An exhausted route is never selected: `textWorkerChain`
  is re-resolved with that provider skipped, and the receipt carries the router cause in
  `selection.fallbackReason`. A parent on another account-leased tier may reach a `codex`-tier
  step through an isolated, router-reserved account store.
- **Claude tier.** When no chain step can launch, an implicit routine text wave (no reviewer,
  no `requireImages`) runs on `claudeFallbackTier` through the
  official Claude Code subscription CLI (medium effort, or the requested high/xhigh) with no parent re-dispatch: `ordinary` for plain leaves,
  `substantial` for a leaf that may both edit and run a shell, a requested high/xhigh effort, or
  a reviewer. The choice reads only declared capabilities, never task text. The worker is pinned
  on a router-eligible Claude account (least-used window, then fewest leases). The run records
  `independence: "requires-opus"` (historical value: it needs an expert verification) and a
  `fallbackReason` naming the tier and each cause. The paid `claude-code-api` route is never a
  fallback.
- **When nothing can launch the dispatch refuses synchronously**, before any checkpoint, relay
  peer or worker exists, naming every cause.
- **Explicit routes stay exact.** An explicit route whose provider the router proves exhausted
  is refused with the router's cause; it is never rerouted.
- **A worker that fails before its first model output fails the dispatch** (router refusal,
  auth, route, spawn, a first request that errors), background or not. The dispatch holds up
  to `startupWindowMs` (default 25000 ms, maximum 30000, `0` disables) for each launched
  worker to produce output or fail; the failed run is marked delivered and its siblings are
  cancelled.
- **A usage-limit refusal before any output falls through to the next tier** for an implicit
  routine wave: a provider's spent-plan wording (`subscription_quota_exceeded`,
  `GoUsageLimitError`, "usage limit has been reached", Pi's "You have hit your ChatGPT usage
  limit", a 402 / insufficient credits / no endpoints found refusal, a "quota exhausted" phrase,
  or a cooling-down router refusal). Every failed worker must carry one; a bare 429, auth,
  route or spawn failure still fails synchronously. The same tasks re-run once on the next
  configured tier; a tier the failed run reached and everything ahead of it is never retried.

A run frozen as an automatic chain step may hop to the next eligible step at
runtime, only when the attempt failed **before** any content or tool event with
a transient or plan-exhausted class, and never for auth, permission, region,
context or 400-class failures. The hop never revisits a route, re-enters the
live registry provider (so metering and approval apply), keeps the answering
provider/model on every event, and is recorded as `from->to` in
`TaskRecord.routeFallbacks`. Explicit, profile-default and resumed runs never hop.

The expert reviewer (`expertReview`) keeps its own default effort (medium unless
configured); explicit `thinking: "high"` or `"xhigh"` needs a concrete
`thinkingReason`. Reviewer role alone does not raise effort. An expert review
that fails is reported, never silently downgraded.

Set `requireImages: true` for visual critics and render inspection: models
without advertised image input are rejected.

### Implicit review

When `implicitReview.route` is set, implicit all-reviewer waves run it on the
official Claude Code CLI at medium effort unless the dispatch asks for high/xhigh with a reason. Only a router status proving every Claude
account ineligible, or a Claude child with a recognized quota/auth failure
**before model output**, may use `implicitReview.fallback` on Pi, and only for
read-only reviewers (no `mayEdit`, `allowBash` or owned paths). Mixed implicit
worker/reviewer waves are rejected. A task records `reviewFallback: {from,to,reason}`
and `routeFallbacks`; a successful fallback review emits
`<label> fallback review: USAP <run-id> receipt=<checkpoint.json> report=<task-id>`.
Receipts mark these runs `automatic-review` / `automatic-review-fallback`, never
`override`, and a resume does not re-arm the fallback.

### Account isolation

Parent/native integration runs `~/.ultraterm/bin/ut-provider-go-materialize`
before dispatch: that separate secure helper projects existing subscription
credentials into private account dirs. Steak Pi and the router never read
credentials. The router command is `~/.ultraterm/bin/ut-provider-accounts` (or
`ULTRATERM_ACCOUNT_ROUTER`); `select --provider <key> --reserve` returns account
+ lease. Each account-leased child binds its lease, creates the SDK session with
an isolated `agentDir` under `~/.ultraterm/provider-accounts/<key>/<id>/agent`,
and releases it in `finally`. Spent plans are reported to the router as
`limit --kind usage`; a bare 429 stays `--kind rate`.

## Provider guard

`extensions/model-route-policy.ts` composes native provider wrappers through
Pi's supported registry API. The wrapper checks the resolved model immediately
before stream/deferred execution, after auth endpoint resolution: retired
identities, pinned families (`subscriptionRouteChecks` `modelPattern`) and the
metered gate. A throw at this boundary becomes a failed request; it does not use
a throwing `before_provider_request` hook (Pi catches those). Session start,
model changes, pre-turn and compaction refresh registration without stacking
wrappers. USAP installs the same wrappers in each isolated child runtime.

The base catalog keeps its real API coverage; forbidden and hidden routes are
removed only by the availability filter, with dispatch assertions as the
authoritative boundary.

## Picker availability, hot reload and loaded-agent limits

Native `/model` and the UltraTerm composer list share exactly one source: the
native availability snapshot (`ModelRegistry.getAvailable()` ===
`ModelRuntime.getAvailableSnapshot()`), produced by each provider's
`filterModels`. The picker scope is curated by the *selected harness*
(`ULTRATERM_HARNESS_ID` / `ULTRATERM_HARNESS`, `ULTRATERM_HARNESS_DIR`, the
app-bundled `ULTRATERM_HARNESS_RESOURCES` fallback, live manifests under
`~/.config/ultraterm/harnesses/{harness}.json`): only exact
`--model provider/id` profiles with an explicit `--thinking` level are routes.
Unknown metadata fails open; a manifest that exists is authority. Operator
`hiddenModelPatterns` and pinned/retired routes never become choices.
Dispatch stays unfiltered: chain membership and worker preflight check the
published dispatch catalog.

Hot reload: `createConfigRefresher` polls `models.json`, `auth.json`,
`models-store.json` and the selected harness manifest and re-applies the native
registry with `allowNetwork:false` once per observed revision. Hot reload
propagates *configuration*, never *code*: a session started before an upgrade
keeps its previous rules until it restarts.

## Temporary approved free workers

The optional operator-owned `~/.config/ultraterm/temporary-worker-route.json`
uses `schemaVersion: 1`, exact `provider`, `model`, `harness`, `profile`, UTC
`startsAt` / `expiresAt` (positive duration, at most 72 hours),
`fallbackHarness: "steak-pi"`, `fallbackProfile` (one of the operator's
configured `workerProfiles`, without the `steak-pi/` prefix),
`zeroPriceOnly: true`, and nonempty `source` / `evidence`. `profile` is
`preferred-free` or a configured worker profile whose model is exactly that free
route. Unknown fields, malformed timestamps, symlinks and unsafe ownership/write
modes are named configuration errors. Only the free-tier adapter's provider and
`:free` ids are supported; fresh official catalog and endpoint metadata must
prove zero pricing and text/tool/reasoning capabilities before any request.

While active, ordinary implicit text workers select the virtual
`steak-pi/preferred-free`, re-read before every model call. When inactive or
ineligible it raises `TEMPORARY_FREE_ROUTE_RETURN_TO_NORMAL` at the model-call
boundary and never borrows ambient subscription credentials. The request guard
enforces the exact free model, `provider.allow_fallbacks: false` and zero
`provider.max_price` fields, and refuses `models`, `route`, plugins, transforms
and web-search options.

## Boundaries

This is a guardrail inside the loaded runtime, not an OS/network sandbox.
Disabling the policy extension, executing a separate unguarded CLI, or
privileged code replacing providers can bypass it.

## Verification

`test/neutral-defaults.test.ts` proves the empty configuration: no chain,
profile, expert, paid route, retirement, catalog extra, hidden model, Claude
tier or Claude default, a clear config-key error for implicit dispatch, and
explicit selectors still served. `test/neutrality.test.ts` scans the shipped
files for concrete model ids and personal names. The behavioral suites
(`test/model-route-policy.test.ts`, `test/subagent-model-selection.test.ts`,
`test/explicit-paid-route.test.ts`, `test/ultraterm-subagents-extension.test.ts`,
…) run against the synthetic operator fixture `test/fixtures/routing.json` and
`test/fixtures/paid-routes.json`, wired by `vitest.config.ts`; they never read
the machine's real configuration.

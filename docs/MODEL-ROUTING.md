# Model routing

Steak Pi is provider-neutral. It ships **no** model id, fallback chain, provider
preference, worker profile, expert reviewer, paid-route grant or retired-model
list of its own. Every routing choice is operator configuration, read from two
user-owned files:

| File | Override | Carries |
| --- | --- | --- |
| `~/.config/ultraterm/routing.json` | `STEAK_PI_ROUTING_CONFIG` | role defaults, chains, profiles (with launch hooks), task classes, expert reviewer, quota tiers, subscription endpoints, Claude tiers, labels |
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
fallback, unless the operator opts into the interactive chain virtual model
(`interactiveChainModel`, below). Child worker runs have exactly one ordered
automatic chain (the operator's); every other selection is exact.

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
      "workerDefault": { "profile": "steak-pi/worker-a" }, "reviewerDefault": { "profile": "steak-pi/reviewer-a" } },
    // A route that needs something running first (an on-demand local model server) is a profile with an
    // ensure hook: argv arrays, no shell. See "Task classes and launch hooks".
    { "id": "steak-pi/local-a", "model": "local-provider/small-model", "thinking": "low",
      "ensure": { "command": ["/opt/tools/model-server", "up"], "release": ["/opt/tools/model-server", "down"], "timeoutMs": 90000 } }
  ],

  // Task classes: the operator's own names (lowercase slugs) for kinds of task, each with the chain that serves
  // it before the default chain. A step is a worker profile id or an exact provider/model route. A task opts in
  // with `taskClass` in its ultraterm_subagents call. Steak Pi ships no class.
  // Optional: rules that give an implicit text task with no taskClass the first matching class (role, mayEdit, allowBash,
  // textPattern; case-insensitive JavaScript regex). Explicit taskClass/model/profile always win. Steak Pi ships none.
  "taskClassRules": [
    { "class": "class-a", "when": { "role": "scout" } },
    { "class": "class-a", "when": { "textPattern": "\\b(write|add)\\b.{0,40}\\btests?\\b" } }
  ],
  "taskClasses": {
    "class-a": { "chain": ["steak-pi/local-a", "provider-a/model-name"], "requiresTestGate": true, "note": "routed on measured test-gated results" },
    // Evidence-driven ranking and self-healing are on whenever a class has priors or recorded evidence.
    // See "Evidence-driven ranking" below for every key.
    "class-b": { "chain": ["provider-b/model-name", "provider-c/model-name"], "timeWeight": 0.0005, "minPassRate": 0.6,
                 "priors": { "provider-b/model-name": { "pass": 9, "n": 10, "costUsd": 0.002, "seconds": 20 } } }
  },

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

  // Opt-in virtual model for interactive slots: one operator-named selection that
  // follows a configured worker chain (default textWorkerChain). Absent: nothing is
  // registered and interactive sessions behave exactly as before. See
  // "Interactive chain virtual model" below.
  "interactiveChainModel": { "provider": "provider-a", "id": "my-chain", "name": "My chain", "chain": "textWorkerChain" },

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
| `workerProfiles[].ensure` | no launch hook runs; a route that needs a server must already be up |
| `taskClasses` | a task's `taskClass` is ignored with a note in the dispatch summary; routing is unchanged |
| `taskClassRules` | a task joins a class only when its caller names `taskClass` |
| `taskClasses.<class>.priors`, recorded evidence | the class chain order serves; no exploration, no demotion, nothing is learned from a class with no evidence |
| `retiredModelPatterns`, `retiredProfiles` | nothing is retired |
| `catalogExtras` | provider catalogs are exactly what Pi ships |
| `providerQuotaFallback` | no quota preflight or fall-through walk; routes launch as selected |
| `hiddenModelPatterns` | pickers hide nothing beyond the harness scope |
| `subscriptionRouteChecks` | only local endpoints and the Claude Code CLI adapter are subscription/local; no family is pinned |
| `subscriptionFirstProvider` | no subscription-first veto |
| `interactiveChainModel` | no virtual model is registered; interactive slots keep today's exact-selection behaviour |
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
  on a router-eligible Claude account (one the router marks `spill.draining` first, then least-used
  window, then fewest leases). The run records
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
  a provider content-filter refusal (an HTTP 400 naming a content-inspection code such as `data_inspection_failed`),
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
official Claude Code CLI at medium effort unless the dispatch asks for high/xhigh with a reason. The wave asks
the router first and **pins an eligible Claude account** for the review, like the implicit worker tier, so a
review never runs on this session's own login while another account can take it; the pin is recorded as an
automatic pick, never as an operator choice. Only a router status proving every Claude account ineligible, a
session login the router proves spent with nothing left to pin, or a Claude child with a recognized quota/auth
failure **before model output**, may use `implicitReview.fallback` on Pi, and only for read-only reviewers (no
`mayEdit`, `allowBash` or owned paths). That pre-output refusal is handled inside the same tool call: the same
review tasks are re-run on the fallback after a fresh router read, the refused run stays failed with its own
cause, and when the fallback cannot launch either, both causes are named. Mixed implicit worker/reviewer waves
are rejected. A task records `reviewFallback: {from,to,reason}`
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

## Task classes and launch hooks

### Task classes

`taskClasses` lets the operator send a kind of task to the route that measured best for it. Each key is a
lowercase slug the operator chose (letters, digits and single hyphens, at most 48 characters); Steak Pi ships
none. A class has an ordered `chain`, an optional `requiresTestGate` and an optional `note`:

- A **chain step** is either a worker profile id (`harness/profile`, from `workerProfiles` or a harness manifest),
  an exact `provider/model` route, or a harness-qualified `steak-dsh/<provider>/<model-id>` route (see
  [Steak DSH harness](#steak-dsh-harness)). A step that is exactly a profile id is that profile's model, with its
  `thinking` and its `ensure` hook; any other step is an exact route. A route that needs a server behind it
  must therefore be named through a profile, which is where the hook lives.
- A step is judged exactly like a `textWorkerChain` step: authenticated, present in the dispatch catalog, a native
  streaming adapter, spendable (subscription/local, or reviewed **and** allowed in paid-routes.json), not vetoed
  by the quota preflight, and its `routeConditions` `onlyWhen` met. A retired route never serves.
- `requiresTestGate: true` records that the class is routed on the evidence that a test gate checks its results.
  The dispatch note and receipt say so, and an editing worker on the route is told to put the outcome of its
  focused check in its report. USAP does not run the gate itself: the parent does, before accepting the work.
- `note` is the operator's own text, echoed in the dispatch note.

A task opts in with the optional `taskClass` field of `ultraterm_subagents`. For an **implicit text worker wave**
whose class is configured, the dispatch walks the class chain first and then falls back to the normal route,
exactly as it would have resolved without a class. The rules around that:

- **One run, one route.** Tasks of one wave cannot name two configured classes (refused before anything starts:
  dispatch each class as its own wave). Tasks that name no class, or one the operator did not configure, ride the
  wave's route, and the dispatch note names them.
- **An unknown class is never an error.** A well-formed class the operator did not configure is ignored with a
  note. So is a class on a wave it does not steer: an explicit `model`, `profile`, `harness` or `claudeAccount`
  (explicit routes stay exact), a reviewer wave, or an image wave. A malformed slug is an input error.
- **Receipts.** `run.selection.taskClass` is `{ name, outcome, reason, step?, requiresTestGate?, note? }`.
  `outcome` is `served` (a class step launched; `step` is the entry and `reason` names the earlier steps and
  why each was not chosen), `fallback` (the class is configured but no step could launch, so the normal route or
  the Claude tier ran) or `ignored`. The same object is in the dispatch summary, the checkpoint and the
  `Task class …` line of the route note; each task's declared class is in `summary.tasks[].taskClass`.
- Class steps resolve in the parent session's registry, so a step on an account-leased tier the session does not
  hold is not reachable. A class run's runtime pre-output hop follows the class's own ranked chain (best
  remaining step first) and only routes the operator's class names; it never leaves the class for the default chain.
- **Which step serves is decided by evidence**, not by chain order, once a class has priors or recorded outcomes:
  see the next section. With neither, the configured order stands.

### Evidence-driven ranking, self-healing and the evidence store

The chain order is only the starting point. Every task of a classed wave leaves a record of how its route did, and the
next dispatch of that class first holds the steps that can launch (the checks above come first and are never relaxed)
to a **quality gate**, then ranks the rest by **expected cost per correct result**:

    gate:  out if upper(p(pass)) < lower(p(pass) of the best route), at the class's qualityGate level
    score(route) = (E[cost] + timeWeight x E[seconds]) / p(pass)        lower is better

- `p(pass)` is a Beta posterior over the route's recorded passes and fails, seeded by the operator's `priors`:
  `Beta(1 + priorPass + w x selfReportedPasses + verifiedPasses, 1 + (priorN - priorPass) + fails)`, where `w` is the
  class's `selfReportWeight` (default 0.5): a pass only the worker's own final state reports counts half of one a
  verification, a test gate or the operator confirmed. A failure counts fully whatever its source (a crash or a
  timeout is observed, not claimed).
- **Quality is a gate, not a trade.** A route whose one-sided credible upper bound (default level 95%) is under the
  best route's lower bound is `gated`: never the pick, never explored, and only the last resort of a runtime failover
  after every ungated route has failed. Once `cooldownMinutes` have passed since its last outcome or re-probe it gets
  one re-probe, like a demoted route, so a route that improved can earn its way back. A route gated by its prior alone
  is held from the class's first recorded outcome. `qualityGate: 0` turns the gate off. `E[cost]` and `E[seconds]` are the mean of the
  route's recorded attempts (dollars from the run's usage cost, wall seconds), mixed with the prior's `costUsd` and
  `seconds` weighted by its `n`. A route with no cost yet is judged at the class's average, so only `p(pass)`
  separates it.
- The winner is a **Thompson draw** from each posterior, so a route with thin evidence still gets picked when it
  might be the best. On top of that, an `explore` share of dispatches (default 0.1) deliberately picks a route other
  than the expected best, so a weaker route's estimate keeps tracking model and provider changes. The route that
  would have won is the failover behind it.
- With **no priors and no evidence** the configured chain order serves. Nothing in Steak Pi names a winner.

Per-class keys (all optional; Steak Pi ships no class, route or number of its own beyond these defaults):

| Key | Default | Meaning |
| --- | --- | --- |
| `timeWeight` | `0` | dollars one second of waiting is worth; `0` ranks on cost alone |
| `minPassRate` | `0` (no floor) | a route whose rolling pass rate falls under it is held out |
| `explore` | `0.1` | share of dispatches that pick a weaker route on purpose (0 to 0.5) |
| `demoteAfter` | `3` | consecutive failures that demote a route for this class |
| `window` | `10` | decided outcomes the rolling pass rate looks at (the floor needs `min(window, 5)` of them) |
| `cooldownMinutes` | `30` | how long a demoted or gated route stays out before one re-probe |
| `qualityGate` | `0.95` | credible level of the quality gate (0 to 0.999); `0` turns it off |
| `selfReportWeight` | `0.5` | weight of a pass only the worker's own state reports, against a verified one (0 to 1) |
| `retryMaxTokens` | double the model's own | output budget for the one same-route retry of an empty reply |
| `slots` | none | most tasks one wave may run on this class's routes at once (a local server with one slot is `1`); a wider wave runs the normal chain |
| `maxScope` | none | `"small"`: the class is for small, bounded tasks; a wave with a task that may both edit and run a shell runs the normal chain |
| `priors` | none | `{ "<chain entry>": { "pass", "n", "costUsd", "seconds" } }`: `pass` of `n` earlier trials, mean cost and seconds of a trial |

A worked example. Two routes serve `class-a`, and the operator's own benchmark gave starting values:

    "class-a": {
      "chain": ["route-a", "route-b"],          // profile ids or exact provider/model routes
      "timeWeight": 0.0005,                     // half a cent buys ten seconds
      "minPassRate": 0.6,
      "priors": {
        "route-a": { "pass": 13, "n": 14, "costUsd": 0.0004, "seconds": 12 },
        "route-b": { "pass": 13, "n": 14, "costUsd": 0.0004, "seconds": 3 }
      }
    }

At first the two cost the same and `route-b` is faster, so `route-b` is expected to win by its time term. If its
recorded outcomes then show it failing more often, `p(pass)` falls and the ranking moves to `route-a` by itself; if
`route-a` starts failing, it moves back. About one dispatch in ten is an exploration that picks the other route. The
dispatch note shows the numbers behind each pick, for example
`Route evidence: winner route-b on harness pi (exploit; explored no; timeWeight 0.0005, floor 0.6, explore 0.1, quality gate 95%, self-report weight 0.5); route-a p(pass) 0.88, E[cost] $0.00040, E[s] 12, n=0+14 prior on pi | route-b p(pass) 0.88, E[cost] $0.00040, E[s] 3, n=0+14 prior on pi`.

**What is recorded.** One `task` record per task of a classed wave when it settles: the class, the route (the
chain entry that finished it), `outcome` (`pass`, `fail`, `unknown`), its `source`, wall seconds, dollars, tokens and,
for a failure, a `failureKind`: `empty-output`, `reasoning-exhausted`, `tool-error`, `http-4xx`, `http-5xx`, `quota`,
`rate-limit`, `content-filter`, `budget` (the task ran out of its turn budget; ranked exactly like `other`), `timeout`
(the task hit its wall-clock deadline: a quality failure and, with its whole wall time recorded, a speed failure) or
`other`. Each record also names the `harness` that ran it. A route a task left on the way (a failover) gets its own `fail` record with the cause. Only a task that
itself declared the class counts. The outcome's source, strongest first:

1. a **verification verdict** recorded later (`ultraterm_hub` `record-outcome`, below);
2. a **test gate** result the worker reported: an editing worker on a `requiresTestGate` class is asked to end its
   report with `TEST-GATE: pass` or `TEST-GATE: fail`;
3. the **worker's final state** (`done` is a `pass`, `failed` or `timed_out` a `fail`, `aborted` is `unknown`). On a
   `requiresTestGate` class a finished task with no gate result is `unknown`, so it cannot inflate the pass rate.

The store is an append-only JSONL, `~/.pi/agent/usap/route-evidence.jsonl` (override `STEAK_PI_ROUTE_EVIDENCE`),
mode 600. Nothing is rewritten: a later verdict is a new `verdict` line that the reader applies to the run's records
(the latest wins), and a `probe` line marks a re-probe. At about 5 MB it rotates to `route-evidence.jsonl.1`
(replacing the older generation), so the store never exceeds about 10 MB. Damaged lines are skipped, and a store that
cannot be written never fails a dispatch.

**Self-healing.**

- **Demotion.** A route is held out of a class after `demoteAfter` consecutive failures, when its rolling pass rate over
  the last `window` decided outcomes falls under `minPassRate`, or at once when it is refused on spent credits
  (`quota`, a 402). The dispatch note and receipt name the cause (`3 consecutive failures (empty-output)`).
- **Re-probe and promotion.** After `cooldownMinutes` the route gets exactly one exploratory pick (a marker line stops
  the next dispatch from probing again), with the healthy routes behind it as the failover. A pass promotes it and
  restarts its rolling window; a failure holds it out for another cooldown. If every route is held out, the normal route
  serves and the receipt says why.
- **Retry, then move on.** A reply that comes back empty or out of output tokens (`stopReason length`: reasoning
  consumed the budget) is retried **once** on the same route with a higher output budget (`retryMaxTokens`, else
  double the model's own, never above 131072), then the task runs on the next ranked route. A reply that fails with
  spent credits (402, "insufficient credits"), a 5xx, or a provider content-filter refusal before output (an HTTP 400
  naming a content-inspection code) moves to the next ranked route at once, with the cause recorded as the left route's
  failure (`content-filter`). A content-filter refusal judges the input, not the route, so it never demotes the route.
  After output began, a content-filter refusal is never resent: the run fails with its named cause. A route whose profile has an `ensure` hook is not offered as a per-task alternate. A
  failure before any output uses the runtime pre-output hop along the same ranked chain.

**Reading and teaching it.** `ultraterm_hub` with `action: "routes"` (read-only; `taskClass` filters) prints, per class,
each route's health, `p(pass)`, pass/fail/unknown counts (and how many were verified), expected cost and seconds, cost per
correct result, and its failure kinds. `action: "record-outcome"` with `runId`, `outcome` (`pass` or `fail`), an optional
`taskId` and `source` (`verification`, `test-gate`, `operator`; default `operator`) attaches a verdict to what a run
left, so a reviewer's finding or a test result moves the estimates. It records nothing for a run that left no classed
evidence.

### Choosing the harness per job

A candidate is a **(harness, model route)** pair, and the harness is part of the chain entry the class ranks: a class
whose chain holds `provider-a/model-a` (the native Pi worker) and `steak-dsh/provider-a/model-a` (the Steak DSH
harness on the same model) ranks them as two candidates on their own evidence, with the gate, the weights, exploration,
demotion and re-probe above. Nothing in Steak Pi prefers a harness: with no priors and no outcomes the chain order
stands, and identical evidence gives identical scores whatever the harness is called (a test fails otherwise).

- **Capability is a filter, applied before ranking.** A candidate that cannot run this job is not a candidate, and
  being unavailable is never recorded as a loss: a steak-dsh step needs an API-key login (not OAuth-only), its
  executable, and a text-only wave; a project's `noClaudeProjects` policy removes every Claude step (including a
  harness-qualified step whose inner route is Claude) and `planOnlyProjects` removes every paid metered step.
- **The receipt names the harness and why.** A classed implicit wave's dispatch note starts with, for example,
  `Harness: steak-dsh, chosen by task class class-a with steak-dsh/provider-a/model-a: the best expected cost per
  verified pass; p(pass) 0.92, E[cost] $0.01, E[s] 40, n=12+10 prior`, and the route-evidence line names each
  candidate's harness (`... on pi`, `... on steak-dsh`).
- **Seed priors only where they were measured.** A benchmark of one harness on one model and task shape belongs in the
  `priors` of the class that runs that model on that shape, with a small `n`, so live outcomes replace it quickly.

**For a job queue outside Pi.** `steak-pi routes` exposes the same ranker and the same store to a caller that launches
whole agent panes (each candidate a `harness/profile` entry of a class chain):

    steak-pi routes rank --class <class> --candidate <entry>=<harness> ... --json
    steak-pi routes record --class <class> --run <job> --task <job> --route <entry> --harness <harness> \
        --outcome pass|fail|unknown [--source worker-state|verification|test-gate|operator] \
        [--seconds N] [--cost USD] [--tokens N] [--failure-kind timeout|...]
    steak-pi routes verdict --run <job> [--task <job>] --outcome pass|fail --source verification|test-gate|operator
    steak-pi routes report [--class <class>] [--json]

The caller passes only the candidates it can launch for the job (after its own capability, quota and project-policy
checks); a candidate outside the class chain is refused. `rank` prints `{ winner, harness, order, excluded, decision,
why }` and writes the re-probe marker when it re-probes; `record` and `verdict` append to the store. A malformed
routing.json fails with its cause.

### Profile launch hooks (`ensure`)

A `workerProfiles[]` entry may carry `ensure: { command: [argv...], release?: [argv...], timeoutMs? }`. Around
every worker launched on that profile USAP:

1. runs `command`: an argv array (an absolute program path, or a bare name resolved through `PATH`; never a
   shell string and never a relative path), with the environment passed through, the home directory as its
   working directory, and a bounded timeout (`timeoutMs`, default 120000, from 1000 to 600000);
2. **refuses the launch** when it exits non-zero, times out or cannot start. The worker never starts and its
   error is `USAP profile ensure refused (<profile>): <stderr, bounded>`. For an implicit wave the route is held
   out and the same tasks run on the next step of the walk (the next class step, then the normal route) inside
   the same tool call; an explicit profile fails the call with that cause;
3. otherwise runs the worker, and in a `finally` runs `release` however the worker ended: done, failed, aborted
   or thrown. `release` is cleanup: the abort that ended the worker does not cancel it, it is bounded by the
   shorter of `timeoutMs` and 30 seconds, and its failure is recorded on the task (`profileEnsure`), never turned
   into a failed worker. A command that was killed by its timeout or an abort may already hold a lease, so
   `release` runs after it too; one that failed on its own did not run its work, so nothing is released.

Ensure and release run once per worker, one at a time per profile within a session (a wave starts up to eight
workers at once and a start-if-absent command must not race itself); other processes are the command's own
business, so make it idempotent and, for a lease count, make `release` its exact inverse. The hook wraps the
shared worker runner, so Pi and claude-code workers get it alike, and it also runs on a bounded resume of a run
that used it. The hook is resolved from the operator's routing.json by the profile id the run recorded and only
while that profile still serves the run's frozen route; a manifest, a task, a tool argument or a checkpoint never
supplies a command, and a run that recorded no profile reads nothing. The receipt `task.profileEnsure` names the
profile and the outcome (`ensured`, `refused`, `released`, `release-failed`), never the command line.

A hook slower than the dispatch's startup window (at most 30 seconds) is still waited for, but a refusal that
arrives after the window is an ordinary failed worker with its named cause rather than a synchronous
fall-through. A runtime hop to another chain route never runs a hook for that route: name a route that needs one
through a class step or a profile.

## Steak DSH harness

`steak-dsh` is the third USAP execution harness (beside `pi` and `claude-code`): the DSH headless CLI with the
Steak DSH bundle applied, run once per leaf as a detached child process. It is not a Pi stream adapter: the
leaf runs on the external CLI, while the same coordinator, hub, capacity limiter, checkpoint store and telemetry
surface serve it. Steak Pi ships no model, provider or price for it: every identity comes from the registry and
the operator's routing.json.

**Route grammar.** `steak-dsh/<provider>/<model-id>`; the model id may itself contain slashes (split at the first
inner slash). The inner `<provider>/<model-id>` must be a model the Pi model registry already knows, the same
registry a Pi-native route uses, and it passes the SAME policy checks: retired patterns, pinned subscription
families (`subscriptionRouteChecks`), reviewed paid-route approval, configured authentication, and the quota
preflight / `onlyWhen` conditions of the inner route. Two harness-specific gates apply on top: the provider must
hold an API key the CLI can use (an OAuth-only login is refused with a named error, because the harness cannot refresh
OAuth tokens), and the `steak-dsh` executable must resolve (`STEAK_DSH_BIN`, else `steak-dsh` on PATH). Every
refusal names the inner route; nothing falls back.

**Explicit dispatch.** `harness: "steak-dsh"` with `model: "<provider>/<model-id>"`, or an exact
`model: "steak-dsh/<provider>/<model-id>"` with no harness field. There is no default steak-dsh route: a dispatch
without a model is refused naming the form. Explicit routes never fall back; `profile`, `claudeAccount` and
`requireImages` are refused on this harness. The effort is the dispatch's `thinking` (`medium`, `high`, `xhigh`;
high/xhigh need a `thinkingReason`), default `medium`.

**Class chains and the evidence router.** A `taskClasses.<name>.chain` entry or a `textWorkerChain` entry may be
`steak-dsh/<provider>/<model-id>`. The walk yields a harness-qualified step whose launch checks are the inner
route's checks plus the executable resolution; when the ranked winner is such a step, the run's harness is set
from it. A class whose chain holds both `provider-a/model-a` and `steak-dsh/provider-a/model-a` ranks them as two
routes on the same recorded evidence: evidence rows record the route string verbatim, priors keyed by that string
work, and `ultraterm_hub routes` shows it beside the native entry. `steak-pi routing check` accepts these entries
and validates the inner model against the registry offline (an unknown inner model is a named error).

**Permissions and the key.** A `mayEdit` leaf runs with `--permission workspace-write` and one `--owned-path` per
owned path (the CLI's owned-paths plugin denies writes elsewhere); a read-only leaf runs with
`--permission read-only`; `--no-shell` is passed unless the task grants `allowBash`. The harness sandbox confines
writes to the run cwd, so an owned path outside it is also granted to the sandbox (`--add-dir`): the owned
directory itself, or the immediate parent of an owned file, and nothing wider. A path whose parent does not exist
yet is refused, and so is a grant that would be the home directory, a directory above it, or one close to the
filesystem root. The owned-path rule still limits the edit tools to the exact owned paths. Reads are not confined on
this harness, as on a native Pi worker, so declared `readPaths` are validated and named in the prompt but need no
grant. With `allowBash` the shell can write anywhere the sandbox allows, as on every harness. The inner model's API key is resolved through Pi's own auth resolution and
passed ONLY in the child environment under the fixed name `STEAK_DSH_ROUTE_KEY` (`--key-env STEAK_DSH_ROUTE_KEY`);
it never appears in argv, prompts, logs or the run record, and the child environment is an explicit allowlist.

**Accounting and failure kinds.** The runner parses the CLI's NDJSON stream with a bounded frame buffer (a
malformed frame fails closed, named), sums `step_end` usage into the run's usage totals, and prices it from the
registry model's own cost table (zero when the table is zero). `maxTurns` is enforced by counting `step_start`
events (a budget stop kills the child and is named). Abort kills the whole process group with the same
SIGTERM→SIGKILL grace as the claude-code runner. A 429 / quota / insufficient-credits refusal is reported as the
same provider-quota failure kind the Pi runner reports, so an implicit wave falls through to its next configured
tier; exit 78 is named as "steak-dsh harness not installed" with the install hint; any other failure names the
last stderr line.

**Adding it to a class.** Put the harness-qualified route in the class chain beside the native one and give it a
prior from your own measurements; the router then ranks both on live outcomes:

```json
"taskClasses": {
  "quick-edit": {
    "chain": ["provider-a/model-a", "steak-dsh/provider-a/model-a"],
    "priors": { "steak-dsh/provider-a/model-a": { "pass": 0.9, "n": 10, "costUsd": 0.001, "seconds": 20 } }
  }
}
```

Measure before you add it: a harness is not better on every model. Compare the two routes on your own tasks first
(for example with ParetoBench) and let the recorded evidence decide after that.

**Limits (v1).** No relay steering (`ultraterm_hub send`/`redirect` are refused with a named error), no resume
(the harness keeps no resumable worker session), and no image input. The dispatch note and receipt name the
harness whenever it is not Pi.

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

## Interactive chain virtual model (opt-in)

Interactive sessions normally keep the exact model the operator selected: a
slot whose plan runs out ends its turn on the error until someone switches the
model. The optional `interactiveChainModel` key gives an interactive slot the
same ordered chain workers use, under one operator-named virtual selection:

```jsonc
{
  "textWorkerChain": ["provider-a/model-name", "provider-b/model-name"],
  "interactiveChainModel": {
    "provider": "provider-a",   // any provider id; the virtual entry is listed under it
    "id": "my-chain",           // must not collide with a physical model id of that provider
    "name": "My chain",         // the display name shown in /model and the status band
    "chain": "textWorkerChain"  // optional; "textWorkerChain" (default) or "multimodalWorkerChain"
  }
}
```

How to enable it:

1. Configure the chain you want the slot to follow (`textWorkerChain` or
   `multimodalWorkerChain`) and add the `interactiveChainModel` key above.
   Validate the file with `steak-pi routing check` before saving.
2. Restart Steak Pi (registration happens at startup; adding or removing the key
   needs a restart, while chain edits apply on the next routing decision).
3. Select the virtual model once with `/model` (it appears under the configured
   provider with the configured name). The selection persists like any model.

Behaviour while it is selected:

- Each new user request routes to the **first available step** of the configured
  chain, with the same checks an implicit worker dispatch uses: exact identity,
  capability, configured auth, catalog membership, subscription/local or
  reviewed-and-allowlisted paid route, and `onlyWhen` quota conditions (the
  account router is asked at most once per minute, and only when a step has an
  `onlyWhen`). A slot returns to the preferred route as soon as it can work.
- Continuation requests keep the physical model that last answered; an automatic
  retry leaves the failed step for the next chain step only for a chain-eligible
  error, otherwise Pi's own same-route retry semantics are unchanged.
- The same pre-output chain wrapper workers use is installed beneath the virtual
  selection, so quota, plan-limit and content-filter refusals hop to the next
  authenticated step **before any output**, with the same spend approval and a
  `model-fallback:from->to` hop receipt on the status band.
- The status band shows the virtual name plus the physical route that answered
  the latest assistant message (`my-chain → provider-b/model-name`). Usage and
  cost stay attributed to the physical provider on every assistant message.
- Explicit `/model` selections are never rerouted: the chain applies only while
  the virtual model itself is selected. Absent key: nothing is registered and
  interactive behaviour is exactly as before.

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
Set `temporaryFreeExclusions` in `routing.json` to an array of `{ "provider":
"openrouter", "pattern": "..." }` entries. Patterns match the model id and name
joined by a space, case-insensitively; anchors apply to that combined string.
If the key is absent or the file is malformed, free-route
selection fails closed with a configuration error; an explicit empty array means
no additional family exclusions. Cached routes revalidate the free worker profile
against removal or remapping and check that the fallback profile ID remains
configured. An expired route whose free profile was removed or remapped still
fails validation; remove the expired route file to restore normal selection.

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
explicit selectors still served, and that no task class or launch hook exists by
default. `test/neutrality.test.ts` scans the shipped files for concrete model
ids, personal names, concrete class names and any literal class table or hook;
`test/task-classes.test.ts` and `test/profile-ensure.test.ts` cover the class
schema, class-first routing and fallback, unknown classes, and the hook's
success, refusal, fall-through and release paths. The behavioral suites
(`test/model-route-policy.test.ts`, `test/subagent-model-selection.test.ts`,
`test/explicit-paid-route.test.ts`, `test/ultraterm-subagents-extension.test.ts`,
…) run against the synthetic operator fixture `test/fixtures/routing.json` and
`test/fixtures/paid-routes.json`, wired by `vitest.config.ts`; they never read
the machine's real configuration.

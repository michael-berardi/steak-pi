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

- A **chain step** is either a worker profile id (`harness/profile`, from `workerProfiles` or a harness manifest) or
  an exact `provider/model` route. A step that is exactly a profile id is that profile's model, with its
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
next dispatch of that class ranks the steps that can launch (the checks above come first and are never relaxed) by
**expected cost per correct result**:

    score(route) = (E[cost] + timeWeight x E[seconds]) / p(pass)        lower is better

- `p(pass)` is a Beta posterior over the route's recorded passes and fails, seeded by the operator's `priors`:
  `Beta(1 + priorPass + passes, 1 + (priorN - priorPass) + fails)`. `E[cost]` and `E[seconds]` are the mean of the
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
| `cooldownMinutes` | `30` | how long a demoted route stays out before one re-probe |
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
`Route evidence: winner route-b (exploit; explored no; timeWeight 0.0005, floor 0.6, explore 0.1); route-a p(pass) 0.88, E[cost] $0.00040, E[s] 12, n=0+14 prior | route-b p(pass) 0.88, E[cost] $0.00040, E[s] 3, n=0+14 prior`.

**What is recorded.** One `task` record per task of a classed wave when it settles: the class, the route (the
chain entry that finished it), `outcome` (`pass`, `fail`, `unknown`), its `source`, wall seconds, dollars, tokens and,
for a failure, a `failureKind`: `empty-output`, `reasoning-exhausted`, `tool-error`, `http-4xx`, `http-5xx`, `quota` or
`other`. A route a task left on the way (a failover) gets its own `fail` record with the cause. Only a task that
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
  spent credits (402, "insufficient credits") or a 5xx moves to the next ranked route at once, with the cause recorded
  as the left route's failure. A route whose profile has an `ensure` hook is not offered as a per-task alternate. A
  failure before any output uses the runtime pre-output hop along the same ranked chain.

**Reading and teaching it.** `ultraterm_hub` with `action: "routes"` (read-only; `taskClass` filters) prints, per class,
each route's health, `p(pass)`, pass/fail/unknown counts (and how many were verified), expected cost and seconds, cost per
correct result, and its failure kinds. `action: "record-outcome"` with `runId`, `outcome` (`pass` or `fail`), an optional
`taskId` and `source` (`verification`, `test-gate`, `operator`; default `operator`) attaches a verdict to what a run
left, so a reviewer's finding or a test result moves the estimates. It records nothing for a run that left no classed
evidence.

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

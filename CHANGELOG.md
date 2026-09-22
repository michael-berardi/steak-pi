# Changelog

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

# Changelog

## 0.6.0 — 2026-09-20 (USAP 1.2)

- Release date: 2026-09-20. Targets Pi 0.86.0 and retains the 0.85.1 peer range;
  final hardening verification is scoped to 0.86.0. No multi-hour endurance run
  was performed: the 8-hour worker value is a configurable deadline ceiling.
- Distribution: install from the `v0.6.0` git tag or the GitHub release archive
  (`steak-pi-0.6.0.tgz` + `.sha256`). The package is not published to the npm
  registry, and the private Implose Cybernetics Homebrew tap remains a channel
  for already-authorized operators only. Generated package archives and raw
  internal verification logs are no longer tracked in the tree.
- Add the optional `bin/steak-pi-dsh` managed entrypoint with
  `docs/DEEPSEEK-HARNESS.md`: guarded persistent bash for native workers and for
  one explicitly admitted primary-session route. Opt-in only, with no added npm
  dependency.
- Fix the optional DSH launcher under installed `node_modules` paths. A temporary, exact-file Node loader handles only its two reviewed TypeScript modules; it is removed before native Pi launches. Packaged-launch tests cover unsafe-option rejection and loader isolation.
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

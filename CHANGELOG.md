# Changelog

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

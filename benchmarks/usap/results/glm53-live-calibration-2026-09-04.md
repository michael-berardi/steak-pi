# GLM-5.3-Flash live calibration — 2026-09-04

Status: **paid live synthetic calibration; not a product benchmark claim**.

## Controls

- Model: `zai/glm-5.3-flash`
- Thinking: `high`
- Fallback: disabled
- Fresh fixture and ephemeral session per run
- Sequential top-level runs with balanced ordering
- Identical prompts, file allowlists, and deterministic verification
- Arms: stock Pi, the removed legacy `parallel` snapshot, USAP, and OMP

All three edit cases used three samples per arm. The read-only injection case is one sample. Raw JSONL remains local under `/tmp/audit/steak-usap-calibration/` and is intentionally not packaged.

## Results

All edit runs passed deterministic verification on the first attempt.

| Case | Arm | First-pass | Median wall time | Median accounted tokens |
| --- | --- | ---: | ---: | ---: |
| Direct boundary edit (n=3) | stock Pi | 3/3 | 24.869 s | 11,176 |
|  | legacy `parallel` | 3/3 | 22.077 s | 11,909 |
|  | USAP | 3/3 | 21.628 s | 16,129 |
|  | OMP | 3/3 | 28.506 s | 71,392 |
| Two intentionally trivial independent fixes (n=3) | stock Pi | 3/3 | 30.489 s | 12,481 |
|  | legacy `parallel` | 3/3 | 56.303 s | 97,773 |
|  | USAP | 3/3 | 55.603 s | 34,310 |
|  | OMP | 3/3 | 77.138 s | 138,956 |

Larger four-module implementation (n=3):

| Arm | First-pass | Median wall time | Median accounted tokens |
| --- | ---: | ---: | ---: |
| stock Pi | 3/3 | 118.036 s | 57,775 |
| legacy `parallel` | 3/3 | 137.462 s | 193,701 |
| USAP | 3/3 | 125.913 s | 78,834 |
| OMP | 3/3 | 246.640 s | 220,809 |

Individual wall times varied substantially: stock Pi 90.756–212.158 s, legacy 129.432–149.926 s, USAP 108.119–143.604 s, and OMP 140.119–249.388 s. Medians are reported rather than presenting any single run as representative.

All four arms passed the one-shot read-only prompt-injection fixture, made no edits, and did not expose the fixture secret.

## Accounting note

USAP and OMP totals include nested worker usage emitted at the tool boundary. Legacy `parallel` did not attribute child usage to the parent, so its parallel-case totals were reconstructed from `details.results[].usage` in raw JSONL. Its historical child launcher also did not disable ambient skills/prompts, unlike USAP's isolated loader; that implementation difference prevents a strict prompt-surface equivalence claim. These gaps are why legacy parent-only token totals must not be compared directly.

## Interpretation

- No measured edit run failed first pass, so these fixtures do not establish a quality difference.
- Direct USAP had similar latency and a modest token premium versus stock Pi; n=3 is too small for a speed claim.
- The tiny parallel case is deliberately below USAP's useful delegation threshold. Stock Pi was fastest and cheapest, validating the rule that independence is necessary but not sufficient and work smaller than its briefing/integration cost stays in the parent.
- When delegation was forced on that case, USAP used about 65% fewer median tokens than legacy `parallel` and about 75% fewer than OMP. It was slightly faster than legacy and about 28% faster than OMP.
- On the larger sample, USAP finished about 7% slower than stock Pi while using about 37% more tokens, but was about 8% faster and 59% leaner than legacy `parallel`, and about 49% faster and 64% leaner than OMP.
- Further workflows and real repositories are still required before making a general product-win claim.

## Native lifecycle/security probes

Separate real GLM-5.3-Flash probes verified:

- background launch → immediate whole-run cancellation → bounded wait: both children aborted and no replacement launched;
- a 1,000 ms run deadline: child settled `timed_out`, run settled `failed`, no work leaked;
- parent request → active child delivery → child reply with the exact request ID and immutable host-bound sender identity;
- concurrent disjoint writers: an out-of-scope sibling write was denied while the legitimate owner succeeded (`a.txt` stayed `A`, `b.txt` became `B2`).

A read-only four-surface release audit also exposed retention, case-folding, malformed-usage, bash-disclosure, and turn-budget issues. Those findings were independently checked and hardened in the implementation and tests before release verification.

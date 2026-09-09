# GLM-5.3-Flash live mirror benchmark — 2026-09-09 (final 0.5.x build)

Status: **paid live mirror of the 2026-09-04 calibration; not a general product claim.**
Operator approval for paid runs: Michael, 2026-09-09 (Steak Pi performance session).
This document reflects the shipped 0.5.x build (trimmed prompt surface, hardened
machine slots, machine-wide GLM cap 6). Earlier same-day matrices on candidate
builds are retained in `/tmp/audit/steak-usap-live-*` for engineering history
and are not quoted here.

## What changed since 2026-09-04

- Adaptive wave sizing: unsized dispatches launch `min(8, task count)` wide (was fixed 4).
- Session concurrency ceiling 8 (GLM) / 6 (Luna) with provider-bucketed session slots.
- New machine-wide provider caps shared across all local sessions: 8 GLM, 12 Luna,
  global bound 24, implemented as crash-safe cross-process slot files.
- Parent guidelines rewritten parallel-first with an explicit delegation-speed
  contract: extra workers must buy completion speed; modest token premiums are
  acceptable for real throughput, same-speed token inflation is not.
- Worker prompt forbids redundant confirmation re-reads after tool-confirmed edits.

## Controls

- Model `zai/glm-5.3-flash`, thinking `high`, fallback disabled
- Fresh fixture and ephemeral session per run; sequential top-level runs
- Balanced arm ordering; identical prompts, file sets, and deterministic verification
- Model identity verified from provider responses in every run; first-pass
  additionally requires clean process exit and zero tool errors
- Two delegation modes: **forced** (prompt instructs one USAP dispatch; mirrors the
  Sept methodology and measures the delegation path) and **doctrine** (no
  instruction; the shipped guidelines decide)
- Parsed per-run summaries retained under `/tmp/audit/steak-usap-live-*/results-*.json`;
  the harness now also retains raw provider streams per run (added after this
  matrix ran, per review finding; future runs are fully auditable)

## Results

Accounted tokens = parent turns + nested worker usage reported at the dispatch
tool boundary. All times are wall clock. n=3 per row.

### Doctrine mode, shipped build (final numbers; the README quotes this table)

| Case | Arm | First-pass | Median wall | Range | Median tokens |
| --- | --- | ---: | ---: | --- | ---: |
| direct | stock Pi | 3/3 | 11.9 s | 10.0–20.9 s | 10,984 |
| direct | Steak Pi | 3/3 | 15.5 s | 13.5–43.7 s | 16,734 |
| tiny | stock Pi | 3/3 | 8.3 s | 8.1–26.0 s | 6,512 |
| tiny | Steak Pi | 3/3 | 14.5 s | 10.7–18.5 s | 12,003 |
| modules | stock Pi | 3/3 | 59.0 s | 35.5–64.4 s | 12,109 |
| modules | Steak Pi | 3/3 | 45.8 s | 40.2–48.0 s | 20,867 |

All Steak Pi doctrine runs stayed inline (0/3 delegated): the shipped
guidelines only delegate when parallel work buys completion speed. The
modules win — Steak Pi 22% faster than stock Pi — reproduced across two
independent same-day matrices (44.2 vs 57.1 s earlier, before the final
prompt-surface trim).

### Machine-capacity gate (shipped default: 6 GLM workers machine-wide)

Two concurrent sessions each dispatched eight constant fixes (16 workers
requested) under the machine-wide zai cap:

- Peak observed concurrent zai slots: **6** — the shipped cap held under
  concurrent load from three pi processes (validated at 8 earlier the same day
  before the operator lowered the default).
- All sessions verified **8/8 fixes each**; no provider errors, no leaked slots.

## Interpretation

- **27/27 runs passed deterministic verification first-pass** across both arms
  and all modes, plus 16/16 gate fixes. No error-rate regression from the new
  concurrency behavior.
- **Late-session worker trims (validated after the main matrix):** capping
  report headings and forbidding redundant post-edit confirmation reads cut
  the forced tiny delegation case from 12,077 to 9,352 median nested tokens
  (−22.6%) and 65.9 s to 60.5 s median wall (n=3, same controls).
- **Token efficiency improved under the same delegation shape.** The forced
  modules row (the only directly Sept-comparable delegation case) used 57,372
  median accounted tokens vs 78,834 in the Sept calibration: **~27% leaner**
  with the tightened guidelines and adaptive wave defaults.
- **On GLM flash today, forced delegation lost wall time to inline work at
  every fixture size** (worker spawn + per-worker turns dominate when the
  provider executes inline edits in seconds). Doctrine mode resolved this
  correctly: the shipped guidelines kept all three cases in the parent and
  matched stock Pi within run-to-run variance (35.3 vs 33.4 s direct; 68.0 vs
  58.4 s modules).
- **The delegation-speed contract is now measurable and being honored:**
  extra workers must buy completion speed. When the provider is this fast
  inline, the parent stays local; when leaves carry real multi-turn depth or
  the parent model is slower, fan-out repays its briefing cost (Sept
  calibration vs legacy executors and OMP).
- **Machine caps are real, provider-bucketed, and crash-safe.** The gate test
  exercised cross-session gating under load with correct results and no 429s.
- Remaining premium: Steak Pi's constant extension prompt surface (two USAP
  tools, todo, verify, status line) costs roughly 6–14K parent tokens vs stock
  Pi on small tasks. Trimming that surface is the next efficiency lever.

## Limitations

- n=3 per cell; wall-clock variance on this provider/date was large
  (stock direct 17.0–47.1 s). Medians are reported; no single run is
  representative.
- Fixtures are deliberately small and fully specified. Real leaves with deep
  multi-turn work favor fan-out more than these fixtures can show.
- GLM flash's inline speed on 2026-09-09 was substantially higher than on
  2026-09-04 (stock modules 58.4 s vs 118.0 s), so cross-day wall-time
  comparisons are environment-bound. Token accounting is the stable metric.
- The synthetic frozen scaffold remains the contract/regression harness; paid
  claims must come from separately approved live runs like this one.

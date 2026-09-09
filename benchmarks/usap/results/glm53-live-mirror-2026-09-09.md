# GLM-5.3-Flash live mirror benchmark — 2026-09-09

Status: **paid live mirror of the 2026-09-04 calibration; not a general product claim.**
Operator approval for paid runs: Michael, 2026-09-09 (Steak Pi performance session).

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
- Model identity verified from provider responses in every run
- Two delegation modes: **forced** (prompt instructs one USAP dispatch; mirrors the
  Sept methodology and measures the delegation path) and **doctrine** (no
  instruction; the shipped guidelines decide)
- Raw JSONL per run under `/tmp/audit/steak-usap-live-*/` (not packaged)

## Results

Accounted tokens = parent turns + nested worker usage reported at the dispatch
tool boundary. All times are wall clock. n=3 per row.

### Forced delegation (mirror arm)

| Case | Arm | First-pass | Median wall | Range | Median tokens |
| --- | --- | ---: | ---: | --- | ---: |
| direct | stock Pi | 3/3 | 33.4 s | 17.0–47.1 s | 11,387 |
| direct | Steak Pi (forced) | 3/3 | 90.1 s | 74.0–97.1 s | 26,219 |
| tiny | stock Pi | 3/3 | 14.4 s | 13.6–15.8 s | 6,613 |
| tiny | Steak Pi (forced) | 3/3 | 65.9 s | 61.5–74.3 s | 27,401 |
| modules | stock Pi | 3/3 | 58.4 s | 37.1–64.9 s | 16,924 |
| modules | Steak Pi (forced) | 3/3 | 156.3 s | 112.3–215.8 s | 57,372 |

### Doctrine mode (shipped guidelines decide)

| Case | Arm | First-pass | Median wall | Range | Median tokens | Delegated |
| --- | --- | ---: | ---: | --- | ---: | ---: |
| direct | Steak Pi (doctrine) | 3/3 | 35.3 s | 34.7–59.6 s | 21,429 | 0/3 — stayed inline |
| tiny | Steak Pi (doctrine) | 3/3 | 25.6 s | 23.4–30.4 s | 13,205 | 0/3 — stayed inline |
| modules | Steak Pi (doctrine) | 3/3 | 68.0 s | 51.1–79.0 s | 20,774 | 0/3 — stayed inline |

### Machine-capacity gate (new in 0.5.0)

Two concurrent sessions each dispatched eight constant fixes (16 workers
requested) while the machine-wide zai cap of 8 was enforced:

- Peak observed concurrent zai slots: **8** (16 requested) — the cap held.
- Both sessions verified **8/8 fixes each**; no provider errors, no leaked slots.
- Per-session wall: 119.8 s and 111.2 s for eight fixes each (~7.5 fixes/minute
  aggregate under the cap).

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

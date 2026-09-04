# USAP comparison benchmark scaffold

This directory is a **local, deterministic, no-provider scaffold** for comparing four orchestration shapes:

- stock Pi;
- legacy parallel fan-out;
- OMP-native orchestration; and
- USAP.

It covers direct/coupled work, independent parallel work, dependencies, relay, cancellation, timeout, malformed output, writable-ownership collision, and failure isolation.

## What these results are—and are not

The current runner only replays frozen synthetic trace plans. It does not launch Pi, workers, a model SDK, shell commands, or network requests. The system profiles and timing/token values are explicit fixture assumptions, not empirical product claims. Results are suitable for testing benchmark contracts, lifecycle semantics, trace shape, and metric math. They are **not** evidence that one real system or model is faster or more accurate than another.

Paid runs must live in a separate, approval-gated harness. They must retain the same case definitions and scoring semantics, record raw traces, and label their output `paid-live` rather than merging it with synthetic results. This scaffold intentionally has no provider adapter and cannot make a paid call.

The first separately controlled live calibration is recorded in
[`results/glm53-live-calibration-2026-09-04.md`](./results/glm53-live-calibration-2026-09-04.md).
It includes its small sample sizes, accounting caveats, variance, and explicit
non-claim status; it does not alter the frozen synthetic fixture.

## Frozen fairness controls

`manifest.ts` is recursively frozen and `validation.ts` hard-fails any drift from all of these controls:

| Control | Required value |
| --- | --- |
| Model | `zai/glm-5.3-flash` |
| Thinking level | `high` |
| Fallback | `disabled` |
| Fallback model list | empty |
| Provider calls | `forbidden` |
| Fixture mode | `deterministic-synthetic` |
| Compared systems | exactly the four listed above |
| Cases | exactly the nine listed above, in the frozen order |
| Maximum synthetic parallelism | each plan must stay within its system profile |

For a future paid comparison, every arm must also use the same clean repository snapshot, prompt/case input, tool permissions, writable ownership, timeout and cancellation budgets, concurrency cap, cache state, retry policy, geographic/provider endpoint, and repetition count. Run order must be balanced, raw failures must remain in the sample, and no arm may silently retry or fall back. The paid runner must verify the exact model returned by the provider before accepting a sample.

## Metrics

Each case and aggregate system report includes:

- **First-pass completion:** criteria accepted on attempt 1 / all criteria.
- **Elapsed critical path:** last synthetic event end minus first event start.
- **Aggregate worker time:** sum of every work span, including failed, cancelled, timed-out, and rework spans.
- **Tokens:** input plus output tokens across work, coordination, and wait spans.
- **Rework:** count of work spans whose attempt is greater than 1.
- **Safety:** declared safety gates without a trace violation / all declared gates.
- **Useful concurrency:** accepted useful worker milliseconds / elapsed critical-path milliseconds. This is average useful occupancy and can exceed 1 when work overlaps.
- **Coordination overhead:** coordination milliseconds, plus coordination milliseconds / elapsed critical path.

Wait spans affect elapsed time but are not counted as work or coordination. Aggregate first-pass and safety scores are weighted by criteria and safety-gate counts rather than averaging case percentages.

## Commands

Run only the focused Vitest file:

```sh
cd path/to/steak-pi
npm exec vitest -- run test/usap-benchmark.test.ts
```

Print the deterministic local JSON report (Node 22+):

```sh
cd path/to/steak-pi
node --experimental-strip-types benchmarks/usap/run.ts > /tmp/usap-synthetic-report.json
```

Run a focused type check without invoking the project-wide test suite:

```sh
cd path/to/steak-pi
npm exec tsc -- --noEmit
```

The last command follows the repository TypeScript configuration and may include other currently tracked source files; it does not make provider calls.

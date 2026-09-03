# Cherry Pi Bounded Agent — Lifecycle Spec (v0.1)

Status: implemented in `extensions/agent-parallel.ts` (bounded parallel
executor). This document is the contract Sol review requires before the
capability ships enabled.

## Tool

`parallel` — spawns 1–8 child coding agents that work concurrently on
independent subtasks and returns their combined results as one tool result.

## Lifecycle states

```
queued → running → done | failed
```

- **queued** — task accepted, waiting for a concurrency slot.
- **running** — child process alive.
- **done** — child exited 0 (output captured).
- **failed** — child exited non-zero, was killed, or timed out; `ok: false`
  with captured output.

Terminal states only. No pause/resume/steer in v0.1 (deferred: steering
and pipelines require a reviewed lifecycle extension — see Deferred).

## Bounds (hard limits)

| Limit | Value | Rationale |
| --- | --- | --- |
| Max tasks per call | 8 | Prompt-bounded planning; prevents runaway fan-out |
| Concurrency | 4 | Machine-friendly default; keeps token burn predictable |
| Output per child | 20,000 chars | Truncated with notice; protects context |
| Wall clock | parent turn timeout | Child outlives the turn → killed with the group |

## Isolation

- Each child runs in the caller's working directory with the caller's
  environment. No shared mutable state between children beyond the
  filesystem itself — tasks MUST be independent (the tool description
  says so, and results are aggregated in dispatch order).
- Children are plain `pi` processes with the Cherry Pi package loaded;
  they authenticate with the operator's own provider credentials.
- A failed child never blocks siblings; failures are reported per-task.

## Failure contract

- Child exit ≠ 0 → `ok: false`, output = stderr+stdout tail.
- Timeout/kill → `ok: false`, output = partial output + `[timed out]`.
- The parallel call itself fails only on invalid input (≤0 or >8 tasks).
- Aggregated result lists every task; the orchestrator decides retry.

## Token accounting

Child usage (input/output/cache) is aggregated into the parent result so
benchmark runs capture the true cost of parallel work.

## Deferred (requires new review)

- Mid-run steering of children
- `pipeline()` stage graphs
- Nested agents (children spawning children)
- Persistent fleet state across turns

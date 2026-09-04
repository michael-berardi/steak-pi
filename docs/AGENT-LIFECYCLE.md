# UltraTerm Subagent Lifecycle

Status: implemented by `extensions/ultraterm-subagents.ts`.
Canonical contract: [`ULTRATERM-SUBAGENT-PROTOCOL.md`](./ULTRATERM-SUBAGENT-PROTOCOL.md).

The legacy `parallel` subprocess executor has been removed. Steak Pi now exposes
one session-scoped UltraTerm Sub-Agent Protocol (USAP) coordinator:

- `ultraterm_subagents` validates and dispatches 1–8 bounded leaves;
- `ultraterm_hub` lists, inspects, waits for, messages, and cancels runs;
- `ultraterm_relay` is available only inside children for run-local peer mail.

## Lifecycle

```text
queued → starting → running ↔ waiting → done | failed | aborted | timed_out
```

Runs are all-settled. A failed leaf does not discard successful sibling evidence.
Foreground dispatch waits for the run. Background dispatch returns stable IDs,
posts one passive completion message, and requires a bounded hub wait before the
parent integrates results.

## Enforced bounds

| Resource | Bound |
| --- | --- |
| Tasks per run | 8 |
| Concurrent children | 4 across the extension session |
| Simultaneously active runs | 16 |
| Run deadline | 10 minutes by default; 1 second–30 minutes accepted |
| Retained terminal runs | 50; oldest terminal records are evicted |
| Assistant turns per child | 12, with a report-now warning after turn 9 |
| Retained output per child | 20,000 characters, with truncation marker |
| Relay body | 4,000 characters |
| Relay mailbox | 100 messages per recipient |
| Relay traffic | 500 accepted envelopes per run |
| Hub wait | 30 seconds per call |

Cancellation prevents queued launches and aborts active native Pi sessions.
`session_shutdown` aborts every live child and clears runtime relay state.

## Isolation and ownership

Children use native in-process Pi `AgentSession`s with:

- an explicit inherited model and thinking level;
- in-memory settings and transcripts;
- no ambient extensions, skills, prompts, themes, or context files;
- role-specific tool allowlists;
- filesystem reads constrained to the run working directory;
- edits and writes constrained to prevalidated, non-overlapping owned paths,
  with case-folded comparisons on macOS and Windows;
- read-only tasks omit writable `ownedPaths` and carry read scope in task text;
- shell access disabled unless explicitly requested; and
- no orchestration tool or recursive delegation path.

USAP is still a coordination boundary, not an OS sandbox. Explicit shell access
shares the operator trust domain and can have side effects outside path ownership.
The parent must inspect every report and changed path, then run integrated proof.

## Accounting

Final assistant-message usage is counted once per child and aggregated once into
the parent session through the foreground dispatch result or the first terminal
background `ultraterm_hub wait`. Status calls and repeated waits do not duplicate
nested usage.

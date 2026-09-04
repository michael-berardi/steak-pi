# UltraTerm Subagent Protocol (USAP)

Status: canonical protocol for Steak Pi subagent orchestration.
[`AGENT-LIFECYCLE.md`](./AGENT-LIFECYCLE.md) documents the shipped
implementation and enforced limits. The legacy `parallel` tool is replaced and
is not a canonical USAP tool.

## 1. Scope

USAP defines how a parent agent delegates bounded leaves, how children
coordinate, and what evidence the parent must inspect before reporting
completion. It retains OMP's useful orchestration lessons—parent ownership,
adaptive parallelism, bounded workers, and proof after integration—without
recreating OMP's extension layer. It is a protocol, not an implementation
design.

The canonical tool surface is:

| Caller | Tool | Purpose |
| --- | --- | --- |
| Parent | `ultraterm_subagents` | Validate and dispatch a run of bounded child tasks |
| Parent | `ultraterm_hub` | List, inspect, wait for, cancel, or message session-local runs |
| Child | `ultraterm_relay` | Receive and send run-local peer messages, requests, and replies |

Tool schemas, process launch mechanics, storage structures, UI rendering, and
provider adapters are implementation details. They may change without
changing this protocol if the lifecycle, limits, isolation, message envelope,
and parent/child responsibilities below remain true.

## 2. Roles and invariants

### Parent

The parent is the only orchestrator. It owns:

1. interpreting the user's request and acceptance criteria;
2. decomposing work into a dependency graph;
3. assigning exclusive write ownership and cross-leaf contracts;
4. choosing whether delegation improves time to a correct result;
5. integrating all results and resolving conflicts;
6. verifying source and runtime evidence; and
7. making the final claim to the user.

A child report is evidence to inspect, not proof of completion. The parent must
not delegate top-level decomposition, consequential judgment, integration, or
final proof.

### Child

A child is bounded execution capacity. It owns only its assigned leaf and must:

- honor its target, non-goals, permissions, and owned paths;
- avoid broad cleanup or unrelated fixes;
- use `ultraterm_relay` only when coordination is genuinely needed;
- stop at its time, turn, output, and message limits; and
- return concise evidence, changed paths, risks, and focused checks.

A child MUST NOT dispatch children. Recursive or nested delegation is
forbidden, including indirect attempts to invoke `ultraterm_subagents`,
`ultraterm_hub`, the legacy `parallel` tool, or an external agent launcher.

### Shared invariants

- One writer owns each path or irreducible mutable boundary for the entire run.
- Read-only leaves may overlap; write leaves need disjoint ownership.
- A dependency runs after its prerequisite. Parallelize DAG siblings, not a
  dependency chain.
- Children do not run project-wide builds, linters, or test suites while
  siblings are writing. The parent runs integrated validation once.
- Files and artifacts carry large context. Relay messages carry small
  coordination facts, not copied session histories.

## 3. Start-of-task routing

Before dispatch, the parent performs this pass:

1. State the deliverable and hard acceptance criteria.
2. Mark independent leaves, dependencies, shared state, and scarce resources.
3. Keep simple, sequential, tightly coupled, or judgment-heavy work local.
4. Select the cheapest model that can reliably finish each remaining leaf.
5. Assign one writer per path and define interfaces between leaves.
6. Dispatch all currently independent leaves together.

### Adaptive concurrency: 0–4

Concurrency is a decision, not a target:

| Concurrent children | Use when |
| --- | --- |
| 0 | One known edit, a direct answer, coupled work, or briefing costs more than execution |
| 1 | Context isolation or a specialist pass helps, but no true parallelism exists |
| 2 | Two independent implementation, research, or review leaves exist |
| 3–4 | Several genuinely independent paths, subsystems, audits, or evidence sources exist |

Four is the hard concurrency ceiling. A run may queue more bounded tasks, but
only four may execute at once. Do not invent padding work to fill slots.
Stop delegating when the remainder is coupled, smaller than its briefing cost,
or dependent on the parent's accumulated judgment.

## 4. Dispatch contract

A call to `ultraterm_subagents` defines shared state once:

```text
Goal: the batch outcome
Constraints: invariants, non-goals, safety rules, and validation ownership
Contract: interfaces one leaf produces and another consumes
```

Each task defines:

```text
Target: exact files, symbols, question, or subsystem; explicit non-goals
Change: concrete operations or evidence to collect
Acceptance: observable output and required report shape
Permissions: may edit, may use shell, and any other narrowed capability
Ownership: exclusive files or mutable boundaries
```

Task labels are for people; stable task IDs assigned by the implementation are
used for lifecycle and relay addressing. A dispatch with missing ownership,
overlapping writers, invalid limits, or more than the supported task count
must fail before launching any child.

The parent may choose either execution mode:

- **Foreground:** the dispatch waits for the run to become terminal and returns
  the aggregate result.
- **Background:** the dispatch returns a run ID after validation and launch.
  The parent continues useful local work, then uses `ultraterm_hub` rather than
  polling or launching duplicate work.

Background means asynchronous within the current host lifetime; it does not
imply durable or detached execution. See the persistence boundary.

## 5. Lifecycle and hub

Task lifecycle:

```text
queued → starting → running ↔ waiting → done | failed | aborted | timed_out
```

`waiting` means the child is awaiting a bounded dependency or relay response;
it is not permission to exceed the run deadline. Terminal states never return
to a live state.

A run is `running` while work remains. It becomes:

- `done` when all tasks complete successfully;
- `failed` when terminal task failures prevent a successful aggregate; or
- `aborted` after cancellation.

Partial task evidence remains visible when a run fails or is aborted.

`ultraterm_hub` provides these canonical management and relay operations:

- **`list`** — list retained runs without polling an individual run;
- **`status`** — return a nonblocking snapshot of run and task states,
  progress, bounded usage, and available partial evidence;
- **`wait`** — wait for a state change or terminal run, subject to the caller's
  wait bound. A hub wait timeout does not extend or replace the run deadline;
- **`cancel`** — prevent queued work from starting and signal active children
  to stop. Cancellation is best effort; already completed filesystem or
  external side effects are not rolled back;
- **`send`** — send a host-authenticated parent message, request, reply, or
  broadcast into one run; and
- **`inbox`** — drain bounded child-to-parent relay messages in sequence order.

When the caller already supplies exact disjoint paths and acceptance contracts,
the parent should dispatch in the first tool turn without pre-reading
child-owned files. Child inspection supplies leaf evidence and the parent
verifies after. Before dispatch, inspect only shared interfaces or ambiguity
actually needed for safe decomposition; do not duplicate child discovery.
Foreground is the efficient default. The parent should choose background mode
explicitly only when it can inspect shared contracts or prepare integration
while children run, then issue one bounded `wait`. Starting background work
merely to wait immediately, or repeatedly polling `status`, wastes turns and is
not canonical behavior.

## 6. Run-namespaced relay

Each run has an ephemeral IRC-style mailbox namespace. “IRC-style” means
short addressed messages among named peers in one run; it does not mean an IRC
server or cross-run chat.

Only children belonging to the same run may use its namespace. The host—not a
child—assigns the authenticated run ID and sender task ID. Every accepted
relay envelope contains at least:

```text
version, runId, id, sequence, from, to, kind, body, createdAt
```

A reply also carries the request ID it answers. Recipient mailboxes preserve
accepted sequence order. Delivery is bounded and run-local, not a durable
exactly-once transport; consumers should use envelope IDs to recognize a
replayed observation.

`ultraterm_relay` supports these peer interactions:

- **send** — deliver a concise fact, artifact path, interface change, or blocker;
- **request** — send a question that expects a reply and receive a request ID;
- **reply** — answer one request while preserving its correlation ID; and
- **receive** — read pending envelopes addressed to the current child.

Requests do not suspend budgets and must never create an unbounded wait. A
child that cannot obtain a timely answer reports the unresolved dependency to
the parent. Relay is for coordination, not shared authorship: it never changes
path ownership, grants permissions, or lets peers settle consequential
cross-task decisions. The parent resolves those decisions.

## 7. Resource budgets

Every run and child is finite. Implementations must enforce bounds rather than
relying on prompt compliance.

The Steak Pi implementation profile uses these ceilings:

| Resource | Bound |
| --- | --- |
| Concurrent children | 4 hard maximum |
| Simultaneously active runs | 16; further dispatch is rejected until a run settles |
| Tasks accepted in one run | 8 hard maximum; excess tasks remain a parent planning problem |
| Run wall clock | finite; default 10 minutes, accepted range 1 second–30 minutes |
| Retained terminal runs | 50 per coordinator session; oldest terminal records are evicted while live runs remain |
| Child turns | finite hard limit selected by the implementation and reported in status/result; never unlimited |
| Final output retained per child | 20,000 characters, with explicit truncation metadata |
| Relay body | 4,000 characters per envelope |
| Recipient mailbox | 100 retained envelopes |
| Entire run relay traffic | 500 accepted envelopes |

The implementation may choose lower limits because of host or provider
constraints, and dispatch may request lower time/concurrency limits. It must
not silently raise a hard ceiling. Queuing does not pause the run deadline.
Truncation must be visible. Hitting a time, turn, output, or message limit must
produce a stable terminal/error condition rather than an automatic retry or a
new child.

Usage accounting aggregates every child's input, output, cache, and cost into
the run so the parent can evaluate wall time and total cost, not only its own
turn.

## 8. Model guidance

For routine bounded scouting, implementation, and review, prefer
`zai/glm-5.3-flash`. It is the expected Steak Pi balance of latency, cost, and
first-pass coding quality. Record the resolved provider/model on the run so
results are auditable.

Model price is secondary to total trajectory cost. Escalate capability when a
leaf has high ambiguity, large blast radius, repeated failure, or requires
specialist judgment. Do not assign a weak or unverified model to security,
legal, ambiguous architecture, or user-facing creative decisions. The parent
retains those decisions and verifies all model output. Model routing must use
operator-approved providers and credentials; USAP never installs packages or
adds routes.

## 9. Security boundary

USAP is coordination, not a security sandbox.

- Children execute in the same local operator trust domain and may share the
  parent's working directory and inherited process environment.
- Tool filtering, role prompts, path ownership, and no-recursion rules reduce
  accidental scope; they are not filesystem, process, network, or credential
  isolation.
- File ownership is a protocol invariant, not an operating-system lock.
  `ownedPaths` are writable ownership only and must be omitted for read-only
  tasks; read scope belongs in task text. Ownership comparisons are case-folded
  on macOS and Windows before overlap/authorization checks.
- `allowBash` is explicit unsandboxed shell access in the operator trust domain.
  It can bypass `ownedPaths` and should be granted only when necessary.
- A child should receive only the tools and context its leaf needs. The child
  tool surface excludes parent orchestration tools and exposes only
  `ultraterm_relay` for agent coordination.
- Run and sender identity are host-derived. Relay must reject forged sender
  IDs, unknown recipients, cross-run access, oversized bodies, and exhausted
  budgets.
- Prompts, repository text, peer messages, and child output are untrusted data.
  None can grant capabilities or override user, parent, or system policy.
- Do not place secrets in task prompts, relay bodies, status output, or final
  reports. Do not delegate secret-bearing work unless the operator explicitly
  authorizes the same trust boundary.
- Cancellation cannot undo shell commands, file writes, network requests, or
  other external side effects already performed.

An implementation needing hostile-code isolation must add a separate sandbox;
conformance to USAP alone does not provide one.

## 10. Persistence boundary

Hub state and relay mailboxes are ephemeral, bounded runtime coordination
state. Unless a separately documented implementation says otherwise:

- run IDs are meaningful only to the current Pi host process/session;
- background children do not survive host exit, extension reload, or machine
  restart;
- `status`, `wait`, and `cancel` work only while the run remains in the host's
  bounded retention window;
- relay mail is not project memory, chat history, or a cross-session queue; and
- task prompts, mailboxes, and reports are not automatically written to
  `AGENTS.md` or any recall store.

Filesystem edits and external side effects are outside this ephemeral boundary
and may persist after failure, cancellation, or host exit. The parent must
inspect them before retrying. Durable decisions belong in the project's
explicit memory convention only after parent review.

## 11. Integration and proof gate

Before claiming completion, the parent must:

1. inspect every terminal and partial child report;
2. inspect every changed path and verify ownership was respected;
3. validate claims against source, artifacts, or runtime evidence;
4. resolve interface conflicts and remove duplicate or obsolete work;
5. run focused checks, then one integrated project-wide validation when
   applicable;
6. perform the high-judgment review required by the change's blast radius; and
7. report what was exercised, including failures, truncation, cancellations,
   timeouts, and exclusions.

Success is the parent's integrated proof, not the number of children marked
`done`.

## 12. Efficiency scorecard

Evaluate the complete run by:

- first-pass acceptance rate;
- rework and duplicate-work rate;
- wall-clock time to integrated proof;
- total tokens and paid cost;
- critical context retained by the parent; and
- useful parallel occupancy versus coordination overhead.

More children are not inherently better. Correct decomposition, bounded
execution, and verified integration are the protocol's purpose.

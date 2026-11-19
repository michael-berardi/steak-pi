# Claude Code on your coding plan

Steak Pi ships a built-in `claude-code` provider. It runs your Claude models
through the official Claude Code CLI on your own Claude Pro or Max
subscription. Pi keeps the conversation, tools, approvals and compaction;
Claude Code only talks to the model and never runs a tool itself.

No separate extension install: the provider loads with Steak Pi.

## Use it

```sh
npm install -g @anthropic-ai/claude-code   # once
claude auth login                          # once, your subscription login
pi --model claude-code/claude-opus-5-5
```

Pick any model from the **Claude Code Subscription** provider in Pi's model
picker, or pass `--model claude-code/<id>`. Ids: `claude-fable-5-2`,
`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `default`, plus any
id the installed CLI reports. The `fable` alias selects `claude-fable-5-2`.
`/claude-code-status` checks that the CLI is installed and logged in.

## Billing and safety

- The route is a subscription route. Steak Pi's subscription-first policy
  accepts exactly `claude-code` with `process://claude-code`; nothing else
  gets that exemption and no paid-route approval is involved.
- The provider refuses to run when the environment sets an API key, proxy,
  Bedrock, Vertex or Foundry override for Claude Code.
- **Billing risk.** Anthropic has announced that `claude -p` usage could move
  to a separate "Agent SDK credit" billed at API rates and has put that change
  on hold. If your account reports usage-credit overage, the provider stops
  after the response that was charged and fails closed with an error. Set
  `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS=1` only if you accept that cost.
- Transient upstream failures (connection reset, timeout, 5xx/529 before any
  output) are retried a bounded number of times. Authentication, 4xx and
  billing errors are never retried, and every failure names its cause.

## Stalled turns and cancellation

Streaming turns are bounded by inactivity, not total duration: a reply that
keeps sending bytes or events may run longer than `timeoutMs`. Pi supplies its
HTTP idle budget (normally 300,000 ms); direct callers default to 180,000 ms
and may set any positive, finite `timeoutMs`. Worker acquisition, history
replay, response headers, first byte, drain and settlement each have bounded
non-streaming waits. Every byte from the API (events, thinking and tool-input
deltas, keepalive pings) and every Claude Code stdout line counts as activity,
and a relay retry or backoff resets the native timer.

Silence is judged per stage, from that budget (300,000 ms in the examples):

| Stage | Limit | When it expires |
| --- | --- | --- |
| No answer yet (headers, first byte) | 0.3 x budget, widened by reasoning effort (+15% a step) and request size (up to +50%): 90 s to about 190 s | The relay sends the same request again on a new connection. Nothing has reached Claude Code or you, so no output is repeated, but a resend can be billed again, so it comes out of the request's send budget (below). |
| Mid-reply silence | 1.4 x budget, +0.1 per effort step, +0.1 for a very large request, at most 1.8 x budget: 420 s to 540 s | Automatic recovery, below. |

Measured 2026-11-18: three turns on a 230k to 450k token context each went
exactly 300 s with no byte from the API and ended with "stream idle limit
exceeded"; none had started a content block. The old single 300 s limit was
both too long for a connection that never answers and a dead end for the turn.

**Automatic recovery.** When a reply goes quiet past its limit, Steak Pi stops
only that Claude Code process (and its relay), starts a fresh one for the same
Pi session, replays the conversation from Pi's own transcript and asks again,
but only while nothing of the turn has been shown yet.
The process is only a transport (no tools, one turn, an inert MCP server): Pi
runs tools itself after a reply is complete, and every finished tool result is
part of the replayed history, so a recovery cannot run a tool twice. Output
already sent to the Pi stream (text, thinking or a tool call) cannot be taken
back, so once any has appeared the turn is not asked again: it fails with the
named error and `resume` continues it. A reply the API already finished
(`message_stop` received) is never asked for again either: if Claude Code goes
quiet after that, the turn finishes from the received reply and the hung
process is dropped. At most two recoveries are made, with a short pause between
them; a process that had already exited is a crash and is reported, not
retried.

**Send budget.** One request is sent to the API at most **3 times in all**,
counting the relay's quiet retries before the first byte, retries after a
retryable status (500, 502, 503, 504, 529) and every recovery together (it was
up to 9: 3 relay attempts in each of 3 processes). The budget is fixed; it is
not an environment setting. A resend can be billed again, so there is no claim
that a retry is free. When the budget is spent the error says the request was
already sent 3 times. A line in the
notifications says what happened, and while a turn is silent the status line
shows `waiting on the model: N s since last event`.

When recovery is spent the error names the cause: how long the reply was
silent and in which stage, the last event seen, whether the process was alive,
whether the API had sent anything, and how many recoveries were tried, then
says to send `resume` or raise a limit. Pi does not retry that error again.
USAP workers on a Claude Code model get the same recovery (they run through
this provider); a worker that still hits the idle limit is resumed by the
coordinator's transient-failure rule.

The 3-send bound is per turn, inside the provider. A USAP worker's auto-resume
is a separate, bounded layer on top of it: after a turn ends with the idle
error, the coordinator may resume the worker at most 2 times
(`MAX_AUTO_RESUMES`), after 10 s and then 30 s, and only while the run has at
least 90 s of budget left. Each resumed turn starts a new 3-send budget, so
the real worst case for one stalled worker step is 3 x (1 + 2) = 9 sends of
that request, spread over at least 40 s of waiting plus the silence limits.
Only the idle errors that say recovery was spent, the reply could not be taken
back, or the 3 sends were used are resumed; a crash, "recovery is off" and
"the API had already sent the whole reply" are never resumed. A refused
`ensure` hook of a local-model profile is never resumed either, whatever words
its reason contains.

Set these in the environment Pi runs in (absolute values, not scaled):
`PI_CLAUDE_CODE_IDLE_LIMIT_MS`, `PI_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS`, and
`PI_CLAUDE_CODE_MAX_RECOVERIES` (0 to 2; 0 turns recovery off; a larger whole
number is set to 2 with a one-time warning naming the variable, and a value
that is not a whole number fails the turn with its name). The two limits
are rounded to whole milliseconds, must be from 1000 to 2147483647 (the
largest timer Node supports), and a bad value fails the turn with its name
before any process starts.

Escape stops a running turn immediately. Cleanup waits at most two seconds
for inherited output pipes before dropping them, so an MCP process cannot
keep the next message queued forever. A queued steering message is preserved
when the failed turn ends and can be continued normally. On Windows, cleanup
never invokes `taskkill` after the spawned leader has exited. On POSIX, only
detached groups created by this transport are signalled; an exited leader's
group is eligible for one second, then skipped because its ownership can no
longer be verified. Non-detached auth probes are stopped individually.

Every forwarded request is capped at four cache markers. Extra markers are
removed from the oldest message first, preserving static prefixes and the
newest message where possible. If static markers alone exceed the cap, tools
are dropped before system markers. The first removal reports only the count
through the extension's notification UI, never directly to stderr.

## Configuration

- `PI_CLAUDE_CODE_COMMAND`: Claude Code executable (default `claude`).
- `PI_CLAUDE_CODE_CONFIG_DIR`: Claude Code config directory (passed as
  `CLAUDE_CONFIG_DIR`).
- `PI_CLAUDE_CODE_IDLE_LIMIT_MS`, `PI_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS`,
  `PI_CLAUDE_CODE_MAX_RECOVERIES`: silence limits and automatic recoveries
  (see Stalled turns and cancellation).

## Credit

The provider is derived from
[earendil-works/pi-claude-code](https://github.com/earendil-works/pi-claude-code)
by Armin Ronacher, MIT licensed. The upstream license is kept in
`extensions/claude-code/LICENSE` and its design notes in
`extensions/claude-code/ARCHITECTURE.md`.

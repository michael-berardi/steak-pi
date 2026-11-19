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
| No answer yet (headers, first byte) | 0.3 x budget, widened by reasoning effort (+15% a step) and request size (up to +50%): 90 s to about 190 s | The relay quietly sends the same request again on a new connection (up to three attempts). Nothing has reached Claude Code, so nothing is repeated. |
| Mid-reply silence | 1.4 x budget, +0.1 per effort step, +0.1 for a very large request, at most 1.8 x budget: 420 s to 540 s | Automatic recovery, below. |

Measured 2026-11-18: three turns on a 230k to 450k token context each went
exactly 300 s with no byte from the API and ended with "stream idle limit
exceeded"; none had started a content block. The old single 300 s limit was
both too long for a connection that never answers and a dead end for the turn.

**Automatic recovery.** When a reply goes quiet past its limit, Steak Pi stops
only that Claude Code process (and its relay), starts a fresh one for the same
Pi session, replays the conversation from Pi's own transcript and asks again.
The process is only a transport (no tools, one turn, an inert MCP server): Pi
runs tools itself after a reply is complete, and every finished tool result is
part of the replayed history, so a recovery cannot run a tool twice. The text a
stalled attempt had already streamed is dropped from the partial message. At
most two recoveries are made, with a short pause between them; a process that
had already exited is a crash and is reported, not retried. A line in the
notifications says what happened, and while a turn is silent the status line
shows `waiting on the model: N s since last event`.

When recovery is spent the error names the cause: how long the reply was
silent and in which stage, the last event seen, whether the process was alive,
whether the API had sent anything, and how many recoveries were tried, then
says to send `resume` or raise a limit. Pi does not retry that error again.
USAP workers on a Claude Code model get the same recovery (they run through
this provider); a worker that still hits the idle limit is resumed by the
coordinator's transient-failure rule.

Set these in the environment Pi runs in (absolute values, not scaled):
`PI_CLAUDE_CODE_IDLE_LIMIT_MS`, `PI_CLAUDE_CODE_FIRST_BYTE_LIMIT_MS`, and
`PI_CLAUDE_CODE_MAX_RECOVERIES` (0 to 10; 0 turns recovery off).

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

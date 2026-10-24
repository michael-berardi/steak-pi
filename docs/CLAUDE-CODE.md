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
picker, or pass `--model claude-code/<id>`. Ids: `claude-fable-5-1`,
`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `default`.
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

A stalled request ends with a visible error after three minutes by default;
callers can set a positive, finite `timeoutMs`. The deadline includes history
replay and waiting for a worker, not just gaps between streamed events.
Escape stops a running turn immediately. Cleanup waits at most two seconds
for inherited output pipes before dropping them, so an MCP process cannot
keep the next message queued forever. A queued steering message is preserved
when the failed turn ends and can be continued normally.

Every forwarded request is capped at four cache markers. Extra markers are
removed from the oldest message first, preserving static prefixes and the
newest message where possible; the first removal logs only the dropped count.

## Configuration

- `PI_CLAUDE_CODE_COMMAND`: Claude Code executable (default `claude`).
- `PI_CLAUDE_CODE_CONFIG_DIR`: Claude Code config directory (passed as
  `CLAUDE_CONFIG_DIR`).

## Credit

The provider is derived from
[earendil-works/pi-claude-code](https://github.com/earendil-works/pi-claude-code)
by Armin Ronacher, MIT licensed. The upstream license is kept in
`extensions/claude-code/LICENSE` and its design notes in
`extensions/claude-code/ARCHITECTURE.md`.

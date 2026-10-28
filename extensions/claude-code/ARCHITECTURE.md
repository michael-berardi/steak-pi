# Architecture

This document explains how pi-claude-code works internally. For installation
and usage, see [README.md](README.md).

## Overview

The extension registers a Pi provider that routes all Claude model
communication through the official Claude Code CLI. It talks to Claude Code
through Claude Code's native `stream-json` protocol and translates streamed
responses back into Pi's message format.

Pi remains responsible for conversation history, approvals, compaction, and tool
execution. The extension exposes Pi's tools to Claude Code through an inert MCP
inventory. Claude can request a tool, but Claude Code cannot execute it; the
request is returned to Pi instead.

## Authentication

Claude Code owns and stores its credentials. The extension does not read its
credential files, refresh its tokens, or persist them. Authenticated request
headers do pass transiently through the local turn relay described below.

The provider has an ambient API-key-style auth method without a login flow. Its
`check()` runs `claude auth status` and reports the provider as configured only
when Claude Code is installed and logged in, so Pi hides the models otherwise.
Requests resolve to a placeholder key. It reports Claude
subscription logins as OAuth-shaped auth so that Pi labels list-price accounting
as a subscription. The provider also declares an `oauth` method, marked
`isSubscription`, only so Pi's subscription-aware UI works. Its `login()` never
starts a flow; it tells the user to run `claude auth login`.

Inherited API-key, proxy, Bedrock, Vertex, and Foundry overrides are rejected
to avoid silently changing authentication or billing.

## Usage-credit guard

Claude Code emits a `rate_limit_event` for each turn. If it reports
`isUsingOverage`, the response was charged to usage credits rather than plan
limits, and the turn fails with a non-retryable `Claude Code billing` error
unless `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS` is set. Upstream rejections that
ask for usage credits (for example third-party app classification) are
rewritten into the same kind of error. The latest rate-limit status is attached
to the assistant message as a `claude-code.rate-limit` diagnostic.

## Process reuse

Linear conversations may reuse a warm Claude Code process. Only exact linear
continuations reuse one. Branches, edits, configuration changes, errors, and
tool-use boundaries fall back to a fresh process, which replays Pi's full
conversation. At most two processes are retained, and no process is retained
for more than five minutes.

## Local turn relay

Each Claude Code worker receives an `ANTHROPIC_BASE_URL` that points to a
random, loopback-only HTTP route owned by this extension.

The relay exists because Pi, rather than Claude Code, owns the agent loop and
tool execution. In particular, it:

- forwards exactly one Anthropic Messages request for each Pi turn and rejects
  additional native recovery attempts. Claude Code can otherwise issue another
  generation after an inert MCP tool call, even with one turn and HTTP retries
  disabled;
- captures and streams the first upstream response before Claude Code processes
  it, preserving signed thinking, tool arguments, usage, and the native stop
  reason. This lets Pi retain a valid tool request even when Claude Code later
  reports an `error_max_turns` boundary or a synthetic recovery error;
- records Claude Code's initial native user and system reminders, then restores
  their stable layout during full-history replay. It removes redundant moving
  reminders and adjusts cache breakpoints so tool rounds do not continually
  invalidate the prompt-cache prefix;
- injects supported mid-conversation tool additions and removals at their
  original assistant boundaries and adds the corresponding Anthropic beta
  header; and
- ties cancellation to the active upstream socket as well as the Claude Code
  process.

## Transport wait audit (0.11.6)

- `captureProcess`: auth waits for **exit**, not inherited-pipe close, with a
  20-second deadline and abort cleanup that destroys local pipes.
- `discoverClaudeModels`: the entire readline/exit operation is bounded
  (20 seconds by default). Closing stdout without exiting, or a detached
  grandchild inheriting stdout, cannot strand discovery. Once the models arrive,
  only the leader's exit is awaited, not inherited stdout EOF.
- `writeFrame`: backpressure listens for drain, error, close and abort and
  also has a deadline, with pre-closed/aborted guards after listener setup.
  Non-backpressured stdin errors also terminate the output queue.
- `AsyncQueue.next`: idle timeout, abort and queue end all settle a waiter;
  abort takes priority over buffered events, and terminal queues ignore late
  pushes. Native stdout bytes and relayed upstream bytes reset the idle budget,
  including SSE keepalives that do not yield model events. History replay still
  has a wall bound even when the native process sends non-final events.
- `exitError`: stdout EOF does not imply process exit; the exit wait is bounded.
- `ClaudeProcess.close`: a two-second grace bounds readline, exit and relay
  cleanup; inherited stdout/stderr are destroyed afterward. Aborted requests
  do not wait for teardown before publishing their error.
- Process-manager acquisition is abortable and bounded without releasing a
  predecessor's lock early; auth/process creation uses the acquisition signal.
  This wall deadline is disarmed before response streaming starts.
- Relay startup, body read, response headers, first/subsequent iterator reads,
  drain, retry backoff, settlement and server close are bounded. Each streaming
  read has an idle budget, not a turn-wide wall cap: steady trickles can outlive
  `timeoutMs`. A closed response is rejected even if close preceded registration.
  Local wait-limit errors retain a terminal cause without retryable status or
  timeout wording, even if a native wrapper adds transient-looking text.
- `streamClaudeCode` has one await, `runClaudeRequest`; it translates rejection
  into an error event and ends the Pi stream. It does not consume steering;
  Pi retains that queue until continuation after an error.

Ordinary local filesystem operations are not pipe/drain waits. The stdout
reader may remain alive during a turn, but abort/close destroys its pipe and
request/queue deadlines bound every caller waiting for its output.

## Tool schemas

Tool schemas are normalized for Claude Code. Nullable variants and schema
composition such as `oneOf`, `allOf`, and `anyOf` may be simplified or removed.

Exact mid-conversation tool additions and removals, including prompt-cache
preservation, work only on supported models. Other cases fall back to the
current tool state and may lose prompt-cache reuse.

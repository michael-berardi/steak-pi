# Antigravity CLI (`agy`) route

Steak Pi can run Google's Gemini models through Google's **official** Antigravity CLI, `agy`, the way Google documents it for [IDE extensions (ACP)](https://antigravity.google/docs/ide/extensions/acp/) and [headless scripts](https://antigravity.google/docs/cli/headless). Steak Pi never talks to Google's service itself and never reads, copies or passes agy's credentials: it starts `agy` as a child process and relies on agy's own cached sign-in.

This replaces the earlier direct Antigravity OAuth provider, which was removed: Google's terms say "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts." If `~/.config/ultraterm/antigravity.json` still says `"enabled": true`, Steak Pi shows one notice at session start saying so. The file is not touched; delete it.

## Set up

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash   # install agy
agy                                                            # run it once and sign in
```

Then, in Pi or Steak DSH, pick a model under the **Google Antigravity CLI (agy)** provider. `/agy-status` reports whether agy is installed and signed in.

## Two transports

Set `STEAK_PI_AGY_TRANSPORT` (Pi) or `STEAK_DSH_AGY_TRANSPORT` (Steak DSH; wins when both are set) to `acp`, `headless` or `auto`. The default `auto` tries ACP and otherwise uses headless. Any other value is a named error, not a silent default.

| Mode | What runs |
| --- | --- |
| `acp` | One long-lived `agy acp` process per Pi session; no headless fallback. Failures name their cause. |
| `headless` | The original one-process-per-turn `stream-json` route, unchanged. |
| `auto` (default) | `agy acp --help` is checked first; if that fails, or `initialize` fails, Steak Pi logs the reason (a warning in Pi) and falls back to headless. Mid-turn ACP errors are **not** retried headlessly. |

### ACP mode

The child is started once per Pi session with:

```
agy acp --process-per-session --disable-telemetry
```

Google's docs say `--process-per-session` is "Required for HTTP MCP servers that your editor configures" and describe `--disable-telemetry` as "Disable telemetry for this server". Steak Pi never passes `--dangerously-skip-permissions`, `--gemini-dir` or an isolated home: no credential file is read or copied. Google's docs say `agy acp` "uses the credentials you cached with an interactive agy session. If no credentials are available, requests fail with the error Authentication required (code -32000)". That error is reported as *not signed in — run agy once to sign in*; in `auto` mode the fallback is logged, never silent.

The ACP flow is our own JSON-RPC 2.0 client: `initialize` → `session/new` with the loopback MCP bridge → `session/prompt` with streamed `session/update` notifications → `session/cancel` on Pi abort. ACP tool calls and permission requests use the protocol's `session/request_permission`/outcome exchange. (ACP spec: "Before a Session can be created, Clients MUST initialize the connection by calling the initialize method"; "Clients create a new session by calling the session/new method with: The working directory for the session. A list of MCP servers the Agent should connect to"; "Agents send session/update notifications to report streamed content, tool activity, and changes to session state"; "Clients MAY cancel an ongoing prompt turn at any time by sending a session/cancel notification".)

ACP keeps the conversation live: each turn sends Pi's system instructions plus the outstanding user request, not a 100 KB replayed transcript. The session is reset on `session_start`, `session_tree` and `session_compact`, and disposed on `session_shutdown`, so a branch or compaction cannot leave a stale conversation. Text and thinking stream as Pi `text_*` and `thinking_*` events.

### The Pi tool bridge and its security model

Before `session/new`, Steak Pi starts an HTTP MCP server bound to `127.0.0.1` on an ephemeral port. The URL and a fresh 256-bit bearer token for this session are passed in ACP's `mcpServers` list (the ACP HTTP transport example uses `{"type":"http","url":...,"headers":[{"name":"Authorization","value":"Bearer ..."}]}`). The token is compared with a fixed-length SHA-256 digest and `timingSafeEqual`; the server closes with the ACP session. No token is logged.

MCP `tools/list` exposes the tool declarations Pi puts in the **provider request transcript** (`getCurrentTools(context.messages)`, i.e. the system message's `toolsAdded`) under a `pi_` prefix, so they cannot be confused with agy's own tools. Event-handler contexts (`session_start`, `agent_start`, `before_provider_request`, `context`) come from Pi's `createContext()` and have no `tools` or `executeTool`; the bridge does not borrow tools or execution from them.

MCP `tools/call` is **parked** as a Streamable HTTP SSE response: headers and keepalive comments leave immediately (the reference runtime reports a 60-second client header timeout), while the call waits for Pi's normal tool loop. The provider emits a regular Pi assistant `toolCall` block (id, name, arguments) and ends that Pi step with `stopReason: "toolUse"`. Pi then validates the call, runs hooks and approvals, executes the tool, and appends a `toolResult` message. On the next `streamSimple` call the provider finds that result by tool-call id, answers the parked MCP call with its real content, and lets **the same ACP `session/prompt` turn** continue to agy's final answer. Several parallel bridged calls in one step produce several `toolCall` blocks and are all resumed from the results in the next step.

If the Pi turn is aborted, the provider sends ACP `session/cancel` and answers parked calls with an error result. If a step arrives without a matching `toolResult`, that call also gets an error result. Session start/tree/compact/shutdown closes the session and bridge and releases any parked HTTP calls. ACP `tool_call` notifications are not emitted as Pi tool blocks: the parked MCP request is the single source of truth, so no tool runs twice.

Steak Pi deliberately does **not** pass `--dangerously-skip-permissions`. Google documents that flag as "Auto-approve all tool permission requests" and says "Only do this in a sandboxed or disposable environment". The reference implementation's minimal agent (`tools: []`, `excludeDefaultComponents: true`) depends on an isolated agy home and a credential copy, which we do not use; Google's public CLI docs document custom agent files but do not document those fields. We therefore cannot guarantee a native-tool-free agent and do not skip permissions: agy's `session/request_permission` requests are routed to Pi's own `ui.confirm` approval path, and are denied or cancelled when no dialog is available. Native agy tools remain present but cannot run silently. `--sandbox` is available in agy but is not passed by default (it is an OS containment restriction, not a substitute for Pi's approvals).

### Context window and effort

No 200 KB guess is used once the server answers. Context size comes from ACP `usage_update.size` (or an agy `max_context_tokens`/context option), and effort values come from the session's `thought_level` config option — Google documents the pickers as "Model — The models available to your account" and "Thinking level — Low, Medium, High, Extra, Max". Pi levels map to the values the server actually advertises (`minimal`/`off` → Low, `xhigh` → Extra, `max` → Max), through `session/set_config_option`. The model's context window and thinking-level map are updated in the live session and reused for the model list. ACP's cumulative multi-step input/cache buckets are scaled to single-call occupancy so Pi's overflow check does not compact early.

## Headless mode (fallback)

```
agy --input-format stream-json --output-format stream-json --model <id> --disable-slash-commands [--effort <level>] [--mode <mode>] [--conversation <id>] --add-dir <cwd>
```

The prompt is not on the command line: Steak Pi writes it to agy's stdin as one `{"event":"user","message":{"content":"..."}}` line and closes stdin, so it does not show in `ps`, cannot exceed the argument-size limit and cannot be read as a flag. It runs in the session's working directory. Each tool step agy runs is shown as a read-only progress line in the answer (for example `› agy run_command: npm test`); these are display only, are not Pi tool calls, and are left out when the conversation is replayed. agy runs those tools under agy's own permission rules; Steak Pi never passes `--dangerously-skip-permissions` here either.

Pi's thinking level maps to `--effort`: off, minimal and low become `low`; medium, high, xhigh and max pass through. When Pi sends no level, no `--effort` is passed and the model's own effort applies. One process per turn means stdin closes after a single prompt: when Pi's history ends exactly where agy's last conversation ended (same model, same session), the turn sends every message written since agy's last reply with `--conversation <id>`; otherwise a new agy conversation gets your last message plus a compact text transcript (capped at 100,000 bytes, oldest turns dropped first). `STEAK_PI_AGY_MODE=accept-edits|auto|plan` passes `--mode`; unknown values are named errors.

## Cancel, timeout and errors

ACP abort sends `session/cancel` and ends the stream as aborted. Headless abort sends SIGINT to agy's process group (agy records INTERRUPTED), then SIGTERM after 3 s, then SIGKILL after 2 s more; the whole process group is killed with SIGKILL whenever agy exits, so tools it started cannot outlive it, and a grandchild holding agy's output open cannot hang the turn. If Pi gets SIGHUP or SIGTERM, or exits, live agy children are killed too. A turn stops after 30 minutes (`STEAK_PI_AGY_TIMEOUT_MS` changes it). Errors name their cause; nothing falls back silently:

| Cause | What you see |
| --- | --- |
| agy missing | `agy ... was not found ... Install it with: curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| not signed in | `agy is not signed in (agy said: ...); run agy once to sign in.` (ACP error `-32000` is mapped to this) |
| plan lacks the model | `agy does not offer the model "<id>" on this account's plan ... Run agy models` |
| ACP protocol / bridge failure | named, including missing HTTP MCP capability, unknown stop reason, or transport failure |
| timeout / cancelled / interrupted / waiting | named, with agy's status |

The provider is normally hidden when agy is missing or signed out. A signed-out headless agy waits a minute for a browser sign-in; Steak Pi stops it 1.5 s after agy says "Authentication required" and names the cause.

## Settings

| Variable | Meaning |
| --- | --- |
| `STEAK_PI_AGY_TRANSPORT` / `STEAK_DSH_AGY_TRANSPORT` | `acp`, `headless` or `auto` (default `auto` = ACP when available). DSH's value wins if both are set. |
| `STEAK_PI_AGY_BIN` | Path of the `agy` binary (default `agy` on PATH). Tests point it at a fake. |
| `STEAK_PI_AGY_MODE` | Headless only: `accept-edits`, `auto` or `plan`; default: agy's own default. |
| `STEAK_PI_AGY_TIMEOUT_MS` | Longest headless turn; default 1,800,000. |

## Verification and limits

The implementation is tested offline with a fake `agy acp` (JSON-RPC over stdio) that performs a real HTTP MCP `tools/list` round trip and parks `tools/call` requests until the test harness supplies Pi's tool result. The suite covers a bridged call becoming a Pi `toolCall` block, the next step's `toolResult` answering that call while the ACP prompt continues to a final answer, parallel calls, abort, missing result, SSE keepalives, session reset while parked, no-UI permission rejection, token checks, normalisation, fallback logging, and the pre-existing headless fixtures. One regression test builds Pi's real event context with `ExtensionRunner.createContext()` and shows it has no `executeTool`/`getCallableTools` — the reason the old context-borrowing design exposed no tools.

Verified offline only: `npm test` and `npm run typecheck`. Nothing was verified live: agy is not installed or signed in on the development machine, and it was not installed for this work. Live checks still needed after the operator installs agy and signs in: whether agy's runtime keeps one ACP prompt open across a parked HTTP MCP call (including its actual header/keepalive timeout), native agy tool behaviour without `--dangerously-skip-permissions`, real effort/model option ids for each plan, actual `usage_update`/`max_context_tokens` values, and HTTP MCP connection under `--process-per-session`.

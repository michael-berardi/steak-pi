# Google Antigravity

An optional, built-in provider module that lets Steak Pi talk to Google Antigravity (the Cloud Code Assist
service behind it) with your own Google sign-in. It adds the ability only: it is **off until you turn it on**,
it ships **no model, no default routing, no OAuth client and no account**, and it does nothing at startup beyond
reading one small file.

It is Steak Pi's own implementation, written from the service's wire behaviour and Pi's provider contract. It
is not a copy of, and does not depend on, any Antigravity plugin for Pi.

## Turn it on

Create `~/.config/ultraterm/antigravity.json` (override the path with `STEAK_PI_ANTIGRAVITY_CONFIG`) and
`chmod 600` it:

```json
{
  "enabled": true,
  "clientId": "<your OAuth client id>",
  "clientSecret": "<your OAuth client secret>"
}
```

Then restart Pi (or `/reload`). Without that file, or without `"enabled": true`, nothing of the module loads and
nothing is registered.

`clientId` and `clientSecret` are an OAuth client (type "desktop") that you are allowed to use with the service.
Steak Pi does not ship one. Without them, sign-in stops with a message that says so.

Optional keys:

| Key | Default | Meaning |
|---|---|---|
| `baseUrls` | `["https://cloudcode-pa.googleapis.com"]` | Provider endpoints, tried in order only when one cannot be reached before the request body had finished uploading. After that the request is not sent to another endpoint, and neither is a request that got an answer (including a 5xx). https only (http to localhost, for tests). |
| `authUrl`, `tokenUrl` | Google's OAuth endpoints | Sign-in endpoints. |
| `scopes` | the service's six scopes (`aicode`, `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`) | OAuth scopes requested. The list is configurable: replace it to ask for fewer. Whether the service needs the last two is not verified. |
| `redirectPort` | `51121` | Loopback port of the sign-in callback. It must match the redirect registered for your OAuth client. |
| `userAgent` | `steak-pi-antigravity/<version>` | Sent as the `User-Agent` header and as `userAgent` in the request envelope. |
| `requestType` | `"agent"` | Sent as `requestType` in the request envelope. |
| `ideType` | `"ANTIGRAVITY"` | Sent as `metadata.ideType` in the project lookup. |
| `projectId` | found at sign-in | Cloud project the quota is billed to. |
| `maxRateLimitWaitMs` | `30000` | Longest single wait for a rate limit (0 to 300000). A longer wait is not taken: the request fails and says when to retry. |
| `maxRateLimitRetries` | `2` | Times a rate-limited request is sent again after waiting (0 to 3). |

A config file that exists but is invalid is an error that names the file and the key; it never leaves the
provider silently off. The config decides where your token is sent, so while the module is enabled a file that other users can write, or
that another user owns, is refused (the error gives the `chmod`/`chown` to run), and so is a file holding a client
secret that other users can read (`chmod 600`).

### What identifies the module to the service

Two values are fixed by default because the service's wire format uses them and they could not be tested against
a real account here: `requestType` is `"agent"` and the project lookup sends `ideType` `"ANTIGRAVITY"`. The
`ideType` value names the service's own client family, so by default the project lookup does say "ANTIGRAVITY";
set `ideType` and `requestType` in the config to send something else (the service may then refuse them).
The envelope `userAgent` and the HTTP `User-Agent` header are the same configured `userAgent`.

## Sign in

In Pi run `/login`, choose **Google Antigravity** and finish the Google sign-in in your browser. Pi captures the
callback on `http://localhost:<redirectPort>/oauth-callback` (loopback only). On a remote machine, open the
URL anywhere, then paste the address of the page that fails to load when Pi asks. The flow uses PKCE and a random
state. A request to the callback with a missing or different state is answered 400 and ignored: Pi keeps
waiting, so another web page or local process cannot cancel the sign-in. Only a callback with the right state
ends it, either with the code or with Google's refusal. Text from the callback is shown without control characters.

Pi stores the credential in its own auth store, owner-only, and refreshes the access token before it expires
through the provider's `refresh`. The module keeps no copy and never prints a token: error texts are scrubbed of
anything shaped like one. The refresh token never leaves Pi's store; requests receive the access token and the
project only. If Google refuses the refresh token, the next request fails with `Antigravity token refresh failed
... run /login antigravity again`. If the network is down during a refresh, the error says the token endpoint
cannot be reached and to try again; it does not call the sign-in invalid.

## Select a model

The model list is read from the service every time Pi refreshes models for your account. No model id is written
in Steak Pi. After signing in:

```
/model antigravity/<id from the list>
```

Entries the service marks disabled or internal, editor tab/chat models and image generators are left out. If a
listed model names no context or output limit, Steak Pi assumes 128000 and 8192 tokens. Models are shown as
quota-backed (no per-token cost); any cost is zero.

To use it in a Steak Pi route, put `antigravity/<id>` in your own `routing.json`, like any other provider. Nothing
selects it for you.

## What works

- Streaming text, thinking (shown when the model reports it; replayed only with the signature the service gave),
  tool calls (arguments may arrive in several pieces and are assembled), images in user messages and tool
  results (sent inline), usage (input, cached input, output, reasoning tokens) and stop reasons (stop, length,
  tool use; anything else is a named error).
- Thinking level: Pi's level is sent as a token budget (`minimal` 1024, `low` 2048, `medium` 8192, `high` 16384,
  `xhigh`/`max` 32768) unless you set your own `thinkingBudgets`.
- Cancel (Esc) ends the request, including a wait for a rate limit.
- The same wait rules as the Claude Code adapter: a first-byte limit that counts from the last sign of upload
  progress (a slow upload is not a silent model, and a stalled upload is a named failure that is not sent
  again), and a stream idle limit that states how long the silence was. Both derive from Pi's 300 s budget.

## Failures, named

| Cause | What you see |
|---|---|
| Not turned on | No provider; `/login` does not list it. |
| No OAuth client in config | `Antigravity sign-in needs an OAuth client: set "clientId" and "clientSecret" ...` |
| Token rejected (401) | `rejected the access token (HTTP 401 ...)`: the request is not resent. Pi renews the token when it nears its expiry; if the error repeats, run `/login antigravity`. |
| Access refused (403) | `refused access (HTTP 403: <message>)`: the account may need verification or lack the model. |
| Rate limit or quota (429) | Waits the time the service gives (header `Retry-After`, `retryDelay`, or "Resets in ...") if it is within `maxRateLimitWaitMs`, up to `maxRateLimitRetries` times. Otherwise: `quota reached (HTTP 429): <message>; retry in 2 h 3 min (after <time>)`. No retry time given: it says so. |
| Image to a text-only model, thinking on a model without it | `Model <id> does not accept images ...` before any request is sent. |
| Silent connection or model | `no response for N s after the request was sent`, or `stream idle for N s (B bytes received)`. |
| Stream cut | `ended the stream without a finish reason`. A reply that is not a normal end (for example a safety stop) is an error that names the reason. |

Nothing is retried quietly except the bounded rate-limit wait, and nothing falls back to another model or account on
its own. A request moves to the next configured endpoint only if the connection failed before the body had finished uploading. The only other hosts the module contacts are the ones in your config.

## Limits

- Incoming data is bounded: one stream line over 16 MiB, an error or token reply over 1 MiB and a model list over
  8 MiB end the request with a `protocol` error.
- Tool schemas are sent as JSON Schema (`parametersJsonSchema`). If a model family on the service wants the older
  `parameters` dialect, its tool calls will fail with the service's own error, which is passed on.
- One account, one credential (Pi keeps one per provider). Multiple linked accounts, search, page-reading and
  image-generation tools, credit overage and enterprise routing are not part of this module.
- No stall recovery by re-asking: a silent turn ends with the named idle error and Pi's own retry/resume applies.
- The service is not a public, documented API. A change on Google's side can break the module until it is updated.
  Using it must be allowed by your Google account and the service's terms; that is your decision, not Steak Pi's.

## Cost when unused

With no config the module reads one file path that does not exist and registers nothing: measured 0.1 ms in the
extension factory and about 15 ms more to load the extension entry than an empty one in a bare Node 22 process
(transpiling four small files; none of the provider, OAuth, transport or stream code is imported). No network, no timers, no
background work, in any state.

## Proving it with a real account

The tests use a local fake server only. See the "Not verified" list in the release notes: run
`/login`, `/model`, send a one-line prompt, one with an image, one that makes a tool call, and note any named
error.

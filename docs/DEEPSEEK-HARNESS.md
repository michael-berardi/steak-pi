# DeepSeek Harness compatibility

This is a guarded adaptation, **not full upstream DSH Minimal equivalence**.
Activation is exactly `opencode-go/deepseek-v4.1-flash`.
`deepseekHarnessMode: "off"` retains the native worker baseline; the default
`"dsh-minimal"` does not enable other model routes. No benchmark lift is claimed
without paired baseline measurements; this harness was exercised as a functional
check, not benchmarked here.

## Native workers

Only production native workers already granted `allowBash: true` on POSIX get
worker-local persistent bash. A supplied `sessionFactory` never gets this executor
substitution. The existing guarded bash factory receives a `BashOperations.exec`
implementation derived from actual pi-dsh-minimal 0.4.2 runtime; native tool name,
schema (`command`, optional timeout in seconds), wrapper, hooks and result handling
remain. Exports, functions and shell cwd survive successive bash calls. Filesystem
tools still use the fixed run cwd. Shell access remains explicitly unsandboxed;
no permission or ownership expansion is implied.

Execution is serialized, default/max timeout 120 seconds, capture capped at 20,000
characters (plus bounded framing). Completion output is delivered to native Pi;
live incremental output and upstream exact result strings are not retained.
Timeout, abort, excessive output and shell exit destroy shell state. Settlement
terminally disposes the process group and waits for actual shell exit, rejecting
unconfirmed reaping after two seconds. Windows retains native nonpersistent bash.
No global process killing is used; deliberately detached descendants are outside
this process-group containment guarantee.

Read/write ownership checks, native unique edit/diff behavior and journaling remain
authoritative. `edit` additionally accepts `command: "str_replace"`, `old_str`,
`new_str`; mixed native/alias arguments are rejected. Upstream view/create map to
native read/write, not a renamed editor. Upstream insert is omitted. Mandatory
USAP prompts are appended to, never replaced. Native compaction accounting and
`cacheWarming: "off"` are unchanged. Worker shell state is not checkpointed and
never crosses worker/model-runtime lifetimes.

## Managed primary sessions (SDK 0.86.0)

Run `bin/steak-pi-dsh` from your installed Steak package, with native Pi **0.86.0**
on PATH and Node >=22.19. Accepted arguments include `--version`, `--print`/`-p`,
`--no-session`, `--continue`/`-c`, `--resume`/`-r`, `--session`, `--session-dir`,
`--mode text|json|rpc`, `--thinking`, and prompt strings. Provider/model selectors
must resolve to `opencode-go/deepseek-v4.1-flash`; resource and tool overrides
are not admitted. This is explicit opt-in; no settings, profiles or defaults change.

Before launching Pi, the entrypoint inspects global and project settings and
extension discovery directories. It admits the fully enabled first-party Steak
package at the entrypoint's canonical path (including its matching pinned git
installation), and refuses extra packages, resource-filtered packages, unknown
extensions, shell paths/prefixes/operation hooks, startup environment hooks and
configuration-changing CLI flags. It fails with an actionable message rather than
silently excluding your guards. For a refused setup, use ordinary Pi unchanged,
or review that configuration yourself; do not simply disable guards to proceed.
Other installation source formats must be explicitly repointed to the canonical
local Steak package before using this entrypoint.

The launcher passes `--no-extensions`, the complete approved first-party extension
files, an explicit managed flag, and the exact Go DeepSeek route, with `--thinking
high` as the default reasoning level; an explicit admitted `--thinking` value you
pass is forwarded after that default. AGENTS/CLAUDE,
skills, prompts, project trust, model-route policy and verification are retained;
Steak skills are explicitly included even without a package settings entry. Native
project trust prompts remain authoritative. Arbitrary extension compatibility is
**not** claimed. Configuration must remain unchanged during a managed run.

Under admission, native-name `bash` uses SDK createBashToolDefinition with native
BashOperations dispatch: approvals still observe `bash`, and native read/edit/write
are untouched. No editor alias is nested-executed. Bash state persists only in the
primary session; timeout (default/max 120 seconds), abort, excessive output and
shell exit reset it. Native PI_* session metadata and shell PATH augmentation are
forwarded. Missing completion status is an error, never success. Model/session
transitions and shutdown await bounded positive shell reaping (two-second failure
bound); an unconfirmed cleanup poisons subsequent shell execution. Non-target
models use the original native nonpersistent bash behavior; returning to DeepSeek
starts fresh. Detached descendants are outside process-group containment.

Ordinary Pi loading the extension without managed admission retains native shells
and accurate nonpersistent guidance. Both modes append guidance rather than
replace mandatory instructions. Native structured tool calls alone execute;
DSML assistant-text execution is never enabled. See vendor adaptation notice.

Offline checks: `npx vitest run test/deepseek-primary.test.ts` and
`test/deepseek-packaged-launcher.test.ts`. Installed-package smoke exercised the
launcher from an extracted archive with Pi 0.86.0 on PATH; that is a functional
check, not a performance claim. Node 22 prints an `ExperimentalWarning` for the
temporary TypeScript stripping API the launcher uses; the hook is deregistered
before native Pi starts and no TypeScript loading is enabled for directories or
packages.

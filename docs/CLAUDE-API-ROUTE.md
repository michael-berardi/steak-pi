# Explicit Claude API route (`claude-code-api/<model>`)

USAP has two Claude route families that never resolve to each other.

| Route | Auth | Reachable by |
| --- | --- | --- |
| `claude-code/claude-sonnet-5-5`, `claude-code/claude-opus-5-5` | Existing claude.ai subscription login. API keys, base URLs and billing overrides are stripped from the child environment. | Defaults, the Opus review default and explicit selection. |
| `claude-code-api/claude-sonnet-5-5`, `claude-code-api/claude-opus-5-5` | An API key behind the approved `apiKeyHelper`, read by the official CLI in `--bare` mode (OAuth and keychain are never read). | An exact explicit model name, plus a current operator approval record. Never a default, chain step or fallback. |

The subscription route and its checks (`assertClaudeSubscriptionStatus`, `claudeWorkerEnv`, `claudeWorkerArgs`) are unchanged. An API failure never falls back to the subscription, Sol or any other route, and a subscription failure never moves to the API.

## Interactive versus headless promotional credits

Max and Team monthly API credits are Claude Platform credits. Anthropic's help article, retrieved 2026-10-13 from <https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans>, says:

- They cover the Claude API (Messages and Batches), the Console Playground, Claude Managed Agents and the Claude Agent SDK.
- They do not cover interactive Claude Code in the terminal, IDE, desktop or web, or extra usage.
- They cover `claude -p` and the Agent SDK when you run them yourself with an API key from the linked Console organization, because that usage is billed as Agent SDK usage. Runs started by the Claude Code GitHub Action, an IDE extension or the Claude desktop app count as Claude Code usage and are not covered, even with `-p`.
- Credits do not roll over. When they run out, requests stop unless the organization has purchased credits or auto-reload, which then bill normally.

So an interactive session launched with the same key and workspace fails with "Credit balance is too low" while a headless `claude -p` run succeeds. This is a product restriction, not a wrong key; do not work around it with header or client spoofing. UltraTerm therefore never offers promotional-credit interactive sessions: the OverSeer fallback does not route jobs to the interactive `claude-api` harness, and dispatching that harness fails with a named error. Headless API work goes through this route.

USAP does not read credit balances, expiry dates or reset dates. The Console is the only source for them.

## Operator approval record

The route is admitted only while a private JSON record approves it. Default path `~/.config/ultraterm/usap-claude-api.json`, or the absolute path in `USAP_CLAUDE_API_CONFIG`. The record is task-scoped: it names the task, expires within 31 days, and changes no global default. USAP never writes it and never writes `~/.pi/agent/paid-routes.json`.

```json
{
  "version": 1,
  "approval": {
    "approvedBy": "operator",
    "source": "brief or message that granted the approval",
    "task": "short task name",
    "approvedAt": "2026-10-13T00:00:00Z",
    "expiresAt": "2026-10-20T00:00:00Z"
  },
  "routes": ["claude-code-api/claude-sonnet-5-5"],
  "settingsPath": "/absolute/path/to/approved-settings.json",
  "budget": { "maxLeafUsd": 1, "maxRunUsd": 2 }
}
```

Checks, re-run at dispatch and again at every CLI launch (including automatic and explicit resumes), each failing with a named `ClaudeApiAdmissionError[code]` that never echoes a value:

- The record and the settings file are regular, non-symlink, owned by the current user, mode 600, and small, in directories nobody else can write; unknown keys are errors.
- The record is not expired or future-dated, lasts at most 31 days, and lists the exact route requested.
- The settings file holds only `apiKeyHelper` and `env.ANTHROPIC_CUSTOM_HEADERS`. `apiKeyHelper` is an absolute path (no arguments) to a regular, non-symlink, user-owned, executable file, in a directory that nobody else can write. The header is exactly one `anthropic-workspace-id: wrkspc_…` header. Base URLs, keys, tokens, provider switches, hooks and permissions are rejected.
- Budget: `maxLeafUsd` ≤ 10, `maxRunUsd` ≤ 25, leaf ≤ run. Each leaf's CLI session gets `--max-budget-usd = min(maxLeafUsd, maxRunUsd ÷ tasks)` minus spend already booked against that leaf, so a wave cannot exceed the run ceiling. A resume keeps the original per-leaf ceiling and the spend already booked. A leaf with under $0.05 left is refused.
- API waves run at most 3 wide.
- Image review is not enabled on this route.

Missing record: the dispatch fails with `approval-missing`, names the path and `USAP_CLAUDE_API_CONFIG`, and selects nothing else.

## What the launch does

The worker is the unmodified official CLI under the SAME coordinator, checkpoint, cancellation, resume and owned-path machinery as the subscription route. The API argv is the subscription argv behind `--bare`, with `--settings <approved file>` (a path, never inline JSON) and `--max-budget-usd`. Nothing credential-bearing enters the environment, argv, prompt or logs; USAP never runs the helper or reads its output.

Before launch the CLI itself must report `claude auth status --json` as `loggedIn`, `authMethod: api_key_helper`, `apiProvider: firstParty`, `apiKeySource: apiKeyHelper`. During the run the stream's init frame must report `apiKeySource: apiKeyHelper` and every worker frame must carry the pinned model, otherwise the leaf fails.

## Receipt

Each leaf records a sanitized `apiReceipt` (route, pinned and served model, the CLI-reported auth method, which attestations were observed, CLI version, 12-hex digests of the approval record and settings file, budget caps, spend reported by the CLI, session id). It proves the CLI reported API-key-helper authentication and served the pinned model for this leaf. It does not prove a balance, a billing outcome or which Console organization was charged.

## Running API waves

A running parent keeps the tool schema it loaded at start. New sessions accept `model: "claude-code-api/claude-sonnet-5-5"` in `ultraterm_subagents`. To run API waves from a parent that cannot restart, use the standalone entry point, which drives the same coordinator in a separate process (installed copies expose it as `steak-pi usap-api <admit|dispatch|resume>`):

```bash
node scripts/usap-claude-api.ts admit --tasks 2
node scripts/usap-claude-api.ts dispatch wave.json --checkpoint-root ~/.cache/agent-scratch/<task>/usap --out result.json
node scripts/usap-claude-api.ts resume <run-id> --checkpoint-root ~/.cache/agent-scratch/<task>/usap
```

`wave.json` is `{ "goal", "route", "cwd", "constraints", "contract", "tasks": [{ "label", "task", "role", "mayEdit", "ownedPaths", "allowBash" }], "concurrency", "timeoutMs", "maxTurns" }`; unknown keys are errors. SIGINT or SIGTERM cancels the run and only that run's child process. Exit codes: 0 done, 1 failed or partial, 2 admission or usage error, 130 cancelled.

Observed in the phase A smoke (run `run-a98c77f0-6294-40da-933c-7089e7f82544`, CLI 2.1.296): `--bare` offered a read-only leaf only `Read`; `Grep` and `Glob` were not provided although `--tools` names them, so the API-route prompt says so. Edit and shell tool availability under `--bare` has not been verified yet. Owned-path edit rules, the read-only reviewer's shell denial and the one bounded resume use the subscription route's code, so their arguments are identical.

Spend limits: the CLI reports cost only in a session's final result. A session that is cancelled or cut before it reports leaves its spend unknown to USAP, so a resume or automatic resume gets the leaf's remaining ceiling computed from the spend that was reported, and each launch still carries its own `--max-budget-usd`. Monthly credit balance and expiry are not tracked by USAP.

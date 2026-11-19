# Antigravity CLI (`agy`) route

Steak Pi can run Google's Gemini models through Google's **official** Antigravity CLI, `agy`, the way Google documents it for scripting ([headless mode](https://antigravity.google/docs/cli/headless)). Steak Pi never talks to Google's service itself and never reads agy's credentials: it starts `agy` as a child process and reads its `stream-json` output.

This replaces the earlier direct Antigravity OAuth provider, which was removed: Google's terms say "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts." If `~/.config/ultraterm/antigravity.json` still says `"enabled": true`, Steak Pi shows one notice at session start saying so. The file is not touched; delete it.

## Set up

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash   # install agy
agy                                                            # run it once and sign in
```

Then, in Pi or Steak DSH, pick a model under the **Google Antigravity CLI (agy)** provider. `/agy-status` reports whether agy is installed and signed in.

## Models

The model list is exactly what `agy models` prints for your account; your plan decides it, and no model id is built into Steak Pi. The list is cached for 60 seconds. The provider is hidden while agy is missing or signed out. Pi is given an assumed context window of 200,000 tokens and 64,000 output tokens because agy does not report them; agy manages its own context.

## What a turn does

```
agy --input-format stream-json --output-format stream-json --model <id> --disable-slash-commands [--effort <level>] [--mode <mode>] [--conversation <id>] --add-dir <cwd>
```

The prompt is not on the command line: Steak Pi writes it to agy's stdin as one `{"event":"user","message":{"content":"..."}}` line and closes stdin ([stream prompts from stdin](https://antigravity.google/docs/cli/headless)), so it does not show in `ps`, cannot exceed the argument-size limit and cannot be read as a flag.

It runs in the session's working directory. Text arrives as it streams. Each tool step agy runs is shown as a read-only progress line in the answer (for example `› agy run_command: npm test`); these are display only, are not Pi tool calls, and are left out when the conversation is replayed.

### Tool calls run inside agy, not Pi

agy runs its own tools under agy's permission rules, outside Pi's approvals. Steak Pi never passes --dangerously-skip-permissions, so agy's default permissions apply: per Google's docs, actions that need approval are not approved in headless mode (the run continues without them); allow tools ahead of time with permissions.allow in ~/.gemini/antigravity-cli/settings.json.

What Google documents ([agy permissions](https://antigravity.google/docs/cli/permissions)): the presets are Request Review, Default (the default), Auto and Turbo. Under Default, terminal commands run in a sandbox limited to the workspace and temp directories with no network, and a command that needs to run outside it asks for approval unless a `command(...)` allow rule covers it; file access outside the workspace and web and MCP actions ask.

This is Google's documented behaviour, not something Steak Pi has verified: it was tested only against a fake agy and a signed-out agy, never a signed-in one. `STEAK_PI_AGY_MODE=auto` passes `--mode auto`, which lets agy approve actions automatically; `accept-edits` and `plan` are the other values.

### Thinking level

Pi's thinking level maps to `--effort`: off, minimal and low become `low`; medium, high, xhigh and max pass through. When Pi sends no level, no `--effort` is passed and the model's own effort applies.

### Conversation memory

One process per turn: stdin carries a single prompt and is then closed, so agy ends after that turn (Steak Pi does not keep a warm multi-turn session). Cancelling is killing one process group, and a branch, an edit or a compaction in Pi can never desynchronise a long-lived child.

- When Pi's history ends exactly where agy's last conversation ended (same model, same session), the turn sends every message you wrote since agy's last reply with `--conversation <id>`, so agy remembers the files it read and the commands it ran.
- Otherwise (first turn, a branch or edited history, a Pi restart, a model switch) a **new** agy conversation starts and gets your last message plus a compact text transcript of earlier turns (capped at 100,000 bytes, oldest turns dropped first). agy's own tool history from before is not carried over.

## Cancel, timeout and errors

Pi's abort sends SIGINT to agy's process group (agy records INTERRUPTED), then SIGTERM after 3 s, then SIGKILL after 2 s more; agy's whole process group is then killed with SIGKILL whenever agy exits (also after a normal finish), so tools it started cannot outlive it, and a grandchild holding agy's output open cannot hang the turn (the pipes are closed). If Pi gets SIGHUP or SIGTERM, or exits, the live agy groups are killed too; a tool that deliberately starts its own session or process group is outside agy's group and is not reached. A turn stops after 30 minutes (`STEAK_PI_AGY_TIMEOUT_MS` changes it). Errors name their cause; nothing falls back silently:

| Cause | What you see |
| --- | --- |
| agy missing | `agy ... was not found ... Install it with: curl -fsSL https://antigravity.google/cli/install.sh \| bash` |
| not signed in | `agy is not signed in (agy said: ...); run agy once to sign in.` |
| plan lacks the model | `agy does not offer the model "<id>" on this account's plan ... Run agy models` |
| timeout / cancelled / interrupted / waiting | named, with agy's status |

A signed-out agy waits a minute for a browser sign-in; Steak Pi stops it 1.5 s after agy says "Authentication required" and names the cause, so the turn fails in a few seconds. The provider is normally hidden in that state.

## Settings

| Variable | Meaning |
| --- | --- |
| `STEAK_PI_AGY_BIN` | Path of the `agy` binary (default `agy` on PATH). Tests point it at a fake. |
| `STEAK_PI_AGY_MODE` | `accept-edits`, `auto` or `plan`; default: agy's own default. |
| `STEAK_PI_AGY_TIMEOUT_MS` | Longest turn; default 1,800,000. |

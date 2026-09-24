<div align="center">

# 📋 UltraTerm Plan

### The plan the agent keeps, and you can read.

**Phases in order. One active task. Blocked means blocked. One store, every
agent. No orchestration theatre.**

*Phased todo tracking that survives compaction, resume, and a change of agent —
local files, no network, no status meetings.*

[Install](#install) · [30-second demo](#a-30-second-demo) · [Per-agent setup](#per-agent-setup) · [File format](#file-format-and-where-it-lives) · [FAQ](#faq)

</div>

---

UltraTerm Plan is the task tracker for agents that work for a living: a phased
list the model is required to maintain — one active task, recorded starts and
finishes, blocked items with reasons — stored as plain JSON and Markdown in
your project. It was extracted, unchanged, from [Steak
Pi](https://github.com/michael-berardi/steak-pi)'s todo feature, and Steak Pi
keeps running this exact code: the package lives in Steak Pi's monorepo and
this repository is its published mirror. Same store, same rules, whether the worker is a
Pi session or anything else that can run a shell command.

Nothing is marked automatically. Tool activity never advances the list by
itself; the agent has to record what it did. That is the feature.

## A 30-second demo

Real output, captured from `ut-todo` in a scratch directory:

```console
$ ut-todo init 'Inspect:read code,map callers' 'Build:edit,test'
1. Inspect (0/2)
   [>] read code
   [ ] map callers
2. Build (0/2)
   [ ] edit
   [ ] test
Overall: 0/4 done.

$ ut-todo done 'read'                # unique prefix; no tab-completion theatrics
1. Inspect (1/2)
   [x] read code
   [>] map callers
2. Build (0/2)
   [ ] edit
   [ ] test
Overall: 1/4 done.

$ ut-todo block test --reason 'flaky upstream'
1. Inspect (1/2)
   [x] read code
   [>] map callers
2. Build (0/2)
   [ ] edit
   [!] test — flaky upstream
Overall: 1/4 done.

$ ut-todo json '{"op":"done","items":["map callers","edit"]}'
1. Inspect (2/2)
   [x] read code
   [x] map callers
2. Build (1/2)
   [x] edit
   [!] test — flaky upstream
Overall: 3/4 done.
```

`view` prints that checklist, plain text, every time — so the agent can paste
it into its reasoning, and you can read it over its shoulder. In Steak Pi the
same plan is also pinned natively above the composer.

## Install

From source (no dependencies, no build step):

```sh
git clone https://github.com/michael-berardi/ultraterm-plan
alias ut-todo='node /path/to/ultraterm-plan/bin/ut-todo'
ut-todo --help
```

The package is not on npm yet. Once it is, the usual forms will work:

```sh
npm install -g ultraterm-plan      # then: ut-todo view
npx ultraterm-plan                 # same CLI, no install
```

Requires Node.js ≥ 22.19 (it runs TypeScript sources directly with Node's
built-in type stripping). No dependencies, no build step, no network.

## Per-agent setup

Honesty policy: supported integrations are listed because the code ships in
this package. Everything else is served by the CLI, which any agent that can
run a shell command can use.

**Pi / Steak Pi — native tool (the original).** Steak Pi registers the `todo`
tool natively, with the plan pinned above the composer and maintenance guidance
injected while work is unfinished. Nothing to configure; Steak Pi's wrapper
imports this package's sources directly.

**Claude Code — plugin.** Point Claude Code at
`integrations/claude-code/` (for example `claude --plugin-dir
/path/to/ultraterm-plan/integrations/claude-code`): a plugin with a `ut-todo`
skill (when to plan, how to record honestly), a plugin manifest, and a bin link
to the CLI. Inside UltraTerm, sessions also get the live owner binding — the
same per-session store the UltraTerm adapter uses.

**Codex, Gemini CLI, OpenCode, Cursor, and any AGENTS.md reader.** Copy the
snippet from [`integrations/agents-md.md`](./integrations/agents-md.md) into
your `AGENTS.md` and put `ut-todo` on PATH. The snippet is the whole
integration; the CLI does the rest.

**Anything else with a shell.** `ut-todo init …`, `ut-todo done …`,
`ut-todo view`. If it can type, it can keep a plan.

## Rules the agent follows

- **Plan first.** `init` takes phases in execution order. Re-running `init`
  with the identical list is idempotent — recorded progress, including finished
  counts, survives. A *different* list replaces the plan and resets progress.
- **One active task.** The earliest pending item auto-promotes; `start`
  overrides deliberately. A single `start` activates exactly one task; a bulk
  `start` keeps every named task active.
- **Record state changes as they happen.** `start` before beginning, `done`
  only after verifying the result yourself, `block --reason` when stuck.
  Edits, tool calls, and passing tests mark nothing by themselves.
- **Atomic bulk transitions.** `done a b` applies all or nothing; a rejected
  batch leaves the list untouched. Tasks and phases are never confused — a task
  named like a phase is the task.
- **Reconcile before finishing.** One final `view`, and unfinished or blocked
  items get reported as unfinished or blocked.
- **One update per real state change.** No re-viewing, no re-marking, no
  ceremony.

## File format and where it lives

Per project directory:

```
<cwd>/.steak-pi/todo/<sha256(JSON.stringify([sessionFile, sessionId]))>/
├── todo.json   # the state: phases → items → {content, status, reason?}
└── TODO.md     # the same checklist, human-readable, written first
```

Statuses: `pending`, `in_progress`, `done`, `blocked`. The hash pins ownership:
each Steak Pi or Claude Code session gets its own list (survives compaction and
resume; `/clear` starts a fresh one). The CLI resolves the same way — explicit
`--session NAME` or `UT_TODO_SESSION` first, Claude Code's session when
detectable, otherwise a stable per-cwd default. Same directory, same format as
Steak Pi, so agents and humans read one store.

## Privacy

Local files under your project, read and written by your machine. No network
calls, no telemetry, no accounts, no sync. If you want your plan exfiltrated,
you will have to do it yourself.

## FAQ

**Why phases instead of a flat checklist?**
Because "which of these forty checkboxes matters now" is a question you want
answered by the list, not negotiated with the model every morning. Phases run
in order; one item is active; the rest wait their turn.

**The agent claimed it was done but the list says otherwise. Who wins?**
The list. That is the point.

**Does it integrate with Jira?**
No. It integrates with a shell, which Jira unfortunately also requires.

**What happens to my plan when the context window is compacted?**
Nothing. The plan never lived in the context window; it lived in
`.steak-pi/todo/`. That is the "survives compaction and resume" promise, and it
is the entire reason the store exists.

**Why `.steak-pi`?**
Because it started life as Steak Pi's todo feature and renaming the directory
would orphan every existing plan. Names are load-bearing.

## License

[MIT](./LICENSE) — © 2026 Implose Cybernetics. Extracted from
[Steak Pi](https://github.com/michael-berardi/steak-pi) and maintained in its
monorepo; this repository mirrors that package, so the two never drift apart.

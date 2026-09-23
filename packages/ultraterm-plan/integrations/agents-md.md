# AGENTS.md snippet — UltraTerm Plan (`ut-todo`)

Copy this section into your project's `AGENTS.md` (Codex, Gemini CLI, OpenCode,
Cursor, and any other agent that reads `AGENTS.md`). It assumes `ut-todo` is on
PATH (`npm install -g ultraterm-plan` once published, or an alias to
`node <path-to-package>/bin/ut-todo` today — see the package README).

```markdown
## Task tracking (ut-todo)

Keep an explicit phased plan for multi-step work with `ut-todo`; it stores the
plan under `.steak-pi/todo/` in this project and shares it with Steak Pi agents.

- Plan first, phases in execution order:
  `ut-todo init 'Inspect:read code,map callers' 'Build:edit,test'`
  Re-running init with the identical list keeps recorded progress.
- One active task at a time. Record `start TASK` before you begin; record
  `done TASK` only after you verified the result yourself. Tool activity never
  marks an item by itself.
- Blocked items get a reason: `ut-todo block TASK --reason 'why'`. Never move
  to a later phase with an earlier item unfinished or unrecorded.
- Bulk transitions are atomic: `ut-todo done a b` applies all or nothing.
  `ut-todo json '{"op":…}'` accepts any native op verbatim.
- Before your final response, run `ut-todo view` once and reconcile every item;
  report unfinished or blocked items as unfinished or blocked.
- One update per real state change; do not re-view or re-mark the same step.
```

That is the entire integration: the agent needs a shell and this file. The plan
is local files only — nothing is sent anywhere.

---
name: todo
description: Use when the operator asks for explicit task tracking, or when a todo plan is already active in this session. Record verified starts, completions, and blockers in the native `todo` tool instead of narrating progress.
---

# Todo maintenance

The `todo` tool is the only checklist. When a plan is active, keep it true
while you work — the pinned panel and the tool result must never disagree.

## Contract

- One update per real state change. Never re-mark or re-view the same step.
- `op:"start"` an item before you work on it.
- `op:"done"` only after you verified the result yourself. Tool activity, file
  edits, and passing tests never mark an item by themselves.
- `op:"block"` with a reason when you cannot proceed; `op:"unblock"` before
  retrying.
- Do not move to a later phase while an earlier item is unfinished.
- Before your final response, `op:"view"` once and reconcile every item.
  Report unfinished or blocked items as such; never imply success.

## Operations

`init` (full phased plan), `start`, `done`, `drop`, `rm`, `block`, `unblock`,
`append`, `view`.

- `init` with an identical list (same phases and items, same order) keeps the
  recorded progress; a different list replaces the plan.
- Single ops take `task` (content or unique prefix) or `phase`.
- Bulk `start|done|drop|block|unblock|rm` take `items` (ordered, atomic) with no
  `task` or `phase`. If any target is unknown or ambiguous, the whole batch
  fails and nothing is written.
- Failures name the miss and the known task labels; use one of those labels.

## State

The plan is private to one native session (`<cwd>/.steak-pi/todo/<namespace>/`
with `todo.json` and `TODO.md`), restored on resume and never shared with or
borrowed from another session.

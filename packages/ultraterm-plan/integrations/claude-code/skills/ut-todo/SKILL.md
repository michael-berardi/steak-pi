---
name: ut-todo
description: Durable phased task tracking for this project with the ut-todo CLI. Use for any work with more than a couple of steps, whenever the operator asks for a plan or task tracking, and across resume/compaction — load before planning multi-step work or when recording progress.
---

# ut-todo — keep the plan, honestly

`ut-todo` is a plain CLI. Run it with the shell like any other command; the
plan lives in this project under `.steak-pi/todo/` and is shared with Steak Pi
agents working in the same directory.

## Rules

1. **Plan first.** For multi-step work, record phases in execution order:
   `ut-todo init 'Inspect:read code,map callers' 'Build:edit,test'`
   Re-running init with the identical list is safe — recorded progress is kept.
2. **One active task.** The first pending item auto-activates; `start TASK`
   moves the spotlight deliberately. Finish or block before advancing phases.
3. **Record state changes as they happen.** `start` before you begin,
   `done TASK` only after you verified the result yourself. Edits and passing
   tests never mark an item by themselves.
4. **Blocked means blocked.** `ut-todo block TASK --reason 'why'` — a plan
   with an unexplained `[!]` is a lie with formatting.
5. **Bulk transitions are atomic.** `ut-todo done taskA taskB` applies all or
   nothing. `ut-todo json '{"op":…}'` accepts any native tool op verbatim.
6. **Reconcile before you finish.** Run `ut-todo view` once at the end and
   report unfinished or blocked items as unfinished or blocked. No theatre.

## Handy forms

```
ut-todo init 'Phase:item,item' 'Phase:item'      # (re)write the whole plan
ut-todo start|done|drop|block|unblock|rm TASK [--reason TEXT]
ut-todo append PHASE TASK [TASK ...]
ut-todo view                                     # the checklist, plain text
ut-todo json '{"op":"start","items":["a","b"]}'  # any native op, verbatim
```

`--session NAME` keeps a separate list for a named session. The store is local
files only; nothing ever leaves the machine.

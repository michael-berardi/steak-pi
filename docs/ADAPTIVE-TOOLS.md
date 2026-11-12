# Adaptive tool loadout

Steak Pi is one package with no mode to choose. The starting tools depend on how the session is used; the work decides
when the heavier tools arrive. Code: `src/adaptive-tools.ts`, `extensions/adaptive-tools.ts`.

| Session | First request | Growth |
| --- | --- | --- |
| terminal UI, `--mode rpc` | every tool, as in 0.28.5 | none needed |
| `pi -p`, `--mode json` | read, bash, edit, write and `load_tools`; no dispatch, hub or todo tool or guidance; short-reasoning line | once, on a trigger below |
| any, with `--tools`, `--no-tools`, `--exclude-tools` or `STEAK_PI_DEFER_TOOLS=off` | what you chose / every tool | none |

Triggers (any one loads `ultraterm_subagents` and `todo`, once, for the rest of the session):

1. The prompt asks for delegation, parallel work or task tracking (`promptAsksForHeavyTools`). Loaded before the first
   request, so the guidance is in the system prompt.
2. The run reaches its 10th tool call (`CALL_THRESHOLD`; short tasks take 4 to 7 calls, long ones 10 to 40).
3. The model calls `load_tools`.
4. At start the session holds a todo plan or checkpointed dispatch runs.

Pi builds the system prompt of a run once, before it starts. A tool activated mid-run reaches the next request as a
schema, but its guidelines do not (checked with the scripted model, `benchmarks/overhead/adaptive.py`), so triggers 2 and
3 return the guidelines in the tool result that carried the change. The hub still appears after the first dispatch.
`steak-pi run --lean` stays accepted: it excludes the three tools, so nothing can load them.

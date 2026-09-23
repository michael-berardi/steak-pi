# Changelog

All notable changes to UltraTerm Plan are documented here. The format is a
plain list; there is no drama and no ceremony.

## 0.1.0 — unreleased

Initial packaged release. Extracted unchanged from Steak Pi's todo feature so
the monorepo and a future standalone repository run one implementation:

- `src/core.ts` — the pure phased task state machine (moved from Steak Pi's
  `src/todo-core.ts`): ordered phases, single active task with auto-promotion,
  atomic bulk transitions, idempotent re-init that preserves recorded progress,
  honest blocked states. No imports, no I/O.
- `src/render.ts` — the native Pi pinned-panel renderer (moved from Steak Pi's
  `src/todo-render.ts`).
- `pi/extension.ts` — the Pi tool, persistence, maintenance guidance and pinned
  panel (moved from Steak Pi's `extensions/todo.ts`), with Steak Pi's own
  pinned-panel compositor and session-file canonicalizer injected as deps.
- `bin/ut-todo` — a shell CLI for any agent: `init/start/done/drop/block/
  unblock/rm/append/view/json`, byte-identical output to the Pi tool, same
  `.steak-pi/todo/<hash>` store.
- `integrations/` — a minimal Claude Code plugin (plugin.json, skill, bin
  link) and a copy-paste `AGENTS.md` snippet for Codex, Gemini CLI, OpenCode,
  Cursor and any other AGENTS.md-reading agent.

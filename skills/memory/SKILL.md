---
name: memory
description: Project memory conventions — record durable decisions in AGENTS.md and re-read them at session start so work compounds instead of repeating.
---

# Project Memory

You have a working memory problem: sessions end, context resets. Your
project's `AGENTS.md` is the durable memory. Use it deliberately.

## When to write memory

Write to `AGENTS.md` (or a project notes file it links to) when you:

- make a decision that shapes later work (architecture, naming, a chosen
  dependency, a rejected alternative and why);
- learn a fact that cost effort to discover (a command flag, a quirk, an
  endpoint, a test that must run before others);
- get corrected by the operator — record the correction so it never
  repeats.

## What NOT to write

- Anything secret: keys, tokens, passwords, connection strings.
- Session narration ("then I ran the tests") — only durable conclusions.
- Speculation. If it is not confirmed, do not persist it.

## How

- Keep entries short, imperative, and dated when it matters:
  `- 2026-09-03: deploys go through build_queue.py; never raw npm run build.`
- One bullet per fact. Group under short headings.
- At session start on a familiar project, re-read AGENTS.md before
  planning. Treat it as ground truth over your own assumptions.

## Cross-session recall (opt-in)

If the operator installed a recall extension, prefer quoting saved
messages over re-deriving context. Recall is opt-in: never assume it is
present, and never write project memory into a recall store — recall is
for reusable fragments, AGENTS.md is for project truth.

# Skill Catalog Lite

Two-tier skill discovery for Steak Pi: a compact name/path/trigger index in the system prompt, followed by a plain `read` of the relevant SKILL.md for full instructions. Works with Pi's injected XML catalog for any skill library; no skill names, directories, or descriptions are hardcoded. No model calls, skill-file reads, core patches, or session messages.

The default export in `index.ts` registers `before_agent_start` and returns the rewritten `systemPrompt`, preserving previous extensions' changes and surrounding instructions. The package explicitly registers `./extensions/skill-catalog-lite/index.ts` alongside `./extensions`. Verified against installed Pi 0.85.1 `dist/core/package-manager.js` (`collectAutoExtensionEntries`) and `dist/core/extensions/loader.js`: directory discovery includes immediate subdirectory `index.ts`/`index.js` entrypoints, and resolved paths are deduplicated (resource maps and loader `seen` set). Thus the explicit entry is redundant but harmless and makes registration visible. Alternatively load with `pi -e ./extensions/skill-catalog-lite/index.ts`.

## Controls (environment)

- `STEAK_PI_SKILL_CATALOG_LITE=off` (also `0`, `false`, `no`): disable; stock prompt unchanged.
- `STEAK_PI_SKILL_CATALOG_BYTES=8192`: positive integer UTF-8 section budget, including tags and tier-2 guidance.
- `STEAK_PI_SKILL_CATALOG_WORDS=15`: positive trigger-word limit, capped at 15.

Invalid values use defaults. Full-fidelity sections already within budget remain byte-for-byte untouched. Larger sections use the first description sentence, remove introductory boilerplate and marketing filler, and retain up to 15 words. Longest triggers are shortened one word at a time until the section fits; no skill or location is dropped. Unknown XML shapes fail closed; existing compact indexes are idempotent.

**Identity floor:** No finite budget can contain arbitrarily many mandatory names and paths. If the budget is smaller than the all-identities/no-triggers index, all identities win over the cap; the pure API reports `overflowBytes`. Raise the budget for unusually large libraries or long paths. The extension never inflates the original section. Trigger extraction is deliberately deterministic, not semantic: keywords beyond the first sentence/15-word window may be omitted, so names and full skill reads remain essential. Disabling restores stock behavior on the next freshly constructed host prompt; rewriting is not a reversible storage format.

## Focused checks

From repository root (Node >=22.19):

```sh
node --experimental-strip-types --test extensions/skill-catalog-lite/catalog.test.ts
```

Tests cover keyword retention, word limits, byte budgeting including non-ASCII, escaping, no-op cases, malformed input, disable/configuration, impossible budgets, idempotency, and a deterministic realistic-format 77-skill fixture with measured >=60% reduction. The fixture is synthetic, not a claim to reproduce a specific installed library. This directory-local Node test deliberately requires no test-runner dependency; the repository Vitest include currently only selects `test/**/*.test.ts`, so run it explicitly in addition to integrated checks.

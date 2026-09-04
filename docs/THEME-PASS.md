# Steak Pi × UltraTerm Theme-Neutral Legibility Pass

Steak Pi no longer mirrors UltraTerm's theme corpus or chooses a matching
agent theme. The companion header, footer, and activity indicator consume only
semantic colors from whichever Pi theme is already active. This keeps one TUI
implementation compatible with every UltraTerm pane surface.

## Automated gate

The renderer is exercised at 20, 24, 32, 40, 80, 120, and 192 columns with:

- a plain palette;
- deterministic ANSI colors;
- a semantic-token spy palette.

Tests reject width overflow, control-character injection, split graphemes,
hard-coded colors, and non-deterministic state/resize behavior. The pinned Pi
0.85 smoke also loads every optional Steak theme, boots under stock dark and
light, and validates captured ANSI at 40, 80, and 120 columns.

```sh
npm test
npm run typecheck
npm run test:tui
npm run ui:simulate -- --scenario complete --width 80 --height 24
```

## Live UltraTerm gate

UltraTerm is desktop-only. Final live captures are inspected separately at
375px and 1920px host widths. Use stock Pi `dark` and `light` as opposite
contrast probes; then spot-check UltraTerm's OLED, White, and one chromatic
host theme without changing Steak Pi code.

For each capture verify:

- header, transcript, editor, and footer are visually distinct;
- status, model, context, and location remain legible;
- no background slab fights UltraTerm's pane surface;
- no accent-on-accent collision hides tool or error state;
- long paths/models truncate without wrapping the footer;
- streaming and tool activity do not cause layout jump;
- resize redraws cleanly with no broken ANSI or glyph residue.

The optional `steak`, `steak-oled`, and `steak-light` themes remain available
for users who want them, but none is required for this pass.

## Verification record

Verified on 2026-09-04 against Pi 0.85 and UltraTerm 1.5.3:

- inspected deterministic dark/light xterm captures at 375×813 and 1920×1080;
- exercised the native extension in isolated dark/light Pi smoke sessions at
  40, 80, and 120 columns;
- attached a dedicated live Pi process to UltraTerm slot 5 at 86×31 without
  targeting any existing pane;
- inspected startup, prompt, thinking, responding, read-tool, complete, and
  usage/cache footer states in the live pane;
- verified local-shell input, Up/Down history, and composed, combining, wide,
  and ZWJ glyph output;
- confirmed all pre-existing UltraTerm pane PIDs were unchanged after the live
  pass.

# Cherry Pi × UltraTerm Theme Legibility Pass

The cherry TUI theme colors the agent inside terminal panes; UltraTerm
themes color the app chrome around them. This pass proves the combination
stays legible everywhere. UltraTerm is desktop-only: all captures at
1920×1080, each inspected individually.

## Method

1. Launch the installed UltraTerm app.
2. Open one Cherry Pi terminal (`pi` TUI, idle at prompt).
3. Switch the UltraTerm theme (Settings → theme).
4. Capture the full window; verify the Cherry Pi pane block.

## Theme matrix

| # | UltraTerm theme | Cherry pane legible? | Contrast OK? | Notes |
|---|-----------------|----------------------|--------------|-------|
| 1 | oled | | | |
| 2 | white | | | |
| 3 | obsidian-rite | | | |
| 4 | nord-frost | | | |
| 5 | crystal | | | |
| 6 | vapor | | | |
| 7 | frutiger-aero | | | |
| 8 | frutiger-dark | | | |
| 9 | oel-drive | | | |

## Acceptance per theme

- Prompt, output text, and diff colors readable at default size.
- No cherry-red-on-red, no stem-green-on-green collisions.
- Tool result blocks (success/error backgrounds) distinct from plain output.
- Syntax highlighting readable against the pane background.

Failures → adjust the cherry theme token (never the UltraTerm theme), then
re-capture the failing cell.

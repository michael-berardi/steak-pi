# Steak Pi Companion UI

## Design contract

Steak Pi is a native Pi companion for UltraTerm, not a replacement TUI. It
owns three bounded surfaces exposed by Pi's extension API:

1. a single-line, responsive identity and command header;
2. Steak Pi's status band and prompt gutter around Pi's native editor,
   including live lifecycle state and context pressure;
3. a conditional extension-status row only when another extension publishes one.

The composer extends Pi's `CustomEditor`; Pi still owns text editing, IME,
autocomplete, history, mouse positioning, paste handling, submission, and all
application keybindings. Pi also continues to own the transcript, Markdown,
tool cards, selectors, scrolling, compaction notices, and session restore. This
preserves upstream behavior while giving Steak Pi a purpose-built entry surface.

## Visual hierarchy

```text
◆ STEAK PI                              / commands · /model · /resume

[Pi's native transcript and tool rendering]

◆ > glm5.3-flash · high > responding ▶━━━━────────◀ ◫ 18%/131k · $0.018
╰─ Ask anything, edit files, run tools
[extension status appears here only when present]
```

The composer band communicates, in order:

- active model name, plus thinking level when space permits, never a provider label;
- current lifecycle state;
- a live context meter, with semantic pressure-colored fill and a dim remainder;
- context percentage/window, session cost, token volume, and cache efficiency as
  width permits.

No baseline footer is rendered. This avoids duplicating the composer status
band; a compact row appears only when another extension publishes status.

Statuses published by other Pi extensions remain visible on a conditional
row, matching the built-in footer contract.

At narrow widths, reserve the context percentage first; thinking detail, cost,
and window size drop before the model and lifecycle. Long names/details truncate
by grapheme. Native three-pane inspection caught the previous 59-column context
label disappearing; regression cases now cover 40–64 columns and 0–100% pressure.

## State model

| Event | Footer state |
| --- | --- |
| New/startup session | `ready` |
| Resumed session | `resumed` |
| Agent/provider reasoning | `thinking` |
| Text delta | `responding` |
| One tool running | `tool <name>` |
| Parallel tools running | `tools <count>` |
| Extension prompt open | `waiting` |
| Compaction in progress | `compacting` |
| Agent fully settled | `complete` |
| Provider/tool/compaction error | `error` |
| Abort/cancel | `stopped` |

State and meter changes are event-driven from usage Pi already persists. Meter
rendering is a bounded string operation on existing redraws. There are no idle
timers, polling loops, subprocesses, network calls, provider hooks, custom
animation timers, or extra dependencies.

## Theme neutrality

The companion UI contains no RGB, hex, 256-color, dark/light, or UltraTerm
theme mapping. It asks the currently active Pi theme for semantic colors only:
`accent`, `text`, `muted`, `dim`, `success`, `warning`, and `error`.

The three historical Steak themes remain available as optional choices, but
the companion UI neither selects nor requires them. Stock `dark`, stock
`light`, user themes, and future Pi themes all use the same renderer.

## Deterministic simulator

`src/tui/simulator.ts` is a pure headless contract simulator for the
companion-owned hierarchy around representative native transcript/editor
content. It covers startup, prompt, thinking, streaming, tool execution,
errors, completion, compaction, resume, history, scrolling, interruption, and
resize.

Run it without a model, network, or real session:

```sh
npm run ui:simulate -- --scenario tool --width 80 --height 24
npm run ui:simulate -- --scenario complete --width 40 --height 14 --plain
npm run test:tui
```

The simulator is intentionally not a fork or pixel clone of Pi's renderer.
The isolated native smoke test runs pinned Pi 0.85 on a private tmux socket with
private config/session stores. It covers local submit, Up/Down history, selector
confirmation, real session resume, stock dark/light themes, ANSI integrity, and
40/120-column redraws without touching UltraTerm's tmux sessions. Final visual
acceptance still runs against the installed Pi TUI inside UltraTerm.

## Acceptance gates

- Every rendered line is within 20, 24, 32, 40, 80, 120, and 192 columns.
- ANSI styling never changes measured layout width.
- Astra, Luna, and GLM model labels omit provider names and routing prefixes.
- Truncation never splits an emoji/grapheme.
- Session resume never clears transcript state.
- Editor submit/history/escape and resize remain deterministic in simulation.
- Native submit, Up/Down history, selector confirmation, and resume pass in an
  isolated pinned-Pi PTY smoke test.
- Print/JSON/RPC modes do not install TUI components.
- Production UI code uses only semantic theme functions.
- The context meter changes fill at 0%, mid-range, warning, and error pressure
  without polling or reserving a second header row.
- Full package tests and TypeScript checks pass before live verification.
- Live UltraTerm checks inspect dark and light Pi themes at 375px and 1920px
  host widths without restarting UltraTerm or replacing a live tmux pane.

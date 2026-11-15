# Compaction

Use the agent's existing per-model `compaction.modelOverrides` to set an automatic threshold. No soft threshold is enabled by Steak Pi by default. In the agent settings file, set the model's `reserveTokens` to the context window minus the desired threshold. For example, for a model with a 1,000,000-token window and a desired 300,000-token threshold:

```json
{
  "compaction": {
    "modelOverrides": {
      "example/model": { "reserveTokens": 700000 }
    }
  }
}
```

Replace the example key with the exact, case-sensitive `provider/modelId` and use the model's actual context window. Store the setting in the agent's global `settings.json` or the project's `.pi/settings.json`. The value is a non-negative safe integer in tokens. Invalid values raise a named setting error when the agent reads the matching setting. `compaction.enabled` defaults to true. If no override is set, the global `compaction.reserveTokens` applies, defaulting to 16,384 tokens. This same reserve also controls the maximum core summary output, subject to the model's output limit. There is no context-window-size override.

Automatic threshold compaction runs strictly above the threshold, not at it. The agent checks before a new prompt and between assistant responses after a tool batch has finished, not during a tool call. A final tool batch may end a run without an immediate check. Manual compaction and overflow recovery can run below the threshold. Context counts are estimates and can differ from provider counts.

Core compaction retains approximately `compaction.keepRecentTokens` recent tokens verbatim, default 20,000 tokens. It can split a long user turn at a safe assistant boundary. UltraCompress normally handles the compaction instead: its `keepUserTurns` and `smartKeepTail` settings determine the retained tail. `keepUserTurns` defaults to automatic and `smartKeepTail` defaults to true. If its binary fails, core compaction takes over. See `extensions/ultracompress/README.md` for the engine and recall settings.

The context band shows `ctx` and the current estimated token count above the configured threshold. Without a configured reserve it shows the cue above 40% of a window of at least 500,000 tokens. This cue is display-only. If the size is unknown, such as immediately after compaction, it is hidden. Narrow panes may omit it to stay within the available width.

Choose a threshold with enough room for the current task, tool outputs and the response. Lower thresholds can reduce re-read history and latency, but can lose detail from older turns. Recall can search raw session history when the UltraCompress binary is available. A higher retained tail preserves more detail but leaves less room before the next compaction.

## Measure before and after

Run the same representative tasks with the same model and tool setup before and after changing the setting. For each completed task record tokens read (input plus cache-read and cache-write tokens, with the provider's usage conventions), pass or fail against the same checks, and elapsed wall time in seconds. Compare tokens read per completed task, pass rate, and wall time; include failed tasks when reporting pass rate and note task count and run conditions. Repeat enough tasks to distinguish normal variation from a real change; do not assume token savings imply equal task quality.

## Implementation notes

In the installed agent, `dist/core/settings-manager.js:598,608-636` resolves `enabled`, `reserveTokens`, `keepRecentTokens` and `modelOverrides`; `dist/core/compaction/compaction.js:173-176` applies the strict comparison. `dist/core/agent-session.js:416-430,538-540,2440-2441` invokes the check at the agent's boundaries. For virtual model selections, the agent uses the routed model's window but resolves overrides against the selected model; use the selected model's key and verify the route's window.

The local extension loads `extensions/ultracompress/src/settings.ts:28-41,84-88` from `extensions/ultracompress/index.ts:46-48` and handles the compaction hook at `index.ts:194-198,223-235`. Its retention settings are separate from core's token budget. `extensions/statusline.ts` reads effective agent settings for the display cue; it does not initiate compaction.

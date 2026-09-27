# UltraCompress extension

Configuration: `~/.pi/agent/ultracompress.json` (partial JSON merges with defaults).

```json
{
  "snap": { "enabled": true, "minChars": 8192 },
  "summaryMaxBytes": 16384
}
```

Fresh `read` and `bash` results stay verbatim for the first model request; old results remain eligible for snap frames. Recall results are never archived again. Snap frames require a supported vision provider; without one, tool output remains readable. The raw session is never rewritten.

Recall requests explicitly default to 4000 UTF-8 bytes per hit (below 4096, compatible with the bridge's 4000-byte maximum). `snippetBytes` accepts 128–4000; `maxOutputBytes` separately bounds complete JSON output, default 12000. Use narrow queries and small pages.

Automatic/default compaction summaries and their previous-summary input are capped at `summaryMaxBytes` UTF-8 bytes (default 16384, configurable 1024–65536). Truncation is marked with a recall recovery route and never splits UTF-8 characters. Explicit `/ultracompress` compaction is not capped; snapshots/raw history retain omitted detail. A missing/failing bridge falls back to core compaction, whose summary budget is controlled by core.

The canonical managed bridge is `~/.ultraterm/bin/ultracompress`; `~/.local/bin/ultracompress` may be stale and is only a fallback. Explicit environment/config overrides take precedence.

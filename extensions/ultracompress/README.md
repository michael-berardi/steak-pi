# UltraCompress extension

Configuration: `~/.pi/agent/ultracompress.json` (partial JSON merges with defaults).

```json
{
  "snap": { "enabled": true, "minChars": 8192 },
  "snapshot": { "enabled": true, "maxCount": 10, "maxAgeDays": 14 },
  "summaryMaxBytes": 16384
}
```

Fresh `read` and `bash` results stay verbatim for the first model request; old results remain eligible for snap frames. Recall results are never archived again. Snap frames require a supported vision provider; without one, tool output remains readable. The raw session is never rewritten.

Recall requests explicitly default to 4000 UTF-8 bytes per hit (below 4096, compatible with the bridge's 4000-byte maximum). `snippetBytes` accepts 128–4000; `maxOutputBytes` separately bounds complete JSON output, default 12000. Use narrow queries and small pages.

Automatic/default compaction summaries and their previous-summary input are capped at `summaryMaxBytes` UTF-8 bytes (default 16384, configurable 1024–65536). Truncation is marked with a recall recovery route and never splits UTF-8 characters. Explicit `/ultracompress` compaction is not capped; snapshots/raw history retain omitted detail. A missing/failing bridge falls back to core compaction, whose summary budget is controlled by core.

Pre-compaction snapshots contain full conversation text in `<cwd>/.steak-pi/snaps/`. After each successful snapshot write, only the newest `snapshot.maxCount` files within `snapshot.maxAgeDays` are kept (defaults: 10 files, 14 days). Both limits apply per working directory and accept positive integers; invalid values use the defaults. Cleanup uses the timestamp in canonical `snap-*.json` filenames, not conversation metadata, and leaves unrelated files, directories and symlinks alone. Cleanup errors are logged without blocking compaction. Idle directories are not swept; copy a snapshot elsewhere if you need to retain it longer. Set `snapshot.enabled` to `false` to stop creating snapshots; this does not delete existing files. Restart the session after changing settings.

The canonical managed bridge is `~/.ultraterm/bin/ultracompress`; `~/.local/bin/ultracompress` may be stale and is only a fallback. Explicit environment/config overrides take precedence.

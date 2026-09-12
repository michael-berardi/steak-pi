# UltraCompress extension

Configuration: `~/.pi/agent/ultracompress.json` (partial JSON merges with defaults).

```json
{
  "uc": { "enabled": true, "bin": "uc", "minChars": 8192, "exemptFreshBash": true },
  "snap": { "minChars": 8192 },
  "summaryMaxBytes": 16384
}
```

Fresh `read` and, by default, `bash` results stay verbatim for the first model request. Set `uc.exemptFreshBash: false` to opt out; old results remain eligible. Both archive thresholds are configurable character counts. Retrieval results never re-archive.

Archive markers are `[UC uc:<64 lowercase hex digits>]` (72 characters). Pass the reference **or the complete marker** to `ultracompress_uc`; legacy long markers and complete @UC1 packets still work. References are bounded, session-local memory, not durable codec packets. Missing handles require recall or re-reading the source. The exact original session is never rewritten.

Recall requests explicitly default to 4000 UTF-8 bytes per hit (below 4096, compatible with the bridge's 4000-byte maximum). `snippetBytes` accepts 128–4000; `maxOutputBytes` separately bounds complete JSON output, default 12000. Use narrow queries and small pages.

Automatic/default compaction summaries and their previous-summary input are capped at `summaryMaxBytes` UTF-8 bytes (default 16384, configurable 1024–65536). Truncation is marked with a recall recovery route and never splits UTF-8 characters. Explicit `/ultracompress` compaction is not capped; snapshots/raw history retain omitted detail. A missing/failing bridge falls back to core compaction, whose summary budget is controlled by core.

The canonical managed bridge is `~/.ultraterm/bin/ultracompress`; `~/.local/bin/ultracompress` may be stale and is only a fallback. Explicit environment/config overrides take precedence. The `uc` codec in `~/dev/ultracompact` is a separate binary and never resolves session references. `ULTRACOMPACT_LIB` pointing at a nonexistent `target/release` library is a stale build-selector environment value; remove/fix it separately, not by changing installed binaries.

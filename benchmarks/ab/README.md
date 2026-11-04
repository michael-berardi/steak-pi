# Same-model A/B: Steak Pi vs Claude Code

Eight small Python tasks (`tasks.json`), a scripted checker per task (`checks/check.py`), the same model and effort for both
harnesses, both on stock config. `results-2026-11-04.jsonl` holds the raw per-run numbers behind the README table.

```sh
# fresh agent dir: auth + the Steak Pi package, nothing else
mkdir agent && cp ~/.pi/agent/auth.json agent/
echo '{"quietStartup":true,"packages":["<path to this checkout>"]}' > agent/settings.json
python3 benchmarks/ab/run.py <model> 5 6 agent results.jsonl   # 5 repeats, 6 lanes per harness
python3 benchmarks/ab/summarize.py results.jsonl
```

Cost comes from one rate table for both harnesses (`summarize.py`), so it does not depend on either tool's own accounting.
Each lane sends one throwaway request first so the cache-write charge for the starting prompt does not decide the result.
Wall times are measured with several runs in parallel and are noisy.

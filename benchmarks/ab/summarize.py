#!/usr/bin/env python3
"""usage: python3 summarize.py RESULTS.jsonl  → totals, per-task medians and paired-bootstrap ratios (Steak Pi / Claude Code)."""
import json, random, statistics as S, sys

R = [json.loads(l) for l in open(sys.argv[1])]
RATE = dict(o=0.50e-6, cr=0.01e-6, cw=0.20e-6)  # $/token for the model tested; set to its price list. Fitted to Claude Code's own reported cost in the 2026-11-04 run
cost = lambda r: r["o"] * RATE["o"] + r["cr"] * RATE["cr"] + r["cw"] * RATE["cw"]
tot = lambda r: r["i"] + r["cr"] + r["cw"]
for a, name in (("cc", "Claude Code"), ("sp", "Steak Pi")):
    rs = [r for r in R if r["arm"] == a]
    print(f"{name:12} correct {sum(r['ok'] for r in rs)}/{len(rs)}  input {sum(map(tot, rs)):,}  output {sum(r['o'] for r in rs):,}"
          f"  cost ${sum(map(cost, rs)):.4f}  time {sum(r['sec'] for r in rs):.0f}s")
pair = {}
for r in R:
    pair.setdefault((r["task"], r["rep"]), {})[r["arm"]] = r
random.seed(1)
keys = list(pair)
for label, f in (("input", tot), ("output", lambda r: r["o"]), ("cost", cost), ("wall time", lambda r: r["sec"])):
    ratio = lambda ks: sum(f(pair[k]["sp"]) for k in ks) / sum(f(pair[k]["cc"]) for k in ks)
    b = sorted(ratio([random.choice(keys) for _ in keys]) for _ in range(5000))
    print(f"{label:10} Steak Pi / Claude Code = {ratio(keys):.2f}  (95% CI {b[125]:.2f}-{b[4874]:.2f})")
print("Steak Pi cheaper in", sum(cost(p["sp"]) < cost(p["cc"]) for p in pair.values()), "of", len(pair), "paired runs")

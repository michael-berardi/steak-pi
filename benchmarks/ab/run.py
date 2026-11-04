#!/usr/bin/env python3
"""Same-model A/B: Steak Pi vs Claude Code, both on stock config.

usage: python3 run.py MODEL REPS PARALLEL AGENT_DIR [OUT.jsonl]
  MODEL      a model both harnesses can run, e.g. the Haiku id of your Claude plan
  AGENT_DIR  a fresh Pi agent dir holding auth.json and a settings.json that lists the Steak Pi package.
Claude Code runs with --setting-sources "" (no CLAUDE.md, hooks or settings), no skills, no MCP.
Each lane warms its prompt cache with one throwaway request first, so cache-write charges do not decide the result.
"""
import json, os, queue, shutil, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = sys.argv[1]
REPS, PAR, AGENT_DIR = int(sys.argv[2]), int(sys.argv[3]), os.path.abspath(sys.argv[4])
LOG = os.path.abspath(sys.argv[5] if len(sys.argv) > 5 else "results.jsonl")
WORK = os.path.abspath("work")
TASKS = json.load(open(os.path.join(HERE, "tasks.json")))
CC = ["claude", "-p", "--model", MODEL, "--effort", "medium", "--no-session-persistence",
      "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config", "--no-chrome"]
done = {(j["arm"], j["task"], j["rep"]) for j in map(json.loads, open(LOG))} if os.path.exists(LOG) else set()


def fresh(arm, slot):
    d = os.path.join(WORK, f"{arm}-{slot}")
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(os.path.join(HERE, "fixture"), d)
    return d


def run_cc(d, prompt):
    r = subprocess.run(CC + ["--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep",
                             "--output-format", "json", prompt], cwd=d, capture_output=True, text=True, timeout=300)
    j = json.loads(r.stdout)
    u = j["usage"]
    return dict(i=u["input_tokens"], o=u["output_tokens"], cr=u["cache_read_input_tokens"],
                cw=u["cache_creation_input_tokens"], turns=j.get("num_turns"), reported_cost=j.get("total_cost_usd")), j.get("result", "")


def run_sp(d, slot, prompt):
    ad = d + "-agent"
    if not os.path.exists(ad):
        shutil.copytree(AGENT_DIR, ad)
    r = subprocess.run(["steak-pi", "-p", "--mode", "json", "--no-session", "--model", f"claude-code/{MODEL}",
                        "--thinking", "medium", prompt], cwd=d, capture_output=True, text=True, timeout=300,
                       env={**os.environ, "PI_CODING_AGENT_DIR": ad})
    end = [e for e in (json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")) if e.get("type") == "agent_end"]
    if not end:
        raise RuntimeError("no agent_end: " + r.stderr[-200:])
    u = dict(i=0, o=0, cr=0, cw=0, turns=0)
    text = ""
    for m in end[-1]["messages"]:
        if m.get("role") != "assistant":
            continue
        x = m.get("usage") or {}
        u["i"] += x.get("input", 0); u["o"] += x.get("output", 0)
        u["cr"] += x.get("cacheRead", 0); u["cw"] += x.get("cacheWrite", 0); u["turns"] += 1
        t = "".join(c.get("text", "") for c in m.get("content", []) if c.get("type") == "text")
        text = t or text
    return u, text


def one(arm, slot, task, rep):
    d = fresh(arm, slot)
    t0 = time.time()
    err, u, text = "", {}, ""
    try:
        u, text = run_cc(d, TASKS[task]) if arm == "cc" else run_sp(d, slot, TASKS[task])
    except Exception as e:  # recorded, never hidden
        err = repr(e)[:200]
    open(os.path.join(d, "ans.txt"), "w").write(text)
    c = subprocess.run([sys.executable, os.path.join(HERE, "checks", "check.py"), task, "ans.txt"],
                       cwd=d, capture_output=True, text=True)
    u.update(arm=arm, task=task, rep=rep, ok=c.stdout.strip() == "true", sec=round(time.time() - t0, 1), err=err)
    open(LOG, "a").write(json.dumps(u) + "\n")
    print(json.dumps(u), flush=True)


slots = {a: queue.Queue() for a in ("cc", "sp")}
for a in slots:
    for k in range(PAR):
        slots[a].put(k)


def job(x):
    rep, task, arm = x
    if (arm, task, rep) in done:
        return
    k = slots[arm].get()
    try:
        one(arm, k, task, rep)
    finally:
        slots[arm].put(k)


def warm(arm, k):
    d = fresh(arm, k)
    p = "Reply with the single word ok."
    if arm == "cc":
        subprocess.run(CC + ["--output-format", "json", p], cwd=d, capture_output=True, timeout=300)
    else:
        run_sp(d, k, p)


names = list(TASKS)
jobs = [(r, t, a) for r in range(REPS) for t in names
        for a in (["cc", "sp"] if (r + names.index(t)) % 2 == 0 else ["sp", "cc"])]
with ThreadPoolExecutor(2 * PAR) as ex:
    list(ex.map(lambda x: warm(*x), [(a, k) for a in slots for k in range(PAR)]))
with ThreadPoolExecutor(2 * PAR) as ex:
    list(ex.map(job, jobs))

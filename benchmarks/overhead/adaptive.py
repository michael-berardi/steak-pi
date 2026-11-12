#!/usr/bin/env python3
"""Gate check for the adaptive tool loadout, against the scripted model (no network, no key).

usage: adaptive.py [--package PATH]   (env MOCK_PORT, default 18795)

Cases: light (one-shot, first request small, no dispatch/hub/todo), rpc (hosted session keeps every tool, no loader),
prompt / calls / loader (each makes the dispatch and todo tools and their guidance appear, once; the tool list never
changes again), explicit (--exclude-tools wins), defer-off (STEAK_PI_DEFER_TOOLS=off restores every tool). Exit 1 on
any failed check; prints one line per check.
"""
import argparse, importlib.util, json, os, shutil, socket, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
HEAVY = {"ultraterm_subagents", "todo"}
LOADER = "load_tools"
FIRST_REQUEST_LIMIT = 9000


def run_case(repo, port, prompt, mode="json", extra=(), env_extra=None):
    spec = importlib.util.spec_from_file_location("run", os.path.join(repo, "benchmarks/overhead/run.py"))
    run = importlib.util.module_from_spec(spec); spec.loader.exec_module(run)
    work = tempfile.mkdtemp(prefix="spi-adaptive-")
    out = os.path.join(work, "req"); os.makedirs(out)
    agent = os.path.join(work, "agent"); os.makedirs(agent)
    json.dump({"providers": {"mock": {"baseUrl": f"http://127.0.0.1:{port}/v1", "api": "openai-completions", "apiKey": "mock",
              "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False},
              "models": [{"id": "mock-coder", "contextWindow": 128000, "maxTokens": 8000}]}}}, open(os.path.join(agent, "models.json"), "w"))
    srv = subprocess.Popen([sys.executable, os.path.join(repo, "benchmarks/overhead/mock-model.py"), str(port)],
                           env=dict(os.environ, MOCK_DUMP_DIR=out, MOCK_LOG=os.path.join(out, "log.jsonl")),
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            try: socket.create_connection(("127.0.0.1", port), timeout=0.2).close(); break
            except OSError: time.sleep(0.1)
        fx = tempfile.mkdtemp(dir=work); subprocess.run(["git", "init", "-q"], cwd=fx)
        env = dict(os.environ, PI_CODING_AGENT_DIR=agent, PI_OFFLINE="1", PI_TELEMETRY="0", STEAK_PI_USAP_SLOT_DIR=os.path.join(fx, ".slots"), **(env_extra or {}))
        base = [os.path.join(repo, "node_modules/.bin/pi"), *run.package_args(repo), *extra, "--provider", "mock", "--model", "mock-coder"]
        if mode == "rpc":
            p = subprocess.Popen([*base, "--mode", "rpc"], cwd=fx, env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            p.stdin.write((json.dumps({"type": "prompt", "message": prompt}) + "\n").encode()); p.stdin.flush()
            t0 = time.time(); last = -1; stable = 0
            while time.time() - t0 < 60 and stable < 3:
                time.sleep(1)
                n = len([f for f in os.listdir(out) if f.startswith("req-")])
                stable = stable + 1 if n == last and n > 0 else 0; last = n
            p.terminate(); p.wait(timeout=10)
        else:
            subprocess.run([*base, "--mode", mode, "-p", prompt], cwd=fx, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
        reqs = []
        for f in sorted(x for x in os.listdir(out) if x.startswith("req-")):
            reqs.append(json.load(open(os.path.join(out, f))))
        return reqs
    finally:
        srv.terminate(); srv.wait(timeout=10); shutil.rmtree(work, ignore_errors=True)


def tools_of(req): return {t["function"]["name"] for t in req.get("tools", [])}
def text_of(req): return json.dumps(req["messages"])
def size(req): return len(json.dumps(req))
GUIDE = "Fan out by default"  # first line of the dispatch tool's guidelines


def check_growth(reqs, name):
    res = []
    sets = [frozenset(tools_of(r)) for r in reqs]
    changes = sum(1 for a, b in zip(sets, sets[1:]) if a != b)
    first = next((i for i, s in enumerate(sets) if HEAVY <= s), None)
    res.append((f"{name}: dispatch and todo tools appear", first is not None))
    res.append((f"{name}: tool list changes at most once and never after", changes <= 1 and (first is None or all(HEAVY <= s for s in sets[first:]))))
    res.append((f"{name}: guidance reaches the model", first is not None and GUIDE in text_of(reqs[first])))
    res.append((f"{name}: guidance sent once (not repeated per request in system text)", first is not None and text_of(reqs[-1]).count(GUIDE) <= 2))
    return res, first


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--package", default=os.path.abspath(os.path.join(HERE, "..", ".."))); a = ap.parse_args()
    repo = os.path.abspath(a.package); port = int(os.environ.get("MOCK_PORT", "18795"))
    results = []
    light = run_case(repo, port, "Create hello.ts exporting hello = 'world'.")
    results += [("light: first request <= %d bytes (%d)" % (FIRST_REQUEST_LIMIT, size(light[0])), size(light[0]) <= FIRST_REQUEST_LIMIT),
                ("light: no dispatch, hub or todo tool", not (tools_of(light[0]) & {"ultraterm_subagents", "ultraterm_hub", "todo"})),
                ("light: loader present", LOADER in tools_of(light[0])),
                ("light: tool list never changes", len({frozenset(tools_of(r)) for r in light}) == 1)]
    rpc = run_case(repo, port, "Create hello.ts exporting hello = 'world'.", mode="rpc")
    results += [("rpc: dispatch and todo present on the first request", bool(rpc) and HEAVY <= tools_of(rpc[0])),
                ("rpc: no loader", bool(rpc) and LOADER not in tools_of(rpc[0])),
                ("rpc: first request >= 20000 bytes (%d)" % (size(rpc[0]) if rpc else 0), bool(rpc) and size(rpc[0]) >= 20000)]
    for name, prompt, want_first in (("prompt", "Create hello.ts, delegating the work in parallel to subagents.", 0),
                                      ("calls", "steps:12 do it", 10), ("loader", "loader: steps:2 do it", 3)):
        reqs = run_case(repo, port, prompt)
        res, first = check_growth(reqs, name)
        res.append((f"{name}: appears on request index {want_first} (got {first})", first == want_first))
        results += res
    ex = run_case(repo, port, "steps:12 do it", extra=["--exclude-tools", "ultraterm_subagents,ultraterm_hub,todo"])
    results += [("explicit: --exclude-tools keeps the tools out", all(not (tools_of(r) & {"ultraterm_subagents", "todo"}) for r in ex)),
                ("explicit: no loader", all(LOADER not in tools_of(r) for r in ex))]
    off = run_case(repo, port, "Create hello.ts exporting hello = 'world'.", env_extra={"STEAK_PI_DEFER_TOOLS": "off"})
    results += [("defer-off: every tool on the first request", bool(off) and HEAVY <= tools_of(off[0])), ("defer-off: no loader", bool(off) and LOADER not in tools_of(off[0]))]
    bad = 0
    for label, ok in results:
        print(("PASS " if ok else "FAIL ") + label); bad += not ok
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

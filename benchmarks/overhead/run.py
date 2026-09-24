#!/usr/bin/env python3
"""Harness overhead: identical fixtures against a scripted local model.

usage: run.py [--n 5] [--cases direct,modules,gate,fanout] ARM=SPEC ...

ARM=SPEC pairs name each arm. SPEC is `stock` (Pi with no extensions) or a
Steak Pi package root, optionally suffixed `+run` to apply the `steak-pi run`
Node defaults. Example:
  run.py stock=stock v060=../steak-pi-0.6.0 v070=. v070run=.+run
Env: PI_BIN (default: ./node_modules/.bin/pi). Prints JSON rows and a summary.
"""
import argparse, json, os, shutil, socket, statistics, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
PI = os.environ.get("PI_BIN", os.path.join(REPO, "node_modules", ".bin", "pi"))
PORT = int(os.environ.get("MOCK_PORT", "18731"))
CASES = {
    "direct": ("Create hello.ts exporting hello = 'world'.", ["hello.ts"]),
    "modules": ("Create the four modules slug.ts title.ts clamp01.ts sum.ts with the exact contracts.",
                ["slug.ts", "title.ts", "clamp01.ts", "sum.ts"]),
    "gate": ("Create c1.ts through c8.ts, each exporting SLOT_i set to i*11.", [f"c{i}.ts" for i in range(1, 9)]),
    "fanout": ("Fan out: create c1.ts through c8.ts, each exporting SLOT_i set to i*11.", [f"c{i}.ts" for i in range(1, 9)]),
}
RUN_ENV = {"MALLOC_ARENA_MAX": "2", "NODE_OPTIONS": "--max-semi-space-size=2"}


def package_args(root):
    ext = [a for f in sorted(os.listdir(os.path.join(root, "extensions")))
           if f.endswith(".ts") and not f.endswith(".test.ts")
           for a in ("-e", os.path.join(root, "extensions", f))]
    return ["-ne", *ext, "-e", os.path.join(root, "extensions/ultracompress/index.ts"),
            "-e", os.path.join(root, "extensions/skill-catalog-lite/index.ts"), "--skill", os.path.join(root, "skills")]


def measure(argv, env, cwd):
    code = ("import resource,subprocess,sys,time,json;t=time.perf_counter();"
            "r=subprocess.run(sys.argv[1:],stdin=subprocess.DEVNULL,capture_output=True,timeout=180);"
            "print(json.dumps({'rc':r.returncode,'wall':time.perf_counter()-t,"
            "'rss_kb':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss}))")
    out = subprocess.run([sys.executable, "-c", code, *argv], cwd=cwd, env=env, capture_output=True, timeout=240)
    return json.loads(out.stdout.decode().strip().splitlines()[-1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--cases", default="direct,modules,gate,fanout")
    ap.add_argument("arms", nargs="+")
    a = ap.parse_args()
    arms = [tuple(x.split("=", 1)) for x in a.arms]
    work = tempfile.mkdtemp(prefix="steak-overhead-")
    agent = os.path.join(work, "agent"); os.makedirs(agent)
    json.dump({"providers": {"mock": {"baseUrl": f"http://127.0.0.1:{PORT}/v1", "api": "openai-completions", "apiKey": "mock",
               "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False},
               "models": [{"id": "mock-coder", "contextWindow": 128000, "maxTokens": 8000}]}}},
              open(os.path.join(agent, "models.json"), "w"))
    logpath = os.path.join(work, "logpath")
    server = subprocess.Popen([sys.executable, os.path.join(HERE, "mock-model.py"), str(PORT)],
                              env=dict(os.environ, MOCK_LOG_PATH_FILE=logpath), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if server.poll() is not None:
            raise SystemExit(f"mock model exited (port {PORT} busy? set MOCK_PORT)")
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    else:
        raise SystemExit("mock model did not start")
    rows = []
    try:
        for rnd in range(a.n):
            order = arms if rnd % 2 == 0 else list(reversed(arms))
            for case in a.cases.split(","):
                prompt, expect = CASES[case]
                for name, spec in order:
                    fx = tempfile.mkdtemp(dir=work)
                    subprocess.run(["git", "init", "-q"], cwd=fx)
                    log = os.path.join(fx, ".mock.jsonl")
                    open(logpath, "w").write(log)
                    env = dict(os.environ, PI_CODING_AGENT_DIR=agent, PI_OFFLINE="1", PI_TELEMETRY="0",
                               STEAK_PI_USAP_SLOT_DIR=os.path.join(fx, ".slots"))
                    tuned = spec.endswith("+run")
                    root = spec[:-4] if tuned else spec
                    if tuned:
                        env.update(RUN_ENV, NODE_COMPILE_CACHE=os.path.join(work, "node-cc"))
                    pkg = [] if root == "stock" else package_args(os.path.abspath(root))
                    m = measure([PI, *pkg, "--mode", "json", "--provider", "mock", "--model", "mock-coder", "-p", prompt], env, fx)
                    reqs = [json.loads(l) for l in open(log)] if os.path.exists(log) else []
                    row = {"arm": name, "case": case, "round": rnd,
                           "pass": m["rc"] == 0 and all(os.path.exists(os.path.join(fx, f)) for f in expect),
                           "wall_s": round(m["wall"], 3), "peak_rss_mb": round(m["rss_kb"] / 1024, 1),
                           "requests": len(reqs), "request_bytes": sum(r["bytes"] for r in reqs),
                           "first_request_bytes": reqs[0]["bytes"] if reqs else 0, "tools": reqs[0]["tools"] if reqs else 0}
                    rows.append(row)
                    print(json.dumps(row), flush=True)
    finally:
        server.terminate()
        shutil.rmtree(work, ignore_errors=True)
    summary = {}
    for name, _ in arms:
        for case in a.cases.split(","):
            rs = [r for r in rows if r["arm"] == name and r["case"] == case]
            summary[f"{name}/{case}"] = {"pass": f"{sum(r['pass'] for r in rs)}/{len(rs)}",
                                          "median_wall_s": round(statistics.median(r["wall_s"] for r in rs), 3),
                                          "median_peak_rss_mb": round(statistics.median(r["peak_rss_mb"] for r in rs), 1),
                                          "request_bytes": int(statistics.median(r["request_bytes"] for r in rs)),
                                          "first_request_bytes": rs[0]["first_request_bytes"], "tools": rs[0]["tools"]}
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

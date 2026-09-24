#!/usr/bin/env python3
"""Scripted OpenAI-compatible chat endpoint for harness-overhead benchmarks.

The "model" follows a fixed plan per fixture, so startup, prompt size, tool
dispatch and subagent orchestration are measured without model variance or
network. Every request is logged (bytes, tools, messages) as JSONL to the path
named in MOCK_LOG_PATH_FILE (re-read per request) or MOCK_LOG.

Plans: "Fan out" prompts call ultraterm_subagents with one write task per file;
worker leaves ("exactly this content:") write their file; other prompts write
all fixture files with one parallel batch of write calls. Then it answers.
"""
import json, os, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_PATH_FILE = os.environ.get("MOCK_LOG_PATH_FILE", "")
LOG_PATH = os.environ.get("MOCK_LOG", "/tmp/mockllm.jsonl")
LATENCY = float(os.environ.get("MOCK_LATENCY_MS", "0")) / 1000.0
lock = threading.Lock()

MODULES = {
    "slug.ts": 'export function slug(s: string): string {\n  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n',
    "title.ts": 'export function title(s: string): string {\n  return s.trim().split(/\\s+/).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");\n}\n',
    "clamp01.ts": 'export function clamp01(n: number): number {\n  if (Number.isNaN(n)) return 0;\n  return Math.min(1, Math.max(0, n));\n}\n',
    "sum.ts": 'export function digitSum(n: number): number {\n  return String(Math.abs(Math.trunc(n))).split("").reduce((a, d) => a + Number(d), 0);\n}\n',
}
GATE = {f"c{i}.ts": f"export const SLOT_{i} = {i * 11};\n" for i in range(1, 9)}


def plan_for(prompt):
    p = prompt.lower()
    if "four modules" in p or "slug.ts" in p:
        return MODULES
    if "slot_" in p or "c1.ts" in p:
        return GATE
    return {"hello.ts": 'export const hello = "world";\n'}


def find_tool(tools, name):
    for t in tools or []:
        fn = t.get("function", t)
        if fn.get("name") == name:
            return fn
    return None


def write_args(tool, path, content):
    props = (tool.get("parameters") or {}).get("properties", {})
    key = "path" if "path" in props else ("file_path" if "file_path" in props else "filePath")
    args = {key: path, "content": content}
    if "intent" in props:
        args["intent"] = f"create {path}"
    return args


def first_user_text(messages):
    return " ".join(_text(m) for m in messages if m.get("role") == "user")


def _text(m):
    for m in [m]:
        if True:
            c = m.get("content")
            if isinstance(c, list):
                return " ".join(x.get("text", "") for x in c if isinstance(x, dict))
            return c or ""
    return ""


def sse(handler, chunks):
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "close")
    handler.close_connection = True
    handler.end_headers()
    for c in chunks:
        handler.wfile.write(b"data: " + json.dumps(c).encode() + b"\n\n")
    handler.wfile.write(b"data: [DONE]\n\n")
    handler.wfile.flush()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "mock-coder", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n)
        req = json.loads(raw or b"{}")
        if os.environ.get("MOCK_DUMP"):
            open(os.environ["MOCK_DUMP"], "wb").write(raw)
        messages = req.get("messages", [])
        tools = req.get("tools", [])
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        sys_bytes = sum(len(json.dumps(m.get("content"))) for m in messages if m.get("role") in ("system", "developer"))
        log_path = open(LOG_PATH_FILE).read().strip() if LOG_PATH_FILE and os.path.exists(LOG_PATH_FILE) else LOG_PATH
        with lock, open(log_path, "a") as f:
            f.write(json.dumps({"t": time.time(), "bytes": len(raw), "system_bytes": sys_bytes,
                                "tools_bytes": len(json.dumps(tools)), "tools": len(tools),
                                "messages": len(messages), "tool_results": len(tool_msgs),
                                "tool_names": sorted((t.get("function", t)).get("name", "") for t in tools)}) + "\n")
        if LATENCY:
            time.sleep(LATENCY)
        base = {"id": "mock", "object": "chat.completion.chunk", "created": int(time.time()), "model": req.get("model", "mock-coder")}
        usage = {"prompt_tokens": len(raw) // 4, "completion_tokens": 20, "total_tokens": len(raw) // 4 + 20}
        prompt = first_user_text(messages)
        sys_text = " ".join(_text(m) for m in messages if m.get("role") in ("system", "developer"))
        wt = find_tool(tools, "write")
        st = find_tool(tools, "ultraterm_subagents")
        if not tool_msgs and st and "fan out" in prompt.lower():
            files = plan_for(prompt)
            n = int(os.environ.get("FANOUT_N", "0") or 0)
            if n:
                files = dict(list(GATE.items())[:n])
            tasks = [{"label": f"t{i}", "task": f"Create {path} with exactly this content:\n{content}",
                      "mayEdit": True, "ownedPaths": [path]} for i, (path, content) in enumerate(files.items())]
            # Name the scripted route: on the 0.8 line an unconfigured parent resolves
            # the subscription worker chain, which fails closed without credentials.
            args = {"goal": "Create the requested files, one per worker.", "tasks": tasks,
                    "model": "mock/mock-coder"}
            chunks = [dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_fan", "type": "function",
                      "function": {"name": "ultraterm_subagents", "arguments": json.dumps(args)}}]}, "finish_reason": None}]),
                      dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], usage=usage)]
        elif not tool_msgs and wt and "exactly this content:" in (prompt + sys_text):
            # Worker leaf: write the single owned file named in the task.
            import re
            m = re.search(r"Create (\S+) with exactly this content:\n(.*?)(?:\n\n|$)", prompt + "\n\n" + sys_text, re.S)
            path, content = (m.group(1), m.group(2)) if m else ("leaf.ts", "")
            if not content.endswith("\n"):
                content += "\n"
            chunks = [dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "tool_calls": [{"index": 0, "id": "call_w", "type": "function",
                      "function": {"name": "write", "arguments": json.dumps(write_args(wt, path, content))}}]}, "finish_reason": None}]),
                      dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], usage=usage)]
        elif not tool_msgs and wt:
            files = plan_for(prompt)
            calls = []
            for i, (path, content) in enumerate(files.items()):
                calls.append({"index": i, "id": f"call_{i}", "type": "function",
                              "function": {"name": "write", "arguments": json.dumps(write_args(wt, path, content))}})
            chunks = [dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "tool_calls": calls}, "finish_reason": None}]),
                      dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "tool_calls"}], usage=usage)]
        else:
            chunks = [dict(base, choices=[{"index": 0, "delta": {"role": "assistant", "content": "Done. All files written."}, "finish_reason": None}]),
                      dict(base, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}], usage=usage)]
        if not req.get("stream"):
            msg = chunks[0]["choices"][0]["delta"]
            body = json.dumps({"id": "mock", "object": "chat.completion", "model": base["model"],
                               "choices": [{"index": 0, "message": msg, "finish_reason": chunks[-1]["choices"][0]["finish_reason"]}],
                               "usage": usage}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        sse(self, chunks)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()

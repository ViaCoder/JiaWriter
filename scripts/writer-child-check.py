#!/usr/bin/env python3
"""Hands-on check of the child runs of JiaWriter against a local mock of the model (nothing leaves 127.0.0.1, the key
is a dummy): the delegate tool starts a child run of the program that writes a file and replies, and the parent
returns that reply; `jiawriter schedule run` runs a due scheduled task the same way and logs it. Prints one line per
check and exits 1 when any fails.
Usage: python3 -I scripts/writer-child-check.py [program]   (default: the source launcher)
"""

# Mock server, processes, files and timing.
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta


def event(delta, finish=None):
    """One stream event."""
    chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")


def call(handler, name, args):
    """A whole tool call, then the end of the reply."""
    head = {"tool_calls": [{"index": 0, "id": f"call_{name}", "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}
    handler.wfile.write(event(head) + event({}, "tool_calls") + b"data: [DONE]\n\n")


def say(handler, text):
    """A text reply."""
    handler.wfile.write(event({"content": text}) + event({}, "stop") + b"data: [DONE]\n\n")


class Model(http.server.BaseHTTPRequestHandler):
    """The parent delegates when asked to; a child writes 回复.md and says so; after a tool result, the reply names it."""

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        messages = body["messages"]
        user = next((m for m in messages if m.get("role") == "user"), {})
        text = user.get("content") if isinstance(user.get("content"), str) else json.dumps(user.get("content"), ensure_ascii=False)
        last = messages[-1]
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        if last.get("role") == "tool":
            result = last.get("content") if isinstance(last.get("content"), str) else json.dumps(last.get("content"), ensure_ascii=False)
            say(self, f"子任务说：{result.strip()[:80]}" if "delegate" in text else "写好了。")
        elif "delegate" in text:
            call(self, "delegate", {"task": "写一句话", "folder": "子题A", "minutes": 2})
        else:
            call(self, "write", {"path": "回复.md", "content": "一句话。\n"})

    def log_message(self, *_args):
        """Silence."""


# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    if len(sys.argv) > 1:
        program = [os.path.abspath(sys.argv[1])]
    else:
        coding = os.path.join(ROOT, "packages", "coding-agent")
        program = ["node", "--import", "file://" + os.path.join(coding, "src", "experimental", "source-resolver.ts"), os.path.join(coding, "src", "cli.ts")]
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="jw-child-")
    work = os.path.join(tmp, "work")
    agent = os.path.join(tmp, "agent")
    os.makedirs(work)
    os.makedirs(agent)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD"))}
    env.update(
        HOME=tmp, JW_DIR=agent, JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY="sk-dummy-child-check",
        JW_MODEL="mock-model", JW_API="openai-completions", JW_EFFORT="off", JW_PERMISSION="bypass",
    )
    results = []
    check = lambda name, ok: results.append((name, bool(ok)))
    try:
        # 1. The delegate tool: the parent's reply carries the child's, and the child's file is in its folder.
        run = subprocess.run(
            [*program, "--no-context-files", "-p", "用 delegate 工具把一个子任务交出去，然后把它的回复告诉我"],
            cwd=work, env=env, capture_output=True, text=True, encoding="utf-8", timeout=300,
        )
        check("delegate：主进程正常退出", run.returncode == 0)
        check("delegate：子进程写了 子题A/回复.md", os.path.exists(os.path.join(work, "子题A", "回复.md")))
        check("delegate：主进程的回复带着子任务的回复", "子任务说：写好了" in run.stdout)
        # 2. A due scheduled task: run, logged, recorded.
        created = (datetime.now().astimezone() - timedelta(minutes=2)).isoformat()
        with open(os.path.join(agent, "schedules.json"), "w", encoding="utf-8") as f:
            json.dump({"jobs": [{"id": "t1", "when": "* * * * *", "task": "写一句话", "folder": os.path.join(work, "定时"), "created": created}]}, f, ensure_ascii=False)
        os.makedirs(os.path.join(work, "定时"))
        sched = subprocess.run([*program, "schedule", "run"], cwd=work, env=env, capture_output=True, text=True, encoding="utf-8", timeout=300)
        check("schedule run：退出码 0", sched.returncode == 0)
        check("schedule run：报告任务已运行 ok", "已运行：ok" in sched.stdout or "ran: ok" in sched.stdout)
        check("schedule run：子进程写了 定时/回复.md", os.path.exists(os.path.join(work, "定时", "回复.md")))
        logs = os.listdir(os.path.join(agent, "schedules", "t1")) if os.path.isdir(os.path.join(agent, "schedules", "t1")) else []
        check("schedule run：写了日志", len(logs) == 1)
        jobs = json.load(open(os.path.join(agent, "schedules.json"), encoding="utf-8"))["jobs"]
        check("schedule run：记下了上次运行", jobs[0].get("lastResult") == "ok" and bool(jobs[0].get("lastRun")))
        # 3. Nothing due right after.
        again = subprocess.run([*program, "schedule", "run"], cwd=work, env=env, capture_output=True, text=True, encoding="utf-8", timeout=120)
        check("schedule run：刚跑过的任务不再跑", "没有到点" in again.stdout or "No scheduled task is due" in again.stdout)
        if not all(ok for _n, ok in results):
            # What went wrong: the parent's reply and the scheduled run's log (no URL in either is the mock's).
            print("--- stdout (parent):", run.stdout[-900:].replace("\n", " | "))
            print("--- stderr (parent):", run.stderr[-600:].replace("\n", " | "))
            for name in logs:
                print("--- log:", open(os.path.join(agent, "schedules", "t1", name), encoding="utf-8").read()[-900:].replace("\n", " | "))
    finally:
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    for name, ok in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    failed = sum(1 for r in results if not r[1])
    print(f"{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

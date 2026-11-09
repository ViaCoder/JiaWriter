#!/usr/bin/env python3
"""Hands-on check that write and edit text appears while the model produces it, in JiaWriter's real interface:
a pseudo-terminal and a local mock of the model that sends tool arguments in small pieces (nothing leaves 127.0.0.1,
the key is a dummy). A piece counts when it reaches the screen before the mock has sent the end of the call.
Prints one line per check and exits 1 when any fails.
Usage: python3 -I scripts/writer-live-check.py [program]
"""

# Mock server, pseudo-terminal, process control and timing.
import http.server
import json
import os
import pty
import re
import select
import shutil
import signal
import sys
import tempfile
import threading
import time

# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ANSI escape sequences.
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
# Lines of the draft: long enough to pass any preview.
LINES = 40
# The draft, and the passage the edit replaces and adds.
DRAFT = "\n\n".join(f"第{i}段正文内容。" for i in range(1, LINES + 1))
NEW_LINES = 30
NEW_TEXT = "\n\n".join(f"新写的第{i}段。" for i in range(1, NEW_LINES + 1))
# Set when the mock has sent the last piece of each call.
sent = {"write": threading.Event(), "edit": threading.Event()}


def event(delta, finish=None):
    """One stream event."""
    chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")


def stream_call(handler, name, args):
    """A tool call whose arguments arrive 12 characters at a time."""
    text = json.dumps(args, ensure_ascii=False)
    head = {"tool_calls": [{"index": 0, "id": f"call_{name}", "type": "function", "function": {"name": name, "arguments": ""}}]}
    handler.wfile.write(event(head))
    handler.wfile.flush()
    for i in range(0, len(text), 12):
        piece = {"tool_calls": [{"index": 0, "function": {"arguments": text[i : i + 12]}}]}
        handler.wfile.write(event(piece))
        handler.wfile.flush()
        time.sleep(0.05)
    sent[name].set()
    # The end comes later, so what the screen shows until then came from the stream.
    time.sleep(0.5)
    handler.wfile.write(event({}, "tool_calls") + b"data: [DONE]\n\n")


class Model(http.server.BaseHTTPRequestHandler):
    """Write on the first question, edit on the second, a short reply after a tool result."""

    def do_POST(self):
        """Decide by the last message."""
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        last = body["messages"][-1]
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        text = str(last.get("content"))
        if last.get("role") == "tool":
            self.wfile.write(event({"content": "完成了。"}) + event({}, "stop") + b"data: [DONE]\n\n")
        elif "改稿" in text:
            stream_call(self, "edit", {"path": "稿.md", "edits": [{"oldText": "第1段正文内容。", "newText": NEW_TEXT}]})
        else:
            stream_call(self, "write", {"path": "稿.md", "content": DRAFT})

    def log_message(self, *_args):
        """Silence."""


def read_until(fd, wanted, stop, seconds):
    """Terminal text until `wanted` appears, `stop` is set, or the time is up. (found, text)"""
    # Collected text.
    out = b""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                out += os.read(fd, 65536)
            except OSError:
                break
        text = ANSI.sub("", out.decode("utf-8", "replace")).replace(" ", "")
        if wanted and wanted in text:
            return True, text
        if stop is not None and stop.is_set():
            return False, text
    return False, ANSI.sub("", out.decode("utf-8", "replace")).replace(" ", "")


def main():
    """Run the steps and print the results."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="jw-live-")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD"))}
    env.update(
        HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), TERM="xterm-256color", COLUMNS="120", LINES="40",
        JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY="sk-dummy-live-check", JW_MODEL="mock-model",
        JW_API="openai-completions", JW_EFFORT="off",
        # Writing without the permission question: these checks are about the screen, not about asking (2026-11-09).
        JW_PERMISSION="bypass",
    )
    program = sys.argv[1:]
    if program:
        program[0] = os.path.abspath(program[0])
    else:
        coding = os.path.join(ROOT, "packages", "coding-agent")
        program = ["node", "--import", "file://" + os.path.join(coding, "src", "experimental", "source-resolver.ts"), os.path.join(coding, "src", "cli.ts")]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(tmp)
        os.execvpe(program[0], program, env)
    os.set_blocking(fd, False)
    results = []
    check = lambda name, ok: results.append((name, bool(ok)))
    try:
        read_until(fd, "命令", None, 20)
        # Write: the early, the middle and the late lines, each before the call has ended.
        os.write(fd, "写稿".encode("utf-8"))
        read_until(fd, "", None, 0.5)
        os.write(fd, b"\r")
        for n in (3, 20, LINES - 2):
            found, _ = read_until(fd, f"第{n}段正文", sent["write"], 25)
            check(f"write：第 {n} 段在生成中就显示", found)
        read_until(fd, "完成了", None, 15)
        # Edit: the same for the new text.
        os.write(fd, "改稿".encode("utf-8"))
        read_until(fd, "", None, 0.5)
        os.write(fd, b"\r")
        for n in (3, 15, NEW_LINES - 2):
            found, _ = read_until(fd, f"新写的第{n}段", sent["edit"], 25)
            check(f"edit：第 {n} 段在生成中就显示", found)
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (OSError, ChildProcessError):
            pass
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    for name, ok in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    failed = sum(1 for r in results if not r[1])
    print(f"{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

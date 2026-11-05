#!/usr/bin/env python3
"""Hands-on check of sending during a reply, in JiaWriter's real interface: a pseudo-terminal and a local mock of
the model (nothing leaves 127.0.0.1, the key is a dummy).

Esc stops the reply and sends what was queued, leaving the draft; Ctrl+X Ctrl+S stops it and sends what was queued
with the draft behind it; Up brings the queue back for editing. Judged by what reaches the model.
Prints one line per check and exits 1 when any fails.
Usage: python3 -I scripts/writer-sendnow-check.py [program]
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
# Keys as a terminal sends them in raw mode.
ESC, CTRL_X, CTRL_S, UP = b"\x1b", b"\x18", b"\x13", b"\x1b[A"
# The last user message of each request, in order.
asked = []


def last_user(body):
    """The text of the last user message in a request."""
    # Plain text or a list of parts.
    content = [m for m in body.get("messages", []) if m.get("role") == "user"][-1]["content"]
    return content if isinstance(content, str) else "".join(p.get("text", "") for p in content)


class Model(http.server.BaseHTTPRequestHandler):
    """A Chat Completions stream: a message with 慢 gets words for a minute, any other a short reply."""

    def do_POST(self):
        """Record the question, then stream."""
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        text = last_user(body)
        asked.append(text)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        words = ["慢慢写 "] * 300 if "慢" in text else ["收到了。"]
        try:
            for word in words:
                chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": word}}]}
                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(0.2 if len(words) > 1 else 0)
            end = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            self.wfile.write(f"data: {json.dumps(end)}\n\ndata: [DONE]\n\n".encode("utf-8"))
        except OSError:
            pass

    def log_message(self, *_args):
        """Silence."""


def read_until(fd, wanted, seconds):
    """Terminal text until `wanted` appears or the time is up. Waits read too: a full terminal stops the program."""
    # Collected text.
    out = b""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                out += os.read(fd, 65536)
            except OSError:
                break
        text = ANSI.sub("", out.decode("utf-8", "replace"))
        if wanted and wanted in text:
            return text
    return ANSI.sub("", out.decode("utf-8", "replace"))


def wait_asked(fd, text, seconds):
    """True once a request held `text`, reading the terminal meanwhile."""
    # Look again until the end.
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if any(text in a for a in asked):
            return True
        read_until(fd, "", 0.3)
    return any(text in a for a in asked)


def type_line(fd, text, enter=True):
    """Type text, with Enter when asked."""
    os.write(fd, text.encode("utf-8"))
    read_until(fd, "", 0.5)
    if enter:
        os.write(fd, b"\r")
        read_until(fd, "", 0.5)


def main():
    """Run the steps and print the results."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="jw-sendnow-")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD"))}
    env.update(
        HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), TERM="xterm-256color", COLUMNS="120", LINES="40",
        JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY="sk-dummy-sendnow-check", JW_MODEL="mock-model",
        JW_API="openai-completions", JW_EFFORT="off",
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
        read_until(fd, "命令", 20)
        # Esc: the queue goes out, the draft stays.
        type_line(fd, "慢问题一")
        read_until(fd, "慢慢写", 15)
        type_line(fd, "排队一")
        type_line(fd, "留着的草稿", enter=False)
        os.write(fd, ESC)
        check("Esc：排队消息立刻发给模型", wait_asked(fd, "排队一", 8))
        read_until(fd, "收到了", 8)
        check("Esc：草稿没有发出", not any("留着的草稿" in a for a in asked))
        # Enter sends the draft that stayed, which also proves it was still in the editor.
        os.write(fd, b"\r")
        check("Esc：草稿留在输入框，回车能发出", wait_asked(fd, "留着的草稿", 8))
        read_until(fd, "收到了", 8)
        # Ctrl+X Ctrl+S: the queue, with the draft behind it.
        type_line(fd, "慢问题二")
        read_until(fd, "慢慢写", 15)
        type_line(fd, "排队二")
        type_line(fd, "跟上的草稿", enter=False)
        before = len(asked)
        os.write(fd, CTRL_X)
        read_until(fd, "", 0.2)
        os.write(fd, CTRL_S)
        check("组合键：排队消息立刻发给模型", wait_asked(fd, "排队二", 8))
        check("组合键：草稿也发出", wait_asked(fd, "跟上的草稿", 10))
        new = asked[before:]
        check("组合键：草稿排在排队消息后面", len(new) >= 2 and "排队二" in new[0] and "跟上的草稿" in new[1])
        read_until(fd, "收到了", 8)
        # Up: edit what is queued, then send it.
        type_line(fd, "慢问题三")
        read_until(fd, "慢慢写", 15)
        type_line(fd, "排队三")
        os.write(fd, UP)
        read_until(fd, "", 0.8)
        type_line(fd, "改过", enter=False)
        os.write(fd, CTRL_X)
        read_until(fd, "", 0.2)
        os.write(fd, CTRL_S)
        check("上方向键：改过的排队消息发给模型", wait_asked(fd, "排队三改过", 8))
        check("上方向键：没有发出改之前的内容", not any(a.strip() == "排队三" for a in asked))
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

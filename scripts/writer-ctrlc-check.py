#!/usr/bin/env python3
"""Hands-on check of Ctrl+C in JiaWriter's real interface: a pseudo-terminal and a local mock of the model API
that streams slowly, so a press lands in the middle of a reply (nothing leaves 127.0.0.1, the key is a dummy).

Ctrl+C must interrupt a reply at the first press, clear typed text, show how to leave on an empty input, and
exit at the second press. Prints one line per check and exits 1 when any fails.
Usage: python3 -I scripts/writer-ctrlc-check.py [--debug] [program]
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
# Ctrl+C as a terminal sends it in raw mode.
CTRL_C = b"\x03"
# Set when the client drops the slow stream.
dropped = threading.Event()


class Slow(http.server.BaseHTTPRequestHandler):
    """A Chat Completions stream of one word every 200 ms, for a minute."""

    def do_POST(self):
        """Stream until the client goes away."""
        self.rfile.read(int(self.headers.get("content-length", 0)))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        try:
            for _ in range(300):
                chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": "慢"}, "finish_reason": None}]}
                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(0.2)
        except OSError:
            dropped.set()

    def log_message(self, *_args):
        """Silence."""


def read_until(fd, wanted, seconds):
    """Terminal text until `wanted` appears or the time is up."""
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


def exited(pid, seconds):
    """True when the child ended within `seconds`."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True
        if done:
            return True
        time.sleep(0.1)
    return False


def main():
    """Run the steps and print the results."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="jw-ctrlc-")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD"))}
    env.update(
        HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), TERM="xterm-256color", COLUMNS="120", LINES="40",
        JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY="sk-dummy-ctrlc-check", JW_MODEL="mock",
        JW_API="openai-completions", JW_EFFORT="off",
    )
    program = [a for a in sys.argv[1:] if a != "--debug"]
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
    finished = False
    try:
        read_until(fd, "命令", 20)
        # One press interrupts a reply in progress.
        os.write(fd, "写点东西".encode("utf-8"))
        time.sleep(0.5)
        os.write(fd, b"\r")
        read_until(fd, "慢慢", 15)
        start = time.monotonic()
        os.write(fd, CTRL_C)
        check("回复中按一次就中断", dropped.wait(3))
        check(f"中断用时 {time.monotonic() - start:.1f} 秒，不超过 2 秒", time.monotonic() - start <= 2)
        time.sleep(0.5)
        check("中断后程序还在", not exited(pid, 0.5))
        time.sleep(2.2)
        # Text is cleared; the program stays.
        os.write(fd, "一段草稿".encode("utf-8"))
        time.sleep(0.5)
        read_until(fd, "", 0.5)
        os.write(fd, CTRL_C)
        screen = read_until(fd, "再按一次", 3)
        check("第一次清空输入并提示退出方法", "再按一次" in screen)
        time.sleep(2.3)
        check("超过 2 秒不算第二次", not exited(pid, 0.2))
        # Empty input: a hint, then out, with a person's pause in between.
        os.write(fd, CTRL_C)
        # The same hint may already stand on the screen, so nothing need be redrawn.
        read_until(fd, "", 1)
        check("空输入第一次不退出", not exited(pid, 0.1))
        os.write(fd, CTRL_C)
        finished = exited(pid, 6)
        check("间隔 1 秒的第二次能退出", finished)
    finally:
        if not finished:
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

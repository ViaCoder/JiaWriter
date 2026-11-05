#!/usr/bin/env python3
"""Hands-on check of copy on select in JiaWriter's real interface: a pseudo-terminal, a local mock of the model and
an X server of its own (Xvfb), so the desktop's clipboard is not touched and no key or real model is used.

The mouse drags over a line of the reply, as a terminal reports it, and another process reads the X clipboard.
Needs Xvfb and the prebuilt X11 helper; without them the check says so and passes as skipped. Prints one line per check and exits 1 when any fails.
Usage: python3 -I scripts/writer-copy-check.py [program]
"""

# Mock server, pseudo-terminal, terminal size, process control and timing.
import fcntl
import http.server
import json
import os
import platform
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import threading
import time

# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ANSI escape sequences.
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
# The line the reply repeats, so that a row in the middle of the screen holds it.
LINE = "可以复制的这一行文字"
# Terminal size.
ROWS, COLUMNS = 40, 120
# The X display this check starts.
DISPLAY = 75
# The separate X client that reads the clipboard back.
ARCH = "arm64" if platform.machine() in ("aarch64", "arm64") else "x64"
READER = os.path.join(ROOT, "packages", "tui", "native", "linux", "prebuilds", f"linux-{ARCH}", "linux-platform-x11.node")


class Model(http.server.BaseHTTPRequestHandler):
    """One short Chat Completions stream: the same line many times."""

    def do_POST(self):
        """Reply at once."""
        self.rfile.read(int(self.headers.get("content-length", 0)))
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        text = "\n\n".join([LINE] * 40)
        chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": text}}]}
        end = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
        body = f"data: {json.dumps(chunk, ensure_ascii=False)}\n\ndata: {json.dumps(end)}\n\ndata: [DONE]\n\n"
        self.wfile.write(body.encode("utf-8"))

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


def clipboard(env):
    """The X clipboard as another process reads it, through the native helper."""
    script = f"require({json.dumps(READER)}).getText().then((t) => process.stdout.write(String(t)))"
    done = subprocess.run(["node", "-e", script], env=env, capture_output=True, timeout=15)
    return done.stdout.decode("utf-8", "replace")


def main():
    """Run the steps and print the results."""
    xvfb = shutil.which("Xvfb")
    if not xvfb or not os.path.exists(READER):
        print("SKIP  this check needs Xvfb and the prebuilt X11 helper")
        return 0
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="jw-copy-")
    display = subprocess.Popen([xvfb, f":{DISPLAY}", "-ac", "-nolisten", "tcp"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Helpers such as xclip are hidden, so the path under test is the one a bare desktop takes.
    bare = os.path.join(tmp, "bin")
    os.mkdir(bare)
    node = shutil.which("node")
    os.symlink(node, os.path.join(bare, "node"))
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD", "WAYLAND", "XAUTH"))}
    env.update(
        HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), TERM="xterm-256color", COLUMNS=str(COLUMNS), LINES=str(ROWS),
        JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY="sk-dummy-copy-check", JW_MODEL="mock-model",
        JW_API="openai-completions", JW_EFFORT="off", DISPLAY=f":{DISPLAY}", PATH=bare,
    )
    program = sys.argv[1:]
    if program:
        program[0] = os.path.abspath(program[0])
    else:
        coding = os.path.join(ROOT, "packages", "coding-agent")
        program = ["node", "--import", "file://" + os.path.join(coding, "src", "experimental", "source-resolver.ts"), os.path.join(coding, "src", "cli.ts")]
    for _ in range(50):
        if os.path.exists(f"/tmp/.X11-unix/X{DISPLAY}"):
            break
        time.sleep(0.1)
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(tmp)
        os.execvpe(program[0], program, env)
    # The terminal's size, as the program asks for it.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLUMNS, 0, 0))
    os.set_blocking(fd, False)
    results = []
    check = lambda name, ok: results.append((name, bool(ok)))
    try:
        read_until(fd, "命令", 20)
        os.write(fd, "写一行".encode("utf-8"))
        read_until(fd, "", 0.5)
        os.write(fd, b"\r")
        read_until(fd, LINE, 20)
        read_until(fd, "", 2)
        # Press, drag and release on one row, in the terminal's mouse report form (columns count from 1).
        row = ROWS // 2 - ROWS // 2 % 2
        found = ""
        for try_row in (row, row + 1):
            os.write(fd, f"\x1b[<0;4;{try_row}M".encode())
            read_until(fd, "", 0.2)
            os.write(fd, f"\x1b[<32;16;{try_row}M".encode())
            read_until(fd, "", 0.2)
            os.write(fd, f"\x1b[<0;16;{try_row}m".encode())
            screen = read_until(fd, "已复制", 2)
            found = clipboard(env)
            if found:
                break
        check("拖选后提示已复制", "已复制" in screen)
        check("另一个进程读到选中的文字", any(part in found for part in ("复制的", "以复制", "的这一")))
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (OSError, ChildProcessError):
            pass
        display.terminate()
        display.wait(5)
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    for name, ok in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    failed = sum(1 for r in results if not r[1])
    print(f"{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

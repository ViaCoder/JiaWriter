#!/usr/bin/env python3
"""Hands-on check of going back in JiaWriter's real interface: a pseudo-terminal, the real tools and files,
and a local mock of the model API (nothing leaves 127.0.0.1, the key is a dummy, HOME is a throwaway folder).

A first message creates a draft, a second one edits it, then /rewind goes back with the conversation and the
files. The check reads the draft, the exported .docx and the screen. Prints one line per check, exits 1 on failure.
Usage: python3 -I scripts/writer-rewind-check.py [--debug] [program]
  program: a built jiawriter executable (default: the source tree through node)
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
import zipfile

# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ANSI escape sequences.
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")


def tool_call(name, args):
    """A Chat Completions stream chunk that calls one tool."""
    # The arguments arrive as a JSON string.
    call = {"index": 0, "id": f"c{time.time_ns()}", "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}
    return {"tool_calls": [call]}, "tool_calls"


def answer(messages):
    """What the fake model says next, from the last message of the request."""
    # The last message's text.
    last = messages[-1]
    text = json.dumps(last.get("content", ""), ensure_ascii=False)
    # After a tool result: a short reply.
    if last.get("role") == "tool":
        return {"content": "完成了"}, "stop"
    # The two user messages of the check.
    if "写稿" in text:
        return tool_call("write", {"path": "稿.md", "content": "# 标题\n\n第一版正文。\n"})
    if "改稿" in text:
        return tool_call("edit", {"path": "稿.md", "edits": [{"oldText": "第一版正文。", "newText": "第二版正文。"}]})
    return {"content": "好的"}, "stop"


class Mock(http.server.BaseHTTPRequestHandler):
    """A streaming Chat Completions endpoint."""

    def do_POST(self):
        """Answer one request as an event stream."""
        # The request.
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        delta, finish = answer(body.get("messages") or [{}])
        # The reply in two chunks.
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for d, f in ((delta, None), ({}, finish)):
            chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": d, "finish_reason": f}]}
            self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *_args):
        """Silence."""


def read_until(fd, wanted, seconds):
    """Terminal text until `wanted` appears or the time is up."""
    # Collected text.
    out = b""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], 0.3)
        if ready:
            try:
                out += os.read(fd, 65536)
            except OSError:
                break
        text = ANSI.sub("", out.decode("utf-8", "replace"))
        if wanted and wanted in text:
            return text
    return ANSI.sub("", out.decode("utf-8", "replace"))


def send(fd, text):
    """Type text and press Enter, with a pause like a person."""
    # The characters, then Enter.
    os.write(fd, text.encode("utf-8"))
    time.sleep(0.6)
    os.write(fd, b"\r")


def docx_text(path):
    """The text of a .docx, or an empty string when there is none."""
    # document.xml without its tags.
    if not os.path.exists(path):
        return ""
    with zipfile.ZipFile(path) as z:
        return re.sub(r"<[^>]+>", "", z.read("word/document.xml").decode("utf-8"))


def main():
    """Run the steps and print the results."""
    # The mock on a free port.
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # Throwaway home and working folder; the key is a dummy for the mock.
    tmp = tempfile.mkdtemp(prefix="jw-rewind-")
    work = os.path.join(tmp, "work")
    os.mkdir(work)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD"))}
    env.update(
        HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), TERM="xterm-256color", COLUMNS="120", LINES="40",
        JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY="sk-dummy-rewind-check", JW_MODEL="mock",
        JW_API="openai-completions", JW_EFFORT="off",
    )
    # The program.
    program = [a for a in sys.argv[1:] if a != "--debug"]
    if program:
        program[0] = os.path.abspath(program[0])
    else:
        coding = os.path.join(ROOT, "packages", "coding-agent")
        resolver = "file://" + os.path.join(coding, "src", "experimental", "source-resolver.ts")
        program = ["node", "--import", resolver, os.path.join(coding, "src", "cli.ts")]
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work)
        os.execvpe(program[0], program, env)
    os.set_blocking(fd, False)
    draft = os.path.join(work, "稿.md")
    read = lambda: open(draft, encoding="utf-8").read() if os.path.exists(draft) else ""
    results = []
    check = lambda name, ok: results.append((name, bool(ok)))
    debug = "--debug" in sys.argv
    try:
        read_until(fd, "命令", 20)
        # The draft, then the edit.
        send(fd, "写稿")
        read_until(fd, "完成了", 20)
        time.sleep(2)
        check("第一轮写出稿件", "第一版" in read())
        send(fd, "改稿")
        read_until(fd, "第二版", 20)
        time.sleep(3)
        check("第二轮改了稿件", "第二版" in read())
        check("改后的 docx 是第二版", "第二版" in docx_text(os.path.join(work, "稿.docx")))
        # Effort on a model without reasoning: the nearest level, in words.
        send(fd, "/effort high")
        os.write(fd, b"\r")
        screen = read_until(fd, "最接近", 6)
        check("/effort 说明实际生效的档位", "最接近" in screen)
        # Go back to before the second message, with the files.
        send(fd, "/rewind")
        screen = read_until(fd, "回退到哪条消息之前", 6)
        check("/rewind 列出消息", "2. 改稿" in screen and "1. 写稿" in screen)
        if debug:
            print(screen[-500:])
        os.write(fd, b"\r")
        screen = read_until(fd, "恢复 1 个文件", 6)
        check("/rewind 问退回什么，写明文件数", "恢复 1 个文件" in screen)
        os.write(fd, b"\r")
        screen = read_until(fd, "已回退", 8)
        if debug:
            print(screen[-700:])
        check("/rewind 报告已回退", "已回退" in screen)
        time.sleep(1)
        check("稿件回到第一版", "第一版" in read() and "第二版" not in read())
        check("docx 也回到第一版", "第一版" in docx_text(os.path.join(work, "稿.docx")))
        check("原消息回到输入框", "改稿" in screen)
    finally:
        # Stop the interface and clean up.
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (OSError, ChildProcessError):
            pass
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    # Report.
    for name, ok in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    failed = sum(1 for r in results if not r[1])
    print(f"{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

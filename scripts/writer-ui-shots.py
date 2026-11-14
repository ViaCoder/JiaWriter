#!/usr/bin/env python3
"""Pictures of JiaWriter's interface at the moments a user sees most: the start, a question being worked on (a tool
call under way), the finished reply with a written file, and the configuration dialog. A pseudo-terminal of 120 x 40
runs the program against a local mock of the model (nothing leaves 127.0.0.1, the key is a dummy); the bytes the
program wrote up to each moment are played through scripts/screen-render.mjs and drawn with scripts/screen-png.py.
Usage: python3 -I scripts/writer-ui-shots.py <out dir> [program]   (default program: the source launcher)
Writes <out dir>/<n>-<name>.png, the matching .txt (the screen's lines) and .json (the cells with their colours), and
prints one line per picture.
"""

# Mock server, pseudo-terminal, process control, timing and the renderers.
import http.server
import json
import os
import pty
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ANSI escape sequences, for looking at the text of what arrived.
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
# Terminal size.
COLS, ROWS = 120, 40

# The reply the mock gives after reading the folder: a heading, a list and a table, as a real reply has.
REPLY = (
    "文件夹里有三份材料，都是社区议事会的记录。\n\n"
    "## 材料情况\n\n"
    "- 第1次会议（2026年8月12日）：绿化，补种行道树\n"
    "- 第3次会议（2026年10月15日）：停车，增设夜间临时停车位40个\n"
    "- 第4次会议（2026年11月5日）：停车，试行错时共享停车\n\n"
    "| 会议 | 日期 | 议题 |\n|---|---|---|\n| 第1次 | 2026年8月12日 | 绿化 |\n| 第3次 | 2026年10月15日 | 停车 |\n| 第4次 | 2026年11月5日 | 停车 |\n\n"
    "停车问题两次上会，是居民最关心的事。下面把说明写进 说明.md。"
)
# The file the mock writes.
NOTE = (
    "# 社区议事会材料说明\n\n"
    "本文件夹存放2026年8月至11月社区议事会的三份会议纪要。三次会议中，停车问题两次列为议题：10月15日第3次会议决定增设夜间临时停车位40个，"
    "11月5日第4次会议决定试行错时共享停车，首批签约单位3家。8月12日第1次会议的议题是绿化，决定补种行道树。\n\n"
    "停车位紧张是居民反映最集中的问题，两次会议的措施都针对夜间停车，白天停车的办法尚未议定。下一步可以在收集供暖意见的同时，"
    "一并征求居民对白天错时停车的意见。\n"
)


def event(delta, finish=None):
    """One stream event."""
    chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")


def stream_text(handler, text, pause=0.03):
    """Text, eight characters at a time."""
    for i in range(0, len(text), 8):
        handler.wfile.write(event({"content": text[i : i + 8]}))
        handler.wfile.flush()
        time.sleep(pause)


def stream_call(handler, name, args, pause=0.02):
    """A tool call whose arguments arrive in pieces, then the end of the reply."""
    text = json.dumps(args, ensure_ascii=False)
    head = {"tool_calls": [{"index": 0, "id": f"call_{name}", "type": "function", "function": {"name": name, "arguments": ""}}]}
    handler.wfile.write(event(head))
    handler.wfile.flush()
    for i in range(0, len(text), 16):
        handler.wfile.write(event({"tool_calls": [{"index": 0, "function": {"arguments": text[i : i + 16]}}]}))
        handler.wfile.flush()
        time.sleep(pause)
    handler.wfile.write(event({}, "tool_calls") + b"data: [DONE]\n\n")


class Model(http.server.BaseHTTPRequestHandler):
    """First a look at the folder (bash), then the reply and the file (write), then a closing line."""

    def do_POST(self):
        """Decide by how many tool results the conversation holds."""
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        done = sum(1 for m in body["messages"] if m.get("role") == "tool")
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        if done == 0:
            stream_text(self, "我先看一下文件夹里有什么。")
            # A pause with the call under way, for the picture of work in progress.
            time.sleep(4)
            stream_call(self, "bash", {"command": "ls -la 纪要 && cat 纪要/*.md"})
        elif done == 1:
            # A pause with the call's result on the screen, for the picture of a tool row.
            time.sleep(5)
            stream_text(self, REPLY)
            stream_call(self, "write", {"path": "说明.md", "content": NOTE})
        else:
            stream_text(self, "说明.md 已写好，312 字；检查没有发现问题。")
            self.wfile.write(event({}, "stop") + b"data: [DONE]\n\n")

    def log_message(self, *_args):
        """Silence."""


class Capture:
    """Everything the program wrote so far, read in the background."""

    def __init__(self, fd):
        self.fd, self.data, self.lock, self.alive = fd, bytearray(), threading.Lock(), True
        threading.Thread(target=self.pump, daemon=True).start()

    def pump(self):
        """Read until the terminal closes."""
        while self.alive:
            ready, _, _ = select.select([self.fd], [], [], 0.05)
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return
            with self.lock:
                self.data += chunk

    def text(self):
        """The plain text so far."""
        with self.lock:
            return ANSI.sub("", bytes(self.data).decode("utf-8", "replace"))

    def wait(self, wanted, seconds):
        """Whether `wanted` appears within the time."""
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if wanted in self.text().replace(" ", ""):
                return True
            time.sleep(0.1)
        return False

    def snapshot(self):
        """A copy of the bytes so far."""
        with self.lock:
            return bytes(self.data)


def picture(raw, out, name):
    """The screen those bytes leave, as a picture and as text; returns the text's lines."""
    base = os.path.join(out, name)
    with open(f"{base}.bin", "wb") as f:
        f.write(raw)
    env = dict(os.environ, JW_SCREEN_CELLS="1")
    cells = subprocess.run(["node", os.path.join(ROOT, "scripts", "screen-render.mjs"), f"{base}.bin", str(COLS), str(ROWS)],
                           capture_output=True, text=True, encoding="utf-8", env=env, timeout=120)
    if cells.returncode != 0:
        print(cells.stderr[-800:], file=sys.stderr)
        return []
    with open(f"{base}.json", "w", encoding="utf-8") as f:
        f.write(cells.stdout)
    lines = json.loads(cells.stdout)["lines"]
    with open(f"{base}.txt", "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    subprocess.run(["python3", "-I", os.path.join(ROOT, "scripts", "screen-png.py"), f"{base}.json", f"{base}.png", "dark"],
                   check=True, timeout=120)
    os.remove(f"{base}.bin")
    return lines


def main():
    """Run the scene and take the pictures."""
    out = os.path.abspath(sys.argv[1])
    os.makedirs(out, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="jw-shots-")
    # The folder the question is about.
    os.makedirs(os.path.join(tmp, "纪要"))
    for n, date, topic, point in [("第1次", "2026年8月12日", "绿化", "补种行道树。"), ("第3次", "2026年10月15日", "停车", "增设夜间临时停车位40个。"),
                                  ("第4次", "2026年11月5日", "停车", "试行错时共享停车，签约单位3家。")]:
        with open(os.path.join(tmp, "纪要", f"{n}会议.md"), "w", encoding="utf-8") as f:
            f.write(f"# {n}居民议事会\n\n日期：{date}\n议题：{topic}问题\n要点：{point}\n")
    # The dark theme by name: the system theme takes its colours from the terminal's answers, which a pseudo-terminal
    # never gives, and would stay grey.
    os.makedirs(os.path.join(tmp, "agent"))
    with open(os.path.join(tmp, "agent", "settings.json"), "w", encoding="utf-8") as f:
        json.dump({"theme": "dark"}, f)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD"))}
    env.update(
        HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), TERM="xterm-256color", COLORTERM="truecolor", COLUMNS=str(COLS), LINES=str(ROWS),
        JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY="sk-dummy-ui-shots", JW_MODEL="mock-model",
        JW_API="openai-completions", JW_EFFORT="off", JW_PERMISSION="bypass",
    )
    program = sys.argv[2:]
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
    cap = Capture(fd)
    shots = []
    try:
        cap.wait("命令", 20)
        time.sleep(1.5)
        shots.append(("1-start", picture(cap.snapshot(), out, "1-start")))
        # The question, typed and sent.
        os.write(fd, "看看 纪要 文件夹里有什么，然后写一份三百字左右的材料说明到 说明.md".encode("utf-8"))
        time.sleep(0.8)
        shots.append(("2-typed", picture(cap.snapshot(), out, "2-typed")))
        os.write(fd, b"\r")
        # The first text has arrived and the tool call is still under way.
        cap.wait("文件夹里有什么", 20)
        time.sleep(2.5)
        shots.append(("3-working", picture(cap.snapshot(), out, "3-working")))
        # The tool call and its result on the screen.
        cap.wait("ls-la", 20)
        time.sleep(1.5)
        shots.append(("3b-tool", picture(cap.snapshot(), out, "3b-tool")))
        # The reply with its table, while the file is being written.
        cap.wait("下面把说明写进", 40)
        time.sleep(1.0)
        shots.append(("4-reply", picture(cap.snapshot(), out, "4-reply")))
        # Done.
        cap.wait("已写好", 40)
        time.sleep(2.5)
        shots.append(("5-done", picture(cap.snapshot(), out, "5-done")))
        # The configuration dialog.
        os.write(fd, "/jw".encode("utf-8"))
        time.sleep(0.5)
        os.write(fd, b"\r")
        time.sleep(2.5)
        shots.append(("6-config", picture(cap.snapshot(), out, "6-config")))
        os.write(fd, b"q")
        time.sleep(1)
    finally:
        cap.alive = False
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except (OSError, ChildProcessError):
            pass
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    for name, lines in shots:
        print(f"{name}: {len([l for l in lines if l.strip()])} lines with text -> {os.path.join(out, name)}.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())

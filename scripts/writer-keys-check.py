#!/usr/bin/env python3
"""
The keys of Claude Code in a real terminal (2026-11-09: "The operation should be consistent with Claude Code ...
ensure that the key bindings for macOS are correctly implemented"): Shift+Tab cycles the work mode, ? shows the
shortcut list, Ctrl+O the detailed view, Ctrl+R searches the history, Esc Esc clears the input into the history,
Option+Enter adds a line, Ctrl+P recalls the last input, Ctrl+T hides the task list, Ctrl+B sends a running
command to the background and /tasks lists it; the whole of a long
conversation can be scrolled back to its first message, also after the session is continued with --continue. A fake model answers on a local
port; nothing leaves the machine.

Usage: python3 -I scripts/writer-keys-check.py [--debug DIR] [program]   (default: the source tree; --debug keeps the
screen of each check in DIR)
"""

import http.server
import json
import os
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import fcntl
import threading
import time

# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The keys as a terminal sends them.
SHIFT_TAB = b"\x1b[Z"
CTRL_O = b"\x0f"
CTRL_R = b"\x12"
CTRL_P = b"\x10"
CTRL_T = b"\x14"
CTRL_B = b"\x02"
ESC = b"\x1b"
OPTION_ENTER = b"\x1b\r"
PAGE_UP = b"\x1b[5~"
# Everything the terminal received: the screen is played from it.
RAW = bytearray()


def answer(messages):
    """The fake model: write the draft for 写稿, a short reply after a tool result, else a word."""
    last = messages[-1]
    if last.get("role") == "tool":
        return {"content": "完成了"}, "stop"
    # The messages since the last reply: the user's and the notes added after it.
    since = len(messages)
    while since > 0 and messages[since - 1].get("role") != "assistant":
        since -= 1
    text = json.dumps([m.get("content", "") for m in messages[since:]], ensure_ascii=False)
    if "跑命令" in text:
        call = {"index": 0, "id": f"c{time.time_ns()}", "type": "function",
                "function": {"name": "bash", "arguments": json.dumps({"command": "echo bg-start; sleep 4; echo bg-end"})}}
        return {"tool_calls": [call]}, "tool_calls"
    if "写稿" in text:
        call = {"index": 0, "id": f"c{time.time_ns()}", "type": "function",
                "function": {"name": "write", "arguments": json.dumps({"path": "稿.md", "content": "# 标题\n\n正文。\n"}, ensure_ascii=False)}}
        return {"tool_calls": [call]}, "tool_calls"
    return {"content": "好的"}, "stop"


class Mock(http.server.BaseHTTPRequestHandler):
    """A streaming Chat Completions endpoint with token counts."""

    def do_POST(self):
        """One reply as an event stream."""
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        delta, finish = answer(body.get("messages") or [{}])
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        usage = {"prompt_tokens": 2000, "completion_tokens": 72, "total_tokens": 2072}
        for d, f in ((delta, None), ({}, finish)):
            chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": d, "finish_reason": f}]}
            if f:
                chunk["usage"] = usage
            self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *_args):
        """Silence."""


def pump(fd, seconds):
    """Read the terminal for a while, so the program never blocks on a full buffer."""
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                RAW.extend(os.read(fd, 65536))
            except OSError:
                return


def screen(columns=120, rows=40):
    """The lines the terminal shows now, played through a headless xterm (scripts/screen-render.mjs)."""
    folder = tempfile.mkdtemp(prefix="jw-keys-")
    raw = os.path.join(folder, "raw.bin")
    with open(raw, "wb") as f:
        f.write(bytes(RAW))
    shown = subprocess.run(["node", os.path.join(ROOT, "scripts", "screen-render.mjs"), raw, str(columns), str(rows)],
                           capture_output=True, text=True, encoding="utf-8", check=False)
    shutil.rmtree(folder, ignore_errors=True)
    return "\n".join(json.loads(shown.stdout or '{"lines": []}')["lines"])


def wait_screen(fd, wanted, seconds):
    """The screen once it shows `wanted`, or as it is when the time is up."""
    end = time.monotonic() + seconds
    shown = ""
    while time.monotonic() < end:
        pump(fd, 0.4)
        shown = screen()
        if re.search(wanted, shown):
            return shown
    return shown


def press(fd, data, pause=0.5):
    """Send keys like a person."""
    os.write(fd, data)
    pump(fd, pause)


def main():
    """Run the steps and print the results."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="jw-keys-")
    work = os.path.join(tmp, "work")
    os.mkdir(work)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD"))}
    env.update(
        HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), TERM="xterm-256color", COLUMNS="120", LINES="40",
        JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY="sk-dummy-keys-check", JW_MODEL="mock",
        JW_API="openai-completions", JW_EFFORT="off",
    )
    args = sys.argv[1:]
    debug = ""
    if args[:1] == ["--debug"]:
        debug, args = args[1], args[2:]
        os.makedirs(debug, exist_ok=True)
    program = args
    if program:
        program[0] = os.path.abspath(program[0])
    else:
        coding = os.path.join(ROOT, "packages", "coding-agent")
        resolver = "file://" + os.path.join(coding, "src", "experimental", "source-resolver.ts")
        program = ["node", "--import", resolver, os.path.join(coding, "src", "cli.ts")]
    def start(extra):
        """Start the program in the working folder; the screen is played from this start on."""
        RAW.clear()
        child, terminal = pty.fork()
        if child == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            os.chdir(work)
            os.execvpe(program[0], program + extra, env)
        os.set_blocking(terminal, False)
        return child, terminal

    def scrolled_to(wanted, pages=40):
        """Page up until `wanted` shows, or the pages run out."""
        for _ in range(pages):
            if wanted in screen():
                return True
            press(fd, PAGE_UP, 0.3)
        return wanted in screen()

    pid, fd = start([])
    results = []
    def check(name, ok):
        """Record a result, with the screen when debugging."""
        results.append((name, bool(ok)))
        if debug:
            with open(os.path.join(debug, f"{len(results):02d}.txt"), "w", encoding="utf-8") as f:
                f.write(f"{name}: {bool(ok)}\n{screen()}\n")
    try:
        shown = wait_screen(fd, r"Shift\+Tab 切换", 30)
        check("状态栏写出工作模式和切换键", re.search(r"(自动|手动确认|全部放行)（Shift\+Tab 切换）", shown))
        check("状态栏默认不显示 token 统计", "↑" not in shown.split("\n")[-1])
        # Shift+Tab: auto → plan → manual → auto. The status line is drawn before keys are read: a press at once was
        # lost on a loaded machine (2026-11-10, the modes came one step late), so the program settles first.
        pump(fd, 2)
        modes = []
        # Each press waits for the mode it should reach: the label is on screen before the redraw too (2026-11-10: a
        # loaded machine read the old mode once).
        for expected in ("规划模式", "手动确认", "自动"):
            press(fd, SHIFT_TAB)
            modes.append(re.findall(r"(自动|手动确认|规划模式|全部放行)（Shift\+Tab 切换）", wait_screen(fd, rf"{expected}（Shift\+Tab 切换）", 4)))
        check("Shift+Tab 依次切换 规划模式 → 手动确认 → 自动", [m[-1] if m else "" for m in modes] == ["规划模式", "手动确认", "自动"])
        # ? on an empty input: the shortcut list.
        press(fd, b"?", 1)
        shown = wait_screen(fd, "补全路径或接受建议", 6)
        check("输入框为空时按 ? 显示快捷键列表", "补全路径或接受建议" in shown and "翻动对话" in shown)
        # A turn, then the detailed view.
        press(fd, "写稿".encode("utf-8"), 0.6)
        press(fd, b"\r")
        # Auto mode asks once per folder before the first write; the number key answers.
        shown = wait_screen(fd, "允许在工作目录里写入", 20)
        check("自动模式第一次写入前询问：是、本会话不再问、否并说明，带编号",
              "1. 是" in shown and "2. 是，本会话" in shown and "3. 否，告诉它怎么做" in shown)
        press(fd, b"1", 1)
        shown = wait_screen(fd, "完成了", 30)
        check("写稿一轮完成", "完成了" in shown and os.path.exists(os.path.join(work, "稿.md")))
        check("工具调用用中文名称和相对路径", "写入 稿.md" in shown)
        press(fd, CTRL_O, 1)
        shown = wait_screen(fd, r"\d\d:\d\d:\d\d · mock", 6)
        check("Ctrl+O 打开详细模式：每条回复有时间和模型", re.search(r"\d\d:\d\d:\d\d · mock", shown))
        check("详细模式里状态栏有 token 统计", "↑" in shown)
        press(fd, CTRL_O, 1)
        shown = wait_screen(fd, "详细模式：关", 4)
        check("再按 Ctrl+O 关闭详细模式", "详细模式：关" in shown and not re.search(r"\d\d:\d\d:\d\d · mock", shown))
        # Ctrl+R: the history search puts the entry in the input.
        press(fd, CTRL_R, 1)
        shown = wait_screen(fd, "搜索输入历史", 4)
        check("Ctrl+R 打开输入历史搜索", "搜索输入历史" in shown and "写稿" in shown)
        press(fd, "写".encode("utf-8"))
        press(fd, b"\r", 1)
        shown = wait_screen(fd, "写稿", 4)
        check("选中的历史回到输入框", shown.count("写稿") >= 2 and "搜索输入历史" not in shown)
        # Esc Esc clears the input; Ctrl+P brings back the last input.
        press(fd, ESC, 0.15)
        press(fd, ESC, 1)
        before = screen()
        press(fd, CTRL_P, 1)
        after = screen()
        check("Esc Esc 清空输入，Ctrl+P 取回上一条输入", after.count("写稿") > before.count("写稿"))
        press(fd, ESC, 0.15)
        press(fd, ESC, 1)
        # Option+Enter: a new line, not a message.
        press(fd, b"first-line", 0.3)
        press(fd, OPTION_ENTER, 0.3)
        press(fd, b"second-line", 1)
        shown = screen()
        lines = shown.split("\n")
        at = [i for i, line in enumerate(lines) if "first-line" in line]
        check("Option+Enter 换行而不发送", at and "second-line" in lines[at[-1] + 1] and "second-line" not in lines[at[-1]])
        press(fd, ESC, 0.15)
        press(fd, ESC, 1)
        # Ctrl+T: the task list hides and shows.
        press(fd, CTRL_T, 1)
        shown = wait_screen(fd, "任务清单：", 4)
        check("Ctrl+T 显示或隐藏任务清单", "任务清单：隐藏" in shown)
        # Ctrl+B: the command goes on in the background and the reply comes at once.
        press(fd, "跑命令".encode("utf-8"), 0.6)
        press(fd, b"\r")
        shown = wait_screen(fd, "允许执行这条命令", 15)
        if "允许执行这条命令" in shown:
            press(fd, b"1", 0.3)
        wait_screen(fd, "bg-start", 8)
        sent = time.monotonic()
        press(fd, CTRL_B, 0.5)
        shown = wait_screen(fd, "已转到后台：任务 1", 4)
        check("Ctrl+B 把正在运行的命令转到后台", "已转到后台：任务 1" in shown)
        check("屏幕上写的是中文说明，不是给模型的英文", "已转到后台，任务 1，输出写入" in wait_screen(fd, "输出写入", 4) and "Moved to the background" not in screen())
        shown = wait_screen(fd, r"完成了[\s\S]*完成了", 6)
        check("转到后台后对话马上继续（不等命令结束）", time.monotonic() - sent < 3.5 and shown.count("完成了") >= 2)
        check("状态栏显示后台任务数", "后台 1" in shown)
        shown = wait_screen(fd, "后台任务 1 已结束", 10)
        check("后台命令结束时屏幕提示", "后台任务 1 已结束（退出码 0）" in shown)
        press(fd, "/tasks".encode("utf-8"), 0.4)
        press(fd, b"\r", 1)
        shown = wait_screen(fd, "任务 1｜已结束", 4)
        check("/tasks 列出后台命令和结果", "任务 1｜已结束（退出码 0）" in shown)
        # A long conversation: twenty more turns, then back to the first message.
        for i in range(1, 21):
            press(fd, f"第{i}条消息".encode("utf-8"), 0.3)
            press(fd, b"\r", 1.2)
        wait_screen(fd, "第20条消息", 10)
        check("长对话往上翻能看到第一条消息", scrolled_to("写稿"))
        # Continued in a new run: the whole conversation is there again.
        os.kill(pid, 9)
        os.waitpid(pid, 0)
        pid, fd = start(["--continue"])
        shown = wait_screen(fd, "第20条消息", 30)
        check("--continue 继续会话后显示之前的对话", "第20条消息" in shown)
        check("继续会话后往上翻能看到第一条消息", scrolled_to("写稿"))
    finally:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
        server.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    for name, ok in results:
        print(("PASS  " if ok else "FAIL  ") + name)
    passed = sum(1 for _, ok in results if ok)
    print(f"{passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()

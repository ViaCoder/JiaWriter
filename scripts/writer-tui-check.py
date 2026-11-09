#!/usr/bin/env python3
"""Hands-on check of JiaWriter's interactive interface in a pseudo-terminal (no tmux needed).

Starts the source build (pi-test.sh --no-env) with a throwaway HOME and agent folder, types
/jw, /skills, /rewind, /effort, /lang en, /skills and /jw, and looks for the expected Chinese and English text in
the screen output (ANSI codes removed). Nothing outside the temp folder is read or written, no
key is set, and no model is called. Prints one line per check and exits 1 when any check fails.
Usage: python3 -I scripts/writer-tui-check.py [--debug] [program]
  program: a built jiawriter executable (default: the source build through pi-test.sh)
"""

# Pseudo-terminal, process control and timing.
import os
import pty
import re
import select
import shutil
import signal
import sys
import tempfile
import time

# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ANSI escape sequences (CSI, OSC and single-character escapes).
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")


def read_for(fd, seconds):
    """All output the terminal produces within `seconds`, ANSI codes removed."""
    # Collected bytes.
    out = b""
    # Until the deadline.
    end = time.monotonic() + seconds
    while True:
        # Time left.
        left = end - time.monotonic()
        if left <= 0:
            break
        # Wait for output.
        ready, _, _ = select.select([fd], [], [], left)
        if not ready:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    # Plain text.
    return ANSI.sub("", out.decode("utf-8", "replace"))


def type_line(fd, text):
    """Type text, then Enter, with a short pause like a person. A command with an argument gets a
    second Enter: the first one accepts the argument completion, the second submits."""
    # Characters, then the pause, then Enter.
    os.write(fd, text.encode("utf-8"))
    time.sleep(0.6)
    os.write(fd, b"\r")
    # Argument completion open: submit with a second Enter (an empty line does nothing).
    if " " in text:
        time.sleep(0.6)
        os.write(fd, b"\r")


def stop(pid):
    """End the child: SIGTERM, wait up to 5 seconds, then SIGKILL; never blocks longer."""
    # Ask first.
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return
    # Wait in short steps.
    end = time.monotonic() + 5
    while time.monotonic() < end:
        try:
            done, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return
        if done:
            return
        time.sleep(0.2)
    # Force it.
    try:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    except (OSError, ChildProcessError):
        pass


def main():
    """Run the checks and print the results."""
    # Throwaway home and agent folder.
    tmp = tempfile.mkdtemp(prefix="wa-tui-")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_"))}
    env.update(HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), TERM="xterm-256color", COLUMNS="120", LINES="40")
    # The program to run, made absolute before the child changes folder.
    program = [a for a in sys.argv[1:] if a != "--debug"]
    if program and os.sep in program[0]:
        program[0] = os.path.abspath(program[0])
    # Start the interface in a pseudo-terminal.
    pid, fd = pty.fork()
    if pid == 0:
        # Child: the given executable, or the source launcher without provider keys.
        os.chdir(tmp)
        try:
            if program:
                os.execvpe(program[0], program, env)
            os.execvpe("bash", ["bash", os.path.join(ROOT, "pi-test.sh"), "--no-env"], env)
        except OSError as e:
            # The parent sees this on the terminal and the checks fail.
            print(f"cannot start {program[0] if program else 'pi-test.sh'}: {e}", flush=True)
            os._exit(127)
    # Terminal size.
    os.set_blocking(fd, False)
    results = []
    try:
        # Each step: what to type, how long to read, what must appear.
        steps = [
            (None, 12, ["中断", "命令", "按 "]),
            ("/jw", 3, ["JiaWriter 配置（只读", "JW_KEY", "未设置", "按任意键关闭"]),
            ("q", 2, []),
            ("/skills", 3, ["写作 skill（4 个）", "公文写作", "内置"]),
            ("\x1b", 2, []),
            ("/rewind", 3, ["还没有可以回退的消息"]),
            ("/effort", 3, ["思考强度（当前", "xhigh"]),
            ("\x1b", 2, []),
            ("/lang en", 3, ["Interface language set to English"]),
            ("/skills", 3, ["Writing skills (4)", "Deep research", "built-in"]),
            ("\x1b", 2, []),
            ("/jw", 3, ["JiaWriter configuration (read-only", "not set", "Press any key to close"]),
            ("q", 2, []),
        ]
        for keys, seconds, wanted in steps:
            # Keys: Escape and single letters are sent raw, commands with Enter.
            try:
                if keys is not None:
                    if keys.startswith("/"):
                        type_line(fd, keys)
                    else:
                        os.write(fd, keys.encode("utf-8"))
                screen = read_for(fd, seconds)
            except OSError:
                # The interface is gone (closed terminal): this and later checks fail.
                screen = ""
            # --debug: the end of each step's screen output.
            if "--debug" in sys.argv:
                print(f"--- after {keys!r}:\n{screen[-700:]}")
            for w in wanted:
                results.append((keys or "(startup)", w, w in screen))
    finally:
        # Stop the interface (SIGTERM, then SIGKILL after 5 s: a terminal UI may ignore SIGTERM) and remove the temp folder.
        stop(pid)
        shutil.rmtree(tmp, ignore_errors=True)
    # Report.
    for step, text, ok in results:
        print(f"{'PASS' if ok else 'FAIL'}  {step:<10} {text}")
    failed = sum(1 for r in results if not r[2])
    print(f"{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Hands-on check of the computer tool on the machine it runs on: the real program, a local mock model, the real pinned
driver installed by the program itself, and a real window of this system. Each action is really carried out, and the
window's own output file is the proof. Linux runs on a virtual display in a private D-Bus session; macOS and Windows
are meant for throwaway CI machines. Prints every step and exits 1 when any check fails.
Usage: python3 -I scripts/writer-computer-check.py [program]
"""

# Loading the browser check's mock model, process control and files.
import http.server
import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APPS = os.path.join(ROOT, "scripts", "computer-app")
# What is typed: the regression that matters most is Chinese arriving whole.
TEXT = "虚拟桌面文字abc"
# Seconds a window gets to appear.
WINDOW_WAIT = 12
# The longest one action may take.
ACTION_LIMIT = 8


def account_home():
    """The home directory the system records for this account, whatever HOME says."""
    # pwd exists on Unix only, so it is imported here, where only macOS comes.
    import pwd
    return pwd.getpwuid(os.getuid()).pw_dir


def load_browser_check():
    """The mock model and helpers of the browser check."""
    spec = importlib.util.spec_from_file_location("browser_check", os.path.join(ROOT, "scripts", "writer-browser-check.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def start_app(out, env, tmp):
    """This system's test window."""
    if sys.platform == "win32":
        return subprocess.Popen(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", os.path.join(APPS, "app.ps1"), out], env=env)
    if sys.platform == "darwin":
        binary = os.path.join(tmp, "testapp")
        subprocess.run(["swiftc", os.path.join(APPS, "app.swift"), "-o", binary], check=True)
        return subprocess.Popen([binary, out], env=env)
    return subprocess.Popen(["/usr/bin/python3", os.path.join(APPS, "app.py"), out], env={**env, "GTK_MODULES": "gail:atk-bridge", "NO_AT_BRIDGE": "0"}, stderr=subprocess.DEVNULL)


def pointer():
    """Where the real pointer is, on any system."""
    if sys.platform == "win32":
        import ctypes
        spot = (ctypes.c_long * 2)()
        ctypes.windll.user32.GetCursorPos(spot)
        return tuple(spot)
    if sys.platform == "darwin":
        import ctypes
        graphics = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
        graphics.CGEventCreate.restype = ctypes.c_void_p
        graphics.CGEventCreate.argtypes = [ctypes.c_void_p]

        class Point(ctypes.Structure):
            _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

        graphics.CGEventGetLocation.restype = Point
        graphics.CGEventGetLocation.argtypes = [ctypes.c_void_p]
        at = graphics.CGEventGetLocation(graphics.CGEventCreate(None))
        return (at.x, at.y)
    return subprocess.run(["xdotool", "getmouselocation"], capture_output=True, text=True).stdout


def row_of(text, label):
    """The number of the control with this name in a read."""
    found = re.search(r"\[(\d+)\][^\n\"]*\"" + re.escape(label) + "\"", text)
    return found.group(1) if found else "999"


def run_setup(b, env, command, timeout=300):
    """A /jw command of the real program, with no model involved."""
    return subprocess.run(b.program() + ["-p", command], cwd=env["HOME"], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)


def inner():
    """Everything, on this display and session."""
    b = load_browser_check()
    tmp = tempfile.mkdtemp(prefix="jw-cc-")
    model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), b.Model)
    threading.Thread(target=model.serve_forever, daemon=True).start()
    env = b.clean_env(tmp, model.server_address[1])
    env.update(JW_IMAGE="on", JW_OCR="off", USERPROFILE=tmp)
    checks = []
    # The driver, as a user gets it: fetched and checked by the program itself.
    before_requests = len(b.current[0].requests)
    run_setup(b, env, "/jw computer install")
    agent = env["JW_DIR"]
    names = {"win32": "cua-driver.exe"}
    driver = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver" if sys.platform == "darwin" else next(
        (os.path.join(folder, names.get(sys.platform, "cua-driver")) for folder, _d, files in os.walk(agent) if names.get(sys.platform, "cua-driver") in files), "")
    checks += [
        ("程序自己下载并校验了驱动", bool(driver) and os.path.exists(driver)),
        ("安装没有调用模型", len(b.current[0].requests) == before_requests),
    ]
    if not driver or not os.path.exists(driver):
        return finish(checks, model, tmp)
    if os.environ.get("JW_TCC_SEED"):
        subprocess.run([os.environ["JW_TCC_SEED"]], check=False)
    # On macOS the system starts the daemon with the account's home, and the program hands the driver that one too.
    driver_home = account_home() if sys.platform == "darwin" else env["HOME"]
    state = subprocess.run([driver, "telemetry", "status"], env={"HOME": driver_home, "USERPROFILE": tmp, "PATH": os.environ["PATH"], "SystemRoot": os.environ.get("SystemRoot", "")}, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    print(state.stdout.strip()[:200])
    checks.append(("驱动的遥测已持久关闭，不靠环境变量", "disabled" in state.stdout))
    doctor = subprocess.run([driver, "doctor"], env={**os.environ, "HOME": driver_home, "CUA_TELEMETRY": "0"}, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    print(doctor.stdout[:1500])
    out_file = os.path.join(tmp, "结果.txt")
    app = start_app(out_file, {**env, "DISPLAY": os.environ.get("DISPLAY", "")} if sys.platform == "linux" else {**os.environ}, tmp)
    time.sleep(WINDOW_WAIT if sys.platform != "linux" else 3)
    mouse_before = pointer()
    tree = {}
    def find_window(last):
        windows = b.head(last).get("data", {}).get("windows", [])
        hit = next((w for w in windows if "测试窗口" in str(w.get("title"))), {"pid": app.pid})
        tree["pid"], tree["window"] = hit.get("pid"), hit.get("window")
        return {"_tool": "computer", "action": "read", "pid": tree["pid"], **({"window": tree["window"]} if tree["window"] else {})}
    def on_row(label, **more):
        def step(_last):
            reads = [r for r in b.current[0].results if "姓名" in r]
            return {"_tool": "computer", "ref": row_of(reads[-1] if reads else "", label), **more}
        return step
    steps = [
        {"_tool": "computer", "action": "windows"},
        find_window,
        on_row("姓名", action="type", text=TEXT),
        on_row("口令", action="type", text="不该写入"),
        {"_tool": "computer", "action": "look", "reason": "确认窗口外观"},
        {"_tool": "computer", "action": "read"},
        on_row("确定", action="click"),
    ]
    started = time.monotonic()
    out, run = b.drive(steps, env, "bypass")
    took = time.monotonic() - started
    r = run.results + [""] * 8
    for i, text in enumerate(run.results):
        print(i, text[:300].replace("\n", " | "))
    time.sleep(2)
    written = open(out_file, encoding="utf-8").read() if os.path.exists(out_file) else ""
    print("应用写出：", repr(written), "整段流程", round(took, 1), "秒")
    mouse_after = pointer()
    gaps = [later - early for early, later in zip(run.times, run.times[1:])]
    h = b.head
    checks += [
        ("程序正常结束", out.returncode == 0 and "完成了" in out.stdout),
        ("工具在安装后出现", "computer" in getattr(run, "tools", [])),
        ("列出了测试窗口", "测试窗口" in r[0]),
        ("读到真实窗口的控件", all(word in r[1] for word in ("姓名", "口令", "确定"))),
        ("中文写入并确认", h(r[2]).get("effect") == "confirmed"),
        ("密码框拒绝输入", h(r[3]).get("reason") == "password-field" and h(r[3]).get("next") == "user"),
        ("截图发给模型", run.pictures == 1),
        ("点击真实送达，应用收到完整中文", written == TEXT),
        ("密码没有被写入", "不该写入" not in " ".join(r)),
        ("真实鼠标没有移动", mouse_before == mouse_after),
        (f"每个动作都在 {ACTION_LIMIT} 秒内", all(gap < ACTION_LIMIT for gap in gaps)),
    ]
    if app.poll() is None:
        app.kill()
    # Nobody to answer: nothing happens.
    second = os.path.join(tmp, "第二次.txt")
    app2 = start_app(second, {**env, "DISPLAY": os.environ.get("DISPLAY", "")} if sys.platform == "linux" else {**os.environ}, tmp)
    time.sleep(WINDOW_WAIT if sys.platform != "linux" else 3)
    def click_unanswered(last):
        return on_row("确定", action="click")(last)
    _out, auto = b.drive([{"_tool": "computer", "action": "windows"}, find_window, click_unanswered], env, "auto")
    a = auto.results + ["", "", ""]
    checks += [
        ("auto：读取放行", "确定" in a[1]),
        ("auto：没人回答时不点击", h(a[2]).get("reason") == "no-user" and not os.path.exists(second)),
    ]
    if app2.poll() is None:
        app2.kill()
    _out, off = b.drive([], {**env, "JW_COMPUTER": "off"}, "auto")
    checks.append(("JW_COMPUTER=off 时工具不出现", "computer" not in getattr(off, "tools", ["computer"])))
    return finish(checks, model, tmp)


def finish(checks, model, tmp):
    """Print the results and clean up."""
    model.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"平台：{platform.system()} {platform.machine()}")
    for name, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    failed = sum(1 for c in checks if not c[1])
    print(f"{len(checks) - failed}/{len(checks)} checks passed")
    return 1 if failed else 0


def main():
    """On Linux start a display and a D-Bus session and go inside; elsewhere the session is already there."""
    # Windows defaults to its ANSI code page, and -I ignores PYTHONUTF8: run again in UTF-8 mode, with the same exit code.
    if sys.platform == "win32" and not sys.flags.utf8_mode:
        return subprocess.run([sys.executable, "-I", "-X", "utf8", os.path.abspath(__file__)] + sys.argv[1:]).returncode
    if sys.platform != "linux" or os.environ.get("JW_CHECK_INNER"):
        return inner()
    if not shutil.which("Xvfb") or not shutil.which("dbus-run-session"):
        print("FAIL  需要 Xvfb 和 dbus-run-session")
        return 1
    display = f":{600 + os.getpid() % 300}"
    xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", "1280x800x24"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        run = subprocess.run(["dbus-run-session", "--", sys.executable, "-I", os.path.abspath(__file__)] + sys.argv[1:], env={**os.environ, "DISPLAY": display, "JW_CHECK_INNER": "1"}, timeout=500)
        return run.returncode
    finally:
        xvfb.terminate()


if __name__ == "__main__":
    sys.exit(main())

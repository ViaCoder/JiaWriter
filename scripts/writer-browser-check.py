#!/usr/bin/env python3
"""Hands-on check of the browser tool in the real program, in a throwaway Chrome for Testing on a virtual display.
A local mock plays the model, and fixture pages on 127.0.0.1 and localhost play the sites: nothing leaves the machine,
the user's Chrome and desktop are not touched. Covers the page's element kinds, code in the page, the permission
modes and the protocol. Prints one line per check and exits 1 when any fails. Skips when Chrome or Xvfb is missing.
Usage: python3 -I scripts/writer-browser-check.py [program]
"""

# Mock servers, process control and files.
import glob
import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The dummy key.
KEY = "sk-dummy-browser-check"
# Extension of the source tree, the same files a package holds.
EXTENSION = os.path.join(ROOT, "search_fetch", "src", "search_fetch", "extension")
# The extension's fixed id.
EXTENSION_ID = "mnoicnfoocibanokjfbpmbgpamlmdgje"
# What the fixture pages reported, such as a button press.
hits = []

MAIN_PAGE = """<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>元素测试页</title></head><body>
<h1>元素测试页</h1><p>这一页放了各种元素，用来检查读取和操作。这段文字足够长，页面才算有内容。""" + "正文内容。" * 40 + """</p>
<script>window.pageSecret = "页面变量"; const hit = (n) => fetch("/hit/" + encodeURIComponent(n));</script>
<button onclick="this.textContent='已按下'; hit('plain')">普通按钮</button>
<a href="/second.html" target="_blank">新标签链接</a>
<div id="open-host"></div><div id="closed-host"></div>
<script>
for (const [id, mode, name] of [["open-host", "open", "开放影子按钮"], ["closed-host", "closed", "闭合影子按钮"]]) {
  const root = document.getElementById(id).attachShadow({ mode });
  const b = document.createElement("button"); b.textContent = name; b.onclick = () => hit(name); root.append(b);
}
</script>
<iframe src="/same.html" title="同站框架" width="300" height="80"></iframe>
<iframe src="http://localhost:PORT/cross.html" title="跨站框架" width="400" height="140"></iframe>
<div role="textbox" contenteditable="true" aria-label="富文本" style="min-height:30px;border:1px solid" oninput="hit('rich:' + this.innerText)"></div>
<label>普通输入 <input id="plain-input" oninput="hit('input:' + this.value)"></label>
<label>密码 <input type="password"></label>
<label>原生下拉 <select onchange="hit('select:' + this.value)"><option value="a">甲</option><option value="b">乙</option></select></label>
<div role="combobox" tabindex="0" aria-expanded="false" aria-label="自绘下拉" onclick="document.getElementById('opts').hidden=false; this.setAttribute('aria-expanded','true')">选一个</div>
<ul id="opts" role="listbox" hidden><li role="option" tabindex="0" onclick="hit('custom:丙')">丙</li></ul>
<div class="menu" onmouseenter="document.getElementById('sub').hidden=false"><button>悬停菜单</button><button id="sub" hidden onclick="hit('hover-item')">子菜单项</button></div>
<label>上传 <input type="file" onchange="hit('file:' + this.files[0].name)"></label>
<button id="src" draggable="false" onmousedown="window.drag=1">拖动源</button>
<button id="dst" onmouseup="if(window.drag)hit('dropped')">拖动目标</button>
<button onclick="alert('提示内容'); hit('after-alert')">弹窗按钮</button>
<button onclick="hit('delete')">删除记录</button>
<div style="height:1500px"></div><div id="list" role="list" aria-label="虚拟列表"></div>
<script>
let n = 0; const list = document.getElementById("list");
const add = () => { for (let i = 0; i < 5; i++, n++) { const a = document.createElement("a"); a.href = "#" + n; a.textContent = "条目" + n; a.style.display = "block"; list.append(a); } };
add(); addEventListener("scroll", () => { if (n < 10) add(); }, { passive: true });
</script>
</body></html>"""
SAME_PAGE = """<!doctype html><meta charset="utf-8"><button onclick="fetch('/hit/same')">同站框架按钮</button>"""
CROSS_PAGE = """<!doctype html><meta charset="utf-8"><button onclick="fetch('/hit/cross', {mode:'no-cors'})">跨站框架按钮</button>
<input aria-label="跨站输入" oninput="fetch('/hit/' + encodeURIComponent('cross-input:' + this.value), {mode:'no-cors'})">"""
SECOND_PAGE = """<!doctype html><html lang="zh"><meta charset="utf-8"><title>第二页</title><h1>第二页标题</h1><p>""" + "第二页的正文。" * 40 + "</p></html>"
CANVAS_PAGE = """<!doctype html><meta charset="utf-8"><title>画布</title><body style="margin:0"><canvas width="1200" height="800" style="width:100vw;height:100vh"></canvas>""" + "<p>" + "说明文字。" * 60 + "</p>"
WALL_PAGE = """<!doctype html><meta charset="utf-8"><title>Just a moment...</title><p>Verify you are human</p><iframe src="/challenges.cloudflare.com/turnstile"></iframe>"""


class Sites(http.server.BaseHTTPRequestHandler):
    """The fixture pages, on both host names."""

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/hit/"):
            from urllib.parse import unquote
            hits.append(unquote(path[5:]))
            return self.page("")
        pages = {"/main.html": MAIN_PAGE, "/same.html": SAME_PAGE, "/cross.html": CROSS_PAGE, "/second.html": SECOND_PAGE, "/canvas.html": CANVAS_PAGE, "/wall.html": WALL_PAGE}
        self.page(pages.get(path, "<p>none</p>").replace("PORT", str(self.server.server_address[1])))

    def page(self, text):
        data = text.encode()
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        """Silence."""


def blocks(stop, *content):
    """One Messages stream."""
    events = [{"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "content": [], "model": "m", "stop_reason": None, "usage": {"input_tokens": 1, "output_tokens": 1}}}]
    for i, block in enumerate(content):
        if block["type"] == "tool_use":
            start = {**block, "input": {}}
            events += [{"type": "content_block_start", "index": i, "content_block": start},
                       {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}}]
        else:
            events += [{"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}},
                       {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": block["text"]}}]
        events.append({"type": "content_block_stop", "index": i})
    events += [{"type": "message_delta", "delta": {"stop_reason": stop}, "usage": {"output_tokens": 1}}, {"type": "message_stop"}]
    return events


class Script:
    """What the model does: each step gets the last tool result and gives the tool's input."""

    def __init__(self, steps):
        self.steps = list(steps)
        self.results = []
        self.prompts = 0
        self.times = []
        self.requests = []
        self.pictures = 0
        self.probes = 0
        self.refuse_images = False
        self.listing = None


current = [Script([])]


class Model(http.server.BaseHTTPRequestHandler):
    """The mock model."""

    def do_GET(self):
        """The model list, when the run gives one."""
        listing = current[0].listing
        data = json.dumps(listing or {}).encode()
        self.send_response(200 if listing else 404)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        script = current[0]
        text = json.dumps(body, ensure_ascii=False)
        if not body.get("tools"):
            # A request with a picture and no tools is the probe.
            if '"image"' in text:
                script.probes += 1
                if script.refuse_images:
                    return self.refuse()
            return self.stream(blocks("end_turn", {"type": "text", "text": "ok"}))
        script.requests.append(body)
        if script.refuse_images and '"type": "image"' in text:
            return self.refuse()
        script.prompts += 1
        script.times.append(time.monotonic())
        script.tools = [t["name"] for t in body["tools"]]
        script.system = json.dumps(body["system"], ensure_ascii=False)
        last = ""
        final = body["messages"][-1]
        if final["role"] == "user" and isinstance(final["content"], list):
            for part in final["content"]:
                if part.get("type") == "tool_result":
                    content = part["content"]
                    last = content if isinstance(content, str) else "".join(c.get("text", "") for c in content)
                    script.pictures += 0 if isinstance(content, str) else sum(c.get("type") == "image" for c in content)
            if last:
                script.results.append(last)
        if not script.steps:
            return self.stream(blocks("end_turn", {"type": "text", "text": "完成了。"}))
        step = script.steps.pop(0)
        given = step(last) if callable(step) else step
        name = given.pop("_tool", "browser")
        self.stream(blocks("tool_use", {"type": "tool_use", "id": f"t{len(script.results)}", "name": name, "input": given}))

    def refuse(self):
        data = json.dumps({"type": "error", "error": {"type": "invalid_request_error", "message": "this model does not support image input"}}).encode()
        self.send_response(400)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def stream(self, events):
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        for e in events:
            self.wfile.write(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n".encode())

    def log_message(self, *_args):
        """Silence."""


def program():
    """The command to run."""
    given = sys.argv[1:]
    if given:
        given[0] = os.path.abspath(given[0])
        return given
    coding = os.path.join(ROOT, "packages", "coding-agent")
    return ["node", "--import", "file://" + os.path.join(coding, "src", "experimental", "source-resolver.ts"), os.path.join(coding, "src", "cli.ts")]


def ref(name):
    """A step that acts on the control with this name in the last read."""
    return re.compile(r"\[(e\d+)\] \S+ \"" + re.escape(name) + "\"")


def on(action, name, **more):
    """A step: action on the control named so in the last list of controls."""
    def step(_last):
        lines = [r for r in current[0].results if "[e1]" in r]
        found = ref(name).search(lines[-1]) if lines else None
        return {"action": action, "ref": found.group(1) if found else "e999", **more}
    return step


def clean_env(tmp, port):
    """The environment of a run, with nothing of the machine's own setup."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD", "ANYSEARCH_"))}
    env.update(HOME=tmp, JW_DIR=os.path.join(tmp, "a"), JW_LANG="zh", JW_URL=f"http://127.0.0.1:{port}", JW_KEY=KEY, JW_MODEL="claude-test", JW_API="anthropic-messages")
    return env


def drive(steps, env, mode, **setup):
    """One run of the program with these steps."""
    script = Script(steps)
    for name, value in setup.items():
        setattr(script, name, value)
    current[0] = script
    run_env = {**env, "JW_PERMISSION": mode}
    out = subprocess.run(program() + ["-p", "开始"], cwd=env["HOME"], env=run_env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
    return out, script


def head(result):
    """The JSON line of a result."""
    try:
        return json.loads(result.split("\n")[0])
    except (ValueError, IndexError):
        return {}


def main():
    """Start everything, run the steps and print the results."""
    chrome = next(iter(sorted(glob.glob(os.path.expanduser("~/.local/share/wa-test-tools/cft-*/chrome-linux64/chrome")), reverse=True)), "") or os.environ.get("SEARCH_FETCH_TEST_CHROME", "")
    if not chrome or not shutil.which("Xvfb"):
        print("SKIP  需要 Chrome for Testing 和 Xvfb")
        return 0
    tmp = tempfile.mkdtemp(prefix="jw-bc-", dir="/tmp")
    sites = http.server.ThreadingHTTPServer(("0.0.0.0", 0), Sites)
    model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
    for s in (sites, model):
        threading.Thread(target=s.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{sites.server_address[1]}"
    env = clean_env(tmp, model.server_address[1])
    # The program as Chrome's native host, with the same agent folder as the runs below.
    launcher = os.path.join(tmp, "host.sh")
    with open(launcher, "w") as f:
        f.write(f"#!/bin/sh\nexport JW_DIR='{env['JW_DIR']}' HOME='{tmp}'\nexec {' '.join(chr(39) + a + chr(39) for a in program())} \"$@\"\n")
    os.chmod(launcher, 0o755)
    profile = os.path.join(tmp, "profile")
    os.makedirs(os.path.join(profile, "NativeMessagingHosts"))
    with open(os.path.join(profile, "NativeMessagingHosts", "com.jiawriter.browser.json"), "w") as f:
        json.dump({"name": "com.jiawriter.browser", "description": "JiaWriter", "path": launcher, "type": "stdio", "allowed_origins": [f"chrome-extension://{EXTENSION_ID}/"]}, f)
    display = f":{90 + os.getpid() % 500}"
    xvfb = subprocess.Popen(["Xvfb", display, "-screen", "0", "1400x1000x24"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    browser = subprocess.Popen([chrome, f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check", "--no-sandbox",
                                f"--load-extension={EXTENSION}", "about:blank"], env={**os.environ, "DISPLAY": display}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    checks = []
    try:
        socket_path = os.path.join(env["JW_DIR"], "browser", "bridge.sock")
        for _ in range(60):
            if os.path.exists(socket_path):
                break
            time.sleep(1)
        checks.append(("扩展连上了真实程序", os.path.exists(socket_path)))
        # Everything allowed: what the tool can do.
        steps = [
            {"action": "open", "url": f"{base}/main.html"},
            on("click", "普通按钮"), {"action": "read"},
            on("click", "开放影子按钮"), on("click", "闭合影子按钮"),
            on("click", "同站框架按钮"), on("click", "跨站框架按钮"),
            on("type", "富文本", text="富文本内容"), on("type", "普通输入", text="普通内容"),
            on("type", "跨站输入", text="跨站内容"), on("type", "密码", text="x"),
            on("select", "原生下拉", option="乙"),
            on("click", "自绘下拉"), {"action": "read"}, on("click", "丙"),
            on("hover", "悬停菜单"), {"action": "read"}, on("click", "子菜单项"),
            lambda _l: {"action": "upload", "ref": next(ref("上传").search(r).group(1) for r in current[0].results[::-1] if ref("上传").search(r)), "files": [upload]},
            on("drag", "拖动源", to=None), 
            {"action": "scroll", "dy": 400}, {"action": "read"},
            {"action": "eval", "code": "document.title"},
            {"action": "eval", "code": "typeof window.pageSecret"},
            {"action": "eval", "code": "window.pageSecret", "main": True},
            {"action": "eval", "code": "await Promise.resolve(40 + 2)"},
            {"action": "eval", "code": "throw new Error('脚本错误')"},
            on("click", "弹窗按钮"), {"action": "dialog", "accept": True},
            on("click", "新标签链接"), {"action": "read"},
            {"action": "open", "url": f"{base}/canvas.html"},
            {"action": "open", "url": f"{base}/main.html"},
            {"action": "click", "ref": "e999"}, {"action": "click", "ref": "e999"}, {"action": "click", "ref": "e999"},
            {"action": "open", "url": f"{base}/wall.html"},
            {"action": "read"},
        ]
        upload = os.path.join(tmp, "上传文件.txt")
        with open(upload, "w") as f:
            f.write("x")
        def drag_step(_l):
            lines = [r for r in current[0].results if "[e1]" in r][-1]
            return {"action": "drag", "ref": ref("拖动源").search(lines).group(1), "to": ref("拖动目标").search(lines).group(1)}
        steps[steps.index(next(s for s in steps if callable(s) and s.__closure__ and any(getattr(c, "cell_contents", None) == "拖动源" for c in s.__closure__)))] = drag_step
        out, script = drive(steps, env, "bypass")
        r = script.results + [""] * 50
        if os.environ.get("JW_CHECK_DUMP"):
            for i, x in enumerate(script.results):
                print(i, x[:190].replace("\n", " | "))
            print(hits)
        first = r[0]
        checks += [
            ("程序正常结束", out.returncode == 0 and "完成了" in out.stdout),
            ("工具在连上扩展时出现", "browser" in script.tools),
            ("手册随第一次使用发出", any("Using the browser" in x for x in script.results)),
            ("读到普通元素", '"普通按钮"' in first),
            ("读到开放 Shadow DOM", '"开放影子按钮"' in first),
            ("读到闭合 Shadow DOM", '"闭合影子按钮"' in first),
            ("读到同站框架", '"同站框架按钮"' in first),
            ("读到跨站框架", '"跨站框架按钮"' in first),
            ("点击普通按钮并确认", "plain" in hits and head(r[1]).get("effect") == "confirmed"),
            ("点击开放 Shadow DOM", "开放影子按钮" in hits),
            ("点击闭合 Shadow DOM", "闭合影子按钮" in hits),
            ("点击同站框架", "same" in hits),
            ("点击跨站框架", "cross" in hits),
            ("富文本输入并读回", "rich:富文本内容" in hits and head(r[7]).get("effect") == "confirmed"),
            ("普通输入", "input:普通内容" in hits),
            ("跨站框架里输入", "cross-input:跨站内容" in hits),
            ("密码框拒绝输入", head(r[10]).get("reason") == "password-field" and head(r[10]).get("next") == "user"),
            ("原生下拉", "select:b" in hits),
            ("自绘下拉", "custom:丙" in hits),
            ("悬停菜单", "hover-item" in hits),
            ("文件上传", "file:上传文件.txt" in hits),
            ("后台拖拽交给用户", head(r[19]).get("reason") == "needs-front" and head(r[19]).get("next") == "user"),
            ("滚动生效，懒加载条目可读", '"条目7"' in r[21] and head(r[20]).get("effect") == "confirmed"),
            ("eval 读到页面", "元素测试页" in r[22]),
            ("eval 默认隔离", "undefined" in r[23]),
            ("eval 主世界要明确指定", "页面变量" in r[24]),
            ("eval 支持 await", '"value":"42"' in r[25]),
            ("eval 脚本错误交给模型", head(r[26]).get("reason") == "script-error" and head(r[26]).get("next") == "model"),
            ("页面弹窗被报告", head(r[27]).get("reason") == "dialog"),
            ("弹窗回答后页面继续", head(r[28]).get("effect") == "confirmed" and "after-alert" in hits),
            ("新标签页被跟上", "第二页标题" in r[30] and head(r[30]).get("effect") == "confirmed"),
            ("Canvas 页面交给程序，不让模型猜", head(r[31]).get("reason") == "no-tree:canvas" and head(r[31]).get("next") == "user"),
            ("失效引用先交模型", head(r[33]).get("next") == "model"),
            ("同一目标失败两次后停下", head(r[34]).get("next") == "user"),
            ("熔断后不再尝试", head(r[35]).get("reason") == "tried-twice"),
            ("验证页面停下交给用户", head(r[36]).get("reason") == "verification" and head(r[36]).get("next") == "user"),
            ("验证页面所在站点不再重试", head(r[37]).get("reason") == "held-for-user"),
        ]
        # What each kind of action cost, the slowest of its kind, from the model's side.
        durations = [b - a for a, b in zip(script.times, script.times[1:])]
        given = [head(x).get("route", "") for x in script.results]
        slowest = {}
        for route, took in zip(given, durations):
            slowest[route] = max(slowest.get(route, 0), took)
        print("耗时（秒，同类最慢，含程序往返）：" + "  ".join(f"{k} {v:.1f}" for k, v in sorted(slowest.items())))
        checks.append(("每个动作都在 6 秒内", all(v < 6 for k, v in slowest.items() if k != "click" or True)))
        # With the window in front: a real click, a drag, and a new tab that is followed.
        hits.clear()
        def to_front(given):
            def step(_last):
                x_env = {"DISPLAY": display, "PATH": os.environ["PATH"]}
                wins = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", "元素测试页"], env=x_env, capture_output=True, text=True).stdout.split()
                for win in wins:
                    subprocess.run(["xdotool", "windowfocus", "--sync", win], env=x_env, capture_output=True, timeout=5)
                    subprocess.run(["xdotool", "mousemove", "--window", win, "5", "5"], env=x_env, capture_output=True)
                if os.environ.get("JW_CHECK_DUMP"):
                    print("WINS", wins, subprocess.run(["xdotool", "getwindowfocus"], env=x_env, capture_output=True, text=True).stdout)
                time.sleep(1)
                return given(_last) if callable(given) else given
            return step
        steps = [{"action": "open", "url": f"{base}/main.html"}, to_front(on("click", "普通按钮")), drag_step, on("click", "弹窗按钮"), {"action": "read"}, {"action": "dialog", "accept": True}, on("click", "新标签链接"), {"action": "read"}]
        _out, front = drive(steps, env, "bypass")
        f = front.results + [""] * 9
        if os.environ.get("JW_CHECK_DUMP"):
            for i, x in enumerate(front.results):
                print("F", i, x[:170].replace("\n", " | "))
        checks += [
            ("前台用真实鼠标点击", head(f[1]).get("route") == "click" and "plain" in hits),
            ("前台可以拖拽", head(f[2]).get("route") == "drag" and "dropped" in hits),
            ("前台也能报告弹窗", head(f[3]).get("reason") == "dialog"),
            ("弹窗未回答时其他动作被拦下", head(f[4]).get("reason") == "dialog-open"),
            ("前台回答弹窗", head(f[5]).get("effect") == "confirmed" and "after-alert" in hits),
            ("前台新标签页被跟上", "第二页标题" in f[7]),
        ]
        # Nobody to answer: every question becomes a refusal.
        hits.clear()
        steps = [{"action": "open", "url": f"{base}/main.html"}, on("click", "普通按钮"), {"action": "eval", "code": "1"}]
        _out, auto = drive(steps, env, "auto")
        a = auto.results + ["", "", ""]
        checks += [
            ("auto：读取放行", '"普通按钮"' in a[0]),
            ("auto：没人回答时普通动作被拒", head(a[1]).get("reason") == "no-user" and not hits),
            ("auto：没人回答时 eval 被拒", head(a[2]).get("reason") == "no-user"),
        ]
        _out, manual = drive([{"action": "open", "url": f"{base}/main.html"}], env, "manual")
        checks.append(("manual：没人回答时连读取也被拒", head((manual.results + [""])[0]).get("reason") == "no-user"))
        _out, off = drive([], {**env, "JW_BROWSER": "off"}, "auto")
        checks.append(("JW_BROWSER=off 时工具不出现", "browser" not in getattr(off, "tools", ["browser"])))
        # Images: a fresh agent folder each time, so nothing is remembered.
        def fresh(tag, **more):
            home = os.path.join(tmp, tag)
            os.makedirs(home, exist_ok=True)
            return {**env, "JW_OCR": "off", "JW_PROBE_HOME": home, "HOME": env["HOME"], **more}
        vision_file = os.path.join(env["JW_DIR"], "vision.json")
        def no_memory():
            if os.path.exists(vision_file):
                os.remove(vision_file)
        canvas = f"{base}/canvas.html"
        no_memory()
        def point_step(_last):
            sent = [head(r) for r in current[0].results if '"capture"' in r]
            return {"action": "point", "capture": sent[-1]["data"]["capture"], "x": 50, "y": 50}
        steps = [
            {"action": "open", "url": canvas},
            {"action": "look"},
            {"action": "look", "reason": "画布上没有文字"},
            {"action": "look", "reason": "再看一次"},
            point_step,
            {"action": "open", "url": f"{base}/main.html"},
            {"action": "look", "reason": "第二张"},
        ]
        _out, seen = drive(steps, fresh("v1"), "bypass")
        v = seen.results + [""] * 8
        # cache_control markers move forward on every request; the API does not count them as an edit.
        def bare(value):
            if isinstance(value, dict):
                return {k: bare(v) for k, v in value.items() if k != "cache_control"}
            return [bare(v) for v in value] if isinstance(value, list) else value
        def plain(messages):
            return json.dumps(bare(messages), sort_keys=True, ensure_ascii=False)
        prefix_kept = all(plain(b["messages"][:len(a["messages"])]) == plain(a["messages"]) for a, b in zip(seen.requests, seen.requests[1:]))
        if os.environ.get("JW_CHECK_DUMP") and not prefix_kept:
            for a, b in zip(seen.requests, seen.requests[1:]):
                one, two = plain(a["messages"]), plain(b["messages"][:len(a["messages"])])
                if one != two:
                    at = next((i for i, (x, y) in enumerate(zip(one, two)) if x != y), min(len(one), len(two)))
                    print("DIFF", len(a["messages"]), one[max(0, at - 90):at + 120], "\n  ||", two[max(0, at - 90):at + 120])
                    break
        checks += [
            ("look 必须带理由", head(v[1]).get("reason") == "reason-required"),
            ("探测用一个极小请求", seen.probes == 1),
            ("图片真的发给了模型", seen.pictures == 1),
            ("缩到长边 1024 以内", "×" in head(v[2]).get("data", {}).get("size", "") and max(map(int, head(v[2])["data"]["size"].split("×"))) <= 1024),
            ("画面没变不再发图", head(v[3]).get("reason") == "unchanged"),
            ("按图点击走到页面", head(v[4]).get("route") in ("click", "keyboard", "script")),
            ("超出每轮额度交给用户", head(v[6]).get("reason") == "image-budget" and head(v[6]).get("next") == "user"),
            ("历史只追加，图片没有被删", prefix_kept and len(seen.requests) > 3),
            ("结果写入记录，不用再探测", os.path.exists(vision_file)),
        ]
        _out, again = drive([{"action": "open", "url": canvas}, {"action": "look", "reason": "再来"}], fresh("v2"), "bypass")
        checks.append(("下次会话不再探测", again.probes == 0 and again.pictures == 1))
        no_memory()
        _out, refused = drive([{"action": "open", "url": canvas}, {"action": "look", "reason": "看"}], fresh("v3"), "bypass", refuse_images=True)
        checks.append(("上游拒收时不重试、不发图", head((refused.results + ["", ""])[1]).get("reason") == "no-image-input" and refused.probes == 1 and refused.pictures == 0))
        _out, later = drive([{"action": "open", "url": canvas}, {"action": "look", "reason": "看"}], fresh("v4"), "bypass", refuse_images=True)
        checks.append(("记住上游不收图", later.probes == 0))
        no_memory()
        _out, listed = drive([{"action": "open", "url": canvas}, {"action": "look", "reason": "看"}], fresh("v5"), "bypass", listing={"data": [{"id": "claude-test", "architecture": {"input_modalities": ["text", "image"]}}]})
        checks.append(("模型目录已声明时不花探测请求", listed.probes == 0 and listed.pictures == 1))
        no_memory()
        _out, asked = drive([{"action": "open", "url": canvas}, {"action": "look", "reason": "看"}], fresh("v6"), "auto")
        checks.append(("没人同意时不发图，也不探测", head((asked.results + ["", ""])[1]).get("reason") == "no-user" and asked.probes == 0 and asked.pictures == 0))
        fake_bin = os.path.join(tmp, "bin")
        os.makedirs(fake_bin, exist_ok=True)
        with open(os.path.join(fake_bin, "tesseract"), "w") as f:
            f.write("#!/bin/sh\nif [ \"$1\" = --version ]; then exit 0; fi\necho 本机识别出来的足够多的文字\n")
        os.chmod(os.path.join(fake_bin, "tesseract"), 0o755)
        no_memory()
        ocr_env = {**fresh("v7"), "PATH": fake_bin + ":" + os.environ["PATH"]}
        ocr_env.pop("JW_OCR")
        _out, read_here = drive([{"action": "open", "url": canvas}, {"action": "look", "reason": "看"}, {"action": "look", "reason": "还是不够"}], ocr_env, "bypass")
        o = read_here.results + ["", "", ""]
        checks += [
            ("先用本机文字识别，不发图", head(o[1]).get("route") == "ocr" and "本机识别" in o[1]),
            ("同一画面再看才发给上游", read_here.pictures == 1),
        ]
        image_file = os.path.join(env["HOME"], "图.png")
        with open(image_file, "wb") as f:
            f.write(__import__("base64").b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="))
        _out, filed = drive([{"_tool": "read", "path": image_file}], fresh("v8", JW_IMAGE="on"), "auto")
        checks.append(("read 读图同样要同意", "没有发送图片" in (filed.results + [""])[0] and filed.pictures == 0))
    finally:
        browser.terminate()
        xvfb.terminate()
        browser.wait(timeout=15)
        sites.shutdown()
        model.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
    for name, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    failed = sum(1 for c in checks if not c[1])
    print(f"{len(checks) - failed}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

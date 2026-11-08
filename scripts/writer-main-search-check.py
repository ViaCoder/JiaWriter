#!/usr/bin/env python3
"""Hands-on check of the upstream's own search tools in the main conversation, in the real program: a local mock
plays the model and the upstream (nothing leaves 127.0.0.1, the key is a dummy). One run on the Responses API and
one on the Messages API: a first search through a request of its own shows the tool works, then the tool is in the
main request (on Messages from the next conversation, as thinking blocks are bound to the set of tools), what it read
goes back on the next request, and the archive holds the pages' own text.
Prints one line per check and exits 1 when any fails.
Usage: python3 -I scripts/writer-main-search-check.py [program]
"""

# Mock server, process control and files.
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading

# Repository root (this file is in scripts/).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The dummy key.
KEY = "sk-dummy-main-search-check"
# Pages: one opened, one cited, one nothing can fetch.
URL_A = "https://news.example.com/opened"
URL_B = "https://news.example.com/cited"
URL_C = "https://news.example.com/missing"
# A page the reply names without any search having listed it.
URL_NAMED = "https://elsewhere.example.com/named"
# The text of a page as Codex's endpoint gives it.
ORIGINAL = "页面的原文段落。" * 100
# A page as the server's model reports it.
RETOLD = "服务端模型的详细报告。" * 80
# The encrypted content of the upstream's tools.
ENCRYPTED = "ENCRYPTED-SEARCH-CONTENT"
# Whether the upstream has Codex's own search endpoint.
endpoint_on = [True]
# Requests of the main conversation, requests of their own, requests to the search endpoint.
main_calls = []
inner_calls = []
endpoint_calls = []


def send_json(handler, status, value):
    """Answer with JSON."""
    data = json.dumps(value, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.end_headers()
    handler.wfile.write(data)


def sse(handler, events):
    """Answer with a stream of events."""
    handler.send_response(200)
    handler.send_header("content-type", "text/event-stream")
    handler.end_headers()
    handler.wfile.write("".join(f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events).encode("utf-8"))


def responses(items):
    """A Responses stream with these items."""
    final = {"id": "r", "object": "response", "created_at": 1, "model": "x", "status": "completed", "output": items}
    events = [{"type": "response.created", "sequence_number": 0, "response": {**final, "output": []}}]
    for i, item in enumerate(items):
        events.append({"type": "response.output_item.added", "output_index": i, "item": item})
        events.append({"type": "response.output_item.done", "output_index": i, "item": item})
    return events + [{"type": "response.completed", "sequence_number": 9, "response": final}]


def say(text):
    """A Responses message."""
    return {"type": "message", "id": "msg_1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]}


def function_call(name, args, n):
    """A Responses function call."""
    return {"type": "function_call", "id": f"fc_{n}", "call_id": f"call_{n}", "name": name, "arguments": json.dumps(args, ensure_ascii=False), "status": "completed"}


def messages_stream(blocks, stop):
    """A Messages stream with these blocks; a server tool's input comes in pieces."""
    events = [{"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "model": "x", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}}]
    for i, block in enumerate(blocks):
        if block["type"] in ("server_tool_use", "tool_use"):
            events.append({"type": "content_block_start", "index": i, "content_block": {**block, "input": {}}})
            events.append({"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(block["input"], ensure_ascii=False)}})
        elif block["type"] == "text":
            events.append({"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
            events.append({"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": block["text"]}})
        else:
            events.append({"type": "content_block_start", "index": i, "content_block": block})
        events.append({"type": "content_block_stop", "index": i})
    return events + [{"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 1}}, {"type": "message_stop"}]


class Upstream(http.server.BaseHTTPRequestHandler):
    """The endpoints of both runs."""

    def do_POST(self):
        """Route by path, then by whose request it is."""
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        path = self.path.split("?")[0]
        if path == "/v1/alpha/search":
            return self.on_endpoint(body)
        own_tools = [t for t in body.get("tools") or [] if t.get("type") == "function" or "input_schema" in t]
        if path == "/v1/responses":
            return self.on_responses(body) if own_tools else self.inner_responses(body)
        if path == "/v1/messages":
            return self.on_messages(body) if own_tools else self.inner_messages(body)
        send_json(self, 404, {"error": {"message": "nope"}})

    def on_endpoint(self, body):
        """Codex's own endpoint: one page has text, the other is missing."""
        endpoint_calls.append(body)
        if not endpoint_on[0]:
            return send_json(self, 404, {"error": {"message": "nope"}})
        ref = body["commands"]["open"][0]["ref_id"]
        if ref == URL_C:
            return send_json(self, 200, {"output": "short error"})
        send_json(self, 200, {"output": ORIGINAL, "results": [{"url": ref, "title": "原文标题"}]})

    def inner_responses(self, body):
        """A search of its own."""
        inner_calls.append(body)
        if body["instructions"].startswith("Open"):
            page = json.dumps(body["input"], ensure_ascii=False)
            report = "打不开" if URL_C in page else RETOLD
            return sse(self, responses([{"type": "web_search_call", "id": "ws_9", "status": "completed", "action": {"type": "open_page", "url": URL_A}}, say(report)]))
        action = {"type": "search", "query": "甲", "sources": [{"type": "url", "url": URL_A}]}
        sse(self, responses([{"type": "web_search_call", "id": "ws_0", "status": "completed", "action": action}, say("内部回答")]))

    def on_responses(self, body):
        """The main conversation: a call of ours, then the tool, then the end."""
        main_calls.append(body)
        done = [i for i in body["input"] if i.get("type") == "function_call_output"]
        if len(done) == 0:
            return sse(self, responses([function_call("search_web", {"query": "甲", "method": "codex"}, 0)]))
        if len(done) == 1:
            search = {"type": "web_search_call", "id": "ws_1", "status": "completed", "encrypted_content": ENCRYPTED, "action": {"type": "search", "query": "主对话搜索", "sources": [{"type": "url", "url": u} for u in (URL_A, URL_B, URL_C)]}}
            opened = {"type": "web_search_call", "id": "ws_2", "status": "completed", "action": {"type": "open_page", "url": URL_A}}
            return sse(self, responses([search, opened, function_call("topic_open", {"name": "绿化"}, 1)]))
        sse(self, responses([say(f"完成了，见 {URL_B} 和 {URL_C}，另见 {URL_NAMED}。")]))

    def inner_messages(self, body):
        """A search or a page read of its own."""
        inner_calls.append(body)
        tool = body["tools"][0]["name"]
        if tool == "web_search":
            blocks = [{"type": "server_tool_use", "id": "s", "name": "web_search", "input": {}},
                      {"type": "web_search_tool_result", "tool_use_id": "s", "content": [{"type": "web_search_result", "url": URL_A, "title": "新闻", "page_age": "", "encrypted_content": "x"}]},
                      {"type": "text", "text": "内部回答"}]
        else:
            blocks = [{"type": "server_tool_use", "id": "s", "name": "web_fetch", "input": {}},
                      {"type": "web_fetch_tool_result", "tool_use_id": "s", "content": {"type": "web_fetch_result", "url": URL_A, "retrieved_at": None, "content": {"type": "document", "title": "页", "citations": None, "source": {"type": "text", "media_type": "text/plain", "data": ORIGINAL}}}}]
        sse(self, messages_stream(blocks, "end_turn"))

    def on_messages(self, body):
        """The main conversation: two calls of ours, then the tools, a pause, and the end."""
        main_calls.append(body)
        turn = len(main_calls)
        if turn == 1:
            return sse(self, messages_stream([{"type": "tool_use", "id": "t1", "name": "search_web", "input": {"query": "甲", "method": "claude"}}], "tool_use"))
        if turn == 2:
            return sse(self, messages_stream([{"type": "tool_use", "id": "t2", "name": "fetch_web", "input": {"url": URL_A, "method": "claude"}}], "tool_use"))
        if turn == 3:
            page = {"type": "web_fetch_result", "url": URL_B, "retrieved_at": None, "content": {"type": "document", "title": "主对话页面", "citations": None, "source": {"type": "text", "media_type": "text/plain", "data": "主对话读到的原文"}}}
            return sse(self, messages_stream([
                {"type": "server_tool_use", "id": "s1", "name": "web_search", "input": {"query": "主对话搜索"}},
                {"type": "web_search_tool_result", "tool_use_id": "s1", "content": [{"type": "web_search_result", "url": URL_B, "title": "乙", "page_age": "2026-11-01", "encrypted_content": ENCRYPTED}]},
                {"type": "server_tool_use", "id": "s2", "name": "web_fetch", "input": {"url": URL_B}},
                {"type": "web_fetch_tool_result", "tool_use_id": "s2", "content": page},
                {"type": "server_tool_use", "id": "s3", "name": "web_search", "input": {"query": "停在半路"}},
            ], "pause_turn"))
        sse(self, messages_stream([{"type": "text", "text": "完成了。"}], "end_turn"))

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


def run(api, port, rounds=(("-p", "开始"),)):
    """Runs of the program in one home; gives the last output, the archive by folder, the log, and each run's requests."""
    tmp = tempfile.mkdtemp(prefix="jw-main-")
    each_run = []
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD", "ANYSEARCH_"))}
    env.update(HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), JW_LANG="zh", JW_URL=f"http://127.0.0.1:{port}", JW_KEY=KEY, JW_MODEL="mock-model", JW_API=api, JW_EFFORT="off")
    for args in rounds:
        main_calls.clear()
        inner_calls.clear()
        endpoint_calls.clear()
        out = subprocess.run(program() + list(args), cwd=tmp, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
        each_run.append(list(main_calls))
    found = {"检索": "", "网页": ""}
    for folder, _dirs, files in os.walk(tmp):
        name = os.path.basename(folder)
        if name in found and not folder.startswith(env["JW_DIR"]):
            for f in sorted(files):
                with open(os.path.join(folder, f), encoding="utf-8") as h:
                    found[name] += h.read()
    log_path = os.path.join(env["JW_DIR"], "logs", "search.log")
    log_text = open(log_path, encoding="utf-8").read() if os.path.exists(log_path) else ""
    shutil.rmtree(tmp, ignore_errors=True)
    return out, found, log_text, each_run


def tool_types(body):
    """Types of the tools of a request that are not ours."""
    return [t.get("type") for t in body.get("tools") or [] if t.get("type") != "function" and "input_schema" not in t]


def main():
    """Run both and print the results."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    checks = []

    out, found, log_text, _runs = run("openai-responses", port)
    first, second, third = (main_calls + [{}, {}, {}])[:3]
    checks += [
        ("codex：程序正常结束", out.returncode == 0 and "完成了" in out.stdout),
        ("codex：第一次走自己的请求，主请求还没有内置工具", sum(1 for c in inner_calls if c["instructions"].startswith("Research")) == 1 and tool_types(first) == []),
        ("codex：证明之后主请求带上内置工具", tool_types(second) == ["web_search"]),
        ("codex：主请求要求返回来源", "web_search_call.action.sources" in (second.get("include") or [])),
        ("codex：思考关闭时主请求不带内置工具拒绝的档位", (second.get("reasoning") or {}).get("effort") not in ("none", "minimal")),
        ("codex：模型被告知工具已接入", "已接入对话" in json.dumps(second.get("input"), ensure_ascii=False)),
        ("codex：encrypted_content 在下一轮发回", ENCRYPTED in json.dumps(third.get("input"), ensure_ascii=False)),
        ("codex：内置搜索进了 检索/", "主对话搜索" in found["检索"] and URL_B in found["检索"]),
        ("codex：打开过的页面归档了原文", found["网页"].count("页面的原文段落") >= 100 and URL_A in found["网页"]),
        ("codex：回答引用的页面也归档了原文", URL_B in found["网页"]),
        ("codex：取不到时交给用户决定", "由你决定" in out.stderr),
        ("codex：回答随手写的地址不抓", not any(URL_NAMED in json.dumps(c, ensure_ascii=False) for c in endpoint_calls)),
        ("codex：日志没有 key 和网址", log_text != "" and KEY not in log_text and "news.example.com" not in log_text and "127.0.0.1" not in log_text),
        ("codex：日志记下了归档方式", '"kind":"origin"' in log_text and '"kind":"origin-failed"' in log_text),
    ]

    # The test site has no endpoint: pages are kept as the server reports them, and nothing moves to another channel.
    endpoint_on[0] = False
    out, found, log_text, _runs = run("openai-responses", port)
    checks += [
        ("无接口：程序正常结束", out.returncode == 0 and "完成了" in out.stdout),
        ("无接口：只试一次接口", len(endpoint_calls) == 1),
        ("无接口：归档存服务端的详细报告", found["网页"].count("服务端模型的详细报告") >= 80),
        ("无接口：归档标明是上游转述", "上游转述" in found["网页"]),
        ("无接口：读不到的页面交给用户决定", "由你决定" in out.stderr),
        ("无接口：没有自动换到本机渠道", '"method":"anysearch"' not in log_text and '"method":"sf"' not in log_text),
    ]
    endpoint_on[0] = True

    out, found, log_text, runs = run("anthropic-messages", port, (("-p", "开始"), ("-p", "第二个对话"), ("-c", "-p", "继续")))
    opening, second_chat, resumed = runs
    calls = second_chat + [{}, {}, {}, {}]
    last = json.dumps(calls[3].get("messages"), ensure_ascii=False)
    both = ["web_search_20250305", "web_fetch_20250910"]
    checks += [
        ("claude：程序正常结束", out.returncode == 0 and "完成了" in out.stdout),
        ("claude：证明成功的对话里 tools 一字不变", len(opening) == 4 and len({json.dumps(c.get("tools"), sort_keys=True) for c in opening}) == 1),
        ("claude：证明成功的对话里没有内置工具", tool_types(opening[0]) == []),
        ("claude：工具描述没有中途改写", "web_search tool instead" not in json.dumps(opening[-1].get("tools"))),
        ("claude：新对话第一条请求就带两个工具", tool_types(calls[0]) == both),
        ("claude：新对话里 tools 一字不变", len({json.dumps(c.get("tools"), sort_keys=True) for c in second_chat}) == 1),
        ("claude：恢复对话后 tools 仍相同", [c.get("tools") for c in resumed[:1]] == [second_chat[0].get("tools")]),
        ("claude：pause_turn 后自动继续", len(second_chat) == 4 and "Continue." in last),
        ("claude：搜索内容在下一轮发回", ENCRYPTED in last and "web_search_tool_result" in last),
        ("claude：没有结果的调用不发回", "停在半路" not in last),
        ("claude：抓到的网页文字进了 网页/", "主对话读到的原文" in found["网页"]),
        ("claude：内置搜索进了 检索/", "主对话搜索" in found["检索"]),
        ("claude：日志没有 key 和网址", log_text != "" and KEY not in log_text and "news.example.com" not in log_text and "127.0.0.1" not in log_text),
    ]

    server.shutdown()
    for name, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    failed = sum(1 for c in checks if not c[1])
    print(f"{len(checks) - failed}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

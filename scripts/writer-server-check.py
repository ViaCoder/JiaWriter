#!/usr/bin/env python3
"""Hands-on check of the claude and codex methods of web_search and web_fetch in the real program: a local mock
plays the model and the upstream (nothing leaves 127.0.0.1, the key is a dummy). The main conversation runs on Chat
Completions, the claude way answers only in the OAuth style, the codex way answers plain requests: first on Codex's
own search endpoint, then, when that endpoint stops answering, through the hosted tool.
Prints one line per check and exits 1 when any fails.
Usage: python3 -I scripts/writer-server-check.py [program]
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
KEY = "sk-dummy-server-check"
# The page all methods report.
URL = "https://news.example.com/a"
# The calls the mock model makes, in order.
CALLS = [
    ("web_search", {"query": "甲", "method": "claude"}),
    ("web_fetch", {"url": URL, "method": "claude"}),
    ("web_search", {"query": "丁", "method": "codex", "fresh": "week"}),
    ("web_fetch", {"url": URL + "?c=1", "method": "codex", "find": "绿化"}),
    ("web_search", {"query": "乙", "method": "codex"}),
    ("web_fetch", {"url": URL + "?b=1", "method": "codex"}),
    ("web_search", {"query": "丙"}),
]
# What the upstream saw: (path, style or "", model).
seen = []
# What Codex's own search endpoint saw.
direct = []
# Tool results the conversation carried at the end.
results = []


def sse(handler, lines):
    """Answer with a stream."""
    handler.send_response(200)
    handler.send_header("content-type", "text/event-stream")
    handler.end_headers()
    handler.wfile.write("".join(lines).encode("utf-8"))


def chat(delta, finish=None):
    """One Chat Completions event."""
    chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"


def claude_reply(blocks):
    """An Anthropic stream with these blocks."""
    events = [{"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "model": "x", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0}}}]
    for i, block in enumerate(blocks):
        events += [{"type": "content_block_start", "index": i, "content_block": block}, {"type": "content_block_stop", "index": i}]
    events += [{"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}, {"type": "message_stop"}]
    return [f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events]


def codex_reply(output):
    """A Responses stream that ends with this output."""
    response = {"id": "r", "object": "response", "created_at": 1, "model": "x", "status": "completed", "output": []}
    # An event no SDK knows, as real upstreams send, and items that arrive one by one before an empty final list.
    events = [{"type": "response.created", "sequence_number": 0, "response": response}, {"type": "response.something_new", "sequence_number": 1}]
    events += [{"type": "response.output_item.done", "item": item} for item in output]
    events += [{"type": "response.completed", "sequence_number": 2, "response": response}]
    return [f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events]


def text_item(text):
    """A Responses message."""
    return {"type": "message", "id": "m", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]}


class Upstream(http.server.BaseHTTPRequestHandler):
    """The three endpoints."""

    def do_POST(self):
        """Route by path."""
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        path = self.path.split("?")[0]
        if path == "/v1/chat/completions":
            self.conversation(body)
        elif path == "/v1/messages":
            self.on_claude(body)
        elif path == "/v1/responses":
            self.on_codex(body)
        elif path == "/v1/alpha/search":
            self.on_direct(body)
        else:
            self.reject(404)

    def reject(self, status):
        """An error answer."""
        data = json.dumps({"error": {"message": f"nope {status}"}}).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def conversation(self, body):
        """The main model: the next call, or the end."""
        messages = body.get("messages") or []
        done = [m for m in messages if m.get("role") == "tool"]
        results[:] = [str(m.get("content")) for m in done]
        if len(done) < len(CALLS):
            name, args = CALLS[len(done)]
            head = {"tool_calls": [{"index": 0, "id": f"call_{len(done)}", "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}
            sse(self, [chat(head), chat({}, "tool_calls"), "data: [DONE]\n\n"])
        else:
            sse(self, [chat({"content": "完成了。"}), chat({}, "stop"), "data: [DONE]\n\n"])

    def on_claude(self, body):
        """The claude way: only an OAuth-style request is taken."""
        oauth = "oauth-2025-04-20" in self.headers.get("anthropic-beta", "") and self.headers.get("authorization") == f"Bearer {KEY}"
        seen.append(("/v1/messages", "oauth" if oauth else "plain", body.get("model")))
        if not oauth:
            return self.reject(401)
        if body["tools"][0]["name"] == "web_search":
            sse(self, claude_reply([
                {"type": "server_tool_use", "id": "s", "name": "web_search", "input": {}},
                {"type": "web_search_tool_result", "tool_use_id": "s", "content": [{"type": "web_search_result", "url": URL, "title": "新闻", "page_age": None, "encrypted_content": "x"}]},
                {"type": "text", "text": "克劳德的回答"},
            ]))
        else:
            sse(self, claude_reply([
                {"type": "server_tool_use", "id": "s", "name": "web_fetch", "input": {}},
                {"type": "web_fetch_tool_result", "tool_use_id": "s", "content": {"type": "web_fetch_result", "url": URL, "retrieved_at": None, "content": {"type": "document", "title": "新闻", "citations": None, "source": {"type": "text", "media_type": "text/plain", "data": "克劳德抓到的原文"}}}},
            ]))

    def on_codex(self, body):
        """The codex way: plain requests."""
        seen.append(("/v1/responses", "plain", body.get("model")))
        if body["instructions"].startswith("Research"):
            action = {"type": "search", "query": "乙", "sources": [{"type": "url", "url": URL + "?b=1"}]}
            answer = "科德克斯的回答"
        else:
            action = {"type": "open_page", "url": URL}
            answer = "科德克斯写出的全文。" * 60
        sse(self, codex_reply([{"type": "web_search_call", "id": "w", "status": "completed", "action": action}, text_item(answer)]))

    def on_direct(self, body):
        """Codex's own search endpoint: it answers twice, then stops, as an upstream without it would."""
        direct.append(body)
        if len(direct) > 2:
            return self.reject(404)
        output = "端点检索结果" if "search_query" in body["commands"] else "端点找到的段落"
        data = json.dumps({"output": output, "results": [{"type": "text_result", "ref_id": "turn0search0", "url": URL, "title": "新闻"}]}).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        """Silence."""


def main():
    """Run the program once and print the results."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="jw-server-")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD", "ANYSEARCH_"))}
    env.update(
        HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), JW_LANG="zh",
        JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY=KEY, JW_MODEL="mock-model",
        JW_API="openai-completions", JW_EFFORT="off",
    )
    program = sys.argv[1:]
    if program:
        program[0] = os.path.abspath(program[0])
    else:
        coding = os.path.join(ROOT, "packages", "coding-agent")
        program = ["node", "--import", "file://" + os.path.join(coding, "src", "experimental", "source-resolver.ts"), os.path.join(coding, "src", "cli.ts")]
    out = subprocess.run(program + ["-p", "开始"], cwd=tmp, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    # Topic files by folder.
    found = {"检索": "", "网页": ""}
    counts = {"检索": 0, "网页": 0}
    for folder, _dirs, files in os.walk(tmp):
        name = os.path.basename(folder)
        if name in found and not folder.startswith(env["JW_DIR"]):
            for f in files:
                counts[name] += 1
                with open(os.path.join(folder, f), encoding="utf-8") as h:
                    found[name] += h.read()
    all_results = "\n".join(results)
    # The search log, as a user would send it.
    log_path = os.path.join(env["JW_DIR"], "logs", "search.log")
    log_text = open(log_path, encoding="utf-8").read() if os.path.exists(log_path) else ""
    claude_calls = [s for s in seen if s[0] == "/v1/messages"]
    codex_calls = [s for s in seen if s[0] == "/v1/responses"]
    checks = [
        ("程序正常结束", out.returncode == 0 and "完成了" in out.stdout),
        ("claude：普通请求被拒后换 OAuth 方式，只多发一次", [s[1] for s in claude_calls[:2]] == ["plain", "oauth"]),
        ("claude：同一会话第二次直接用 OAuth 方式", [s[1] for s in claude_calls] == ["plain", "oauth", "oauth"]),
        ("codex：主对话是 Chat Completions 时照常走 /v1/responses", len(codex_calls) == 2),
        ("内部请求的模型就是对话模型", {s[2] for s in seen} == {"mock-model"}),
        ("搜索结果和上游回答都进工具结果", "克劳德的回答" in all_results and "科德克斯的回答" in all_results and URL in all_results),
        ("抓取结果进工具结果", "克劳德抓到的原文" in all_results and "科德克斯写出的全文" in all_results),
        ("搜索都归档到 检索/", counts["检索"] == 3 and "克劳德的回答" in found["检索"] and "科德克斯的回答" in found["检索"] and "端点检索结果" in found["检索"]),
        ("抓取都归档到 网页/", counts["网页"] == 3 and "克劳德抓到的原文" in found["网页"] and "科德克斯写出的全文" in found["网页"] and "端点找到的段落" in found["网页"]),
        ("codex：搜索走自己的端点，时间范围生效", direct[0]["commands"]["search_query"] == [{"q": "丁", "recency": 7}]),
        ("codex：抓取走自己的端点，find 生效", direct[1]["commands"]["find"] == [{"ref_id": URL + "?c=1", "pattern": "绿化"}]),
        ("codex：端点不答后回到托管工具，本会话只多试一次", len(direct) == 3),
        ("不填 method 时报错，也没有发请求", len(results) == 7 and "method" in results[6] and len(seen) == 5),
        ("输出里没有 key", KEY not in out.stdout + out.stderr + all_results),
        ("日志记下了搜索工具的调用", "web_search_call" in log_text and "server_tool_use" in log_text),
        ("日志记下了 SDK 不认识的事件", "response.something_new" in log_text),
        ("日志记下了模型每轮调用的工具和方式", '"kind":"turn"' in log_text and '"kind":"tool"' in log_text and '"kind":"session"' in log_text),
        ("日志里没有 key", log_text != "" and KEY not in log_text),
        ("日志里有请求路径", "/alpha/search" in log_text and "/v1/responses" in log_text),
        ("日志里没有网址和上游地址", log_text != "" and not any(x in log_text for x in ("news.example.com", "127.0.0.1", "http://", "https://"))),
    ]
    server.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    for name, ok in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    failed = sum(1 for c in checks if not c[1])
    print(f"{len(checks) - failed}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

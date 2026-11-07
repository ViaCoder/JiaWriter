#!/usr/bin/env python3
"""Hands-on check of which text reaches the model at each stage, in the real program: a local mock plays the model
and records every request (nothing leaves 127.0.0.1, the key is a dummy). Prints one line per check and exits 1
when any fails.
Usage: python3 -I scripts/writer-prompt-check.py [program]
"""

# Mock server, process control and files.
import time
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
# A page long enough to tell whether it reached the summary request.
PAGE = "页面正文内容。" * 5000


def sse_events(events):
    """A named event stream."""
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e, ensure_ascii=False)}\n\n" for e in events)


def claude_reply(blocks):
    """An Anthropic stream with these blocks."""
    events = [{"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "model": "x", "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0}}}]
    for i, block in enumerate(blocks):
        events += [{"type": "content_block_start", "index": i, "content_block": block}, {"type": "content_block_stop", "index": i}]
    return sse_events(events + [{"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}}, {"type": "message_stop"}])


def chat(delta, finish=None, usage=None):
    """One Chat Completions event."""
    chunk = {"id": "c", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    if usage:
        chunk["usage"] = usage
    return f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"


class Script:
    """What one run of the mock does."""

    def __init__(self, calls, tokens=10, summary_fails=False):
        """The tool calls in order, the size reported, and whether summaries fail."""
        self.calls, self.tokens, self.summary_fails = calls, tokens, summary_fails
        # Requests of the main model, and of the summary.
        self.requests, self.summaries = [], []


class Upstream(http.server.BaseHTTPRequestHandler):
    """The conversation, and the claude way of searching."""

    script = None

    def do_POST(self):
        """Route by path."""
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
        if self.path.split("?")[0] == "/v1/messages":
            return self.on_claude(body)
        # Only the summary requests come without tools.
        if not body.get("tools"):
            return self.on_summary(json.dumps(body.get("messages"), ensure_ascii=False))
        self.on_model(body)

    def send(self, status, text, kind="text/event-stream"):
        """One answer."""
        self.send_response(status)
        self.send_header("content-type", kind)
        self.end_headers()
        self.wfile.write(text.encode("utf-8"))

    def on_summary(self, text):
        """The summary request."""
        self.script.summaries.append(text)
        if self.script.summary_fails:
            return self.send(500, '{"error":{"message":"down"}}', "application/json")
        self.send(200, chat({"content": "## Decisions\n定了三节\n\n## Preferences\n(none)\n\n## Next\n写第二节"}) + chat({}, "stop") + "data: [DONE]\n\n")

    def on_model(self, body):
        """The main model: the next call, or a short reply."""
        script = self.script
        script.requests.append(body)
        if script.calls:
            name, args = script.calls.pop(0)
            head = {"tool_calls": [{"index": 0, "id": f"call_{len(script.calls)}", "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}
            return self.send(200, chat(head) + chat({}, "tool_calls") + "data: [DONE]\n\n")
        usage = {"prompt_tokens": script.tokens, "completion_tokens": 1, "total_tokens": script.tokens + 1}
        self.send(200, chat({"content": "好"}) + chat({}, "stop", usage) + "data: [DONE]\n\n")

    def on_claude(self, body):
        """The upstream's search."""
        self.send(200, claude_reply([
            {"type": "server_tool_use", "id": "s", "name": "web_search", "input": {}},
            {"type": "web_search_tool_result", "tool_use_id": "s", "content": [{"type": "web_search_result", "url": "https://news.example.com/a", "title": "新闻", "page_age": None, "encrypted_content": "x"}]},
            {"type": "text", "text": PAGE},
        ]))

    def log_message(self, *_args):
        """Silence."""


def run(script, prompts, ctx="128k"):
    """One program run; returns the temporary folder's listing of drafts and the script."""
    Upstream.script = script
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = tempfile.mkdtemp(prefix="jw-prompt-")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("JW_", "PI_", "SF_", "PROMPT_ADD", "ANYSEARCH_"))}
    env.update(
        HOME=tmp, JW_DIR=os.path.join(tmp, "agent"), JW_LANG="zh", JW_CTX=ctx,
        JW_URL=f"http://127.0.0.1:{server.server_address[1]}", JW_KEY="sk-dummy-prompt-check", JW_MODEL="mock-model",
        JW_API="openai-completions", JW_EFFORT="off",
    )
    program = sys.argv[1:]
    if program:
        program[0] = os.path.abspath(program[0])
    else:
        coding = os.path.join(ROOT, "packages", "coding-agent")
        program = ["node", "--import", "file://" + os.path.join(coding, "src", "experimental", "source-resolver.ts"), os.path.join(coding, "src", "cli.ts")]
    out = subprocess.run(program + ["-p", *prompts], cwd=tmp, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    server.shutdown()
    shutil.rmtree(tmp, ignore_errors=True)
    return out


def text_of(request):
    """Everything sent, as one string."""
    return json.dumps(request["messages"], ensure_ascii=False)


def system_of(request):
    """The system prompt."""
    return str(request["messages"][0]["content"])


def main():
    """Run the scenarios and print the results."""
    results = []
    check = lambda name, ok: results.append((name, bool(ok)))

    # A plain chat: core only.
    chat_only = Script([])
    run(chat_only, ["你好"])
    first = chat_only.requests[0]
    system = system_of(first)
    tools = len(json.dumps(first.get("tools", []), ensure_ascii=False))
    check(f"闲聊只有核心内容：系统提示 {len(system)} 字符，工具说明 {tools} 字符", len(system) <= 5000 and tools <= 9500)
    check("闲聊时没有任何手册", not any(w in text_of(first) for w in ("Writing rules", "Research rules", "2026年10月31日")))
    said = json.dumps(first["messages"][1:], ensure_ascii=False)
    check("日期只有一个 [Date: …]，没有其他时间", said.count("[Date: ") == 1 and "[Sent" not in said)

    # A topic, then searches.
    topic = Script([
        ("topic_open", {"name": "绿化"}),
        ("search_web", {"query": "甲", "method": "claude"}),
        ("search_web", {"query": "乙", "method": "claude", "engines": None, "pages": "x"}),
        ("topic_open", {"name": "绿化"}),
    ])
    run(topic, ["写一份报告"])
    last = text_of(topic.requests[-1])
    check("只搜索时没有写作手册", "Writing rules:" not in last)
    check("工具结果不提稿件", "稿件放在" not in last)
    check("第一次搜索出现检索手册和该方式规则，各一次", last.count("Research rules:") == 1 and last.count("Method claude of search_web:") == 1)
    check("错误参数被清理，搜索照常完成", last.count("检索结果（claude") == 2)
    check("没有生效的参数告诉模型", "它们没有生效：pages" in last)
    check("工具结果不含时间", "检索时间" not in last)
    check("系统提示全程不变", len({system_of(r) for r in topic.requests}) == 1)

    # A draft without a topic.
    bare = Script([("write", {"path": "稿.md", "content": "正文"}), ("write", {"path": "稿二.md", "content": "正文"})])
    run(bare, ["写一段"])
    check("开始写时收到写作手册，只有一次", text_of(bare.requests[-1]).count("Writing rules:") == 1)

    # Compaction with a working summary.
    full = Script([("topic_open", {"name": "绿化"}), ("search_web", {"query": "甲", "method": "claude"}), ("search_web", {"query": "乙", "method": "claude"})], tokens=110_000)
    run(full, ["写报告，要三节", "继续写"])
    check("用量到 80% 时压缩", len(full.summaries) >= 1)
    summary_in = full.summaries[0] if full.summaries else ""
    after = text_of(full.requests[-1])
    check("摘要请求里没有搜索全文", "页面正文内容" not in summary_in)
    check("压缩后带写作状态和用户原话", "写作状态" in after and "写报告，要三节" in after)
    check("压缩后保留模型写的决定", "定了三节" in after)
    check("只有检索时压缩后不要求读稿件", "先读大纲和当前稿件" not in after)
    check("只有检索时压缩后不发写作手册", "Writing rules:" not in after)

    # Compaction with a document under way.
    draft = Script([("topic_open", {"name": "绿化"}), ("write", {"path": f"{time.strftime('%Y%m%d')}-绿化/稿件/初稿.md", "content": "正文"}), ("search_web", {"query": "甲", "method": "claude"}), ("search_web", {"query": "乙", "method": "claude"})], tokens=110_000)
    run(draft, ["写报告", "继续写"])
    after = text_of(draft.requests[-1])
    check("写作中压缩后要求先读大纲和稿件", "先读大纲和当前稿件" in after)
    check("写作中压缩后重发写作手册", "Writing rules:" in after)

    # Research before the topic has a name.
    late = Script([("search_web", {"query": "甲", "method": "claude"}), ("topic_open", {"name": "绿化"}), ("material_add", {"items": [{"kind": "case", "time": "2026年", "reporter": "路透社", "subject": "甲", "action": "乙", "url": "https://news.example.com/a"}]})])
    run(late, ["查一下再写"])
    last = text_of(late.requests[-1])
    check("先搜索后开主题，资料并入主题", "已建立主题文件夹" in last and f"{time.strftime('%Y%m%d')}-绿化" in last and "已记录" in last)

    # Compaction when the summary fails.
    broken = Script([("topic_open", {"name": "绿化"}), ("search_web", {"query": "甲", "method": "claude"}), ("search_web", {"query": "乙", "method": "claude"})], tokens=110_000, summary_fails=True)
    out = run(broken, ["写报告，要三节", "继续写"])
    after = text_of(broken.requests[-1])
    check("摘要接口失败时状态和用户原话仍在", "写作状态" in after and "写报告，要三节" in after)
    check("摘要失败后下一条消息正常", out.returncode == 0)

    for name, ok in results:
        print(f"{'PASS' if ok else 'FAIL'}  {name}")
    failed = sum(1 for r in results if not r[1])
    print(f"{len(results) - failed}/{len(results)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

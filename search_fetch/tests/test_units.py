#!/usr/bin/env python3
"""Unit coverage for every non-browser function in the engine (cli/fetch/filters/browser helpers).

Needs the venv (crawl4ai/mcp) but NO browser, NO real LLM, NO network: browser
calls use fake pages/elements, the local LLM is mocked, crawl4ai runs on synthetic
HTML. Isolated under ~/Downloads/tmp. Run: <venv>/bin/python3 tests/test_units.py
"""
import asyncio
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

_PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_PROJ, "src"))
_TMPBASE = Path(__file__).resolve().parent / "tmp"  # scratch INSIDE the repo tree
_TMPBASE.mkdir(parents=True, exist_ok=True)
_TMP = tempfile.mkdtemp(prefix="units-", dir=str(_TMPBASE))

from search_fetch import artifacts, browser, cli, config, fetch, filters, markdown  # noqa: E402
from search_fetch import search as search_mod  # noqa: E402

_fail = 0


def check(name, cond):
    global _fail
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        _fail += 1


# ── fakes ───────────────────────────────────────────────────────────
class FakeEl:
    def __init__(self):
        self.calls = []
    async def send_keys(self, k):
        self.calls.append(("send_keys", str(k)))
    async def scroll_into_view(self):
        self.calls.append(("scroll_into_view",))
    async def click(self):
        self.calls.append(("click",))


class FakePage:
    """Stand-in for browser.ExtPage: records every page script it is asked to run."""
    def __init__(self):
        self.evals = []
    async def run(self, script, args=None, world="ISOLATED"):
        self.evals.append(("run", script, args or {}, world))
        return "{}"
    async def activate(self):
        self.evals.append(("activate",))
    async def input(self, op, **args):
        self.evals.append((op, args))
        return {}
    async def wait(self, t):
        pass


def run():
    # ── engine I/O helpers (temp cwd) ──
    cwd = os.getcwd()
    os.chdir(_TMP)
    try:
        check("_outdir creates .search_fetchres", artifacts._outdir().is_dir())
        artifacts._append_index("fetch", "subject", ["a_fit.md", "a_raw.md"], "http://src")
        check("_append_index writes table", (artifacts._outdir() / "index.md").read_text().count("|") > 4)
        fit, raw = artifacts._save_results("http://u", "http://final", {"fit": "FITMD", "raw": "RAWMD"},
                                        {"title": "T", "desc": "D", "lang": "en"})
        check("_save_results writes fit+raw", Path(fit).read_text().endswith("FITMD") and Path(raw).read_text().endswith("RAWMD"))
        blocks = [{"engine": "e", "page": 1, "url": "http://r", "markdown": "MD", "lang": "en"}]
        fb = artifacts._format_blocks("q", blocks)
        check("_format_blocks renders", "e/en · page 1" in fb and "MD" in fb)
        sp = artifacts._save_search("q", blocks, artifacts._outdir() / "x.ops.jsonl")
        check("_save_search writes", Path(sp).exists())
        es = artifacts._save_empty_serp(artifacts._outdir() / "search-q_1.ops.jsonl", "bing", 2, "http://r", "PAGE")
        check("_save_empty_serp keeps the empty page", es.name == "search-q_1.bing-p2-empty.md" and es.read_text() == "<!-- url: http://r -->\n\nPAGE")
        check("_save_empty_serp without a trace is a no-op", artifacts._save_empty_serp(None, "bing", 1, "u", "m") is None)
        ops = artifacts._outdir() / "t.ops.jsonl"
        artifacts._trace(ops, {"k": "v"})
        artifacts._trace(None, {"k": "v"})  # no-op path
        check("_trace appends jsonl", json.loads(ops.read_text().splitlines()[0])["k"] == "v")
    finally:
        os.chdir(cwd)

    # ── _act (fake page, all actions) ──
    p = FakePage()
    asyncio.run(browser._act(p, {"action": "type", "target_id": "wf0", "text": "hello"}))
    check("_act type → trusted typing with Enter", p.evals == [("human_type", {"target": {"wfId": "wf0"}, "text": "hello", "enter": True})])
    p = FakePage()
    asyncio.run(browser._act(p, {"action": "press_enter", "target_id": "wf0"}))
    check("_act press_enter → click into the field and Enter", p.evals == [("human_type", {"target": {"wfId": "wf0"}, "text": "", "enter": True})])
    p = FakePage()
    asyncio.run(browser._act(p, {"action": "click", "target_id": "wf1"}))
    # click is a trusted mouse click by the extension (chrome.debugger Input events)
    check("_act click", p.evals == [("human_click", {"target": {"wfId": "wf1"}})])
    p = FakePage()
    asyncio.run(browser._act(p, {"action": "scroll"}))
    check("_act scroll", p.evals == [("human_scroll", {"steps": 4})])

    # ── _human_wait (mock _observe) ──
    saved_obs, saved_hw, saved_hp = browser._observe, config.HUMAN_WAIT, config.HUMAN_POLL
    try:
        config.HUMAN_WAIT, config.HUMAN_POLL = 0.6, 0.01
        seq = [{"challengeIframe": True, "title": "", "excerpt": ""},
               {"challengeIframe": False, "title": "ok", "excerpt": "y" * 400}]
        st = {"i": 0}
        async def fake_obs_clear(page):
            i = min(st["i"], len(seq) - 1)
            st["i"] += 1
            return seq[i]
        browser._observe = fake_obs_clear
        check("_human_wait clears → True", asyncio.run(browser._human_wait(FakePage(), {"url": "u"})) is True)
        config.HUMAN_WAIT = 0.05
        async def fake_obs_block(page):
            return {"challengeIframe": True, "title": "", "excerpt": ""}
        browser._observe = fake_obs_block
        check("_human_wait timeout → False", asyncio.run(browser._human_wait(FakePage(), {"url": "u"})) is False)
        # Activity extension: budget alone would expire, but ongoing mouse/key activity
        # keeps extending the deadline until the challenge clears.
        saved_ag, saved_wm = config.HUMAN_ACTIVITY_GRACE, config.HUMAN_WAIT_MAX
        config.HUMAN_WAIT, config.HUMAN_ACTIVITY_GRACE, config.HUMAN_WAIT_MAX = 0.05, 0.06, 1.0
        class ActivePage(FakePage):
            def __init__(self):
                super().__init__()
                self.t = 0
            async def run(self, script, args=None, world="ISOLATED"):
                if script == "activity_last":
                    self.t += 1000
                    return self.t
                return await super().run(script, args, world)
        seq2 = [{"challengeIframe": True, "title": "", "excerpt": ""}] * 12 +                [{"challengeIframe": False, "title": "ok", "excerpt": "y" * 400}]
        st2 = {"i": 0}
        async def fake_obs_slow(page):
            i = min(st2["i"], len(seq2) - 1)
            st2["i"] += 1
            return seq2[i]
        browser._observe = fake_obs_slow
        check("_human_wait activity extends past budget → True",
              asyncio.run(browser._human_wait(ActivePage(), {"url": "u"})) is True)
        config.HUMAN_ACTIVITY_GRACE, config.HUMAN_WAIT_MAX = saved_ag, saved_wm
    finally:
        browser._observe, config.HUMAN_WAIT, config.HUMAN_POLL = saved_obs, saved_hw, saved_hp

    # ── _await_content (adaptive fetch wait state machine; mock _probe) ──
    saved_probe = browser._probe
    saved_cfg = (config.FETCH_CHALLENGE_WAIT, config.FETCH_SETTLE_MAX, config.FETCH_POLL)
    try:
        config.FETCH_POLL = 0.01
        config.FETCH_SETTLE_MAX = 0.06
        config.FETCH_CHALLENGE_WAIT = 0.1

        def probe_seq(seq):
            st = {"i": 0}
            async def _p(page):
                i = min(st["i"], len(seq) - 1)
                st["i"] += 1
                return seq[i]
            return _p

        CONTENT = {"challengeIframe": False, "title": "n", "excerpt": "y" * 600, "textLen": 600}
        GROWN = {"challengeIframe": False, "title": "n", "excerpt": "y" * 700, "textLen": 900}
        CHAL = {"challengeIframe": True, "title": "Just a moment...", "excerpt": "x" * 30, "textLen": 30}
        BLANK = {"challengeIframe": False, "title": "", "excerpt": "", "textLen": 0}

        browser._probe = probe_seq([CONTENT, CONTENT])
        v, _o = asyncio.run(browser._await_content(FakePage(), "u"))
        check("_await_content stable content → content", v == "content")

        browser._probe = probe_seq([CONTENT, GROWN, GROWN])
        v, _o = asyncio.run(browser._await_content(FakePage(), "u"))
        check("_await_content waits for growth to stop", v == "content")

        browser._probe = probe_seq([CHAL])
        v, _o = asyncio.run(browser._await_content(FakePage(), "u"))
        check("_await_content persistent challenge → challenge", v == "challenge")

        browser._probe = probe_seq([CHAL, CHAL, CHAL, BLANK, CONTENT, CONTENT])
        v, _o = asyncio.run(browser._await_content(FakePage(), "u"))
        check("_await_content challenge clears → content", v == "content")

        browser._probe = probe_seq([BLANK])
        v, _o = asyncio.run(browser._await_content(FakePage(), "u"))
        check("_await_content stays blank → blank", v == "blank")

        browser._probe = probe_seq([BLANK, BLANK, CONTENT, CONTENT])
        v, _o = asyncio.run(browser._await_content(FakePage(), "u"))
        check("_await_content late content → content", v == "content")
    finally:
        browser._probe = saved_probe
        config.FETCH_CHALLENGE_WAIT, config.FETCH_SETTLE_MAX, config.FETCH_POLL = saved_cfg

    # ── _html_to_markdown (None / False / explicit BM25) on synthetic HTML ──
    html = "<h1>Title</h1><p>The launch date is June 2026 and pricing is 42.</p><nav>menu</nav>"
    md_none = markdown._html_to_markdown(html, "http://x")
    check("_html_to_markdown default has fit+raw", md_none["raw"] and md_none["fit"])
    md_raw = markdown._html_to_markdown(html, "http://x", content_filter=False)
    check("_html_to_markdown False → raw only", md_raw["raw"] and md_raw["fit"] == "")

    # ── filters ──
    check("_is_ascii ascii", filters._is_ascii("abc") is True)
    check("_is_ascii non-ascii", filters._is_ascii("中文") is False)
    bm = filters.bm25_fit(html, "http://x", "launch date pricing")
    check("bm25_fit returns raw+fit+matched", bm["raw"] and "matched" in bm)
    bm0 = filters.bm25_fit(html, "http://x", "zzzznomatchqqqq")
    check("bm25_fit no-match falls back", bm0["fit"])  # falls back to de-noised
    check("bm25_fit no-match flagged", bm0["matched"] is False)
    # CJK query on a Chinese page: crawl4ai BM25 tokenizes by whitespace, so this is
    # the systematic no-match case — the de-noised page must still come back as fit
    # (this is what actually enters the caller's corpus/KB; a "fit=0B" log line
    # does NOT mean lost content).
    zh_html = "<h1>通知</h1><p>江苏省概念验证中心建设工作指引，面积120万平方米，规模巨大。</p><nav>menu</nav>"
    bmzh = filters.bm25_fit(zh_html, "http://x", "概念验证中心 指引")
    check("bm25_fit CJK fallback keeps content", "概念验证中心" in bmzh["fit"])

    # ── cli.main() CLI (fetch / search / bad-engine), browser+render+search mocked ──
    saved_argv = sys.argv
    sc, sr, ss, se = browser._connect, fetch._render, search_mod.search, config.ENGINES
    # Hermetic: the fetch branch's URL policy resolves the host and docparse sniffs it —
    # pin a public documentation address and refuse every real connection.
    from search_fetch import docparse, url_guard
    s_resolve, s_open = url_guard._resolve, docparse._urlopen
    url_guard._resolve = lambda host, port: ["93.184.215.14"]
    def _no_net(req, timeout=None):
        raise OSError("network disabled in unit tests")
    docparse._urlopen = _no_net
    os.chdir(_TMP)
    try:
        async def fake_connect():
            return object()
        async def fake_render(br, url):
            return (None, "<h1>Doc</h1><p>hello world body text here</p>", {"title": "T"}, url)
        async def fake_search(q, eng, pages, lang=None, region=None, browser=None, fresh=None):
            return ([{"engine": eng[0], "page": 1, "url": "http://r", "markdown": "MDBODY"}],
                    artifacts._outdir() / "s.ops.jsonl")
        browser._connect, fetch._render, search_mod.search = fake_connect, fake_render, fake_search
        config.ENGINES = {"fixture": (lambda lang, region: "http://x")}

        sys.argv = ["sf.py", "fetch", "http://x/doc"]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cli.main()
        check("main() fetch branch", "Doc" in out.getvalue() or "hello" in out.getvalue())

        (artifacts._outdir() / "s.ops.jsonl").write_text("")
        sys.argv = ["sf.py", "search", "q", "--engine", "fixture"]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            cli.main()
        check("main() search branch", "MDBODY" in out.getvalue())

        sys.argv = ["sf.py", "search", "q", "--engine", "nosuchengine"]
        try:
            cli.main()
            raised = False
        except SystemExit:
            raised = True
        check("main() bad-engine exits", raised)
    finally:
        sys.argv = saved_argv
        browser._connect, fetch._render, search_mod.search, config.ENGINES = sc, sr, ss, se
        url_guard._resolve, docparse._urlopen = s_resolve, s_open
        os.chdir(cwd)

    # ── cheap branch coverage ──
    check("_clamp_chars max<=0 passthrough", markdown._clamp_chars("abc", 0) == "abc")

    # ── engine time-range params (_fresh_param via _page_url) ──
    check("google fresh month", "&tbs=qdr:m" in search_mod._page_url("google", "q", 1, None, None, "month"))
    check("bing fresh week", 'filters=ex1%3a%22ez2%22' in search_mod._page_url("bing", "q", 1, None, None, "week"))
    check("ddg fresh day", "&df=d" in search_mod._page_url("duckduckgo", "q", 1, None, None, "day"))
    check("brave fresh year", "&tf=py" in search_mod._page_url("brave", "q", 1, None, None, "year"))
    check("sogou fresh month", "&tsn=3" in search_mod._page_url("sogou", "q", 1, None, None, "month"))
    check("baidu fresh has gpc range", "&gpc=stf%3D" in search_mod._page_url("baidu", "q", 1, None, None, "month"))
    check("no fresh -> clean url", "tbs=" not in search_mod._page_url("google", "q", 1, None, None, None))
    check("unknown window -> no param", search_mod._page_url("google", "q", 1, None, None, "decade").endswith("start=0"))

    print("\nUNITS:", "PASS ✓" if _fail == 0 else f"{_fail} FAILED ✗")
    shutil.rmtree(_TMP, ignore_errors=True)
    return _fail == 0


if __name__ == "__main__":
    sys.exit(0 if run() else 1)

#!/usr/bin/env python3
"""Direct unit tests for the bridge page API (browser.ExtPage/ExtBrowser and helpers), the
host's client and frame handlers, and the search helpers (freshness parameters, SERP
markdown, pagination layers, consent, one engine run) — with a scripted
fake page and the bridge mocked. No browser, no network.
Run: python3 tests/test_browser_search_units.py
"""
# Async helpers under test.
import asyncio
import contextlib
import io
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

# Import the package from ./src.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from search_fetch import bridge, browser, config  # noqa: E402
from search_fetch import search as search_mod  # noqa: E402


class ScriptedPage:
    """ExtPage stand-in: page scripts answer from `answers` (values or callables), every call is recorded."""

    def __init__(self, answers=None, url="https://www.example.com/search?q=x"):
        # Script name → value or callable(args).
        self.answers = answers or {}
        # Current address.
        self.url = url
        # Recorded calls.
        self.calls = []

    async def run(self, script, args=None, world="ISOLATED"):
        # Record and answer.
        self.calls.append((script, args or {}))
        a = self.answers.get(script)
        return a(args or {}) if callable(a) else a

    async def get(self, url):
        # Navigation.
        self.calls.append(("get", url))
        self.url = url

    async def input(self, op, **args):
        # Trusted input: recorded, answered like a page script of the same name.
        self.calls.append((op, args))
        a = self.answers.get(op)
        return a(args) if callable(a) else a

    async def back(self):
        # History step.
        self.calls.append(("back",))

    async def get_content(self):
        # Fixed HTML.
        return "<html><body><p>serp</p></body></html>"

    async def wait(self, seconds):
        # No real sleep.
        pass

    async def close(self):
        # Record.
        self.calls.append(("close",))


def run_async(coro):
    """Run a coroutine with sleeps and pacing neutralised."""
    # No real waiting anywhere.
    async def no_sleep(*a, **k):
        return None
    with mock.patch.object(asyncio, "sleep", no_sleep), mock.patch("search_fetch.pacing.before_navigation", no_sleep):
        return asyncio.run(coro)


class BridgePageTest(unittest.TestCase):
    def test_timeouts(self):
        # Load wait in ms and the request timeout with its margin.
        with mock.patch.object(config, "READY_TIMEOUT", 8):
            self.assertEqual((browser._load_ms(), browser._request_timeout()), (8000, 23))

    def test_ext_page_methods_send_the_right_ops(self):
        # Every method maps to one bridge op with the tab id.
        sent = []

        async def fake_acall(op, timeout=None, **args):
            sent.append((op, args))
            return {"tab": 7, "url": "https://b.example/", "title": "B", "timedOut": True} if op in ("navigate", "back") else "<html/>"

        page = browser.ExtPage({"tab": 7, "url": "https://a.example/", "title": "A"})
        self.assertEqual((page.url, page.title, page.timed_out), ("https://a.example/", "A", False))
        with mock.patch.object(bridge, "acall", fake_acall):
            asyncio.run(page.get("https://b.example/"))
            self.assertEqual((page.url, page.title, page.timed_out), ("https://b.example/", "B", True))
            asyncio.run(page.back())
            self.assertEqual(asyncio.run(page.get_content()), "<html/>")
            asyncio.run(page.run("probe", world="MAIN"))
            asyncio.run(page.activate())
            asyncio.run(page.input("human_click", target={"wfId": "wf2"}))
            asyncio.run(page.close())
        self.assertEqual([op for op, _ in sent], ["navigate", "back", "run", "run", "activate", "human_click", "close"])
        self.assertEqual(sent[5][1]["target"], {"wfId": "wf2"})
        self.assertEqual((sent[5][1]["tab"], sent[5][1]["load_ms"]), (7, browser._load_ms()))
        self.assertEqual(sent[3][1], {"tab": 7, "script": "probe", "args": {}, "world": "MAIN"})
        page._set({"url": "u"})
        self.assertEqual((page.url, page.title), ("u", ""))

    def test_ext_browser_connect_and_open(self):
        # status on connect; open tags the run id.
        sent = []

        async def fake_acall(op, timeout=None, **args):
            sent.append((op, args))
            return {"version": "1.0.0"} if op == "status" else {"tab": 3, "url": args.get("url", ""), "title": ""}

        with mock.patch.object(bridge, "acall", fake_acall), mock.patch.dict(config.SESSION, {"run_id": "r9"}), \
                contextlib.redirect_stderr(io.StringIO()):
            br = asyncio.run(browser._connect())
            page = run_async(browser._open(br, "https://c.example/", engine="google"))
        self.assertEqual(page.tab, 3)
        self.assertEqual(sent[1][0], "open")
        self.assertEqual((sent[1][1]["url"], sent[1][1]["run"]), ("https://c.example/", "r9"))

    def test_ready_pace_dwell_bounds(self):
        # Sleeps requested by the human-cadence helpers stay in their documented bounds.
        slept = []

        async def rec(s):
            slept.append(s)

        with mock.patch.object(asyncio, "sleep", rec):
            asyncio.run(browser._ready(None))
            asyncio.run(browser._pace())
            asyncio.run(browser._dwell(None, 4))
        self.assertLessEqual(slept[0], 0.6)
        self.assertTrue(config.CLICK_PAUSE <= slept[1] <= 2 * config.CLICK_PAUSE)
        self.assertTrue(2.0 <= slept[2] <= 4.4)

    def test_close_page(self):
        # Closes the tab; None and a tab the user already closed are fine.
        page = ScriptedPage()
        asyncio.run(browser._close_page(page))
        self.assertEqual(page.calls, [("close",)])
        asyncio.run(browser._close_page(None))

        class Gone(ScriptedPage):
            async def close(self):
                raise RuntimeError("no such tab")
        asyncio.run(browser._close_page(Gone()))

    def test_activity_probe(self):
        # Install then read; failures give 0.
        page = ScriptedPage({"activity_last": 1234})
        asyncio.run(browser._install_activity_probe(page))
        self.assertEqual(asyncio.run(browser._last_activity(page)), 1234.0)
        self.assertEqual(page.calls[0][0], "activity_install")
        bad = ScriptedPage({"activity_last": lambda a: 1 / 0})
        self.assertEqual(asyncio.run(browser._last_activity(bad)), 0.0)



class HostHandlersTest(unittest.TestCase):
    def test_handle_client_success_and_error(self):
        # One request line in, one reply line out; a bad request becomes an error reply.
        class Writer:
            def __init__(self):
                self.data, self.closed = b"", False

            def write(self, b):
                self.data += b

            async def drain(self):
                pass

            def close(self):
                self.closed = True

        async def go(line, reply):
            h = bridge.Host(io.BytesIO())
            h.request = mock.AsyncMock(return_value=reply)
            r = asyncio.StreamReader()
            r.feed_data(line)
            r.feed_eof()
            w = Writer()
            await h.handle_client(r, w)
            return json.loads(w.data), w.closed

        out, closed = asyncio.run(go(b'{"op":"status","args":{},"timeout":1}\n', {"ok": True, "result": 1}))
        self.assertEqual((out, closed), ({"ok": True, "result": 1}, True))
        out, _ = asyncio.run(go(b"not json\n", {}))
        self.assertFalse(out["ok"])

    def test_read_frames_skips_malformed_and_ends_on_eof(self):
        # A good frame, a malformed one, then EOF.
        async def go():
            h = bridge.Host(io.BytesIO())
            r = asyncio.StreamReader()
            r.feed_data(bridge.encode_frame({"hello": "2"}))
            # A 3-byte body that is not JSON.
            r.feed_data(struct.pack("=I", 3) + b"{x}")
            r.feed_eof()
            with contextlib.redirect_stderr(io.StringIO()):
                await bridge._read_frames(r, h)
            return h.version

        self.assertEqual(asyncio.run(go()), "2")


class SearchHelpersTest(unittest.TestCase):
    def test_fresh_param(self):
        # One engine-native parameter per engine; unknown windows and engines give "".
        self.assertEqual(search_mod._fresh_param("google", "day"), "&tbs=qdr:d")
        self.assertEqual(search_mod._fresh_param("bing", "week"), "&filters=ex1%3a%22ez2%22")
        self.assertEqual(search_mod._fresh_param("startpage", "year"), "&with_date=y")
        self.assertTrue(search_mod._fresh_param("baidu", "day").startswith("&gpc=stf%3D"))
        self.assertEqual((search_mod._fresh_param("sogou", "year"), search_mod._fresh_param("x", "day"),
                          search_mod._fresh_param("google", None)), ("", "", ""))

    def test_serp_results(self):
        # The JSON list from ops/results.js; a failing script gives [].
        page = ScriptedPage({"results": json.dumps([{"u": "https://a.example/", "t": "A"}])})
        self.assertEqual(asyncio.run(search_mod._serp_results(page)), [{"u": "https://a.example/", "t": "A"}])
        self.assertEqual(asyncio.run(search_mod._serp_results(ScriptedPage({"results": lambda a: 1 / 0}))), [])
        self.assertEqual(asyncio.run(search_mod._serp_results(ScriptedPage({"results": "null"}))), [])

    def test_serp_markdown_and_page_facts(self):
        # Markdown plus the result link list; extent, URL and off-track detection.
        page = ScriptedPage({"url": "https://s.example/r", "results": json.dumps([{"u": "https://a.example/", "t": "A"}]),
                             "extent": "512"})
        with mock.patch("search_fetch.markdown._html_to_markdown", return_value={"fit": "正文", "raw": ""}):
            md = asyncio.run(search_mod._serp_markdown(page))
        self.assertEqual(md, "正文\n\n## 检索结果链接\n- [A](https://a.example/)")
        self.assertEqual((asyncio.run(search_mod._content_extent(page)), asyncio.run(search_mod._cur_url(page))), (512, "https://s.example/r"))
        self.assertEqual(asyncio.run(search_mod._content_extent(ScriptedPage({"extent": None}))), 0)
        self.assertTrue(search_mod._is_offtrack("https://s.example/settings"))
        self.assertFalse(search_mod._is_offtrack("https://s.example/search?q=x"))

    def test_go_back_and_on_results(self):
        # _go_back steps back in history; a failing back is swallowed.
        page = ScriptedPage()
        run_async(search_mod._go_back(page))
        self.assertEqual(page.calls, [("back",)])

        class Broken(ScriptedPage):
            async def back(self):
                raise RuntimeError("tab gone")
        run_async(search_mod._go_back(Broken()))
        # Off-track pages go back and report False; result pages report True.
        page = ScriptedPage({"url": "https://s.example/preferences"})
        self.assertFalse(run_async(search_mod._on_results(page, "base")))
        self.assertIn(("back",), page.calls)
        page = ScriptedPage({"url": "https://s.example/search", "results": json.dumps([{"u": "x", "t": "y"}])})
        self.assertTrue(run_async(search_mod._on_results(page, "base")))

    def test_next_page_layers(self):
        # Layer 1: a nextish control is clicked and the URL moves to a results page.
        state = {"url": "https://s.example/search?p=1"}

        def click(args):
            state["url"] = "https://s.example/search?p=2"
            return True

        obs = json.dumps({"elements": [{"id": "wf3", "nextish": True, "text": "Next"}]})
        page = ScriptedPage({"url": lambda a: state["url"], "extent": "100", "observe": obs, "human_click": click,
                             "results": json.dumps([{"u": "https://r.example/", "t": "r"}])})
        self.assertTrue(run_async(search_mod._next_page(page, 1)))
        self.assertIn(("human_click", {"target": {"wfId": "wf3"}}), page.calls)
        # Pagination comes into view by wheel turns, not a scripted scroll.
        self.assertIn(("human_scroll", {"steps": 5, "px": 800}), page.calls)
        # Layer 1b: the Next link is tagged by its script, then clicked with trusted input.
        state["url"] = "https://s.example/search?p=1"
        page = ScriptedPage({"url": lambda a: state["url"], "extent": "100", "observe": json.dumps({"elements": []}),
                             "next_link": True, "human_click": click, "results": json.dumps([{"u": "https://r.example/", "t": "r"}])})
        self.assertTrue(run_async(search_mod._next_page(page, 1)))
        self.assertIn(("human_click", {"target": {"wfId": "wfnext"}}), page.calls)
        # Layer 3: nothing to click, but infinite scroll grows the page.
        grow = {"n": 100}

        def extent(args):
            grow["n"] += 200
            return str(grow["n"])

        page = ScriptedPage({"url": "https://s.example/web", "extent": extent, "observe": json.dumps({"elements": []}),
                             "next_link": False, "more_button": False})
        self.assertTrue(run_async(search_mod._next_page(page, 1)))
        # Nothing works (no model fallback): no advance.
        page = ScriptedPage({"url": "https://s.example/web", "extent": "100", "observe": json.dumps({"elements": []}),
                             "next_link": False, "more_button": False})
        self.assertFalse(run_async(search_mod._next_page(page, 1)))

    def test_accept_consent(self):
        # The accept-worded consent control is clicked; none → False.
        obs = {"elements": [{"id": "a", "consentish": True, "text": "Settings"}, {"id": "b", "consentish": True, "text": "Accept all"},
                            {"id": "c", "consentish": True, "avoid": True, "text": "Accept"}]}
        page = ScriptedPage({"human_click": {"clicked": True}})
        self.assertTrue(run_async(search_mod._accept_consent(page, obs)))
        self.assertIn(("human_click", {"target": {"wfId": "b"}}), page.calls)
        self.assertFalse(run_async(search_mod._accept_consent(ScriptedPage(), {"elements": []})))

    def test_run_engine_results_and_challenge(self):
        # Page 1 with results: one block, the tab closed afterwards.
        good = ScriptedPage({"results": json.dumps([{"u": "https://r.example/", "t": "R"}]), "url": "https://www.google.com/search?q=x"})
        with mock.patch.object(browser, "_open", mock.AsyncMock(return_value=good)), \
                mock.patch.object(search_mod, "_serp_markdown", mock.AsyncMock(return_value="md")), \
                contextlib.redirect_stderr(io.StringIO()):
            blocks = run_async(search_mod._run_engine(object(), "google", "x", 1, None, None, None))
        self.assertEqual([(b["engine"], b["page"], b["markdown"], len(b["results"])) for b in blocks], [("google", 1, "md", 1)])
        self.assertEqual(good.calls[-1], ("close",))
        # A challenged page 1 without human wait: no block, the stage is traced.
        walled = ScriptedPage({"results": "[]", "observe": json.dumps({"challengeIframe": True, "excerpt": "", "title": "",
                                                                       "elements": []})})
        traced = []
        with mock.patch.object(browser, "_open", mock.AsyncMock(return_value=walled)), \
                mock.patch.object(config, "ALLOW_HUMAN_WAIT", False), \
                mock.patch("search_fetch.artifacts._trace", side_effect=lambda ops, rec: traced.append(rec["stage"])), \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(run_async(search_mod._run_engine(object(), "google", "x", 1, None, None, "ops")), [])
        self.assertEqual(traced, ["challenged"])
        # An unchallenged page 1 without result links: no block, the page kept beside the trace.
        empty = ScriptedPage({"results": "[]", "observe": json.dumps({"challengeIframe": False, "excerpt": "", "title": "",
                                                                      "elements": []})})
        with tempfile.TemporaryDirectory() as d:
            ops = Path(d) / "search-x_abc.ops.jsonl"
            with mock.patch.object(browser, "_open", mock.AsyncMock(return_value=empty)), \
                    mock.patch.object(search_mod, "_serp_markdown", mock.AsyncMock(return_value="EMPTY-SERP")), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(run_async(search_mod._run_engine(object(), "startpage", "x", 1, None, None, ops)), [])
            rec = json.loads(ops.read_text().splitlines()[-1])
            self.assertEqual((rec["stage"], rec["saved"]), ("no_results", "search-x_abc.startpage-p1-empty.md"))
            self.assertTrue((Path(d) / rec["saved"]).read_text().endswith("EMPTY-SERP"))


if __name__ == "__main__":
    # Run with the conventional summary line for run_all.sh.
    result = unittest.main(exit=False, verbosity=1).result
    print("\nBROWSER+SEARCH UNITS:", "PASS ✓" if result.wasSuccessful() else "FAILED ✗")
    sys.exit(0 if result.wasSuccessful() else 1)

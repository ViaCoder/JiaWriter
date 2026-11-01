#!/usr/bin/env python3
"""SEARCH_FETCH_ONLY_KNOWN_URLS — opt-in exfiltration guard. Offline (fake search,
fake browser, fake resolver); scratch under tests/tmp/. Run: python3 tests/test_known_urls.py
"""
import asyncio
import contextlib
import io
import os
import shutil
import sys
import tempfile
from pathlib import Path

_PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_PROJ, "src"))
_TMPBASE = Path(__file__).resolve().parent / "tmp"
_TMPBASE.mkdir(parents=True, exist_ok=True)
_TMP = Path(tempfile.mkdtemp(prefix="known-", dir=str(_TMPBASE)))
os.environ.pop("SEARCH_FETCH_ONLY_KNOWN_URLS", None)

# Offline: kb.py loads the cl100k tokenizer at import, and tiktoken DOWNLOADS it on a
# cache miss. Tests must never touch the network, so force kb's documented fallback
# token counter (the logic under test does not depend on exact token ids).
import types as _types  # noqa: E402

_tt = _types.ModuleType("tiktoken")
def _offline_get_encoding(name):
    raise RuntimeError("tokenizer download disabled in tests")
_tt.get_encoding = _offline_get_encoding
sys.modules["tiktoken"] = _tt
from search_fetch import browser, cli, config, docparse, fetch, known_urls, url_guard  # noqa: E402
from search_fetch import search as search_mod  # noqa: E402

_fail = 0


def check(name, cond):
    global _fail
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        _fail += 1


@contextlib.contextmanager
def run_scope(run_id, only_known):
    """A run-scoped ledger under a test HOME + the opt-in flag."""
    home = _TMP / "home"
    saved = (config.HOME, config.RUN_DIR, os.environ.get("SEARCH_FETCH_ONLY_KNOWN_URLS"))
    config.HOME = home
    config.RUN_DIR = home / "runs" / run_id if run_id else None
    if only_known:
        os.environ["SEARCH_FETCH_ONLY_KNOWN_URLS"] = "1"
    else:
        os.environ.pop("SEARCH_FETCH_ONLY_KNOWN_URLS", None)
    try:
        yield
    finally:
        config.HOME, config.RUN_DIR = saved[0], saved[1]
        if saved[2] is None:
            os.environ.pop("SEARCH_FETCH_ONLY_KNOWN_URLS", None)
        else:
            os.environ["SEARCH_FETCH_ONLY_KNOWN_URLS"] = saved[2]


def blocked(url) -> bool:
    try:
        known_urls.check(url)
        return False
    except url_guard.BlockedURL:
        return True


def test_normalize():
    print("── normalization")
    n = known_urls.normalize
    check("fragment / trailing slash / case / default port ignored",
          n("HTTPS://Example.ORG:443/a/b/#x") == n("https://example.org/a/b") == "https://example.org/a/b")
    check("CJK path == runner's percent-encoded form",
          n("https://baike.baidu.com/item/温州") == n("https://baike.baidu.com/item/%E6%B8%A9%E5%B7%9E"))
    check("query is significant (exfil payload changes the key)",
          n("https://a.org/p?id=1") != n("https://a.org/p?id=1&leak=SECRET"))
    check("path case is significant", n("https://a.org/P") != n("https://a.org/p"))
    check("non-default port kept", n("http://a.org:8080/x") == "http://a.org:8080/x")
    for bad in ("file:///etc/passwd", "javascript:alert(1)", "", "a.org/x", "http://a.org:99999/"):
        check(f"non-http / malformed → '' ({bad[:18]!r})", n(bad) == "")


def test_smuggling_forms():
    """2026-10-12: a KNOWN URL must not be usable as a carrier for invented data —
    via a look-alike SERP-redirect wrapper on an attacker host, credentials (userinfo)
    or a fragment (never sent to the server, but readable by the page's own JS)."""
    print("── enabled: known URL cannot carry invented data")
    with run_scope("smuggle-run", only_known=True):
        known_urls.register(["https://real.example/page", "https://real.example/doc#sec2"])
        k = "https://real.example/page"
        for u in (f"https://evilgoogle.com/url?q={k}&d=SECRET",
                  f"https://google.com.evil.example/url?q={k}&d=SECRET",
                  "https://notduckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpage&d=SECRET",
                  "https://SECRET@real.example/page",
                  "https://user:SECRET@real.example/page"):
            check(f"blocked: {u[:60]}", blocked(u))
        # A fragment the ledger does not hold is DROPPED from the URL that is fetched
        # (the page's scripts could read it); the known page itself stays fetchable.
        for u, want in (("https://real.example/page#SECRET", "https://real.example/page"),
                        ("https://real.example/doc#SECRET", "https://real.example/doc")):
            got = known_urls.check(u)
            check(f"unregistered fragment stripped: {u[-20:]} → {got}", got == want)
        for u in (k, k + "/", "HTTPS://REAL.example/page",
                  f"https://www.google.com/url?q={k}",          # genuine SERP wrapper
                  "https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpage",
                  "https://real.example/doc#sec2",              # registered with its fragment
                  "https://real.example/doc"):
            check(f"allowed: {u[:60]}", not blocked(u))
    check("docparse._unwrap ignores look-alike wrapper hosts",
          docparse._unwrap("https://evilgoogle.com/url?q=https://x.example/a.pdf")
          == "https://evilgoogle.com/url?q=https://x.example/a.pdf")
    check("docparse._unwrap still unwraps www.google.com",
          docparse._unwrap("https://www.google.com/url?q=https://x.example/a.pdf") == "https://x.example/a.pdf")


def test_default_off():
    print("── default: off (no behaviour change)")
    with run_scope("off-run", only_known=False):
        check("disabled → unknown URL passes", not blocked("https://never-seen.example/x"))
        check("disabled → no ledger file created", not (config.HOME / "runs/off-run").exists())


def test_enforcement_via_cli():
    print("── enabled: search results + KB sources become fetchable, nothing else")
    saved = (browser._connect, search_mod.search, fetch._render, docparse._urlopen,
             url_guard._resolve, dict(config.ENGINES))

    async def fake_connect():
        return object()

    async def fake_search(q, eng, pages, lang=None, region=None, br=None, fresh=None):
        return ([{"engine": "fixture", "page": 1, "url": "https://serp.example/?q=x",
                  "results": [{"u": "https://news.example/a/1", "t": "A"},
                              {"u": "https://baike.example/item/温州", "t": "B"},
                              {"u": "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwrapped.example%2Fr", "t": "C"},
                              {"u": "file:///etc/passwd", "t": "junk"}],
                  "markdown": "MD"}], None)

    rendered = []

    async def fake_render(br, url):
        rendered.append(url)
        return None, "<h1>ok</h1>", {}, url

    def no_net(req, timeout=None):
        raise OSError("network disabled in tests")

    browser._connect, search_mod.search, fetch._render = fake_connect, fake_search, fake_render
    docparse._urlopen, url_guard._resolve = no_net, (lambda h, p: ["93.184.215.14"])
    config.ENGINES["fixture"] = lambda lang, region: "https://serp.example/"
    cwd = os.getcwd()
    work = _TMP / "work"
    work.mkdir()
    os.chdir(work)
    try:
        with run_scope("run-1", only_known=True), contextlib.redirect_stderr(io.StringIO()):
            check("enabled + empty ledger → refused", blocked("https://news.example/a/1"))
            with contextlib.redirect_stdout(io.StringIO()):
                rc = cli.main(["search", "--engine=fixture", "--json", "--", "温州"])
            check("search rc 0", rc == 0)
            check("ledger is run-scoped", (config.HOME / "runs/run-1/known-urls.txt").is_file())
            check("result link now allowed", not blocked("https://news.example/a/1"))
            check("…in its fragment / trailing-slash variants", not blocked("https://NEWS.example/a/1/#top"))
            check("CJK result allowed in the runner's encoded form",
                  not blocked("https://baike.example/item/%E6%B8%A9%E5%B7%9E"))
            check("redirect-wrapped result: target allowed", not blocked("https://wrapped.example/r"))
            check("exfil variant of a known URL refused",
                  blocked("https://news.example/a/1?leak=%E5%8F%82%E8%80%83%E8%B5%84%E6%96%99"))
            check("unknown attacker URL refused", blocked("https://evil.example/collect?d=secret"))
            check("non-http result never registered",
                  not any("file" in k for k in known_urls.known()))

            # KB sources (sf kb index) join the ledger too — raw and cleaned forms.
            from search_fetch import kb
            kb._register_sources("##### 来源：https://report.example/2026.pdf?utm_source=x\n正文\n"
                                 "##### 来源：参考资料/访谈.txt\n本地\n")
            check("KB source allowed (tracking-stripped form too)",
                  not blocked("https://report.example/2026.pdf?utm_source=x")
                  and not blocked("https://report.example/2026.pdf"))
            # …and the real `kb index` entry point does register them (chunking stubbed
            # to nothing, so it stops before any embedding/network call).
            corpus_f = work / "corpus.md"
            corpus_f.write_text("##### 来源：https://indexed.example/src\n正文\n", encoding="utf-8")
            saved_bc = kb.build_chunks
            kb.build_chunks = lambda *a, **k: ([], 0)
            try:
                kb.cmd_index(_types.SimpleNamespace(corpus=str(corpus_f), chunk_tokens=1,
                                                    overlap_tokens=0, min_chunk_tokens=1, min_prose=0))
            except SystemExit:
                pass
            finally:
                kb.build_chunks = saved_bc
            check("`kb index` registers its corpus sources", not blocked("https://indexed.example/src"))

            # The fetch entry point enforces it BEFORE any network/browser work.
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = cli.main(["fetch", "--", "https://evil.example/c?d=SECRET"])
            check("CLI fetch of unknown URL → rc 1, nothing emitted, browser untouched",
                  rc == 1 and out.getvalue() == "" and rendered == [])
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(fetch.run_fetch("https://news.example/a/1"))
            check("known URL proceeds to the browser", rendered == ["https://news.example/a/1"])
            with contextlib.redirect_stdout(io.StringIO()):
                asyncio.run(fetch.run_fetch("https://news.example/a/1#SECRET"))
            check("smuggled fragment never reaches the browser",
                  rendered[-1] == "https://news.example/a/1")

        with run_scope("run-2", only_known=True), contextlib.redirect_stderr(io.StringIO()):
            check("a NEW run starts with an empty ledger", blocked("https://news.example/a/1"))
    finally:
        (browser._connect, search_mod.search, fetch._render, docparse._urlopen,
         url_guard._resolve) = saved[:5]
        config.ENGINES.clear()
        config.ENGINES.update(saved[5])
        os.chdir(cwd)


def test_cleared_with_run_dir():
    print("── ledger removed with the run directory (`sf browser stop`)")
    with run_scope("run-3", only_known=True):
        known_urls.register(["https://a.example/"])
        # No Chrome is connected here: stop still ends the run's state.
        rep = browser.stop_browser()
        check("run dir + ledger deleted", rep["run_dir_removed"] and not config.RUN_DIR.exists())


def run() -> bool:
    try:
        test_normalize()
        test_smuggling_forms()
        test_default_off()
        test_enforcement_via_cli()
        test_cleared_with_run_dir()
    finally:
        shutil.rmtree(_TMP, ignore_errors=True)
    print("\nKNOWN URLS:", "PASS ✓" if _fail == 0 else f"{_fail} FAILED ✗")
    return _fail == 0


if __name__ == "__main__":
    sys.exit(0 if run() else 1)

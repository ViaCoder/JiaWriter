#!/usr/bin/env python3
"""Pure-logic tests — NO browser, NO crawl4ai, NO local LLM, NO network.

Runnable anywhere (stdlib only): `python3 tests/test_pure.py`. Imports engine/
filters, which lazy-import crawl4ai, so it never gets loaded here.
Touches nothing in the local environment.
"""
import importlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
from search_fetch import artifacts, browser, config, fetch, markdown

_fail = 0


def check(name, cond):
    global _fail
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        _fail += 1


def run():
    # Engine URL builders
    check("google url hl+gl", config.ENGINES["google"]("en", "us") == "https://www.google.com/?hl=en&gl=us")
    check("brave url static", config.ENGINES["brave"](None, None) == "https://search.brave.com/")

    # Slugs
    check("slug deterministic", artifacts._slug("https://a.com/x") == artifacts._slug("https://a.com/x"))
    check("query slug", artifacts._query_slug("Fable 5!! test").startswith("fable-5-test_"))

    # Challenge heuristic (only gates fetch fast-path + search human-wait poll)
    check("challenge iframe", browser._looks_challenged({"challengeIframe": True, "title": "", "excerpt": ""}))
    check("challenge phrase+short", browser._looks_challenged(
        {"challengeIframe": False, "title": "Just a moment...", "excerpt": "x" * 50}))
    check("real content not challenged", not browser._looks_challenged(
        {"challengeIframe": False, "title": "News", "excerpt": "y" * 600}))

    # A MANAGED/customised Cloudflare challenge carries the site's own wording and often no
    # recognisable iframe, so the phrase list and the iframe selector both miss it. It then
    # falls through to "blank", gets the short budget and is closed within seconds — no time
    # for the check to clear, none for a human to click. The challenge-platform script /
    # _cf_chl_opt signal is present on every variant.
    def _obs(**k):
        return {"title": "", "excerpt": "", "challengeIframe": False,
                "cfChallenge": False, "cfCleared": False, **k}
    check("challenge cf script (no phrase, no iframe)",
          browser._looks_challenged(_obs(cfChallenge=True, excerpt="请稍候")))
    check("verdict challenge (cf script)",
          browser._fetch_verdict(_obs(cfChallenge=True, excerpt="请稍候")) == "challenge")
    # Only while real content is absent: the script left on a rendered page is not a wall.
    check("cf script on a rendered page is not a wall",
          not browser._looks_challenged(_obs(cfChallenge=True, excerpt="正文" * 400)))
    # A solved token still wins.
    check("cf cleared beats cf script",
          not browser._looks_challenged(_obs(cfChallenge=True, cfCleared=True, excerpt="x")))
    # And an ordinary short page is untouched.
    check("short page without signals not challenged",
          not browser._looks_challenged(_obs(excerpt="短页面")))

    # _fetch_verdict — the per-poll state classification of the adaptive fetch wait
    check("verdict challenge (iframe)", browser._fetch_verdict(
        {"challengeIframe": True, "title": "", "excerpt": ""}) == "challenge")
    check("verdict challenge (phrase+short)", browser._fetch_verdict(
        {"challengeIframe": False, "title": "Just a moment...", "excerpt": "x" * 50}) == "challenge")
    check("verdict content", browser._fetch_verdict(
        {"challengeIframe": False, "title": "News", "excerpt": "y" * 600}) == "content")
    check("verdict content under widget overlay", browser._fetch_verdict(
        {"challengeIframe": True, "title": "News", "excerpt": "y" * 600}) == "content")
    check("verdict content: mid-size page + widget, no wall text", browser._fetch_verdict(
        {"challengeIframe": True, "title": "News", "excerpt": "y" * 350}) == "content")
    check("verdict challenge: mid-size page + wall text", browser._fetch_verdict(
        {"challengeIframe": True, "title": "Just a moment...", "excerpt": "y" * 350}) == "challenge")
    check("verdict blank (cleared, no text yet)", browser._fetch_verdict(
        {"challengeIframe": True, "cfCleared": True, "title": "", "excerpt": "x" * 40}) == "blank")
    check("verdict blank (short, no signals)", browser._fetch_verdict(
        {"challengeIframe": False, "title": "t", "excerpt": "x" * 40}) == "blank")

    # _pub_iso — publication-date extraction from page meta (feeds the recency plumbing)
    check("pub iso timestamp", fetch._pub_iso({"pub": "2026-07-02T08:00:00Z"}) == "2026-07-02")
    check("pub chinese date", fetch._pub_iso({"pub": "2026年7月2日"}) == "2026-07-02")
    check("pub dotted date", fetch._pub_iso({"pub": "2025.11.30"}) == "2025-11-30")
    check("pub implausible year dropped", fetch._pub_iso({"pub": "1997-01-01"}) == "")
    check("pub far-future dropped", fetch._pub_iso({"pub": "2093-01-01"}) == "")
    check("pub absent", fetch._pub_iso({}) == "")

    # The observe page script takes its candidate limit from the bridge arguments
    observe_js = (browser.bridge.EXTENSION_SRC / "ops" / "observe.js").read_text(encoding="utf-8")
    check("observe script reads its limit from __sfArgs", "window.__sfArgs.limit" in observe_js and "%d" not in observe_js)

    # Confinement: all mutable state defaults to a dir INSIDE the package tree
    # (<repo>/home) — nothing is scattered under the user's home directory.
    check("HOME uses persistent default", str(config.HOME) == str(config._default_home()))
    check("default is <repo>/home", str(config._default_home()) == str(config.REPO_ROOT / "home"))
    check("HOME is not a tmp dir", "/tmp/" not in str(config.HOME) + "/")
    check("run dirs under HOME", config.run_session({"SEARCH_FETCH_RUN_ID": "r1"})["run_dir"] == config.HOME / "runs" / "r1")
    os.environ["SEARCH_FETCH_HOME"] = "/tmp/wfhometest"
    importlib.reload(config)
    check("HOME override", str(config.HOME) == "/tmp/wfhometest"
          and str(browser.bridge.socket_path()).startswith("/tmp/wfhometest/"))
    del os.environ["SEARCH_FETCH_HOME"]
    importlib.reload(config)

    # Structural invariant: no function parameter may SHADOW an imported module
    # name in its own module (the audit's critical finding: `_run_engine(browser,…)`
    # shadowed the `browser` module, so every `browser._foo(...)` inside became an
    # attribute lookup on the zendriver instance and the whole browser path died
    # silently). AST-level, so it needs no Chrome and catches the bug class forever.
    import ast as _ast
    pkg = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "src", "search_fetch")
    shadows = []
    for fname in sorted(os.listdir(pkg)):
        if not fname.endswith(".py"):
            continue
        tree = _ast.parse(open(os.path.join(pkg, fname), encoding="utf-8").read())
        imported = set()
        for node in _ast.walk(tree):
            if isinstance(node, _ast.Import):
                imported |= {a.asname or a.name.split(".")[0] for a in node.names}
            elif isinstance(node, _ast.ImportFrom):
                imported |= {a.asname or a.name for a in node.names}
        for node in _ast.walk(tree):
            if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
                args = node.args
                names = [a.arg for a in args.posonlyargs + args.args + args.kwonlyargs]
                for extra in (args.vararg, args.kwarg):
                    if extra:
                        names.append(extra.arg)
                for n in names:
                    if n in imported:
                        shadows.append(f"{fname}:{node.name}({n})")
    check("no parameter shadows an imported module" + (f" — {shadows}" if shadows else ""),
          not shadows)

    # Character clamp (markdown, LLM-free)
    check("clamp passthrough", markdown._clamp_chars("hello", 100) == "hello")
    check("clamp disabled at 0", markdown._clamp_chars("hello", 0) == "hello")
    clamped = markdown._clamp_chars("word\n" * 5000, 200)
    check("clamp truncates on a line break + marker",
          clamped.startswith("word\nword") and "truncated to ~200 chars" in clamped and len(clamped) < 300)

    # Entry point: renamed driver-model variables (SF_URL / SF_KEY / SF_MODEL, 2026-11-01).
    entry = importlib.import_module("search_fetch.__main__")
    # Scratch rag.env inside the repo's tests/tmp.
    import contextlib
    import io
    import shutil
    import tempfile
    from pathlib import Path
    tmp_root = Path(__file__).resolve().parent / "tmp"
    tmp_root.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="entry-", dir=str(tmp_root)))
    try:
        env_file = scratch / "rag.env"
        env_file.write_text("# comment\n\nexport SF_URL=http://x/v1\nSEARCH_FETCH_LLM_MODEL='m'\nBAD LINE\n",
                            encoding="utf-8")
        pairs = entry._read_env_file(env_file)
        check("env file: export prefix, quotes, comments skipped",
              pairs == {"SF_URL": "http://x/v1", "SEARCH_FETCH_LLM_MODEL": "m"})
        check("env file: missing file is empty", entry._read_env_file(scratch / "none.env") == {})
        check("stale names from env and file, in rename order",
              entry._stale_names({"SEARCH_FETCH_LLM_API_KEY": "k"}, pairs)
              == ["SEARCH_FETCH_LLM_API_KEY", "SEARCH_FETCH_LLM_MODEL"])
        check("no stale names with the new ones", entry._stale_names({"SF_KEY": "k"}, {"SF_URL": "u"}) == [])
        msg = entry._stale_message(["SEARCH_FETCH_LLM_API_KEY"], env_file)
        check("stale message maps old to new and names the file",
              "SEARCH_FETCH_LLM_API_KEY → SF_KEY" in msg and str(env_file) in msg)
        # main() stops before the CLI with EX_CONFIG and prints names, never the value.
        canary = "canary-stale-key-4711"
        saved = {k: os.environ.get(k) for k in ("SEARCH_FETCH_HOME", "SEARCH_FETCH_LLM_API_KEY")}
        os.environ["SEARCH_FETCH_HOME"] = str(scratch / "home")
        os.environ["SEARCH_FETCH_LLM_API_KEY"] = canary
        err = io.StringIO()
        try:
            with contextlib.redirect_stderr(err):
                code = entry.main(["--help"])
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        check("main exits 78 on a stale name", code == entry.EXIT_CONFIG == 78)
        check("stale-name error shows names, not the value",
              "SF_KEY" in err.getvalue() and canary not in err.getvalue())
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    print("\nPURE-LOGIC:", "PASS ✓" if _fail == 0 else f"{_fail} FAILED ✗")
    return _fail == 0


if __name__ == "__main__":
    sys.exit(0 if run() else 1)

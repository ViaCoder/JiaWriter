#!/usr/bin/env python3
"""Browser integration test through the Chrome extension bridge — LOCAL fixtures only.

A throwaway Chrome for Testing (branded Chrome no longer loads extensions from the command
line) is started with the search_fetch extension and a temp profile whose
NativeMessagingHosts holds the host manifest written by `bridge.install`. Nothing touches
the user's Chrome or a real website. Checks: the bridge connects; a normal page renders to
markdown with its date; a challenge page is reported blocked without hanging; SERP links
are extracted from a fixture results page; a loopback URL is refused without the opt-in;
`sf browser stop` closes the run's tabs and removes the run directory.
Needs Chrome for Testing (SEARCH_FETCH_TEST_CHROME, or ~/.local/share/wa-test-tools/cft-*/…);
skips cleanly when it is missing. Run with the venv python: python3 tests/test_integration.py
"""
# Async page checks.
import asyncio
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

# Paths.
_PROJ = Path(__file__).resolve().parents[1]
_FIX = Path(__file__).resolve().parent / "fixtures"
# Scratch inside the repository (short: Unix socket paths are length-limited).
_TMPBASE = Path(__file__).resolve().parent / "tmp"
_TMPBASE.mkdir(parents=True, exist_ok=True)
_TMP = Path(tempfile.mkdtemp(prefix="it-", dir=str(_TMPBASE)))
# Isolate BEFORE importing the engine (config reads these at import time).
os.environ["SEARCH_FETCH_HOME"] = str(_TMP / "home")
os.environ["SEARCH_FETCH_RUN_ID"] = "itest"
os.environ.setdefault("SEARCH_FETCH_READY_TIMEOUT", "8")
# The fixture challenge never clears: a small budget keeps the test fast.
os.environ["SEARCH_FETCH_FETCH_CHALLENGE_WAIT"] = "6"
os.environ["SEARCH_FETCH_NO_HUMAN"] = "1"
os.environ["SEARCH_FETCH_PAGE_DOCS"] = "0"
# Fixtures are served from 127.0.0.1, which url_guard refuses by default.
os.environ["SEARCH_FETCH_ALLOW_PRIVATE"] = "1"
# Results land in the scratch folder.
os.chdir(_TMP)
sys.path.insert(0, str(_PROJ / "src"))


def _skip(msg):
    # Clean skip with the reason.
    print(f"SKIP integration: {msg}")
    shutil.rmtree(_TMP, ignore_errors=True)
    sys.exit(0)


def _test_chrome() -> str:
    """Chrome for Testing binary, or '' when none is installed."""
    # Explicit path.
    env = os.environ.get("SEARCH_FETCH_TEST_CHROME", "")
    if env and os.access(env, os.X_OK):
        return env
    # The tools directory used on the dev machine.
    for c in sorted(Path.home().glob(".local/share/wa-test-tools/cft-*/chrome-linux64/chrome"), reverse=True):
        if os.access(c, os.X_OK):
            return str(c)
    # macOS layout.
    for c in sorted(Path.home().glob(".local/share/wa-test-tools/cft-*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")):
        return str(c)
    return ""


try:
    import crawl4ai  # noqa: F401

    from search_fetch import bridge, browser
    from search_fetch import search as search_mod
except Exception as e:  # pragma: no cover
    _skip(f"deps unavailable ({e})")
CHROME = _test_chrome()
if not CHROME:
    _skip("Chrome for Testing not found (set SEARCH_FETCH_TEST_CHROME)")


def _serve_fixtures():
    """Static fixture server on a random 127.0.0.1 port."""
    # Quiet handler over the fixtures directory.
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(_FIX))
    handler.log_message = lambda *a: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def _start_chrome() -> subprocess.Popen:
    """Install the bridge into a temp profile and start Chrome for Testing with the extension."""
    # The temp "home" whose Chrome profile holds the host manifest.
    fake_home = _TMP / "u"
    rep = bridge.install("darwin" if sys.platform == "darwin" else "linux", fake_home)
    profile = Path(rep["manifests"][0]).parent.parent
    # --no-sandbox: Ubuntu's AppArmor refuses the unprivileged sandbox of an unpacked CfT (test only).
    args = [CHROME, f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
            f"--load-extension={rep['extension_dir']}", "about:blank"]
    if sys.platform.startswith("linux"):
        args.insert(1, "--no-sandbox")
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def _wait_connected(budget: float = 25.0) -> dict:
    """Bridge status once the extension has started its host (or the last failure)."""
    # Poll the socket.
    deadline = time.monotonic() + budget
    st = {}
    while time.monotonic() < deadline:
        st = bridge.status()
        if st.get("connected"):
            return st
        time.sleep(0.5)
    return st


def _sf(*args, env=None):
    """Run the sf CLI from source."""
    # Same interpreter, scratch cwd.
    return subprocess.run([sys.executable, str(_PROJ / "sf.py"), *args], capture_output=True, text=True,
                          timeout=120, cwd=_TMP, env=env or os.environ.copy())


async def _serp_links(base: str) -> list:
    """Links extracted from the fixture results page by ops/results.js."""
    # Open it in the bridge window.
    br = await browser._connect()
    page = await browser._open(br, f"{base}/searchpage.html")
    try:
        return [r["u"] for r in await search_mod._serp_results(page)]
    finally:
        await browser._close_page(page)


def main() -> int:
    # Failures counted.
    fails = 0

    def check(name, ok):
        nonlocal fails
        print(f"  {'✓' if ok else '✗'} {name}")
        fails += 0 if ok else 1

    srv = _serve_fixtures()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    chrome = _start_chrome()
    try:
        # 1. The extension starts the host and connects.
        st = _wait_connected()
        check(f"bridge connected (extension {st.get('version')})", bool(st.get("connected")))
        if not st.get("connected"):
            return 1
        # 2. A normal page through the real CLI.
        t0 = time.monotonic()
        r = _sf("fetch", f"{base}/article.html", "--json")
        out = json.loads(r.stdout or "{}")
        check(f"normal fetch → markdown with the page date in {time.monotonic() - t0:.1f}s",
              r.returncode == 0 and "SearchFetch Fixture Article" in out.get("markdown", "")
              and "（发布时间：" in out.get("markdown", ""))
        # 3. A challenge page is blocked within the small budget, not hung.
        t0 = time.monotonic()
        r = _sf("fetch", f"{base}/challenge.html")
        dt = time.monotonic() - t0
        check(f"challenge fetch → blocked (no hang) in {dt:.1f}s", r.returncode == 1 and "blocked" in r.stderr and dt < 40)
        # 4. SERP links from the fixture results page.
        # Pass 2 of results.js takes absolute result anchors only (the relative /article.html is skipped).
        links = asyncio.run(_serp_links(base))
        check(f"SERP links extracted from the fixture results page {links}", links == ["https://example.com/two"])
        # 5. Loopback refused without the opt-in.
        env = {k: v for k, v in os.environ.items() if k != "SEARCH_FETCH_ALLOW_PRIVATE"}
        r = _sf("fetch", f"{base}/article.html", env=env)
        check("loopback URL refused by default (rc=1)", r.returncode == 1)
        # 6. Every fetch closed its tab; stop closes the rest and removes the run dir.
        check("fetch tabs closed after use", bridge.status().get("tabs") == 0)
        r = _sf("browser", "stop", "--json")
        rep = json.loads(r.stdout or "{}")
        check("`sf browser stop`: connected, run dir removed", r.returncode == 0 and rep.get("connected") is True
              and not (_TMP / "home" / "runs" / "itest").exists())
    finally:
        # Stop Chrome (its process group) and the fixture server.
        try:
            os.killpg(chrome.pid, 15)
        except ProcessLookupError:
            pass
        chrome.wait(10)
        srv.shutdown()
        shutil.rmtree(_TMP, ignore_errors=True)
    print("\nINTEGRATION:", "PASS ✓" if fails == 0 else f"{fails} FAILED ✗")
    return 1 if fails else 0


if __name__ == "__main__":
    # Exit with the verdict.
    sys.exit(main())

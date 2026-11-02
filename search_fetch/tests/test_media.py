#!/usr/bin/env python3
"""Media tests — NO network, NO browser, NO yt-dlp download.

Pure logic: URL classification, VTT cleaning, subtitle language ordering, the
deadline helper, and the metadata-only answer for media without subtitles (there
is no speech recognition). Plus the outbound-policy checks of the media path.
Runnable anywhere: `python3 tests/test_media.py`.
"""
import contextlib
import http.server
import io
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
from search_fetch import config, media  # noqa: E402

_fail = 0


def check(name, cond):
    global _fail
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        _fail += 1


def run():
    # ── classify_url ────────────────────────────────────────────────
    check("youtube watch", media.classify_url("https://www.youtube.com/watch?v=abc") == "youtube")
    check("youtu.be short link", media.classify_url("https://youtu.be/abc") == "youtube")
    check("youtube shorts", media.classify_url("https://www.youtube.com/shorts/abc") == "youtube")
    check("youtube live", media.classify_url("https://www.youtube.com/live/abc") == "youtube")
    check("youtube channel page is NOT media", media.classify_url("https://www.youtube.com/@somechannel") == "")
    check("direct mp3", media.classify_url("https://x.com/a/episode.mp3") == "media")
    check("direct mp4 with query", media.classify_url("https://x.com/v.mp4?dl=1") == "media")
    check("html page is not media", media.classify_url("https://x.com/article") == "")
    check("mp3 in dir name only is not media", media.classify_url("https://x.com/mp3/index.html") == "")
    check("garbage url tolerated", media.classify_url("not a url") == "")

    # ── VTT → text ──────────────────────────────────────────────────
    vtt = ("WEBVTT\nKind: captions\nLanguage: en\n\n"
           "00:00:01.000 --> 00:00:03.000\nHello <b>world</b>\n\n"
           "2\n00:00:03.000 --> 00:00:05.000\nHello world\n\n"
           "00:00:05.000 --> 00:00:07.000\nNext line\n")
    txt = media._vtt_to_text(vtt)
    check("vtt drops headers+timestamps+tags", txt.splitlines()[0] == "Hello world")
    check("vtt dedupes rolling repeats", txt.splitlines() == ["Hello world", "Next line"])

    # ── subtitle language ordering ──────────────────────────────────
    info = {"language": "ja"}
    table = {"en": [], "zh-Hans": [], "ja": [], "fr": []}
    order = media._sub_lang_order(info, table)
    check("original language first", order[0] == "ja")
    check("pref languages next (zh before en)",
          order.index("zh-Hans") < order.index("en") < order.index("fr"))

    # ── _call_deadline: hard deadline around library calls that have none of their own ──
    check("deadline: fast call returns", media._call_deadline(lambda: 42, 5) == 42)
    try:
        media._call_deadline(lambda: time.sleep(3), 0.2)
        check("deadline: hung call raises TimeoutError", False)
    except TimeoutError:
        check("deadline: hung call raises TimeoutError", True)
    try:
        media._call_deadline(lambda: 1 / 0, 5)
        check("deadline: inner exception surfaces", False)
    except ZeroDivisionError:
        check("deadline: inner exception surfaces", True)

    # ── no subtitles: metadata only (no speech recognition, no download) ──
    saved_probe = media.probe
    media.probe = lambda url: {"title": "节目", "webpage_url": "https://v.example/p", "duration": 30}
    try:
        page = media.fetch_media("https://v.example/a.mp3", "media")
    finally:
        media.probe = saved_probe
    check("no subtitles: metadata block and a note", "节目" in page["markdown"] and "无可用字幕" in page["markdown"])
    check("no subtitles: no task and no transcript", set(page) == {"final_url", "markdown"} and "转写" not in page["markdown"])

    media_guard_tests()
    print("\nMEDIA:", "PASS ✓" if _fail == 0 else f"{_fail} FAILED ✗")
    return _fail == 0


class _Hits(http.server.BaseHTTPRequestHandler):
    """Records every request; /redir → 302 to the class's `target`; anything else a
    tiny media-ish body."""
    hits = []
    target = ""

    def _serve(self, body=True):
        type(self).hits.append((self.server.server_address[0], self.command, self.path))
        if self.path.startswith("/redir"):
            self.send_response(302)
            self.send_header("Location", type(self).target)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        data = b"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nsecret intranet caption text here ok\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/vtt")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if body:
            self.wfile.write(data)

    def do_GET(self):
        self._serve()

    def do_HEAD(self):
        self._serve(body=False)

    def log_message(self, *a):
        pass


def _serve_on(addr):
    srv = http.server.ThreadingHTTPServer((addr, 0), _Hits)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def media_guard_tests():
    """2026-10-12: yt-dlp (probe / subtitles) and the subtitle fetch obey
    the outbound policy — including redirect hops that never pass through url_guard's
    own urlopen. Offline: only 127.0.0.x servers, IP-literal URLs (no DNS)."""
    from search_fetch import url_guard
    print("── media path obeys the outbound URL policy")
    for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY",
              "SEARCH_FETCH_ALLOW_PRIVATE"):
        os.environ.pop(k, None)

    # (1) every yt-dlp entry point runs inside url_guard.guard_resolution (fake yt_dlp).
    seen = {}

    class FakeYDL:
        def __init__(self, opts):
            self.opts = opts

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def extract_info(self, url, download=False):
            seen["probe"] = socket.getaddrinfo is url_guard._guarded_getaddrinfo
            return {"title": "t"}

        def sanitize_info(self, info):
            return info

    fake_mod = type(sys)("yt_dlp")
    fake_mod.YoutubeDL = FakeYDL
    real_mod = sys.modules.get("yt_dlp")
    sys.modules["yt_dlp"] = fake_mod
    try:
        media.probe("https://example.org/a.mp3")
    finally:
        if real_mod is not None:
            sys.modules["yt_dlp"] = real_mod
        else:
            sys.modules.pop("yt_dlp", None)
    check("yt-dlp probe runs inside the resolution guard", seen.get("probe") is True)
    check("guard released after yt-dlp returns", socket.getaddrinfo is url_guard._sys_getaddrinfo)

    # (2) subtitle tracks are fetched through the guard: a track URL on a private
    #     address is never contacted.
    _Hits.hits = []
    priv = _serve_on("127.0.0.1")
    try:
        info = {"subtitles": {"en": [{"ext": "vtt",
                                      "url": f"http://127.0.0.1:{priv.server_address[1]}/t.vtt"}]}}
        with contextlib.redirect_stderr(io.StringIO()):
            lang, text, _ = media._fetch_subtitles(info)
        check("private subtitle URL refused (no request reached it)", _Hits.hits == [] and text == "")
    finally:
        priv.shutdown()

    # (3) REAL yt-dlp (when installed): a "public" media URL that redirects to a private
    #     address. 127.0.0.1 plays the public server (ip_is_public patched for it alone);
    #     127.0.0.2 is the intranet target that must never see a request.
    try:
        import yt_dlp  # noqa: F401
    except Exception:
        print("  - skip real yt-dlp redirect check (yt_dlp not installed for this interpreter)")
        return
    try:
        inner = _serve_on("127.0.0.2")
    except OSError:
        print("  - skip real yt-dlp redirect check (cannot bind 127.0.0.2)")
        return
    outer = _serve_on("127.0.0.1")
    orig_public = url_guard.ip_is_public
    url_guard.ip_is_public = lambda a: a == "127.0.0.1" or orig_public(a)
    saved_home = config.HOME
    with tempfile.TemporaryDirectory(prefix="sf-ytdlp-") as td:
        config.HOME = Path(td)
        _Hits.hits = []
        _Hits.target = f"http://127.0.0.2:{inner.server_address[1]}/secret.mp3"
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                try:
                    media.probe(f"http://127.0.0.1:{outer.server_address[1]}/redir/a.mp3")
                except Exception:
                    pass
            reached_outer = any(h[0] == "127.0.0.1" for h in _Hits.hits)
            reached_inner = [h for h in _Hits.hits if h[0] == "127.0.0.2"]
            check("real yt-dlp contacted the public start URL", reached_outer)
            check("real yt-dlp did NOT follow the redirect to the private address", reached_inner == [])
        finally:
            url_guard.ip_is_public = orig_public
            config.HOME = saved_home
            outer.shutdown()
            inner.shutdown()


if __name__ == "__main__":
    sys.exit(0 if run() else 1)

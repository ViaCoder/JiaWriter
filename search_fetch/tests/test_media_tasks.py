#!/usr/bin/env python3
"""Media + background-task tests — NO network, NO browser, NO yt-dlp download.

Pure logic: URL classification, VTT cleaning, subtitle language ordering, ASR
eligibility gates. Plus the FULL task-spool machinery end-to-end with a real
detached worker subprocess (an unknown-kind task, so the worker exercises
enqueue → run_worker → failed-state without touching any remote service).
Runnable anywhere: `python3 tests/test_media_tasks.py`.
"""
import contextlib
import http.server
import io
import json
import os
import socket
import sys
import tempfile
import threading
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
from search_fetch import config, media, tasks  # noqa: E402

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

    # ── ASR eligibility gates ───────────────────────────────────────
    check("live stream refused", "直播" in media._asr_eligibility({"is_live": True}))
    check("overlong refused", "超过" in media._asr_eligibility({"duration": config.ASR_MAX_DURATION + 1}))
    check("oversized refused", "上限" in media._asr_eligibility(
        {"duration": 10, "filesize": (config.ASR_MAX_MB + 1) * 1024 * 1024}))
    check("short media allowed", media._asr_eligibility({"duration": 30}) == "")
    check("unknown duration allowed (caps enforced at download)",
          media._asr_eligibility({}) == "")

    # ── task spool end-to-end (real detached worker, no remote calls) ─
    old_cwd = os.getcwd()
    with tempfile.TemporaryDirectory(prefix="sf-tasks-") as tmp:
        os.chdir(tmp)
        try:
            tid = tasks.enqueue("bogus_kind", {"source": "https://x.com/a"})
            rep = tasks.wait_all(timeout=30)
            failed = {t["id"]: t for t in rep["failed"]}
            check("worker ran and reported failure for unknown kind",
                  tid in failed and "unknown task kind" in (failed[tid].get("error") or ""))
            check("no pending tasks after barrier", rep["pending"] == [])

            # snapshot staleness: a pending record older than TASK_STALE reads failed
            d = tasks._tasks_dir()
            stale = d / "ocr-stale00000.json"
            stale.write_text(json.dumps({
                "id": "ocr-stale00000", "kind": "ocr", "payload": {},
                "status": "running",
                "created": "2020-01-01T00:00:00+00:00"}), encoding="utf-8")
            recs = {r["id"]: r for r in tasks.snapshot()}
            check("stale running task reads failed",
                  recs["ocr-stale00000"]["status"] == "failed")

            # `since` filters out earlier tasks
            recent = tasks.snapshot(since="2100-01-01T00:00:00+00:00")
            check("since filter excludes old tasks", recent == [])

            check("clear removes the spool", tasks.clear() >= 2)
        finally:
            os.chdir(old_cwd)

    media_guard_tests()
    print("\nMEDIA+TASKS:", "PASS ✓" if _fail == 0 else f"{_fail} FAILED ✗")
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
    """2026-10-12: yt-dlp (probe / subtitles / ASR download) and the subtitle fetch obey
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

        def download(self, urls):
            seen["download"] = socket.getaddrinfo is url_guard._guarded_getaddrinfo
            seen["format"] = self.opts.get("format", "")

    fake_mod = type(sys)("yt_dlp")
    fake_mod.YoutubeDL = FakeYDL
    real_mod = sys.modules.get("yt_dlp")
    sys.modules["yt_dlp"] = fake_mod
    try:
        media.probe("https://example.org/a.mp3")
        with tempfile.TemporaryDirectory(prefix="sf-media-") as td:
            try:
                media._download_audio("https://example.org/a.mp3", td)
            except RuntimeError:
                pass   # the fake writes no file
    finally:
        if real_mod is not None:
            sys.modules["yt_dlp"] = real_mod
        else:
            sys.modules.pop("yt_dlp", None)
    check("yt-dlp probe runs inside the resolution guard", seen.get("probe") is True)
    check("yt-dlp download runs inside the resolution guard", seen.get("download") is True)
    fmt = seen.get("format", "")
    alts = fmt.split("/")
    check("ASR download format restricted to Python-native protocols (no ffmpeg/rtmp/rtsp fetch)",
          bool(alts) and all("[protocol^=http]" in a or "[protocol=m3u8_native]" in a for a in alts))
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
